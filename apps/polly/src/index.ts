import { join } from 'node:path';
import { createBot, createLlm, errMsg, grammyMessenger, log, openDb, schedule, startPolling } from '@fir/core';
import { loadConfig } from './config.js';
import { loadContent } from './content.js';
import { PollyStore } from './store.js';
import { Teacher } from './teacher.js';

const cfg = loadConfig();
const content = loadContent(cfg.contentDir);
const db = openDb(join(cfg.dataDir, 'polly.db'));
const bot = createBot(cfg.botToken);
const teacher = new Teacher({ store: new PollyStore(db), messenger: grammyMessenger(bot), llm: createLlm(cfg.llm), content, cfg });

// Polly is the owner's personal teacher: everyone else is ignored silently.
bot.use(async (ctx, next) => {
  if (ctx.from?.id === cfg.ownerId && ctx.chat?.type === 'private') await next();
});

for (const name of ['start', 'help', 'lesson', 'review', 'tones', 'test', 'talk', 'stop', 'profile', 'stats', 'time']) {
  bot.command(name, (ctx) => teacher.onCommand(name, ctx.match));
}
bot.on('callback_query:data', async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup().catch(() => undefined); // one tap per message
  await teacher.onAction(ctx.callbackQuery.data);
});
bot.on('message:voice', (ctx) => teacher.onVoice(ctx.message.voice.file_id, ctx.message.voice.duration));
bot.on('message:text', (ctx) => teacher.onText(ctx.message.text));

schedule('tick', '* * * * *', cfg.tz, () => teacher.tick());

const stop = () => {
  void bot.stop().finally(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

log('info', 'polly starting', { words: content.words.size, lessons: content.lessons.length });
startPolling(bot).catch((e) => {
  log('error', 'bot stopped', { err: errMsg(e) });
  process.exit(1);
});
