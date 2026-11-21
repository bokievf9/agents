import {
  ApprovalQueue, GatewayWatch, OutboxMessenger, createBot, createLlm, errMsg, grammyMessenger, log, openDb, safeGetJson, setupBotMenu, startPolling, startPricesRefresh, loadPrices,
} from '@fir/core';
import { catchUpRoutines, HeartbeatWorker, Hq, meterLlm, startRoutines } from '@fir/hq';
import { loadConfig } from './config.js';
import { Director } from './director.js';
import { createSettings, startValues, type SettingsDefaults } from './settings.js';
import { seedTiming } from './timing.js';
import { HEAD_ID, MarketingHead } from './heads/marketing.js';
import { HEAD_ID as SALES_HEAD_ID, SalesHead, seedSales } from './heads/sales.js';
import { seedOrg, syncRoleTitles } from './org.js';
import { PRODUCTION_HEAD_ID, ProductionHead, seedProduction } from './heads/production.js';
import { BACKOFFICE, BACKOFFICE_HEAD_ID, BackofficeHead, seedBackoffice } from './heads/backoffice.js';
import { SUPPORT_HEAD_ID, SupportHead, seedSupport } from './heads/support.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BillingWorker, CHAIN_HOSTS, PaymentWatcher } from '@fir/worker-billing';
import { CustomerSupportWorker } from '@fir/worker-customer-support';
import { FinanceWorker } from '@fir/worker-finance';
import { OnboardingWorker } from '@fir/worker-onboarding';
import { MonitoringWorker } from '@fir/worker-monitoring';
import { Reporter, type TopicSender } from './reporter.js';
import { TopicManager } from './topics.js';
import { resolveMedia } from '@fir/worker-publisher';
import { createWebhook } from './webhook.js';
import { registerCabinetLead } from './cabinet.js';
import { AuditGate, AuditStore, submitAudit } from './audit-shared.js';
import { blogApi } from './blog.js';
import { DemoUsage, tapLlm } from './demo-usage.js';
import { payApi } from './pay.js';
import { cachedStatus } from './status.js';
import { createAdmin } from './admin.js';
import { buildCabinet, type CabinetApi } from './cabinet-api.js';
import { UPLOAD_TYPES } from '@fir/core';
import { serveFile } from './pult-files.js';
import { eventsApi } from './pult-events.js';
import { OwnerChannel } from './presence.js';
import { cachedOffice } from './office.js';
import { Drill } from './drill.js';
import { guardedLead, LostLeads } from './lost-leads.js';
import { BuilderBridge, RestGithubClient } from './bridge.js';
import { ClientBot } from './client/bot.js';
import { RateLimiter } from './client/sanitize.js';
import { WebChatEngine } from './client/web.js';
import { startFiraLeadManager } from './fira-wiring.js';
import { siteBooker, siteSlots } from './client/site-slots.js';
import { Calls } from './calls.js';
import { FALLBACK_INSTRUCTIONS } from './client/prompt.js';
import { clientSinks } from './client/sinks.js';
import { gatewayGate } from './client/shared.js';
import { HQ_PROFILE } from './tg.js';
import { COMMAND_NAMES, routedTo } from './commands.js';
import { installOwnerGlue, TG_COMMANDS } from './glue.js';
import { pultLinks } from './links.js';
import { ClientInbox, clientToOwner } from './client-inbox.js';
import { OwnerNotices } from './notices.js';
import { OwnerAssistant } from './assistant.js';
import { createReach } from './reach.js';
import { appTools, toolsFor } from './tools.js';
import { installRejectionGuard, keepPolling } from './process-guard.js';
import { EmailFailures } from './email-failures.js';

