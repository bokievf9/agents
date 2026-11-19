/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { storeFor } from '@fir/worker-content-maker';
import { BillingStore } from '@fir/worker-billing';
import { PmStore } from '@fir/worker-project-manager';
import { describe, expect, it } from 'vitest';
import { EVENT_NAMES, cleanPath, eventsApi } from '../src/pult-events.js';
import { pultWorld, serve, type PultWorld } from './pult-helpers.js';

const SITE = 'site-secret';
const DAY = 86_400_000;
const days = (p: PultWorld) => p.w.db.prepare('SELECT * FROM site_events ORDER BY day, name, path').all() as any[];

async function events(p: PultWorld, clock: () => number = () => p.t()) {
  const api = eventsApi(p.w.db, p.t, () => p.w.hq.tz);
  const s = await serve(p, { events: { token: SITE, handle: api.handle } }, undefined, clock);
  const send = (body: unknown, headers: Record<string, string> = { 'x-site-token': SITE }) =>
    s.http('POST', '/events', body, headers);
  return { s, send, api };
}

describe('POST /events', () => {
  it('needs the site token (401), and does not exist without one (404)', async () => {
    const p = pultWorld();
    const { s, send } = await events(p);
    expect((await send({ name: 'chat_open' }, {})).status).toBe(401);
    expect((await send({ name: 'chat_open' }, { 'x-site-token': 'nope' })).status).toBe(401);
    expect((await send({ name: 'chat_open' }, { 'x-admin-token': 'admin-secret' })).status).toBe(401); // another token does not open it
    expect(days(p)).toEqual([]);
    await s.close();
    const bare = await serve(pultWorld());
    expect((await bare.http('POST', '/events', { name: 'chat_open' }, { 'x-site-token': SITE })).status).toBe(404);
    await bare.close();
  });

  it('accepts exactly the whitelist, anything else is 400 with the allowed names', async () => {
    const p = pultWorld();
    const { s, send } = await events(p);
    for (const name of EVENT_NAMES) {
      const r = await send({ name, path: '/ru/blog', locale: 'ru' });
      expect(r.status, name).toBe(200);
      expect(await r.json()).toEqual({ ok: true });
    }
    expect(days(p)).toHaveLength(EVENT_NAMES.length);
    for (const bad of [{}, { name: 'page_view' }, { name: 5 }, { name: 'chat_open; DROP TABLE site_events' }, { path: '/x' }, [], 'chat_open', null, { name: 'chat_open', path: 'x'.repeat(301) }]) {
      const r = await send(bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(await r.json()).toMatchObject({ ok: false, error: 'invalid', allowed: [...EVENT_NAMES] });
    }
    const broken = await s.http('POST', '/events', undefined, { 'x-site-token': SITE });
    expect(broken.status).toBe(400);
    expect(days(p)).toHaveLength(EVENT_NAMES.length); // nothing from the bad ones
    await s.close();
  });

  it('aggregates per day, name and page into one counter; days follow the company clock', async () => {
    const p = pultWorld();
    const { s, send } = await events(p);
    for (let i = 0; i < 3; i++) await send({ name: 'blog_view', path: '/ru/blog/bot-dlya-barber', locale: 'ru' });
    await send({ name: 'blog_view', path: '/ru/blog/other', locale: 'ru' });
    await send({ name: 'chat_open' });
    expect(days(p).map((r) => [r.day, r.name, r.path, r.count])).toEqual([
      ['2026-11-18', 'blog_view', '/ru/blog/bot-dlya-barber', 3], ['2026-11-18', 'blog_view', '/ru/blog/other', 1], ['2026-11-18', 'chat_open', '', 1],
    ]);
    p.w.clock.t += DAY;
    await send({ name: 'blog_view', path: '/ru/blog/bot-dlya-barber', locale: 'ru' });
    expect(days(p).filter((r) => r.day === '2026-11-19')).toHaveLength(1);
    // 20:00 UTC is already the next day in Tashkent (UTC+5)
    p.w.clock.t = Date.UTC(2026, 10, 18, 20, 0);
    await send({ name: 'chat_open' });
    expect(days(p).find((r) => r.name === 'chat_open' && r.day === '2026-11-19')!.count).toBe(1);
    await s.close();
  });

  it('keeps no personal data: no IP, no query or key, no invoice numbers, no free text', async () => {
    const p = pultWorld();
    const { s, send } = await events(p);
    await send({ name: 'pay_view', path: '/ru/pay/FT-2026-001?k=SECRETKEY#frag', ref: 'c1a1b2c3', locale: 'ru' }, { 'x-site-token': SITE, 'x-visitor-ip': '203.0.113.9' });
    await send({ name: 'ref_click', path: 'https://firtech.pro/en/?utm=alice@example.com', ref: 'Алиса <script>', locale: 'de' });
    await send({ name: 'cabinet_signup', path: '/ru/cabinet/abcdef0123456789abcdef0123456789abcdef', locale: 'en' });
    const rows = days(p);
    expect(Object.keys(rows[0]).sort()).toEqual(['count', 'day', 'locale', 'name', 'path', 'ref']);
    expect(rows.map((r) => [r.name, r.path, r.ref, r.locale])).toEqual([
      ['cabinet_signup', '/ru/cabinet/:id', '', 'en'], ['pay_view', '/ru/pay/:id', 'c1a1b2c3', 'ru'], ['ref_click', '/en', '', ''],
    ]);
    const dump = JSON.stringify(p.w.db.prepare('SELECT * FROM site_events').all());
    for (const secret of ['203.0.113.9', 'SECRETKEY', 'FT-2026', 'alice@example.com', 'script', 'frag']) expect(dump).not.toContain(secret);
    await s.close();
  });

  it('120 a minute per visitor IP (x-visitor-ip), other visitors are not affected, the window moves', async () => {
    const p = pultWorld();
    const clock = { t: Date.now() };
    const { s, send } = await events(p, () => clock.t);
    const as = (ip: string) => ({ 'x-site-token': SITE, 'x-visitor-ip': ip });
    for (let i = 0; i < 120; i++) expect((await send({ name: 'chat_open' }, as('198.51.100.1'))).status).toBe(200);
    const over = await send({ name: 'chat_open' }, as('198.51.100.1'));
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ ok: false, error: 'rate_limited' });
    expect((await send({ name: 'chat_open' }, as('198.51.100.2'))).status).toBe(200);
    expect(days(p).reduce((n, r) => n + r.count, 0)).toBe(121); // the limited one is not counted
    clock.t += 61_000;
    expect((await send({ name: 'chat_open' }, as('198.51.100.1'))).status).toBe(200);
    await s.close();
  });
});

