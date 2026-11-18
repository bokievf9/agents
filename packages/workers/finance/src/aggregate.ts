import { zonedParts, zonedToMs, type Db } from '@fir/core';
import { z } from 'zod';

export interface Totals {
  usd: number;
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

export interface PeriodCosts extends Totals {
  /** Fixed costs (servers, backups) prorated for the days of the period. */
  fixedUsd: number;
  byDept: ({ dept: string } & Totals)[];
  byAgent: ({ dept: string; agentId: string } & Totals)[];
}

export interface FinanceReport {
  yesterday: PeriodCosts;
  week: PeriodCosts;
  month: PeriodCosts;
  /** Local date parts of `now`. */
  day: number;
  month1: number;
  daysInMonth: number;
  /** Days of the month counted in `month` (through yesterday, or through today with `includeToday`). */
  monthDays: number;
  fixedMonthTotal: number;
  fixed: Record<string, number>;
  /** Department monthly limits (head's budget) where set. */
  budgets: Record<string, number>;
  /** Paid revenue in USD from Billing's `bl_invoices` (0 when Billing has no table or no payments). */
  revenue: { yesterday: number; month: number };
}

const fixedSchema = z.record(z.string(), z.number().min(0));

/** `{"droplet":24,"backups":4.8}`: USD per month by item. Empty or missing is no fixed costs; garbage is an error. */
export function parseFixedCosts(raw: string | undefined): Record<string, number> {
  if (!raw?.trim()) return {};
  try {
    return fixedSchema.parse(JSON.parse(raw));
  } catch {
    throw new Error('FIXED_COSTS_USD_MONTH must be JSON like {"droplet":24,"backups":4.8}');
  }
}

const sum = (xs: Iterable<number>): number => {
  let s = 0;
  for (const x of xs) s += x;
  return s;
};
const empty = (): Totals => ({ usd: 0, inputTokens: 0, outputTokens: 0, calls: 0 });
const add = (a: Totals, b: Totals): void => {
  a.usd += b.usd;
  a.inputTokens += b.inputTokens;
  a.outputTokens += b.outputTokens;
  a.calls += b.calls;
};

/** API spend from `costs` for [from, to), per department and agent. */
export function period(db: Db, from: number, to: number, fixedUsd: number): PeriodCosts {
  const rows = db
    .prepare(
      `SELECT dept, agent_id, SUM(usd) usd, SUM(input_tokens) i, SUM(output_tokens) o, COUNT(*) n
       FROM costs WHERE at >= ? AND at < ? GROUP BY dept, agent_id ORDER BY dept, agent_id`,
    )
    .all(from, to) as { dept: string; agent_id: string; usd: number; i: number; o: number; n: number }[];
  const total = empty();
  const depts = new Map<string, Totals>();
  const byAgent = rows.map((r) => {
    const t: Totals = { usd: r.usd, inputTokens: r.i, outputTokens: r.o, calls: r.n };
    add(total, t);
    add(depts.get(r.dept) ?? depts.set(r.dept, empty()).get(r.dept)!, t);
    return { dept: r.dept, agentId: r.agent_id, ...t };
  });
  return { ...total, fixedUsd, byDept: [...depts].map(([dept, t]) => ({ dept, ...t })).sort((a, b) => b.usd - a.usd), byAgent: byAgent.sort((a, b) => b.usd - a.usd) };
}

/**
 * Paid revenue (USD) for payments in [from, to), read from Billing's `bl_invoices`. Finance does not import the
 * Billing worker: it only reads the table, and returns 0 while the table does not exist.
 */
export function revenue(db: Db, from: number, to: number): number {
  const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'bl_invoices'").get();
  if (!has) return 0;
  return (db.prepare("SELECT COALESCE(SUM(amount_usd), 0) s FROM bl_invoices WHERE status = 'paid' AND paid_at >= ? AND paid_at < ?").get(from, to) as { s: number }).s;
}

/**
 * Costs for yesterday, this calendar week (from Monday) and this month, all in the HQ timezone. Fixed costs are
 * prorated per day at the current month's rate (monthly total / days in month). By default the week and the month
 * run through the end of yesterday (the morning line); `includeToday` runs them through `now` (the Sunday report).
 */
export function aggregate(db: Db, o: { now: number; tz: string; fixed: Record<string, number>; includeToday?: boolean }): FinanceReport {
  const p = zonedParts(o.now, o.tz);
  const dim = new Date(Date.UTC(p.y, p.mo, 0)).getUTCDate();
  const todayStart = zonedToMs(p.y, p.mo, p.d, 0, 0, o.tz);
  const yStart = zonedToMs(p.y, p.mo, p.d - 1, 0, 0, o.tz);
  const weekOffset = (p.dow + 6) % 7; // days since Monday
  const weekStart = zonedToMs(p.y, p.mo, p.d - weekOffset, 0, 0, o.tz);
  const monthStart = zonedToMs(p.y, p.mo, 1, 0, 0, o.tz);
  const end = o.includeToday ? o.now : todayStart;
  const extra = o.includeToday ? 1 : 0;
  const fixedTotal = sum(Object.values(o.fixed));
  const daily = fixedTotal / dim;
  const monthDays = p.d - 1 + extra;
  // The week can start in the previous month: only this month's days are prorated at this month's rate.
  const weekDays = Math.min(weekOffset + extra, monthDays);
  const budgets = Object.fromEntries(
    (db.prepare("SELECT dept, budget_usd_month b FROM agents WHERE role = 'head' AND budget_usd_month > 0").all() as { dept: string; b: number }[]).map((r) => [r.dept, r.b] as const),
  );
  return {
    yesterday: period(db, yStart, todayStart, daily),
    week: period(db, weekStart, end, daily * weekDays),
    month: period(db, monthStart, end, daily * monthDays),
    day: p.d,
    month1: p.mo,
    daysInMonth: dim,
    monthDays,
    fixedMonthTotal: fixedTotal,
    fixed: o.fixed,
    budgets,
    revenue: { yesterday: revenue(db, yStart, todayStart), month: revenue(db, monthStart, end) },
  };
}
