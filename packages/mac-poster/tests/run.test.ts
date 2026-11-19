import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BlockedError, ManualError, StuckError } from '../src/guards.js';
import { HqClient, HqError, type HqDay, type HqFile } from '../src/hq.js';
import { runInstagram, type RunDeps } from '../src/run.js';
import type { SitePoster } from '../src/site.js';
import { emptyState, recordPost, type State } from '../src/state.js';

const TOKEN = 'secret-admin-token';

/** A fake HQ behind a mocked fetch: records every call. */
function fakeHq(days: Record<string, HqDay[]>, opts: { status?: number; queued?: unknown[] } = {}) {
  const calls: { method: string; url: string; headers: Record<string, string>; body?: unknown }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    calls.push({ method: init.method!, url, headers, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (opts.status) return new Response(JSON.stringify({ ok: false, error: 'boom' }), { status: opts.status });
    const u = new URL(url);
    if (u.pathname === '/admin/content' && u.searchParams.get('queued') === '1') return Response.json({ ok: true, week: '2026-W48', days: [], queuedItems: opts.queued ?? [] });
    if (u.pathname === '/admin/content') return Response.json({ ok: true, week: u.searchParams.get('week'), days: days[u.searchParams.get('week')!] ?? [] });
    if (u.pathname.startsWith('/admin/files/')) return new Response(Buffer.from(`bytes:${decodeURIComponent(u.pathname.slice(13))}`));
    if (u.pathname.startsWith('/admin/content/')) return Response.json({ ok: true, item: { id: Number(u.pathname.split('/')[3]) } });
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return { client: new HqClient('http://127.0.0.1:18787', TOKEN, fetchImpl), calls };
}

const png = (p: string) => ({ path: p, type: 'png' as const, w: 1080, h: 1350 });
const it_ = (id: number, kind: 'clip' | 'post' | 'carousel' | 'story', files: HqFile[] = [png(`${id}/1.png`)]) => ({
  id, kind, platform: 'instagram', status: 'ready' as const, title: `t${id}`, caption: { instagram: 'x' }, igCaption: `cap ${id}`, files, publishedUrl: null, error: null, publishedOn: [],
});
const WEEKS = {
  '2026-W48': [{ date: '2026-11-23', items: [it_(1, 'post'), it_(2, 'clip', [{ path: '2/reel.mp4', type: 'mp4' as const, w: 1080, h: 1920 }]), it_(3, 'story'), it_(4, 'carousel', [png('4/1.png'), png('4/2.png')])] }],
};

function fakeSite(behaviour: (id: number, files: string[]) => Promise<{ url: string }>) {
  const log: string[] = [];
  const site: SitePoster = {
    site: 'instagram',
    start: () => { log.push('start'); return Promise.resolve(); },
    post: (item, files) => { log.push(`post ${item.id} ${files.map((f) => readFileSync(f, 'utf8')).join(',')}`); return behaviour(Number(item.id), files); },
    close: () => { log.push('close'); return Promise.resolve(); },
  };
  return { site, log };
}

function deps(over: Partial<RunDeps> & Pick<RunDeps, 'client' | 'openSite'>): RunDeps & { lines: string[]; saved: number } {
  const lines: string[] = [];
  const d = { state: emptyState(), saveState: () => { d.saved++; }, date: '2026-11-23', dryRun: false, limit: 6, dailyCap: 10, log: (l: string) => lines.push(l), workDir: mkdtempSync(join(tmpdir(), 'mp-run-')), lines, saved: 0, ...over };
  return d;
}

describe('HQ client (mocked fetch)', () => {
  it('sends the token in the header only; published and failed bodies; encoded file paths', async () => {
    const { client, calls } = fakeHq(WEEKS);
    await client.content('2026-W48');
    await client.file('41/slide 1.png');
    await client.published(41, 'https://www.instagram.com/p/X/');
    await client.failed(42, 'x'.repeat(400));
    expect(calls.every((c) => c.headers['x-admin-token'] === TOKEN && !c.url.includes(TOKEN))).toBe(true);
    expect(calls[0]!.url).toBe('http://127.0.0.1:18787/admin/content?week=2026-W48');
    expect(calls[1]!.url).toBe('http://127.0.0.1:18787/admin/files/41/slide%201.png');
    expect(calls[2]).toMatchObject({ method: 'POST', url: 'http://127.0.0.1:18787/admin/content/41', body: { action: 'published', platform: 'instagram', url: 'https://www.instagram.com/p/X/' } });
    expect(calls[3]!.body).toMatchObject({ action: 'failed', platform: 'instagram' });
    expect((calls[3]!.body as { note: string }).note).toHaveLength(300);
  });

  it('errors carry the status, never the token', async () => {
    const { client } = fakeHq({}, { status: 401 });
    const e = await client.content('2026-W48').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HqError);
    expect((e as HqError).status).toBe(401);
    expect(String((e as Error).message)).not.toContain(TOKEN);
    const e2 = await fakeHq({}, { status: 409 }).client.failed(1, 'n').catch((x: unknown) => x);
    expect((e2 as Error).message).toContain('409 boom');
    const down = new HqClient('http://127.0.0.1:1', TOKEN, (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch);
    expect(String(await down.content('2026-W48').catch((x: Error) => x.message))).toMatch(/HQ недоступен.*ECONNREFUSED/);
  });
});

describe('runInstagram', () => {
  it('dry run: prints the plan, opens no browser, posts nothing', async () => {
    const { client, calls } = fakeHq(WEEKS);
    let opened = 0;
    const d = deps({ client, dryRun: true, openSite: () => { opened++; return fakeSite(() => Promise.resolve({ url: '' })).site; } });
    const r = await runInstagram(d);
    expect(opened).toBe(0);
    expect(r.plan.map((p) => p.id)).toEqual([2, 4, 1, 3]);
    expect(d.lines[0]).toMatch(/^Instagram на 2026-11-23: к публикации 4, в этот запуск 4/);
    expect(calls.map((c) => c.url.replace('http://127.0.0.1:18787', ''))).toEqual(['/admin/content?week=2026-W47', '/admin/content?week=2026-W48', '/admin/content?queued=1']);
  });

  it('items agents queued through tools.mac.poster.enqueue are picked up from any week, once, only for instagram', async () => {
    const old = { ...it_(9, 'post'), macQueued: ['instagram'], plannedDate: '2026-10-01' }; // planned long ago, outside the two weeks
    const future = { ...it_(8, 'post'), macQueued: ['instagram'], plannedDate: '2026-12-20' }; // queued early: due now
    const other = { ...it_(7, 'post'), macQueued: ['tiktok'], plannedDate: '2026-10-01' };
    const dup = { ...it_(1, 'post'), macQueued: ['instagram'], plannedDate: '2026-11-23' }; // also in the week: listed once
    const { client, calls } = fakeHq(WEEKS, { queued: [old, future, other, dup] });
    const r = await runInstagram(deps({ client, dryRun: true, openSite: () => fakeSite(() => Promise.resolve({ url: '' })).site }));
    expect(r.plan.map((p) => p.id).sort((a, b) => Number(a) - Number(b))).toEqual([1, 2, 3, 4, 8, 9]);
    expect(r.plan.filter((p) => p.id === 1)).toHaveLength(1);
    expect(calls.some((c) => c.url.endsWith('/admin/content?queued=1'))).toBe(true);
    // an older HQ without queuedItems is not an error
    const plain = fakeHq(WEEKS);
    expect((await runInstagram(deps({ client: plain.client, dryRun: true, openSite: () => fakeSite(() => Promise.resolve({ url: '' })).site }))).plan).toHaveLength(4);
  });

  it('posts in order, downloads files, reports published/failed; manual stories and stuck items', async () => {
    const { client, calls } = fakeHq(WEEKS);
    const f = fakeSite((id) => {
      if (id === 3) return Promise.reject(new ManualError('вручную: в веб-версии не нашлась загрузка истории'));
      if (id === 1) return Promise.reject(new StuckError('после «Поделиться» не увидел подтверждения'));
      if (id === 4) return Promise.reject(new Error('шаг «caption»: timeout'));
      return Promise.resolve({ url: `https://www.instagram.com/reel/R${id}/` });
    });
    const d = deps({ client, openSite: () => f.site });
    const r = await runInstagram(d);
    expect(f.log).toEqual(['start', 'post 2 bytes:2/reel.mp4', 'post 4 bytes:4/1.png,bytes:4/2.png', 'post 1 bytes:1/1.png', 'post 3 bytes:3/1.png', 'close']);
    expect(r.posted).toEqual([{ id: 2, url: 'https://www.instagram.com/reel/R2/' }]);
    const posts = calls.filter((c) => c.method === 'POST').map((c) => [c.url.split('/').pop(), (c.body as { action: string; note?: string }).action, (c.body as { note?: string }).note ?? '']);
    expect(posts).toEqual([
      ['2', 'published', ''],
      ['4', 'failed', 'не получилось: шаг «caption»: timeout'],
      ['1', 'failed', 'после «Поделиться» не увидел подтверждения'],
      ['3', 'failed', 'вручную: в веб-версии не нашлась загрузка истории'],
    ]);
    expect(d.state.posted['2026-11-23']).toBe(1);
    expect(d.state.attempts).toMatchObject({ 1: '2026-11-23', 2: '2026-11-23', 3: '2026-11-23', 4: '2026-11-23' });
    expect(Object.keys(d.state.stuck)).toEqual(['1']);
    // the same day again: nothing left to try
    const again = await runInstagram({ ...d, openSite: () => { throw new Error('must not open'); } });
    expect(again.plan).toEqual([]);
  });

  it('a challenge stops the run, the item is not marked failed and stays for the next run', async () => {
    const { client, calls } = fakeHq(WEEKS);
    const f = fakeSite((id) => (id === 4 ? Promise.reject(new BlockedError({ kind: 'challenge', message: 'Instagram просит подтвердить вход' })) : Promise.resolve({ url: `https://www.instagram.com/p/P${id}/` })));
    const d = deps({ client, openSite: () => f.site });
    const r = await runInstagram(d);
    expect(r.stopped).toContain('подтвердить вход');
    expect(r.posted.map((p) => p.id)).toEqual([2]);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(d.state.attempts['4']).toBeUndefined();
    expect(f.log.at(-1)).toBe('close');
  });

  it('the run limit and the daily cap', async () => {
    const { client } = fakeHq(WEEKS);
    const f = fakeSite((id) => Promise.resolve({ url: `https://www.instagram.com/p/P${id}/` }));
    const r = await runInstagram(deps({ client, limit: 2, openSite: () => f.site }));
    expect(r.posted.map((p) => p.id)).toEqual([2, 4]);
    const state: State = emptyState();
    for (let i = 0; i < 10; i++) recordPost(state, '2026-11-23');
    let opened = 0;
    const d = deps({ client, state, openSite: () => { opened++; return f.site; } });
    await runInstagram(d);
    expect(opened).toBe(0);
    expect(d.lines.join('\n')).toContain('Дневной лимит 10 публикаций исчерпан');
  });

  it('a failed HQ report is logged, not fatal', async () => {
    const days = WEEKS;
    const base = fakeHq(days);
    const client = Object.assign(Object.create(Object.getPrototypeOf(base.client) as object) as HqClient, base.client, { published: () => Promise.reject(new HqError(503, 'HQ POST: 503 unavailable')) });
    const f = fakeSite(() => Promise.resolve({ url: 'https://www.instagram.com/p/Z/' }));
    const d = deps({ client, limit: 1, openSite: () => f.site });
    const r = await runInstagram(d);
    expect(r.posted).toHaveLength(1);
    expect(d.lines.join('\n')).toContain('HQ не принял отчёт: HQ POST: 503 unavailable');
  });
});
