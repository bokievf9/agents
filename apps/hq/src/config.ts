import { Cron } from 'croner';
import { DEFAULT_PRICES_URL, loadBaseConfig, optional, required, type BaseConfig } from '@fir/core';
import { loadMonitorConfig, type MonitorConfig } from '@fir/worker-monitoring';
import { parsePaymentDetails, parseTolerance, type PaymentDetails } from '@fir/worker-billing';
import { parseFixedCosts } from '@fir/worker-finance';
import { z } from 'zod';

export interface Config extends BaseConfig {
  dbFile: string;
  instructionsDir: string;
  /**
   * Department bot tokens that are still set in the env (owner 2026-11-22: «в Telegram один бот, сам HQ»). They are ignored: one log line, no polling,
   * no posts. Names only, never the values.
   */
  retiredBots: string[];
  /** `TG_APPROVAL_CARDS=on`: approval cards with buttons in Telegram again (off by default: decisions only in the review center). */
  tgApprovalCards: boolean;
  /** `TG_RUNNER=off` stops the clients' Telegram bots (default on); `TG_RUNNER_MAX` bots poll at once (default 20). */
  tgRunner: boolean;
  tgRunnerMax: number;
  /** ИИ-менеджер заявок on Fira (`client/fira-lead.ts`, `FIRA_LEAD_MANAGER=on`); off: the old JSON runtime. */
  firaLeadManager: boolean;
  /** `TG_GROUP_REPORTS=on`: department reports into the topics of the HQ group again, posted by the HQ bot (off by default: reports stay in the Shell). */
  tgGroupReports: boolean;
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
  /** Support: what the monitoring checks, fixed monthly costs by item, department limit (0: none). */
  monitor: MonitorConfig;
  fixedCostsUsdMonth: Record<string, number>;
  supportBudgetUsd: number;
  /** Hours until a client ticket without an approved answer becomes an alert. */
  supportSlaHours: number;
  /** Invoice number prefix (`FT` gives FT-2026-001) and the payment details printed in invoices. */
  invoicePrefix: string;
  paymentDetails: PaymentDetails;
  /** Optional API keys of the two indexers the payment watcher reads (higher rate limits); without them the free tier is used. */
  trongridApiKey: string | undefined;
  toncenterApiKey: string | undefined;
  /** Optional Openverse OAuth client (`OPENVERSE_CLIENT_ID`/`OPENVERSE_CLIENT_SECRET`): a bearer token and higher limits; anonymous use works without it. */
  openverseClientId: string | undefined;
  openverseClientSecret: string | undefined;
  /** `CONTENT_BACKGROUNDS=on`: carousel slides and posts get an Openverse picture under the brand frame (credit in the caption). Default off. */
  contentBackgrounds: boolean;
  /** `PAY_TOLERANCE`: under-payment the watcher accepts, percent 0..0.5; default 0 (exact). */
  payTolerancePct: number;
  /** Sales bot token (@firtech_leads_bot). Without it the Sales head is silent (no group posts). */
  /** Shared secret of `POST /lead` (header `x-lead-token`); without it the webhook server does not start. */
  leadWebhookToken: string | undefined;
  webhookPort: number;
  /** Secret of `POST /chat` (header `x-chat-token`). Required for the route: without it `/chat` answers 404 (no fallback to another token). */
  webChatToken: string | undefined;
  /** Secret of `POST /events` (header `x-site-token`, the site's page counters). `SITE_EVENTS_TOKEN`, else `WEB_CHAT_TOKEN` (the same site-to-HQ trust level); none: the route answers 404. */
  siteEventsToken: string | undefined;
  /** P-04: `x-hq-token` of HQ's own call bookings on the site (`POST <site>/api/slots`); empty: `LEAD_WEBHOOK_TOKEN` (the same site-HQ pair); both empty: nothing is booked on the site. */
  siteBookingToken: string | undefined;
  /** Shared with the site (`UNSUBSCRIBE_SECRET`): signs the «Отписаться» links of news and recommendation letters; shorter than 16 characters counts as unset. */
  unsubscribeSecret: string | undefined;
  /** Shared secret of `GET /office` (header `x-office-token`); without it the route answers 404. */
  officeToken: string | undefined;
  /** Secret of `/admin/*` (header `x-admin-token`). Required for the routes: without it `/admin/*` answers 404 (no fallback to `OFFICE_TOKEN`, which the public hero uses). */
  adminToken: string | undefined;
  /**
   * `CABINET_TOKEN` (header `x-cabinet-token`): the client cabinet's own key to HQ. It opens only `/admin/clients/by-email` and `/admin/clients/:id` and `:id/*`
   * (never `anonymize`), see `cabinetRouteAllowed` in `webhook.ts`; nothing else under `/admin`. Unset: the cabinet-token path is off. Must differ from `ADMIN_TOKEN`.
   */
  cabinetToken: string | undefined;
  /** `TRUSTED_PROXY_IP` (comma list): the peers whose `x-real-ip` / `x-visitor-ip` HQ believes besides loopback; empty: the docker network gateway of this container is derived at start. */
  trustedProxyIps: string[];
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
  /** Reward for a referral after the referred client pays; validity (days) of a КП (the payment split is by stages from the price list). */
  referralReward: string;
  kpValidDays: number;
  /** Production and Back Office bot tokens: without them the heads are silent in the group. */
  /** Monthly limits of the two departments in USD (0: none). Used only when the head is first created. */
  productionBudgetUsd: number;
  backofficeBudgetUsd: number;
  /** Folder of the repo `knowledge/` (playbook titles for `/kb`); without it `/kb` searches lessons only. */
  knowledgeDir: string | undefined;
  /** Optional Marketing sources; each is off without its key. */
  youtubeApiKey: string | undefined;
  youtubeChannelId: string | undefined;
  /** YouTube auto-posting and owner stats (all optional): the Google Desktop client JSON, the refresh token, the privacy of uploads. */
  ytOauthClientJson: string | undefined;
  ytRefreshToken: string | undefined;
  ytPrivacy: string | undefined;
  /** Instagram Graph API publishing and insights (all optional): professional account id, long-lived token, public base URL of the media route, token issue date (ISO). */
  igUserId: string | undefined;
  igAccessToken: string | undefined;
  /** Graph host: graph.facebook.com (Facebook login) or graph.instagram.com (Instagram login product). */
  igApiHost: 'graph.facebook.com' | 'graph.instagram.com';
  igPublicBase: string | undefined;
  igTokenIssuedAt: string | undefined;
  /** Signs the public `/media/<sig>/<path>` URLs: `MEDIA_SECRET`, else `WEB_CHAT_TOKEN`. Without both the route answers 404. */
  mediaSecret: string | undefined;
  /** Key for the Telegram tokens of the clients' agents at rest (`PG_SECRET`); absent: the media secret is used. */
  pgSecret: string | undefined;
  trendsRegions: string[];
  gscServiceAccountJson: string | undefined;
  gscSiteUrl: string | undefined;
  /** Agent tools (`docs/tools.md`): Brave Search API key (else DuckDuckGo HTML), Resend key and sender for `email.send`. All optional. */
  braveSearchKey: string | undefined;
  resendApiKey: string | undefined;
  emailFrom: string | undefined;
  siteUrl: string;
  /** The site's price list (`GET`, JSON): the single source of every price the agents name. Fetched at start and every 15 minutes (`PRICES_RELOAD_MS`). */
  pricesUrl: string;
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
  /** Demo messages per signed-in client and day (all demo sources together). */
  demoDailyPerClient: number;
  /** On unless `DEMO_REQUIRE_CLIENT` is explicitly off/0/false/no: a demo request that names no known client gets 401 `login_required`. */
  demoRequireClient: boolean;
  /** `KNOWLEDGE_AUTO_IMPORT` (default on): a lead with the client's site in the brief queues the import of that site into his agent's knowledge. `off` stops it. */
  knowledgeAutoImport: boolean;
  /** `KNOWLEDGE_AUTO_DAILY` (default 20): automatic site imports per 24 hours for all clients together. */
  knowledgeAutoDaily: number;
  /** `PUBLIC_IP` and `SELF_IPS` (comma list): addresses of this server; the site crawler never fetches them. */
  selfIps: string[];
  /** age public key (`age1...`) for the nightly backup sent to the owner; unset: sent unencrypted (the message says so). */
  backupAgeRecipient: string | undefined;
}

