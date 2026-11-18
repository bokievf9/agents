import { Cron } from 'croner';
import { loadBaseConfig, optional, required, type BaseConfig } from '@fir/core';
import { z } from 'zod';

export interface Config extends BaseConfig {
  dbFile: string;
  instructionsDir: string;
  /** Marketing bot token. Without it the Marketing head is silent (no group posts). */
  marketingBotToken: string | undefined;
  /** Telegram group of the HQ (with topics) and the topic ids by key: general, approvals, or a department id. */
  groupId: number | undefined;
  topics: Record<string, number>;
  clipsPerWeek: number;
  carouselsPerWeek: number;
  /** Monthly limit of the Marketing department in USD (0: none). Used only when the head is first created. */
  marketingBudgetUsd: number;
  /** Optional Marketing sources; each is off without its key. */
  youtubeApiKey: string | undefined;
  youtubeChannelId: string | undefined;
  trendsRegions: string[];
  gscServiceAccountJson: string | undefined;
  gscSiteUrl: string | undefined;
  siteUrl: string;
}

function num(env: NodeJS.ProcessEnv, key: string, def: number, min: number, max: number): number {
  const raw = optional(env, key);
  if (raw === undefined) return def;
  const n = Number(raw.replace(',', '.'));
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${key} must be a number from ${min} to ${max}`);
  return n;
}

const topicsSchema = z.record(z.string(), z.number().int().positive());

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // The Director's own bot: HQ_BOT_TOKEN feeds the shared base config.
  const base = loadBaseConfig({ ...env, TELEGRAM_BOT_TOKEN: required(env, 'HQ_BOT_TOKEN') });
  const groupRaw = optional(env, 'HQ_GROUP_ID');
  const groupId = groupRaw === undefined ? undefined : Number(groupRaw);
  if (groupId !== undefined && !Number.isSafeInteger(groupId)) throw new Error('HQ_GROUP_ID must be a number');
  let topics: Record<string, number> = {};
  const topicsRaw = optional(env, 'HQ_TOPICS');
  if (topicsRaw !== undefined) {
    try {
      topics = topicsSchema.parse(JSON.parse(topicsRaw));
    } catch {
      throw new Error('HQ_TOPICS must be JSON like {"general":2,"marketing":3}');
    }
  }
  return {
    ...base,
    dbFile: `${base.dataDir}/hq.db`,
    instructionsDir: optional(env, 'INSTRUCTIONS_DIR') ?? new URL('../instructions', import.meta.url).pathname,
    marketingBotToken: optional(env, 'MARKETING_BOT_TOKEN'),
    groupId,
    topics,
    clipsPerWeek: Math.round(num(env, 'CLIPS_PER_WEEK', 7, 1, 7)),
    carouselsPerWeek: num(env, 'CAROUSELS_PER_WEEK', 0.5, 0, 1),
    marketingBudgetUsd: num(env, 'MARKETING_BUDGET_USD', 0, 0, 100_000),
    youtubeApiKey: optional(env, 'YOUTUBE_API_KEY'),
    youtubeChannelId: optional(env, 'YOUTUBE_CHANNEL_ID'),
    trendsRegions: (optional(env, 'TRENDS_REGIONS') ?? 'KZ,UZ,RU').split(',').map((r) => r.trim().toUpperCase()).filter((r) => /^[A-Z]{2}$/.test(r)),
    gscServiceAccountJson: optional(env, 'GSC_SERVICE_ACCOUNT_JSON'),
    gscSiteUrl: optional(env, 'GSC_SITE_URL'),
    siteUrl: (optional(env, 'SITE_URL') ?? 'https://firtech.pro').replace(/\/$/, ''),
  };
}

/** "HH:MM" to a daily cron pattern, validated. */
export function dailyCron(time: string): string {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!m) throw new Error(`Bad time "${time}", expected HH:MM`);
  const pattern = `${Number(m[2])} ${Number(m[1])} * * *`;
  new Cron(pattern, { paused: true });
  return pattern;
}
