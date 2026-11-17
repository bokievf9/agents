import { Bot } from 'grammy';
import type { ApprovalQueue, Action } from './approvals.js';
import { errMsg, log } from './log.js';
import type { Messenger } from './messenger.js';

export function createBot(token: string): Bot {
  const bot = new Bot(token);
  bot.catch((err) => log('error', 'bot handler failed', { err: errMsg(err.error) }));
  return bot;
}

export function grammyMessenger(bot: Bot): Messenger {
  return {
    async send(chatId, text, buttons) {
      await bot.api.sendMessage(chatId, text, {
        ...(buttons
          ? { reply_markup: { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) } }
          : {}),
        link_preview_options: { is_disabled: true },
      });
    },
  };
}

const ACTIONS: Record<string, Action> = { a: 'approve', e: 'edit', r: 'reject' };

/**
 * Wires the approval buttons and the owner's "edit" reply. Install BEFORE the app's own message
 * handlers: the edit reply must be consumed here and never reach the client dialogue.
 * Only the owner's id is accepted for everything here.
 */
export function installApprovals(bot: Bot, queue: ApprovalQueue, ownerId: number): void {
  bot.on('callback_query:data', async (ctx, next) => {
    const m = /^ap:(\d+):([aer])$/.exec(ctx.callbackQuery.data);
    if (!m) return next();
    const answer = await queue.handle(ACTIONS[m[2]!]!, Number(m[1]), ctx.from.id);
    await ctx.answerCallbackQuery({ text: answer });
    if (ctx.from.id === ownerId) await ctx.editMessageReplyMarkup().catch(() => undefined);
  });
  bot.on('message:text', async (ctx, next) => {
    if (ctx.from.id === ownerId && ctx.chat.type === 'private' && queue.awaitingEdit) {
      if (await queue.submitEdit(ctx.from.id, ctx.message.text)) return;
    }
    return next();
  });
}

/** Long polling; resolves when the bot stops. */
export function startPolling(bot: Bot): Promise<void> {
  return bot.start({ onStart: (me) => log('info', 'bot started', { username: me.username }) });
}
