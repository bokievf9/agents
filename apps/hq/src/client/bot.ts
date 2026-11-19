import { Bot, GrammyError, type Context } from 'grammy';
import { createBot, errMsg, log, startPolling, type Button, type Db, type LlmClient } from '@fir/core';
import type { BotProbe } from '@fir/worker-monitoring';
import { ClientBlockedError, type ClientChannel } from './channel.js';
import type { CounterStore } from './sanitize.js';
import { ClientEngine, type ClientSinks, type ClientTransport, type From } from './engine.js';
import { COMMANDS, OWNER_COMMANDS, PROFILE } from './texts.js';

const keyboard = (buttons?: Button[][]) => ({ inline_keyboard: (buttons ?? []).map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) });

/** Telegram over grammy: HTML, no link previews, 403 becomes `ClientBlockedError`. */
export function grammyTransport(bot: Bot): ClientTransport {
  return {
    async send(chatId, html, buttons, opts) {
      try {
        const m = await bot.api.sendMessage(chatId, html, {
          parse_mode: 'HTML', link_preview_options: { is_disabled: true },
          ...(buttons ? { reply_markup: keyboard(buttons) } : {}), ...(opts?.silent ? { disable_notification: true } : {}),
        });
        return m.message_id;
      } catch (e) {
        if (e instanceof GrammyError && e.error_code === 403) throw new ClientBlockedError(chatId);
        throw e;
      }
    },
    async edit(chatId, messageId, html, buttons) {
      try {
        await bot.api.editMessageText(chatId, messageId, html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: keyboard(buttons) });
      } catch (e) {
        if (e instanceof GrammyError && /not modified/i.test(e.description)) return;
        throw e;
      }
    },
    async clearButtons(chatId, messageId) {
      await bot.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: keyboard() }).catch(() => undefined);
    },
    async typing(chatId) {
      await bot.api.sendChatAction(chatId, 'typing').catch(() => undefined);
    },
  };
}

export interface ClientBotOptions {
  token: string;
  db: Db;
  now: () => number;
  tz: () => string;
  llm: LlmClient;
  ownerId: number;
  instructions: string;
  quietHours: string;
  perHour: number;
  dailyCap: number;
  counter?: CounterStore;
  ownerFallback?: (text: string) => Promise<void>;
}

const MEDIA: [string, string][] = [
  ['message:photo', 'фото'], ['message:voice', 'голосовое'], ['message:video', 'видео'], ['message:video_note', 'кружок'], ['message:document', 'файл'],
  ['message:sticker', 'стикер'], ['message:audio', 'аудио'], ['message:animation', 'GIF'], ['message:location', 'геолокация'], ['message:contact', 'контакт'],
];

/**
 * The public client bot (`CLIENT_BOT_TOKEN`): a separate grammy bot with long polling in the HQ process. Private chats
 * only (groups and channels are ignored). Updates of one chat run one after another, different chats in parallel, so a
 * slow LLM answer never holds up anyone else. Implements `ClientChannel` for the heads.
 */
export class ClientBot implements ClientChannel {
  readonly bot: Bot;
  readonly engine: ClientEngine;
  private readonly queues = new Map<number, Promise<void>>();
  private startedAt: number | null = null;
  private lastPollAt: number | null = null;
  private pollError: string | null = null;

  constructor(private readonly o: ClientBotOptions) {
    this.bot = createBot(o.token);
    // A completed getUpdates (also an empty one) is a sign that long polling is alive; a hung poll shows as silence.
    this.bot.api.config.use(async (prev, method, payload, signal) => {
      const res = await prev(method, payload, signal);
      if (method === 'getUpdates' && res.ok) this.lastPollAt = o.now();
      return res;
    });
    this.engine = new ClientEngine({
      db: o.db, now: o.now, tz: o.tz, transport: grammyTransport(this.bot), llm: o.llm, ownerId: o.ownerId, instructions: o.instructions,
      quietHours: o.quietHours, perHour: o.perHour, dailyCap: o.dailyCap, ...(o.counter ? { counter: o.counter } : {}), ...(o.ownerFallback ? { ownerFallback: o.ownerFallback } : {}),
    });
    this.wire();
  }

