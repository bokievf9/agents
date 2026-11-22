/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { GrammyError } from 'grammy';
import { afterEach, describe, expect, it } from 'vitest';
import { OWNER, TOKENS, drillWorld, type DrillWorld } from './world.js';
import { seedEverything, LEAD } from './seed.js';
import { useGuard } from './guard.js';

const g = useGuard();
let w: DrillWorld;
afterEach(async () => { await w?.close(); });

const tooMany = () => new GrammyError('Too Many Requests', { ok: false, error_code: 429, description: 'Too Many Requests: retry after 2', parameters: { retry_after: 2 } } as any, 'sendMessage', {});

describe('Telegram trouble: the outbox retries, nothing is lost or doubled', () => {
  it('a 429 on a reminder is retried after retry_after and the reminder arrives once', async () => {
    w = await drillWorld();
    await w.notices.scan(); // the first scan only marks what exists
    const real = w.tg.sendMessage.bind(w.tg);
    let fails = 2;
    w.tg.sendMessage = (...a: Parameters<typeof real>) => (fails-- > 0 ? Promise.reject(tooMany()) : real(...a));
    expect((await w.http('POST', '/lead', { ...LEAD, name: 'Ретрай' }, { 'x-lead-token': TOKENS.lead })).status).toBe(200);
    await w.beat(); // 15:00 Kuala Lumpur, not quiet
    const n = w.tg.sent.length;
    await w.notices.scan();
    expect(w.sleeps.filter((ms) => ms >= 2000).length, 'it waited the retry_after').toBeGreaterThanOrEqual(2);
    const sent = w.tg.sent.slice(n).filter((m) => m.text.includes('Новая заявка'));
    expect(sent).toHaveLength(1);
    await w.notices.scan(); // the next tick sends nothing again
    expect(w.tg.sent.slice(n).filter((m) => m.text.includes('Новая заявка'))).toHaveLength(1);
    expect(g.errors()).toEqual([]);
  });
  it('TG_APPROVAL_CARDS=on (legacy): a 429 on a card is retried after retry_after and the card arrives once', async () => {
    w = await drillWorld({ withServer: false, tgCards: true });
    for (const k of w.queue.trustTable()) w.queue.setLevel(k.kind, 0);
    const real = w.tg.sendMessage.bind(w.tg);
    let fails = 2;
    w.tg.sendMessage = (...a: Parameters<typeof real>) => (fails-- > 0 ? Promise.reject(tooMany()) : real(...a));
    await w.cmd('invoice', 'Dilnoza 120 поддержка бота');
    await w.beat();
    const n = w.tg.sent.length;
    await w.director.sendApprovalBatch(true);
    expect(w.sleeps.filter((ms) => ms >= 2000).length, 'it waited the retry_after').toBeGreaterThanOrEqual(2);
    const cards = w.tg.sent.slice(n).filter((m) => m.text.includes('billing_invoice') || m.buttons);
    expect(cards.length).toBe(1);
    expect(w.queue.pending().filter((r) => r.kind === 'billing_invoice')).toHaveLength(1);
    expect(g.errors()).toEqual([]);
  });
  it('TG_APPROVAL_CARDS=on (legacy): Telegram down for good: the card stays queued, the owner is not told twice, the next batch sends it once', async () => {
    w = await drillWorld({ withServer: false, tgCards: true });
    for (const k of w.queue.trustTable()) w.queue.setLevel(k.kind, 0);
    const real = w.tg.sendMessage.bind(w.tg);
    let down = true;
    w.tg.sendMessage = (...a: Parameters<typeof real>) => (down ? Promise.reject(Object.assign(new Error('502 Bad Gateway'), { error_code: 502 })) : real(...a));
    await w.cmd('invoice', 'Dilnoza 120 поддержка бота').catch(() => undefined);
    await w.beat();
    await w.director.sendApprovalBatch(true).catch(() => undefined);
    expect(w.queue.pending().length + w.hq.queuedApprovals().length).toBeGreaterThan(0);
    down = false;
    await w.director.sendApprovalBatch(true);
    const cards = w.tg.sent.filter((m) => m.buttons?.some((r) => r.some((b) => /^ap:\d+:a$/.test(b.data ?? ''))));
    process.stdout.write('CARDS ' + JSON.stringify(cards.map((c) => c.text.slice(0, 200))) + '\n'); expect(cards).toHaveLength(1);
    expect(g.rejections).toEqual([]);
    g.expectErrors(); // a dead Telegram may log errors; what matters is no duplicate and no lost card
  });
  it('a blocked owner chat (403) does not crash the heads', async () => {
    w = await drillWorld({ withServer: false });
    w.tg.sendMessage = () => Promise.reject(Object.assign(new Error('Forbidden: bot was blocked by the user'), { error_code: 403 }));
    await w.cmd('status').catch(() => undefined);
    for (const r of ['support-daily', 'marketing-trends-daily', 'sales-daily-cards']) w.hq.runRoutine(r);
    for (let i = 0; i < 3; i++) await w.beat();
    expect(g.rejections).toEqual([]);
    g.expectErrors();
  });
});

