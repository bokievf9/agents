import { errMsg, formatSlot, log, type Button, type Db, type LlmClient } from '@fir/core';
import { ClientBlockedError, type ClientChannel } from './channel.js';
import { inWindow, linksOnly, RateLimiter } from './sanitize.js';
import { clip, freeAnswer, GREETING, intakeRecord, TurnHistory } from './shared.js';
import { ChatStore, maskUsername, textHash, type Chat, type Draft } from './store.js';
import {
  BUDGETS, budgetButtons, DEADLINES, deadlineButtons, esc, menuButtons, NEEDS, needButtons, T, type Budget, type Deadline, type Lang, type Need,
} from './texts.js';

/** What the engine needs from Telegram; the grammy bot implements it, tests keep everything in memory. */
export interface ClientTransport {
  /** Sends HTML, returns the message id. Throws `ClientBlockedError` on 403. */
  send(chatId: number, html: string, buttons?: Button[][], opts?: { silent?: boolean }): Promise<number>;
  /** Replaces the text and keyboard of a message (no buttons: the keyboard disappears). */
  edit(chatId: number, messageId: number, html: string, buttons?: Button[][]): Promise<void>;
  clearButtons(chatId: number, messageId: number): Promise<void>;
  typing(chatId: number): Promise<void>;
}

/** Who wrote: Telegram's `from` of a private chat (chat id = user id there). */
export interface From {
  chatId: number;
  username?: string | undefined;
  firstName?: string | undefined;
  langCode?: string | undefined;
}

/** The company behind the bot: the Sales and Support heads, wired in `index.ts`. */
export interface ClientSinks {
  /** Same as `POST /lead`: a Sales task with `meta.lead`. Returns the task id. */
  createLead(lead: Record<string, unknown>, service: string): number;
  /** A ticket task for a known client, with the chat id. Returns the task id. */
  createTicket(client: string, text: string, chatId?: number): Promise<number>;
  /** The client's name when the company name or invoice number is known to Support or billing. */
  findClient(query: string): string | null;
  /** The call slots offered to the lead of a task (for a «1» / «2» answer). */
  leadSlots(taskId: number): { leadId: number; slots: number[] } | null;
}

export interface ClientEngineDeps {
  db: Db;
  now: () => number;
  tz: () => string;
  transport: ClientTransport;
  llm: LlmClient;
  ownerId: number;
  /** System prompt source: `instructions/client-bot.md`. */
  instructions: string;
  /** «22:00-08:00» in the company timezone: templates only, no LLM, «a person answers in the morning». */
  quietHours?: string;
  /** Messages per chat per hour, LLM calls per day for all chats. */
  perHour?: number;
  dailyCap?: number;
  sinks?: ClientSinks;
  /** Plain text to the owner through the Director when the client bot cannot write to him (he never opened it). */
  ownerFallback?: (text: string) => Promise<void>;
}

/**
 * The public client bot («лицо компании»): welcome and menu, a 3-step project intake that becomes a Sales lead, «я уже
 * клиент» that becomes a Support ticket, «позвать человека» that hands the chat to the owner, and a free conversation
 * answered by the LLM within strict rules (sanitised, rate limited, round the clock; quiet hours only mean a human answers in the morning). Approved replies of the heads
 * come back through `deliver`. Stores per chat only the `cb_chats` row; client texts go into lead and ticket records
 * the way the website form does, never into logs.
 */
export class ClientEngine implements ClientChannel {
  readonly store: ChatStore;
  readonly limiter: RateLimiter;
  private sinks: ClientSinks | undefined;
  private readonly history: TurnHistory<number>;

  constructor(private readonly d: ClientEngineDeps) {
    this.store = new ChatStore(d.db, d.now);
    this.limiter = new RateLimiter(d.perHour ?? 20, d.dailyCap ?? 300, d.now, d.tz);
    this.sinks = d.sinks;
    this.history = new TurnHistory(d.now);
  }

