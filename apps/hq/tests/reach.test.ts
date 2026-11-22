/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { MockLlm, REACH_DAILY_CAP, REACH_QUEUE_EXPIRE_MS, REACH_RUN_EXPIRE_MS, REACH_TTL_MS, ReachStore, reachChannels, type LlmClient } from '@fir/core';
import { describe, expect, it } from 'vitest';
import { createReach } from '../src/reach.js';
import { carouselJson, clipJson } from './helpers.js';
import { YT_READ, YT_SUBTITLE, macAnswers } from './reach-helpers.js';
import { serve } from './shell-helpers.js';
import { reviewWorld } from './review-helpers.js';

const IG_USER = 'https://www.instagram.com/anna.salon/reel/ABC123/';
const YT = 'https://www.youtube.com/shorts/xyz789';
const ANALYSIS = {
  format: 'рилс 24 с, говорящая голова', hook: 'Клиент пишет в два часа ночи, а салон закрыт', structure: ['Боль в первой фразе', 'Бот отвечает и записывает', 'Призыв: слово БОТ'],
  whyItWorks: 'Узнаваемая ситуация в первые секунды', numbers: null, analogue: { type: 'clip', topic: 'Бот отвечает клиенту салона ночью', angle: 'Та же боль, показать запись через бота' },
};
const llm = (): MockLlm & LlmClient =>
  new MockLlm((req) => {
    if (req.system.includes('Владелец прислал ссылку')) return JSON.stringify(ANALYSIS);
    if (req.system.includes('Проверь материал по чек-листу')) return '{"ok":true,"issues":[]}';
    if (req.messages[0]!.content.startsWith('Составь карусель')) return carouselJson();
    return clipJson();
  });
const fetchOk = (url: string): Promise<Response> =>
  Promise.resolve(url.startsWith('https://www.youtube.com/oembed') ? Response.json({ title: 'Бот для салона за минуту', author_name: 'Мастер Айдар' }) : new Response('<html><head><meta property="og:title" content="Анна: бот записывает клиентов"><meta property="og:description" content="Как бот ведёт запись ночью"></head></html>', { headers: { 'content-type': 'text/html' } }));

const world = () => reviewWorld({ llm: llm(), integrations: { fetch: fetchOk } });
const store = (p: ReturnType<typeof world>) => new ReachStore(p.w.db, p.w.hq.now);
const CLI_OK = { ok: true, items: [{ title: 'x', url: 'https://example.com/', text: 'body' }], meta: {} };

