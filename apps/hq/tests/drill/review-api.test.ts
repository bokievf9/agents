/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drillWorld, type DrillWorld } from './world.js';
import { seedEverything } from './seed.js';
import { useGuard } from './guard.js';

const g = useGuard();
const KINDS = ['content_pack', 'content_item', 'article', 'seo_proposal', 'audit', 'support_answer', 'support_money', 'billing_invoice', 'onboarding_guide', 'presales_pack', 'prospect_first', 'lead_reply', 'lead_price', 'pm_spec', 'pm_client_status', 'bo_document'];

async function seeded(): Promise<DrillWorld> {
  const w = await drillWorld();
  for (const k of w.queue.trustTable()) w.queue.setLevel(k.kind, 0);
  await seedEverything(w);
  return w;
}
const list = async (w: DrillWorld, qs = 'status=all&limit=200') => (await w.adm('GET', `/admin/review?${qs}`)).json.items as any[];
const first = async (w: DrillWorld, kind: string, status = 'pending') => (await list(w)).find((i) => i.kind === kind && i.status === status);

describe('GET /admin/review lists every kind in one shape', () => {
  let w: DrillWorld;
  beforeAll(async () => { w = await seeded(); }, 60_000);
  afterAll(async () => { await w?.close(); });
  it.each(KINDS)('%s has the contract fields', async (kind) => {
    const it = await first(w, kind);
    expect(it, `no ${kind} in the review list`).toBeDefined();
    expect(it).toMatchObject({ id: expect.stringMatching(/^ap_\d+$/), kind, status: 'pending', dept: expect.any(String) });
    expect(Array.isArray(it.actions)).toBe(true);
    expect(it.actions).toContain('approve');
    expect(it.actions).toContain('reject');
    expect(typeof it.title).toBe('string');
    expect(it.versions.length).toBeGreaterThanOrEqual(1);
  });
  it('filters, pages and bad parameters', async () => {
    for (const q of ['dept=sales', 'dept=all', 'status=decided', 'limit=0', 'limit=201', 'limit=1', 'limit=200', 'cursor=5']) expect((await w.adm('GET', `/admin/review?${q}`)).status, q).toBe(200);
    for (const q of ['dept=nope', 'status=x', 'limit=abc', 'limit=-1', 'cursor=abc']) expect((await w.adm('GET', `/admin/review?${q}`)).status, q).toBe(400);
    const page1 = (await w.adm('GET', '/admin/review?limit=3')).json;
    expect(page1.items).toHaveLength(3);
    expect((await w.adm('GET', `/admin/review?limit=3&cursor=${page1.nextCursor}`)).json.items[0].id).not.toBe(page1.items[0].id);
    expect(g.errors()).toEqual([]);
  });
});

describe.each([['approve'], ['reject']] as const)('POST /admin/review/:id %s on every kind', (action) => {
  let w: DrillWorld;
  beforeAll(async () => { w = await seeded(); }, 60_000);
  afterAll(async () => { await w?.close(); });
  it.each(KINDS.filter((k) => k !== 'content_item'))(`${action} %s`, async (kind) => {
    const item = await first(w, kind);
    expect(item, `no ${kind}`).toBeDefined();
    let r = await w.adm('POST', `/admin/review/${item.id}`, { action });
    if (r.status === 409 && r.json.error === 'placeholder') {
      expect(action).toBe('approve');
      expect((await first(w, kind)).status).toBe('pending'); // held open, not failed
      const e = await w.adm('POST', `/admin/review/${item.id}`, { action: 'edit', text: { draft: 'Готовый текст владельца, всё впишу сам.' } });
      expect(e.status, JSON.stringify(e.json)).toBe(200);
      r = await w.adm('POST', `/admin/review/${item.id}`, { action });
    }
    expect(r.status, `${kind}: ${r.text.slice(0, 200)}`).toBe(200);
    expect(r.json.ok, `${kind}: ${r.text.slice(0, 300)}`).toBe(true);
    const after = (await list(w)).find((i) => i.id === item.id);
    expect(after.status).toMatch(action === 'approve' ? /^(approved|published)$/ : /^rejected$/);
    // the same press again is a no-op, the opposite one is refused
    expect((await w.adm('POST', `/admin/review/${item.id}`, { action })).status).toBe(200);
    const opposite = await w.adm('POST', `/admin/review/${item.id}`, { action: action === 'approve' ? 'reject' : 'approve' });
    expect(opposite.status).toBe(409);
    expect(opposite.json.error).toBe('already_decided');
    expect(g.errors()).toEqual([]);
    expect(g.rejections).toEqual([]);
  });
});

