import { MockLlm, OffLlm, openDb, type LlmClient, type LlmRequest } from '@fir/core';
import type { Task, WorkerCtx } from '@fir/hq';
import { describe, expect, it } from 'vitest';
import { parseTrendsRss } from '../src/sources.js';
import { TrendScoutWorker, latestTrendHints, trendStoreFor } from '../src/worker.js';

// Thu 2026-11-19 08:30 Tashkent
const NOW = Date.UTC(2026, 10, 19, 3, 30);

const RSS = `<?xml version="1.0"?><rss xmlns:ht="https://trends.google.com/trending/rss"><channel>
<item><title>Курс доллара</title><ht:approx_traffic>200+</ht:approx_traffic><link>https://trends.google.com/x</link>
<ht:news_item><ht:news_item_title>Доллар &amp; тенге</ht:news_item_title><ht:news_item_url>https://news.example/usd</ht:news_item_url></ht:news_item></item>
<item><title>ChatGPT агент</title><ht:approx_traffic>1000+</ht:approx_traffic></item>
</channel></rss>`;

const ytVideos = (ids: string[]) => ({ items: ids.map((id) => ({ id, snippet: { title: `Видео ${id}` }, statistics: { viewCount: '1500000' } })) });

function fakeFetch(opts: { youtube?: 'ok' | 'fail'; trends?: 'ok' | 'fail' } = {}) {
  const calls: string[] = [];
  const fn = (url: string): Promise<Response> => {
    calls.push(url);
    if (url.startsWith('https://trends.google.com/trending/rss')) {
      return Promise.resolve(opts.trends === 'fail' ? new Response('no', { status: 503 }) : new Response(RSS));
    }
    if (url.includes('googleapis.com/youtube')) {
      if (opts.youtube === 'fail') return Promise.resolve(new Response('quota', { status: 403 }));
      if (url.includes('/search?')) return Promise.resolve(Response.json({ items: [{ id: { videoId: 'S1' } }] }));
      return Promise.resolve(Response.json(ytVideos(url.includes('chart=mostPopular') ? ['M1'] : ['S1'])));
    }
    return Promise.resolve(new Response('?', { status: 404 }));
  };
  return { fn, calls };
}

function setup(llm: LlmClient, scout: TrendScoutWorker) {
  const db = openDb(':memory:');
  const clock = { t: NOW };
  const ctx: WorkerCtx = { llm, db, tz: 'Asia/Tashkent', now: () => clock.t, requestApproval: () => Promise.resolve(0), log: () => undefined };
  const task = (meta: Record<string, unknown>): Task => ({
    id: 1, title: 't', body: '', dept: 'marketing', assigneeId: null, creator: 'routine', parentId: null, status: 'running', priority: 0,
    dueAt: null, result: null, costUsd: 0, meta, tags: [], routineId: null, createdAt: 0, updatedAt: 0,
  });
  return { scout, ctx, db, clock, task, scoutRun: (meta: Record<string, unknown>) => scout.run(task(meta), ctx) };
}

const pickLlm = (picks: unknown[]) => new MockLlm((r: LlmRequest) => (r.system.includes('трендвотчер') ? JSON.stringify({ items: picks }) : JSON.stringify({ lines: ['Растут ролики про агентов', 'Снимите про запись клиентов'] })));
const pick = (n: number, extra: Record<string, unknown> = {}) => ({ n, hook: `Хук номер ${n}`, format: 'клип 30 с с субтитрами', why: 'быстро растёт охват', direction: 'admin', ...extra });

describe('parseTrendsRss', () => {
  it('reads titles, traffic and the news link; decodes entities', () => {
    const items = parseTrendsRss(RSS, 'KZ');
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ source: 'google_trends', region: 'KZ', url: 'https://news.example/usd', metric: '200+ запросов в сутки' });
    expect(items[0]!.title).toBe('Курс доллара: Доллар & тенге');
    expect(items[1]!.url).toContain('trends.google.com/trends/explore?q=');
  });
});

