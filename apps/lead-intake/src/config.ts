import { intEnv, loadBaseConfig, optional, type BaseConfig } from '@fir/core';

export interface Config extends BaseConfig {
  /** Shared secret for `POST /lead` (header `x-lead-token`); no token, no webhook server. */
  webhookToken: string | undefined;
  webhookPort: number;
  /** Call slots offered to clients, local times in TZ, e.g. "11:00,15:00". */
  slotHours: [string, string];
  /** Client messages allowed per chat in the window; the rest is ignored. */
  rateLimit: number;
  rateWindowMs: number;
  /** Initial trust level of ordinary replies (questions, holding answers). Prices are always locked at 0. */
  replyLevel: 0 | 1;
  leadsFile: string;
  dbFile: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const base = loadBaseConfig(env);
  const hours = (optional(env, 'SLOT_HOURS') ?? '11:00,15:00').split(',').map((s) => s.trim());
  if (hours.length !== 2 || !hours.every((h) => /^\d{1,2}:\d{2}$/.test(h))) throw new Error('SLOT_HOURS must be "HH:mm,HH:mm"');
  return {
    ...base,
    webhookToken: optional(env, 'LEAD_WEBHOOK_TOKEN'),
    webhookPort: intEnv(env, 'WEBHOOK_PORT', 8787),
    slotHours: [hours[0]!, hours[1]!],
    rateLimit: intEnv(env, 'RATE_LIMIT_MESSAGES', 20),
    rateWindowMs: intEnv(env, 'RATE_LIMIT_WINDOW_MIN', 10) * 60_000,
    replyLevel: intEnv(env, 'REPLY_LEVEL', 1) === 0 ? 0 : 1,
    leadsFile: `${base.dataDir}/leads.jsonl`,
    dbFile: `${base.dataDir}/lead-intake.db`,
  };
}
