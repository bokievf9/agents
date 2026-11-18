import { Api } from 'grammy';
import {
  ApprovalQueue, createBot, createLlm, errMsg, grammyMessenger, installApprovals, log, openDb, setupBotMenu, startPolling,
} from '@fir/core';
import { HeartbeatWorker, Hq, startRoutines } from '@fir/hq';
import { loadConfig } from './config.js';
import { Director } from './director.js';
import { HEAD_ID, MARKETING, MarketingHead } from './heads/marketing.js';
import { HEAD_ID as SALES_HEAD_ID, parseCopy, SALES, SalesHead, seedSales } from './heads/sales.js';
import { seedOrg } from './org.js';
import { PRODUCTION, PRODUCTION_HEAD_ID, ProductionHead, seedProduction } from './heads/production.js';
import { BACKOFFICE, BACKOFFICE_HEAD_ID, BackofficeHead, seedBackoffice } from './heads/backoffice.js';
import { SUPPORT, SUPPORT_COMMANDS, SUPPORT_HEAD_ID, SupportHead, seedSupport } from './heads/support.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BillingWorker } from '@fir/worker-billing';
import { CustomerSupportWorker } from '@fir/worker-customer-support';
import { FinanceWorker } from '@fir/worker-finance';
import { OnboardingWorker } from '@fir/worker-onboarding';
import { MonitoringWorker } from '@fir/worker-monitoring';
import { Reporter, type TopicSender } from './reporter.js';
import { TopicManager } from './topics.js';
import { createWebhook } from './webhook.js';
import { createAdmin } from './admin.js';
import { OwnerChannel } from './presence.js';
import { cachedOffice } from './office.js';
import { Drill } from './drill.js';
import { BuilderBridge, RestGithubClient } from './bridge.js';
import { ClientBot } from './client/bot.js';
import { RateLimiter } from './client/sanitize.js';
import { WebChatEngine } from './client/web.js';
import { FALLBACK_INSTRUCTIONS } from './client/prompt.js';
import { clientSinks } from './client/sinks.js';
import { DIRECTOR_COMMANDS, DIRECTOR_PROFILE, deptBotMenu, menuCommand } from './tg.js';

const cfg = loadConfig();
const db = openDb(cfg.dbFile);
const hq = new Hq(db);
// The timezone of the departments is a setting; the first start takes it from TZ.
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'tz'").get()) hq.setSetting('tz', cfg.tz);
seedOrg(hq, cfg);
seedSupport(hq, cfg, (file) => readFileSync(join(cfg.instructionsDir, file), 'utf8').trim());
seedSales(hq, cfg);
seedProduction(hq, cfg, (file) => readFileSync(join(cfg.instructionsDir, file), 'utf8').trim());
seedBackoffice(hq, cfg, (file) => readFileSync(join(cfg.instructionsDir, file), 'utf8').trim());

const bot = createBot(cfg.botToken);
// Every message to the owner goes through the channel: inbox always, Telegram only when he is away (presence.ts).
const telegram = grammyMessenger(bot);
const channel: OwnerChannel = new OwnerChannel({
  hq, inner: telegram, ownerId: cfg.ownerId, awayAfterMin: cfg.presenceAwayAfterMin, approvalPending: (id: number): boolean => queue.get(id)?.status === 'pending',
  onCardSent: (id: number, messageId: number) => queue.noteCard(id, cfg.ownerId, messageId),
});
const messenger = channel;
const queue: ApprovalQueue = new ApprovalQueue(db, messenger, cfg.ownerId, cfg.trustThreshold);
hq.attachQueue(queue);
const llm = createLlm(cfg.llm);

// Department bots only post into their topic of the HQ group (no polling, no private chats). Without a token, silent.
const senders = new Map<string, TopicSender>();
const topicSender = (api: Api): TopicSender => async (chatId, threadId, text) => {
  await api.sendMessage(chatId, text, { message_thread_id: threadId, link_preview_options: { is_disabled: true } });
};
senders.set('general', topicSender(bot.api));
// Every department reports through the Director's bot unless it has its own bot token (the department bots are optional).
const topicManager = new TopicManager(hq, cfg.groupId, cfg.topics, bot.api);
const deptApis = new Map<string, Api>();
for (const [dept, token] of [[MARKETING, cfg.marketingBotToken], [SUPPORT, cfg.supportBotToken], [SALES, cfg.salesBotToken], [PRODUCTION, cfg.productionBotToken], [BACKOFFICE, cfg.backofficeBotToken]] as const) {
  if (!token) continue;
  const api = new Api(token);
  deptApis.set(dept, api);
  senders.set(dept, topicSender(api));
}
const reporter = new Reporter(() => topicManager.groupId(), () => topicManager.topics(), senders, topicSender(bot.api));

