/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storeFor } from '@fir/worker-content-maker';
import { describe, expect, it } from 'vitest';
import { openPack } from './helpers.js';
import { shellWorld, serve, type ShellWorld } from './shell-helpers.js';

const NEW_PACK = { postsPerWeek: 3, storiesPerWeek: 5, carouselsPerWeek: 2 };
const WEEK = '2026-W48'; // the pack of the world covers Mon 23.11 - Sun 29.11
const store = (p: ShellWorld) => storeFor({ db: p.w.db, now: p.w.hq.now });
const decisions = (p: ShellWorld) => (p.w.db.prepare("SELECT COUNT(*) n FROM decisions WHERE kind = 'content_item'").get() as { n: number }).n;

async function packed(opts: Parameters<typeof shellWorld>[0] = {}) {
  const p = shellWorld(opts);
  p.w.hq.runRoutine('marketing-weekly-pack');
  await p.w.marketing.onHeartbeat();
  await p.w.director.sendApprovalBatch(false);
  return p;
}
const items = async (p: ShellWorld, week = WEEK) => (await p.call('GET', `/admin/content?week=${week}`)).json.days.flatMap((d: any) => d.items) as any[];
const firstOf = async (p: ShellWorld, kind: string) => (await items(p)).find((i) => i.kind === kind);

describe('GET /admin/content', () => {
  it('401 without the token; the current week by default; a bad week is 400', async () => {
    const p = shellWorld();
    const s = await serve(p);
    expect((await s.http('GET', '/admin/content', undefined, {})).status).toBe(401);
    const r = await p.call('GET', '/admin/content');
    expect(r.json).toMatchObject({ ok: true, week: '2026-W47', summary: { pending: 0, approved: 0, published: 0, rendering: 0 } });
    expect(r.json.days).toHaveLength(7);
    expect(r.json.days[0].date).toBe('2026-11-16');
    for (const bad of ['2026-W54', '2026-W00', 'W47', '2026-47', 'x']) expect((await p.call('GET', `/admin/content?week=${bad}`)).status).toBe(400);
    await s.close();
  });

  it('the pack week lists every item with the contract shape, pending until the owner decides', async () => {
    const p = await packed({ cadence: NEW_PACK });
    const r = await p.call('GET', `/admin/content?week=${WEEK}`);
    expect(r.json.week).toBe(WEEK);
    expect(r.json.days.map((d: any) => d.date)).toEqual(['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29']);
    const all = r.json.days.flatMap((d: any) => d.items);
    expect(all).toHaveLength(17);
    expect(r.json.summary).toMatchObject({ pending: 17, approved: 0, published: 0, rendering: 0 });
    for (const it of all) {
      expect(Object.keys(it).sort()).toEqual(['approvalId', 'caption', 'error', 'files', 'hook', 'id', 'igCaption', 'kind', 'macQueued', 'platform', 'publishedOn', 'publishedUrl', 'sourceSlug', 'status', 'title']);
      expect(['clip', 'post', 'carousel', 'story']).toContain(it.kind);
      expect(it.status).toBe('pending');
      expect(it.files).toEqual([]);
      expect(Object.keys(it.caption).sort()).toEqual(['dzen', 'instagram', 'shorts', 'tiktok']);
    }
    const clip = all.find((i: any) => i.kind === 'clip');
    expect(clip.hook).toContain('Клиент пишет в 2 ночи');
    expect(clip.caption.tiktok).toContain('tt подпись');
    expect(clip.caption.shorts).toContain('Бот-администратор');
    expect(all.filter((i: any) => i.kind === 'clip')).toHaveLength(7);
    // the previous week has nothing
    expect((await items(p, '2026-W47'))).toEqual([]);
  });
});

