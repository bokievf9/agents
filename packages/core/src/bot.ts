import { Bot } from 'grammy';
import type { ApprovalQueue, Action } from './approvals.js';
import { errMsg, log } from './log.js';
import type { Messenger } from './messenger.js';

export function createBot(token: string): Bot {
  const bot = new Bot(token);
  bot.catch((err) => log('error', 'bot handler failed', { err: errMsg(err.error) }));
  return bot;
}

/** Telegram refuses texts over 4096 characters; long ones go out in parts (split at newlines), buttons on the last part. */
export const TG_MAX = 4000;
export function splitForTelegram(text: string, max = TG_MAX): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) parts.push(rest);
  return parts;
}

export function grammyMessenger(bot: Bot): Messenger {
  const sendMessage = async (chatId: number, text: string, buttons?: { text: string; data: string }[][]): Promise<number> => {
    const parts = splitForTelegram(text);
    let id = 0;
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1;
      const m = await bot.api.sendMessage(chatId, parts[i] ?? '', {
        ...(buttons && last
          ? { reply_markup: { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) } }
          : {}),
        link_preview_options: { is_disabled: true },
      });
      id = m.message_id;
    }
    return id;
  };
  return {
    async send(chatId, text, buttons) {
      await sendMessage(chatId, text, buttons);
    },
    sendMessage,
    async edit(chatId, messageId, text) {
      try {
        await bot.api.editMessageText(chatId, messageId, text.length > 4096 ? `${text.slice(0, 4090)}…` : text, { link_preview_options: { is_disabled: true } });
      } catch (e) {
        if (!/message is not modified/i.test(errMsg(e))) throw e;
      }
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