function num(env: NodeJS.ProcessEnv, key: string, def: number, min: number, max: number): number {
  const raw = optional(env, key);
  if (raw === undefined) return def;
  const n = Number(raw.replace(',', '.'));
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${key} must be a number from ${min} to ${max}`);
  return n;
}

/** The bots of the departments, retired on 2026-11-22: HQ_BOT_TOKEN is the only bot of the owner (the client bot and Polly are separate). */
export const RETIRED_BOT_TOKENS = ['MARKETING_BOT_TOKEN', 'SUPPORT_BOT_TOKEN', 'SALES_BOT_TOKEN', 'CONTENT_BOT_TOKEN', 'PROSPECTOR_BOT_TOKEN', 'PRODUCTION_BOT_TOKEN', 'BACKOFFICE_BOT_TOKEN'] as const;

const topicsSchema = z.record(z.string(), z.number().int().positive());

/** The site's referral rule (owner decision 2026-11-19), in the words of the answer to a referrer. */
export const DEFAULT_REFERRAL_REWARD = '10% от первой подтверждённой сметы, USDT, в течение 7 дней после оплаты';

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
    retiredBots: RETIRED_BOT_TOKENS.filter((k) => optional(env, k) !== undefined),
    tgRunner: (env.TG_RUNNER ?? 'on').toLowerCase() !== 'off',
    tgRunnerMax: Math.min(200, Math.max(1, Number(env.TG_RUNNER_MAX) || 20)),
    tgApprovalCards: (env.TG_APPROVAL_CARDS ?? 'off').toLowerCase() === 'on',
    firaLeadManager: (env.FIRA_LEAD_MANAGER ?? 'off').toLowerCase() === 'on',
    tgGroupReports: (env.TG_GROUP_REPORTS ?? 'off').toLowerCase() === 'on',
    groupId,
    topics,
    clipsPerWeek: Math.round(num(env, 'CLIPS_PER_WEEK', 7, 1, 7)),
    carouselsPerWeek: num(env, 'CAROUSELS_PER_WEEK', 2, 0, 7),
    postsPerWeek: Math.round(num(env, 'POSTS_PER_WEEK', 3, 0, 7)),
    storiesPerWeek: Math.round(num(env, 'STORIES_PER_WEEK', 5, 0, 7)),
    rendersDir: `${base.dataDir}/renders`,
    renderReels: (env.REELS_RENDER ?? 'on').toLowerCase() !== 'off',
    marketingBudgetUsd: num(env, 'MARKETING_BUDGET_USD', 0, 0, 100_000),
    monitor: loadMonitorConfig(env, base.dataDir),
    fixedCostsUsdMonth: parseFixedCosts(optional(env, 'FIXED_COSTS_USD_MONTH')),
    supportBudgetUsd: num(env, 'SUPPORT_BUDGET_USD', 0, 0, 100_000),
    supportSlaHours: num(env, 'SUPPORT_SLA_HOURS', 4, 0.25, 168),
    invoicePrefix: (optional(env, 'INVOICE_PREFIX') ?? 'FT').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'FT',
    paymentDetails: parsePaymentDetails(optional(env, 'PAYMENT_DETAILS_JSON')),
    trongridApiKey: optional(env, 'TRONGRID_API_KEY'),
    toncenterApiKey: optional(env, 'TONCENTER_API_KEY'),
    openverseClientId: optional(env, 'OPENVERSE_CLIENT_ID'),
    openverseClientSecret: optional(env, 'OPENVERSE_CLIENT_SECRET'),
    contentBackgrounds: (env.CONTENT_BACKGROUNDS ?? 'off').toLowerCase() === 'on',
    payTolerancePct: parseTolerance(optional(env, 'PAY_TOLERANCE')),
    leadWebhookToken: optional(env, 'LEAD_WEBHOOK_TOKEN'),
    officeToken: optional(env, 'OFFICE_TOKEN'),
    adminToken: optional(env, 'ADMIN_TOKEN'),
    trustedProxyIps: (optional(env, 'TRUSTED_PROXY_IP') ?? '').split(',').map((x) => x.trim()).filter(Boolean),
    cabinetToken: ((c, a) => { if (c && a && c === a) throw new Error('CABINET_TOKEN must differ from ADMIN_TOKEN'); return c; })(optional(env, 'CABINET_TOKEN'), optional(env, 'ADMIN_TOKEN')),
    presenceAwayAfterMin: num(env, 'PRESENCE_AWAY_AFTER_MIN', 20, 1, 1440),
    webChatToken: optional(env, 'WEB_CHAT_TOKEN'),
    siteEventsToken: optional(env, 'SITE_EVENTS_TOKEN') ?? optional(env, 'WEB_CHAT_TOKEN'),
    siteBookingToken: optional(env, 'SITE_BOOKING_TOKEN') ?? optional(env, 'LEAD_WEBHOOK_TOKEN'),
    unsubscribeSecret: ((s) => (s && s.length >= 16 ? s : undefined))(optional(env, 'UNSUBSCRIBE_SECRET')),
    webhookPort: Math.round(num(env, 'WEBHOOK_PORT', 8787, 1, 65_535)),
    batchSize: Math.round(num(env, 'BATCH_SIZE', 10, 1, 100)),
    slotHours: [hours[0]!, hours[1]!],
    replyLevel: num(env, 'REPLY_LEVEL', 1, 0, 1) === 0 ? 0 : 1,
    salesBudgetUsd: num(env, 'SALES_BUDGET_USD', 0, 0, 100_000),
    referralReward: optional(env, 'REFERRAL_REWARD') ?? DEFAULT_REFERRAL_REWARD,
    kpValidDays: Math.round(num(env, 'KP_VALID_DAYS', 14, 1, 90)),
    productionBudgetUsd: num(env, 'PRODUCTION_BUDGET_USD', 0, 0, 100_000),
    backofficeBudgetUsd: num(env, 'BACKOFFICE_BUDGET_USD', 0, 0, 100_000),
    knowledgeDir: optional(env, 'KNOWLEDGE_DIR'),
    youtubeApiKey: optional(env, 'YOUTUBE_API_KEY'),
    youtubeChannelId: optional(env, 'YOUTUBE_CHANNEL_ID'),
    ytOauthClientJson: optional(env, 'YT_OAUTH_CLIENT_JSON'),
    ytRefreshToken: optional(env, 'YT_REFRESH_TOKEN'),
    ytPrivacy: optional(env, 'YT_PRIVACY'),
    igUserId: optional(env, 'IG_USER_ID'),
    igAccessToken: optional(env, 'IG_ACCESS_TOKEN'),
    igApiHost: optional(env, 'IG_API_HOST') === 'graph.instagram.com' ? 'graph.instagram.com' : 'graph.facebook.com',
    igPublicBase: optional(env, 'IG_PUBLIC_BASE')?.replace(/\/+$/, ''),
    igTokenIssuedAt: optional(env, 'IG_TOKEN_ISSUED_AT'),
    mediaSecret: optional(env, 'MEDIA_SECRET') ?? optional(env, 'WEB_CHAT_TOKEN'),
    pgSecret: optional(env, 'PG_SECRET'),
    trendsRegions: (optional(env, 'TRENDS_REGIONS') ?? 'KZ,UZ,RU').split(',').map((r) => r.trim().toUpperCase()).filter((r) => /^[A-Z]{2}$/.test(r)),
    gscServiceAccountJson: optional(env, 'GSC_SERVICE_ACCOUNT_JSON'),
    gscSiteUrl: optional(env, 'GSC_SITE_URL'),
    braveSearchKey: optional(env, 'BRAVE_SEARCH_KEY'),
    resendApiKey: optional(env, 'RESEND_API_KEY'),
    emailFrom: optional(env, 'RESEND_FROM') ?? 'Fir Tech <hello@firtech.pro>',
    githubToken: optional(env, 'GITHUB_TOKEN'),
    githubRepo: optional(env, 'GITHUB_REPO') ?? 'bokievf9/agents',
    builderPollMinutes: Math.round(num(env, 'BUILDER_POLL_MINUTES', 10, 1, 59)),
    clientBotToken: optional(env, 'CLIENT_BOT_TOKEN'),
    clientQuietHours: quietWindow(optional(env, 'CLIENT_QUIET_HOURS') ?? '22:00-08:00'),
    clientRatePerHour: Math.round(num(env, 'CLIENT_RATE_PER_HOUR', 20, 1, 1000)),
    clientLlmDailyCap: Math.round(num(env, 'CLIENT_LLM_DAILY_CAP', 300, 0, 100_000)),
    demoDailyPerClient: Math.round(num(env, 'DEMO_DAILY_PER_CLIENT', 30, 1, 10_000)),
    demoRequireClient: !/^(off|0|false|no)$/i.test(optional(env, 'DEMO_REQUIRE_CLIENT') ?? ''),
    knowledgeAutoImport: !/^(off|0|false|no)$/i.test(optional(env, 'KNOWLEDGE_AUTO_IMPORT') ?? ''),
    knowledgeAutoDaily: Math.max(0, Math.floor(Number(optional(env, 'KNOWLEDGE_AUTO_DAILY')) || 20)),
    selfIps: [optional(env, 'PUBLIC_IP'), optional(env, 'SELF_IPS')].flatMap((v) => (v ?? '').split(',')).map((x) => x.trim()).filter(Boolean),
    backupAgeRecipient: backupRecipient(optional(env, 'BACKUP_AGE_RECIPIENT')),
    pricesUrl: optional(env, 'PRICES_URL') ?? DEFAULT_PRICES_URL,
    siteUrl: (optional(env, 'SITE_URL') ?? 'https://firtech.pro').replace(/\/$/, ''),
  };
}

/** An age public key (`age1` + bech32 characters), or undefined. A wrong value fails at start, not at three in the morning. */
function backupRecipient(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (!/^age1[0-9a-z]{50,}$/.test(v)) throw new Error('BACKUP_AGE_RECIPIENT must be an age public key (age1...), made with `age-keygen`');
  return v;
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

/** "HH:MM" on one weekday (0 Sunday, 1 Monday...) to a cron pattern, validated. */
export function weeklyCron(time: string, dow: number): string {
  const daily = dailyCron(time);
  const [min, hour] = daily.split(' ');
  const pattern = `${min} ${hour} * * ${dow}`;
  new Cron(pattern, { paused: true });
  return pattern;
}