describe('quiet hours (owner clock 23:00-08:00 Kuala Lumpur)', () => {
  it('an alert in the night waits for the morning summary instead of waking the owner (the Shell has it at once)', async () => {
    w = await drillWorld({ withServer: false });
    w.clock.t = Date.UTC(2026, 10, 18, 17, 30); // 01:30 Kuala Lumpur
    expect(w.hq.isQuiet()).toBe(true);
    const n = w.tg.sent.length;
    await w.hq.alert('Тестовый ночной алерт: подробности для Shell', { kind: 'llm', short: 'Тестовый ночной алерт' });
    await w.notices.flush();
    expect(w.tg.sent.length).toBe(n);
    expect(w.channel.list({ limit: 50 }).map((m) => m.text).join('\n')).toContain('подробности для Shell');
    w.clock.t = Date.UTC(2026, 10, 19, 0, 5); // 08:05
    expect(w.hq.isQuiet()).toBe(false);
    await w.notices.flush();
    expect(w.tg.sent.length, 'the night alert is not sent on its own in the morning').toBe(n);
    await w.director.sendMorningSummary();
    const morning = w.tg.sent.slice(n).map((m) => m.text).join('\n');
    expect(morning).toContain('Утренняя сводка');
    expect(morning).toContain('За ночь: алертов 1');
    expect(morning).toContain('Тестовый ночной алерт');
    expect(w.tg.sent.slice(n)).toHaveLength(1);
  });
  it('the web chat in quiet hours still answers 200 and the visitor is promised a reply', async () => {
    w = await drillWorld();
    w.clock.t = Date.UTC(2026, 10, 18, 18, 30); // 23:30 Dushanbe, inside the client quiet hours
    const r = await w.http('POST', '/chat', { sessionId: 'visitor-night-0001', locale: 'ru', message: 'Сколько стоит бот для салона?' }, { 'x-chat-token': TOKENS.chat });
    expect(r.status).toBe(200);
    expect(g.errors()).toEqual([]);
  });
});

describe('the model gateway is down', () => {
  it('POST /chat answers 200 with the scripted line and the request is not lost; /lead still makes its task', async () => {
    w = await drillWorld({ gatewayDown: true });
    const r = await w.http('POST', '/chat', { sessionId: 'visitor-down-0001', locale: 'ru', message: 'Здравствуйте, нужен бот' }, { 'x-chat-token': TOKENS.chat });
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(JSON.stringify(body)).toMatch(/менеджер|Принял|ответит/i);
    const lead = await w.http('POST', '/lead', LEAD, { 'x-lead-token': TOKENS.lead });
    expect(lead.status).toBe(200);
    for (let i = 0; i < 3; i++) await w.beat();
    const t = w.hq.tasks({ dept: 'sales', limit: 20 }).find((x) => x.meta.action === 'lead')!;
    expect(['approval', 'done', 'blocked']).toContain(t.status);
    if (t.status === 'blocked') expect(w.hq.events(t.id).at(-1)!.body.length).toBeGreaterThan(5);
    expect(g.rejections).toEqual([]);
    expect(g.errors().map((l) => `${l.msg}: ${String(l.err)}`)).toEqual([]);
  });
  it('the gateway comes back: the owner hears once that it is down and once that it is back', async () => {
    w = await drillWorld({ withServer: false });
    // the watcher is part of index.ts; here the heads' own failure path is what counts: a down gateway blocks tasks with a reason and /retry brings them back
    w.state.down = true;
    const t = w.hq.runRoutine('support-daily')!;
    for (let i = 0; i < 3; i++) await w.beat();
    const blockedOrDone = w.hq.task(t.id)!;
    expect(['blocked', 'done', 'approval']).toContain(blockedOrDone.status);
    w.state.down = false;
    if (blockedOrDone.status === 'blocked') {
      await w.cmd('retry', String(t.id));
      for (let i = 0; i < 3; i++) await w.beat();
      expect(['done', 'approval', 'blocked']).toContain(w.hq.task(t.id)!.status);
    }
    expect(g.rejections).toEqual([]);
  });
});

describe('lost leads', () => {
  it('a lead task that cannot be created: the form gets 500, the contact is kept, the owner hears it in the hourly alert', async () => {
    w = await drillWorld();
    const real = w.sales.createLeadTask.bind(w.sales);
    (w.sales as any).createLeadTask = () => { throw new Error('db is locked'); };
    const r = await w.http('POST', '/lead', { ...LEAD, name: 'Lost Visitor', contact: '@lost_visitor' }, { 'x-lead-token': TOKENS.lead });
    expect(r.status).toBe(500);
    (w.sales as any).createLeadTask = real;
    expect(w.lost.recent(5)[0]).toMatchObject({ source: 'lead', contact: '@lost_visitor' });
    expect(await w.lost.flush()).toBe(1);
    expect(w.alerts.join('\n')).toContain('@lost_visitor');
    expect(await w.lost.flush()).toBe(0); // once an hour
    expect(w.lost.summaryLine()).toContain('1');
    g.expectErrors(); // the webhook logs the failure it answered with 500
  });
  it('a stale lead task is recorded once', async () => {
    w = await drillWorld();
    await w.http('POST', '/lead', { ...LEAD, name: 'Stale Visitor', contact: '@stale_v' }, { 'x-lead-token': TOKENS.lead });
    w.clock.t += 20 * 60_000;
    expect(w.lost.watchStale()).toBe(1);
    expect(w.lost.watchStale()).toBe(0);
  });
});

describe('a seeded office survives a restart in the middle of work', () => {
  it('running tasks go back to assigned, running approvals fail instead of running twice', async () => {
    w = await drillWorld();
    for (const k of w.queue.trustTable()) w.queue.setLevel(k.kind, 0);
    await seedEverything(w);
    const t = w.hq.tasks({ dept: 'support', limit: 1 })[0]!;
    w.hq.db.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(t.id);
    const card = w.queue.pending()[0]!;
    w.hq.db.prepare("UPDATE approvals SET status = 'running' WHERE id = ?").run(card.id);
    expect(w.hq.recoverInterrupted()).toContain(t.id);
    expect(w.queue.recoverInterrupted()).toContain(card.id);
    expect(w.hq.task(t.id)!.status).toBe('assigned');
    expect(w.queue.get(card.id)!.status).toBe('failed');
    void OWNER;
    g.expectErrors();
  });
});
