import { intEnv, loadBaseConfig, optional, required, type BaseConfig } from '@fir/core';

export interface Config extends BaseConfig {
  contentDir: string;
  dbFile: string;
  /** Default lesson time ("HH:mm", local time in TZ) until the owner sets one with /time. */
  lessonTime: string;
  /** Sunday time of the weekly report ("HH:mm", local). */
  weeklyAt: string;
  /** Cards in one review session (about ten minutes). */
  reviewLimit: number;
}

const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Polly has its own bot: POLLY_BOT_TOKEN feeds the shared base config (it reads TELEGRAM_BOT_TOKEN).
  const base = loadBaseConfig({ ...env, TELEGRAM_BOT_TOKEN: required(env, 'POLLY_BOT_TOKEN') });
  const lessonTime = optional(env, 'LESSON_TIME') ?? '19:00';
  const weeklyAt = optional(env, 'WEEKLY_REPORT_AT') ?? '19:00';
  if (!HHMM.test(lessonTime) || !HHMM.test(weeklyAt)) throw new Error('LESSON_TIME and WEEKLY_REPORT_AT must be "HH:mm"');
  return {
    ...base,
    contentDir: optional(env, 'CONTENT_DIR') ?? new URL('../content', import.meta.url).pathname,
    dbFile: `${base.dataDir}/polly.db`,
    lessonTime,
    weeklyAt,
    reviewLimit: intEnv(env, 'REVIEW_LIMIT', 15),
  };
}

export const isHHMM = (s: string): boolean => HHMM.test(s);
