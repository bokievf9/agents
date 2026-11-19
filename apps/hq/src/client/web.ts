import { errMsg, log, type Db, type LlmClient } from '@fir/core';
import { z } from 'zod';
import type { ClientSinks } from './engine.js';
import { inWindow, linksOnly, RateLimiter } from './sanitize.js';
import { clip, freeAnswer, GREETING, intakeRecord, TurnHistory } from './shared.js';
import type { Draft } from './store.js';
import { BUDGETS, DEADLINES, NEEDS, T, type Budget, type Deadline, type Lang, type Need } from './texts.js';
import { WebSessionStore, type WebSession, type WebState } from './web-store.js';
import { isCatalogueId, nicheHint } from './products.js';
import { budgetButtons, deadlineButtons, intakeButton, menuButtons, needButtons, plain, productCardButtons, productCardText, productListButtons, W, type WebButton } from './web-texts.js';

/** The request contract of `POST /chat` (the site is built against exactly these names). */
export const chatSchema = z.object({
  sessionId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
  locale: z.enum(['ru', 'en']),
  message: z.string().trim().min(1).max(1000),
  page: z.string().max(200).optional(),
  /** `demo`: a scripted description of the salon demo with the Telegram deep link (no sandbox on the website). */
  mode: z.enum(['demo']).optional(),
});
export type ChatRequest = z.output<typeof chatSchema>;

export type ChatApiState = 'chat' | 'intake' | 'contact' | 'done';
export interface ChatReply {
  ok: true;
  reply: string;
  buttons?: WebButton[];
  state: ChatApiState;
  leadCreated?: boolean;
}
export type ChatOutcome = { kind: 'ok'; body: ChatReply } | { kind: 'rate_limited' } | { kind: 'unavailable' };

export interface WebChatDeps {
  db: Db;
  now: () => number;
  tz: () => string;
  llm: LlmClient;
  instructions: string;
  quietHours?: string;
  /** Shared LLM budget gate: the same counter as the Telegram bot's daily cap. */
  gate: { llmAllowed(): boolean; llmUsed(): void };
  sinks?: ClientSinks;
  perSessionHour?: number;
  perIpHour?: number;
  llmPerSession?: number;
}

/** Telegram @username, phone or email, validated loosely. Returns the contact as stored, or null. */
export function parseContact(raw: string): string | null {
  const t = raw.trim();
  if (t.length < 5 || t.length > 120) return null;
  const link = /^(?:https?:\/\/)?t\.me\/([A-Za-z][A-Za-z0-9_]{4,31})\/?$/i.exec(t);
  if (link) return `@${link[1]}`;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(t)) return t;
  if (/^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(t)) return t;
  if (/^\+?[\d\s().-]{7,25}$/.test(t)) {
    const digits = t.replace(/\D/g, '').length;
    if (digits >= 7 && digits <= 15) return t;
  }
  return null;
}

const apiState = (s: WebState): ChatApiState => (s === 'idle' || s === 'ask' ? 'chat' : s === 'contact' ? 'contact' : 'intake');
type Step = { reply: string; buttons?: WebButton[]; created?: boolean };

/**
 * The website version of the client bot: the same intake, «я уже клиент» and free LLM conversation, with a visitor
 * session instead of a Telegram chat and a contact step instead of a chat to reply into. One request, one reply.
 * Sessions live in `web_chat_sessions` (24 h); LLM turns only in memory; logs carry counts and ids, never texts.
 */
export class WebChatEngine {
  readonly store: WebSessionStore;
  private readonly sessionLimiter: RateLimiter;
  private readonly ipLimiter: RateLimiter;
  private readonly history: TurnHistory<string>;
  private readonly queues = new Map<string, Promise<unknown>>();
  private sinks: ClientSinks | undefined;