const cfg = loadConfig();
const db = openDb(cfg.dbFile);
const hq = new Hq(db);
// P-28: a forgotten promise is an error line and one alert in 10 minutes, never the end of the process (the alert sink is the Director, added below).
installRejectionGuard(process, (text) => hq.alert(text, { kind: 'service', short: 'HQ: ошибка в фоне (обещание без обработки), процесс работает. Подробности в логе hq.' }), { now: Date.now });
// Requests accepted from visitors that fail before the owner sees them: `lost_lead` rows and one summary alert an hour.
const lost = new LostLeads(hq);
// Emails to clients that failed (P-07): a row each, one alert an hour, the mark on the cabinet document.
const emailFailures = new EmailFailures(hq);
// Prices come from one place: the site's price list (fetched now and every 15 minutes (PRICES_RELOAD_MS), the last good copy is kept in the
// database, a bundled snapshot is the last resort). Workers and the client bot read `getPrices()` when they need a number.
const pricesOpts = { url: cfg.pricesUrl, store: { get: (k: string) => hq.setting(k) || undefined, set: (k: string, v: string) => hq.setSetting(k, v) } };
const pricesRefresh = startPricesRefresh(pricesOpts);
const pricesLoaded = await pricesRefresh.ready;
log('info', 'prices loaded', { source: pricesLoaded.source, updatedAt: pricesLoaded.prices.updatedAt });
// A restart or a deploy cuts off the tasks that were running: they go back to the head's queue.
const recovered = hq.recoverInterrupted();
if (recovered.length) log('warn', 'interrupted tasks put back to assigned', { count: recovered.length });
// Two clocks, both settings (the first start takes them from TZ and OWNER_TZ): the company's for the market, the owner's for what reaches him.
seedTiming(hq, cfg);
// The owner's settings (`GET`/`PATCH /admin/settings`) override the env, which stays the default: read before anything below takes a value from `cfg`.
const settingsDefaults: SettingsDefaults = {
  trustThreshold: cfg.trustThreshold, slotHours: [...cfg.slotHours], kpValidDays: cfg.kpValidDays, clientLlmDailyCap: cfg.clientLlmDailyCap,
  tgApprovalCards: cfg.tgApprovalCards, tgGroupReports: cfg.tgGroupReports,
};
const startVals = startValues(hq, settingsDefaults);
cfg.tgApprovalCards = startVals.tgApprovalCards;
cfg.tgGroupReports = startVals.tgGroupReports;
cfg.clientLlmDailyCap = startVals.clientLlmDailyCap;
cfg.slotHours = startVals.slotHours;
seedOrg(hq, cfg);
seedSupport(hq, cfg, (file) => readFileSync(join(cfg.instructionsDir, file), 'utf8').trim());
seedSales(hq, cfg);
seedProduction(hq, cfg, (file) => readFileSync(join(cfg.instructionsDir, file), 'utf8').trim());
seedBackoffice(hq, cfg, (file) => readFileSync(join(cfg.instructionsDir, file), 'utf8').trim());
syncRoleTitles(hq);

// One bot in Telegram (owner 2026-11-22): HQ_BOT_TOKEN. The department bots are retired: their tokens are ignored, nothing polls or posts with them.
if (cfg.retiredBots.length) log('info', 'department bots retired, HQ bot only', { ignored: cfg.retiredBots });
const bot = createBot(cfg.botToken);
const links = pultLinks(cfg.siteUrl);
// Every message to the owner goes through the channel: the inbox of the Пульт always; Telegram gets only the short reminders (`notices`) and the
// answers to his own messages in the bot (presence.ts, `telegram: 'notices'`). TG_APPROVAL_CARDS=on brings the approval cards back.
const telegram = new OutboxMessenger(grammyMessenger(bot));
const channel: OwnerChannel = new OwnerChannel({
  hq, inner: telegram, ownerId: cfg.ownerId, awayAfterMin: cfg.presenceAwayAfterMin, approvalPending: (id: number): boolean => queue.get(id)?.status === 'pending',
  onCardSent: (id: number, messageId: number) => queue.noteCard(id, cfg.ownerId, messageId),
  telegram: 'notices', cards: cfg.tgApprovalCards, pultUrl: links.base, skipAtDesk: () => hq.setting('notice.skip_desk') !== '0',
});
const notices = new OwnerNotices({ hq, links, deliver: (html) => channel.notice(html) });
const messenger = channel;
const queue: ApprovalQueue = new ApprovalQueue(db, messenger, cfg.ownerId, cfg.trustThreshold);
queue.thresholdFor = startVals.trustThreshold; // per kind from the settings, else the global one, else TRUST_THRESHOLD
hq.attachQueue(queue);
// A decision cut off mid-execution by a restart is failed (never run twice); the owner decides again.
const cutOff = queue.recoverInterrupted();
if (cutOff.length) log('warn', 'approvals interrupted by a restart marked failed', { ids: cutOff });
// The model gateway is watched through the company's own calls: down for a minute, the owner hears once; back, once more.
// In direct mode (ANTHROPIC_API_KEY) the same watch reports Anthropic being unreachable, and the OmniRoute health check is off.
const directLlm = cfg.llm.mode === 'direct';
const modelsName = directLlm ? 'Claude (Anthropic)' : 'Шлюз моделей';
const llm = new GatewayWatch(createLlm(cfg.llm), {
  onDown: () => hq.alert(`${modelsName} не отвечает больше минуты, задачи подождут (задачи с ошибкой модели можно повторить в Пульте). Скажу, когда вернётся.`, { kind: 'llm', short: `${modelsName} не отвечает больше минуты, задачи подождут.` }),
  onUp: () => hq.alert(`${modelsName} снова отвечает, работа идёт.`, { kind: 'llm' }),
});
if (directLlm) {
  try { db.prepare("DELETE FROM mon_state WHERE check_id = 'omniroute'").run(); } catch { /* no monitoring table yet */ }
}
// The public client bot and the website chat are the biggest spend and had no meter: every call now lands in `costs` (agent
// `client-bot`, department sales; a customer is waiting, so the money limit alerts but never silences it). The daily call cap
// lives in HQ settings, so a deploy does not reset it.
const gatewayDown = gatewayGate(() => llm.down, Date.now); // visitors get the scripted answer while the gateway is down; one call a minute probes it
// «Демо только для вошедших»: every demo message is booked to the signed-in client (`demo_usage`: calls, tokens, money) and capped per day; the tap sees the usage of the
// model calls made inside one demo message (outside it the client is the same as before).
const demoUsage = new DemoUsage({ db, now: hq.now, tz: () => hq.tz, limit: () => { const v = Number(hq.setting('demo_daily_per_client')); return v > 0 ? v : cfg.demoDailyPerClient; } });
const clientLlm = tapLlm(meterLlm(llm, hq, { agentId: 'client-bot', urgent: true }));
const counter = { get: (k: string) => hq.setting(k) || undefined, set: (k: string, v: string) => hq.setSetting(k, v) };

