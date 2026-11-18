import { MockLlm, OffLlm, openDb, type LlmClient } from '@fir/core';
import { Hq, type Task, type WorkerCtx } from '@fir/hq';
import { describe, expect, it } from 'vitest';
import { AnalystWorker, aggregate, fallbackRecommendations, numbersText, type FetchFn } from '../src/index.js';

const DAY = 86_400_000;
// Mon 2026-11-23 08:00 Tashkent. The report covers Mon 16.11 - Sun 22.11.
const NOW = Date.UTC(2026, 10, 23, 3, 0);
const inWeek = Date.UTC(2026, 10, 19, 6, 0);

function world(llm: LlmClient = new OffLlm()) {
  const db = openDb(':memory:');
  const clock = { t: NOW };
  const hq = new Hq(db, { now: () => clock.t });
  db.exec(`
    CREATE TABLE cm_ready (id INTEGER PRIMARY KEY, item_id INTEGER, platform TEXT, type TEXT, text TEXT, planned_date TEXT, status TEXT);
    CREATE TABLE pb_posts (ready_id INTEGER PRIMARY KEY, item_id INTEGER, platform TEXT, sent_on TEXT, published_at INTEGER);
  `);
  const ready = (platform: string, date: string, status = 'ready') => db.prepare('INSERT INTO cm_ready (item_id, platform, type, text, planned_date, status) VALUES (1, ?, ?, ?, ?, ?)').run(platform, 'clip', '', date, status);
  const posted = (id: number, platform: string, at: number) => db.prepare('INSERT INTO pb_posts (ready_id, item_id, platform, published_at) VALUES (?, 1, ?, ?)').run(id, platform, at);
  const ctx: WorkerCtx = { llm, db, tz: 'Asia/Tashkent', now: () => clock.t, requestApproval: () => Promise.resolve(0), log: () => undefined };
  const task = { id: 1, title: 't', body: '', dept: 'marketing', assigneeId: null, creator: 'routine', parentId: null, status: 'running', priority: 0, dueAt: null, result: null, costUsd: 0, meta: { action: 'report' }, tags: [], routineId: null, createdAt: 0, updatedAt: 0 } as Task;
  return { db, hq, clock, ready, posted, ctx, task };
}

function ytFetch(subs: number, status = 200): FetchFn {
  return () => Promise.resolve(status === 200 ? Response.json({ items: [{ statistics: { subscriberCount: String(subs), viewCount: '5000', videoCount: '12' } }] }) : new Response('x', { status }));
}

describe('aggregate', () => {
  it('counts approved and published per platform in the week, Sales leads, costs and the prospector funnel', () => {
    const w = world();
    w.ready('instagram', '2026-11-17'); w.ready('tiktok', '2026-11-17', 'published'); w.ready('shorts', '2026-11-22');
    w.ready('instagram', '2026-11-24'); // next week: not counted
    w.posted(2, 'tiktok', inWeek); w.posted(1, 'instagram', inWeek + 1000); w.posted(3, 'instagram', NOW - 10 * DAY - DAY * 3); // third is old
    // leads: tagged, or by meta/title; routine cards and non-sales tasks are not leads
    w.hq.createTask({ title: 'Заявка с сайта', dept: 'sales', creator: 'owner', tags: ['lead'] });
    w.hq.createTask({ title: 'Лид из бота', dept: 'sales', creator: 'owner' });
    w.hq.createTask({ title: 'Карточки дня', dept: 'sales', creator: 'routine' });
    w.hq.createTask({ title: 'Чужой', dept: 'marketing', creator: 'owner', tags: ['lead'] });
    w.clock.t = NOW; // created now: outside the window, so move the rows into it
    w.db.prepare('UPDATE tasks SET created_at = ?').run(inWeek);
    w.hq.ensureAgent({ id: 'content-maker', dept: 'marketing', role: 'worker', title: 'CM' });
    w.hq.recordCost({ agentId: 'content-maker', model: 'm', inputTokens: 0, outputTokens: 0, usd: 1.25 });
    w.db.prepare('UPDATE costs SET at = ?').run(inWeek);
    w.db.exec("CREATE TABLE prospects (id INTEGER PRIMARY KEY, status TEXT); INSERT INTO prospects (status) VALUES ('new'),('new'),('sent')");
    const n = aggregate(w.db, '2026-11-16', '2026-11-22', NOW, 'Asia/Tashkent', null, null);
    expect(n).toMatchObject({ approved: 3, published: 2, publishedByPlatform: { tiktok: 1, instagram: 1 }, leads: 2, leadsPrev: 0, costUsd: 1.25, subscribers: null, subscribersDelta: null, funnel: { new: 2, sent: 1 } });
  });

  it('tables that do not exist yet give zeros and no funnel, never an error', () => {
    const db = openDb(':memory:');
    new Hq(db);
    expect(aggregate(db, '2026-11-16', '2026-11-22', NOW, 'Asia/Tashkent', null, null)).toMatchObject({ approved: 0, published: 0, leads: 0, funnel: null });
  });

  it('five numbers in text, with and without YouTube', () => {
    const base = { approved: 8, published: 5, publishedByPlatform: { instagram: 3, tiktok: 2 }, leads: 2, leadsPrev: 1, costUsd: 0.5, funnel: null };
    const text = numbersText({ ...base, subscribers: 120, subscribersDelta: 15 });
    expect(text.split('\n')).toHaveLength(5);
    expect(text).toContain('2. Опубликовано (отмечено вручную): 5 (Instagram 3, TikTok 2)');
    expect(text).toContain('5. Подписчики YouTube: 120 (+15 за неделю)');
    expect(numbersText({ ...base, subscribers: null, subscribersDelta: null })).toContain('нет данных (YouTube не подключён)');
  });
});

