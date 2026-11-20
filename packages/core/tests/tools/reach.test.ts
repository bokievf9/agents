import { describe, expect, it } from 'vitest';
import { REACH_CACHE_MS, REACH_DAILY_CAP, REACH_FAIL_MS, REACH_QUEUE_EXPIRE_MS, REACH_RESULT_CAP, REACH_RUN_EXPIRE_MS, REACH_TTL_MS, ReachStore, TOOL_POLICY, capResult, cleanArgs, isAllowed, openDb, reachKey, reachSpec } from '../../src/index.js';
import { tools } from './helpers.js';

const DONE = { ok: true, items: [{ title: 'T', url: 'https://youtu.be/x', author: 'A', published_at: '2026-01-01', text: '0:00 hello\n0:03 world' }], meta: { lang: 'en' } };

function world(over: Parameters<typeof tools>[0] = {}) {
  const db = openDb(':memory:');
  const w = tools({ db, ...over });
  const store = new ReachStore(db, () => w.clock.t);
  return { ...w, db, store };
}

describe('policy rows', () => {
  it('marketing: youtube, web, instagram, twitter, reddit; sales: linkedin, reddit, web, github; support none', () => {
    const rows = TOOL_POLICY.filter((p) => p.name.startsWith('reach.'));
    expect(rows.length).toBe(20);
    expect(isAllowed('reach.youtube.subtitle', 'marketing')).toBe(true);
    expect(isAllowed('reach.youtube.subtitle', 'sales')).toBe(false);
    expect(isAllowed('reach.linkedin.jobs', 'sales')).toBe(true);
    expect(isAllowed('reach.linkedin.jobs', 'marketing')).toBe(false);
    expect(isAllowed('reach.reddit.search', 'sales')).toBe(true);
    expect(isAllowed('reach.reddit.search', 'marketing')).toBe(true);
    expect(isAllowed('reach.github.read', 'sales')).toBe(true);
    for (const r of rows) expect(isAllowed(r.name, 'support'), r.name).toBe(false);
  });
});

describe('cleanArgs', () => {
  it('requires positionals, rejects options-lookalikes, unknown keys and control characters', () => {
    const sub = reachSpec('youtube', 'subtitle')!;
    expect(cleanArgs(sub, { target: 'https://youtu.be/abc', lang: 'ru,en' })).toEqual({ ok: true, args: { target: 'https://youtu.be/abc', lang: 'ru,en' } });
    expect(cleanArgs(sub, {})).toMatchObject({ ok: false });
    expect(cleanArgs(sub, { target: '--help' })).toMatchObject({ ok: false });
    expect(cleanArgs(sub, { target: 'a b' })).toMatchObject({ ok: false });
    expect(cleanArgs(sub, { target: 'https://x.y/\n' })).toMatchObject({ ok: true }); // trimmed
    expect(cleanArgs(sub, { target: 'https://x.y/a\nb' })).toMatchObject({ ok: false });
    expect(cleanArgs(sub, { target: 'x', extra: 1 })).toMatchObject({ ok: false });
    expect(cleanArgs(sub, { target: 'x', lang: 'ru; rm -rf' })).toMatchObject({ ok: false });
    expect(cleanArgs(reachSpec('instagram', 'posts')!, { username: '@fir.tech', limit: 5 })).toEqual({ ok: true, args: { username: 'fir.tech', limit: 5 } });
    expect(cleanArgs(reachSpec('instagram', 'posts')!, { username: 'a', limit: 99 })).toMatchObject({ ok: false });
    expect(reachSpec('youtube', 'post')).toBeUndefined();
    expect(reachSpec('constructor', 'x')).toBeUndefined();
  });
  it('the key does not depend on the order of the arguments', () => {
    expect(reachKey('youtube', 'subtitle', { target: 'a', lang: 'en' })).toBe(reachKey('youtube', 'subtitle', { lang: 'en', target: 'a' }));
    expect(reachKey('youtube', 'subtitle', { target: 'a' })).not.toBe(reachKey('youtube', 'read', { target: 'a' }));
  });
});