describe('POST /admin/content/:itemId', () => {
  it('approve: the same queue path as the Telegram button; a second approve changes nothing (one decision, one journal row)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shell-renders-'));
    const p = await packed({ cadence: NEW_PACK, rendersDir: dir });
    const post = await firstOf(p, 'post');
    const before = decisions(p);
    const streak = p.w.queue.streak('content_item');
    let r = await p.call('POST', `/admin/content/${post.id}`, { action: 'approve' });
    expect(r.status).toBe(200);
    expect(r.json.item).toMatchObject({ id: post.id, kind: 'post', status: 'ready' });
    expect(r.json.item.files).toEqual([{ path: `${post.id}/1.png`, type: 'png', w: 1080, h: 1350 }]);
    expect(decisions(p)).toBe(before + 1);
    expect(p.w.queue.streak('content_item')).toBe(streak + 1);
    expect(store(p).item(post.id)!.status).toBe('ready');
    expect(store(p).rowsOfItem(post.id).length).toBeGreaterThan(0);
    // again: no second decision, no second set of rows, same answer
    const rows = store(p).rowsOfItem(post.id).length;
    r = await p.call('POST', `/admin/content/${post.id}`, { action: 'approve' });
    expect(r.json.ok).toBe(true);
    expect(r.json.item.status).toBe('ready');
    expect(decisions(p)).toBe(before + 1);
    expect(store(p).rowsOfItem(post.id)).toHaveLength(rows);
    // the opposite decision is refused
    const rej = await p.call('POST', `/admin/content/${post.id}`, { action: 'reject' });
    expect(rej.status).toBe(409);
    expect(rej.json.error).toBe('already_decided');
    // the pack's other items are untouched
    expect((await items(p)).filter((i) => i.status === 'pending')).toHaveLength(16);
  });

  it('reject: the item is rejected with the note, idempotent; approving it afterwards is 409', async () => {
    const p = await packed();
    const clip = await firstOf(p, 'clip');
    let r = await p.call('POST', `/admin/content/${clip.id}`, { action: 'reject', note: 'не наш тон' });
    expect(r.json.item.status).toBe('rejected');
    expect(store(p).item(clip.id)).toMatchObject({ status: 'rejected', comment: 'не наш тон' });
    const n = decisions(p);
    r = await p.call('POST', `/admin/content/${clip.id}`, { action: 'reject' });
    expect(r.json.item.status).toBe('rejected');
    expect(decisions(p)).toBe(n);
    expect((await p.call('POST', `/admin/content/${clip.id}`, { action: 'approve' })).status).toBe(409);
    // the task of the item followed the decision
    const link = p.w.db.prepare("SELECT task_id t, state FROM task_approvals WHERE json_extract(payload, '$.itemId') = ?").get(clip.id) as any;
    expect(link.state).toBe('rejected');
    expect(p.w.hq.task(link.t)!.status).toBe('rejected');
  });

  it('works on a card that was already sent (opened pack): the existing approval is decided and approvalId is shown', async () => {
    const p = await packed();
    expect(await openPack(p.w)).toBe(1);
    const one = (await items(p))[0];
    expect(one.approvalId).toEqual(expect.any(Number));
    expect(p.w.queue.get(one.approvalId)!.status).toBe('pending');
    const r = await p.call('POST', `/admin/content/${one.id}`, { action: 'approve' });
    expect(r.json.item.status).toMatch(/^(approved|ready|rendering)$/);
    expect(p.w.queue.get(one.approvalId)!.status).toBe('executed');
  });

  it('revise with a note replaces a platform caption (or the script), the item stays pending; without a note or after approval it is refused', async () => {
    const p = await packed();
    const clip = await firstOf(p, 'clip');
    let r = await p.call('POST', `/admin/content/${clip.id}`, { action: 'revise', note: 'Новая подпись для TikTok #fir', platform: 'tiktok' });
    expect(r.status).toBe(200);
    expect(r.json.item.status).toBe('pending');
    expect(r.json.item.caption.tiktok).toBe('Новая подпись для TikTok #fir');
    expect(r.json.item.caption.shorts).toContain('Бот-администратор'); // other parts untouched
    r = await p.call('POST', `/admin/content/${clip.id}`, { action: 'revise', note: '1. Голос: Привет\n   Субтитр: Привет' });
    expect(r.json.item.status).toBe('pending');
    expect(store(p).item(clip.id)!.text).toContain('Привет');
    expect(store(p).item(clip.id)!.text).toContain('Новая подпись для TikTok #fir');
    expect((await p.call('POST', `/admin/content/${clip.id}`, { action: 'revise' })).json.error).toBe('invalid');
    await p.call('POST', `/admin/content/${clip.id}`, { action: 'approve' });
    expect(store(p).item(clip.id)!.status).toBe('ready');
    expect((await p.call('POST', `/admin/content/${clip.id}`, { action: 'revise', note: 'поздно' })).status).toBe(409);
    // an edited item does not count as a clean approval (the streak reset of the queue)
    expect(p.w.queue.streak('content_item')).toBe(0);
  });

  it('published marks every ready platform row (or one platform), idempotent; refused before approval', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shell-renders-'));
    const p = await packed({ rendersDir: dir });
    const clip = await firstOf(p, 'clip');
    expect((await p.call('POST', `/admin/content/${clip.id}`, { action: 'published' })).status).toBe(409);
    await p.call('POST', `/admin/content/${clip.id}`, { action: 'approve' });
    expect(store(p).rowsOfItem(clip.id).map((r) => r.platform).sort()).toEqual(['instagram', 'shorts', 'tiktok']);
    let r = await p.call('POST', `/admin/content/${clip.id}`, { action: 'published', platform: 'instagram' });
    expect(r.json.item.status).not.toBe('published');
    expect(store(p).rowsOfItem(clip.id).filter((x) => x.status === 'published').map((x) => x.platform)).toEqual(['instagram']);
    r = await p.call('POST', `/admin/content/${clip.id}`, { action: 'published' });
    expect(r.json.item.status).toBe('published');
    r = await p.call('POST', `/admin/content/${clip.id}`, { action: 'published' });
    expect(r.json.item.status).toBe('published');
    expect(r.json.ok).toBe(true);
    expect((await p.call('GET', `/admin/content?week=${WEEK}`)).json.summary.published).toBe(1);
    expect((await p.call('POST', `/admin/content/${clip.id}`, { action: 'published', platform: 'dzen' })).status).toBe(400);
  });

  it('rerender: a reel goes back to the render queue (status rendering), an image item is drawn again; not for unapproved items', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shell-renders-'));
    const p = await packed({ cadence: NEW_PACK, rendersDir: dir, renderReels: true });
    const clip = await firstOf(p, 'clip');
    const post = await firstOf(p, 'post');
    expect((await p.call('POST', `/admin/content/${clip.id}`, { action: 'rerender' })).status).toBe(409);
    await p.call('POST', `/admin/content/${clip.id}`, { action: 'approve' });
    let r = await p.call('GET', `/admin/content?week=${WEEK}`);
    expect(r.json.days.flatMap((d: any) => d.items).find((i: any) => i.id === clip.id)).toMatchObject({ status: 'rendering' });
    expect(r.json.summary.rendering).toBe(1);
    // an active job is kept: the call is fine and the status stays rendering
    r = await p.call('POST', `/admin/content/${clip.id}`, { action: 'rerender' });
    expect(r.json.item.status).toBe('rendering');
    await p.call('POST', `/admin/content/${post.id}`, { action: 'approve' });
    store(p).setFiles(post.id, []);
    expect((await items(p)).find((i) => i.id === post.id)!.files).toEqual([]);
    r = await p.call('POST', `/admin/content/${post.id}`, { action: 'rerender' });
    expect(r.json.item.files).toEqual([{ path: `${post.id}/1.png`, type: 'png', w: 1080, h: 1350 }]);
  });

  it('validates: action, fields, ids', async () => {
    const p = await packed();
    const clip = await firstOf(p, 'clip');
    for (const bad of [{}, { action: 'delete' }, { action: 'approve', extra: 1 }, { action: 'revise', note: 'x'.repeat(4001) }, { action: 'published', platform: 'vk' }, { action: 5 }]) {
      const r = await p.call('POST', `/admin/content/${clip.id}`, bad);
      expect(r.status).toBe(400);
      expect(r.json).toMatchObject({ ok: false, error: 'invalid' });
    }
    expect((await p.call('POST', '/admin/content/999', { action: 'approve' })).status).toBe(404);
    expect((await p.call('POST', '/admin/content/x1', { action: 'approve' })).status).toBe(404);
    expect((await p.call('POST', '/admin/content/a999', { action: 'approve' })).status).toBe(404);
    expect((await p.call('POST', '/admin/content', { action: 'approve' })).status).toBe(404);
    expect((await p.call('DELETE', `/admin/content/${clip.id}`, {})).status).toBe(404);
  });

  it('an item that is not waiting (a draft) cannot be approved', async () => {
    const p = shellWorld();
    const id = store(p).insertItem({ packId: null, seq: 1, total: 1, type: 'post', topicKey: 'k', topicText: 'тема', plannedDate: '2026-11-24' });
    const it = (await items(p)).find((i) => i.id === id);
    expect(it).toMatchObject({ status: 'draft', title: 'тема' });
    const r = await p.call('POST', `/admin/content/${id}`, { action: 'approve' });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('not_pending');
  });
});

