import type { Bot } from 'grammy';
import { errMsg, escapeHtml, installApprovals, log, type ApprovalQueue } from '@fir/core';
import type { OwnerAssistant } from './assistant.js';
import type { Director } from './director.js';
import type { MarketingHead } from './heads/marketing.js';
import { parseCopy, type SalesHead } from './heads/sales.js';
import type { PultLinks } from './links.js';
import type { OwnerChannel } from './presence.js';
import { menuCommand } from './tg.js';
import type { TopicManager } from './topics.js';

export interface GlueDeps {
  ownerId: number;
  channel: OwnerChannel;
  queue: ApprovalQueue;
  director: Director;
  marketing: MarketingHead;
  sales: SalesHead;
  topicManager: TopicManager;
  /** The owner's questions (any text): answered from the data of HQ (`assistant.ts`). */
  assistant: OwnerAssistant;
  links: PultLinks;
  /** `TG_APPROVAL_CARDS=on`: the old approval cards and their buttons (and «Править» by text) work again. Off: decisions only in the review center. */
  cards?: boolean;
}

/** The two commands left in the bot (owner 2026-11-22: «никаких функций»): what the bot is, and the link to the Пульт. */
export const TG_COMMANDS: { command: string; description: string }[] = [
  { command: 'start', description: 'Что умеет Shell и ссылка на Пульт' },
  { command: 'pult', description: 'Открыть Пульт: управление компанией' },
];

/**
 * The Telegram glue of the one HQ bot, in the order the handlers must run: group events, the owner-only gate, the buttons (old cards answer
 * «решения в Пульте»; with `cards` the legacy approval buttons), `/start` and `/pult`, then every other text is a question to the assistant.
 * The Director's commands, the reply keyboard and the task cards are gone from Telegram: the same actions live in the Пульт (admin API).
 */
export function installOwnerGlue(bot: Bot, d: GlueDeps): void {
  const { ownerId, channel, director, topicManager, assistant, links } = d;
  const background = (name: string, run: () => Promise<void>) => void run().catch((e) => log('error', 'owner message failed', { cmd: name, err: errMsg(e) }));
  /** Plain text to the owner in this chat (inside the reply scope it goes to Telegram and is kept in the inbox as a reply). */
  const answer = (text: string) => channel.sendMessage(ownerId, escapeHtml(text), undefined, { html: true }).then(() => undefined);
  /** P-17: what the owner wrote in Telegram and what HQ answered, for the site's «Поручения» (the question path is recorded by the assistant itself). */
  const note = (role: 'owner' | 'command' | 'hq', text: string) => { try { assistant.history.add(role, text, undefined, 'telegram'); } catch (e) { log('warn', 'history write failed', { err: errMsg(e) }); } };
  const answerNoted = async (text: string) => { note('hq', text); await answer(text); };

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

  if (d.cards) installLegacyCards(bot, d);
  else {
    // A card or a button from before the switch: answered with where decisions live now, never left spinning.
    bot.on('callback_query:data', async (ctx) => {
      await ctx.answerCallbackQuery({ text: 'Решения теперь в Пульте, в ревью-центре' }).catch(() => undefined);
    });
  }

  bot.command('start', (ctx) => background('start', async () => {
    // the old reply keyboard (Одобрения, Задачи, Статус...) goes away with this message
    const text = assistant.help();
    note('command', '/start');
    note('hq', text);
    try {
      await ctx.reply(text, { reply_markup: { remove_keyboard: true }, link_preview_options: { is_disabled: true } });
      channel.record('reply', text);
    } catch {
      await answer(text);
    }
  }));
  bot.command('pult', () => background('pult', async () => { note('command', '/pult'); await answerNoted(`Пульт: ${links.to('home')}\nОдобрения: ${links.to('review')}`); }));
  // Any other text is a question, answered in the background (the next update is not held). An old /command gets a short hint instead.
  bot.on('message:text', (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) {
      note('command', text.slice(0, 200));
      background('unknown', () => answerNoted(`Команд в Telegram больше нет, управление в Пульте: ${links.to('home')}. Спросите обычным текстом, например «что висит?».`));
      return;
    }
    background('question', async () => {
      // with the legacy cards an «Править» waits for the owner's next text first
      if (d.cards && (await director.consumeEdit(text))) { note('owner', text); return; }
      await answer(await assistant.answer(text));
    });
  });
}

/**
 * The approval cards of the old Director bot, behind `TG_APPROVAL_CARDS=on` (kept so a fallback and the drill still work): the Director's buttons,
 * the Scout's «Скопировать», «Править» on content, the core approval buttons and their edit text. Moved here unchanged.
 */
function installLegacyCards(bot: Bot, d: GlueDeps): void {
  const { ownerId, queue, director, marketing, sales } = d;
  // «/skip» leaves a pending «Править» (the one command the old cards still need)
  bot.command('skip', (ctx) => void director.onCommand('skip').catch((e) => log('error', 'owner message failed', { cmd: 'skip', err: errMsg(e) })).then(() => void ctx));
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
}