  connect(sinks: ClientSinks): void {
    this.sinks = sinks;
  }

  isNight(at = this.d.now()): boolean {
    return inWindow(at, this.d.tz(), this.d.quietHours ?? '22:00-08:00');
  }

  // ---- ClientChannel: approved texts from the heads ----
  async send(chatId: number, text: string): Promise<void> {
    try {
      await this.d.transport.send(chatId, esc(text));
    } catch (e) {
      if (e instanceof ClientBlockedError) this.store.update(chatId, { blocked: true });
      throw e;
    }
    this.remember(chatId, 'assistant', text);
  }

  // ---- entry points (the grammy glue calls these, private chats only) ----
  async onCommand(from: From, name: string, arg: string): Promise<void> {
    if (from.chatId === this.d.ownerId) return this.ownerCommand(name, arg.trim());
    const chat = this.chat(from);
    if (this.limiter.hit(chat.chatId) === 'drop') return;
    switch (name) {
      case 'start':
        return this.welcome(chat, from);
      case 'human':
        return this.callHuman(chat);
      case 'lang': {
        const lang: Lang = chat.lang === 'ru' ? 'en' : 'ru';
        this.store.update(chat.chatId, { lang });
        return this.welcome({ ...chat, lang }, from);
      }
      default:
        await this.say(chat.chatId, T[chat.lang].help);
    }
  }

  async onText(from: From, raw: string, replyTo?: number): Promise<void> {
    if (from.chatId === this.d.ownerId) return this.ownerText(raw, replyTo);
    const cmd = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(raw.trim());
    if (cmd) return this.onCommand(from, cmd[1]!.toLowerCase(), cmd[2] ?? '');
    const first = this.chat(from);
    let chat: Chat = first;
    const rate = this.limiter.hit(chat.chatId);
    if (rate === 'drop') return;
    if (rate === 'warn') {
      await this.say(chat.chatId, T[chat.lang].slow);
      await this.notifyOwner(`⏸ <b>Лимит сообщений</b> · ${this.who(chat)}\nБольше ${this.d.perHour ?? 20} сообщений за час, бот молчит до конца часа. /reply ${chat.chatId} текст`, chat.chatId);
      return;
    }
    if (this.isSpam(chat, raw)) {
      log('info', 'client bot spam dropped', { chatId: chat.chatId });
      return;
    }
    const text = raw.trim().slice(0, 2000);
    // A new person who just writes: the welcome first; a bare greeting needs nothing more.
    if (first.fresh) {
      await this.welcome(chat, from);
      if (GREETING.test(text)) return;
    }
    chat = this.store.get(chat.chatId)!;
    switch (chat.state) {
      case 'need':
      case 'need_text':
        return this.afterNeed(chat, { needText: clip(text, 1000) });
      case 'deadline':
        return this.afterDeadline(chat, { deadlineText: clip(text, 100) });
      case 'budget':
        return this.finishIntake(chat, from, { budgetText: clip(text, 40) });
      case 'client_name':
        return this.afterClientName(chat, text);
      case 'client_question':
        return this.afterClientQuestion(chat, from, text);
      default:
    }
    if (chat.muted) return this.forward(chat, text, 'Сообщение (бот молчит, ждёт вас)');
    if (await this.slotPick(chat, text)) return;
    await this.answer(chat, text);
  }

  /** A photo, voice, sticker or file: text only for now. */
  async onMedia(from: From, kind: string): Promise<void> {
    if (from.chatId === this.d.ownerId) return;
    const chat = this.chat(from);
    if (this.limiter.hit(chat.chatId) !== 'ok') return;
    if (chat.muted) return this.forward(chat, `[${kind}: бот читает только текст, содержимое не передаётся]`, 'Вложение (бот молчит)');
    await this.say(chat.chatId, T[chat.lang].textOnly);
  }

