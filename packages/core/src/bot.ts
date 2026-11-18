import { Bot, type Api } from 'grammy';
import type { ApprovalQueue, Action } from './approvals.js';
import { errMsg, log } from './log.js';
import { stripHtml, type Button, type Messenger, type ReplyKeyboard, type SendOptions } from './messenger.js';

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

const inline = (buttons?: Button[][]) => ({ inline_keyboard: (buttons ?? []).map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) });
const reply = (k: ReplyKeyboard) => ({
  keyboard: k.rows.map((row) => row.map((text) => ({ text }))),
  resize_keyboard: true,
  is_persistent: true,
  ...(k.placeholder ? { input_field_placeholder: k.placeholder.slice(0, 64) } : {}),
});
const notModified = (e: unknown) => /message is not modified/i.test(errMsg(e));

export function grammyMessenger(bot: Bot): Messenger {
  const sendMessage = async (chatId: number, text: string, buttons?: Button[][], opts?: SendOptions): Promise<number> => {
    // HTML cut at a newline could split a tag (a quote over several lines): a too long HTML text goes out as plain parts
    const html = Boolean(opts?.html) && text.length <= TG_MAX;
    const parts = splitForTelegram(opts?.html && !html ? stripHtml(text) : text);
    let id = 0;
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1;
      const markup = !last ? undefined : buttons ? inline(buttons) : opts?.keyboard ? reply(opts.keyboard) : undefined;
      const m = await bot.api.sendMessage(chatId, parts[i] ?? '', {
        ...(markup ? { reply_markup: markup } : {}),
        ...(html ? { parse_mode: 'HTML' as const } : {}),
        link_preview_options: { is_disabled: true },
      });
      id = m.message_id;
    }
    return id;
  };
  return {
    async send(chatId, text, buttons, opts) {
      await sendMessage(chatId, text, buttons, opts);
    },
    sendMessage,
    async edit(chatId, messageId, text, opts) {
      try {
        const html = Boolean(opts?.html) && text.length <= 4096;
        const body = opts?.html && !html ? stripHtml(text) : text;
        await bot.api.editMessageText(chatId, messageId, body.length > 4096 ? `${body.slice(0, 4090)}…` : body, {
          link_preview_options: { is_disabled: true },
          ...(html ? { parse_mode: 'HTML' as const } : {}),
          ...(opts?.buttons ? { reply_markup: inline(opts.buttons) } : {}),
        });
      } catch (e) {
        if (!notModified(e)) throw e;
      }
    },
    async editButtons(chatId, messageId, buttons) {
      try {
        await bot.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: inline(buttons ?? []) });
      } catch (e) {
        if (!notModified(e)) throw e;
      }
    },
  };
}

export interface BotCommand {
  command: string;
  description: string;
}

export interface BotMenu {
  /** Shown to everyone (keep it short: most bots answer only their owner). */
  commands?: BotCommand[];
  /** The owner's own list, scoped to his private chat. */
  ownerCommands?: { chatId: number; commands: BotCommand[] };
  /** «What can this bot do?» on an empty chat, ≤ 512 characters. */
  description?: string;
  /** The profile «about» text, ≤ 120 characters. */
  shortDescription?: string;
  /** The menu button next to the input field opens the command list (in the owner's chat). */
  menuButtonChatId?: number;
}

/**
 * Commands with descriptions, descriptions and the menu button: one call at startup. Telegram limits: command 1–32
 * characters `[a-z0-9_]`, description 1–256, at most 100 commands. Every step is separate; errors are only logged.
 */
export async function setupBotMenu(api: Api, menu: BotMenu, name = 'bot'): Promise<number> {
  const clean = (list: BotCommand[]) =>
    list.filter((c) => /^[a-z0-9_]{1,32}$/.test(c.command) && c.description.trim()).slice(0, 100).map((c) => ({ command: c.command, description: c.description.slice(0, 256) }));
  const steps: [string, () => Promise<unknown>][] = [];
  if (menu.commands) steps.push(['commands', () => api.setMyCommands(clean(menu.commands!))]);
  if (menu.ownerCommands) {
    const o = menu.ownerCommands;
    steps.push(['owner commands', () => api.setMyCommands(clean(o.commands), { scope: { type: 'chat', chat_id: o.chatId } })]);
  }
  if (menu.description !== undefined) steps.push(['description', () => api.setMyDescription(menu.description!.slice(0, 512))]);
  if (menu.shortDescription !== undefined) steps.push(['short description', () => api.setMyShortDescription(menu.shortDescription!.slice(0, 120))]);
  if (menu.menuButtonChatId !== undefined) steps.push(['menu button', () => api.setChatMenuButton({ chat_id: menu.menuButtonChatId!, menu_button: { type: 'commands' } })]);
  let ok = 0;
  for (const [step, run] of steps) {
    try {
      await run();
      ok++;
    } catch (e) {
      log('warn', 'bot menu step failed', { bot: name, step, err: errMsg(e) });
    }
  }
  return ok;
}

const ACTIONS: Record<string, Action> = { a: 'approve', e: 'edit', r: 'reject' };

export interface InstallApprovalsOptions {
  /** Owner texts that are never an edit (the reply keyboard buttons): they go on to the app's handlers. */
  passthrough?: (text: string) => boolean;
}

/**
 * Wires the approval buttons and the owner's "edit" reply. Install BEFORE the app's own message
 * handlers: the edit reply must be consumed here and never reach the client dialogue.
 * Only the owner's id is accepted for everything here. After a decision the card is edited in place
 * (with a card format on the queue) or loses its buttons.
 */
export function installApprovals(bot: Bot, queue: ApprovalQueue, ownerId: number, opts: InstallApprovalsOptions = {}): void {
  bot.on('callback_query:data', async (ctx, next) => {
    const m = /^ap:(\d+):([aer])$/.exec(ctx.callbackQuery.data);
    if (!m) return next();
    const id = Number(m[1]);
    const answer = await queue.handle(ACTIONS[m[2]!]!, id, ctx.from.id);
    await ctx.answerCallbackQuery({ text: answer }).catch(() => undefined);
    if (ctx.from.id !== ownerId) return;
    const msg = ctx.callbackQuery.message;
    const settled = msg ? await queue.settleCard(id, { chatId: msg.chat.id, messageId: msg.message_id }).catch(() => false) : false;
    if (!settled) await ctx.editMessageReplyMarkup().catch(() => undefined);
  });
  bot.on('message:text', async (ctx, next) => {
    if (ctx.from.id === ownerId && ctx.chat.type === 'private' && queue.awaitingEdit && !opts.passthrough?.(ctx.message.text)) {
      if (await queue.submitEdit(ctx.from.id, ctx.message.text)) return;
    }
    return next();
  });
}

/** Long polling; resolves when the bot stops. */
export function startPolling(bot: Bot): Promise<void> {
  return bot.start({ onStart: (me) => log('info', 'bot started', { username: me.username }) });
}
