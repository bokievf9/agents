import { ApprovalQueue, MemoryMessenger, MockLlm, openDb } from '@fir/core';
import { Hq } from '@fir/hq';
import { BillingWorker } from '@fir/worker-billing';
import { CsStore } from '@fir/worker-customer-support';
import { FinanceWorker } from '@fir/worker-finance';
import { DAY_MS, MonitoringWorker, type CheckDeps, type MonitorConfig } from '@fir/worker-monitoring';
import { describe, expect, it } from 'vitest';
import { Director } from '../src/director.js';
import { SUPPORT_HEAD_ID, SupportHead, seedSupport } from '../src/heads/support.js';
import { Reporter, type TopicSender } from '../src/reporter.js';

const OWNER = 100;
// Wed 2026-11-18 03:00 Tashkent (22:00 UTC the day before)
const T0 = Date.UTC(2026, 10, 17, 22, 0);
const cfg: MonitorConfig = {
  urls: ['https://firtech.pro/api/health'], omnirouteUrl: 'http://omniroute:20128/health', dataDir: '/d', docker: false, dockerSocket: '/s',
  diskMaxPct: 85, certMinDays: 14, timeoutMs: 1000,
};

function world() {
  const clock = { t: T0, healthy: true };
  const db = openDb(':memory:');
  const messenger = new MemoryMessenger();
  const hq = new Hq(db, { now: () => clock.t });
  const queue = new ApprovalQueue(db, messenger, OWNER, 20, () => clock.t);
  hq.attachQueue(queue);
  hq.upsertAgent({ id: 'director', dept: 'hq', role: 'director', title: 'Директор' });
  seedSupport(hq, { supportBudgetUsd: 0 }, () => 'Инструкция головы');
  const posted: { threadId: number; text: string }[] = [];
  const send: TopicSender = (_c, threadId, text) => Promise.resolve(void posted.push({ threadId, text }));
  const reporter = new Reporter(-1001, { support: 5, general: 2 }, new Map([['support', send], ['general', send]]));
  const deps: CheckDeps = {
    now: () => clock.t,
    fetch: ((url: string) => {
      const up = clock.healthy || String(url).includes('omniroute');
      return Promise.resolve(new Response(up ? '{"ok":true}' : 'x', { status: up ? 200 : 502 }));
    }) as unknown as typeof fetch,
    certValidTo: () => Promise.resolve(new Date(clock.t + 60 * DAY_MS).toUTCString()),
    statfs: () => Promise.resolve({ blocks: 100, bavail: 60 }),
    listContainers: () => Promise.resolve([]),
  };
  const llm = new MockLlm(() => '');
  const director = new Director({ hq, llm, messenger, queue, ownerId: OWNER, reporter });
  const head = new SupportHead({ hq, llm, reporter, monitor: new MonitoringWorker({ ...cfg, omnirouteUrl: 'http://omniroute:20128/health' }, deps), finance: new FinanceWorker({ fixedCosts: { droplet: 30 } }),
    billing: new BillingWorker({ paymentDetails: { usdt_trc20: 'TXyz00' } }), messenger, ownerId: OWNER });
  director.onSupportCommand = (name, args) => head.onCommand(name, args);
  return { clock, hq, messenger, posted, director, head };
}

