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
  hq.ensureAgent({ id: 'trend-scout', dept: 'marketing', role: 'worker', title: 'Трендвотчер', bossId: 'marketing-head' });
  hq.ensureAgent({ id: 'publisher', dept: 'marketing', role: 'worker', title: 'Публикатор', bossId: 'marketing-head' });
  hq.ensureAgent({ id: 'seo', dept: 'marketing', role: 'worker', title: 'SEO', bossId: 'marketing-head' });
  hq.ensureAgent({ id: 'analyst', dept: 'marketing', role: 'worker', title: 'Аналитик', bossId: 'marketing-head' });
  const routines = [
    { name: 'marketing-weekly-pack', cron: '0 9 * * 1', dept: 'marketing', title: 'Пакет недели: рилсы, посты, карусели и истории', meta: { action: 'pack' }, priority: 1 },
    { name: 'marketing-daily-today', cron: '0 9 * * *', dept: 'marketing', title: 'Что публикуем сегодня', meta: { action: 'daily' } },
    { name: 'marketing-trends-daily', cron: '30 8 * * *', dept: 'marketing', title: 'Хуки и форматы дня', meta: { action: 'trends' } },
    { name: 'marketing-trends-weekly', cron: '0 20 * * 0', dept: 'marketing', title: 'Тренды ниши за неделю', meta: { action: 'trends_weekly' } },
    { name: 'marketing-analyst-weekly', cron: '0 8 * * 1', dept: 'marketing', title: 'Недельный отчёт маркетинга', meta: { action: 'report' } },
    { name: 'marketing-article-weekly', cron: '0 10 * * 2', dept: 'marketing', title: 'Статья в блог сайта (ниша без статьи)', meta: { action: 'article' } },
    { name: 'marketing-seo-weekly', cron: '0 11 * * 1', dept: 'marketing', title: 'SEO и AI-SEO проверка сайта', meta: { action: 'seo' } },
  ];
  hq.syncRoutines('marketing', routines);
}