  /** An inline button. Returns the toast text (or nothing). */
  async onButton(from: From, data: string, messageId?: number): Promise<string | undefined> {
    if (from.chatId === this.d.ownerId) return undefined;
    const chat = this.chat(from);
    const [kind, key = ''] = data.split(':');
    if (kind === 'm') {
      await this.menu(chat, from, key, messageId);
      return undefined;
    }
    const stale = async () => {
      if (messageId !== undefined) await this.d.transport.clearButtons(chat.chatId, messageId).catch(() => undefined);
      return T[chat.lang].stale;
    };
    if (messageId === undefined || chat.card !== messageId) return stale();
    if (kind === 'n' && chat.state === 'need' && (NEEDS as readonly string[]).includes(key)) {
      if (key === 'other') {
        this.store.update(chat.chatId, { state: 'need_text' });
        await this.edit(chat.chatId, messageId, T[chat.lang].step1Text);
        return undefined;
      }
      await this.afterNeed(chat, { need: key as Need }, messageId);
      return undefined;
    }
    if (kind === 'd' && chat.state === 'deadline' && (DEADLINES as readonly string[]).includes(key)) {
      await this.afterDeadline(chat, { deadline: key as Deadline }, messageId);
      return undefined;
    }
    if (kind === 'b' && chat.state === 'budget' && (BUDGETS as readonly string[]).includes(key)) {
      await this.finishIntake(chat, from, { budget: key as Budget }, messageId);
      return undefined;
    }
    return stale();
  }

  // ---- welcome, menu ----
  /** The chat row, created on first contact (`fresh`): the language comes from Telegram's `language_code` then. */
  private chat(from: From): Chat & { fresh: boolean } {
    const existing = this.store.get(from.chatId);
    const lang: Lang = existing?.lang ?? (from.langCode?.toLowerCase().startsWith('en') ? 'en' : 'ru');
    return { ...this.store.touch(from.chatId, from.username ?? '', lang), fresh: !existing };
  }

  private async welcome(chat: Chat, from: From): Promise<void> {
    await this.dropCard(chat);
    const id = await this.say(chat.chatId, T[chat.lang].welcome(from.firstName ?? ''), menuButtons(chat.lang));
    this.store.update(chat.chatId, { state: 'idle', draft: {}, card: id });
  }

  private async menu(chat: Chat, from: From, key: string, messageId: number | undefined): Promise<void> {
    const onCard = messageId !== undefined && messageId === chat.card;
    // A menu under an older answer: its keyboard goes, the next step comes as a new message.
    if (messageId !== undefined && !onCard) await this.d.transport.clearButtons(chat.chatId, messageId).catch(() => undefined);
    const t = T[chat.lang];
    switch (key) {
      case 'discuss': {
        this.store.update(chat.chatId, { state: 'need', draft: {} });
        if (onCard) await this.edit(chat.chatId, messageId!, t.step1, needButtons(chat.lang));
        else {
          await this.dropCard(chat);
          this.store.update(chat.chatId, { card: await this.say(chat.chatId, t.step1, needButtons(chat.lang)) });
        }
        return;
      }
      case 'client': {
        this.store.update(chat.chatId, { state: 'client_name', draft: {}, card: null });
        if (onCard) await this.edit(chat.chatId, messageId!, t.askClient);
        else {
          await this.dropCard(chat);
          await this.say(chat.chatId, t.askClient);
        }
        return;
      }
      case 'human':
        return this.callHuman(chat);
      case 'lang': {
        const lang: Lang = chat.lang === 'ru' ? 'en' : 'ru';
        this.store.update(chat.chatId, { lang, state: 'idle', draft: {} });
        if (onCard) await this.edit(chat.chatId, messageId!, T[lang].welcome(from.firstName ?? ''), menuButtons(lang));
        else await this.welcome({ ...chat, lang }, from);
        return;
      }
      default:
    }
  }