// Department reports: into the topics of the HQ group only with TG_GROUP_REPORTS=on, and then by the HQ bot itself. Off (the default), a report stays
// in the task journal and the Пульт (Reporter.post returns false).
const topicSender: TopicSender = async (chatId, threadId, text) => {
  await bot.api.sendMessage(chatId, text, { message_thread_id: threadId, link_preview_options: { is_disabled: true } });
};
const topicManager = new TopicManager(hq, cfg.groupId, cfg.topics, bot.api);
const reporter = cfg.tgGroupReports
  ? new Reporter(() => topicManager.groupId(), () => topicManager.topics(), new Map([['general', topicSender]]), topicSender)
  : new Reporter(undefined, {}, new Map());

const director = new Director({ hq, llm, messenger, queue, ownerId: cfg.ownerId, reporter, notices, links });
const settingsRef: { view: (() => unknown) | null } = { view: null };
const assistant = new OwnerAssistant({ hq, llm, links, pendingApprovals: () => queue.pending().length, settingsView: () => settingsRef.view?.() ?? null });
// The agents' toolbox (docs/tools.md): keys from the config and the app's adapters; every head gives each worker run its own `ctx.tools`.
const tools = appTools(hq, llm, cfg);

// The public client bot (@firtech_bot): only with CLIENT_BOT_TOKEN. The heads deliver approved client texts through it.
const readClientInstructions = (): string => {
  try {
    return readFileSync(join(cfg.instructionsDir, 'client-bot.md'), 'utf8');
  } catch (e) {
    log('warn', 'client-bot.md not readable, using the short built-in rules', { err: errMsg(e) });
    return FALLBACK_INSTRUCTIONS;
  }
};
const clientBot = cfg.clientBotToken
  ? new ClientBot({
      token: cfg.clientBotToken, db, now: hq.now, tz: () => hq.tz, llm: clientLlm, counter, ownerId: cfg.ownerId, instructions: readClientInstructions(),
      quietHours: cfg.clientQuietHours, perHour: cfg.clientRatePerHour, dailyCap: cfg.clientLlmDailyCap,
      // one bot: «позвать человека» and the client's words after it go to the thread in the Пульт and a reminder of the HQ bot, never from the client bot
      toOwner: clientToOwner({ inbox: new ClientInbox(db, hq.now), notices, links, now: hq.now, onError: (e) => log('warn', 'client bot hand-off failed', { err: errMsg(e) }) }),
      ownerHint: `Этот бот для клиентов. Ответы клиентам и возврат бота сценарию: в Пульте, ${links.to('chats')}`,
      onLost: (source, reason, info) => lost.record(source, reason, info), gatewayDown,
    })
  : null;