describe('Trend scout: daily', () => {
  it('collects Google Trends and YouTube, asks the model for five items, stores them with the source link', async () => {
    const { fn, calls } = fakeFetch();
    const scout = new TrendScoutWorker({ youtubeApiKey: 'KEY123', regions: ['KZ', 'UZ'], fetch: fn });
    const t = setup(pickLlm([pick(1), pick(3, { direction: 'content' }), pick(2, { direction: null }), pick(99), pick(1)]), scout);
    const res = await t.scoutRun({ action: 'trends' });
    expect(res.ok).toBe(true);
    const items = trendStoreFor(t.ctx).latest('2026-11-19');
    expect(items.map((i) => i.rank)).toEqual([1, 2, 3]); // n=99 (unknown signal) and the duplicate n=1 are dropped
    expect(items[0]).toMatchObject({ hook: 'Хук номер 1', url: 'https://news.example/usd', source: 'google_trends', direction: 'admin' });
    expect(items[1]!.direction).toBe('content');
    expect(items[2]!.direction).toBeNull();
    expect(calls.filter((u) => u.includes('chart=mostPopular'))).toHaveLength(2); // KZ and UZ
    expect(calls.filter((u) => u.includes('/search?')).length).toBeGreaterThanOrEqual(5);
    expect(calls.find((u) => u.includes('/search?'))).toContain('order=viewCount');
    expect(res.result).toContain('Формат: клип 30 с');
    expect(res.result).toContain('TikTok не используется');
  });

  it('without a YouTube key only Google Trends is read; the note says so', async () => {
    const { fn, calls } = fakeFetch();
    const t = setup(pickLlm([pick(1)]), new TrendScoutWorker({ regions: ['KZ'], fetch: fn }));
    const res = await t.scoutRun({ action: 'trends' });
    expect(res.ok).toBe(true);
    expect(calls.some((u) => u.includes('googleapis.com'))).toBe(false);
    expect(res.result).toContain('YouTube выключен');
    expect(t.scout.sources).toEqual(['google_trends']);
  });

  it('a failing source is a note, not a crash, and the API key never appears in the text', async () => {
    const { fn } = fakeFetch({ youtube: 'fail' });
    const t = setup(pickLlm([pick(1)]), new TrendScoutWorker({ youtubeApiKey: 'SECRETKEY', regions: ['RU'], fetch: fn }));
    const res = await t.scoutRun({ action: 'trends' });
    expect(res.ok).toBe(true);
    expect(res.result).toContain('YouTube: HTTP 403');
    expect(JSON.stringify(res)).not.toContain('SECRETKEY');
  });

  it('no data at all, LLM off, empty regions and garbage answers fail cleanly', async () => {
    const down = fakeFetch({ trends: 'fail' }).fn;
    expect((await setup(pickLlm([pick(1)]), new TrendScoutWorker({ regions: ['KZ'], fetch: down })).scoutRun({ action: 'trends' })).error).toContain('Источники не дали данных');
    expect((await setup(new OffLlm(), new TrendScoutWorker({ regions: ['KZ'], fetch: fakeFetch().fn })).scoutRun({ action: 'trends' })).error).toContain('LLM off');
    expect((await setup(pickLlm([pick(1)]), new TrendScoutWorker({ regions: [], fetch: fakeFetch().fn })).scoutRun({ action: 'trends' })).ok).toBe(false);
    expect((await setup(new MockLlm(() => 'не json'), new TrendScoutWorker({ regions: ['KZ'], fetch: fakeFetch().fn })).scoutRun({ action: 'trends' })).error).toContain('не дала валидный');
    expect((await setup(pickLlm([pick(1)]), new TrendScoutWorker({ regions: ['KZ'], fetch: fakeFetch().fn })).scoutRun({ action: 'wat' })).ok).toBe(false);
  });

  it('a second run the same day reuses the stored items unless forced', async () => {
    const { fn, calls } = fakeFetch();
    const llm = pickLlm([pick(1)]);
    const t = setup(llm, new TrendScoutWorker({ regions: ['KZ'], fetch: fn }));
    await t.scoutRun({ action: 'trends' });
    const n = calls.length;
    const again = await t.scoutRun({ action: 'trends' });
    expect(again.result).toContain('уже собраны');
    expect(calls).toHaveLength(n);
    await t.scoutRun({ action: 'trends', force: true });
    expect(trendStoreFor(t.ctx).latest('2026-11-19')).toHaveLength(1); // replaced, not duplicated
  });
});

describe('Trend scout: weekly and the content-maker hook', () => {
  it('latestTrendHints returns the newest day (not older than a week) in the shape the content-maker takes', async () => {
    const t = setup(pickLlm([pick(1), pick(2, { direction: null })]), new TrendScoutWorker({ regions: ['KZ'], fetch: fakeFetch().fn }));
    await t.scoutRun({ action: 'trends' });
    expect(latestTrendHints(t.ctx)).toEqual([
      { hook: 'Хук номер 1', format: 'клип 30 с с субтитрами', why: 'быстро растёт охват', direction: 'admin' },
      { hook: 'Хук номер 2', format: 'клип 30 с с субтитрами', why: 'быстро растёт охват' },
    ]);
    t.clock.t = NOW + 9 * 86_400_000;
    expect(latestTrendHints(t.ctx)).toEqual([]);
  });

  it('the Sunday digest summarizes the stored week; an empty week says so; the model off falls back to the list', async () => {
    const t = setup(pickLlm([pick(1)]), new TrendScoutWorker({ regions: ['KZ'], fetch: fakeFetch().fn }));
    expect((await t.scoutRun({ action: 'trends_weekly' })).result).toContain('данных нет');
    await t.scoutRun({ action: 'trends' });
    const weekly = await t.scoutRun({ action: 'trends_weekly' });
    expect(weekly.result).toContain('Тренды ниши за неделю 2026-11-13 - 2026-11-19');
    expect(weekly.result).toContain('- Растут ролики про агентов');
    const off = setup(new OffLlm(), new TrendScoutWorker({ regions: ['KZ'], fetch: fakeFetch().fn }));
    trendStoreFor(off.ctx).saveDay('2026-11-18', [{ hook: 'Хук', format: 'формат', why: 'почему', source: 'youtube', url: 'u', direction: null }]);
    expect((await off.scoutRun({ action: 'trends_weekly' })).result).toContain('- Хук (формат)');
  });
});