  // ---- the 3-step intake ----
  /** Step 1 answered (button or text): step 2 in the same card when it was a button, else a new card. */
  private async afterNeed(chat: Chat, patch: Draft, messageId?: number): Promise<void> {
    const draft = { ...chat.draft, ...patch };
    this.store.update(chat.chatId, { state: 'deadline', draft });
    await this.nextCard(chat, T[chat.lang].step2, deadlineButtons(chat.lang), messageId);
  }

  private async afterDeadline(chat: Chat, patch: Draft, messageId?: number): Promise<void> {
    this.store.update(chat.chatId, { state: 'budget', draft: { ...chat.draft, ...patch } });
    await this.nextCard(chat, T[chat.lang].step3, budgetButtons(chat.lang), messageId);
  }

  private async nextCard(chat: Chat, html: string, buttons: Button[][], messageId?: number): Promise<void> {
    if (messageId !== undefined) return this.edit(chat.chatId, messageId, html, buttons);
    await this.dropCard(chat);
    this.store.update(chat.chatId, { card: await this.say(chat.chatId, html, buttons) });
  }

  private async finishIntake(chat: Chat, from: From, patch: Draft, messageId?: number): Promise<void> {
    const d: Draft = { ...chat.draft, ...patch };
    const t = T[chat.lang];
    const rec = intakeRecord(d, chat.lang, 'Заявка из клиентского Telegram-бота.');
    const night = this.isNight();
    const done = `${t.done(rec.shown.need, rec.shown.deadline, rec.shown.budget)}${night ? `\n${t.doneNight}` : ''}`;
    if (messageId !== undefined) await this.edit(chat.chatId, messageId, done);
    else {
      await this.dropCard(chat);
      await this.say(chat.chatId, done);
    }
    await this.createLead(chat, from, { message: rec.message, budget: rec.budget, service: rec.service }, rec.masked);
  }

  /** The lead goes to Sales exactly like a website form lead, with the chat id so replies come back here. */
  private async createLead(chat: Chat, from: From, x: { message: string; budget: string; service: string }, masked: string): Promise<void> {
    this.store.update(chat.chatId, { state: 'idle', draft: {}, card: null });
    if (!this.sinks) {
      await this.forward(chat, x.message, 'Заявка (продажи не подключены)');
      return;
    }
    const name = clip(from.firstName?.trim() || (from.username ? `@${from.username}` : '') || 'Клиент из Telegram', 80);
    const lead = {
      name, contact: from.username ? `@${from.username}` : `Telegram id ${chat.chatId}`, service: x.service, budget: clip(x.budget, 40),
      message: clip(x.message, 2000), estimate: '', locale: chat.lang, slot: '', source: 'telegram', chatId: chat.chatId,
      ...(from.username ? { username: from.username.slice(0, 40) } : {}),
    };
    const taskId = this.sinks.createLead(lead, x.service);
    this.store.update(chat.chatId, { leadTask: taskId, summary: `${masked} · задача #${taskId}` });
    log('info', 'client bot lead', { chatId: chat.chatId, taskId });
    await this.notifyOwner(
      `🆕 <b>Заявка в клиентском боте</b> · ${this.who(chat)}\n${esc(masked)}, задача продаж #${taskId}. Первый ответ бот отправит сам (уровень lead_reply), всё с ценой придёт вам на одобрение.`,
      chat.chatId,
    );
  }

  // ---- «Я уже клиент» ----
  private async afterClientName(chat: Chat, text: string): Promise<void> {
    const query = clip(text, 80);
    const found = this.sinks?.findClient(query) ?? null;
    // The same answer either way: the bot never confirms to a stranger who is a client.
    this.store.update(chat.chatId, { state: 'client_question', draft: found ? { client: found } : { client: null, clientQuery: query } });
    await this.say(chat.chatId, T[chat.lang].askQuestion);
  }