const marketing = new MarketingHead({
  hq, tools, llm, queue, messenger, ownerId: cfg.ownerId, reporter, clipsPerWeek: cfg.clipsPerWeek, carouselsPerWeek: cfg.carouselsPerWeek,
  postsPerWeek: cfg.postsPerWeek, storiesPerWeek: cfg.storiesPerWeek, rendersDir: cfg.rendersDir, renderReels: cfg.renderReels, backgrounds: cfg.contentBackgrounds,
  ...(clientBot ? { audit: clientBot.engine } : {}), lost,
  integrations: {
    youtubeApiKey: cfg.youtubeApiKey, youtubeChannelId: cfg.youtubeChannelId, ytOauthClientJson: cfg.ytOauthClientJson, ytRefreshToken: cfg.ytRefreshToken, ytPrivacy: cfg.ytPrivacy, igUserId: cfg.igUserId, igAccessToken: cfg.igAccessToken, igApiHost: cfg.igApiHost, igPublicBase: cfg.igPublicBase, igTokenIssuedAt: cfg.igTokenIssuedAt, mediaSecret: cfg.mediaSecret, trendsRegions: cfg.trendsRegions,
    gscServiceAccountJson: cfg.gscServiceAccountJson, gscSiteUrl: cfg.gscSiteUrl, siteUrl: cfg.siteUrl,
  },
});
director.editors.set('content_item', marketing);
director.editors.set('article', marketing); // «Править» on an article = a remark, the article is written again
director.onPackButton = (op, id, at) => marketing.onPackButton(op, id, at); // the weekly pack's card: «Посмотреть по одному», previews
for (const name of routedTo('marketing')) director.commands.set(name, { dept: 'marketing', run: (arg) => marketing.command(name, arg) });
const monitor = new MonitoringWorker(cfg.monitor);
if (clientBot) monitor.watchBot(clientBot.probe()); // getMe, polling errors and silence of @firtech_bot go to the checks and to /status
const billing = new BillingWorker({ prefix: cfg.invoicePrefix, paymentDetails: cfg.paymentDetails, siteUrl: cfg.siteUrl });
// On-chain USDT check: only the two indexer hosts, resolved once to a public address, 8 s, 1 MB (core `safeGetJson`).
const payWatch = new PaymentWatcher({
  addresses: billing.chainAddresses(),
  get: (url, headers) => safeGetJson(url, { allowHosts: CHAIN_HOSTS, headers, timeoutMs: 8000 }),
  keys: { ...(cfg.trongridApiKey ? { trongrid: cfg.trongridApiKey } : {}), ...(cfg.toncenterApiKey ? { toncenter: cfg.toncenterApiKey } : {}) },
  tolerancePct: cfg.payTolerancePct,
});
const support = new SupportHead({
  hq, tools, llm, reporter, monitor, finance: new FinanceWorker({ fixedCosts: cfg.fixedCostsUsdMonth }),
  cs: new CustomerSupportWorker({ slaHours: cfg.supportSlaHours }),
  billing, payWatch,
  onboarding: new OnboardingWorker(), messenger, ownerId: cfg.ownerId, ...(clientBot ? { client: clientBot } : {}),
});
director.onSupportCommand = (name, args) => support.onCommand(name, args);
// the site's free call windows (`GET /api/slots`, one request a minute at most) minus the ones HQ already holds: the chat's offer and the first reply (P-06)
const siteFree = siteSlots(cfg.siteUrl);
const callsRef: { current: Calls | null } = { current: null };
const cabinetRef: { current: CabinetApi | null } = { current: null };
const freeSlots = async (): Promise<number[]> => (callsRef.current ? callsRef.current.freeOf(await siteFree()) : siteFree());
const sales = new SalesHead({
  hq, tools, llm, queue, messenger, ownerId: cfg.ownerId, reporter, batchSize: cfg.batchSize, slotHours: cfg.slotHours, replyLevel: cfg.replyLevel, freeSlots,
  // «демо на ваших данных»: a lead with a niche gets its draft agent at once, the demo link goes into the first reply
  demoLink: (leadId, lang) => cabinetRef.current?.playground.draftForLead(leadId, lang)?.url ?? null,
  referralReward: cfg.referralReward, kpValidDays: startVals.kpValidDays,
  ...(clientBot ? { client: clientBot } : {}), lost,
});
const auditGate = new AuditGate(hq.now);
clientBot?.connect(clientSinks({ hq, sales, support, invoicePrefix: cfg.invoicePrefix, audit: { marketing, gate: auditGate }, calls: { book: (...a) => callsRef.current ? callsRef.current.book(...a) : Promise.resolve(null) } }));
director.onSalesReply = (id, text) => sales.startReply(id, text);
director.onSalesCommand = (name, arg) => sales.salesCommand(name, arg);
director.editors.set('sales:reply', sales); // the owner's text after /reply <id>
const production = new ProductionHead({ hq, tools, llm, queue, messenger, ownerId: cfg.ownerId, reporter });
const backoffice = new BackofficeHead({
  hq, tools, llm, queue, messenger, ownerId: cfg.ownerId, reporter, knowledgeDir: cfg.knowledgeDir,
  ops: { dataDir: cfg.dataDir, rendersDir: cfg.rendersDir, ageRecipient: cfg.backupAgeRecipient },
});
// Cabinet v3 (2026-11-22): the client's documents (accept, sign), threads and uploads, the playground of agents. The heads hand the owner's approvals to it.
const chatGateForAgents = clientBot?.engine.limiter ?? new RateLimiter(1, cfg.clientLlmDailyCap, hq.now, () => hq.tz, counter);
const cabinet = buildCabinet({
  unsubscribeSecret: cfg.unsubscribeSecret,
  hq, llm: clientLlm, billing, siteUrl: cfg.siteUrl, dataDir: cfg.dataDir, mediaSecret: cfg.mediaSecret, mediaBase: cfg.igPublicBase, secret: cfg.pgSecret, gate: chatGateForAgents, demoUsage, demoRequireClient: cfg.demoRequireClient, kpValidDays: startVals.kpValidDays,
  tools: () => toolsFor(hq, tools, { agentId: 'documents', dept: BACKOFFICE, messenger, ownerId: cfg.ownerId }),
});
sales.cabinet = cabinet.docs;
cabinetRef.current = cabinet;
// P-02/P-04/P-18/P-19/P-20 (2026-11-22): the call bookings live in HQ; the window goes to the site, the client hears it by his channel, reminders a day and an hour before
const calls = new Calls({
  hq, siteBook: siteBooker(cfg.siteUrl, cfg.siteBookingToken), mail: cabinet.mail,
  notifyOwner: (text) => void channel.notify('message', text).catch((e) => log('warn', 'call notice to the owner failed', { err: errMsg(e) })),
});
calls.client = clientBot;
sales.calls = calls;
callsRef.current = calls;
backoffice.cabinet = cabinet.docs;
support.cabinet = cabinet.docs;
production.cabinet = cabinet.docs;
// The first payment of a КП starts the project (reserved by the approved КП) and asks the referral payout; `/paid` and later the on-chain check land here.
support.onPaid = async (inv) => {
  cabinet.docs.onPaid(inv);
  return [...production.onInvoicePaid(inv), ...(await sales.onInvoicePaid(inv))];
};
for (const name of routedTo('production')) director.commands.set(name, { dept: 'production', run: (arg) => production.command(name, arg) });
for (const name of routedTo('backoffice')) director.commands.set(name, { dept: 'backoffice', run: (arg) => backoffice.command(name, arg) });
const drill = new Drill({
  hq, queue, messenger, ownerId: cfg.ownerId, reporter,
  monitor: async () => {
    const events = await support.monitorTick();
    return events.length ? `проверки выполнены, событий: ${events.length}` : 'проверки выполнены, всё в норме';
  },
  kb: (query) => backoffice.command('kb', query),
});
director.onDrillCommand = (arg) => drill.command(arg);
director.onTopicsCommand = async () => (await topicManager.ensure()).text;
if (cfg.tgGroupReports) director.summaryLines.push(() => topicManager.summaryNote());
director.summaryLines.push(() => demoUsage.summaryLine(), () => production.overdueLine(), () => backoffice.pendingLine(), () => lost.summaryLine(), () => emailFailures.summaryLine());