const director = new Director({ hq, llm, messenger, queue, ownerId: cfg.ownerId, reporter });

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
      token: cfg.clientBotToken, db, now: hq.now, tz: () => hq.tz, llm, ownerId: cfg.ownerId, instructions: readClientInstructions(),
      quietHours: cfg.clientQuietHours, perHour: cfg.clientRatePerHour, dailyCap: cfg.clientLlmDailyCap,
      ownerFallback: (text) => messenger.send(cfg.ownerId, text),
    })
  : null;
const marketing = new MarketingHead({
  hq, llm, queue, messenger, ownerId: cfg.ownerId, reporter, clipsPerWeek: cfg.clipsPerWeek, carouselsPerWeek: cfg.carouselsPerWeek,
  integrations: {
    youtubeApiKey: cfg.youtubeApiKey, youtubeChannelId: cfg.youtubeChannelId, trendsRegions: cfg.trendsRegions,
    gscServiceAccountJson: cfg.gscServiceAccountJson, gscSiteUrl: cfg.gscSiteUrl, siteUrl: cfg.siteUrl,
  },
});
director.editors.set('content_item', marketing);
const support = new SupportHead({
  hq, llm, reporter, monitor: new MonitoringWorker(cfg.monitor), finance: new FinanceWorker({ fixedCosts: cfg.fixedCostsUsdMonth }),
  cs: new CustomerSupportWorker({ slaHours: cfg.supportSlaHours }),
  billing: new BillingWorker({ prefix: cfg.invoicePrefix, paymentDetails: cfg.paymentDetails }),
  onboarding: new OnboardingWorker(), messenger, ownerId: cfg.ownerId, ...(clientBot ? { client: clientBot } : {}),
});
director.onSupportCommand = (name, args) => support.onCommand(name, args);
const sales = new SalesHead({
  hq, llm, queue, messenger, ownerId: cfg.ownerId, reporter, batchSize: cfg.batchSize, slotHours: cfg.slotHours, replyLevel: cfg.replyLevel,
  referralReward: cfg.referralReward, prepaymentPercent: cfg.prepaymentPercent, kpValidDays: cfg.kpValidDays,
  ...(clientBot ? { client: clientBot } : {}),
});
clientBot?.connect(clientSinks({ hq, sales, support, invoicePrefix: cfg.invoicePrefix }));
director.onSalesReply = (id, text) => sales.startReply(id, text);
director.onSalesCommand = (name, arg) => sales.salesCommand(name, arg);
director.editors.set('sales:reply', sales); // the owner's text after /reply <id>
const production = new ProductionHead({ hq, llm, queue, messenger, ownerId: cfg.ownerId, reporter });
const backoffice = new BackofficeHead({ hq, llm, queue, messenger, ownerId: cfg.ownerId, reporter, knowledgeDir: cfg.knowledgeDir });
for (const name of ['project', 'pstatus', 'target', 'mdone']) director.commands.set(name, { dept: 'production', run: (arg) => production.command(name, arg) });
for (const name of ['doc', 'lesson', 'kb']) director.commands.set(name, { dept: 'backoffice', run: (arg) => backoffice.command(name, arg) });
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
director.summaryLines.push(() => topicManager.summaryNote(), () => production.overdueLine(), () => backoffice.pendingLine());

// Group service messages: the basic group became a supergroup (new id), or a topic was created by hand.
bot.on('message', async (ctx, next) => {
  if (ctx.chat.type === 'private') return next();
  const m = ctx.message;
  const changed = topicManager.onGroupEvent({
    chatId: ctx.chat.id,
    ...(m.message_thread_id !== undefined ? { threadId: m.message_thread_id } : {}),
    ...(m.migrate_to_chat_id !== undefined ? { migrateTo: m.migrate_to_chat_id } : {}),
    ...(m.migrate_from_chat_id !== undefined ? { migrateFrom: m.migrate_from_chat_id } : {}),
    ...(m.forum_topic_created ? { topicName: m.forum_topic_created.name } : {}),
  });
  if (changed && (m.migrate_to_chat_id !== undefined || m.migrate_from_chat_id !== undefined)) void topicManager.ensure().catch(() => undefined);
});

// Only the owner in a private chat; everyone else is ignored silently.
// What he writes in Telegram is answered in Telegram, whatever the presence mode (the scope follows the handlers' async calls).
bot.use(async (ctx, next) => {
  if (ctx.from?.id === cfg.ownerId && ctx.chat?.type === 'private') await channel.asReply(() => next());
});

// A button never spins: a handler that throws still answers the callback query.
bot.on('callback_query:data', async (ctx, next) => {
  try {
    await next();
  } catch (e) {
    log('error', 'button handler failed', { err: errMsg(e) });
    await ctx.answerCallbackQuery({ text: 'Не получилось, попробуйте ещё раз' }).catch(() => undefined);
  }
});

