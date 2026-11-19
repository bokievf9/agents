import { Cron } from 'croner';
import { loadBaseConfig, optional, required, type BaseConfig } from '@fir/core';
import { loadMonitorConfig, type MonitorConfig } from '@fir/worker-monitoring';
import { parsePaymentDetails, type PaymentDetails } from '@fir/worker-billing';
import { parseFixedCosts } from '@fir/worker-finance';
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
  /** Single posts and story series a week in the weekly pack (defaults 3 and 5). */
  postsPerWeek: number;
  storiesPerWeek: number;
  /** Rendered PNG files of posts, slides, stories and covers: `<DATA_DIR>/renders`. */
  rendersDir: string;
  /** Videos of approved reels are rendered by the `renderer` service (REELS_RENDER=off disables the queue). */
  renderReels: boolean;
  /** Monthly limit of the Marketing department in USD (0: none). Used only when the head is first created. */
  marketingBudgetUsd: number;
  /** Support bot token. Without it the Support head is silent in the group (checks and alerts still work). */
  supportBotToken: string | undefined;
  /** Support: what the monitoring checks, fixed monthly costs by item, department limit (0: none). */
  monitor: MonitorConfig;
  fixedCostsUsdMonth: Record<string, number>;
  supportBudgetUsd: number;
  /** Hours until a client ticket without an approved answer becomes an alert. */
  supportSlaHours: number;
  /** Invoice number prefix (`FT` gives FT-2026-001) and the payment details printed in invoices. */
  invoicePrefix: string;
  paymentDetails: PaymentDetails;
  /** Sales bot token (@firtech_leads_bot). Without it the Sales head is silent (no group posts). */
  salesBotToken: string | undefined;
  /** Shared secret of `POST /lead` (header `x-lead-token`); without it the webhook server does not start. */
  leadWebhookToken: string | undefined;
  webhookPort: number;
  /** Secret of `POST /chat` (header `x-chat-token`); falls back to `LEAD_WEBHOOK_TOKEN`. */
  webChatToken: string | undefined;
  /** Shared secret of `GET /office` (header `x-office-token`); without it the route answers 404. */
  officeToken: string | undefined;
  /** Secret of `/admin/*` (header `x-admin-token`); falls back to `OFFICE_TOKEN`. Without both the admin API is off. */
  adminToken: string | undefined;
  /** The site counts as gone after this many minutes without a ping: notifications go back to Telegram. */
  presenceAwayAfterMin: number;
  /** New Scout cards per day. */
  batchSize: number;
  /** Call slots offered to leads, local times in the HQ timezone. */
  slotHours: [string, string];
  /** Initial trust level of the first reply to a lead (prices are locked at 0 anyway). */
  replyLevel: 0 | 1;
  /** Monthly limit of the Sales department in USD (0: none). Used only when the head is first created. */
  salesBudgetUsd: number;
  /** Reward for a referral after the referred client pays; prepayment share (%) and validity (days) of a КП. */
  referralReward: string;
  prepaymentPercent: number;
  kpValidDays: number;
  /** Production and Back Office bot tokens: without them the heads are silent in the group. */
  productionBotToken: string | undefined;
  backofficeBotToken: string | undefined;
  /** Monthly limits of the two departments in USD (0: none). Used only when the head is first created. */
  productionBudgetUsd: number;
  backofficeBudgetUsd: number;
  /** Folder of the repo `knowledge/` (playbook titles for `/kb`); without it `/kb` searches lessons only. */
  knowledgeDir: string | undefined;
  /** Optional Marketing sources; each is off without its key. */
  youtubeApiKey: string | undefined;
  youtubeChannelId: string | undefined;
  trendsRegions: string[];
  gscServiceAccountJson: string | undefined;
  gscSiteUrl: string | undefined;
  siteUrl: string;
  /** Builder bridge: fine-grained token (Issues read/write on `githubRepo`). Without it the bridge is off. */
  githubToken: string | undefined;
  githubRepo: string;
  builderPollMinutes: number;
  /** Public client bot (@firtech_bot). Without the token the bot does not start and leads come only from the site. */
  clientBotToken: string | undefined;
  /** Quiet hours of the client bot in the HQ timezone: templates only, no LLM. */
  clientQuietHours: string;
  /** Client messages per chat per hour, and LLM answers per day for all chats. */
  clientRatePerHour: number;
  clientLlmDailyCap: number;
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
  const hours = (optional(env, 'SLOT_HOURS') ?? '11:00,15:00').split(',').map((h) => h.trim());
  if (hours.length !== 2 || !hours.every((h) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(h))) throw new Error('SLOT_HOURS must be "HH:mm,HH:mm"');
  return {
    ...base,
    dbFile: `${base.dataDir}/hq.db`,
    instructionsDir: optional(env, 'INSTRUCTIONS_DIR') ?? new URL('../instructions', import.meta.url).pathname,
    marketingBotToken: optional(env, 'MARKETING_BOT_TOKEN'),
    groupId,
    topics,
    clipsPerWeek: Math.round(num(env, 'CLIPS_PER_WEEK', 7, 1, 7)),
    carouselsPerWeek: num(env, 'CAROUSELS_PER_WEEK', 2, 0, 7),
    postsPerWeek: Math.round(num(env, 'POSTS_PER_WEEK', 3, 0, 7)),
    storiesPerWeek: Math.round(num(env, 'STORIES_PER_WEEK', 5, 0, 7)),
    rendersDir: `${base.dataDir}/renders`,
    renderReels: (env.REELS_RENDER ?? 'on').toLowerCase() !== 'off',
    marketingBudgetUsd: num(env, 'MARKETING_BUDGET_USD', 0, 0, 100_000),
    supportBotToken: optional(env, 'SUPPORT_BOT_TOKEN'),
    monitor: loadMonitorConfig(env, base.dataDir),
    fixedCostsUsdMonth: parseFixedCosts(optional(env, 'FIXED_COSTS_USD_MONTH')),
    supportBudgetUsd: num(env, 'SUPPORT_BUDGET_USD', 0, 0, 100_000),
    supportSlaHours: num(env, 'SUPPORT_SLA_HOURS', 4, 0.25, 168),
    invoicePrefix: (optional(env, 'INVOICE_PREFIX') ?? 'FT').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'FT',
    paymentDetails: parsePaymentDetails(optional(env, 'PAYMENT_DETAILS_JSON')),
    salesBotToken: optional(env, 'SALES_BOT_TOKEN'),
    leadWebhookToken: optional(env, 'LEAD_WEBHOOK_TOKEN'),
    officeToken: optional(env, 'OFFICE_TOKEN'),
    adminToken: optional(env, 'ADMIN_TOKEN') ?? optional(env, 'OFFICE_TOKEN'),
    presenceAwayAfterMin: num(env, 'PRESENCE_AWAY_AFTER_MIN', 20, 1, 1440),
    webChatToken: optional(env, 'WEB_CHAT_TOKEN') ?? optional(env, 'LEAD_WEBHOOK_TOKEN'),
    webhookPort: Math.round(num(env, 'WEBHOOK_PORT', 8787, 1, 65_535)),
    batchSize: Math.round(num(env, 'BATCH_SIZE', 10, 1, 100)),
    slotHours: [hours[0]!, hours[1]!],
    replyLevel: num(env, 'REPLY_LEVEL', 1, 0, 1) === 0 ? 0 : 1,
    salesBudgetUsd: num(env, 'SALES_BUDGET_USD', 0, 0, 100_000),
    referralReward: optional(env, 'REFERRAL_REWARD') ?? 'месяц сопровождения бесплатно',
    prepaymentPercent: Math.round(num(env, 'PREPAYMENT_PERCENT', 50, 1, 100)),
    kpValidDays: Math.round(num(env, 'KP_VALID_DAYS', 14, 1, 90)),
    productionBotToken: optional(env, 'PRODUCTION_BOT_TOKEN'),
    backofficeBotToken: optional(env, 'BACKOFFICE_BOT_TOKEN'),
    productionBudgetUsd: num(env, 'PRODUCTION_BUDGET_USD', 0, 0, 100_000),
    backofficeBudgetUsd: num(env, 'BACKOFFICE_BUDGET_USD', 0, 0, 100_000),
    knowledgeDir: optional(env, 'KNOWLEDGE_DIR'),
    youtubeApiKey: optional(env, 'YOUTUBE_API_KEY'),
    youtubeChannelId: optional(env, 'YOUTUBE_CHANNEL_ID'),
    trendsRegions: (optional(env, 'TRENDS_REGIONS') ?? 'KZ,UZ,RU').split(',').map((r) => r.trim().toUpperCase()).filter((r) => /^[A-Z]{2}$/.test(r)),
    gscServiceAccountJson: optional(env, 'GSC_SERVICE_ACCOUNT_JSON'),
    gscSiteUrl: optional(env, 'GSC_SITE_URL'),
    githubToken: optional(env, 'GITHUB_TOKEN'),
    githubRepo: optional(env, 'GITHUB_REPO') ?? 'bokievf9/agents',
    builderPollMinutes: Math.round(num(env, 'BUILDER_POLL_MINUTES', 10, 1, 59)),
    clientBotToken: optional(env, 'CLIENT_BOT_TOKEN'),
    clientQuietHours: quietWindow(optional(env, 'CLIENT_QUIET_HOURS') ?? '22:00-08:00'),
    clientRatePerHour: Math.round(num(env, 'CLIENT_RATE_PER_HOUR', 20, 1, 1000)),
    clientLlmDailyCap: Math.round(num(env, 'CLIENT_LLM_DAILY_CAP', 300, 0, 100_000)),
    siteUrl: (optional(env, 'SITE_URL') ?? 'https://firtech.pro').replace(/\/$/, ''),
  };
}

/** "HH:mm-HH:mm" (or empty: never quiet), validated. */
function quietWindow(v: string): string {
  const t = v.trim();
  if (t && !/^([01]?\d|2[0-3]):[0-5]\d-([01]?\d|2[0-3]):[0-5]\d$/.test(t)) throw new Error('CLIENT_QUIET_HOURS must be "HH:mm-HH:mm", e.g. 22:00-08:00');
  return t;
}

/** "HH:MM" to a daily cron pattern, validated. */
export function dailyCron(time: string): string {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!m) throw new Error(`Bad time "${time}", expected HH:MM`);
  const pattern = `${Number(m[2])} ${Number(m[1])} * * *`;
  new Cron(pattern, { paused: true });
  return pattern;
}
