import { ApprovalQueue, MemoryMessenger, openDb } from '@fir/core';
import { Hq } from '../src/index.js';

export const OWNER = 100;
// Wed 2026-11-18 12:00 in Tashkent (UTC+5): 07:00 UTC
export const NOW = Date.UTC(2026, 10, 18, 7, 0);

export function setup() {
  const clock = { t: NOW };
  const db = openDb(':memory:');
  const messenger = new MemoryMessenger();
  const hq = new Hq(db, { now: () => clock.t });
  const queue = new ApprovalQueue(db, messenger, OWNER, 20, () => clock.t);
  hq.attachQueue(queue);
  hq.upsertAgent({ id: 'director', dept: 'hq', role: 'director', title: 'Директор' });
  hq.upsertAgent({ id: 'marketing-head', dept: 'marketing', role: 'head', title: 'Голова маркетинга', bossId: 'director', budgetUsdMonth: 0 });
  hq.upsertAgent({ id: 'content-maker', dept: 'marketing', role: 'worker', title: 'Контент-мейкер', bossId: 'marketing-head' });
  hq.upsertAgent({ id: 'sales-head', dept: 'sales', role: 'head', title: 'Голова продаж', bossId: 'director' });
  return { hq, db, queue, messenger, clock };
}
