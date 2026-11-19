/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTools } from '@fir/core';
import { storeFor } from '@fir/worker-content-maker';
import { describe, expect, it } from 'vitest';
import { pultWorld, type PultWorld } from './pult-helpers.js';

const NEW_PACK = { postsPerWeek: 3, storiesPerWeek: 5, carouselsPerWeek: 2 };
const WEEK = '2026-W48';
const store = (p: PultWorld) => storeFor({ db: p.w.db, now: p.w.hq.now });

/** The pack of the week, with every item of Monday 23.11 approved through the API. */
async function monday() {
  const p = pultWorld({ cadence: NEW_PACK, rendersDir: mkdtempSync(join(tmpdir(), 'mac-poster-')) });
  p.w.hq.runRoutine('marketing-weekly-pack');
  await p.w.marketing.onHeartbeat();
  await p.w.director.sendApprovalBatch(false);
  const all = (await p.call('GET', `/admin/content?week=${WEEK}`)).json.days.flatMap((d: any) => d.items) as any[];
  const day = all.filter((i) => store(p).item(i.id)!.plannedDate === '2026-11-23');
  for (const i of day) expect((await p.call('POST', `/admin/content/${i.id}`, { action: 'approve' })).status).toBe(200);
  return { p, day };
}
const journal = (p: PultWorld, action: string) => p.w.db.prepare("SELECT COUNT(*) n FROM activity WHERE agent_id = 'mac-poster' AND action = ?").get(action) as { n: number };