  constructor(private readonly d: WebChatDeps) {
    this.store = new WebSessionStore(d.db, d.now);
    // Daily cap is not used here: the shared gate holds the LLM counter.
    this.sessionLimiter = new RateLimiter(d.perSessionHour ?? 30, 0, d.now, d.tz);
    this.ipLimiter = new RateLimiter(d.perIpHour ?? 60, 0, d.now, d.tz);
    this.history = new TurnHistory(d.now);
    this.sinks = d.sinks;
  }

  connect(sinks: ClientSinks): void {
    this.sinks = sinks;
  }

  private isNight(): boolean {
    return inWindow(this.d.now(), this.d.tz(), this.d.quietHours ?? '22:00-08:00');
  }

  /** Limits first (cheap, before any work), then the session's requests run one after another. */
  async handle(req: ChatRequest, ip: string): Promise<ChatOutcome> {
    if (!this.sinks) return { kind: 'unavailable' };
    if (this.ipLimiter.hit(ip) !== 'ok') return { kind: 'rate_limited' };
    if (this.sessionLimiter.hit(req.sessionId) !== 'ok') return { kind: 'rate_limited' };
    const prev = this.queues.get(req.sessionId) ?? Promise.resolve();
    const run = prev.then(() => this.process(req));
    const settled = run.catch(() => undefined);
    this.queues.set(req.sessionId, settled);
    void settled.finally(() => {
      if (this.queues.get(req.sessionId) === settled) this.queues.delete(req.sessionId);
    });
    try {
      return { kind: 'ok', body: await run };
    } catch (e) {
      log('error', 'web chat failed', { err: errMsg(e) });
      return { kind: 'unavailable' };
    }
  }