describe('Support head', () => {
  it('seeds the department and two routines once', () => {
    const w = world();
    expect(w.hq.agents('support').map((a) => a.id).sort()).toEqual(['billing', 'customer-support', 'finance', 'monitoring', 'onboarding', 'support-head']);
    expect(w.hq.routines().map((r) => [r.name, r.cron])).toEqual([['support-daily', '40 7 * * *'], ['support-weekly', '0 20 * * 0'], ['support-billing', '30 7 * * *']]);
    seedSupport(w.hq, { supportBudgetUsd: 5 }, () => 'другая');
    expect(w.hq.agent(SUPPORT_HEAD_ID)!.instructions).toBe('Инструкция головы');
    expect(w.hq.routines()).toHaveLength(3);
  });

  it('a task with «мониторинг» and a URL adds it to the monitoring list once', async () => {
    const w = world();
    const t = w.hq.createTask({ title: 'добавить https://rosa.uz в мониторинг', dept: 'support', creator: 'head' });
    await w.head.onHeartbeat();
    expect(w.hq.task(t.id)!.status).toBe('done');
    expect(w.hq.events(t.id).some((e) => e.body.includes('https://rosa.uz добавлен'))).toBe(true);
    const t2 = w.hq.createTask({ title: 'мониторинг https://rosa.uz', dept: 'support', creator: 'head' });
    await w.head.onHeartbeat();
    expect(w.hq.events(t2.id).some((e) => e.body.includes('уже в мониторинге'))).toBe(true);
  });

  it('an outage: one task per day, one alert, one recovery, no task per tick', async () => {
    const w = world();
    const tick = async () => {
      w.clock.t += 5 * 60_000;
      await w.head.monitorTick();
    };
    await tick();
    w.clock.healthy = false;
    await tick();
    expect(w.messenger.sent).toHaveLength(0);
    await tick();
    await tick();
    await tick();
    const alerts = w.messenger.sent.filter((m) => m.text.includes('не в порядке'));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.text).toContain('firtech.pro/api/health');
    w.clock.healthy = true;
    await tick();
    expect(w.messenger.sent.filter((m) => m.text.includes('снова в норме'))).toHaveLength(1);
    const duty = w.hq.tasks({ dept: 'support' });
    expect(duty).toHaveLength(1);
    expect(duty[0]!.title).toBe('Дежурство 18.11');
    expect(w.hq.events(duty[0]!.id).filter((e) => e.kind === 'incident')).toHaveLength(2);
    expect(w.posted.filter((p) => p.threadId === 5)).toHaveLength(2);
    // Next day: the duty task is closed with the uptime line
    w.clock.t += DAY_MS;
    await w.head.monitorTick();
    expect(w.hq.task(duty[0]!.id)).toMatchObject({ status: 'done' });
    expect(w.hq.task(duty[0]!.id)!.result).toContain('аптайм за 24 ч');
  });

  it('quiet hours hold the alert for the morning summary', async () => {
    const w = world();
    w.hq.setSetting('quiet_hours', '23:00-07:00'); // it is 03:00 in Tashkent
    w.clock.healthy = false;
    for (let i = 0; i < 2; i++) {
      w.clock.t += 5 * 60_000;
      await w.head.monitorTick();
    }
    expect(w.messenger.sent).toHaveLength(0);
    expect(w.director.morningSummary()).toContain('Инциденты за ночь');
  });

  it('the daily routine yields one report line with finance and uptime; the weekly one the month report', async () => {
    const w = world();
    w.clock.t += 5 * 60_000;
    await w.head.monitorTick();
    const daily = w.hq.runRoutine('support-daily')!;
    const weekly = w.hq.runRoutine('support-weekly')!;
    await w.head.onHeartbeat();
    expect(w.hq.task(daily.id)).toMatchObject({ status: 'done' });
    expect(w.hq.task(daily.id)!.result).toMatch(/Monitoring: аптайм за 24 ч 100%.*\nФинансы: вчера/s);
    expect(w.hq.task(weekly.id)!.result).toContain('Расходы за месяц на данный момент');
    expect(w.hq.reports(0).map((r) => r.dept)).toEqual(['support', 'support']);
    expect(w.director.morningSummary()).toContain('support:');
  });

  it('a free-text task for another department goes back as not for support', async () => {
    const w = world();
    const t = w.hq.createTask({ title: 'Нарисуй логотип', dept: 'support', creator: 'owner' });
    await w.head.onHeartbeat();
    expect(w.hq.task(t.id)!.status).toBe('blocked');
    const asked = w.hq.createTask({ title: 'Сколько мы потратили в этом месяце?', dept: 'support', creator: 'owner' });
    await w.head.onHeartbeat();
    expect(w.hq.task(asked.id)!.status).toBe('done');
  });

  it('ticket: /ticket drafts a KB answer at level 1 (sent to the owner at once), /tickets lists it', async () => {
    const w = world();
    await w.director.onCommand('client', 'Dilnoza | @dil | бот записи | базовый');
    await w.director.onCommand('ticket', 'Dilnoza: как оплатить подписку?');
    const msgs = w.messenger.sent.map((m) => m.text).join('\n');
    expect(msgs).toContain('Тикет #1');
    expect(msgs).toContain('ответ утверждён, отправьте клиенту @dil');
    expect(msgs).toContain('TRC20');
    await w.director.onCommand('tickets', '');
    expect(w.messenger.sent.at(-1)!.text).toContain('#1 отвечен');
    await w.director.onCommand('ticket', 'без двоеточия');
    expect(w.messenger.sent.at(-1)!.text).toContain('Формат: /ticket');
  });

  it('a cabinet ticket: the answer is stored on the ticket, no hand-off message to the owner without a chat', async () => {
    const w = world();
    const store = new CsStore(w.hq.db, () => w.clock.t);
    const t = store.addCabinetTicket({ clientName: 'Dilnoza', contact: 'dil@example.com', text: 'как оплатить подписку?' });
    const before = w.messenger.sent.length;
    await w.head.cabinetTicket(t.id, 'Dilnoza', 'как оплатить подписку?', '@nobody');
    const after = store.ticket(t.id)!;
    expect(after.status).toBe('answered');
    expect(after.answer).toContain('TRC20');
    expect(after.source).toBe('cabinet');
    expect(w.messenger.sent.slice(before).some((m) => m.text.includes('отправьте клиенту'))).toBe(false);
    expect(store.recent()).toHaveLength(1);
  });

  it('ticket SLA: a money ticket waits at level 0 and becomes one alert after 4 hours', async () => {
    const w = world();
    await w.director.onCommand('ticket', 'Roza: верните деньги за сайт');
    expect(w.hq.queuedApprovals().map((a) => a.kind)).toEqual(['support_money']);
    w.clock.t += 3 * 3600_000;
    expect(await w.head.slaTick()).toEqual([]);
    w.clock.t += 1.1 * 3600_000;
    const alerts = await w.head.slaTick();
    expect(alerts).toHaveLength(1);
    expect(w.messenger.sent.some((m) => m.text.includes('Тикет #1 (Roza) без утверждённого ответа'))).toBe(true);
    expect(await w.head.slaTick()).toEqual([]);
  });

  it('a forwarded task "вопрос клиента Имя: текст" becomes a ticket on the heartbeat', async () => {
    const w = world();
    const t = w.hq.createTask({ title: 'Вопрос клиента', body: 'Roza: где мои заявки?', dept: 'support', creator: 'owner' });
    await w.head.onHeartbeat();
    expect(w.hq.task(t.id)!.status).toBe('done');
    expect(w.messenger.sent.some((m) => m.text.includes('Тикет #1: ответ утверждён'))).toBe(true);
  });

  it('paid new-project invoice: revenue reaches the finance line and onboarding starts (checklist task + guide), check-ins fire via the routine', async () => {
    const w = world();
    await w.director.onCommand('invoice', 'Dilnoza 150 бот записи new');
    expect(w.messenger.sent.at(-1)!.text).toContain('FT-2026-001');
    expect(w.hq.queuedApprovals().map((a) => a.kind)).toEqual(['billing_invoice']);
    await w.director.onCommand('paid', 'FT-2026-001');
    const reply = w.messenger.sent.at(-1)!.text;
    expect(reply).toContain('оплачен');
    expect(reply).toContain('Онбординг: Dilnoza');
    expect(w.hq.tasks({ dept: 'support', status: 'blocked' }).map((t) => t.title)).toContain('Онбординг: Dilnoza');
    expect(w.hq.queuedApprovals().map((a) => a.kind)).toContain('onboarding_guide');
    // revenue shows up in the Finance line
    w.clock.t += 24 * 3600_000; // next morning: yesterday's payment is in the morning line
    const daily = w.hq.runRoutine('support-daily')!;
    await w.head.onHeartbeat();
    expect(w.hq.task(daily.id)!.result).toContain('Выручка (оплаченные счета): вчера $150.00, месяц $150.00');
    // day 1 check-in through the daily billing routine
    w.clock.t += 7 * 3600_000;
    const billing = w.hq.runRoutine('support-billing')!;
    await w.head.onHeartbeat();
    expect(w.hq.task(billing.id)!.result).toContain('Онбординг Dilnoza: День 1');
    expect(w.messenger.sent.some((m) => m.text.includes('Онбординг Dilnoza: День 1'))).toBe(true);
  });
});
