import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLlm, openDb, type SafeGetOptions, type SafeGetResult, type SafePostOptions, type SafePostResult } from '@fir/core';
import type { WorkerCtx } from '@fir/hq';
import { onApproved, renderClip, storeFor, type Clip } from '@fir/worker-content-maker';
import { describe, expect, it } from 'vitest';
import { IgApi, InstagramDaily, InstagramPoster, PostPending, PublishStore, PublisherWorker, TOKEN_EXPIRED_TEXT, instagramWeekLine, mediaUrl, resolveMedia, signMedia, tokenDaysLeft, verifyMedia, type PublishPack } from '../src/index.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 23, 4, 0);
const BASE = 'https://firtech.pro/media';
const pack = (over: Partial<PublishPack> = {}): PublishPack => ({
  readyId: 3, itemId: 7, platform: 'instagram', type: 'clip', plannedDate: '2026-11-23', title: 'Запись',
  caption: 'Подпись', hashtags: ['#fir'], files: ['/data/renders/7/reel.mp4'], ...over,
});

interface Call { method: 'GET' | 'POST'; url: string; body?: Record<string, unknown>; headers: Record<string, string> }
/** A scripted Graph API. `route` answers by method and path (without the version); unknown paths answer 200 {}. */
function graph(route: (c: Call, path: string, q: URLSearchParams) => { status?: number; body?: unknown } | undefined = () => undefined) {
  const calls: Call[] = [];
  const answer = (c: Call): { status: number; body: unknown } => {
    calls.push(c);
    const u = new URL(c.url);
    const path = u.pathname.replace(/^\/v[\d.]+\//, '');
    const r = route(c, path, u.searchParams);
    if (r) return { status: r.status ?? 200, body: r.body ?? {} };
    if (path.endsWith('content_publishing_limit')) return { status: 200, body: { data: [{ quota_usage: 2, config: { quota_total: 50 } }] } };
    if (path.endsWith('/media_publish')) return { status: 200, body: { id: 'M1' } };
    if (path.endsWith('/media')) return { status: 200, body: { id: `C${calls.filter((x) => x.method === 'POST').length}` } };
    if (u.searchParams.get('fields') === 'status_code') return { status: 200, body: { status_code: 'FINISHED' } };
    if (u.searchParams.get('fields') === 'permalink') return { status: 200, body: { permalink: 'https://www.instagram.com/reel/ABC123/' } };
    return { status: 200, body: {} };
  };
  const get = (url: string, o: SafeGetOptions): Promise<SafeGetResult> => {
    const a = answer({ method: 'GET', url, headers: o.headers ?? {} });
    return Promise.resolve({ ok: true, status: a.status, body: a.status === 200 ? a.body : null });
  };
  const post = (url: string, o: SafePostOptions): Promise<SafePostResult> => {
    const a = answer({ method: 'POST', url, body: JSON.parse(o.body as string) as Record<string, unknown>, headers: o.headers ?? {} });
    return Promise.resolve({ ok: true, status: a.status, body: a.body, headers: {} });
  };
  return { calls, api: new IgApi({ token: 'SECRET-TOKEN', get, post }) };
}

function setup(g = graph(), over: Partial<ConstructorParameters<typeof InstagramPoster>[0]> = {}) {
  const db = openDb(':memory:');
  const store = new PublishStore(db);
  const slept: number[] = [];
  const poster = new InstagramPoster({
    api: g.api, userId: 'U1', store, day: () => '2026-11-23', publicBase: BASE, mediaSecret: 'sec', rendersDir: '/data/renders',
    sleep: (ms) => { slept.push(ms); return Promise.resolve(); }, ...over,
  });
  return { db, store, poster, g, slept };
}
const posts = (g: ReturnType<typeof graph>): Record<string, unknown>[] => g.calls.filter((c) => c.method === 'POST').map((c) => ({ path: new URL(c.url).pathname.replace(/^\/v[\d.]+\//, ''), ...c.body }));

describe('signed media URLs', () => {
  it('the signature is a 32-char hex HMAC of the path; the builder and the verifier agree', () => {
    const sig = signMedia('sec', '7/reel.mp4');
    expect(sig).toMatch(/^[0-9a-f]{32}$/);
    expect(mediaUrl(`${BASE}/`, 'sec', '7/slide 1.png')).toBe(`${BASE}/${signMedia('sec', '7/slide 1.png')}/7/slide%201.png`);
    expect(verifyMedia('sec', sig, '7/reel.mp4')).toBe(true);
  });

  it('a tampered signature, path or secret is refused; only renders are served', () => {
    const root = mkdtempSync(join(tmpdir(), 'media-'));
    mkdirSync(join(root, '7'));
    writeFileSync(join(root, '7', 'reel.mp4'), 'video');
    writeFileSync(join(root, '7', 'notes.txt'), 'x');
    writeFileSync(join(root, '..secret.png'), 'x');
    const out = mkdtempSync(join(tmpdir(), 'outside-'));
    writeFileSync(join(out, 'leak.png'), 'x');
    symlinkSync(out, join(root, 'link'));
    const ok = resolveMedia(root, 'sec', signMedia('sec', '7/reel.mp4'), '7/reel.mp4');
    expect(ok).toMatchObject({ type: 'video/mp4', size: 5 });
    expect(resolveMedia(root, 'sec', `${signMedia('sec', '7/reel.mp4').slice(0, 31)}${signMedia('sec', '7/reel.mp4').endsWith('0') ? '1' : '0'}`, '7/reel.mp4')).toBeNull();
    expect(resolveMedia(root, 'other', signMedia('sec', '7/reel.mp4'), '7/reel.mp4')).toBeNull();
    expect(resolveMedia(root, 'sec', signMedia('sec', '7/reel.mp4'), '7/other.mp4')).toBeNull();
    expect(resolveMedia(root, 'sec', signMedia('sec', '7/notes.txt'), '7/notes.txt')).toBeNull(); // not an allowed extension
    expect(resolveMedia(root, 'sec', signMedia('sec', '../x.png'), '../x.png')).toBeNull(); // signed but outside
    expect(resolveMedia(root, 'sec', signMedia('sec', 'link/leak.png'), 'link/leak.png')).toBeNull(); // symlink out of the folder
  });
});

describe('InstagramPoster', () => {
  it('Reel: container with REELS and a signed video_url, FINISHED after polling, publish, permalink; the token stays in the header', async () => {
    let n = 0;
    const g = graph((_c, path, q) => {
      if (q.get('fields') === 'status_code') return { body: { status_code: ++n < 3 ? 'IN_PROGRESS' : 'FINISHED' } };
      return undefined;
    });
    const { poster, store, slept } = setup(g, { rendersDir: '/data/renders' });
    store.markAttempt(3, 7, 'instagram', '2026-11-23');
    const r = await poster.post(pack());
    expect(r.url).toBe('https://www.instagram.com/reel/ABC123/');
    const p = posts(g);
    expect(p[0]).toMatchObject({ path: 'U1/media', media_type: 'REELS', share_to_feed: true, caption: 'Подпись\n\n#fir', video_url: `${BASE}/${signMedia('sec', '7/reel.mp4')}/7/reel.mp4` });
    expect(p[1]).toMatchObject({ path: 'U1/media_publish', creation_id: p[0] && 'C1' });
    expect(slept).toEqual([10_000, 10_000]);
    expect(store.container(3)).toBeNull();
    expect(store.instagramPublished(0, Infinity).length).toBe(0); // not marked published here: the worker does that
    expect(g.calls.every((c) => c.headers.authorization === 'Bearer SECRET-TOKEN' && !c.url.includes('SECRET-TOKEN'))).toBe(true);
  });

  it('a Reel still processing after 5 minutes keeps its container id and finishes on the next run', async () => {
    let done = false;
    const g = graph((_c, _p, q) => (q.get('fields') === 'status_code' ? { body: { status_code: done ? 'FINISHED' : 'IN_PROGRESS' } } : undefined));
    const { poster, store, slept } = setup(g);
    store.markAttempt(3, 7, 'instagram', '2026-11-23');
    await expect(poster.post(pack())).rejects.toBeInstanceOf(PostPending);
    expect(store.container(3)).toBe('C1');
    expect(slept.length).toBe(30); // 31 checks, 10 s apart, 5 min
    const before = posts(g).length;
    done = true;
    const r = await poster.post(pack());
    expect(r.url).toContain('instagram.com/reel/');
    expect(posts(g).slice(before).map((x) => x.path)).toEqual(['U1/media_publish']); // no second container
    expect(posts(g).filter((x) => x.path === 'U1/media').length).toBe(1);
    expect(store.container(3)).toBeNull();
  });

  it('a processing ERROR drops the container so the next day starts clean', async () => {
    const g = graph((_c, _p, q) => (q.get('fields') === 'status_code' ? { body: { status_code: 'ERROR' } } : undefined));
    const { poster, store } = setup(g);
    store.markAttempt(3, 7, 'instagram', '2026-11-23');
    await expect(poster.post(pack())).rejects.toThrow(/ERROR/);
    expect(store.container(3)).toBeNull();
  });

  it('carousel: a child container per picture (is_carousel_item), then CAROUSEL with children, then publish', async () => {
    const g = graph();
    const { poster } = setup(g);
    await poster.post(pack({ type: 'carousel', files: ['/data/renders/7/1.png', '/data/renders/7/2.png', '/data/renders/7/3.png'] }));
    const p = posts(g);
    expect(p.slice(0, 3).map((x) => [x.is_carousel_item, x.media_type, typeof x.image_url])).toEqual([[true, undefined, 'string'], [true, undefined, 'string'], [true, undefined, 'string']]);
    expect(p[3]).toMatchObject({ media_type: 'CAROUSEL', children: 'C1,C2,C3' });
    expect(p[4]?.path).toBe('U1/media_publish');
    expect(p[4]).toMatchObject({ creation_id: 'C4' });
  });

  it('post: image_url without media_type; story: STORIES per frame', async () => {
    const g = graph();
    const { poster } = setup(g);
    await poster.post(pack({ type: 'post', files: ['/data/renders/7/post.png'] }));
    expect(posts(g)[0]).toMatchObject({ image_url: `${BASE}/${signMedia('sec', '7/post.png')}/7/post.png`, caption: 'Подпись\n\n#fir' });
    expect(posts(g)[0]).not.toHaveProperty('media_type');
    const g2 = graph();
    await setup(g2).poster.post(pack({ type: 'story', files: ['/data/renders/7/s1.png', '/data/renders/7/s2.png'] }));
    expect(posts(g2).filter((x) => x.media_type === 'STORIES').length).toBe(2);
    expect(posts(g2).filter((x) => x.path === 'U1/media_publish').length).toBe(2);
  });

  it('refuses at 45 posts in 24 h (no container is created) and flags it as a quota stop', async () => {
    const g = graph((_c, path) => (path.endsWith('content_publishing_limit') ? { body: { data: [{ quota_usage: 45 }] } } : undefined));
    const { poster } = setup(g);
    const err = (await poster.post(pack()).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain('лимит Instagram: 45 из 50');
    expect(posts(g)).toEqual([]);
  });

  it('without IG_PUBLIC_BASE the reason is «нет публичного URL файлов» and nothing is called', async () => {
    const g = graph();
    const { poster } = setup(g, { publicBase: undefined });
    await expect(poster.post(pack())).rejects.toThrow('нет публичного URL файлов');
    expect(g.calls).toEqual([]);
  });

  it('a Graph error carries its code and message, never the token', async () => {
    const g = graph((c) => (c.method === 'POST' ? { status: 400, body: { error: { message: 'Invalid video', code: 2207026 } } } : undefined));
    const err = (await setup(g).poster.post(pack()).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain('code 2207026');
    expect(err.message).not.toContain('SECRET-TOKEN');
  });

  it('through the worker: one attempt a day, the error is stored, a pending Reel resumes the same day and gets published', async () => {
    const db = openDb(':memory:');
    const ctx: WorkerCtx = { llm: new MockLlm(() => ''), db, tz: 'Asia/Tashkent', now: () => NOW, requestApproval: () => Promise.resolve(0), log: () => undefined };
    const content = storeFor(ctx);
    const clip: Clip = {
      title: 'T', hook: 'Хук', durationSec: 28, scenes: [1, 2, 3, 4].map((i) => ({ voice: `Голос ${i}`, subtitle: `Субтитр ${i}` })), cta: 'firtech.pro',
      captions: { instagram: { text: 'ig', hashtags: ['#fir'] }, tiktok: { text: 'tt', hashtags: ['#fir'] }, shorts: { title: 'S', text: 'st', hashtags: ['#s'] } },
    };
    const id = content.insertItem({ packId: null, seq: 1, total: 1, type: 'clip', topicKey: 'free:t', topicText: 't', plannedDate: '2026-11-23' });
    const text = renderClip(clip);
    content.setProposed(id, text, 'T');
    onApproved(content, { itemId: id, text }, false);
    let finished = false;
    const g = graph((_c, _p, q) => (q.get('fields') === 'status_code' ? { body: { status_code: finished ? 'FINISHED' : 'IN_PROGRESS' } } : undefined));
    const store = new PublishStore(db);
    const poster = new InstagramPoster({ api: g.api, userId: 'U1', store, day: () => '2026-11-23', publicBase: BASE, mediaSecret: 'sec', rendersDir: '/data/renders', sleep: () => Promise.resolve(), maxWaitMs: 20_000 });
    const worker = new PublisherWorker({ render: (itemId, platform) => (platform === 'instagram' ? `/data/renders/${itemId}/reel.mp4` : null), posters: [poster], fileExists: () => true });
    const first = await worker.autoPublish(ctx);
    expect(first.find((r) => r.platform === 'instagram')).toMatchObject({ pending: true });
    expect(store.auto(first[0]!.readyId).error).toBeNull();
    finished = true;
    const second = await worker.autoPublish(ctx);
    const ig = second.find((r) => r.platform === 'instagram')!;
    expect(ig.url).toBe('https://www.instagram.com/reel/ABC123/');
    expect(store.get(ig.readyId)?.publishedAt).toBe(NOW);
    expect(store.instagramPublished(0, NOW + 1)[0]?.mediaId).toBe('M1');
    expect(await worker.autoPublish(ctx)).toEqual([]); // published: nothing more
  });
});

describe('InstagramDaily', () => {
  function daily(g: ReturnType<typeof graph>, over: Partial<ConstructorParameters<typeof InstagramDaily>[0]> = {}) {
    const db = openDb(':memory:');
    const store = new PublishStore(db);
    const clock = { day: '2026-11-23', now: NOW };
    const d = new InstagramDaily({ api: g.api, store, day: () => clock.day, now: () => clock.now, ...over });
    return { db, store, d, clock };
  }
  const published = (store: PublishStore, readyId: number, mediaId: string, at: number) => {
    store.markAttempt(readyId, readyId, 'instagram', '2026-11-20');
    store.markPublished(readyId, readyId, 'instagram', at);
    store.setMedia(readyId, mediaId);
    store.setUrl(readyId, `https://www.instagram.com/reel/${mediaId}/`);
  };

  it('an expired token (the call fails with 400) alerts the owner once a day, again the next day', async () => {
    const g = graph((_c, path) => (path === 'me' ? { status: 400 } : undefined));
    const { d, clock } = daily(g);
    expect((await d.run()).alerts).toEqual([TOKEN_EXPIRED_TEXT]);
    expect((await d.run()).alerts).toEqual([]);
    clock.day = '2026-11-24';
    expect((await d.run()).alerts).toEqual([TOKEN_EXPIRED_TEXT]);
  });

  it('a network failure is not an expired token; a healthy token gives no alert', async () => {
    const down = new IgApi({ token: 't', get: () => Promise.resolve({ ok: false, status: 0, error: 'network' }) });
    expect((await daily({ api: down, calls: [] } as unknown as ReturnType<typeof graph>).d.run()).alerts).toEqual([]);
    expect((await daily(graph()).d.run()).alerts).toEqual([]);
  });

  it('warns 7 days before expiry from IG_TOKEN_ISSUED_AT, once a day', async () => {
    expect(tokenDaysLeft('2026-09-25', NOW)).toBe(Math.ceil((Date.parse('2026-09-25') + 60 * DAY - NOW) / DAY));
    const { d } = daily(graph(), { tokenIssuedAt: '2026-09-25' }); // issued 59 days ago
    const left = tokenDaysLeft('2026-09-25', NOW)!;
    const r = await d.run();
    expect(left).toBeLessThanOrEqual(7);
    expect(r.alerts[0]).toContain(`через ${left} дн.`);
    expect((await d.run()).alerts).toEqual([]);
    expect((await daily(graph(), { tokenIssuedAt: '2026-11-01' }).d.run()).alerts).toEqual([]); // 38 days left
  });

  it('comments digest: new ones are stored once (dedupe by id), the header has the count and the first three', async () => {
    const comments = [
      { id: 'c1', text: 'Классно!', username: 'anna', timestamp: '2026-11-22T10:00:00+0000' },
      { id: 'c2', text: 'Сколько стоит?', username: 'bek', timestamp: '2026-11-22T11:00:00+0000' },
      { id: 'c3', text: 'Три', username: 'cat', timestamp: '2026-11-22T12:00:00+0000' },
      { id: 'c4', text: 'Четыре', username: 'dan', timestamp: '2026-11-22T13:00:00+0000' },
    ];
    const g = graph((_c, path) => (path === 'M1/comments' ? { body: { data: comments } } : undefined));
    const { d, store, db } = daily(g);
    published(store, 1, 'M1', NOW - DAY);
    published(store, 2, 'OLD', NOW - 9 * DAY); // older than a week: not read
    const r = await d.run();
    expect(r.newComments).toBe(4);
    expect(r.commentsLine).toBe('Комментарии в Instagram: 4 новых\n@anna: Классно!\n@bek: Сколько стоит?\n@cat: Три');
    expect(g.calls.some((c) => c.url.includes('/OLD/'))).toBe(false);
    expect((await d.run()).commentsLine).toBe('');
    expect(db.prepare('SELECT COUNT(*) n, SUM(replied) r FROM pb_comments').get()).toEqual({ n: 4, r: 0 });
  });
});

describe('instagramWeekLine', () => {
  it('sums the week, reads followers with the delta and names the best reel', async () => {
    const g = graph((_c, path) => {
      if (path === 'U1/insights') return { body: { data: [{ name: 'reach', total_value: { value: 1200 } }, { name: 'profile_views', total_value: { value: 80 } }] } };
      if (path === 'U1') return { body: { followers_count: 130, media_count: 20 } };
      if (path === 'M1/insights') return { body: { data: [{ name: 'views', values: [{ value: 500 }] }] } };
      if (path === 'M2/insights') return { body: { data: [{ name: 'views', values: [{ value: 900 }] }] } };
      return undefined;
    });
    const db = openDb(':memory:');
    const store = new PublishStore(db);
    store.saveIgStats('2026-11-16', 120, 15);
    for (const [i, id] of ['M1', 'M2'].entries()) {
      store.markAttempt(i + 1, i + 1, 'instagram', '2026-11-20');
      store.markPublished(i + 1, i + 1, 'instagram', NOW - 3 * DAY);
      store.setMedia(i + 1, id);
      store.setUrl(i + 1, `https://www.instagram.com/reel/${id}/`);
    }
    const line = await instagramWeekLine({ api: g.api, userId: 'U1', store }, { fromMs: NOW - 7 * DAY, toMs: NOW, day: '2026-11-23' });
    expect(line).toBe('Instagram за неделю: 2 публикаций, охват 1200, подписчиков 130 (+10), лучший ролик: https://www.instagram.com/reel/M2/ (900 просмотров)');
    const ins = g.calls.find((c) => c.url.includes('/U1/insights'))!;
    expect(ins.url).toContain('metric=reach%2Cprofile_views%2Caccounts_engaged');
    expect(ins.url).toContain('metric_type=total_value');
    expect(store.followersUpTo('2026-11-23')).toBe(130);
  });
});