  connect(sinks: ClientSinks): void {
    this.engine.connect(sinks);
  }

  send(chatId: number, text: string): Promise<void> {
    return this.engine.send(chatId, text);
  }

  /** Per-chat queue: order kept inside a chat, chats independent. Errors are logged, never thrown into grammy. */
  private serial(chatId: number, job: () => Promise<void>): void {
    const prev = this.queues.get(chatId) ?? Promise.resolve();
    const next = prev.then(job).catch((e) => log('error', 'client bot handler failed', { chatId, err: errMsg(e) }));
    this.queues.set(chatId, next);
    void next.finally(() => {
      if (this.queues.get(chatId) === next) this.queues.delete(chatId);
    });
  }

  /** Resolves when every queued update has been handled (tests, graceful stop). */
  async idle(): Promise<void> {
    while (this.queues.size) await Promise.all([...this.queues.values()]);
  }

  private wire(): void {
    const from = (ctx: Context): From => ({
      chatId: ctx.chat!.id, username: ctx.from?.username, firstName: ctx.from?.first_name, langCode: ctx.from?.language_code,
    });
    // Private chats with a real person only: groups, channels and other bots are ignored silently.
    this.bot.use(async (ctx, next) => {
      if (ctx.chat?.type === 'private' && ctx.from && !ctx.from.is_bot) await next();
    });
    this.bot.on('callback_query:data', async (ctx) => {
      const f = from(ctx);
      const data = ctx.callbackQuery.data;
      const messageId = ctx.callbackQuery.message?.message_id;
      this.serial(f.chatId, async () => {
        const toast = await this.engine.onButton(f, data, messageId);
        await ctx.answerCallbackQuery(toast ? { text: toast } : undefined).catch(() => undefined);
      });
    });
    this.bot.on('message:text', (ctx) => {
      const f = from(ctx);
      const text = ctx.message.text;
      const replyTo = ctx.message.reply_to_message?.message_id;
      this.serial(f.chatId, () => this.engine.onText(f, text, replyTo));
    });
    for (const [filter, kind] of MEDIA) {
      this.bot.on(filter as 'message:photo', (ctx) => {
        const f = from(ctx);
        this.serial(f.chatId, () => this.engine.onMedia(f, kind));
      });
    }
  }

  /** Menu commands in RU and EN, the owner's own commands in his chat, profile texts. Errors only logged. */
  async setup(): Promise<void> {
    const api = this.bot.api;
    const steps: [string, () => Promise<unknown>][] = [
      ['commands', () => api.setMyCommands(COMMANDS.en)],
      ['commands ru', () => api.setMyCommands(COMMANDS.ru, { language_code: 'ru' })],
      ['commands owner', () => api.setMyCommands(OWNER_COMMANDS, { scope: { type: 'chat', chat_id: this.o.ownerId } })],
      ['description', () => api.setMyDescription(PROFILE.en.description)],
      ['description ru', () => api.setMyDescription(PROFILE.ru.description, { language_code: 'ru' })],
      ['short description', () => api.setMyShortDescription(PROFILE.en.short)],
      ['short description ru', () => api.setMyShortDescription(PROFILE.ru.short, { language_code: 'ru' })],
    ];
    for (const [name, run] of steps) await run().catch((e) => log('warn', 'client bot setup step failed', { step: name, err: errMsg(e) }));
  }

  start(): Promise<void> {
    void this.setup();
    this.startedAt = this.o.now();
    this.pollError = null;
    return startPolling(this.bot).catch((e: unknown) => {
      this.pollError = errMsg(e);
      throw e;
    });
  }

  /** What the monitoring worker asks: last sign of life, `getMe`, and whether polling has crashed. */
  probe(): BotProbe {
    return {
      lastUpdateAt: () => Math.max(this.engine.store.lastActivity() ?? 0, this.lastPollAt ?? 0) || null,
      startedAt: () => this.startedAt,
      getMe: () => this.bot.api.getMe(),
      pollingError: () => this.pollError,
    };
  }

  async stop(): Promise<void> {
    await this.bot.stop();
    await this.idle();
  }
}