describe('articles in the calendar', () => {
  async function withArticle() {
    const p = shellWorld();
    p.w.hq.createTask({ title: 'Статья дня', body: '', dept: 'marketing', creator: 'owner', meta: { action: 'article' } });
    p.w.hq.wake('marketing-head', 'task');
    await p.w.marketing.onHeartbeat();
    await p.w.director.sendApprovalBatch(false);
    return { p, art: store(p).articles()[0]! };
  }
  const row = async (p: ShellWorld, id: string) => (await p.call('GET', '/admin/content?week=2026-W47')).json.days.flatMap((d: any) => d.items).find((i: any) => i.id === id);

  it('an article waits as pending with its approval id; ids are a<number>', async () => {
    const { p, art } = await withArticle();
    expect(art.status).toBe('proposed');
    const r = await row(p, `a${art.id}`);
    expect(r).toMatchObject({ kind: 'article', platform: 'blog', status: 'pending', publishedUrl: null });
    expect(r.approvalId).toEqual(expect.any(Number));
  });

  it('approve publishes it through the same card path (idempotent); only approve, reject and revise apply to an article', async () => {
    const { p, art } = await withArticle();
    const r = await p.call('POST', `/admin/content/a${art.id}`, { action: 'approve' });
    expect(r.json.item).toMatchObject({ status: 'published', publishedUrl: `/blog/${store(p).article(art.id)!.slug}` });
    expect(store(p).article(art.id)).toMatchObject({ status: 'approved', published: true });
    const n = (p.w.db.prepare("SELECT COUNT(*) n FROM decisions WHERE kind = 'article'").get() as { n: number }).n;
    expect((await p.call('POST', `/admin/content/a${art.id}`, { action: 'approve' })).json.item.status).toBe('published');
    expect((p.w.db.prepare("SELECT COUNT(*) n FROM decisions WHERE kind = 'article'").get() as { n: number }).n).toBe(n);
    expect((await p.call('POST', `/admin/content/a${art.id}`, { action: 'reject' })).status).toBe(409);
    for (const action of ['published', 'rerender']) expect((await p.call('POST', `/admin/content/a${art.id}`, { action })).status).toBe(409);
  });

  it('revise is the owner\'s remark: the card is closed and the article is written again; reject closes it', async () => {
    const { p, art } = await withArticle();
    const r = await p.call('POST', `/admin/content/a${art.id}`, { action: 'revise', note: 'Короче и без воды' });
    expect(r.status).toBe(200);
    expect(store(p).article(art.id)!.comment).toBe('Короче и без воды');
    expect(p.w.hq.tasks({ dept: 'marketing' }).some((t) => t.title.startsWith('Переделать статью'))).toBe(true);
    const other = await withArticle();
    expect((await other.p.call('POST', `/admin/content/a${other.art.id}`, { action: 'reject' })).json.item.status).toBe('rejected');
  });
});

