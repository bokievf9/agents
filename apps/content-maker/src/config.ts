import { Cron } from 'croner';
import { loadBaseConfig, optional, required, type BaseConfig } from '@fir/core';

export interface Config extends BaseConfig {
  dbFile: string;
  promptsDir: string;
  /** Cron pattern of the weekly pack, in TZ. Default: Monday 09:00. */
  packCron: string;
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
  };
}
