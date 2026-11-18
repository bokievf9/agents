import { Cron } from 'croner';
import { loadBaseConfig, optional, required, type BaseConfig } from '@fir/core';

export interface Config extends BaseConfig {
  dbFile: string;
  promptsDir: string;
  /** Cron pattern of the weekly pack, in TZ. Default: Monday 09:00. */
  packCron: string;
  /** Clip scripts in a weekly pack, 1-7, one per day. Default 7. */
  clipsPerWeek: number;
  /** Carousels per week, 0-1 (0.5 = every other week). Default 0.5. */
  carouselsPerWeek: number;
}

function num(env: NodeJS.ProcessEnv, key: string, def: number, min: number, max: number): number {
  const raw = optional(env, key);
  if (raw === undefined) return def;
  const n = Number(raw.replace(',', '.'));
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${key} must be a number from ${min} to ${max}`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // The marketing department has its own bot: CONTENT_BOT_TOKEN feeds the shared base config.
  const base = loadBaseConfig({ ...env, TELEGRAM_BOT_TOKEN: required(env, 'CONTENT_BOT_TOKEN') });
  const packCron = optional(env, 'PACK_CRON') ?? '0 9 * * 1';
  try {
    new Cron(packCron, { timezone: base.tz, paused: true });
  } catch {
    throw new Error('PACK_CRON is not a valid cron pattern');
  }
  return {
    ...base,
    dbFile: `${base.dataDir}/content-maker.db`,
    promptsDir: optional(env, 'PROMPTS_DIR') ?? new URL('../prompts', import.meta.url).pathname,
    packCron,
    clipsPerWeek: Math.round(num(env, 'CLIPS_PER_WEEK', 7, 1, 7)),
    carouselsPerWeek: num(env, 'CAROUSELS_PER_WEEK', 0.5, 0, 1),
  };
}
