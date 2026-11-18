import { join } from 'node:path';
import { createBot, createLlm, errMsg, grammyMessenger, log, openDb, schedule, startPolling } from '@fir/core';
import { loadConfig } from './config.js';
import { loadPrompts } from './draft.js';
import { CB, Prospector } from './agent.js';
import { ProspectStore } from './store.js';

const cfg = loadConfig();
const db = openDb(join(cfg.dataDir, 'prospector.db'));
const bot = createBot(cfg.botToken);
const agent = new Prospector({
  store: new ProspectStore(db),
  messenger: grammyMessenger(bot),
  llm: createLlm(cfg.llm),
  prompts: loadPrompts(cfg.promptsDir),
  ownerId: cfg.ownerId,
  batchSize: cfg.batchSize,
});

// Owner only, private chat only: everyone else is ignored silently.
bot.use(async (ctx, next) => {
  if (ctx.from?.id === cfg.ownerId && (ctx.chat?.type === 'private' || ctx.callbackQuery)) await next();
});

for (const name of ['start', 'help', 'batch', 'next', 'stats', 'find', 'reply']) {
  bot.command(name, (ctx) => agent.onCommand(ctx.from!.id, name, ctx.match));
}
bot.on('callback_query:data', async (ctx) => {
  const answer = await agent.onCallback(ctx.from.id, ctx.callbackQuery.data);
  await ctx.answerCallbackQuery(answer ? { text: answer } : {});
  if (answer && !answer.startsWith('Текст') && answer !== 'Жду правку') await ctx.editMessageReplyMarkup().catch(() => undefined);
});
bot.on('message:text', async (ctx) => {
  if (!ctx.message.text.startsWith('/')) await agent.onText(ctx.from.id, ctx.message.text);
});

schedule('batch', cfg.batchCron, cfg.tz, () => agent.batch().then(() => undefined));

const stop = () => {
  void bot.stop().finally(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

log('info', 'prospector starting', { batchCron: cfg.batchCron, batchSize: cfg.batchSize, callbackPrefix: CB });
startPolling(bot).catch((e) => {
  log('error', 'bot stopped', { err: errMsg(e) });
  process.exit(1);
});