  private async afterClientQuestion(chat: Chat, from: From, text: string): Promise<void> {
    const t = T[chat.lang];
    const night = this.isNight();
    const client = chat.draft.client;
    if (client && this.sinks) {
      this.store.update(chat.chatId, { state: 'idle', draft: {} });
      await this.say(chat.chatId, t.ticketAck(night));
      const taskId = await this.sinks.createTicket(client, clip(text, 2000), chat.chatId);
      this.store.update(chat.chatId, { summary: `клиент: тикет, задача #${taskId}` });
      log('info', 'client bot ticket', { chatId: chat.chatId, taskId });
      await this.notifyOwner(`🧾 <b>Клиент написал в бот</b> · ${this.who(chat)}\nКлиент ${esc(client)}, задача сопровождения #${taskId}. Ответ по справке уйдёт сам, остальное придёт на одобрение.`, chat.chatId);
      return;
    }
    await this.say(chat.chatId, t.clientLeadAck(night));
    const message = `Пишет как клиент («${chat.draft.clientQuery ?? '?'}»), в базе клиентов не найден.\nВопрос: ${text}`;
    await this.createLead(chat, from, { message, budget: '', service: 'other' }, 'пишет как клиент, не найден');
  }

  // ---- «Позвать человека» ----
  private async callHuman(chat: Chat): Promise<void> {
    const t = T[chat.lang];
    if (chat.muted) {
      await this.say(chat.chatId, t.humanAlready);
      return;
    }
    await this.dropCard(chat);
    this.store.update(chat.chatId, { muted: true, state: 'idle', draft: {}, card: null, summary: `${chat.summary ? `${chat.summary} · ` : ''}позвал человека` });
    await this.say(chat.chatId, t.human(this.isNight()));
    const link = chat.username ? `https://t.me/${esc(chat.username)}` : `tg://user?id=${chat.chatId}`;
    await this.notifyOwner(
      `👤 <b>Зовут человека</b> · ${this.who(chat)} · ${chat.lang}\n<a href="${link}">Открыть профиль</a>\nСводка: ${esc(chat.summary || 'новый разговор')}\n\n` +
        `Бот в этом чате замолчал и пересылает сообщения сюда. Ответ: ответьте на это сообщение или /reply ${chat.chatId} текст. Вернуть бота: /resume ${chat.chatId}`,
      chat.chatId,
    );
  }