// The Director's own buttons: task lists and cards, departments, the batch header, «👁 Полностью» on a card.
bot.on('callback_query:data', async (ctx, next) => {
  const msg = ctx.callbackQuery.message;
  if (!msg) return next();
  const toast = await director.onButton(ctx.callbackQuery.data, { chatId: msg.chat.id, messageId: msg.message_id });
  if (toast === null) return next();
  await ctx.answerCallbackQuery({ text: toast }).catch(() => undefined);
});

// «Скопировать» on a Scout card: the plain draft as its own message.
bot.on('callback_query:data', async (ctx, next) => {
  const copyId = parseCopy(ctx.callbackQuery.data);
  if (copyId === null) return next();
  await ctx.answerCallbackQuery({ text: await sales.onCopy(copyId) });
});

// "Править" on a content item asks which part to edit; other kinds use the core's whole-text edit.
bot.on('callback_query:data', async (ctx, next) => {
  const edit = /^ap:(\d+):e$/.exec(ctx.callbackQuery.data);
  const part = /^ce:(\d+):(\w+)$/.exec(ctx.callbackQuery.data);
  const rule = /^rl:(\d+):([yn])$/.exec(ctx.callbackQuery.data);
  const published = /^pb:(\d+)$/.exec(ctx.callbackQuery.data);
  if (published) {
    await ctx.answerCallbackQuery({ text: marketing.onPublished(Number(published[1])) });
    return;
  }
  if (rule) {
    await ctx.answerCallbackQuery({ text: await director.onRuleButton(Number(rule[1]), rule[2] === 'y') });
    await ctx.editMessageReplyMarkup().catch(() => undefined);
    return;
  }
  if (!edit && !part) return next();
  const text = edit ? await director.onEditPressed(Number(edit[1])) : await director.onPartPicked(Number(part![1]), part![2]!);
  if (text === null) return next(); // no editor for this kind: the core's own edit
  await ctx.answerCallbackQuery({ text });
  // the part picker message loses its buttons; the approval card itself (part buttons on it) keeps them
  const onCard = part && queue.cardMessage(Number(part[1]))?.messageId === ctx.callbackQuery.message?.message_id;
  if (part && !onCard) await ctx.editMessageReplyMarkup().catch(() => undefined);
});

// After the core ran the approval buttons, tasks follow the owner's decision.
bot.on('callback_query:data', async (ctx, next) => {
  const m = /^ap:(\d+):([aer])$/.exec(ctx.callbackQuery.data);
  await next();
  if (m) director.afterDecision();
});
// Commands and the reply keyboard's buttons are never taken for an edit text.
installApprovals(bot, queue, cfg.ownerId, { passthrough: (text) => text.startsWith('/') || menuCommand(text) !== null });
// Anything else (an old card from before a restart, a button of a removed feature): answered, never left spinning.
bot.on('callback_query:data', async (ctx) => {
  await ctx.answerCallbackQuery({ text: 'Устарело' }).catch(() => undefined);
});

const botCommands = ['start', 'help', 'status', 'depts', 'tasks', 'approve', 'costs', 'org', 'pause', 'resume', 'reply', 'skip', 'builders', 'builder', 'topics', 'drill', 'retry', 'desk', 'away', ...SUPPORT_COMMANDS, ...director.commands.keys(), 'kp', 'referral', 'referrals'];
const background = (name: string, run: () => Promise<void>) => void run().catch((e) => log('error', 'command failed', { cmd: name, err: errMsg(e) }));
for (const name of botCommands) {
  bot.command(name, (ctx) => background(name, () => director.onCommand(name, ctx.match)));
}
// A free-text message goes through the LLM: run it in the background so buttons stay responsive.
// An unknown /command gets a short hint with the keyboard instead of silence.
bot.on('message:text', (ctx) => {
  const text = ctx.message.text;
  if (!text.startsWith('/')) background('text', () => director.onText(text));
  else background('unknown', () => director.hint(`Не знаю команды ${text.split(/\s/)[0]!.slice(0, 40)}.`));
});

// The menu: the owner's command list with descriptions, the menu button, profile texts; department bots point to the Director.
const setupMenus = async () => {
  await setupBotMenu(bot.api, {
    commands: [], ownerCommands: { chatId: cfg.ownerId, commands: DIRECTOR_COMMANDS }, description: DIRECTOR_PROFILE.description,
    shortDescription: DIRECTOR_PROFILE.short, menuButtonChatId: cfg.ownerId,
  }, 'director');
  const me = await bot.api.getMe().then((m) => m.username).catch(() => undefined);
  for (const [dept, api] of deptApis) await setupBotMenu(api, deptBotMenu(dept, me), dept);
};
void setupMenus().catch((e) => log('warn', 'bot menu setup failed', { err: errMsg(e) }));

