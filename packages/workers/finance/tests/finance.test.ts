import { openDb } from '@fir/core';
import { Hq, type Task, type WorkerCtx } from '@fir/hq';
import { MockLlm } from '@fir/core';
import { describe, expect, it } from 'vitest';
import { FinanceWorker, aggregate, dailyLine, monthlyReport, parseFixedCosts, tokens } from '../src/index.js';

// Sunday 2026-11-22 20:00 Tashkent (UTC+5) = 15:00 UTC
const NOW = Date.UTC(2026, 10, 22, 15, 0);
const TZ = 'Asia/Tashkent';
const local = (d: number, h = 12) => Date.UTC(2026, 10, d, h - 5, 0);

function setup() {
  const db = openDb(':memory:');
  const hq = new Hq(db, { now: () => NOW });
  hq.upsertAgent({ id: 'director', dept: 'hq', role: 'director', title: 'Д' });
  hq.upsertAgent({ id: 'marketing-head', dept: 'marketing', role: 'head', title: 'М', budgetUsdMonth: 10 });
  hq.upsertAgent({ id: 'content-maker', dept: 'marketing', role: 'worker', title: 'К' });
  hq.upsertAgent({ id: 'support-head', dept: 'support', role: 'head', title: 'С' });
  const put = (agent: string, at: number, usd: number, i: number, o: number) => {
    const dept = agent === 'support-head' ? 'support' : 'marketing';
    db.prepare('INSERT INTO costs (agent_id, dept, model, input_tokens, output_tokens, usd, at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(agent, dept, 'm', i, o, usd, at);
  };
  // Nov 21 (Sat, yesterday), Nov 18 (Wed, this week), Nov 5 (earlier this month), Oct 30 (last month, excluded)
  put('content-maker', local(21), 1.5, 1000, 500);
  put('content-maker', local(21, 14), 0.5, 2000, 0);
  put('support-head', local(18), 0.25, 400, 100);
  put('content-maker', local(5), 3, 10_000, 5_000);
  put('content-maker', Date.UTC(2026, 9, 30, 12), 99, 1, 1);
  return { db, hq };
}

describe('aggregation', () => {
  const fixed = { droplet: 24, backups: 6 }; // 30 per month, November has 30 days: $1 a day

  it('sums yesterday, week and month per department and agent (Sunday report counts today)', () => {
    const { db } = setup();
    const r = aggregate(db, { now: NOW, tz: TZ, fixed, includeToday: true });
    expect(r.yesterday).toMatchObject({ usd: 2, inputTokens: 3000, outputTokens: 500, calls: 2, fixedUsd: 1 });
    expect(r.week.usd).toBeCloseTo(2.25); // Mon 16 .. Sun 22: 1.5 + .5 + .25
    expect(r.week.fixedUsd).toBeCloseTo(7); // 7 days
    expect(r.month.usd).toBeCloseTo(5.25);
    expect(r.month.fixedUsd).toBeCloseTo(22); // 22 days of November
    expect(r.month.byDept.map((d) => [d.dept, +d.usd.toFixed(2)])).toEqual([['marketing', 5], ['support', 0.25]]);
    expect(r.month.byAgent[0]).toMatchObject({ agentId: 'content-maker', usd: 5 });
    expect(r.budgets).toEqual({ marketing: 10 });
    expect(r.daysInMonth).toBe(30);
  });

  it('the morning line stops at the end of yesterday', () => {
    const { db } = setup();
    const r = aggregate(db, { now: NOW, tz: TZ, fixed });
    expect(r.month.fixedUsd).toBeCloseTo(21);
    expect(r.week.fixedUsd).toBeCloseTo(6);
  });

  it('a week that starts in the previous month prorates only this month days', () => {
    const { db } = setup();
    // Wed 2026-12-02 12:00: week began Mon Nov 30, December has 31 days; only 2 days (1st, 2nd) are in December
    const r = aggregate(db, { now: Date.UTC(2026, 11, 2, 7), tz: TZ, fixed: { x: 31 }, includeToday: true });
    expect(r.week.fixedUsd).toBeCloseTo(2);
    expect(r.month.fixedUsd).toBeCloseTo(2);
  });

  it('formats the lines', () => {
    const { db } = setup();
    const r = aggregate(db, { now: NOW, tz: TZ, fixed, includeToday: true });
    expect(dailyLine(r)).toContain('вчера $3.00 (API $2.00, серверы $1.00, токенов 4k)');
    const m = monthlyReport(r);
    expect(m).toContain('(22 из 30 дн.)');
    expect(m).toContain('marketing: $5.00');
    expect(m).toContain('лимит $10.00 (50%)');
    expect(m).toContain('Прогноз на весь месяц: $');
    expect(tokens(1_500_000)).toBe('1.5M');
  });

  it('parses fixed costs and rejects garbage', () => {
    expect(parseFixedCosts('{"droplet":24,"backups":4.8}')).toEqual({ droplet: 24, backups: 4.8 });
    expect(parseFixedCosts(undefined)).toEqual({});
    expect(() => parseFixedCosts('{"a":-1}')).toThrow();
    expect(() => parseFixedCosts('x')).toThrow();
  });

  it('the worker runs daily by default and weekly on request', async () => {
    const { db } = setup();
    const w = new FinanceWorker({ fixedCosts: fixed });
    const logs: string[] = [];
    const ctx: WorkerCtx = { llm: new MockLlm(() => ''), db, tz: TZ, now: () => NOW, requestApproval: () => Promise.resolve(0), log: (a) => void logs.push(a) };
    const task = (meta: Record<string, unknown>) => ({ meta }) as unknown as Task;
    expect((await w.run(task({}), ctx)).result).toContain('Финансы:');
    expect((await w.run(task({ action: 'weekly' }), ctx)).result).toContain('Расходы за месяц');
    expect(logs).toEqual(['finance_daily', 'finance_weekly']);
  });

  it('reads paid revenue from billing invoices when the table exists, 0 and no line when not', () => {
    const { db } = setup();
    expect(aggregate(db, { now: NOW, tz: TZ, fixed }).revenue).toEqual({ yesterday: 0, month: 0 });
    expect(dailyLine(aggregate(db, { now: NOW, tz: TZ, fixed }))).not.toContain('Выручка');
    db.exec("CREATE TABLE bl_invoices (id INTEGER PRIMARY KEY, amount_usd REAL, status TEXT, paid_at INTEGER)");
    const ins = db.prepare('INSERT INTO bl_invoices (amount_usd, status, paid_at) VALUES (?, ?, ?)');
    ins.run(100, 'paid', NOW - 36 * 3600_000); // earlier this month
    ins.run(40, 'paid', NOW - 20 * 3600_000); // yesterday
    ins.run(999, 'issued', null);
    const r = aggregate(db, { now: NOW, tz: TZ, fixed, includeToday: true });
    expect(r.revenue.month).toBe(140);
    expect(dailyLine(r)).toContain('Выручка (оплаченные счета)');
  });
});
