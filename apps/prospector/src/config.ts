import { intEnv, loadBaseConfig, optional, required, type BaseConfig } from '@fir/core';

export interface Config extends BaseConfig {
  /** Cron of the daily batch, evaluated in TZ. */
  batchCron: string;
  /** New prospects per batch. */
  batchSize: number;
  promptsDir: string;
  dbFile: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // The sales department has its own bot: PROSPECTOR_BOT_TOKEN feeds the shared base config.
  const base = loadBaseConfig({ ...env, TELEGRAM_BOT_TOKEN: required(env, 'PROSPECTOR_BOT_TOKEN') });
  return {
    ...base,
    batchCron: optional(env, 'BATCH_CRON') ?? '0 10 * * *',
    batchSize: intEnv(env, 'BATCH_SIZE', 10),
    promptsDir: optional(env, 'PROMPTS_DIR') ?? new URL('../prompts', import.meta.url).pathname,
    dbFile: `${base.dataDir}/prospector.db`,
  };
}
