import { MockLlm, OffLlm, openDb, type LlmClient } from '@fir/core';
import { Hq, type Task, type WorkerCtx } from '@fir/hq';
import { describe, expect, it } from 'vitest';
import { AnalystWorker, aggregate, weekVideoIds, youtubeWeekLine, fallbackRecommendations, numbersText, type FetchFn } from '../src/index.js';

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

  it('articles of the week: proposed, approved, published (builder issue closed); no line without articles', () => {
    const w = world();
    w.db.exec(`
      CREATE TABLE cm_articles (id INTEGER PRIMARY KEY, niche TEXT, status TEXT, created_at INTEGER, decided_at INTEGER, task_id INTEGER, published INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE cm_items (id INTEGER PRIMARY KEY, status TEXT, created_at INTEGER, source_slug TEXT);
      CREATE TABLE cm_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const art = (status: string, created: number, decided: number | null, task: number | null, published = 0) => w.db.prepare('INSERT INTO cm_articles (niche, status, created_at, decided_at, task_id, published) VALUES (?, ?, ?, ?, ?, ?)').run('barber', status, created, decided, task, published);
    w.db.prepare('INSERT INTO cm_items (status, created_at, source_slug) VALUES (?, ?, ?)').run('ready', inWeek, 'a-b');
    w.db.prepare('INSERT INTO cm_items (status, created_at, source_slug) VALUES (?, ?, ?)').run('ready', inWeek, null);
    w.db.prepare("INSERT INTO cm_kv (key, value) VALUES ('blog_hits:2026-11-17', '40'), ('blog_hits:2026-11-18', '2'), ('blog_hits:2026-10-01', '99')").run();
    const t1 = w.hq.createTask({ title: 'Статья 1', dept: 'marketing', creator: 'head', meta: { builderClosed: true } });
    const t2 = w.hq.createTask({ title: 'Статья 2', dept: 'marketing', creator: 'head', meta: { issue: { number: 7 } } });
    art('approved', inWeek, inWeek, t1.id);
    art('approved', inWeek, inWeek, t2.id, 1); // published by HQ itself
    art('rejected', inWeek, inWeek, null);
    art('proposed', inWeek, null, null);
    art('approved', inWeek - 30 * DAY, inWeek - 30 * DAY, t1.id); // old: not this week
    const n = aggregate(w.db, '2026-11-16', '2026-11-22', NOW, 'Asia/Tashkent', null, null);
    expect(n.articles).toEqual({ proposed: 4, approved: 2, published: 2, fromArticles: 1, hits: 42 });
    expect(numbersText(n)).toContain('6. Статьи блога: предложено 4, одобрено 2, опубликовано 2');
    expect(numbersText(n)).toContain('из статей в материалах недели: 1; обращений к /blog: 42');
    const none = world();
    expect(aggregate(none.db, '2026-11-16', '2026-11-22', NOW, 'Asia/Tashkent', null, null).articles).toBeNull();
  });

  it('tables that do not exist yet give zeros and no funnel, never an error', () => {
    const db = openDb(':memory:');
    new Hq(db);
    expect(aggregate(db, '2026-11-16', '2026-11-22', NOW, 'Asia/Tashkent', null, null)).toMatchObject({ approved: 0, published: 0, leads: 0, funnel: null });
  });

  it('five numbers in text, with and without YouTube', () => {
    const base = { approved: 8, published: 5, publishedByPlatform: { instagram: 3, tiktok: 2 }, leads: 2, leadsPrev: 1, costUsd: 0.5, funnel: null, articles: null };
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
    expect(fallbackRecommendations({ approved: 7, published: 1, publishedByPlatform: {}, leads: 0, leadsPrev: 2, costUsd: 0, subscribers: null, subscribersDelta: null, funnel: null, articles: null })).toHaveLength(3);
  });
});

describe('YouTube with the owner token', () => {
  const oauth = { accessToken: () => Promise.resolve('AT') };
  const get = (url: string, h: Record<string, string>) => {
    expect(h.authorization).toBe('Bearer AT');
    if (url.includes('channels?part=statistics&mine=true')) return Promise.resolve({ items: [{ statistics: { subscriberCount: '45', viewCount: '9000', videoCount: '12' } }] });
    if (url.includes('videos?part=statistics&id=aaaaaaaaaaa,bbbbbbbbbbb')) return Promise.resolve({ items: [{ statistics: { viewCount: '700' } }, { statistics: { viewCount: '500' } }] });
    return Promise.reject(new Error(`unexpected ${url}`));
  };
  const withUrl = (w: ReturnType<typeof world>) => {
    w.db.exec('ALTER TABLE pb_posts ADD COLUMN url TEXT');
    w.posted(1, 'shorts', inWeek);
    w.posted(2, 'shorts', inWeek);
    w.posted(3, 'shorts', inWeek - 20 * DAY);
    w.db.prepare("UPDATE pb_posts SET url = 'https://youtube.com/shorts/' || CASE ready_id WHEN 1 THEN 'aaaaaaaaaaa' WHEN 2 THEN 'bbbbbbbbbbb' ELSE 'ccccccccccc' END").run();
  };

  it('the week line counts this week\'s Shorts, their views and subscribers', async () => {
    const w = world();
    withUrl(w);
    const res = await new AnalystWorker({ oauth, get }).run(w.task, w.ctx);
    expect(res.result).toContain('YouTube за неделю: 2 Shorts, 1200 просмотров, 45 подписчиков');
    expect(weekVideoIds(w.db, inWeek - DAY, inWeek + DAY)).toHaveLength(2);
    expect(youtubeWeekLine(1, 10, 5, 2)).toBe('YouTube за неделю: 1 Shorts, 10 просмотров, 5 подписчиков (+2)');
  });

  it('without a refresh token the API-key path works as before and adds no week line', async () => {
    const w = world();
    const res = await new AnalystWorker({ youtubeApiKey: 'K', youtubeChannelId: 'UC1', fetch: ytFetch(30) }).run(w.task, w.ctx);
    expect(res.result).toContain('Подписчики YouTube: 30');
    expect(res.result).not.toContain('YouTube за неделю');
  });
});
