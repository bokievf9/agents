import { createBot, createLlm, errMsg, grammyMessenger, installApprovals, log, ApprovalQueue, openDb, schedule, startPolling } from '@fir/core';
import { loadConfig } from './config.js';
import { loadPrompts } from './generate.js';
import { ownerOnly } from './guard.js';
import { ContentHead } from './head.js';
import { ContentStore } from './store.js';

const cfg = loadConfig();
const db = openDb(cfg.dbFile);
const bot = createBot(cfg.botToken);
const messenger = grammyMessenger(bot);
const queue = new ApprovalQueue(db, messenger, cfg.ownerId, cfg.trustThreshold);
const head = new ContentHead({ store: new ContentStore(db), messenger, llm: createLlm(cfg.llm), queue, prompts: loadPrompts(cfg.promptsDir), cfg });

// Only the owner in a private chat; everyone else is ignored silently.
bot.use(ownerOnly(cfg.ownerId));

// "Править" is handled here, before the core's whole-text edit: it asks which part to edit (script or one platform).
bot.on('callback_query:data', async (ctx, next) => {
  const edit = /^ap:(\d+):e$/.exec(ctx.callbackQuery.data);
  const part = /^ce:(\d+):(\w+)$/.exec(ctx.callbackQuery.data);
  if (!edit && !part) return next();
  const text = edit ? await head.onEditPressed(Number(edit[1])) : await head.onPartPicked(Number(part![1]), part![2]!);
  await ctx.answerCallbackQuery({ text });
  if (part) await ctx.editMessageReplyMarkup().catch(() => undefined);
});

// After the approval buttons ran (installApprovals below), a rejection asks for a comment.
bot.on('callback_query:data', async (ctx, next) => {
  const m = /^ap:(\d+):([aer])$/.exec(ctx.callbackQuery.data);
  await next();
  if (m?.[2] === 'r' || m?.[2] === 'a') await head.afterDecision(Number(m[1]), m[2] === 'r' ? 'reject' : 'approve').catch((e) => log('error', 'afterDecision failed', { err: errMsg(e) }));
});
installApprovals(bot, queue, cfg.ownerId);

const background = (name: string, run: () => Promise<void>) => void run().catch((e) => log('error', 'command failed', { cmd: name, err: errMsg(e) }));
for (const name of ['start', 'help', 'queue', 'stats', 'skip']) bot.command(name, (ctx) => head.onCommand(name, ctx.match));
// Generation takes minutes: run it in the background so the buttons stay responsive.
bot.command('pack', () => background('pack', () => head.onCommand('pack')));
bot.command('topic', (ctx) => background('topic', () => head.onCommand('topic', ctx.match)));
bot.on('message:text', async (ctx) => {
  if (!ctx.message.text.startsWith('/')) await head.onText(ctx.message.text);
});

schedule('weekly-pack', cfg.packCron, cfg.tz, () => head.generatePack());

const stop = () => {
  void bot.stop().finally(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

log('info', 'content-maker starting', { cron: cfg.packCron, tz: cfg.tz });
startPolling(bot).catch((e) => {
  log('error', 'bot stopped', { err: errMsg(e) });
  process.exit(1);
});
