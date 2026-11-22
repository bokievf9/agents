import { errMsg, formatSlot, log, type Button, type Db, type LlmClient } from '@fir/core';
import { ClientBlockedError, type ClientChannel } from './channel.js';
import { inWindow, linksOnly, RateLimiter, type CounterStore } from './sanitize.js';
import { isPriceQuestion } from '@fir/worker-lead-intake';
import { asksCatalogue } from './needs.js';
import { clip, GREETING, intakeRecord, TurnHistory } from './shared.js';
import { enrichmentOf, newQ, productNamesOf, receptionistTurn, type EnrichmentOut } from './receptionist.js';
import { ChatStore, RefStore, refFromStartArg, textHash, type Chat, type Draft } from './store.js';
import {
  BUDGETS, budgetButtons, DEADLINES, deadlineButtons, esc, haveButtons, HAVES, haveFlags, parseHave, menuButtons, NEEDS, needButtons, productCardButtons, productCardHtml, productListButtons,
  productListHtml, SERVICE, T, X, type Budget, type Deadline, type Have, type Lang, type Need,
} from './texts.js';
import { isCatalogueId, nicheHint } from './products.js';
import { DemoSalon, DEMO_START } from './demo.js';
import { auditInputSchema, type AuditOutcome } from '../audit-shared.js';
import type { LostInfo, LostSource } from '../lost-leads.js';

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
  /** A message of a signed-in cabinet client (web chat): into the client's support thread and a Support ticket. */
  clientMessage?(client: { email: string; name?: string }, text: string): Promise<number | void>;
  /** The client's name when the company name or invoice number is known to Support or billing. */
  findClient(query: string): string | null;
  /** The call slots offered to the lead of a task (for a «1» / «2» answer). */
  leadSlots(taskId: number): { leadId: number; slots: number[] } | null;
  /** P-04: the picked window becomes the lead's call booking in HQ (the site's window, the reminders). Absent: the owner line only, as before. */
  bookCall?(leadId: number, at: number): Promise<void>;
  /** `/audit <url>`: the same path as `POST /audit` (contact is the chat's username, or `tg:<chatId>` with `chatId` for direct delivery). */
  createAudit?(a: { url: string; contact: string; name?: string; locale: Lang; chatId: number }): Promise<AuditOutcome>;
}

/** What the client bot hands to HQ for the owner. `text` is the client's own words (a thread line in the Пульт, never Telegram); no text: a fact only. */
export interface OwnerLine {
  kind: 'human' | 'message' | 'ticket';
  chatId: number;
  /** The client's first name (empty when Telegram gave none). */
  name: string;
  text?: string;
  /** Why the line is there (`Нужен человек`, `Сообщение без ответа модели`...), for the Пульт. */
  why?: string;
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
  /** Where the daily LLM counter is kept between restarts (HQ settings). */
  counter?: CounterStore;
  sinks?: ClientSinks;
  /**
   * The way to the owner (one HQ bot, owner 2026-11-22): the client bot never writes to him. A client who asks for a person, writes after the hand-off or needs an
   * answer becomes a line of his thread in the Пульт and a reminder of the HQ bot (`client-inbox.ts`); the owner answers in `/admin/chats`.
   */
  toOwner?: (line: OwnerLine) => void;
  /** The one line the owner gets when he writes to the client bot himself (where the chats are now). */
  ownerHint?: string;
  /** A request accepted from a person that failed before the owner could see it: `lost_lead` and the hourly alert (see `lost-leads.ts`). */
  onLost?: (source: LostSource, reason: string, info?: LostInfo) => void;
  /** True while the model gateway is known to be down: the free conversation answers with the scripted «принял» and records a lead. */
  gatewayDown?: () => boolean;
  /** How long a person waits for the model before the scripted answer (ms, default 20 s). */
  llmTimeoutMs?: number;
}

