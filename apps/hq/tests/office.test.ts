import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { MockLlm, openDb } from '@fir/core';
import { HeartbeatWorker, Hq, meterLlm } from '@fir/hq';
import { describe, expect, it } from 'vitest';
import { ChatStore } from '../src/client/store.js';
import { WebSessionStore } from '../src/client/web-store.js';
import { buildOffice, cachedOffice, deriveStatus, officeSchema, publicActivity, publicTitle } from '../src/office.js';
import { createWebhook } from '../src/webhook.js';
import { NOW } from './helpers.js';

function world(now = NOW) {
  const hq = new Hq(openDb(':memory:'), { now: () => now });
  hq.upsertAgent({ id: 'director', dept: 'hq', role: 'director', title: 'Директор' });
  hq.upsertAgent({ id: 'marketing-head', dept: 'marketing', role: 'head', title: 'Голова маркетинга' });
  hq.upsertAgent({ id: 'content-maker', dept: 'marketing', role: 'worker', title: 'Контент-мейкер', bossId: 'marketing-head' });
  hq.upsertAgent({ id: 'sales-head', dept: 'sales', role: 'head', title: 'Голова продаж' });
  return hq;
}

const facts = (o: Partial<Parameters<typeof deriveStatus>[0]> = {}) => ({ paused: false, sleeping: false, tasks: [], lastSeenAt: NOW, now: NOW, ...o });

