import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hq } from '@fir/hq';
import type { Config } from './config.js';

const read = (dir: string, file: string): string => readFileSync(join(dir, file), 'utf8').trim();

/**
 * First start: puts the org into the database. Instructions come from `instructions/*.md` once; after that the
 * database copy is the truth (the owner edits it through the Director's rule-change flow, or `hq import`).
 * Routines are created only when missing, so an owner's edit of a cron or title survives restarts.
 */
export function seedOrg(hq: Hq, cfg: Pick<Config, 'instructionsDir' | 'marketingBudgetUsd'>): void {
  hq.ensureAgent({
    id: 'director', dept: 'hq', role: 'director', title: 'Директор', instructions: read(cfg.instructionsDir, 'director.md'),
  });
  hq.ensureAgent({
    id: 'marketing-head', dept: 'marketing', role: 'head', title: 'Голова маркетинга', instructions: read(cfg.instructionsDir, 'marketing-head.md'),
    bossId: 'director', bot: 'MARKETING_BOT_TOKEN', budgetUsdMonth: cfg.marketingBudgetUsd,
  });
  hq.ensureAgent({ id: 'content-maker', dept: 'marketing', role: 'worker', title: 'Контент-мейкер', bossId: 'marketing-head' });
  const routines = [
    { name: 'marketing-weekly-pack', cron: '0 9 * * 1', dept: 'marketing', title: 'Пакет недели: 7 клипов и карусель', meta: { action: 'pack' }, priority: 1 },
    { name: 'marketing-daily-today', cron: '0 9 * * *', dept: 'marketing', title: 'Что публикуем сегодня', meta: { action: 'daily' } },
  ];
  for (const r of routines) if (!hq.routineByName(r.name)) hq.scheduleRoutine(r);
}