  private async process(req: ChatRequest): Promise<ChatReply> {
    this.store.sweep();
    this.history.sweep();
    const lang: Lang = req.locale;
    let s = this.store.get(req.sessionId);
    const fresh = !s;
    if (!s) {
      s = this.store.create(req.sessionId, lang);
      log('info', 'web chat session', { sessionId: s.id, total: this.store.count() });
    }
    this.store.update(s.id, { locale: lang, messages: s.messages + 1, ...(req.page && !s.draft.page ? { draft: { ...s.draft, page: req.page.slice(0, 200) } } : {}) });
    s = this.store.get(s.id)!;

    const text = req.message.trim();
    if (req.mode === 'demo' || /^demo$/i.test(text)) return { ok: true, reply: W[lang].demo, buttons: menuButtons(lang), state: 'chat' };
    const start = /^\/start\b/i.test(text);
    if (start || (fresh && GREETING.test(text))) return this.greet(s, lang);
    let step: Step;
    const btn = /^\/btn\s+([A-Za-z0-9:_-]{1,40})$/i.exec(text);
    if (btn) step = await this.button(s, lang, btn[1]!);
    else if (/^\//.test(text)) step = this.prompt(s, lang);
    else if (s.state !== 'contact' && linksOnly(text)) step = { reply: W[lang].ask };
    else step = await this.text(s, lang, text.slice(0, 1000));
    // A new visitor who starts with a real question: the greeting first, then the answer to it.
    if (fresh) step = { reply: `${W[lang].welcome}\n\n${step.reply}`, buttons: menuButtons(lang) };
    const after = this.store.get(s.id)!;
    return {
      ok: true, reply: step.reply, ...(step.buttons?.length ? { buttons: step.buttons } : {}),
      state: step.created ? 'done' : apiState(after.state), ...(step.created ? { leadCreated: true } : {}),
    };
  }

  private greet(s: WebSession, lang: Lang): ChatReply {
    this.store.update(s.id, { state: 'idle', draft: { ...(s.draft.page ? { page: s.draft.page } : {}) } });
    return { ok: true, reply: W[lang].welcome, buttons: menuButtons(lang), state: 'chat' };
  }

  /** The question of the current step again (a stale or unknown button, an unknown command). */
  private prompt(s: WebSession, lang: Lang): Step {
    const t = T[lang];
    switch (s.state) {
      case 'need': return { reply: plain(t.step1), buttons: needButtons(lang) };
      case 'deadline': return { reply: plain(t.step2), buttons: deadlineButtons(lang) };
      case 'budget': return { reply: plain(t.step3), buttons: budgetButtons(lang) };
      case 'client_name': return { reply: plain(t.askClient) };
      case 'client_question': return { reply: plain(t.askQuestion) };
      case 'contact': return { reply: W[lang].askContact };
      case 'ask': return { reply: W[lang].ask, buttons: intakeButton(lang) };
      default: return { reply: W[lang].welcome, buttons: menuButtons(lang) };
    }
  }

  private setState(s: WebSession, state: WebState, draft?: Draft): void {
    this.store.update(s.id, { state, ...(draft ? { draft } : {}) });
  }

  private fresh(s: WebSession): Draft {
    return s.draft.page ? { page: s.draft.page } : {};
  }

  private async button(s: WebSession, lang: Lang, id: string): Promise<Step> {
    const t = T[lang];
    const [kind, key = ''] = id.split(':');
    if (id === 'intake') {
      this.setState(s, 'need', this.fresh(s));
      return { reply: plain(t.step1), buttons: needButtons(lang) };
    }
    if (id === 'products') return { reply: W[lang].productsIntro, buttons: productListButtons(lang) };
    if (kind === 'product' && isCatalogueId(key)) return { reply: productCardText(lang, key), buttons: productCardButtons(lang, key) };
    if (kind === 'need' && isCatalogueId(key) && (s.state === 'idle' || s.state === 'ask')) {
      this.setState(s, 'need', this.fresh(s));
      return this.afterNeed({ ...s, state: 'need', draft: this.fresh(s) }, lang, { need: key });
    }
    if (id === 'client') {
      this.setState(s, 'client_name', this.fresh(s));
      return { reply: plain(t.askClient) };
    }
    if (id === 'ask') {
      this.setState(s, 'ask', this.fresh(s));
      return { reply: W[lang].ask, buttons: intakeButton(lang) };
    }
    if (kind === 'need' && s.state === 'need' && (NEEDS as readonly string[]).includes(key)) {
      if (key === 'other') return { reply: plain(t.step1Text) };
      return this.afterNeed(s, lang, { need: key as Need });
    }
    if (kind === 'deadline' && s.state === 'deadline' && (DEADLINES as readonly string[]).includes(key)) return this.afterDeadline(s, lang, { deadline: key as Deadline });
    if (kind === 'budget' && s.state === 'budget' && (BUDGETS as readonly string[]).includes(key)) return this.afterBudget(s, lang, { budget: key as Budget });
    return this.prompt(s, lang);
  }

  private async text(s: WebSession, lang: Lang, text: string): Promise<Step> {
    switch (s.state) {
      case 'need': return this.afterNeed(s, lang, { needText: clip(text, 1000) });
      case 'deadline': return this.afterDeadline(s, lang, { deadlineText: clip(text, 100) });
      case 'budget': return this.afterBudget(s, lang, { budgetText: clip(text, 40) });
      case 'client_name': return this.afterClientName(s, lang, text);
      case 'client_question':
        this.setState(s, 'contact', { ...s.draft, question: clip(text, 1000), pending: 'client' });
        return { reply: W[lang].askContact };
      case 'contact': return this.afterContact(s, lang, text);
      default: return this.free(s, lang, text);
    }
  }

  // ---- the 3-step intake, then the contact ----
  private afterNeed(s: WebSession, lang: Lang, patch: Draft): Step {
    this.setState(s, 'deadline', { ...s.draft, ...patch });
    const hint = patch.needText ? nicheHint(lang, patch.needText) : '';
    return { reply: `${hint ? `${hint}\n\n` : ''}${plain(T[lang].step2)}`, buttons: deadlineButtons(lang) };
  }

  private afterDeadline(s: WebSession, lang: Lang, patch: Draft): Step {
    this.setState(s, 'budget', { ...s.draft, ...patch });
    return { reply: plain(T[lang].step3), buttons: budgetButtons(lang) };
  }

  private afterBudget(s: WebSession, lang: Lang, patch: Draft): Step {
    this.setState(s, 'contact', { ...s.draft, ...patch, pending: 'intake' });
    return { reply: W[lang].askContact };
  }

  private afterClientName(s: WebSession, lang: Lang, text: string): Step {
    const query = clip(text, 80);
    const found = this.sinks?.findClient(query) ?? null;
    // The same answer either way: the chat never confirms to a stranger who is a client.
    this.setState(s, 'client_question', { ...this.fresh(s), ...(found ? { client: found } : { client: null, clientQuery: query }) });
    return { reply: plain(T[lang].askQuestion) };
  }

  private async afterContact(s: WebSession, lang: Lang, text: string): Promise<Step> {
    const contact = parseContact(text);
    if (!contact) return { reply: W[lang].contactBad };
    const sinks = this.sinks!;
    const d = s.draft;
    const night = this.isNight();
    const page = d.page ?? '';
    const pageLine = page ? `\nСтраница: ${page}` : '';
    const base = { name: 'Посетитель веб-чата', contact, estimate: '', locale: lang, slot: '', source: 'web', page };
    if (d.pending === 'client') {
      const question = d.question ?? '';
      if (d.client) {
        const taskId = await sinks.createTicket(d.client, `${question}\nКонтакт: ${contact}`);
        this.finished(s, `клиент: тикет, задача #${taskId}`, taskId, 'ticket');
        return { reply: W[lang].clientDone(true, night), created: true };
      }
      const message = `Пишет как клиент («${d.clientQuery ?? '?'}»), в базе клиентов не найден.\nВопрос: ${question}\nЗаявка из веб-чата на сайте.${pageLine}`;
      const taskId = sinks.createLead({ ...base, service: 'other', budget: '', message: clip(message, 2000) }, 'other');
      this.finished(s, `пишет как клиент, не найден, задача #${taskId}`, taskId, 'lead');
      return { reply: W[lang].clientDone(false, night), created: true };
    }
    const rec = intakeRecord(d, lang, 'Заявка из веб-чата на сайте.');
    const taskId = sinks.createLead({ ...base, service: rec.service, product: rec.product, budget: clip(rec.budget, 40), message: clip(`${rec.message}${pageLine}`, 2000) }, rec.service);
    this.finished(s, `${rec.masked} · задача #${taskId}`, taskId, 'lead');
    return { reply: W[lang].done(rec.shown.need, rec.shown.deadline, rec.shown.budget, night), created: true };
  }

  private finished(s: WebSession, summary: string, taskId: number, kind: 'lead' | 'ticket'): void {
    this.setState(s, 'idle', this.fresh(s));
    this.store.update(s.id, { summary });
    log('info', 'web chat lead', { sessionId: s.id, taskId, kind });
  }

  // ---- free conversation ----
  private async free(s: WebSession, lang: Lang, text: string): Promise<Step> {
    const w = W[lang];
    const cap = this.d.llmPerSession ?? 15;
    let used = 0;
    const gate = {
      llmAllowed: () => s.llmAnswers < cap && this.d.gate.llmAllowed(),
      llmUsed: () => {
        used++;
        this.d.gate.llmUsed();
      },
    };
    const r = await freeAnswer({ llm: this.d.llm, instructions: this.d.instructions, gate }, lang, text, this.history.turns(s.id));
    if (used) this.store.update(s.id, { llmAnswers: s.llmAnswers + used });
    switch (r.kind) {
      case 'price': return { reply: w.price, buttons: intakeButton(lang) };
      case 'fallback': return { reply: s.llmAnswers >= cap ? w.cap : w.fallback, buttons: intakeButton(lang) };
      default:
    }
    this.history.remember(s.id, 'user', text);
    this.history.remember(s.id, 'assistant', r.text);
    log('info', 'web chat answer', { sessionId: s.id, removed: r.removed, team: r.team, answers: s.llmAnswers + used });
    return { reply: r.text, buttons: intakeButton(lang) };
  }
}