describe('the Mac helper reports through POST /admin/content/:id', () => {
  it('the item view carries publishedOn and the Instagram caption ready to paste', async () => {
    const { p, day } = await monday();
    const post = (await p.call('GET', `/admin/content?week=${WEEK}`)).json.days[0].items.find((i: any) => i.id === day.find((d) => d.kind === 'post').id);
    expect(post.publishedOn).toEqual([]);
    expect(post.igCaption).toMatch(/#\S+/);
    expect(post.igCaption).not.toContain('Instagram:');
  });

  it('published with url: marks the Instagram row only, stores the URL once, one journal row; repeat is a no-op', async () => {
    const { p, day } = await monday();
    const post = day.find((d) => d.kind === 'post');
    const url = 'https://www.instagram.com/p/ABC123/';
    let r = await p.call('POST', `/admin/content/${post.id}`, { action: 'published', platform: 'instagram', url });
    expect(r.status).toBe(200);
    expect(r.json.item).toMatchObject({ publishedUrl: url, error: null });
    expect(r.json.item.publishedOn).toEqual(['instagram']);
    r = await p.call('POST', `/admin/content/${post.id}`, { action: 'published', platform: 'instagram', url: 'https://www.instagram.com/p/OTHER/' });
    expect(r.json.item.publishedUrl).toBe(url);
    expect(journal(p, 'published').n).toBe(1);
    expect(journal(p, 'published_url').n).toBe(1);
    const row = p.w.db.prepare("SELECT via, url FROM pb_posts WHERE item_id = ? AND platform = 'instagram'").get(post.id) as any;
    expect(row).toEqual({ via: 'mac', url });
  });

  it('failed: the row stays ready with the reason as error; the same report twice writes one journal row', async () => {
    const { p, day } = await monday();
    const clip = day.find((d) => d.kind === 'clip');
    let r = await p.call('POST', `/admin/content/${clip.id}`, { action: 'failed', platform: 'instagram', note: 'challenge: Подтвердите, что это вы' });
    expect(r.status).toBe(200);
    expect(r.json.item.error).toBe('challenge: Подтвердите, что это вы');
    expect(r.json.item.publishedOn).toEqual([]);
    expect(store(p).rowsOfItem(clip.id).find((x) => x.platform === 'instagram')!.status).toBe('ready');
    expect((await p.call('POST', `/admin/content/${clip.id}`, { action: 'failed', platform: 'instagram', note: 'challenge: Подтвердите, что это вы' })).status).toBe(200);
    expect(journal(p, 'publish_failed').n).toBe(1);
    // a later success clears the error
    r = await p.call('POST', `/admin/content/${clip.id}`, { action: 'published', platform: 'instagram', url: 'https://www.instagram.com/reel/XYZ/' });
    expect(r.json.item).toMatchObject({ error: null, publishedUrl: 'https://www.instagram.com/reel/XYZ/' });
  });

  it('validation: failed needs platform and note, url only with published and https', async () => {
    const { p, day } = await monday();
    const id = day[0].id;
    for (const bad of [
      { action: 'failed', note: 'x' }, { action: 'failed', platform: 'instagram' }, { action: 'approve', url: 'https://x.y/' },
      { action: 'published', platform: 'instagram', url: 'http://insecure/' }, { action: 'published', url: 'https://www.instagram.com/p/1/' },
      { action: 'failed', platform: 'instagram', note: 'x', extra: 1 },
    ]) expect((await p.call('POST', `/admin/content/${id}`, bad)).status).toBe(400);
    const pending = (await p.call('GET', `/admin/content?week=${WEEK}`)).json.days[1].items[0];
    expect((await p.call('POST', `/admin/content/${pending.id}`, { action: 'failed', platform: 'instagram', note: 'x' })).status).toBe(409);
  });

  it('the morning header counts the Mac results; a failed item keeps its manual card with the reason', async () => {
    const { p, day } = await monday();
    const [a, b] = day.filter((d) => d.kind !== 'story');
    p.w.clock.t = Date.UTC(2026, 10, 22, 12, 0); // the Mac ran the evening before (within 24 hours)
    await p.call('POST', `/admin/content/${a.id}`, { action: 'published', platform: 'instagram', url: 'https://www.instagram.com/p/AAA/' });
    await p.call('POST', `/admin/content/${b.id}`, { action: 'failed', platform: 'instagram', note: 'кнопка «Поделиться» не найдена' });
    p.w.messenger.sent.length = 0;
    p.w.clock.t = Date.UTC(2026, 10, 23, 4, 30);
    p.w.hq.runRoutine('marketing-daily-today');
    await p.w.marketing.onHeartbeat();
    const texts = p.w.messenger.sent.map((m) => m.text);
    expect(texts.some((t) => t.includes('Instagram с Мака: опубликовано 1, ошибок 1.'))).toBe(true);
    expect(texts.some((t) => t.includes('Instagram с Мака не получилось (кнопка «Поделиться» не найдена). Публикуйте вручную.'))).toBe(true);
  });

  it('the queue an agent fills (tools.mac.poster.enqueue): ?queued=1 lists it, the report settles it', async () => {
    const { p, day } = await monday();
    const post = day.find((d) => d.kind === 'post');
    const tools = createTools({ agentId: 'publisher', dept: 'marketing', db: p.w.db, journal: p.w.hq, now: p.w.hq.now });
    expect(await tools.mac.poster.enqueue(post.id, 'instagram')).toMatchObject({ ok: true, value: { already: false } });
    let r = await p.call('GET', `/admin/content?week=${WEEK}&queued=1`);
    const listed = r.json.days.flatMap((d: any) => d.items);
    expect(listed.map((i: any) => i.id)).toEqual([post.id]);
    expect(listed[0].macQueued).toEqual(['instagram']);
    expect(r.json.queuedItems.map((i: any) => i.id)).toEqual([post.id]);
    expect((await p.call('GET', '/admin/content?week=2026-W47&queued=1')).json.queuedItems.map((i: any) => i.id)).toEqual([post.id]); // any week
    expect((await p.call('GET', `/admin/content?week=${WEEK}`)).json.days.flatMap((d: any) => d.items).length).toBeGreaterThan(1);
    await p.call('POST', `/admin/content/${post.id}`, { action: 'published', platform: 'instagram', url: 'https://www.instagram.com/p/Q1/' });
    r = await p.call('GET', `/admin/content?week=${WEEK}&queued=1`);
    expect(r.json.queuedItems).toEqual([]);
    expect(p.w.db.prepare("SELECT status FROM mac_queue WHERE item_id = ?").get(post.id)).toEqual({ status: 'done' });
    expect(p.w.db.prepare("SELECT COUNT(*) n FROM activity WHERE action = 'tool:mac.poster.enqueue'").get()).toEqual({ n: 1 });
  });
});