describe('GET /office access', () => {
  async function start(office?: { token: string; get: () => unknown }) {
    const server = createWebhook(() => Promise.resolve(1), 'lead', Date.now, office);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/office` };
  }
  it('404 without OFFICE_TOKEN, 401 on a wrong token, 200 with the right one', async () => {
    const off = await start();
    try {
      expect((await fetch(off.url, { headers: { 'x-office-token': 'x' } })).status).toBe(404);
    } finally { off.server.close(); }
    const hq = world();
    const on = await start({ token: 'office-secret', get: cachedOffice(hq) });
    try {
      expect((await fetch(on.url)).status).toBe(401);
      expect((await fetch(on.url, { headers: { 'x-office-token': 'nope' } })).status).toBe(401);
      expect((await fetch(on.url, { headers: { 'x-lead-token': 'lead' } })).status).toBe(401);
      const ok = await fetch(on.url, { headers: { 'x-office-token': 'office-secret' } });
      expect(ok.status).toBe(200);
      expect(officeSchema.safeParse(await ok.json()).success).toBe(true);
    } finally { on.server.close(); }
  });
});

describe('office data', () => {
  it('matches the schema on an empty and on a busy database', () => {
    const hq = world();
    expect(officeSchema.parse(buildOffice(hq, NOW)).departments.map((d) => d.id)).toEqual(['marketing', 'sales']);
    const t = hq.createTask({ title: 'Клип: ИИ-приёмщик', dept: 'marketing', creator: 'head', assigneeId: 'content-maker' });
    hq.claim(t.id, 'content-maker');
    hq.recordCost({ agentId: 'content-maker', model: 'x', inputTokens: 100, outputTokens: 50, usd: 0.5, taskId: t.id });
    const o = officeSchema.parse(buildOffice(hq, NOW));
    const w = o.departments[0]!.workers[0]!;
    expect(w).toMatchObject({ id: 'content-maker', status: 'working', tasksToday: 1, costTodayUsd: 0.5, currentTask: { id: t.id, title: 'Клип: ИИ-приёмщик' } });
    expect(o.costs).toMatchObject({ todayUsd: 0.5, tokensToday: 150, byDept: { marketing: 0.5 } });
    expect(o.tasks.counts.running).toBe(1);
    expect(o.health.firtech.ok).toBeNull();
  });

  it('caches for 5 seconds', () => {
    const hq = world();
    let clock = 1000;
    const get = cachedOffice(hq, 5000, () => clock);
    const a = get();
    hq.createTask({ title: 'новая', dept: 'marketing', creator: 'owner' });
    clock += 4000;
    expect(get()).toBe(a);
    clock += 1500;
    expect(get()).not.toBe(a);
  });

  it('counts pending approvals and builder issues', () => {
    const hq = world();
    const t = hq.createTask({ title: 'нужен строитель', dept: 'marketing', creator: 'head', tags: ['builder'] });
    hq.block(t.id, 'head', 'x');
    expect(buildOffice(hq, NOW).director.openBuilderIssues).toBe(0);
    hq.setMeta(t.id, { issue: { number: 3, url: 'u' } });
    expect(buildOffice(hq, NOW).director.openBuilderIssues).toBe(1);
  });
});

describe('status derivation', () => {
  it('covers the main cases', () => {
    expect(deriveStatus(facts({ paused: true }))).toBe('paused');
    expect(deriveStatus(facts({ tasks: [{ status: 'running', updatedAt: NOW }] }))).toBe('working');
    expect(deriveStatus(facts({ tasks: [{ status: 'approval', updatedAt: NOW }, { status: 'done', updatedAt: NOW - 1 }] }))).toBe('waiting');
    expect(deriveStatus(facts({ tasks: [{ status: 'review', updatedAt: NOW }] }))).toBe('waiting');
    expect(deriveStatus(facts({ tasks: [{ status: 'blocked', updatedAt: NOW }] }))).toBe('blocked');
    expect(deriveStatus(facts())).toBe('idle');
    expect(deriveStatus(facts({ sleeping: true }))).toBe('sleeping');
    expect(deriveStatus(facts({ sleeping: true, tasks: [{ status: 'running', updatedAt: NOW }] }))).toBe('working');
    expect(deriveStatus(facts({ tasks: [{ status: 'running', updatedAt: NOW }], lastSeenAt: NOW - 11 * 60_000 }))).toBe('offline');
    expect(deriveStatus(facts({ lastSeenAt: null }))).toBe('idle');
  });

  it('reads paused departments and night hours from the database', () => {
    const hq = world();
    hq.setDeptStatus('marketing', 'paused');
    expect(buildOffice(hq, NOW).departments[0]!.workers[0]!.status).toBe('paused');
    // 2026-11-19 22:00 UTC = 03:00 Tashkent: night
    const night = Date.UTC(2026, 10, 19, 22, 0);
    expect(buildOffice(world(night), night).departments[1]!.head!.status).toBe('sleeping');
    expect(buildOffice(world(), NOW).departments[1]!.head!.status).toBe('idle');
  });
});

describe('privacy', () => {
  it('masks lead and client task titles', () => {
    const hq = world();
    const id = hq.createTask({ title: 'Лид с сайта (bots)', dept: 'sales', creator: 'routine', meta: { action: 'lead', lead: { name: 'Dilnoza', contact: '@dilnoza' } } }).id;
    hq.createTask({ title: 'Проект: Салон Роза', dept: 'sales', creator: 'owner', meta: { action: 'project' } });
    hq.createTask({ title: 'Клип: ИИ-приёмщик', dept: 'marketing', creator: 'head' });
    const o = buildOffice(hq, NOW);
    const text = JSON.stringify(o);
    expect(o.tasks.recent.find((t) => t.id === id)!.title).toBe(`Лид #${id}`);
    expect(text).not.toMatch(/Dilnoza|dilnoza|Роза|Лид с сайта/);
    expect(text).toContain('Клип: ИИ-приёмщик');
    expect(publicTitle({ id: 7, title: 'Ответ бизнесу #3 Кафе', dept: 'sales', routineId: null, meta: { action: 'reply' } })).toBe('Ответ бизнесу');
  });

  it('the public scene masks a client domain, name, phone, @username or email in a task title with a generic title; the admin office keeps the real one', () => {
    const hq = world();
    const audit = hq.createTask({ title: 'Аудит: example.com', dept: 'marketing', creator: 'head', meta: { action: 'audit', auditId: 1, url: 'https://example.com' } });
    const byText = hq.createTask({ title: 'Написать @dilnoza_salon про бота', dept: 'marketing', creator: 'owner' });
    const phone = hq.createTask({ title: 'Позвонить +7 701 000 00 04 по рилсу', dept: 'marketing', creator: 'owner' });
    const mail = hq.createTask({ title: 'Ответ на письмо ivan@cafe.uz', dept: 'marketing', creator: 'owner' });
    const ticket = hq.createTask({ title: 'Тикет из бота: Cambridge', dept: 'support', creator: 'routine', meta: { action: 'ticket' } });
    const safe = hq.createTask({ title: 'Клип: ИИ-приёмщик', dept: 'marketing', creator: 'head' });
    const pub = buildOffice(hq, NOW);
    const title = (o: typeof pub, id: number) => o.tasks.recent.find((t) => t.id === id)!.title;
    expect(title(pub, audit.id)).toBe('Аудит сайта');
    expect(title(pub, byText.id)).toBe('Задача маркетинга');
    expect(title(pub, phone.id)).toBe('Задача маркетинга');
    expect(title(pub, mail.id)).toBe('Задача маркетинга');
    expect(title(pub, ticket.id)).toBe('Тикет клиента');
    expect(title(pub, safe.id)).toBe('Клип: ИИ-приёмщик'); // nothing about a client: kept
    expect(JSON.stringify(pub)).not.toMatch(/example\.com|dilnoza_salon|701 000|ivan@cafe|Cambridge/);
    // the admin office (GET /admin/office) asks for the real titles
    const admin = buildOffice(hq, NOW, undefined, { maskClientData: false });
    expect(title(admin, audit.id)).toBe('Аудит: example.com');
    expect(title(admin, byText.id)).toContain('@dilnoza_salon');
    expect(title(admin, ticket.id)).toBe('Тикет из бота: Cambridge');
    expect(publicTitle({ id: 1, title: 'Аудит: example.com', dept: 'marketing', routineId: null, meta: {} })).toBe('Задача маркетинга');
    expect(publicTitle({ id: 1, title: 'Аудит: example.com', dept: 'marketing', routineId: null, meta: { action: 'audit' } })).toBe('Аудит сайта');
    // a routine title is ours and stays, unless it carries a client domain by mistake
    expect(publicTitle({ id: 2, title: 'SEO и AI-SEO проверка сайта', dept: 'marketing', routineId: 5, meta: {} })).toBe('SEO и AI-SEO проверка сайта');
    // the scene is the same: the visible tasks and the page's recent list never carry the domain
    expect(JSON.stringify(officeSchema.parse(pub).scene)).not.toContain('example.com');
  });

  it('strips contacts and free text from the activity feed', () => {
    expect(publicActivity({ action: 'task_created', objectType: 'task', objectId: '12' })).toEqual({ action: 'task_created', object: 'task:12' });
    expect(publicActivity({ action: 'Написал @ivan', objectType: 'lead', objectId: '+7 999 123 45 67' })).toEqual({ action: 'event', object: null });
    expect(publicActivity({ action: 'x', objectType: null, objectId: 'a@b.co' }).object).toBeNull();
    const hq = world();
    hq.log('sales-head', 'note', 'lead', '@dilnoza', 'телефон +79991234567');
    expect(JSON.stringify(buildOffice(hq, NOW).activity)).not.toMatch(/dilnoza|7999/);
  });
});