describe('Content Studio: feed and orders', () => {
  it('feed lists everything newest first with filters, review id and cursor; bad filters are 400', async () => {
    const p = await packed({ cadence: NEW_PACK });
    const r = await p.call('GET', '/admin/content/feed?limit=5');
    expect(r.status).toBe(200);
    expect(r.json.items).toHaveLength(5);
    expect(r.json.total).toBe(17);
    expect(r.json.nextCursor).toBe('5');
    expect(r.json.items[0]).toMatchObject({ status: 'pending', origin: null });
    expect(r.json.items[0].reviewId).toMatch(/^ap_\d+$/);
    const next = await p.call('GET', '/admin/content/feed?limit=200&cursor=5&kind=clip');
    expect(next.json.items.every((i: any) => i.kind === 'clip')).toBe(true);
    for (const bad of ['status=x', 'kind=x', 'limit=0x', 'cursor=-1']) expect((await p.call('GET', `/admin/content/feed?${bad}`)).status).toBe(400);
  });

  it('a prompt order is a Content Maker task; the result comes back as an approval linked to the order', async () => {
    const p = shellWorld();
    expect((await p.call('POST', '/admin/content/orders', { mode: 'prompt', prompt: 'a' })).status).toBe(400);
    expect((await p.call('POST', '/admin/content/orders', { mode: 'prompt', prompt: 'Про ночные заявки', extra: 1 })).status).toBe(400);
    const r = await p.call('POST', '/admin/content/orders', { mode: 'prompt', prompt: 'Про ночные заявки в барбершопе', type: 'post' });
    expect(r.status).toBe(200);
    expect(r.json.order).toMatchObject({ mode: 'prompt', state: 'working', itemId: null, reviewId: null, type: 'post' });
    expect(p.w.hq.task(r.json.order.id)!.meta).toMatchObject({ action: 'topic', type: 'post', source: 'owner' });
    await p.w.marketing.onHeartbeat();
    const list = (await p.call('GET', '/admin/content/orders')).json.items;
    expect(list[0]).toMatchObject({ id: r.json.order.id, state: 'delivered', itemStatus: 'pending' });
    expect(list[0].reviewId).toMatch(/^ap_\d+$/);
    expect(store(p).item(list[0].itemId)!.type).toBe('post');
    const feed = (await p.call('GET', '/admin/content/feed')).json.items.find((i: any) => i.id === list[0].itemId);
    expect(feed.origin).toEqual({ orderId: r.json.order.id, mode: 'prompt', fromItemId: null });
    expect(feed.reviewId).toBe(list[0].reviewId);
  });

  it('more variant and for a niche: a new item next to the original, linked by reviseOf and by the order; bad input is refused', async () => {
    const p = await packed({ cadence: NEW_PACK });
    const clip = await firstOf(p, 'clip');
    const v = await p.call('POST', '/admin/content/orders', { mode: 'variant', fromItemId: clip.id });
    expect(v.status).toBe(200);
    const n = await p.call('POST', '/admin/content/orders', { mode: 'niche', fromItemId: String(clip.id), niche: 'барбершоп', note: 'без цен' });
    expect(n.status).toBe(200);
    expect(p.w.hq.task(n.json.order.id)!.meta).toMatchObject({ action: 'revise_item', fromItemId: clip.id, studio: { mode: 'niche', fromItemId: clip.id } });
    await p.w.marketing.onHeartbeat();
    const list = (await p.call('GET', '/admin/content/orders')).json.items;
    expect(list.map((o: any) => [o.mode, o.state, o.fromItemId])).toEqual([['niche', 'delivered', clip.id], ['variant', 'delivered', clip.id]]);
    expect(list[0].itemId).not.toBe(clip.id);
    expect((await p.call('POST', '/admin/content/orders', { mode: 'niche', fromItemId: clip.id, niche: 'нет такой ниши xyz' })).json.error).toBe('invalid_niche');
    expect((await p.call('POST', '/admin/content/orders', { mode: 'variant', fromItemId: 99999 })).status).toBe(404);
    expect((await p.call('POST', '/admin/content/orders', { mode: 'variant' })).status).toBe(400);
  });
});