installOwnerGlue(bot, { ownerId: cfg.ownerId, channel, queue, director, marketing, sales, topicManager, assistant, links, cards: cfg.tgApprovalCards });

// The menu of the one bot: /start and /pult only, the profile texts say what it is (a reminder and answers; control in the Пульт).
void setupBotMenu(bot.api, {
  commands: [], ownerCommands: { chatId: cfg.ownerId, commands: TG_COMMANDS }, description: HQ_PROFILE.description,
  shortDescription: HQ_PROFILE.short, menuButtonChatId: cfg.ownerId,
}, 'hq').catch((e) => log('warn', 'bot menu setup failed', { err: errMsg(e) }));

// Heartbeat: the heads work only when woken (a task, a message or a routine).
const heartbeats = new HeartbeatWorker(hq, async (agent) => {
  if (agent.id === HEAD_ID) await marketing.onHeartbeat();
  if (agent.id === SUPPORT_HEAD_ID) await support.onHeartbeat();
  if (agent.id === SALES_HEAD_ID) await sales.onHeartbeat();
  if (agent.id === PRODUCTION_HEAD_ID) await production.onHeartbeat();
  if (agent.id === BACKOFFICE_HEAD_ID) await backoffice.onHeartbeat();
});
heartbeats.start();
// Heartbeat file for the monitoring (without Docker access) and for a look from outside: touched every 30 s while the process is alive.
const hqBeat = join(cfg.dataDir, 'hq.heartbeat');
const beat = () => {
  try {
    writeFileSync(hqBeat, String(Date.now()));
  } catch (e) {
    log('warn', 'heartbeat file not written', { err: errMsg(e) });
  }
};
beat();
const beatTimer = setInterval(beat, 30_000);
beatTimer.unref();
// Agent Reach jobs the Mac never answers (off, no tunnel) fail after 6 h and release the tasks waiting on them.
const reachTimer = setInterval(() => { try { createReach({ hq, now: hq.now }).sweep(); } catch (e) { log('warn', 'reach sweep failed', { err: errMsg(e) }); } }, 300_000);
reachTimer.unref();
let routineJobs = startRoutines(hq);
// P-26: routines whose time passed while HQ was down run once now (not on a timing change: only at start).
try {
  const caught = catchUpRoutines(hq);
  if (caught.length) log('info', 'routines caught up', { n: caught.length, names: caught });
} catch (e) {
  log('warn', 'routine catch-up failed', { err: errMsg(e) });
}
// A clock or a time changed through the Director: the routines and the heads' own crons follow it at once (no restart needed).
director.onTimingChange = () => {
  routineJobs.forEach((j) => j.stop());
  routineJobs = startRoutines(hq);
  support.start();
};
const bridge = new BuilderBridge({
  hq, pollMinutes: cfg.builderPollMinutes,
  github: cfg.githubToken ? new RestGithubClient(cfg.githubToken, cfg.githubRepo) : null,
});
director.onBuilderTask = () => bridge.syncNew();
bridge.start();
director.start();
support.start();
drill.start();
// Due times live in the database, not in timers: the demo-salon reminder (60 s after a booking) and the 20-hour audit alert are
// found by this 30 s ticker, also right after a start, so a restart or a deploy loses nothing.
const dueTick = async () => {
  await clientBot?.engine.demo.tick().catch((e) => log('warn', 'demo reminders failed', { err: errMsg(e) }));
  await marketing.auditWatch().catch((e) => log('warn', 'audit watch failed', { err: errMsg(e) }));
  // clarifying questions of the Sales head: the client's answers, or 24 hours without them, release the КП
  await sales.clarifyTick().catch((e) => log('warn', 'clarify tick failed', { err: errMsg(e) }));
  // leads nobody took for 15 minutes are recorded, and the lost requests of the last hour become one alert
  try {
    lost.watchStale();
    await lost.flush();
  } catch (e) {
    log('warn', 'lost leads watch failed', { err: errMsg(e) });
  }  // P-11: a КП the client never answered expires after KP_VALID_DAYS (the owner hears a day before and when it happens)
  await cabinet.docs.expiryTick().catch((e) => log('warn', 'quote expiry tick failed', { err: errMsg(e) }));
  // P-07: emails to clients that did not go (КП, contract, invoice, act, stage notices, clarifying questions): one alert an hour
  await emailFailures.flush().catch((e) => log('warn', 'email failures flush failed', { err: errMsg(e) }));
  // the reminders of the one HQ bot: new clients, leads, approvals, payments, stages, signatures, calls (grouped, quiet hours to the morning)
  await notices.scan().catch((e) => log('warn', 'owner notices scan failed', { err: errMsg(e) }));
  // P-13: a manager's or Support's answer in a cabinet thread: one email «новое сообщение» per thread an hour, none when the client already read it
  await cabinet.mail?.messageTick().catch((e) => log('warn', 'client message mail failed', { err: errMsg(e) }));
  // P-20: call reminders a day and an hour before (client and owner), once each
  await calls.tick().catch((e) => log('warn', 'call reminders failed', { err: errMsg(e) }));
  // P-16: a review asked a week ago and not given: one inbox line for the owner
  try {
    cabinet.docs.reviewTick();
  } catch (e) {
    log('warn', 'review tick failed', { err: errMsg(e) });
  }
};
void dueTick();
const dueTimer = setInterval(() => void dueTick(), 30_000);
dueTimer.unref();
if (cfg.tgGroupReports) void topicManager.ensure().then((r) => log('info', 'topics checked', { state: r.state, created: r.created }));
// P-09: cabinet notices a restart cut off (approved, never told to the client) go now, failed emails are tried again (3 emails per document in all).
void cabinet.docs.recoverDeliveries()
  .then((r) => { if (r.delivered || r.remailed) log('info', 'cabinet deliveries recovered', r); })
  .catch((e) => log('warn', 'cabinet delivery recovery failed', { err: errMsg(e) }));