describe('cleanPath', () => {
  it('keeps the page, drops everything that could identify someone', () => {
    expect(cleanPath('/ru/blog/Bot-Dlya-Barber/?a=1')).toBe('/ru/blog/bot-dlya-barber');
    expect(cleanPath('https://firtech.pro/en/pricing#top')).toBe('/en/pricing');
    expect(cleanPath('/ru/pay/FT-2026-001')).toBe('/ru/pay/:id');
    expect(cleanPath('/ru/блог')).toBe('/ru/:id');
    expect(cleanPath('no-slash')).toBe('');
    expect(cleanPath(undefined)).toBe('');
    expect(cleanPath('/')).toBe('/');
    expect(cleanPath('/a/b/c/d/e/f/g/h').split('/').length).toBeLessThanOrEqual(7);
  });
});

describe('GET /admin/metrics/week', () => {
  const W47 = Date.UTC(2026, 10, 18, 7, 0); // Wed, 2026-W47 (Mon 16.11 - Sun 22.11)
  const W46 = W47 - 7 * DAY;

  it('401 without the token, 400 on a bad week, zeros and the full shape on an empty database', async () => {
    const p = pultWorld();
    const s = await serve(p);
    expect((await s.http('GET', '/admin/metrics/week', undefined, {})).status).toBe(401);
    await s.close();
    expect((await p.call('GET', '/admin/metrics/week?week=2026-W99')).status).toBe(400);
    const r = await p.call('GET', '/admin/metrics/week');
    expect(r.json.ok).toBe(true);
    expect(r.json.week).toBe('2026-W47');
    const zero = {
      site: Object.fromEntries(EVENT_NAMES.map((n) => [n, 0])), blog: { hits: 0, published: 0 }, youtube: { shorts: 0, views: 0, subscribers: 0, delta: 0 },
      funnel: { leads: 0, qualified: 0, proposals: 0, contracts: 0, paid: 0, projects: 0 }, money: { invoicedUsd: 0, paidUsd: 0 },
    };
    expect(r.json).toMatchObject(zero);
    expect(r.json.prevWeek).toEqual({ week: '2026-W46', ...zero });
    expect((await p.call('POST', '/admin/metrics/week', {})).status).toBe(404);
  });

  it('adds up the seeded week and the week before from events, blog, YouTube, funnel and invoices', async () => {
    const p = pultWorld();
    const { w } = p;
    const db = w.db;
    // site events of both weeks
    const api = eventsApi(db, () => w.clock.t, () => w.hq.tz);
    const hit = (at: number, name: string, n = 1) => { w.clock.t = at; for (let i = 0; i < n; i++) api.handle({ name, path: '/ru' }); };
    hit(W47, 'chat_open', 4); hit(W47 + DAY, 'chat_open', 2); hit(W47, 'lead_sent', 3); hit(W47 - DAY, 'blog_view', 7); hit(W47 - 2 * DAY, 'pay_view');
    hit(W46, 'chat_open', 5); hit(W46, 'lead_sent');
    hit(W47 + 6 * DAY, 'builder_done', 2); // Tue 24.11: next week, not counted
    w.clock.t = W47;
    // blog: hits per day in cm_kv, one article approved and published this week
    const cm = storeFor({ db, now: () => w.clock.t });
    cm.setKv('blog_hits:2026-11-17', '5'); cm.setKv('blog_hits:2026-11-19', '3'); cm.setKv('blog_hits:2026-11-10', '9');
    const a = cm.insertArticle('barber'); cm.setArticle(a, { status: 'proposed' }); cm.publishArticle(a, { slug: 'bot-dlya-barber', json: '{}', date: '2026-11-18' });
    // YouTube: two Shorts this week, snapshots for the views and subscribers
    db.exec('CREATE TABLE IF NOT EXISTS pb_posts (ready_id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL, platform TEXT NOT NULL, sent_on TEXT, published_at INTEGER, url TEXT, error TEXT, auto_on TEXT)');
    db.prepare("INSERT INTO pb_posts (ready_id, item_id, platform, published_at, url) VALUES (1, 1, 'shorts', ?, 'https://youtube.com/shorts/abcDEF12345'), (2, 2, 'shorts', ?, 'https://youtube.com/shorts/ghiJKL67890'), (3, 3, 'shorts', ?, 'https://youtube.com/shorts/oldOLD11111')").run(W47, W47 + 1000, W46);
    db.exec('CREATE TABLE IF NOT EXISTS an_snapshots (week_end TEXT PRIMARY KEY, yt_subscribers INTEGER, yt_views INTEGER, yt_videos INTEGER, numbers TEXT NOT NULL, created_at INTEGER NOT NULL)');
    db.prepare("INSERT INTO an_snapshots VALUES ('2026-11-08', 90, 800, 5, '{}', 0), ('2026-11-15', 100, 1000, 7, '{}', 0), ('2026-11-22', 112, 1700, 9, '{}', 0)").run();
    // funnel and money
    const billing = new BillingStore(db, () => w.clock.t);
    const pm = new PmStore(db, () => w.clock.t);
    db.exec(`CREATE TABLE IF NOT EXISTS ps_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, pack_id INTEGER NOT NULL DEFAULT 1, lead_id INTEGER, kind TEXT NOT NULL, direction TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft', created_at INTEGER NOT NULL, decided_at INTEGER)`);
    db.exec(`CREATE TABLE IF NOT EXISTS bo_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, client TEXT NOT NULL, project_id INTEGER, version INTEGER NOT NULL DEFAULT 1, text TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', task_id INTEGER, created_at INTEGER NOT NULL)`);
    const l1 = p.lead('Алиса', { service: 'bot', budget: '$300', at: W47 });
    p.lead('Боб', { at: W47 + 1000 });
    p.lead('Вася', { service: 'site', budget: '$500', at: W47 + 2000 });
    p.lead('Прошлая', { service: 'bot', budget: '$100', at: W46 });
    db.prepare("INSERT INTO ps_documents (lead_id, kind, status, created_at, decided_at) VALUES (?, 'kp', 'approved', ?, ?), (?, 'kp', 'approved', ?, ?), (?, 'kp', 'draft', ?, NULL)").run(l1.id, W47, W47, l1.id + 3, W46, W46, l1.id + 1, W47);
    db.prepare("INSERT INTO bo_documents (type, client, status, created_at) VALUES ('contract', 'Алиса', 'approved', ?), ('contract', 'X', 'rejected', ?), ('act', 'Алиса', 'approved', ?)").run(W47, W47, W47);
    const i1 = billing.addInvoice({ client: 'Алиса', amountUsd: 150, what: 'Сайт', method: null, dueDate: '2026-12-01', leadId: l1.id }, 2026);
    billing.setStatus(i1.id, 'issued'); billing.markManualPaid(i1.id);
    const i2 = billing.addInvoice({ client: 'Вася', amountUsd: 80.5, what: 'Бот', method: null, dueDate: '2026-12-01' }, 2026);
    billing.setStatus(i2.id, 'issued');
    const i3 = billing.addInvoice({ client: 'Черновик', amountUsd: 999, what: 'Черновик', method: null, dueDate: '2026-12-01' }, 2026); // draft: not invoiced yet
    void i3;
    const proj = pm.createProject({ client: 'Алиса', what: 'Сайт', product: 'site', source: 'sales', taskId: null, leadId: l1.id }); pm.setStatus(proj.id, 'active');
    pm.createProject({ client: 'Резерв', what: 'Бот', product: 'bot', source: 'sales', taskId: null }); // a reservation is not a project yet
    // the previous week's money
    w.clock.t = W46;
    const old = billing.addInvoice({ client: 'Старый', amountUsd: 40, what: 'Правка', method: null, dueDate: '2026-11-20' }, 2026); billing.setStatus(old.id, 'issued'); billing.markManualPaid(old.id);
    w.clock.t = W47;

    const r = await p.call('GET', '/admin/metrics/week?week=2026-W47');
    expect(r.status).toBe(200);
    expect(r.json.site).toEqual({ chat_open: 6, builder_done: 0, estimate_pdf: 0, lead_sent: 3, audit_sent: 0, ref_click: 0, cabinet_signup: 0, pay_view: 1, blog_view: 7 });
    expect(r.json.blog).toEqual({ hits: 8, published: 1 });
    expect(r.json.youtube).toEqual({ shorts: 2, views: 700, subscribers: 112, delta: 12 });
    expect(r.json.funnel).toEqual({ leads: 3, qualified: 2, proposals: 1, contracts: 1, paid: 1, projects: 1 });
    expect(r.json.money).toEqual({ invoicedUsd: 230.5, paidUsd: 150 });
    expect(r.json.prevWeek).toMatchObject({
      week: '2026-W46', site: { chat_open: 5, lead_sent: 1, blog_view: 0 }, blog: { hits: 9, published: 0 },
      youtube: { shorts: 1, views: 200, subscribers: 100, delta: 10 },
      funnel: { leads: 1, qualified: 1, proposals: 1, contracts: 0, paid: 1, projects: 0 }, money: { invoicedUsd: 40, paidUsd: 40 },
    });
    // the same keys in the current and the previous week
    const keys = (o: any) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'ok' && k !== 'prevWeek').map(([k, v]) => [k, typeof v === 'object' ? Object.keys(v as object).sort() : k]));
    expect(keys(r.json.prevWeek)).toEqual(keys(r.json));
    // an explicit past week reads its own rows
    const past = await p.call('GET', '/admin/metrics/week?week=2026-W46');
    expect(past.json.site.chat_open).toBe(5);
    expect(past.json.prevWeek.week).toBe('2026-W45');
  });
});
