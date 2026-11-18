import { OffLlm, openDb, type LlmClient, type Payload } from '@fir/core';
import type { Task, WorkerCtx } from '@fir/hq';
import { LeadIntakeWorker, type Delivery } from '../src/worker.js';

export const NOW = Date.UTC(2026, 10, 18, 7, 0); // Wed 12:00 in Tashkent

export interface Staged {
  kind: string;
  payload: Payload;
  summary: string;
}

export const webLead = (over: Record<string, unknown> = {}) => ({
  name: 'Dilnoza', contact: '@dilnoza', service: 'bots', message: 'Нужен бот для салона, срочно', locale: 'ru', ...over,
});

export function setup(opts: { llm?: LlmClient; replyLevel?: 0 | 1 } = {}) {
  const db = openDb(':memory:');
  const staged: Staged[] = [];
  const clock = { t: NOW };
  const llm = opts.llm ?? new OffLlm();
  const ctx: WorkerCtx = {
    llm, db, tz: 'Asia/Tashkent', now: () => clock.t,
    requestApproval: (kind, payload, summary) => Promise.resolve(staged.push({ kind, payload, summary }) - 1),
    log: () => undefined,
  };
  const worker = new LeadIntakeWorker({ ...(opts.replyLevel !== undefined ? { replyLevel: opts.replyLevel } : {}) });
  const delivered: Delivery[] = [];
  const specs = worker.kindSpecs(ctx, (d) => Promise.resolve(void delivered.push(d)));
  let n = 0;
  const task = (lead: Record<string, unknown> = webLead(), meta: Record<string, unknown> = {}): Task => ({
    id: ++n, title: 'Лид', body: '', dept: 'sales', assigneeId: 'lead-intake', creator: 'routine', parentId: null, status: 'running', priority: 0,
    dueAt: null, result: null, costUsd: 0, meta: { action: 'lead', lead, ...meta }, tags: [], routineId: null, createdAt: 0, updatedAt: 0,
  });
  return { db, ctx, worker, staged, delivered, specs, clock, task, run: (t: Task) => worker.run(t, ctx) };
}