describe('POST /admin/review/:id edit, revise, send, call, reschedule, publish_now', () => {
  let w: DrillWorld;
  beforeAll(async () => { w = await seeded(); }, 60_000);
  afterAll(async () => { await w?.close(); });
  it('bad ids, bodies and unknown actions', async () => {
    expect((await w.adm('POST', '/admin/review/zzz', { action: 'approve' })).status).toBe(404);
    expect((await w.adm('POST', '/admin/review/ap_999999', { action: 'approve' })).status).toBe(404);
    const item = await first(w, 'lead_reply');
    for (const body of [{}, { action: 'nope' }, { action: 'approve', extra: 1 }, { action: 'edit' }, { action: 'call' }, { action: 'call', slot: 'tomorrow' }, 'text']) {
      const r = await w.adm('POST', `/admin/review/${item.id}`, body);
      expect([400, 409], JSON.stringify(body)).toContain(r.status);
    }
    expect((await w.adm('POST', `/admin/review/${item.id}`, '{broken')).status).toBe(400);
    expect(g.errors()).toEqual([]);
  });
  it.each(KINDS.filter((k) => !['content_pack', 'content_item', 'article', 'seo_proposal', 'presales_pack'].includes(k)))('edit then approve %s', async (kind) => {
    const item = await first(w, kind);
    expect(item.actions, kind).toContain('edit');
    const e = await w.adm('POST', `/admin/review/${item.id}`, { action: 'edit', text: { draft: 'Новый текст от владельца без заготовок.' }, note: 'сам' });
    expect(e.status, `${kind} ${e.text.slice(0, 200)}`).toBe(200);
    const after = await first(w, kind);
    expect(after.status).toBe('pending');
    expect(after.currentVersion).toBeGreaterThanOrEqual(2);
    expect((await w.adm('POST', `/admin/review/${item.id}`, { action: 'edit', text: { draft: 'Новый текст от владельца без заготовок.' } })).status).toBe(409); // unchanged
    const ok = await w.adm('POST', `/admin/review/${item.id}`, { action: 'approve' });
    expect(ok.status, `${kind} ${ok.text.slice(0, 300)}`).toBe(200);
    expect(g.errors()).toEqual([]);
  });
  it('send, call on the lead kinds', async () => {
    const item = await first(w, 'support_answer');
    if (item) {
      const r = await w.adm('POST', `/admin/review/${item.id}`, { action: 'send' });
      expect([200, 409], r.text).toContain(r.status);
    }
    const lead = (await list(w)).find((i) => i.kind === 'presales_pack');
    const c = await w.adm('POST', `/admin/review/${lead.id}`, { action: 'call', slot: '2026-11-24T10:00:00Z' });
    expect([200, 409], c.text).toContain(c.status);
    expect(g.errors()).toEqual([]);
  });
  it('article and content item: revise, reschedule, publish_now', async () => {
    const art = await first(w, 'article');
    const rev = await w.adm('POST', `/admin/review/${art.id}`, { action: 'revise', note: 'короче и без воды' });
    expect(rev.status, rev.text).toBe(200);
    const open = (await list(w)).filter((i) => i.kind === 'content_pack');
    expect(open.length).toBe(1);
    const pk = w.queue.pending().find((r) => r.kind === 'content_pack')!;
    await w.press(`pk:${pk.id}:o`);
    const item = (await list(w)).find((i) => i.kind === 'content_item' && i.status === 'pending');
    expect(item).toBeDefined();
    const resch = await w.adm('POST', `/admin/review/${item.id}`, { action: 'reschedule', slot: '2026-12-01' });
    expect(resch.status, resch.text).toBe(200);
    expect((await w.adm('POST', `/admin/review/${item.id}`, { action: 'reschedule', slot: 'soon' })).status).toBe(400);
    const edit = await w.adm('POST', `/admin/review/${item.id}`, { action: 'edit', text: { body: 'Новый сценарий: клиент пишет ночью, бот отвечает сразу.' } });
    expect([200, 409], edit.text).toContain(edit.status);
    const rv = await w.adm('POST', `/admin/review/${item.id}`, { action: 'revise', note: 'другой хук' });
    expect(rv.status, rv.text).toBe(200);
    const pub = await w.adm('POST', `/admin/review/${item.id}`, { action: 'publish_now' });
    expect([200, 409], pub.text).toContain(pub.status);
    expect(g.errors()).toEqual([]);
    expect(g.rejections).toEqual([]);
  });
});

describe('POST /admin/review/:id on content items and the pack', () => {
  it('approve and reject an item opened from the pack, the pack card still decides the rest, repeats are no-ops', async () => {
    const w = await seeded();
    try {
      const pack = (await w.adm('GET', '/admin/review?status=pending&limit=200')).json.items.find((i: any) => i.kind === 'content_pack');
      expect(pack.meta.pack.itemIds.length).toBeGreaterThan(5);
      const [a, b, c] = pack.meta.pack.itemIds as string[];
      const ok = await w.adm('POST', `/admin/review/${a}`, { action: 'approve' });
      expect(ok.status, ok.text).toBe(200);
      expect((await w.adm('POST', `/admin/review/${a}`, { action: 'approve' })).status).toBe(200);
      expect((await w.adm('POST', `/admin/review/${a}`, { action: 'reject' })).status).toBe(409);
      const no = await w.adm('POST', `/admin/review/${b}`, { action: 'reject', note: 'не подходит хук' });
      expect(no.status, no.text).toBe(200);
      const items = (await list(w)).filter((i) => i.kind === 'content_item');
      expect(items.find((i) => i.id === a).status).toMatch(/approved|published/);
      expect(items.find((i) => i.id === b).status).toBe('rejected');
      expect(items.find((i) => i.id === c).status).toBe('pending');
      const done = await w.adm('POST', `/admin/review/${pack.id}`, { action: 'approve' }); // the pack decides what is left
      expect(done.status, done.text).toBe(200);
      expect((await list(w)).find((i) => i.id === c).status).toMatch(/approved|published/);
      expect(g.errors()).toEqual([]);
    } finally {
      await w.close();
    }
  }, 60_000);
});