// Wake every head once at start: tasks that waited while the process was down.
for (const dept of hq.departments()) {
  const head = hq.headOf(dept);
  if (head) hq.wake(head.id, 'schedule');
}

// POST /lead from firtech.pro (same host): a Sales task per lead. No token, no server.
// POST /chat (website chat): the same conversation engine as the client bot, its LLM daily cap shared with the Telegram counter.
const chatGate = clientBot?.engine.limiter ?? new RateLimiter(1, cfg.clientLlmDailyCap, hq.now, () => hq.tz, counter);
// P-25: the owner hears when the day's model calls of the clients' chats reach 80% and 100% of the cap (one shared counter: any limiter tells it).
const capNotice = (level: 80 | 100, used: number, cap: number) => void hq.alert(level === 100
  ? `Дневной лимит вызовов модели для клиентских чатов исчерпан (${used} из ${cap}): до завтра чаты отвечают сценариями. Лимит меняется в Пульте, настройки.`
  : `Клиентские чаты израсходовали ${used} из ${cap} вызовов модели за сегодня (80%). Лимит меняется в Пульте, настройки.`, { kind: 'budget' });
for (const l of new Set([clientBot?.engine.limiter, chatGateForAgents, chatGate])) if (l) l.onCap ??= capNotice;
// ИИ-менеджер заявок on Fira (FIRA_LEAD_MANAGER=on): registered before the web chat and the client bot take their first turn
if (cfg.firaLeadManager) startFiraLeadManager({ hq, db });
const webChat = cfg.webChatToken
  ? new WebChatEngine({
      db, now: hq.now, tz: () => hq.tz, llm: clientLlm, instructions: readClientInstructions(), quietHours: cfg.clientQuietHours, gate: chatGate, demoUsage, demoRequireClient: cfg.demoRequireClient,
      onLost: (source, reason, info) => lost.record(source, reason, info), gatewayDown, siteOrigin: cfg.siteUrl, slots: freeSlots,
    })
  : null;