  // ---- free conversation ----
  /** «1» or «2» after the first reply with two call slots. */
  private async slotPick(chat: Chat, text: string): Promise<boolean> {
    const m = /^\s*([12])\s*[.)]?\s*$/.exec(text);
    if (!m || !chat.leadTask || !this.sinks) return false;
    const lead = this.sinks.leadSlots(chat.leadTask);
    const slot = lead?.slots[Number(m[1]) - 1];
    if (!lead || lead.slots.length < 2 || slot === undefined) return false;
    await this.say(chat.chatId, T[chat.lang].slotPicked(formatSlot(slot, this.d.tz(), chat.lang)));
    this.store.update(chat.chatId, { summary: `${chat.summary} · выбрал звонок` });
    await this.notifyOwner(`📞 <b>Лид #${lead.leadId} выбрал звонок</b> · ${this.who(chat)}\n${esc(formatSlot(slot, this.d.tz(), 'ru'))}. Подтвердите: /reply ${chat.chatId} текст`, chat.chatId);
    return true;
  }

  private discussButton(lang: Lang): Button[][] {
    return [[{ text: T[lang].menu.discuss, data: 'm:discuss' }, { text: T[lang].menu.human, data: 'm:human' }]];
  }

  private async answer(chat: Chat, text: string): Promise<void> {
    const t = T[chat.lang];
    const r = await freeAnswer(
      { llm: this.d.llm, instructions: this.d.instructions, gate: this.limiter }, chat.lang, text, this.turns(chat.chatId),
      () => this.d.transport.typing(chat.chatId).catch(() => undefined),
    );
    switch (r.kind) {
      case 'price':
        await this.say(chat.chatId, t.priceAnswer, this.discussButton(chat.lang));
        return;
      case 'fallback':
        return this.fallback(chat, text);
      default:
    }
    await this.say(chat.chatId, esc(r.text));
    this.remember(chat.chatId, 'user', text);
    this.remember(chat.chatId, 'assistant', r.text);
    log('info', 'client bot answer', { chatId: chat.chatId, removed: r.removed, team: r.team, llmToday: this.limiter.llmToday });
    if (r.team || r.removed > 0) await this.forward(chat, text, r.team ? 'Нужен человек (вопрос к команде)' : 'Вопрос о цене или сроках');
  }

  private async fallback(chat: Chat, text: string): Promise<void> {
    await this.say(chat.chatId, T[chat.lang].fallback);
    await this.forward(chat, text, 'Сообщение без ответа модели');
  }

  private turns(chatId: number) {
    return this.history.turns(chatId);
  }

  private remember(chatId: number, role: 'user' | 'assistant', content: string): void {
    this.history.remember(chatId, role, content);
  }

  /** Links only, or the same text a third time in a row. */
  private isSpam(chat: Chat, text: string): boolean {
    if (linksOnly(text)) return true;
    const hash = textHash(text);
    const repeats = hash === chat.lastHash ? chat.repeats + 1 : 0;
    this.store.update(chat.chatId, { lastHash: hash, repeats });
    return repeats >= 2;
  }

  // ---- owner side (his private chat with the client bot) ----
  private async ownerCommand(name: string, arg: string): Promise<void> {
    const target = /^(\d+)(?:\s+([\s\S]+))?$/.exec(arg);
    const known = target ? this.store.get(Number(target[1])) : undefined;
    switch (name) {
      case 'chats':
        await this.ownerSay(this.chatsText());
        return;
      case 'mute':
      case 'resume': {
        if (!known) return void (await this.ownerSay(`Формат: /${name} <chatId>, номера в /chats.`));
        this.store.update(known.chatId, { muted: name === 'mute' });
        await this.ownerSay(name === 'mute' ? `Бот молчит в чате ${known.chatId}, сообщения клиента приходят сюда.` : `Бот снова отвечает в чате ${known.chatId}.`);
        return;
      }
      case 'reply': {
        if (!known || !target?.[2]?.trim()) return void (await this.ownerSay('Формат: /reply <chatId> текст. Номера в /chats, или ответьте на уведомление о клиенте.'));
        await this.relay(known.chatId, target[2].trim());
        return;
      }
      default:
        await this.ownerSay(
          '<b>Клиентский бот: команды владельца</b>\n/chats: последние разговоры\n/reply &lt;chatId&gt; текст: ответить клиенту (или ответьте на уведомление)\n/mute &lt;chatId&gt;: бот молчит в чате\n/resume &lt;chatId&gt;: бот снова отвечает\n\nОстальное, как всегда, через Директора.',
        );
    }
  }

  private async ownerText(text: string, replyTo?: number): Promise<void> {
    const cmd = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
    if (cmd) return this.ownerCommand(cmd[1]!.toLowerCase(), (cmd[2] ?? '').trim());
    const chatId = replyTo !== undefined ? this.store.noticeChat(replyTo) : undefined;
    if (chatId === undefined) {
      await this.ownerSay('Чтобы ответить клиенту, ответьте (reply) на уведомление о нём или напишите /reply &lt;chatId&gt; текст. Список: /chats');
      return;
    }
    await this.relay(chatId, text.trim());
  }

  /** The owner's text goes to the client verbatim; the bot stays quiet in that chat until /resume. */
  private async relay(chatId: number, text: string): Promise<void> {
    if (!text) return;
    try {
      await this.send(chatId, text);
    } catch (e) {
      const blocked = e instanceof ClientBlockedError;
      log('warn', 'client bot relay failed', { chatId, blocked });
      await this.ownerSay(blocked ? `Не доставлено: клиент ${chatId} заблокировал бота.` : `Не доставлено в чат ${chatId}: ${esc(errMsg(e)).slice(0, 200)}`);
      return;
    }
    const chat = this.store.get(chatId);
    this.store.update(chatId, { muted: true, ...(chat && !chat.summary.includes('отвечает человек') ? { summary: `${chat.summary ? `${chat.summary} · ` : ''}отвечает человек` } : {}) });
    await this.ownerSay(`Отправлено в чат ${chatId}. Бот там молчит, вернуть: /resume ${chatId}`);
  }

  private chatsText(): string {
    const list = this.store.recent(15);
    if (!list.length) return 'Разговоров пока нет.';
    const now = this.d.now();
    const ago = (t: number) => {
      const m = Math.floor((now - t) / 60_000);
      return m < 60 ? `${m} мин` : m < 1440 ? `${Math.floor(m / 60)} ч` : `${Math.floor(m / 1440)} дн`;
    };
    const lines = list.map((c) => {
      const flags = [c.muted ? 'бот молчит' : '', c.blocked ? 'заблокировал бота' : '', c.state !== 'idle' ? `шаг: ${c.state}` : ''].filter(Boolean).join(', ');
      return `<code>${c.chatId}</code> ${esc(maskUsername(c.username))} · ${c.lang} · ${ago(c.lastAt)} назад${flags ? ` · ${flags}` : ''}\n${esc(c.summary || 'без заявки')}`;
    });
    return `<b>Разговоры</b> (${this.store.count()} всего, LLM сегодня ${this.limiter.llmToday})\n\n${lines.join('\n\n')}`;
  }

  // ---- sending ----
  private who(chat: Chat): string {
    return `<code>${chat.chatId}</code> ${chat.username ? `@${esc(chat.username)}` : 'без username'}`;
  }

  /** A message from the client to the owner; his Telegram reply to it goes back to the client. */
  private async forward(chat: Chat, text: string, why: string): Promise<void> {
    await this.notifyOwner(`💬 <b>${esc(why)}</b> · ${this.who(chat)}\n${esc(clip(text, 1500))}\n\n↩️ Ответьте на это сообщение или /reply ${chat.chatId} текст.`, chat.chatId);
  }

  private async notifyOwner(html: string, chatId: number): Promise<void> {
    try {
      const id = await this.d.transport.send(this.d.ownerId, html, undefined, { silent: this.isNight() });
      this.store.addNotice(id, chatId);
    } catch (e) {
      log('warn', 'client bot cannot write to the owner', { err: errMsg(e) });
      await this.d.ownerFallback?.(`Клиентский бот: ${html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')}\n\n(Откройте клиентский бот и нажмите /start, чтобы отвечать клиентам из него.)`).catch(() => undefined);
    }
  }

  private async ownerSay(html: string): Promise<void> {
    await this.d.transport.send(this.d.ownerId, html).catch((e) => log('warn', 'client bot owner reply failed', { err: errMsg(e) }));
  }

  /** To a client; a block is remembered, other errors are logged. Returns the message id or null. */
  private async say(chatId: number, html: string, buttons?: Button[][]): Promise<number | null> {
    try {
      return await this.d.transport.send(chatId, html, buttons);
    } catch (e) {
      if (e instanceof ClientBlockedError) this.store.update(chatId, { blocked: true });
      else log('warn', 'client bot send failed', { chatId, err: errMsg(e) });
      return null;
    }
  }

  private async edit(chatId: number, messageId: number, html: string, buttons?: Button[][]): Promise<void> {
    await this.d.transport.edit(chatId, messageId, html, buttons).catch((e) => log('warn', 'client bot edit failed', { chatId, err: errMsg(e) }));
  }

  /** The keyboard of the previous card disappears (buttons are used once). */
  private async dropCard(chat: Chat): Promise<void> {
    const cur = this.store.get(chat.chatId);
    if (cur?.card) {
      await this.d.transport.clearButtons(chat.chatId, cur.card).catch(() => undefined);
      this.store.update(chat.chatId, { card: null });
    }
  }
}