/**
 * The public client bot («лицо компании»): welcome and menu, a 3-step project intake that becomes a Sales lead, «я уже
 * клиент» that becomes a Support ticket, «позвать человека» that hands the chat to the owner, and a free conversation
 * answered by the LLM within strict rules (sanitised, rate limited, round the clock; quiet hours only mean a human answers in the morning). Approved replies of the heads
 * come back through `deliver`. Stores per chat only the `cb_chats` row; client texts go into lead and ticket records
 * the way the website form does, never into logs.
 */
/** What the owner reads when he writes to the client bot: the chats are in the Пульт. */
const OWNER_HINT = 'Этот бот для клиентов. Ответы клиентам и возврат бота сценарию: в Shell, раздел «Чаты».';

export class ClientEngine implements ClientChannel {
  readonly store: ChatStore;
  private readonly refs: RefStore;
  readonly limiter: RateLimiter;
  private sinks: ClientSinks | undefined;
  private readonly history: TurnHistory<number>;
  readonly demo: DemoSalon;

  constructor(private readonly d: ClientEngineDeps) {
    this.store = new ChatStore(d.db, d.now);
    this.refs = new RefStore(d.db, d.now);
    this.demo = new DemoSalon(
      d.db, d.now, d.tz,
      { send: (chatId, html, buttons) => this.say(chatId, html, buttons), edit: (chatId, id, html, buttons) => this.edit(chatId, id, html, buttons) },
    );
    this.limiter = new RateLimiter(d.perHour ?? 20, d.dailyCap ?? 300, d.now, d.tz, d.counter);
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

  /**
   * The owner took the chat over (he answered from the Пульт: the bot stays quiet there) or gave it back to the bot's script (`resume` in the Пульт).
   * False for a chat the bot does not know.
   */
  handOver(chatId: number, human: boolean): boolean {
    const chat = this.store.get(chatId);
    if (!chat) return false;
    const mark = 'отвечает человек';
    const summary = human ? (chat.summary.includes(mark) ? chat.summary : `${chat.summary ? `${chat.summary} · ` : ''}${mark}`) : chat.summary.replace(` · ${mark}`, '').replace(mark, '').trim();
    this.store.update(chatId, { muted: human, summary });
    return true;
  }

  /** Whether the bot is quiet in this chat (a person has taken it over). */
  isHandedOver(chatId: number): boolean {
    return this.store.get(chatId)?.muted === true;
  }

  /** The chat of a Telegram username, for delivering an approved audit to someone who already wrote to the bot. */
  findChat(username: string): number | undefined {
    return this.store.chatIdByUsername(username);
  }

  // ---- entry points (the grammy glue calls these, private chats only) ----
  async onCommand(from: From, name: string, arg: string): Promise<void> {
    if (from.chatId === this.d.ownerId) return this.ownerSay(this.d.ownerHint ?? OWNER_HINT);
    const chat = this.chat(from);
    if (this.limiter.hit(chat.chatId) === 'drop') return;
    switch (name) {
      case 'start': {
        // `/start ref_<slug>`: who brought this person, kept for the lead made later (`origin: ref:<slug>`).
        const ref = refFromStartArg(arg);
        if (ref) this.refs.set(`tg:${chat.chatId}`, ref);
        this.demo.wipe(chat.chatId);
        if (/^demo(_salon)?$/i.test(arg.trim()) || arg.trim() === DEMO_START) return this.startDemo(chat);
        return this.welcome(chat, from);
      }
      case 'demo':
        return this.startDemo(chat);
      case 'audit':
        return this.audit(chat, from, arg.trim());
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

  private async startDemo(chat: Chat): Promise<void> {
    await this.dropCard(chat);
    this.store.update(chat.chatId, { state: 'idle', draft: {}, card: null });
    await this.demo.start(chat.chatId, chat.lang);
  }

  /** `/audit <url>`: the free 24-hour audit, through the same sink as the website. Never a lead; the owner approves the text. */
  private async audit(chat: Chat, from: From, arg: string): Promise<void> {
    const t = X[chat.lang];
    const url = /^(https?:\/\/)?\S+$/i.test(arg) ? (/^https?:\/\//i.test(arg) ? arg : `https://${arg}`) : '';
    const parsed = url ? auditInputSchema.safeParse({ url, contact: from.username ? `@${from.username}` : `tg:${chat.chatId}`, locale: chat.lang }) : null;
    if (!parsed?.success || !this.sinks?.createAudit) {
      await this.say(chat.chatId, parsed?.success === false || !arg ? t.auditUsage : t.auditOff);
      return;
    }
    const out = await this.sinks.createAudit({ ...parsed.data, chatId: chat.chatId });
    await this.say(chat.chatId, out === 'ok' ? t.auditOk : out === 'duplicate' ? t.auditDup : out === 'rate_limited' ? t.auditBusy : t.auditUsage);
  }

  async onText(from: From, raw: string): Promise<void> {
    if (from.chatId === this.d.ownerId) return this.ownerSay(this.d.ownerHint ?? OWNER_HINT);
    const cmd = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(raw.trim());
    if (cmd) return this.onCommand(from, cmd[1]!.toLowerCase(), cmd[2] ?? '');
    const first = this.chat(from);
    let chat: Chat = first;
    const rate = this.limiter.hit(chat.chatId);
    if (rate === 'drop') return;
    if (rate === 'warn') {
      await this.say(chat.chatId, T[chat.lang].slow);
      log('info', 'client bot rate limit', { chatId: chat.chatId, perHour: this.d.perHour ?? 20 });
      return;
    }
    if (this.isSpam(chat, raw)) {
      log('info', 'client bot spam dropped', { chatId: chat.chatId });
      return;
    }
    const text = raw.trim().slice(0, 2000);
    // A new person who just writes: the welcome first; a bare greeting needs nothing more.
    // (a first message that already names a need gets the short greeting: the product list is only for «что вы делаете»)
    if (first.fresh) {
      const bare = GREETING.test(text);
      await this.welcome(chat, from, !bare && !asksCatalogue(text));
      if (bare) return;
    }
    chat = this.store.get(chat.chatId)!;
    switch (chat.state) {
      case 'need':
      case 'need_text':
        return this.afterNeed(chat, { needText: clip(text, 1000) });
      case 'deadline':
        return this.afterDeadline(chat, { deadlineText: clip(text, 100) });
      case 'budget':
        return this.afterBudget(chat, { budgetText: clip(text, 40) });
      case 'hosting':
        return this.finishIntake(chat, from, { have: parseHave(text) });
      case 'client_name':
        return this.afterClientName(chat, text);
      case 'client_question':
        return this.afterClientQuestion(chat, from, text);
      default:
    }
    if (chat.muted) return this.forward(chat, text, 'Сообщение (бот молчит, ждёт вас)');
    if (await this.slotPick(chat, text)) return;
    await this.answer(chat, from, text);
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
    if (kind === 'dm') {
      if (messageId === undefined) return T[chat.lang].stale;
      const r = await this.demo.button(chat.chatId, chat.lang, messageId, data);
      if (r.want) await this.demoWant(chat, messageId);
      return r.toast;
    }
    if (kind === 'm') {
      await this.menu(chat, from, key, messageId);
      return undefined;
    }
    const stale = async () => {
      if (messageId !== undefined) await this.d.transport.clearButtons(chat.chatId, messageId).catch(() => undefined);
      return T[chat.lang].stale;
    };
    if (messageId === undefined || chat.card !== messageId) return stale();
    if (kind === 'p' && isCatalogueId(key)) {
      await this.edit(chat.chatId, messageId, productCardHtml(chat.lang, key), productCardButtons(chat.lang, key));
      return undefined;
    }
    if (kind === 'pd' && isCatalogueId(key)) {
      this.store.update(chat.chatId, { state: 'need', draft: {} });
      await this.afterNeed({ ...chat, state: 'need', draft: {} }, { need: key }, messageId);
      return undefined;
    }
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
      await this.afterBudget(chat, { budget: key as Budget }, messageId);
      return undefined;
    }
    if (kind === 'h' && chat.state === 'hosting' && (HAVES as readonly string[]).includes(key)) {
      await this.finishIntake(chat, from, { have: key as Have }, messageId);
      return undefined;
    }
    return stale();
  }

  /** «Хочу такого бота себе»: the demo is wiped and the normal intake starts with the AI booking assistant chosen, `source: demo_salon`. */
  private async demoWant(chat: Chat, messageId: number): Promise<void> {
    this.demo.wipe(chat.chatId);
    const draft: Draft = { source: DEMO_START };
    this.store.update(chat.chatId, { state: 'need', draft, card: messageId });
    await this.afterNeed({ ...chat, state: 'need', draft, card: messageId }, { need: 'admin' }, messageId);
  }

  // ---- welcome, menu ----
  /** The chat row, created on first contact (`fresh`): the language comes from Telegram's `language_code` then. */
  private chat(from: From): Chat & { fresh: boolean } {
    const existing = this.store.get(from.chatId);
    const lang: Lang = existing?.lang ?? (from.langCode?.toLowerCase().startsWith('en') ? 'en' : 'ru');
    return { ...this.store.touch(from.chatId, from.username ?? '', lang, from.firstName?.trim() ?? ''), fresh: !existing };
  }

  private async welcome(chat: Chat, from: From, short = false): Promise<void> {
    await this.dropCard(chat);
    const id = await this.say(chat.chatId, short ? T[chat.lang].welcomeShort(from.firstName ?? '') : T[chat.lang].welcome(from.firstName ?? ''), menuButtons(chat.lang));
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
      case 'products': {
        this.store.update(chat.chatId, { state: 'idle', draft: {} });
        if (onCard) await this.edit(chat.chatId, messageId!, productListHtml(chat.lang), productListButtons(chat.lang));
        else {
          await this.dropCard(chat);
          this.store.update(chat.chatId, { card: await this.say(chat.chatId, productListHtml(chat.lang), productListButtons(chat.lang)) });
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
      case 'demo':
        return this.startDemo(chat);
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
    // A niche in the visitor's own words: one line with the product that usually fits it.
    const hint = patch.needText ? nicheHint(chat.lang, patch.needText) : '';
    await this.nextCard(chat, `${hint ? `${esc(hint)}\n\n` : ''}${T[chat.lang].step2}`, deadlineButtons(chat.lang), messageId);
  }

  private async afterDeadline(chat: Chat, patch: Draft, messageId?: number): Promise<void> {
    this.store.update(chat.chatId, { state: 'budget', draft: { ...chat.draft, ...patch } });
    await this.nextCard(chat, T[chat.lang].step3, budgetButtons(chat.lang), messageId);
  }

  /** Step 4, the last short question: the client's own domain and hosting (the КП says who pays for them). */
  private async afterBudget(chat: Chat, patch: Draft, messageId?: number): Promise<void> {
    this.store.update(chat.chatId, { state: 'hosting', draft: { ...chat.draft, ...patch } });
    await this.nextCard(chat, T[chat.lang].step4, haveButtons(chat.lang), messageId);
  }

  private async nextCard(chat: Chat, html: string, buttons: Button[][], messageId?: number): Promise<void> {
    if (messageId !== undefined) return this.edit(chat.chatId, messageId, html, buttons);
    await this.dropCard(chat);
    this.store.update(chat.chatId, { card: await this.say(chat.chatId, html, buttons) });
  }

  private async finishIntake(chat: Chat, from: From, patch: Draft, messageId?: number): Promise<void> {
    const d: Draft = { ...chat.draft, ...patch };
    const t = T[chat.lang];
    const rec = intakeRecord(d, chat.lang, d.source === DEMO_START ? 'Заявка из клиентского Telegram-бота после демо «Салон Лайм».' : 'Заявка из клиентского Telegram-бота.');
    const night = this.isNight();
    const done = `${t.done(rec.shown.need, rec.shown.deadline, rec.shown.budget)}${night ? `\n${t.doneNight}` : ''}`;
    if (messageId !== undefined) await this.edit(chat.chatId, messageId, done);
    else {
      await this.dropCard(chat);
      await this.say(chat.chatId, done);
    }
    await this.createLead(chat, from, { message: rec.message, budget: rec.budget, service: rec.service, product: rec.product, have: haveFlags(d.have), ...(d.source ? { source: d.source } : {}) }, rec.masked);
  }

  /** The lead goes to Sales exactly like a website form lead, with the chat id so replies come back here. */
  private async createLead(chat: Chat, from: From, x: { message: string; budget: string; service: string; product?: string; source?: string; have?: { hasDomain: boolean | null; hasHosting: boolean | null }; enrichment?: EnrichmentOut }, masked: string): Promise<void> {
    this.store.update(chat.chatId, { state: 'idle', draft: {}, card: null });
    if (!this.sinks) {
      await this.forward(chat, x.message, 'Заявка (продажи не подключены)');
      return;
    }
    const name = clip(from.firstName?.trim() || (from.username ? `@${from.username}` : '') || 'Клиент из Telegram', 80);
    const ref = this.refs.get(`tg:${chat.chatId}`);
    const lead = {
      name, contact: from.username ? `@${from.username}` : `Telegram id ${chat.chatId}`, service: x.service, budget: clip(x.budget, 40),
      message: clip(x.message, 2000), estimate: '', locale: chat.lang, slot: '', source: ref ? `ref:${ref}` : (x.source ?? 'telegram'), chatId: chat.chatId, product: x.product ?? '',
      ...(from.username ? { username: from.username.slice(0, 40) } : {}),
      ...(x.have?.hasDomain != null ? { hasDomain: x.have.hasDomain } : {}), ...(x.have?.hasHosting != null ? { hasHosting: x.have.hasHosting } : {}),
      ...(x.enrichment ? { enrichment: x.enrichment } : {}),
    };
    let taskId: number;
    try {
      taskId = this.sinks.createLead(lead, x.service);
    } catch (e) {
      // the person was told «принято»: the request is kept for the owner (contact and words) and the owner hears about it at once and in the hourly alert
      this.d.onLost?.('bot', `заявка не создана: ${errMsg(e)}`, { contact: lead.contact, ref: `чат ${chat.chatId}`, text: x.message });
      await this.forward(chat, x.message, 'Заявка не дошла до продаж (сбой), текст сохранён');
      return;
    }
    this.store.update(chat.chatId, { leadTask: taskId, summary: `${masked} · задача #${taskId}` });
    log('info', 'client bot lead', { chatId: chat.chatId, taskId });
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
      this.d.toOwner?.({ kind: 'ticket', chatId: chat.chatId, name: chat.name });
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
    // the hand-off: the owner hears it from the HQ bot (a reminder with a link into the chat), never from this bot; the client's next messages become lines of his thread
    this.d.toOwner?.({ kind: 'human', chatId: chat.chatId, name: chat.name, why: chat.summary || 'новый разговор' });
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
    await this.sinks.bookCall?.(lead.leadId, slot).catch((e) => log('warn', 'client bot call booking failed', { lead: lead.leadId, err: errMsg(e) }));
    this.d.toOwner?.({ kind: 'message', chatId: chat.chatId, name: chat.name, text: `Выбрал окно для звонка: ${formatSlot(slot, this.d.tz(), 'ru')}`, why: `Лид #${lead.leadId} выбрал звонок` });
    return true;
  }

  private discussButton(lang: Lang): Button[][] {
    return [[{ text: T[lang].menu.discuss, data: 'm:discuss' }, { text: T[lang].menu.human, data: 'm:human' }]];
  }

  /**
   * The free conversation is the receptionist of ИИ-менеджер заявок 2.0 (`receptionist.ts`): qualification in at most five turns, the builder link first, a call
   * second, a person on request or frustration. A price question keeps its template. A call asked for becomes a lead with the conversation summary.
   */
  private async answer(chat: Chat, from: From, text: string): Promise<void> {
    const t = T[chat.lang];
    if (isPriceQuestion(text)) {
      await this.say(chat.chatId, t.priceAnswer, this.discussButton(chat.lang));
      return;
    }
    await this.d.transport.typing(chat.chatId).catch(() => undefined);
    const out = await receptionistTurn(
      {
        llm: this.d.llm, instructions: this.d.instructions, gate: this.limiter, now: this.d.now, tz: this.d.tz,
        ...(this.d.gatewayDown ? { gatewayDown: this.d.gatewayDown } : {}), ...(this.d.llmTimeoutMs !== undefined ? { timeoutMs: this.d.llmTimeoutMs } : {}),
      },
      { lang: chat.lang, text, q: chat.draft.q ?? newQ(), turns: this.turns(chat.chatId), channel: 'telegram', conversationId: `tg-${chat.chatId}` },
    );
    switch (out.kind) {
      case 'fallback':
        return this.fallback(chat, from, text, out.down === true);
      case 'handoff':
        this.store.update(chat.chatId, { draft: { ...chat.draft, q: out.q } });
        return this.callHuman(chat);
      case 'client':
        return;
      default:
    }
    this.store.update(chat.chatId, { draft: { ...chat.draft, q: out.q } });
    await this.say(chat.chatId, esc(out.text));
    this.remember(chat.chatId, 'user', text);
    this.remember(chat.chatId, 'assistant', out.text);
    log('info', 'client bot answer', { chatId: chat.chatId, removed: out.removed, rewritten: out.rewritten === true, turns: out.q.turns, llmToday: this.limiter.llmToday });
    if (out.team || out.removed > 0) await this.forward(chat, text, out.team ? 'Нужен человек (вопрос к команде)' : 'Вопрос о цене или сроках');
    // a call asked for: the lead with the conversation summary (the person is reachable in this chat)
    if (out.callAsked && !chat.leadTask) {
      const q = out.q;
      const product = productNamesOf(q);
      await this.createLead(
        chat, from,
        { message: `Просит созвон в клиентском боте.${q.pain ? `\nЗадача (словами клиента): ${q.pain}` : ''}${product ? `\nПродукт: ${product}` : ''}`, budget: q.budget ?? '', service: SERVICE[q.products?.[0] ?? 'other'], product, enrichment: enrichmentOf(q, true) },
        `созвон, ${q.products?.join(', ') || 'продукт не определён'}`,
      );
    }
  }

  private async fallback(chat: Chat, from: From, text: string, down: boolean): Promise<void> {
    if (!down) {
      await this.say(chat.chatId, T[chat.lang].fallback);
      await this.forward(chat, text, 'Сообщение без ответа модели');
      return;
    }
    // The gateway is down: the person gets the scripted «принял, менеджер ответит в рабочее время», never an error, and the question still
    // becomes a lead record (once per chat) so Sales and the owner see it; a chat that already has a lead only forwards the text.
    await this.say(chat.chatId, T[chat.lang].gatewayDown);
    if (!chat.leadTask && this.sinks) {
      await this.createLead(chat, from, { message: `Вопрос в клиентском боте (модель была недоступна): ${text}`, budget: '', service: 'other' }, 'вопрос без ответа модели');
      return;
    }
    await this.forward(chat, text, 'Вопрос без ответа (модель недоступна)');
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

  // ---- sending ----
  /** A client's words for the owner: a line of his thread and a reminder (HQ), never a Telegram message from this bot. */
  private async forward(chat: Chat, text: string, why: string): Promise<void> {
    this.d.toOwner?.({ kind: 'message', chatId: chat.chatId, name: chat.name, text: clip(text, 1500), why });
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
