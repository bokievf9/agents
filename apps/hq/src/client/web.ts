import { errMsg, log, type Db, type LlmClient } from '@fir/core';
import { z } from 'zod';
import type { DemoUsage } from '../demo-usage.js';
import type { ClientSinks } from './engine.js';
import { inWindow, linksOnly, RateLimiter } from './sanitize.js';
import { asksCatalogue } from './needs.js';
import { clip, GREETING, intakeRecord, TurnHistory } from './shared.js';
import { DemoChat, isPersona, PERSONAS } from './persona.js';
import { isPriceQuestion } from '@fir/worker-lead-intake';
import type { FiraLeadTurn } from './fira-registry.js';
import { enrichmentOf, findContact, HANDOFF, LEAD_DONE, loginUrlOf, merge, newQ, productNamesOf, receptionistTurn, SITE_ORIGIN, slotPickedText, wantsPerson, type Cta, type QState } from './receptionist.js';
import { parseRefSlug, RefStore, type Draft } from './store.js';
import { BUDGETS, DEADLINES, NEEDS, SERVICE, T, type Budget, type Deadline, type Lang, type Need } from './texts.js';
import { WebSessionStore, type WebSession, type WebState } from './web-store.js';
import { isCatalogueId, nicheHint, PRODUCTS } from './products.js';
import type { LostInfo, LostSource } from '../lost-leads.js';
import { budgetButtons, deadlineButtons, intakeButton, menuButtons, needButtons, plain, productCardButtons, productCardText, productListButtons, W, type WebButton } from './web-texts.js';

/** The request contract of `POST /chat` (the site is built against exactly these names). */
export const chatSchema = z.object({
  sessionId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
  locale: z.enum(['ru', 'en']),
  /** The visitor's words. `text` is the same field under the name of the site contract (2026-11-22); `message` is the older name, both are read. */
  message: z.string().trim().min(1).max(1000).optional(),
  text: z.string().trim().min(1).max(1000).optional(),
  page: z.string().max(200).optional(),
  /** `demo`: a scripted description of the salon demo with the Telegram deep link (no sandbox on the website). */
  mode: z.enum(['demo']).optional(),
  /** Referral slug (the site sends it from `?ref=` or its stored value): who brought the visitor. */
  ref: z.string().trim().regex(/^[a-z0-9_-]{1,32}$/).optional(),
  /** The demo tab: answer in the voice of a fictional business of this niche. A demo session never creates a lead, a ticket or a stored session. */
  persona: z.enum(PERSONAS).optional(),
  /** The signed-in cabinet account (the site sends them when the visitor is logged in): an existing client is routed to their thread, a lead is linked to the account. A malformed value is ignored. */
  clientEmail: z.string().trim().toLowerCase().max(254).email().optional().catch(undefined),
  cabinetId: z.string().trim().min(1).max(64).optional().catch(undefined),
  clientName: z.string().trim().max(120).optional().catch(undefined),
  /** «Демо только для вошедших» (2026-11-23): the site marks a demo request and names the signed-in client (`clientId` is the same as `cabinetId`, or the HQ id). */
  demo: z.boolean().optional().catch(undefined),
  clientId: z.string().trim().min(1).max(64).optional().catch(undefined),
}).transform((d, ctx) => {
  const message = d.message ?? d.text;
  if (!message) ctx.addIssue({ code: 'custom', path: ['message'], message: 'message or text is required' });
  return { ...d, message: message ?? '' };
});
export type ChatRequest = z.output<typeof chatSchema>;

