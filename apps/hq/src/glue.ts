import type { Bot } from 'grammy';
import { errMsg, installApprovals, log, type ApprovalQueue } from '@fir/core';
import type { Director } from './director.js';
import type { MarketingHead } from './heads/marketing.js';
import { parseCopy, type SalesHead } from './heads/sales.js';
import type { OwnerChannel } from './presence.js';
import { menuCommand } from './tg.js';
import type { TopicManager } from './topics.js';
import { COMMAND_NAMES } from './commands.js';

export interface GlueDeps {
  ownerId: number;
  channel: OwnerChannel;
  queue: ApprovalQueue;
  director: Director;
  marketing: MarketingHead;
  sales: SalesHead;
  topicManager: TopicManager;
}

/**
 * The Telegram glue of the owner's bot, in the order the handlers must run (group events, owner-only gate, the button handlers,
 * the core's approval buttons, commands, free text). Moved out of `index.ts` unchanged so the drill suite can feed it updates.
 */
export function installOwnerGlue(bot: Bot, d: GlueDeps): void {
  const { ownerId, channel, queue, director, marketing, sales, topicManager } = d;
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
    if (ctx.from?.id === ownerId && ctx.chat?.type === 'private') await channel.asReply(() => next());
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
  installApprovals(bot, queue, ownerId, { passthrough: (text) => text.startsWith('/') || menuCommand(text) !== null });
  // Anything else (an old card from before a restart, a button of a removed feature): answered, never left spinning.
  bot.on('callback_query:data', async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'Устарело' }).catch(() => undefined);
  });

  // every command of the one list (`commands.ts`): the same names feed /help, the menu and these handlers
  const botCommands = COMMAND_NAMES;
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
}
