import { join } from 'node:path';
import {
  ApprovalQueue, createBot, createLlm, errMsg, grammyMessenger, installApprovals, log, openDb, schedule, startPolling,
} from '@fir/core';
import { KIND_PRICE, KIND_REPLY, LeadAgent } from './agent.js';
import { loadConfig } from './config.js';
import { LeadStore } from './store.js';
import { TEMP_RU } from './text.js';
import { createWebhook } from './webhook.js';

const cfg = loadConfig();
const db = openDb(join(cfg.dataDir, 'lead-intake.db'));
const bot = createBot(cfg.botToken);
const messenger = grammyMessenger(bot);
const llm = createLlm(cfg.llm);
const queue = new ApprovalQueue(db, messenger, cfg.ownerId, cfg.trustThreshold);
const store = new LeadStore(db);
const agent = new LeadAgent({ store, queue, messenger, llm, cfg });

// Approval buttons and the owner's "edit" reply first, then the commands, then the public dialogue.
installApprovals(bot, queue, cfg.ownerId);

const isOwner = (id: number | undefined) => id === cfg.ownerId;

bot.command('leads', async (ctx) => {
  if (!isOwner(ctx.from?.id)) return;
  const rows = store.recent(10).map((l) => `#${l.id} ${TEMP_RU[l.temperature]} ${l.state === 'asking' ? '(опрос)' : ''} ${l.niche || '?'} / ${l.task.slice(0, 40) || '?'}`);
  await ctx.reply(rows.join('\n') || 'Лидов пока нет.');
});
bot.command('trust', async (ctx) => {
  if (!isOwner(ctx.from?.id)) return;
  const rows = queue.trustTable().map((r) => `${r.kind}: уровень ${r.level}, подряд ${r.streak}${r.locked ? ' (заблокирован на 0)' : ''}`);
  await ctx.reply(`${rows.join('\n')}\nLLM: ${llm.enabled ? 'on' : 'off'}`);
});
bot.command('level', async (ctx) => {
  if (!isOwner(ctx.from?.id)) return;
  const [kind, lvl] = ctx.match.trim().split(/\s+/);
  if (![KIND_REPLY, KIND_PRICE].includes(kind ?? '') || (lvl !== '0' && lvl !== '1')) {
    await ctx.reply(`Формат: /level ${KIND_REPLY}|${KIND_PRICE} 0|1`);
    return;
  }
  queue.setLevel(kind!, lvl === '1' ? 1 : 0);
  await ctx.reply(`${kind}: уровень ${lvl}`);
});

bot.on('message:text', async (ctx) => {
  if (isOwner(ctx.from.id) || ctx.chat.type !== 'private') return; // the owner uses commands; groups are ignored
  await agent.onClientMessage({
    chatId: ctx.chat.id,
    name: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' '),
    username: ctx.from.username,
    isBot: ctx.from.is_bot,
    text: ctx.message.text,
  });
});

schedule('stale-leads', '0 10 * * *', cfg.tz, async () => {
  const n = await agent.finalizeStale();
  if (n) log('info', 'stale leads finalized', { count: n });
});

if (cfg.webhookToken) {
  createWebhook(agent, cfg.webhookToken).listen(cfg.webhookPort, '0.0.0.0', () => log('info', 'webhook listening', { port: cfg.webhookPort }));
} else {
  log('warn', 'LEAD_WEBHOOK_TOKEN is not set, POST /lead is disabled');
}

const stop = () => {
  void bot.stop().finally(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

startPolling(bot).catch((e) => {
  log('error', 'bot stopped', { err: errMsg(e) });
  process.exit(1);
});
