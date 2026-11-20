import { MockLlm, openDb, type PostFn, type SafePostOptions, type SafePostResult } from '@fir/core';
import type { Task, WorkerCtx } from '@fir/hq';
import { onApproved, renderClip, storeFor, type Clip } from '@fir/worker-content-maker';
import { describe, expect, it } from 'vitest';
import { PublishStore, PublisherWorker, QUOTA_LIMIT, QuotaExceeded, UPLOAD_COST, YouTubePoster, buildVideoMeta, parsePrivacy, type PublishPack } from '../src/index.js';

const NOW = Date.UTC(2026, 10, 23, 4, 0); // Mon 2026-11-23 09:00 Tashkent
const clip = (title: string): Clip => ({
  title, hook: 'Хук', durationSec: 28,
  scenes: [1, 2, 3, 4].map((i) => ({ voice: `Голос ${i}`, subtitle: `Субтитр ${i}` })),
  cta: 'firtech.pro',
  captions: { instagram: { text: 'ig', hashtags: ['#fir', '#боты'] }, tiktok: { text: 'tt', hashtags: ['#fir', '#боты'] }, shorts: { title: 'Заголовок шортс', text: 'Текст шортс', hashtags: ['#shorts', '#боты'] } },
});
const pack = (over: Partial<PublishPack> = {}): PublishPack => ({
  readyId: 3, itemId: 7, platform: 'shorts', type: 'clip', plannedDate: '2026-11-23', title: 'Запись',
  caption: 'Заголовок шортс\nТекст шортс', hashtags: ['#shorts', '#боты'], files: ['/data/renders/7/reel.mp4'], ...over,
});