describe('office scene', () => {
  const MIN = 60_000;
  const scene = (hq: Hq, now = NOW) => officeSchema.parse(buildOffice(hq, now, 86_400 * 1.24)).scene!;

  it('masks visitors, maps states, caps at 20 and leaks no client text', () => {
    const hq = world();
    const web = new WebSessionStore(hq.db, () => NOW - 5 * MIN);
    const tg = new ChatStore(hq.db, () => NOW - 2 * MIN);
    web.create('sess-secret-1', 'ru');
    web.update('sess-secret-1', { state: 'need', draft: { needText: 'Нужен сайт для барбершопа Dilnoza' } });
    web.create('sess-contact', 'ru');
    web.update('sess-contact', { state: 'contact', draft: { question: 'мой номер +79991234567' } });
    web.create('sess-done', 'ru');
    web.update('sess-done', { summary: 'лид создан' });
    web.create('sess-chat', 'ru');
    tg.touch(777001, 'dilnoza_uz', 'ru');
    tg.update(777001, { muted: true, state: 'idle' });
    tg.touch(777002, 'ivan_k', 'ru');
    tg.update(777002, { state: 'budget' });
    tg.touch(777003, 'olga', 'ru');
    tg.update(777003, { state: 'idle', leadTask: 5 });
    // too old: not active
    new WebSessionStore(hq.db, () => NOW - 40 * MIN).create('sess-old', 'ru');
    const o = officeSchema.parse(buildOffice(hq, NOW));
    const s = o.scene!;
    expect(o.visitorsActive).toBe(7);
    expect(s.visitorsTotalToday).toBe(8);
    const states = s.visitors.map((v) => `${v.channel}:${v.state}`).sort();
    expect(states).toEqual(['telegram:done', 'telegram:human', 'telegram:intake', 'web:chat', 'web:contact', 'web:done', 'web:intake']);
    expect(s.visitors.every((v) => /^v-[0-9a-f]{6}$/.test(v.id))).toBe(true);
    expect(new Set(s.visitors.map((v) => v.id)).size).toBe(7);
    const text = JSON.stringify(o);
    expect(text).not.toMatch(/sess-|777001|777002|Dilnoza|dilnoza|ivan_k|olga|барбершоп|79991234567/);
    for (let i = 0; i < 30; i++) web.create(`bulk-${i}`, 'ru');
    const big = officeSchema.parse(buildOffice(hq, NOW));
    expect(big.scene!.visitors).toHaveLength(20);
    expect(big.visitorsActive).toBe(37);
  });

  it('counts today in the company time zone', () => {
    const hq = world();
    // NOW = 12:00 Tashkent; day starts 00:00 Tashkent = 19:00 UTC the day before
    const dayStart = Date.UTC(2026, 10, 17, 19, 0);
    const mk = (created: number) => {
      const h = new Hq(hq.db, { now: () => created });
      return h.createTask({ title: 'Лид', dept: 'sales', creator: 'routine', meta: { action: 'lead', lead: { name: 'Dilnoza' } } });
    };
    mk(dayStart + MIN);
    mk(dayStart - MIN); // yesterday in Tashkent
    mk(dayStart + 3_600_000);
    hq.db.exec('CREATE TABLE IF NOT EXISTS decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, approval_id INTEGER, kind TEXT NOT NULL, decision TEXT NOT NULL, at INTEGER NOT NULL)');
    const ins = hq.db.prepare('INSERT INTO decisions (approval_id, kind, decision, at) VALUES (1, ?, ?, ?)');
    ins.run('x', 'approve', dayStart + MIN); ins.run('x', 'approve', dayStart - MIN); ins.run('x', 'reject', dayStart + MIN); ins.run('x', 'auto', dayStart + MIN);
    const pub = (at: number) => new Hq(hq.db, { now: () => at }).log('owner', 'published', 'content_ready', '4');
    pub(dayStart + MIN); pub(dayStart - MIN);
    expect(scene(hq)).toMatchObject({ leadsToday: 2, approvedToday: 1, rejectedToday: 1, publishedToday: 1, uptimeDays: 1.2 });
  });

  it('groups builder issues by department and pending approvals by agent', () => {
    const hq = world();
    const b1 = hq.createTask({ title: 'a', dept: 'marketing', creator: 'head', tags: ['builder'] });
    hq.block(b1.id, 'head', 'x');
    const b2 = hq.createTask({ title: 'b', dept: 'sales', creator: 'head', tags: ['builder'] });
    hq.block(b2.id, 'head', 'x');
    const open = hq.createTask({ title: 'c', dept: 'marketing', creator: 'head', tags: ['builder'] }); // not blocked
    expect(open.id).toBeGreaterThan(0);
    const t1 = hq.createTask({ title: 'клип', dept: 'marketing', creator: 'head', assigneeId: 'content-maker' });
    const t2 = hq.createTask({ title: 'ответ', dept: 'sales', creator: 'head' });
    const ins = hq.db.prepare("INSERT INTO task_approvals (task_id, dept, kind, payload, summary, state, created_at) VALUES (?, ?, 'k', '{}', 's', ?, ?)");
    ins.run(t1.id, 'marketing', 'queued', NOW); ins.run(t1.id, 'marketing', 'asked', NOW); ins.run(t2.id, 'sales', 'queued', NOW); ins.run(t1.id, 'marketing', 'executed', NOW);
    expect(scene(hq)).toMatchObject({ builderIssuesByDept: { marketing: 1, sales: 1 }, approvalsByAgent: { 'content-maker': 2, 'sales-head': 1 } });
  });

  it('reactions: last 10 minutes only, newest last, capped at 30', () => {
    const hq = world();
    const t = hq.createTask({ title: 'клип', dept: 'marketing', creator: 'head', assigneeId: 'content-maker' });
    const at = (ms: number) => new Hq(hq.db, { now: () => ms });
    at(NOW - 11 * MIN).log('content-maker', 'task_done', 'task', String(t.id));
    at(NOW - 5 * MIN).log('owner', 'approved', 'task', String(t.id));
    at(NOW - 4 * MIN).log('owner', 'rejected', 'task', String(t.id));
    at(NOW - 3 * MIN).log('owner', 'published', 'content_ready', '9');
    at(NOW - 2 * MIN).log('marketing-head', 'task_blocked', 'task', String(t.id));
    at(NOW - 1 * MIN).log('content-maker', 'task_done', 'task', String(t.id));
    at(NOW - 1 * MIN).log('bridge', 'builder_issue_closed', 'task', String(t.id), '#3');
    at(NOW - 1 * MIN).log('content-maker', 'llm.call');
    const r = scene(hq).reactions;
    expect(r.map((x) => `${x.agent}:${x.kind}`)).toEqual([
      'content-maker:approved', 'content-maker:rejected', 'publisher:published', 'marketing-head:blocked', 'content-maker:done', 'content-maker:issue_closed',
    ]);
    for (let i = 0; i < 40; i++) at(NOW - 30_000).log('content-maker', 'task_done', 'task', String(t.id));
    expect(scene(hq).reactions).toHaveLength(30);
  });

  it('lead reaction for a Sales lead task, nothing for the drill', () => {
    const hq = world();
    const lead = hq.createTask({ title: 'Лид', dept: 'sales', creator: 'routine', meta: { action: 'lead', lead: { name: 'Dilnoza' } } });
    hq.createTask({ title: 'Лид', dept: 'sales', creator: 'routine', tags: ['drill'], meta: { action: 'lead' } });
    expect(lead.id).toBeGreaterThan(0);
    expect(scene(hq).reactions).toEqual([{ agent: 'sales-head', kind: 'lead', at: new Date(NOW).toISOString() }]);
    expect(scene(hq).leadsToday).toBe(1);
  });

  it('notice is the first line of the last summary, trimmed to 80, markup stripped', () => {
    const hq = world();
    expect(scene(hq).notice).toBe('');
    hq.db.exec('CREATE TABLE IF NOT EXISTS owner_inbox (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL)');
    const ins = hq.db.prepare('INSERT INTO owner_inbox (at, kind, text) VALUES (?, ?, ?)');
    ins.run(NOW - 1000, 'summary', 'Старая сводка\nтело');
    ins.run(NOW, 'summary', `<b>Утренняя сводка, 19.11 ${'очень длинный заголовок '.repeat(6)}</b>\n\nОтчёты: Dilnoza`);
    ins.run(NOW + 1, 'message', 'не сводка');
    const n = scene(hq).notice;
    expect(n.length).toBeLessThanOrEqual(80);
    expect(n.startsWith('Утренняя сводка, 19.11')).toBe(true);
    expect(n).not.toMatch(/<|Dilnoza/);
  });
});