// Heartbeat: the heads work only when woken (a task, a message or a routine).
const heartbeats = new HeartbeatWorker(hq, async (agent) => {
  if (agent.id === HEAD_ID) await marketing.onHeartbeat();
  if (agent.id === SUPPORT_HEAD_ID) await support.onHeartbeat();
  if (agent.id === SALES_HEAD_ID) await sales.onHeartbeat();
  if (agent.id === PRODUCTION_HEAD_ID) await production.onHeartbeat();
  if (agent.id === BACKOFFICE_HEAD_ID) await backoffice.onHeartbeat();
});
heartbeats.start();
const routineJobs = startRoutines(hq);
const bridge = new BuilderBridge({
  hq, pollMinutes: cfg.builderPollMinutes,
  github: cfg.githubToken ? new RestGithubClient(cfg.githubToken, cfg.githubRepo) : null,
});
director.onBuilderTask = () => bridge.syncNew();
bridge.start();
director.start();
support.start();
drill.start();
void topicManager.ensure().then((r) => log('info', 'topics checked', { state: r.state, created: r.created }));
// Wake every head once at start: tasks that waited while the process was down.
for (const dept of hq.departments()) {
  const head = hq.headOf(dept);
  if (head) hq.wake(head.id, 'schedule');
}

// POST /lead from firtech.pro (same host): a Sales task per lead. No token, no server.
// POST /chat (website chat): the same conversation engine as the client bot, its LLM daily cap shared with the Telegram counter.
const chatGate = clientBot?.engine.limiter ?? new RateLimiter(1, cfg.clientLlmDailyCap, hq.now, () => hq.tz);
const webChat = cfg.webChatToken
  ? new WebChatEngine({ db, now: hq.now, tz: () => hq.tz, llm, instructions: readClientInstructions(), quietHours: cfg.clientQuietHours, gate: chatGate })
  : null;
webChat?.connect(clientSinks({ hq, sales, support, invoicePrefix: cfg.invoicePrefix }));

const admin = cfg.adminToken
  ? createAdmin({ hq, queue, director, channel, ownerId: cfg.ownerId, commandNames: botCommands, drill: (arg) => drill.command(arg) })
  : null;
// Presence: the site pings while it is open; without pings the owner counts as away and a digest goes to Telegram.
const presenceTimer = setInterval(() => void channel.sync().catch((e) => log('error', 'presence sync failed', { err: errMsg(e) })), 60_000);
presenceTimer.unref();

const webhook = cfg.leadWebhookToken || cfg.webChatToken || cfg.adminToken
  ? createWebhook(
      ({ name, contact, service, budget, message, estimate, locale, slot, source }) =>
        Promise.resolve(sales.createLeadTask({ name, contact, service, budget, message, estimate, locale, slot, source }, service)),
      cfg.leadWebhookToken,
      Date.now,
      cfg.officeToken ? { token: cfg.officeToken, get: cachedOffice(hq) } : undefined,
      webChat && cfg.webChatToken ? { token: cfg.webChatToken, handle: (r, ip) => webChat.handle(r, ip) } : undefined,
      admin && cfg.adminToken ? { token: cfg.adminToken, handle: (r) => admin.handle(r) } : undefined,
    ).listen(cfg.webhookPort, '0.0.0.0', () => log('info', 'webhook listening', { port: cfg.webhookPort, lead: Boolean(cfg.leadWebhookToken), chat: Boolean(webChat), admin: Boolean(admin) }))
  : null;
if (!webhook) log('warn', 'LEAD_WEBHOOK_TOKEN and WEB_CHAT_TOKEN are not set, POST /lead and POST /chat are disabled');

const stop = () => {
  webhook?.close();
  clearInterval(presenceTimer);
  heartbeats.stop();
  bridge.stop();
  director.stop();
  support.stop();
  drill.stop();
  routineJobs.forEach((j) => j.stop());
  void Promise.all([bot.stop(), clientBot?.stop()]).finally(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

log('info', 'hq starting', { tz: hq.tz, departments: hq.departments(), group: cfg.groupId !== undefined, marketingBot: Boolean(cfg.marketingBotToken), supportBot: Boolean(cfg.supportBotToken), salesBot: Boolean(cfg.salesBotToken), clientBot: Boolean(clientBot) });
// The client bot polls on its own; if it stops, HQ keeps working (the Director stays the owner's interface).
clientBot?.start().catch((e) => log('error', 'client bot stopped', { err: errMsg(e) }));
if (!clientBot) log('info', 'CLIENT_BOT_TOKEN is not set, the public client bot is off');
startPolling(bot).catch((e) => {
  log('error', 'bot stopped', { err: errMsg(e) });
  process.exit(1);
});