describe('tools.reach: queued, then cached', () => {
  it('answers queued at once, the same call attaches to the open job, a done job is served from the table for 24 h', async () => {
    const { t, store, journal, clock } = world();
    const a = await t.reach.youtube.subtitle({ target: 'https://youtu.be/abc' });
    expect(a).toEqual({ ok: true, value: { state: 'queued', jobId: 1 } });
    expect(await t.reach.youtube.subtitle({ target: 'https://youtu.be/abc' })).toEqual({ ok: true, value: { state: 'queued', jobId: 1 } });
    expect(store.get(1)).toMatchObject({ status: 'queued', taskId: 7, channel: 'youtube', action: 'subtitle', agentId: 'trend-scout' });
    expect(journal.lines.at(-1)).toMatchObject({ action: 'tool:reach.youtube.subtitle', objectId: '7' });
    expect(store.claim(1)).toBe(true);
    expect(store.finish(1, { ok: true, result: DONE })).toMatchObject({ applied: true });
    const b = await t.reach.youtube.subtitle({ target: 'https://youtu.be/abc' });
    expect(b).toMatchObject({ ok: true, value: { state: 'done', jobId: 1, result: DONE } });
    clock.t += REACH_CACHE_MS + 1;
    expect(await t.reach.youtube.subtitle({ target: 'https://youtu.be/abc' })).toEqual({ ok: true, value: { state: 'queued', jobId: 2 } });
  });

  it('a failed job is not asked again for an hour; NEED_LOGIN is not_configured', async () => {
    const { t, store, clock } = world();
    await t.reach.instagram.profile({ username: 'rival' });
    store.claim(1);
    store.finish(1, { ok: true, result: { ok: false, items: [], meta: {}, error: { code: 'NEED_LOGIN', message: 'log in' } } });
    expect(store.get(1)).toMatchObject({ status: 'failed', error: 'NEED_LOGIN: log in' });
    expect(await t.reach.instagram.profile({ username: 'rival' })).toMatchObject({ ok: false, error: 'not_configured', retryable: false });
    clock.t += REACH_FAIL_MS + 1;
    expect(await t.reach.instagram.profile({ username: 'rival' })).toMatchObject({ ok: true, value: { state: 'queued', jobId: 2 } });
  });

  it('another task asking for the same open job is remembered as a waiter', async () => {
    const { store, db, clock } = world();
    const a = world({ db, taskId: 8 });
    await a.t.reach.web.read({ target: 'https://example.com/' });
    const b = world({ db, taskId: 9 });
    expect(await b.t.reach.web.read({ target: 'https://example.com/' })).toMatchObject({ ok: true, value: { state: 'queued', jobId: 1 } });
    void clock; void store;
    expect(new ReachStore(db).get(1)).toMatchObject({ taskId: 8, waiters: [9] });
  });

  it('validation, rights, no database and the daily cap', async () => {
    const w = world();
    expect(await w.t.reach.youtube.subtitle({})).toMatchObject({ ok: false, error: 'invalid' });
    expect(await w.t.reach.youtube.search({ query: '--x' })).toMatchObject({ ok: false, error: 'invalid' });
    const sales = world({ dept: 'sales', agentId: 'scout' });
    expect(await sales.t.reach.youtube.search({ query: 'x' })).toMatchObject({ ok: false, error: 'not_allowed' });
    expect(await sales.t.reach.linkedin.jobs({ query: 'ai engineer', location: 'Dubai', limit: 5 })).toMatchObject({ ok: true, value: { state: 'queued' } });
    const support = world({ dept: 'support' });
    expect(await support.t.reach.web.read({ target: 'https://example.com/' })).toMatchObject({ ok: false, error: 'not_allowed' });
    expect(await tools().t.reach.web.read({ target: 'https://example.com/' })).toMatchObject({ ok: false, error: 'not_configured' });
    expect(await w.t.call('reach.web.read', { target: 'https://example.com/' })).toMatchObject({ ok: true });

    const c = world();
    for (let i = 0; i < REACH_DAILY_CAP; i++) c.store.create('web', 'search', { query: `q${i}` }, null, null);
    expect(await c.t.reach.web.search({ query: 'one more' })).toMatchObject({ ok: false, error: 'rate_limited', retryable: false });
    expect(await c.t.reach.web.search({ query: 'q3' })).toMatchObject({ ok: true, value: { state: 'queued' } }); // an open job of the same key is no new job
    c.clock.t += 86_400_000 + 1;
    expect(await c.t.reach.web.search({ query: 'later' })).toMatchObject({ ok: true });
  });
});