describe('the Mac queue routes', () => {
  it('POST /admin/reach validates, dedupes, answers from the cache and stops at the daily cap', async () => {
    const p = world();
    for (const bad of [{}, { channel: 'youtube' }, { channel: 'nope', action: 'x', args: {} }, { channel: 'youtube', action: 'subtitle', args: {} }, { channel: 'youtube', action: 'subtitle', args: { target: '--help' } }, { channel: 'web', action: 'read', args: { target: 'https://a.b/', x: 1 } }, { channel: 'web', action: 'read', args: { target: 'https://a.b/' }, extra: 1 }]) {
      expect((await p.call('POST', '/admin/reach', bad)).status, JSON.stringify(bad)).toBe(400);
    }
    const a = await p.call('POST', '/admin/reach', { channel: 'web', action: 'read', args: { target: 'https://example.com/' } });
    expect(a.json).toMatchObject({ ok: true, cached: false, item: { id: 1, status: 'queued', channel: 'web', action: 'read', args: { target: 'https://example.com/' }, taskId: null } });
    expect((await p.call('POST', '/admin/reach', { channel: 'web', action: 'read', args: { target: 'https://example.com/' } })).json).toMatchObject({ cached: true, item: { id: 1 } });
    expect((await p.call('GET', '/admin/reach/1')).json.item).toMatchObject({ id: 1, status: 'queued', result: null });
    expect((await p.call('GET', '/admin/reach/9')).status).toBe(404);
    expect((await p.call('GET', '/admin/reach/x')).status).toBe(404);
    const s = store(p);
    for (let i = 0; i < REACH_DAILY_CAP; i++) s.create('web', 'search', { query: `q${i}` }, null, null);
    expect((await p.call('POST', '/admin/reach', { channel: 'web', action: 'search', args: { query: 'over' } })).status).toBe(429);
  });

  it('GET /admin/reach/jobs: filter, limit, counts; the Mac reports its channels there and in the claim', async () => {
    const p = world();
    const s = store(p);
    for (const t of ['a', 'b', 'c']) s.create('web', 'read', { target: t }, null, null);
    s.claim(3);
    let r = (await p.call('GET', '/admin/reach/jobs?status=queued&limit=1')).json;
    expect(r.items.map((x: any) => x.id)).toEqual([1]);
    expect(r.counts).toMatchObject({ queued: 2, running: 1 });
    expect((await p.call('GET', '/admin/reach/jobs?status=bogus')).status).toBe(400);
    expect((await p.call('GET', '/admin/reach/jobs?limit=x')).status).toBe(400);
    expect((await p.call('GET', '/admin/reach/jobs?channels=nope')).status).toBe(400);
    r = (await p.call('GET', '/admin/reach/jobs?status=queued&channels=youtube,web,instagram')).json;
    expect(r.channels).toEqual(['instagram', 'web', 'youtube']);
    expect(reachChannels(p.w.db)).toEqual(['instagram', 'web', 'youtube']);
    expect((await p.call('POST', '/admin/reach/jobs/1/claim', { channels: ['youtube'] })).status).toBe(200);
    expect(reachChannels(p.w.db)).toEqual(['youtube']);
  });

  it('claim: one winner, the loser gets 409; unknown job 404; bad body 400', async () => {
    const p = world();
    store(p).create('web', 'read', { target: 'a' }, null, null);
    const [x, y] = await Promise.all([p.call('POST', '/admin/reach/jobs/1/claim', {}), p.call('POST', '/admin/reach/jobs/1/claim', {})]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect([x, y].find((r) => r.status === 409)!.json).toMatchObject({ error: 'already_claimed', status: 'running' });
    expect((await p.call('POST', '/admin/reach/jobs/77/claim', {})).status).toBe(404);
    expect((await p.call('POST', '/admin/reach/jobs/1/claim', { channels: ['nope'] })).status).toBe(400);
    expect((await p.call('POST', '/admin/reach/jobs/1/claim', { x: 1 })).status).toBe(400);
  });

  it('result: needs a claim, is idempotent, a failed answer keeps the reason, a CLI ok:false is a failed job', async () => {
    const p = world();
    const s = store(p);
    s.create('web', 'read', { target: 'a' }, null, null);
    s.create('web', 'read', { target: 'b' }, null, null);
    s.create('web', 'read', { target: 'c' }, null, null);
    expect((await p.call('POST', '/admin/reach/jobs/1/result', { ok: true, result: CLI_OK })).json).toMatchObject({ error: 'not_claimed' });
    for (const id of [1, 2, 3]) await p.call('POST', `/admin/reach/jobs/${id}/claim`, {});
    expect((await p.call('POST', '/admin/reach/jobs/1/result', { ok: true, result: CLI_OK })).json).toMatchObject({ ok: true, already: false, item: { status: 'done' } });
    const again = await p.call('POST', '/admin/reach/jobs/1/result', { ok: false, error: 'late' });
    expect(again.json).toMatchObject({ ok: true, already: true, item: { status: 'done', error: null } });
    expect((await p.call('GET', '/admin/reach/1')).json.item.result).toMatchObject({ ok: true, items: [{ text: 'body' }] });
    expect((await p.call('POST', '/admin/reach/jobs/2/result', { ok: false, error: 'timeout after 120 s' })).json).toMatchObject({ item: { status: 'failed', error: 'timeout after 120 s' } });
    const cli = await p.call('POST', '/admin/reach/jobs/3/result', { ok: true, result: { ok: false, items: [], meta: {}, error: { code: 'NEED_LOGIN', message: 'log in', hint: 'agent-reach login' } } });
    expect(cli.json).toMatchObject({ item: { status: 'failed', error: 'NEED_LOGIN: log in' } });
    for (const bad of [{}, { ok: true }, { ok: false }, { ok: true, result: { ok: 'yes' } }, { ok: true, result: CLI_OK, extra: 1 }]) expect((await p.call('POST', '/admin/reach/jobs/1/result', bad)).status, JSON.stringify(bad)).toBe(400);
    expect((await p.call('POST', '/admin/reach/jobs/99/result', { ok: true, result: CLI_OK })).status).toBe(404);
  });

  it('the token is required, and the result route takes a body up to ~400 KB (others 16 KB)', async () => {
    const p = world();
    const srv = await serve(p);
    expect((await srv.http('GET', '/admin/reach/jobs', undefined, {})).status).toBe(401);
    expect((await srv.http('POST', '/admin/reach', { channel: 'web', action: 'read', args: { target: 'https://a.b/' } }, {})).status).toBe(401);
    // over 16 KB on an ordinary route: the server answers 413 and drops the connection
    const tooBig = await srv.http('POST', '/admin/reach', { channel: 'web', action: 'search', args: { query: 'x'.repeat(30_000) } }).then((r) => r.status, () => 413);
    expect(tooBig).toBe(413);
    await srv.http('POST', '/admin/reach', { channel: 'web', action: 'read', args: { target: 'https://a.b/' } });
    expect((await srv.http('POST', '/admin/reach/jobs/1/claim', {})).status).toBe(200);
    const big = { ok: true, result: { ok: true, items: [{ title: 't', text: 'z'.repeat(300_000) }], meta: {} } };
    const r = await srv.http('POST', '/admin/reach/jobs/1/result', big);
    expect(r.status).toBe(200);
    const stored = (await (await srv.http('GET', '/admin/reach/1')).json()) as any;
    expect(JSON.stringify(stored.item.result).length).toBeLessThanOrEqual(200_000);
    expect(stored.item.result.meta.truncated).toBe(true);
    await srv.close();
  });

  it('expiry: queued 6 h and running 30 min fail; the nightly purge drops jobs older than 7 days', async () => {
    const p = world();
    const s = store(p);
    s.create('web', 'read', { target: 'q' }, null, null);
    s.create('web', 'read', { target: 'r' }, null, null);
    s.claim(2);
    const reach = createReach({ hq: p.w.hq, now: p.w.hq.now });
    p.w.clock.t += REACH_RUN_EXPIRE_MS + 1;
    expect(reach.sweep()).toBe(1);
    p.w.clock.t += REACH_QUEUE_EXPIRE_MS;
    expect(reach.sweep()).toBe(1);
    expect(s.get(1)).toMatchObject({ status: 'failed' });
    expect(reach.purge()).toBe(0);
    p.w.clock.t += REACH_TTL_MS;
    expect(reach.purge()).toBe(2);
    expect((await p.call('GET', '/admin/reach/jobs')).json.items).toEqual([]);
  });
});

describe('the Trendwatcher and the owner\'s Mac', () => {
  const post = (p: ReturnType<typeof world>, url: string) => p.call('POST', '/admin/trends', { url });
  const links = async (p: ReturnType<typeof world>) => (await p.call('GET', '/admin/trends')).json.items as any[];

  it('a YouTube link parks its task on the Mac jobs; the transcript arrives, HQ resumes the task, the analysis uses the words, the pace and the numbers', async () => {
    const p = world();
    const r = await post(p, YT);
    const taskId = r.json.item.taskId as number;
    await p.w.marketing.onHeartbeat();
    // parked: blocked with the tag, no alert, the link waits, two jobs (subtitle + info) are queued
    const t = p.w.hq.task(taskId)!;
    expect(t).toMatchObject({ status: 'blocked' });
    expect(t.tags).toContain('reach-wait');
    expect(p.w.hq.events(taskId).some((e) => e.body.includes('ждёт Мак'))).toBe(true);
    expect(store(p).list('queued').map((j) => `${j.channel}.${j.action}`).sort()).toEqual(['youtube.read', 'youtube.subtitle']);
    expect(store(p).list('queued').find((j) => j.action === 'subtitle')!.args).toEqual({ target: YT, lang: 'ru,en,en-orig,uz,tg,uk' });
    const [chip] = await links(p);
    expect(chip).toMatchObject({ status: 'analysing', chip: 'ждёт Мак', reach: { status: 'queued', channel: 'youtube' } });
    expect((p.w.llm as MockLlm).calls.find((c) => c.system.includes('Владелец прислал ссылку'))).toBeUndefined();
    // the Mac works: the chip changes while a job runs
    await p.call('POST', '/admin/reach/jobs/1/claim', { channels: ['youtube'] });
    expect((await links(p))[0]).toMatchObject({ chip: 'Мак читает' });
    await p.call('POST', '/admin/reach/jobs/1/result', { ok: true, result: YT_SUBTITLE });
    expect(p.w.hq.task(taskId)!.status).toBe('blocked'); // the second job is still open: the task has one job id, so it was resumed by the first answer
    // the answers are in: the task is back in the inbox (resumed by the job it waited on)
    await macAnswers(p, (j) => (j.action === 'read' ? YT_READ : YT_SUBTITLE));
    expect(p.w.hq.task(taskId)!.status).toBe('inbox');
    await p.w.marketing.onHeartbeat();
    const prompt = (p.w.llm as MockLlm).calls.find((c) => c.system.includes('Владелец прислал ссылку'))!.messages[0]!.content;
    expect(prompt).toContain('Транскрипт (');
    expect(prompt).toContain('Клиент пишет вам в два часа ночи.');
    expect(prompt).toMatch(/Темп: \d+(\.\d+)? слов в секунду/);
    expect(prompt).toContain('ролик 24 с');
    expect(prompt).toContain('Просмотры: 120000, лайки: 8500');
    const [link] = await links(p);
    expect(link).toMatchObject({ status: 'proposed', chip: null, reach: null, analysis: { hook: ANALYSIS.hook } });
    expect(store(p).counts()).toMatchObject({ queued: 0, running: 0 });
  });

  it('the same link a day later is served from the cache: no new jobs, no waiting', async () => {
    const p = world();
    await post(p, YT);
    await p.w.marketing.onHeartbeat();
    await macAnswers(p, (j) => (j.action === 'read' ? YT_READ : YT_SUBTITLE));
    await p.w.marketing.onHeartbeat();
    p.w.clock.t += 2 * 3_600_000;
    const before = store(p).counts();
    const second = await p.call('POST', '/admin/trends', { url: YT, note: 'ещё раз' }); // within a day: the same row
    expect(second.json.already).toBe(true);
    expect(store(p).counts()).toEqual(before);
  });

  it('the Mac never answers: after 6 hours the jobs fail, the task is resumed and the page path finishes the analysis', async () => {
    const p = world();
    const r = await post(p, YT);
    const taskId = r.json.item.taskId as number;
    await p.w.marketing.onHeartbeat();
    expect(p.w.hq.task(taskId)!.status).toBe('blocked');
    p.w.clock.t += REACH_QUEUE_EXPIRE_MS + 1;
    expect(createReach({ hq: p.w.hq, now: p.w.hq.now }).sweep()).toBe(2);
    expect(p.w.hq.task(taskId)!.status).toBe('inbox');
    await p.w.marketing.onHeartbeat();
    const prompt = (p.w.llm as MockLlm).calls.find((c) => c.system.includes('Владелец прислал ссылку'))!.messages[0]!.content;
    expect(prompt).not.toContain('Транскрипт');
    expect(prompt).toContain('Название: Бот для салона за минуту');
    expect((await links(p))[0]).toMatchObject({ status: 'proposed' });
  });

  it('an answer that arrives before the task is parked releases it at once', async () => {
    const p = world();
    const task = p.w.hq.createTask({ title: 't', dept: 'marketing', creator: 'owner', meta: {} });
    p.w.hq.claim(task.id, 'x');
    const job = store(p).create('web', 'read', { target: 'a' }, task.id, 'x');
    store(p).claim(job.id);
    store(p).finish(job.id, { ok: true, result: CLI_OK });
    createReach({ hq: p.w.hq, now: p.w.hq.now }).park(task.id, 'x', job.id);
    expect(p.w.hq.task(task.id)!.status).toBe('inbox');
  });

  it('Instagram: the og path as before; the author\'s profile and posts are queued only when the Mac reported Instagram as set up', async () => {
    const p = world();
    await post(p, IG_USER);
    await p.w.marketing.onHeartbeat();
    expect(store(p).counts()).toEqual({ queued: 0, running: 0, done: 0, failed: 0 });
    expect((await links(p))[0]).toMatchObject({ status: 'proposed' });
    // the Mac reports the channel; the next link of the account queues the profile and the posts, and nobody waits for them
    await p.call('GET', '/admin/reach/jobs?channels=youtube,instagram');
    await post(p, 'https://www.instagram.com/anna.salon/reel/DEF456/');
    await p.w.marketing.onHeartbeat();
    expect(store(p).list('queued').map((j) => `${j.channel}.${j.action}:${JSON.stringify(j.args)}`).sort()).toEqual(['instagram.posts:{"username":"anna.salon","limit":5}', 'instagram.profile:{"username":"anna.salon"}']);
    expect((await links(p))[0]).toMatchObject({ status: 'proposed', chip: null });
  });
});