/** A scripted Google: init gives a session URL, PUT gives the video id. Records every call. */
function google(opts: { initStatus?: number; putStatus?: number } = {}) {
  const calls: { url: string; o: SafePostOptions }[] = [];
  const post: PostFn = (url, o) => {
    calls.push({ url, o });
    const res = (r: SafePostResult) => Promise.resolve(r);
    if (url.includes('uploadType=resumable')) return res(opts.initStatus && opts.initStatus !== 200 ? { ok: true, status: opts.initStatus, body: { error: { errors: [{ reason: 'quotaExceeded' }] } }, headers: {} } : { ok: true, status: 200, body: null, headers: { location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=S1' } });
    return res(opts.putStatus && opts.putStatus !== 200 ? { ok: true, status: opts.putStatus, body: { error: { status: 'INTERNAL' } }, headers: {} } : { ok: true, status: 200, body: { id: 'vid123' }, headers: {} });
  };
  return { calls, post };
}

function setup(g = google(), poster: Partial<ConstructorParameters<typeof YouTubePoster>[0]> = {}) {
  const db = openDb(':memory:');
  const ctx: WorkerCtx = { llm: new MockLlm(() => ''), db, tz: 'Asia/Tashkent', now: () => NOW, requestApproval: () => Promise.resolve(0), log: () => undefined };
  const content = storeFor(ctx);
  const store = new PublishStore(db);
  const approved = (title: string, date = '2026-11-23') => {
    const id = content.insertItem({ packId: null, seq: 1, total: 1, type: 'clip', topicKey: `free:${title}`, topicText: title, plannedDate: date });
    const text = renderClip(clip(title));
    content.setProposed(id, text, title);
    onApproved(content, { itemId: id, text }, false);
    return id;
  };
  const yt = new YouTubePoster({ auth: { accessToken: () => Promise.resolve('AT') }, store, day: () => '2026-11-23', now: () => NOW, post: g.post, readFile: () => new Uint8Array(10), ...poster });
  const files = new Set<string>();
  const worker = new PublisherWorker({ render: (itemId) => (files.has(String(itemId)) ? `/data/renders/${itemId}/reel.mp4` : null), posters: [yt], fileExists: () => true });
  return { db, ctx, content, store, approved, yt, worker, files, g };
}

describe('buildVideoMeta', () => {
  it('title ends with #Shorts and stays within 100 characters; description has caption, utm link and hashtags', () => {
    const m = buildVideoMeta(pack({ caption: `${'Очень длинный заголовок '.repeat(10)}\nТекст` }), { now: NOW });
    expect(m.snippet.title.length).toBeLessThanOrEqual(100);
    expect(m.snippet.title.endsWith(' #Shorts')).toBe(true);
    expect(m.snippet.description).toContain('Текст');
    expect(m.snippet.description).toContain('https://firtech.pro/?utm_source=youtube&utm_medium=shorts&utm_campaign=7');
    expect(m.snippet.description).toContain('#shorts #боты');
    expect(m.snippet.categoryId).toBe('28');
    expect(m.snippet.defaultLanguage).toBe('ru');
    expect(m.status).toEqual({ privacyStatus: 'public', selfDeclaredMadeForKids: false });
  });

  it('tags keep within 500 characters in total and always include Shorts', () => {
    const many = Array.from({ length: 200 }, (_, i) => `#тег${i}`);
    const m = buildVideoMeta(pack({ hashtags: many }), { now: NOW });
    expect(m.snippet.tags[0]).toBe('Shorts');
    expect(m.snippet.tags.join(',').length).toBeLessThanOrEqual(500);
  });

  it('a future publishAt forces private; a past one is ignored; privacy comes from the option', () => {
    const future = buildVideoMeta(pack(), { privacy: 'public', publishAt: NOW + 3_600_000, now: NOW });
    expect(future.status).toEqual({ privacyStatus: 'private', selfDeclaredMadeForKids: false, publishAt: new Date(NOW + 3_600_000).toISOString() });
    expect(buildVideoMeta(pack(), { privacy: 'unlisted', publishAt: NOW - 1, now: NOW }).status).toEqual({ privacyStatus: 'unlisted', selfDeclaredMadeForKids: false });
    expect(parsePrivacy('unlisted')).toBe('unlisted');
    expect(parsePrivacy('weird')).toBe('public');
    expect(parsePrivacy(undefined)).toBe('public');
  });
});

describe('YouTubePoster', () => {
  it('opens a resumable session, PUTs the video once, returns the Shorts URL and books 1600 units', async () => {
    const t = setup();
    expect(await t.yt.post(pack())).toEqual({ url: 'https://youtube.com/shorts/vid123' });
    expect(t.g.calls).toHaveLength(2);
    expect(t.g.calls[0]!.url).toBe('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status');
    expect(t.g.calls[0]!.o.headers).toMatchObject({ authorization: 'Bearer AT', 'x-upload-content-type': 'video/mp4', 'x-upload-content-length': '10' });
    expect(t.g.calls[1]!.o.method).toBe('PUT');
    expect(t.g.calls[1]!.o.timeoutMs).toBe(60_000);
    expect(t.store.quotaUsed('2026-11-23')).toBe(UPLOAD_COST);
  });

  it('refuses past 9000 units without any network call', async () => {
    const t = setup();
    t.store.addQuota('2026-11-23', QUOTA_LIMIT - UPLOAD_COST + 1);
    await expect(t.yt.post(pack())).rejects.toBeInstanceOf(QuotaExceeded);
    expect(t.g.calls).toHaveLength(0);
    t.store.addQuota('2026-11-24', 5 * UPLOAD_COST);
    expect(t.store.quotaUsed('2026-11-23')).toBe(QUOTA_LIMIT - UPLOAD_COST + 1); // per-day counters
  });

  it('a failed session or upload throws with the reason, never retries, and has no token in the text', async () => {
    const a = setup(google({ initStatus: 403 }));
    await expect(a.yt.post(pack())).rejects.toThrow(/сессия загрузки не открыта \(HTTP 403 quotaExceeded\)/);
    expect(a.g.calls).toHaveLength(1);
    const b = setup(google({ putStatus: 500 }));
    const msg = await b.yt.post(pack()).catch((e: Error) => e.message);
    expect(msg).toMatch(/загрузка не удалась \(HTTP 500 INTERNAL\)/);
    expect(msg).not.toContain('AT');
    expect(b.g.calls).toHaveLength(2);
  });

  it('a pack without a video file throws', async () => {
    await expect(setup().yt.post(pack({ files: [] }))).rejects.toThrow(/нет MP4/);
  });
});

describe('PublisherWorker.autoPublish', () => {
  it('posts an approved Shorts item with an MP4, marks pb_posts and the row published; other platforms untouched', async () => {
    const t = setup();
    const id = t.approved('Запись');
    t.files.add(String(id));
    const res = await t.worker.autoPublish(t.ctx);
    expect(res).toEqual([expect.objectContaining({ itemId: id, platform: 'shorts', url: 'https://youtube.com/shorts/vid123' })]);
    const row = t.content.readyRows().length;
    expect(row).toBe(2); // instagram and tiktok still ready
    const shorts = t.db.prepare("SELECT ready_id FROM pb_posts WHERE platform = 'shorts'").get() as { ready_id: number };
    expect(t.store.get(shorts.ready_id)?.publishedAt).toBe(NOW);
    expect(t.store.auto(shorts.ready_id)).toMatchObject({ url: 'https://youtube.com/shorts/vid123', error: null });
    expect(t.worker.packsToSend(t.ctx).flat().map((p) => p.platform)).toEqual(['instagram', 'tiktok']);
  });

  it('a failure keeps the row ready, stores the error, and does not try again the same day', async () => {
    const t = setup(google({ putStatus: 500 }));
    const id = t.approved('Запись');
    t.files.add(String(id));
    const [r] = await t.worker.autoPublish(t.ctx);
    expect(r).toMatchObject({ itemId: id, error: expect.stringContaining('загрузка не удалась') });
    const rid = r!.readyId;
    expect(t.store.get(rid)?.publishedAt).toBeNull();
    expect(t.store.auto(rid).error).toContain('HTTP 500');
    expect(t.worker.packsToSend(t.ctx).flat().map((p) => p.platform)).toContain('shorts'); // manual flow keeps it
    expect(await t.worker.autoPublish(t.ctx)).toEqual([]);
    expect(t.g.calls).toHaveLength(2);
  });

  it('no MP4 (or no poster) means the manual way: nothing is attempted', async () => {
    const t = setup();
    t.approved('Без видео');
    expect(await t.worker.autoPublish(t.ctx)).toEqual([]);
    expect(await new PublisherWorker().autoPublish(t.ctx)).toEqual([]);
    expect(t.g.calls).toHaveLength(0);
  });

  it('quota spent: the result says so and the item stays manual', async () => {
    const t = setup();
    t.store.addQuota('2026-11-23', QUOTA_LIMIT);
    const id = t.approved('Запись');
    t.files.add(String(id));
    expect(await t.worker.autoPublish(t.ctx)).toEqual([expect.objectContaining({ quota: true })]);
    expect(t.worker.packsToSend(t.ctx).flat().map((p) => p.platform)).toContain('shorts');
  });
});

describe('Task shape stays as before', () => {
  it('the manual run still works with a poster configured', async () => {
    const t = setup();
    t.approved('Запись');
    const task = { id: 1, title: 't', body: '', dept: 'marketing', assigneeId: null, creator: 'routine', parentId: null, status: 'running', priority: 0, dueAt: null, result: null, costUsd: 0, meta: { action: 'daily' }, tags: [], routineId: null, createdAt: 0, updatedAt: 0 } as Task;
    expect((await t.worker.run(task, t.ctx)).ok).toBe(true);
  });
});

describe('PublisherWorker.publishNow (the review center: «Выложить сейчас»)', () => {
  it('posts one platform of an approved item that is not due yet, marks it published like the morning run, books the quota', async () => {
    const t = setup();
    const id = t.approved('Запись', '2026-11-30'); // planned a week ahead: the morning run would not touch it
    t.files.add(String(id));
    expect(await t.worker.autoPublish(t.ctx)).toEqual([]);
    const r = await t.worker.publishNow(t.ctx, id, 'shorts');
    expect(r).toEqual({ result: expect.objectContaining({ itemId: id, platform: 'shorts', url: 'https://youtube.com/shorts/vid123' }) });
    expect(t.store.quotaUsed('2026-11-23')).toBe(UPLOAD_COST);
    const rid = (r as { result: { readyId: number } }).result.readyId;
    expect(t.store.get(rid)?.publishedAt).toBe(NOW);
    expect(t.content.readyRow(rid)?.status).toBe('published');
    expect(t.content.readyRows().map((x) => x.platform)).toEqual(['instagram', 'tiktok']);
  });

  it('a failure is reported with the reason and stays retryable at once (the once-a-day guard is for the morning run)', async () => {
    const t = setup(google({ putStatus: 500 }));
    const id = t.approved('Запись');
    t.files.add(String(id));
    const first = await t.worker.publishNow(t.ctx, id, 'shorts');
    expect(first).toEqual({ result: expect.objectContaining({ error: expect.stringContaining('загрузка не удалась') }) });
    const rid = (first as { result: { readyId: number } }).result.readyId;
    expect(t.store.get(rid)?.publishedAt).toBeNull();
    expect(t.store.auto(rid).error).toContain('HTTP 500');
    const second = await t.worker.publishNow(t.ctx, id, 'shorts');
    expect('result' in second && second.result.error).toContain('загрузка не удалась');
    expect(t.g.calls).toHaveLength(4); // two tries, two HTTP calls each
  });

  it('a spent quota is a reported failure with quota: true and no request', async () => {
    const t = setup();
    const id = t.approved('Запись');
    t.files.add(String(id));
    t.store.addQuota('2026-11-23', QUOTA_LIMIT - UPLOAD_COST + 1);
    const r = await t.worker.publishNow(t.ctx, id, 'shorts');
    expect(r).toEqual({ result: expect.objectContaining({ quota: true, error: expect.stringContaining('квота YouTube') }) });
    expect(t.g.calls).toHaveLength(0);
  });

  it('says why nothing was tried: no poster for the platform, no approved row, no video file, already published', async () => {
    const t = setup();
    const id = t.approved('Запись');
    expect(await t.worker.publishNow(t.ctx, id, 'instagram')).toEqual({ reason: 'no_poster' });
    expect(await t.worker.publishNow(t.ctx, 999, 'shorts')).toEqual({ reason: 'not_ready' });
    expect(await t.worker.publishNow(t.ctx, id, 'shorts')).toEqual({ reason: 'no_file' });
    t.files.add(String(id));
    await t.worker.publishNow(t.ctx, id, 'shorts');
    expect(await t.worker.publishNow(t.ctx, id, 'shorts')).toEqual({ reason: 'not_ready' }); // the row is published: it left the ready queue
    expect(t.g.calls).toHaveLength(2);
  });
});