describe('Analyst report', () => {
  it('one RU report: header with the week, five numbers, three recommendations from the model, stage 2 note', async () => {
    const w = world(new MockLlm(() => JSON.stringify({ recommendations: ['Первая рекомендация', 'Вторая рекомендация', 'Третья рекомендация'] })));
    w.ready('instagram', '2026-11-17');
    const res = await new AnalystWorker({ youtubeApiKey: 'K', youtubeChannelId: 'UC1', fetch: ytFetch(120) }).run(w.task, w.ctx);
    expect(res.ok).toBe(true);
    expect(res.result).toContain('Недельный отчёт маркетинга, 16.11 - 22.11');
    expect(res.result).toContain('1. Одобрено материалов на неделю (платформ): 1');
    expect(res.result).toContain('5. Подписчики YouTube: 120');
    expect(res.result).toContain('3. Третья рекомендация');
    expect(res.result).toContain('Instagram и TikTok: статистики пока нет (этап 2)');
  });

  it('subscriber growth comes from the previous snapshot', async () => {
    const w = world();
    const worker = new AnalystWorker({ youtubeApiKey: 'K', youtubeChannelId: 'UC1', fetch: ytFetch(100) });
    await worker.run(w.task, w.ctx);
    w.clock.t = NOW + 7 * DAY;
    const next = await new AnalystWorker({ youtubeApiKey: 'K', youtubeChannelId: 'UC1', fetch: ytFetch(130) }).run(w.task, w.ctx);
    expect(next.result).toContain('130 (+30 за неделю)');
  });

  it('without a model the rule-based recommendations fill exactly three slots when there is enough to say', async () => {
    const w = world();
    w.ready('instagram', '2026-11-17');
    const res = await new AnalystWorker().run(w.task, w.ctx);
    const recs = res.result.split('Рекомендации:\n')[1]!.split('\n\n')[0]!.split('\n');
    expect(recs).toHaveLength(3);
    expect(recs[0]).toContain('Опубликовано 0 из 1');
    expect(res.result).toContain('нет данных (YouTube не подключён)');
  });

  it('a YouTube failure is a note: the report still comes, the key is not in it', async () => {
    const w = world();
    const res = await new AnalystWorker({ youtubeApiKey: 'SECRETK', youtubeChannelId: 'UC1', fetch: ytFetch(0, 403) }).run(w.task, w.ctx);
    expect(res.ok).toBe(true);
    expect(res.result).toContain('YouTube: YouTube HTTP 403');
    expect(res.result).not.toContain('SECRETK');
    expect((await new AnalystWorker().run({ ...w.task, meta: { action: 'wat' } }, w.ctx)).ok).toBe(false);
  });

  it('fallback recommendations are never more than three', () => {
    expect(fallbackRecommendations({ approved: 7, published: 1, publishedByPlatform: {}, leads: 0, leadsPrev: 2, costUsd: 0, subscribers: null, subscribersDelta: null, funnel: null })).toHaveLength(3);
  });
});
