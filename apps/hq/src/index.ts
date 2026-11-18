import { Api } from 'grammy';
import {
  ApprovalQueue, createBot, createLlm, errMsg, grammyMessenger, installApprovals, log, openDb, startPolling,
} from '@fir/core';
import { HeartbeatWorker, Hq, startRoutines } from '@fir/hq';
import { loadConfig } from './config.js';
import { Director } from './director.js';
import { HEAD_ID, MARKETING, MarketingHead } from './heads/marketing.js';
import { seedOrg } from './org.js';
import { Reporter, type TopicSender } from './reporter.js';

const cfg = loadConfig();
const db = openDb(cfg.dbFile);
const hq = new Hq(db);
// The timezone of the departments is a setting; the first start takes it from TZ.
if (!db.prepare("SELECT 1 FROM settings WHERE key = 'tz'").get()) hq.setSetting('tz', cfg.tz);
seedOrg(hq, cfg);

const bot = createBot(cfg.botToken);
const messenger = grammyMessenger(bot);
const queue = new ApprovalQueue(db, messenger, cfg.ownerId, cfg.trustThreshold);
hq.attachQueue(queue);
const llm = createLlm(cfg.llm);

// Department bots only post into their topic of the HQ group (no polling, no private chats). Without a token, silent.
const senders = new Map<string, TopicSender>();
const topicSender = (api: Api): TopicSender => async (chatId, threadId, text) => {
  await api.sendMessage(chatId, text, { message_thread_id: threadId, link_preview_options: { is_disabled: true } });
};
senders.set('general', topicSender(bot.api));
if (cfg.marketingBotToken) senders.set(MARKETING, topicSender(new Api(cfg.marketingBotToken)));
const reporter = new Reporter(cfg.groupId, cfg.topics, senders);

const director = new Director({ hq, llm, messenger, queue, ownerId: cfg.ownerId, reporter });
const marketing = new MarketingHead({
  hq, llm, queue, messenger, ownerId: cfg.ownerId, reporter, clipsPerWeek: cfg.clipsPerWeek, carouselsPerWeek: cfg.carouselsPerWeek,
  integrations: {
    youtubeApiKey: cfg.youtubeApiKey, youtubeChannelId: cfg.youtubeChannelId, trendsRegions: cfg.trendsRegions,
    gscServiceAccountJson: cfg.gscServiceAccountJson, gscSiteUrl: cfg.gscSiteUrl, siteUrl: cfg.siteUrl,
  },
});
director.editors.set('content_item', marketing);

// Only the owner in a private chat; everyone else is ignored silently.
bot.use(async (ctx, next) => {
  if (ctx.from?.id === cfg.ownerId && ctx.chat?.type === 'private') await next();
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
  if (part) await ctx.editMessageReplyMarkup().catch(() => undefined);
});

// After the core ran the approval buttons, tasks follow the owner's decision.
bot.on('callback_query:data', async (ctx, next) => {
  const m = /^ap:(\d+):([aer])$/.exec(ctx.callbackQuery.data);
  await next();
  if (m) director.afterDecision();
});
installApprovals(bot, queue, cfg.ownerId);

const background = (name: string, run: () => Promise<void>) => void run().catch((e) => log('error', 'command failed', { cmd: name, err: errMsg(e) }));
for (const name of ['start', 'help', 'status', 'tasks', 'approve', 'costs', 'org', 'pause', 'resume', 'skip']) {
  bot.command(name, (ctx) => background(name, () => director.onCommand(name, ctx.match)));
}
// A free-text message goes through the LLM: run it in the background so buttons stay responsive.
bot.on('message:text', (ctx) => {
  if (!ctx.message.text.startsWith('/')) background('text', () => director.onText(ctx.message.text));
});

// Heartbeat: the heads work only when woken (a task, a message or a routine).
const heartbeats = new HeartbeatWorker(hq, async (agent) => {
  if (agent.id === HEAD_ID) await marketing.onHeartbeat();
});
heartbeats.start();
const routineJobs = startRoutines(hq);
director.start();
// Wake every head once at start: tasks that waited while the process was down.
for (const dept of hq.departments()) {
  const head = hq.headOf(dept);
  if (head) hq.wake(head.id, 'schedule');
}

const stop = () => {
  heartbeats.stop();
  director.stop();
  routineJobs.forEach((j) => j.stop());
  void bot.stop().finally(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

log('info', 'hq starting', { tz: hq.tz, departments: hq.departments(), group: cfg.groupId !== undefined, marketingBot: Boolean(cfg.marketingBotToken) });
startPolling(bot).catch((e) => {
  log('error', 'bot stopped', { err: errMsg(e) });
  process.exit(1);
});