export type ChatApiState = 'chat' | 'intake' | 'contact' | 'done';
export interface ChatReply {
  ok: true;
  reply: string;
  buttons?: WebButton[];
  state: ChatApiState;
  leadCreated?: boolean;
  /** ИИ-менеджер заявок 2.0: the prefilled builder link the receptionist proposed (a full URL), and which offers this reply carries, in their order. */
  builderLink?: string;
  cta?: ('builder' | 'call' | 'telegram')[];
  /** A person was asked for (or the visitor was upset): the owner gets it in /admin/chats. */
  handoff?: boolean;
  /** The reply of a demo session (`persona`): nothing was stored. */
  demo?: true;
  /** The signed-in client's demo cap of the day (`DEMO_DAILY_PER_CLIENT`), present when the request named a client: flat fields and the `usage` object. */
  limit?: number;
  remaining?: number;
  usage?: { limit: number; used: number; remaining: number };
  /** Texts the owner wrote himself from the workplace to this visitor (a lead answered by hand): shown after the bot's answer, once. */
  ownerReplies?: string[];
}
export type ChatOutcome =
  | { kind: 'ok'; body: ChatReply }
  | { kind: 'rate_limited' }
  | { kind: 'unavailable' }
  /** The client's demo cap of the day is spent (429 `limit_reached` with the usage fields). */
  | { kind: 'limit'; body: Record<string, unknown> }
  /** `DEMO_REQUIRE_CLIENT=on` and the demo request names no known client (401 `login_required`). */
  | { kind: 'login_required' };

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
  /** A request accepted from a visitor that failed before the owner could see it: `lost_lead` and the hourly alert (see `lost-leads.ts`). */
  onLost?: (source: LostSource, reason: string, info?: LostInfo) => void;
  /** True while the model gateway is known to be down: the free conversation answers with the scripted «принял» and asks for a contact. */
  gatewayDown?: () => boolean;
  /** How long a visitor waits for the model before the scripted answer (ms, default 20 s). */
  llmTimeoutMs?: number;
  /** Menu buttons («Обсудить проект», a product card) start the conversation with the receptionist (default true). false: they start the scripted 3-step intake, as when the model is off. */
  conversation?: boolean;
  /** True for a signed-in cabinet client who has a project (the receptionist's `client.vip`: the owner hears his questions). */
  hasProject?: (email: string) => boolean;
  /** Booking and cap of the demo per signed-in client (`demo-usage.ts`); absent: the demo is anonymous as before. */
  demoUsage?: DemoUsage;
  /** True: a demo request without a known client is refused (`login_required`). Default false until the site sends the identity everywhere. */
  demoRequireClient?: boolean;
  /** Demo sessions (`persona`) per visitor IP and hour (default 40). */
  perIpDemoHour?: number;
  /** Origin of the builder links the receptionist proposes (default https://firtech.pro). */
  siteOrigin?: string;
  /** Free call slots (UTC ms) for the call offer, e.g. the site's `/api/slots`; without it the receptionist says «предложу время». */
  slots?: () => Promise<number[]>;
  /** The model step on Fira (`client/fira-lead.ts`); absent: the one HQ registered (`FIRA_LEAD_MANAGER=on`), null: the old runtime. */
  fira?: FiraLeadTurn | null;
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

const wantsPersonFlag = (text: string): boolean => wantsPerson(text) !== null;
/** «Да», «ок», «записывайте»: the visitor confirms the window he picked before the sign-in. */
const AFFIRM = /^(да|ага|ок|окей|хорошо|давайте|подтверждаю|записывайте|запишите|yes|yep|ok|okay|sure|confirm|book it)(?![\p{L}])/iu;
const isPriceQuestionText = (text: string): boolean => isPriceQuestion(text);
const ctaList = (c: Cta): ('builder' | 'call' | 'telegram')[] => [...(c.builder ? ['builder' as const] : []), ...(c.call ? ['call' as const] : []), ...(c.telegram ? ['telegram' as const] : [])];
const apiState = (s: WebState): ChatApiState => (s === 'idle' || s === 'ask' ? 'chat' : s === 'contact' ? 'contact' : 'intake');
type Step = { reply: string; buttons?: WebButton[]; created?: boolean; link?: string; cta?: Cta; handoff?: boolean };

/**
 * The website version of the client bot: the same intake, «я уже клиент» and free LLM conversation, with a visitor
 * session instead of a Telegram chat and a contact step instead of a chat to reply into. One request, one reply.
 * Sessions live in `web_chat_sessions` (24 h); LLM turns only in memory; logs carry counts and ids, never texts.
 */
export class WebChatEngine {
  readonly store: WebSessionStore;
  private readonly refs: RefStore;
  private readonly sessionLimiter: RateLimiter;
  private readonly ipLimiter: RateLimiter;
  private readonly history: TurnHistory<string>;
  private readonly demo: DemoChat;
  private readonly demoLimiter: RateLimiter;
  private readonly queues = new Map<string, Promise<unknown>>();
  private sinks: ClientSinks | undefined;

