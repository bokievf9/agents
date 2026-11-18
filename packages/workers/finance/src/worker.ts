import { zonedParts } from '@fir/core';
import type { SubtaskSpec, Task, Worker, WorkerCtx, WorkerResult } from '@fir/hq';
import { aggregate } from './aggregate.js';
import { dailyLine, monthlyReport } from './report.js';

export const WORKER_ID = 'finance';

export interface FinanceOptions {
  /** Fixed costs, USD per month by item (env FIXED_COSTS_USD_MONTH). */
  fixedCosts?: Record<string, number>;
}

/**
 * The financier: reads `costs`, adds fixed server costs, writes the daily line and the Sunday month-to-date report.
 * No LLM, no outside calls: only arithmetic over the company's own ledger. `meta.action` is `daily` (default) or `weekly`.
 */
export class FinanceWorker implements Worker {
  readonly id = WORKER_ID;
  constructor(private readonly o: FinanceOptions = {}) {}

  async plan(): Promise<SubtaskSpec[] | null> {
    return null;
  }

  async run(task: Task, ctx: WorkerCtx): Promise<WorkerResult> {
    const weekly = task.meta.action === 'weekly';
    const r = aggregate(ctx.db, { now: ctx.now(), tz: ctx.tz, fixed: this.o.fixedCosts ?? {}, includeToday: weekly });
    ctx.log(weekly ? 'finance_weekly' : 'finance_daily', `${zonedParts(ctx.now(), ctx.tz).d}`);
    return { ok: true, result: weekly ? monthlyReport(r) : dailyLine(r) };
  }
}