webChat?.connect(clientSinks({ hq, sales, support, invoicePrefix: cfg.invoicePrefix, calls }));
if (webChat) calls.webReply = (sessionId, text) => webChat.store.queueOwnerReply(sessionId, text);

// The company settings of the Пульт: the first department limits are written once, when every limit is still 0.
const settings = createSettings({
  hq, queue, defaults: settingsDefaults, slotHours: cfg.slotHours, now: hq.now,
  limiters: () => [...new Set([clientBot?.engine.limiter, chatGateForAgents, chatGate].filter((x): x is RateLimiter => x !== undefined))],
  setLevel: (kind, level) => void director.levelCommand(`${kind} ${level}`),
  onSchedule: () => { director.start(); director.onTimingChange?.(); },
});
settingsRef.view = () => settings.view();
if (settings.seedBudgets()) log('info', 'first department limits written', { source: 'seed 2026-11-23' });
const admin = cfg.adminToken
  ? createAdmin({ hq, queue, director, channel, ownerId: cfg.ownerId, commandNames: COMMAND_NAMES, drill: (arg) => drill.command(arg), cabinetTicket: (t) => support.cabinetTicket(t.id, t.name, t.text, t.telegram, t.leadId),
      reloadPrices: async () => { const r = await loadPrices(pricesOpts); return { source: r.source, updatedAt: r.prices.updatedAt }; },
      acceptStage: (projectId, stageNo) => Promise.resolve(production.acceptStage(projectId, stageNo, 'client')),
      billing, marketing, tools, cabinet, calls, rendersDir: cfg.rendersDir, onRoutinesChange: () => director.onTimingChange?.(), settings, ...(clientBot ? { client: clientBot } : {}), ...(webChat ? { webReply: (sessionId: string, text: string) => webChat.store.queueOwnerReply(sessionId, text) } : {}),
    })
  : null;
// Presence: the site pings while it is open; without pings the owner counts as away and a digest goes to Telegram.
const presenceTimer = setInterval(() => void channel.sync().catch((e) => log('error', 'presence sync failed', { err: errMsg(e) })), 60_000);
presenceTimer.unref();