describe('ReachStore', () => {
  it('claim is won once; the result is accepted once and a repeat is a no-op; a queued job cannot be answered', () => {
    const { store } = world();
    const j = store.create('youtube', 'read', { target: 'abc' }, 1, 'x');
    expect(store.finish(j.id, { ok: true, result: DONE })).toMatchObject({ applied: false, reason: 'not_claimed' });
    expect(store.claim(j.id)).toBe(true);
    expect(store.claim(j.id)).toBe(false);
    expect(store.finish(j.id, { ok: true, result: DONE })).toMatchObject({ applied: true });
    expect(store.finish(j.id, { ok: false, error: 'late' })).toMatchObject({ applied: false });
    expect(store.get(j.id)).toMatchObject({ status: 'done', error: null });
    expect(store.finish(999, { ok: true, result: DONE })).toEqual({ applied: false });
  });

  it('a Mac-side error answer is a failed job with the reason', () => {
    const { store } = world();
    const j = store.create('web', 'read', { target: 'x' }, null, null);
    store.claim(j.id);
    store.finish(j.id, { ok: false, error: 'timeout after 120 s' });
    expect(store.get(j.id)).toMatchObject({ status: 'failed', error: 'timeout after 120 s', result: null });
  });

  it('expire: queued 6 h and running 30 min fail; purge removes jobs past the 7-day ttl', () => {
    const { store, clock } = world();
    const q = store.create('web', 'read', { target: 'q' }, null, null);
    const r = store.create('web', 'read', { target: 'r' }, null, null);
    store.claim(r.id);
    clock.t += REACH_RUN_EXPIRE_MS + 1;
    expect(store.expire().map((j) => j.id)).toEqual([r.id]);
    clock.t += REACH_QUEUE_EXPIRE_MS;
    expect(store.expire().map((j) => j.id)).toEqual([q.id]);
    expect(store.get(q.id)).toMatchObject({ status: 'failed' });
    expect(store.purge()).toBe(0);
    clock.t += REACH_TTL_MS;
    expect(store.purge()).toBe(2);
    expect(store.counts()).toEqual({ queued: 0, running: 0, done: 0, failed: 0 });
  });

  it('the result is capped at 200 KB: long texts are halved and meta.truncated is set', () => {
    const big = { ok: true, items: [{ title: 'x', text: 'a'.repeat(600_000) }, { title: 'y', text: 'b'.repeat(10) }], meta: {} };
    const c = capResult(big);
    expect(Buffer.byteLength(JSON.stringify(c))).toBeLessThanOrEqual(REACH_RESULT_CAP);
    expect(c.meta.truncated).toBe(true);
    expect(c.items[0]!.title).toBe('x');
    expect(capResult(DONE)).toEqual(DONE);
    const { store } = world();
    const j = store.create('web', 'read', { target: 'big' }, null, null);
    store.claim(j.id);
    store.finish(j.id, { ok: true, result: big });
    expect(JSON.stringify(store.get(j.id)!.result).length).toBeLessThanOrEqual(REACH_RESULT_CAP);
  });
});