  constructor(private readonly d: WebChatDeps) {
    this.store = new WebSessionStore(d.db, d.now);
    this.refs = new RefStore(d.db, d.now);
    // Daily cap is not used here: the shared gate holds the LLM counter.
    this.sessionLimiter = new RateLimiter(d.perSessionHour ?? 30, 0, d.now, d.tz);
    this.ipLimiter = new RateLimiter(d.perIpHour ?? 60, 0, d.now, d.tz);
    this.history = new TurnHistory(d.now);
    this.demoLimiter = new RateLimiter(d.perIpDemoHour ?? 40, 0, d.now, d.tz);
    this.demo = new DemoChat({ llm: d.llm, now: d.now, tz: d.tz, gate: d.gate, gatewayDown: d.gatewayDown, timeoutMs: d.llmTimeoutMs });
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
    if (req.persona) return this.handleDemo(req, req.persona, ip);
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
      const body = await run;
      const ownerReplies = this.store.takeOwnerReplies(req.sessionId);
      return { kind: 'ok', body: ownerReplies.length ? { ...body, ownerReplies } : body };
    } catch (e) {
      // Never an error to the visitor: the scripted «принял, менеджер ответит» goes out and the failure is recorded (the message was accepted)
      log('error', 'web chat failed', { err: errMsg(e) });
      this.d.onLost?.('chat', `веб-чат не обработал сообщение: ${errMsg(e)}`, { ref: `сессия ${req.sessionId.slice(0, 8)}`, text: req.message });
      return { kind: 'ok', body: { ok: true, reply: W[req.locale].down, state: 'chat' } };
    }
  }

  /**
   * A demo session of the site's demo tab: the voice of the niche, per-IP limit, nothing stored (no session row, no lead, no ticket, no owner reply), the log carries
   * counts only. It needs no company sinks, so it answers even while the intake is not connected.
   */
  private async handleDemo(req: ChatRequest, persona: string, ip: string): Promise<ChatOutcome> {
    if (!isPersona(persona)) return { kind: 'rate_limited' };
    if (this.demoLimiter.hit(ip) !== 'ok') return { kind: 'rate_limited' };
    const du = this.d.demoUsage;
    const clientId = du ? du.resolveClient({ email: req.clientEmail, cabinetId: req.cabinetId ?? req.clientId, name: req.clientName, locale: req.locale }) : null;
    if (du && clientId === null && this.d.demoRequireClient) return { kind: 'login_required' };
    const run = () => this.demo.reply(persona, req.sessionId, req.locale, req.message.trim()).catch((e) => {
      log('error', 'web chat demo failed', { err: errMsg(e) });
      return null;
    });
    let r: Awaited<ReturnType<typeof run>>;
    if (du && clientId !== null) {
      const m = await du.metered(clientId, `persona:${persona}`, run);
      if (!m.ok) {
        log('info', 'web chat demo limit', { persona, clientId });
        return { kind: 'limit', body: { ok: false, error: 'limit_reached', ...du.fields(clientId) } };
      }
      r = m.value;
    } else r = await run();
    log('info', 'web chat demo', { persona, sessions: this.demo.size(), ...(clientId !== null ? { clientId } : {}) });
    const usage = du && clientId !== null ? du.fields(clientId) : {};
    if (!r) return { kind: 'ok', body: { ok: true, reply: W[req.locale].down, state: 'chat', demo: true, ...usage } };
    return { kind: 'ok', body: { ok: true, reply: r.reply, state: 'chat', demo: true, ...usage } };
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
    const ref = parseRefSlug(req.ref);
    if (ref) this.refs.set(`web:${s.id}`, ref);
    const identity = req.clientEmail ? { email: req.clientEmail, ...(req.cabinetId ? { cabinetId: req.cabinetId } : {}), ...(req.clientName ? { name: req.clientName } : {}) } : undefined;
    const draft: Draft = { ...s.draft, ...(req.page && !s.draft.page ? { page: req.page.slice(0, 200) } : {}), ...(identity ? { identity } : {}) };
    this.store.update(s.id, { locale: lang, messages: s.messages + 1, ...(draft.page !== s.draft.page || identity ? { draft } : {}) });
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
    // The model may greet and introduce itself too: one greeting is enough, so a leading greeting sentence of the answer is dropped.
    if (fresh) step = { ...step, reply: `${asksCatalogue(text) ? W[lang].welcome : W[lang].welcomeShort}\n\n${stripGreeting(step.reply)}`, buttons: menuButtons(lang) };
    const after = this.store.get(s.id)!;
    return {
      ok: true, reply: step.reply, ...(step.buttons?.length ? { buttons: step.buttons } : {}),
      state: step.created ? 'done' : apiState(after.state), ...(step.created ? { leadCreated: true } : {}),
      ...(step.link ? { builderLink: step.link } : {}), ...(step.cta ? { cta: ctaList(step.cta) } : {}), ...(step.handoff ? { handoff: true } : {}),
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
      if (this.conversational()) return this.startQualify(s, lang);
      this.setState(s, 'need', this.fresh(s));
      return { reply: plain(t.step1), buttons: needButtons(lang) };
    }
    if (id === 'products') return { reply: W[lang].productsIntro, buttons: productListButtons(lang) };
    if (kind === 'product' && isCatalogueId(key)) return { reply: productCardText(lang, key), buttons: productCardButtons(lang, key) };
    if (kind === 'need' && isCatalogueId(key) && (s.state === 'idle' || s.state === 'ask')) {
      if (this.conversational()) return this.startQualify(s, lang, key);
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
    if (s.draft.pending === 'handoff' && /^(не надо|не нужно|отмена|передумал|cancel|no thanks|never ?mind)(?![\p{L}])/iu.test(text.trim())) {
      this.setState(s, 'idle', { ...this.fresh(s), ...(s.draft.q ? { q: s.draft.q } : {}), ...(s.draft.identity ? { identity: s.draft.identity } : {}) });
      return { reply: lang === 'ru' ? 'Хорошо, продолжим здесь. Чем помочь?' : 'All right, we can go on here. How can I help?' };
    }
    const contact = parseContact(text);
    if (!contact) return { reply: W[lang].contactBad };
    if (s.draft.pending === 'handoff') return this.leadFromQ(s, lang, s.draft.q ?? newQ(), contact, true);
    const sinks = this.sinks!;
    const d = s.draft;
    const night = this.isNight();
    const page = d.page ?? '';
    const pageLine = page ? `\nСтраница: ${page}` : '';
    const ref = this.refs.get(`web:${s.id}`);
    const base = { name: 'Посетитель веб-чата', contact, estimate: '', locale: lang, slot: '', source: ref ? `ref:${ref}` : 'web', page, sessionId: s.id };
    // The visitor is told «принято» in every case: when Sales cannot take the request the contact and the words are kept (lost_lead) and the owner is alerted.
    const lose = (reason: string, text: string, e: unknown): void => {
      this.d.onLost?.('chat', `${reason}: ${errMsg(e)}`, { contact, ref: `сессия ${s.id.slice(0, 8)}`, text });
      this.setState(s, 'idle', this.fresh(s));
      this.store.update(s.id, { summary: `${reason} (в журнале потерянных)` });
    };
    if (d.pending === 'client') {
      const question = d.question ?? '';
      if (d.client) {
        try {
          const taskId = await sinks.createTicket(d.client, `${question}\nКонтакт: ${contact}`);
          this.finished(s, `клиент: тикет, задача #${taskId}`, taskId, 'ticket');
        } catch (e) {
          lose('тикет клиента не создан', question, e);
        }
        return { reply: W[lang].clientDone(true, night), created: true };
      }
      const message = `Пишет как клиент («${d.clientQuery ?? '?'}»), в базе клиентов не найден.\nВопрос: ${question}\nЗаявка из веб-чата на сайте.${pageLine}`;
      try {
        const taskId = sinks.createLead({ ...base, service: 'other', budget: '', message: clip(message, 2000) }, 'other');
        this.finished(s, `пишет как клиент, не найден, задача #${taskId}`, taskId, 'lead');
      } catch (e) {
        lose('заявка клиента не создана', message, e);
      }
      return { reply: W[lang].clientDone(false, night), created: true };
    }
    const rec = intakeRecord(d, lang, 'Заявка из веб-чата на сайте.');
    try {
      const taskId = sinks.createLead({ ...base, service: rec.service, product: rec.product, budget: clip(rec.budget, 40), message: clip(`${rec.message}${pageLine}`, 2000) }, rec.service);
      this.finished(s, `${rec.masked} · задача #${taskId}`, taskId, 'lead');
    } catch (e) {
      lose('заявка не создана', `${rec.message}${pageLine}`, e);
    }
    return { reply: W[lang].done(rec.shown.need, rec.shown.deadline, rec.shown.budget, night), created: true };
  }

  private finished(s: WebSession, summary: string, taskId: number, kind: 'lead' | 'ticket'): void {
    this.setState(s, 'idle', this.fresh(s));
    this.store.update(s.id, { summary });
    log('info', 'web chat lead', { sessionId: s.id, taskId, kind });
  }

  // ---- ИИ-менеджер заявок 2.0: the conversation ----
  /** The model can talk now: the conversation (qualification, offers) runs; otherwise the scripted 3-step intake stays the way in. */
  private conversational(): boolean {
    return this.d.conversation !== false && this.d.llm.enabled && !this.d.gatewayDown?.();
  }

  private saveQ(id: string, q: QState): void {
    const cur = this.store.get(id);
    if (cur) this.store.update(id, { draft: { ...cur.draft, q } });
  }

  /** The menu button «Обсудить проект» (or a product card): the first question of the qualification, no form. */
  private startQualify(s: WebSession, lang: Lang, product?: string): Step {
    const q: QState = { ...newQ(), ...(product && isCatalogueId(product) ? { products: [product] } : {}) };
    this.setState(s, 'idle', { ...this.fresh(s), q, ...(s.draft.identity ? { identity: s.draft.identity } : {}) });
    const name = product && isCatalogueId(product) ? PRODUCTS[product].name[lang] : '';
    const ask = lang === 'ru'
      ? 'Расскажите, чем занимается ваш бизнес и что сейчас мешает: теряются заявки, запись идёт вручную, ночью никто не отвечает?'
      : 'Tell me what your business does and what gets in the way now: lost requests, manual booking, nobody answering at night?';
    return { reply: name ? (lang === 'ru' ? `Хорошо, «${name}». ${ask}` : `Good, “${name}”. ${ask}`) : ask };
  }

  private async free(s: WebSession, lang: Lang, text: string): Promise<Step> {
    const w = W[lang];
    const cap = this.d.llmPerSession ?? 15;
    let used = 0;
    const q0 = s.draft.q ?? newQ();
    // a contact in the visitor's message: the lead is made now from what the conversation has (the visitor decided to leave it); a signed-in client already has their account
    const contact = s.draft.identity ? null : findContact(text);
    if (contact) {
      const q = merge(q0, { reply: '' }, text);
      return this.leadFromQ(s, lang, q, contact, wantsPersonFlag(text));
    }
    // P-03: the window picked before the sign-in: the visitor is back signed in and says yes, the lead with the window is made now (once)
    if (s.draft.identity && q0.slot !== undefined && q0.slot > this.d.now() && !q0.leadMade && AFFIRM.test(text)) return this.leadFromQ(s, lang, q0, s.draft.identity.email, false);
    const out = await receptionistTurn(
      {
        llm: this.d.llm, instructions: this.d.instructions, now: this.d.now, tz: this.d.tz, slots: this.d.slots, siteOrigin: this.d.siteOrigin, ...(this.d.fira !== undefined ? { fira: this.d.fira } : {}),
        gate: {
          llmAllowed: () => s.llmAnswers < cap && this.d.gate.llmAllowed(),
          llmUsed: () => {
            used++;
            this.d.gate.llmUsed();
          },
        },
        ...(this.d.gatewayDown ? { gatewayDown: this.d.gatewayDown } : {}), ...(this.d.llmTimeoutMs !== undefined ? { timeoutMs: this.d.llmTimeoutMs } : {}),
      },
      { lang, text, q: q0, turns: this.history.turns(s.id), conversationId: `web-${s.id}`, ...(s.draft.identity ? { client: { email: s.draft.identity.email, name: s.draft.identity.name ?? s.draft.identity.email, ...(this.d.hasProject?.(s.draft.identity.email) ? { vip: true } : {}) } } : {}) },
    );
    if (used) this.store.update(s.id, { llmAnswers: s.llmAnswers + used });
    switch (out.kind) {
      case 'handoff': return this.handoff(s, lang, out.q, out.why, text);
      case 'client': return this.routeClient(s, lang, out.q, text);
      case 'fallback':
        this.saveQ(s.id, out.q);
        if (isPriceQuestionText(text)) return { reply: w.price, buttons: intakeButton(lang) };
        if (out.down) {
          // The gateway is down: «принял, менеджер ответит в рабочее время», and the visitor's question becomes the intake that only needs a contact
          this.setState(s, 'contact', { ...this.fresh(s), q: out.q, needText: clip(text, 1000), pending: 'intake' });
          return { reply: w.down };
        }
        return { reply: s.llmAnswers >= cap ? w.cap : w.fallback, buttons: intakeButton(lang) };
      default:
    }
    // P-03: a call window picked: a signed-in client gets the lead with it at once (the account is the contact); anyone else keeps it in the session until the sign-in
    if (out.picked !== undefined && s.draft.identity && !out.q.leadMade) return this.leadFromQ(s, lang, out.q, s.draft.identity.email, false);
    // a signed-in client asks for a call: the account is the contact, the lead is linked to it (once); when windows were offered he picks one first (P-03)
    if (out.callAsked && s.draft.identity && !out.q.leadMade && !out.q.offeredSlots?.length) return this.leadFromQ(s, lang, out.q, s.draft.identity.email, false);
    this.saveQ(s.id, out.q);
    this.history.remember(s.id, 'user', text);
    this.history.remember(s.id, 'assistant', out.text);
    log('info', 'web chat answer', { sessionId: s.id, removed: out.removed, rewritten: out.rewritten === true, turns: out.q.turns, offers: ctaList(out.cta).length, answers: s.llmAnswers + used });
    return { reply: out.text, ...(out.link ? { link: out.link } : {}), ...(ctaList(out.cta).length ? { cta: out.cta } : {}) };
  }

  /** A signed-in client's project question, or a person asked for: into their thread (cabinet, Messages), no new lead. */
  private async routeClient(s: WebSession, lang: Lang, q: QState, text: string, handoff = false): Promise<Step> {
    const id = s.draft.identity!;
    const sinks = this.sinks!;
    this.saveQ(s.id, q);
    const body = handoff ? `${lang === 'ru' ? 'Просит живого менеджера в чате на сайте' : 'Asks for a person in the website chat'}: ${text}` : text;
    try {
      if (sinks.clientMessage) await sinks.clientMessage({ email: id.email, ...(id.name ? { name: id.name } : {}) }, body);
      else await sinks.createTicket(id.name || id.email, body);
      log('info', 'web chat client routed', { sessionId: s.id, handoff });
    } catch (e) {
      this.d.onLost?.('chat', `сообщение клиента из веб-чата не доставлено: ${errMsg(e)}`, { contact: id.email, ref: `сессия ${s.id.slice(0, 8)}`, text });
    }
    return { reply: HANDOFF[lang].client, ...(handoff ? { handoff: true } : {}) };
  }

  /** A person was asked for, or the visitor is upset: a signed-in client goes to their thread, anyone else is asked for a contact (the lead then says so and lands in /admin/chats). */
  private async handoff(s: WebSession, lang: Lang, q: QState, why: 'ask' | 'upset', text: string): Promise<Step> {
    if (s.draft.identity) return this.routeClient(s, lang, q, text, true);
    this.setState(s, 'contact', { ...s.draft, q, pending: 'handoff' });
    log('info', 'web chat handoff', { sessionId: s.id, why });
    // P-03: the site takes no contact from a visitor who is not signed in: he is pointed to the sign-in (a contact typed anyway still makes the lead)
    return { reply: HANDOFF[lang][why === 'upset' ? 'signInUpset' : 'signIn'].replace('{login}', loginUrlOf(this.d.siteOrigin ?? SITE_ORIGIN, lang)), handoff: true };
  }

  /** The lead of a conversation: what the receptionist learned, the summary, the product family, the niche, the intent score and the link it proposed ride along. */
  private async leadFromQ(s: WebSession, lang: Lang, q: QState, contact: string, handoff: boolean): Promise<Step> {
    const sinks = this.sinks!;
    const d = s.draft;
    const id = d.identity;
    const night = this.isNight();
    const page = d.page ?? '';
    const ref = this.refs.get(`web:${s.id}`);
    const state: QState = { ...q, handoff: q.handoff || handoff };
    const enrichment = enrichmentOf(state, true);
    const product = productNamesOf(state);
    const message = [
      state.pain ? `Задача (словами клиента): ${state.pain}` : handoff ? 'Просит живого менеджера в веб-чате.' : 'Оставил контакт в веб-чате.',
      ...(product ? [`Продукт: ${product}`] : []),
      ...(state.niche || state.kind ? [`Ниша: ${state.niche || state.kind}`] : []),
      ...(state.channels?.length ? [`Каналы: ${state.channels.join(', ')}`] : []),
      ...(state.timeline ? [`Срок: ${state.timeline}`] : []),
      'Заявка из веб-чата на сайте (ИИ-менеджер заявок).',
      ...(page ? [`Страница: ${page}`] : []),
    ].join('\n');
    const lead = {
      name: id?.name || 'Посетитель веб-чата', contact: clip(contact, 120), service: SERVICE[state.products?.[0] ?? 'other'], product, budget: clip(state.budget ?? '', 40), message: clip(message, 2000), estimate: '',
      // P-03/P-04: the window the visitor picked rides with the lead; the Sales head books it (the site's `POST /api/slots`, else a «подтвердить созвон» task)
      locale: lang, slot: state.slot !== undefined && state.slot > this.d.now() ? new Date(state.slot).toISOString() : '', source: ref ? `ref:${ref}` : 'web', page, sessionId: s.id, enrichment, ...(handoff ? { handoff: true } : {}),
      ...(id ? { clientEmail: id.email, ...(id.cabinetId ? { cabinetId: id.cabinetId } : {}), ...(id.name ? { clientName: id.name } : {}) } : {}),
    };
    try {
      const taskId = sinks.createLead(lead, lead.service);
      this.finished(s, `разговор: ${enrichment.productFamily || 'продукт не определён'}, намерение ${enrichment.intentScore}${handoff ? ', просил менеджера' : ''} · задача #${taskId}`, taskId, 'lead');
      this.saveQ(s.id, { ...state, leadMade: true });
    } catch (e) {
      this.d.onLost?.('chat', `заявка из разговора не создана: ${errMsg(e)}`, { contact, ref: `сессия ${s.id.slice(0, 8)}`, text: message });
      this.setState(s, 'idle', this.fresh(s));
      this.store.update(s.id, { summary: 'заявка из разговора не создана (в журнале потерянных)' });
    }
    if (!handoff && lead.slot && state.slot !== undefined) return { reply: slotPickedText(lang, state.slot, this.d.tz(), { signedIn: true, loginUrl: '' }), created: true };
    return { reply: handoff ? `${HANDOFF[lang].done}${night ? (lang === 'ru' ? ' Сейчас у нас ночь, поэтому ответ придёт утром.' : ' It is night here now, so the answer will come in the morning.') : ''}` : LEAD_DONE[lang](night), created: true, ...(handoff ? { handoff: true } : {}) };
  }
}

/** Drops a leading greeting sentence («Здравствуйте! Я Фира, ...» / «Hi, I'm Fira ...») when the system already greeted in the same message. */
export function stripGreeting(reply: string): string {
  const m = /^\s*(Здравствуйте|Привет|Добрый день|Добрый вечер|Доброе утро|Hello|Hi|Good (?:morning|afternoon|evening))[^\n.!?]{0,120}[.!?]?(?:\s+(?:Я|I'm|I am)\s[^\n.!?]{0,120}[.!?])?\s*/u.exec(reply);
  if (!m || m[0].length >= reply.trim().length) return reply;
  return reply.slice(m[0].length);
}