const webhook = cfg.leadWebhookToken || cfg.webChatToken || cfg.adminToken || cfg.siteEventsToken || cfg.mediaSecret
  ? createWebhook(
      // the form gets its error when the task cannot be made, but the person's contact is kept for the owner (guardedLead)
      guardedLead(lost, ({ name, contact, service, budget, message, estimate, locale, slot, source, telegramSent, hasDomain, hasHosting, clientEmail, cabinetId, clientName }) => {
        const id = sales.createLeadTask({
          name, contact, service, budget, message, estimate, locale, slot, source, ...(telegramSent ? { telegramSent: true } : {}),
          ...(hasDomain !== undefined ? { hasDomain } : {}), ...(hasHosting !== undefined ? { hasHosting } : {}),
        }, service);
        if (!clientEmail) return id;
        // a signed-in cabinet client: the account and the lead row exist (and are linked) before the answer goes back to the site
        try {
          const r = registerCabinetLead(db, hq.now, id, { clientEmail, cabinetId, clientName, name, contact, service, budget, message, estimate, locale, source, hasDomain, hasHosting });
          return { id, leadId: r.leadId };
        } catch (e) {
          log('warn', 'cabinet lead not linked', { task: id, err: errMsg(e) });
          return id;
        }
      }),
      cfg.leadWebhookToken,
      Date.now,
      cfg.officeToken ? { token: cfg.officeToken, get: cachedOffice(hq) } : undefined,
      webChat && cfg.webChatToken ? { token: cfg.webChatToken, handle: (r, ip) => webChat.handle(r, ip) } : undefined,
      admin && cfg.adminToken ? { token: cfg.adminToken, handle: (r) => admin.handle(r), file: (path, range) => serveFile(cfg.rendersDir, path, range) } : undefined,
      {
        ...(cfg.leadWebhookToken
          ? {
              audit: {
                token: cfg.leadWebhookToken,
                handle: (a) => Promise.resolve(submitAudit({ store: new AuditStore(db, hq.now), gate: auditGate, create: (x) => marketing.requestAudit(x) }, a)),
              },
            }
          : {}),
        status: { get: cachedStatus(db) },
        blog: blogApi(db, hq.now, () => hq.tz),
        pay: payApi(db, billing, hq.now, () => hq.tz),
        ...(cfg.siteEventsToken ? { events: { token: cfg.siteEventsToken, handle: eventsApi(db, hq.now, () => hq.tz).handle } } : {}),
        ...(cfg.mediaSecret
          ? {
              media: {
                // renders (Instagram, the cabinet's PDFs) and the clients' uploads under DATA_DIR/uploads; expiring links carry `?e=`
                resolve: (sig: string, rel: string, exp?: number | null) => rel.startsWith('uploads/')
                  ? resolveMedia(cfg.dataDir, cfg.mediaSecret!, sig, rel, { exp: exp ?? null, now: hq.now(), types: UPLOAD_TYPES })
                  : resolveMedia(cfg.rendersDir, cfg.mediaSecret!, sig, rel, { exp: exp ?? null, now: hq.now() }),
              },
            }
          : {}),
        agent: { handle: (id, r) => cabinet.playground.handlePublic(id, r) },
      },
    ).listen(cfg.webhookPort, '0.0.0.0', () => log('info', 'webhook listening', { port: cfg.webhookPort, lead: Boolean(cfg.leadWebhookToken), chat: Boolean(webChat), admin: Boolean(admin) }))
  : null;
const missingTokens = [
  ...(cfg.leadWebhookToken ? [] : ['LEAD_WEBHOOK_TOKEN: POST /lead and POST /audit answer 404']),
  ...(cfg.webChatToken ? [] : ['WEB_CHAT_TOKEN: POST /chat answers 404']),
  ...(cfg.adminToken ? [] : ['ADMIN_TOKEN: /admin/* answers 404']),
  ...(cfg.siteEventsToken ? [] : ['SITE_EVENTS_TOKEN (or WEB_CHAT_TOKEN): POST /events answers 404']),
];
if (missingTokens.length) log('warn', `routes switched off, tokens are required (no fallback to another token): ${missingTokens.join('; ')}`);

const stop = () => {
  webhook?.close();
  pricesRefresh.stop();
  clearInterval(presenceTimer);
  clearInterval(beatTimer);
  heartbeats.stop();
  bridge.stop();
  director.stop();
  support.stop();
  drill.stop();
  clearInterval(dueTimer);
  routineJobs.forEach((j) => j.stop());
  // Exit fast: a long poll in flight would hold the process (and Telegram's update slot) for up to 30 s, which is the
  // gap the owner sees on every deploy. Once the process is gone Telegram frees the slot for the new container at once.
  setTimeout(() => process.exit(0), 1500).unref();
  void Promise.all([bot.stop(), clientBot?.stop()]).finally(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

log('info', 'hq starting', { tz: hq.tz, departments: hq.departments(), group: cfg.groupId !== undefined, groupReports: cfg.tgGroupReports, approvalCards: cfg.tgApprovalCards, clientBot: Boolean(clientBot) });
// The client bot polls on its own (P-05): a crashed poll starts again after a pause, three times in a row; then HQ exits and the container
// restarts (compose `restart: unless-stopped`), so Telegram leads never wait for a manual restart.
if (clientBot) {
  const bot = clientBot;
  void keepPolling(() => bot.start(), {
    attempts: 3, pauseMs: 15_000, now: Date.now,
    onRestart: (attempt, e) => log('warn', 'client bot polling restarts', { attempt, err: errMsg(e) }),
    onGiveUp: async (e) => {
      log('error', 'client bot stopped', { err: errMsg(e) });
      // The main sales channel is down: the owner hears about it at once (the monitoring check turns `down` too).
      await hq.alert('Клиентский бот @firtech_bot: поллинг упал 4 раза подряд, перезапускаю HQ (контейнер поднимется сам). Подробности в логе hq.', { kind: 'service', short: 'Клиентский Telegram @firtech_bot упал, HQ перезапускается.' }).catch(() => undefined);
      process.exit(1);
    },
  });
}
if (!clientBot) log('info', 'CLIENT_BOT_TOKEN is not set, the public client bot is off');
startPolling(bot).catch((e) => {
  log('error', 'bot stopped', { err: errMsg(e) });
  process.exit(1);
});