describe('office liveliness', () => {
  it('an agent stays working for 60 s after its last event, then goes back to idle', () => {
    const hq = world();
    hq.log('content-maker', 'task_done', 'task', '1');
    expect(buildOffice(hq, NOW).departments[0]!.workers[0]!.status).toBe('working');
    expect(buildOffice(hq, NOW + 59_000).departments[0]!.workers[0]!.status).toBe('working');
    expect(buildOffice(hq, NOW + 61_000).departments[0]!.workers[0]!.status).toBe('idle');
    expect(deriveStatus(facts({ lastEventAt: NOW - 30_000 }))).toBe('working');
    expect(deriveStatus(facts({ lastEventAt: NOW - 61_000 }))).toBe('idle');
    expect(deriveStatus(facts({ paused: true, lastEventAt: NOW }))).toBe('paused');
  });

  it('lastActiveAt follows every event, including journal entries and wake-ups', async () => {
    const hq = world();
    const w = buildOffice(hq, NOW).departments[0]!.workers[0]!;
    expect(w.lastActiveAt).toBeNull();
    const t = hq.createTask({ title: 'x', dept: 'marketing', creator: 'head', assigneeId: 'content-maker' });
    hq.addEvent(t.id, 'report', 'content-maker', 'готово');
    expect(officeSchema.parse(buildOffice(hq, NOW)).departments[0]!.workers[0]!.lastActiveAt).toBe(new Date(NOW).toISOString());
    const hb = new HeartbeatWorker(hq, () => Promise.resolve());
    hq.wake('sales-head', 'task');
    await hb.tick();
    const sales = officeSchema.parse(buildOffice(hq, NOW)).departments[1]!.head!;
    expect(sales.lastActiveAt).toBe(new Date(NOW).toISOString());
    expect(sales.status).toBe('working');
  });

  it('thinking is true only while an LLM call of that agent is in flight; the call is logged as llm.call', async () => {
    const hq = world();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const llm = meterLlm(new MockLlm(async () => { await gate; return 'ok'; }), hq, { agentId: 'content-maker' });
    const call = llm.complete({ tier: 'haiku', system: 's', messages: [{ role: 'user', content: 'u' }] });
    const mid = officeSchema.parse(buildOffice(hq, NOW));
    expect(mid.departments[0]!.workers[0]!.thinking).toBe(true);
    expect(mid.departments[0]!.head!.thinking).toBe(false);
    expect(mid.director.thinking).toBe(false);
    release();
    await call;
    expect(buildOffice(hq, NOW).departments[0]!.workers[0]!.thinking).toBe(false);
    expect(buildOffice(hq, NOW).activity.some((a) => a.agent === 'content-maker' && a.action === 'llm.call')).toBe(true);
  });

  it('a failing LLM call does not leave the agent thinking', async () => {
    const hq = world();
    const llm = meterLlm(new MockLlm(() => { throw new Error('boom'); }), hq, { agentId: 'content-maker' });
    await expect(llm.complete({ tier: 'haiku', system: 's', messages: [{ role: 'user', content: 'u' }] })).rejects.toThrow();
    expect(hq.thinking('content-maker')).toBe(false);
  });

  it('queueEmpty and lastEventAt', () => {
    const hq = world();
    expect(buildOffice(hq, NOW)).toMatchObject({ queueEmpty: true, lastEventAt: null });
    const t = hq.createTask({ title: 'x', dept: 'marketing', creator: 'owner' });
    const o = officeSchema.parse(buildOffice(hq, NOW));
    expect(o.queueEmpty).toBe(false);
    expect(o.lastEventAt).toBe(new Date(NOW).toISOString());
    hq.setStatus(t.id, 'done', 'owner');
    expect(buildOffice(hq, NOW).queueEmpty).toBe(true);
  });

  it('activity lists wake-ups, routine fires, approvals decided and LLM calls; last 50; no free text', async () => {
    const hq = world();
    hq.scheduleRoutine({ name: 'marketing-daily', cron: '0 9 * * *', dept: 'marketing', title: 'Что публикуем' });
    hq.runRoutine('marketing-daily');
    hq.wake('marketing-head', 'task');
    await new HeartbeatWorker(hq, () => Promise.resolve()).tick();
    const kinds = new Set(buildOffice(hq, NOW).activity.map((a) => a.action));
    expect(kinds).toContain('routine_fired');
    expect(kinds).toContain('head_wake');
    for (let i = 0; i < 80; i++) hq.log('content-maker', 'llm.call');
    const act = buildOffice(hq, NOW).activity;
    expect(act).toHaveLength(50);
    expect(JSON.stringify(act)).not.toMatch(/Что публикуем/);
    hq.log('owner', 'approval_decided', 'task', '3', 'executed');
    expect(buildOffice(hq, NOW).activity[0]).toMatchObject({ agent: 'owner', action: 'approval_decided', object: 'task:3' });
  });
});
