import { placeholderHold, tryComplete, type KindSpec, type Payload } from '@fir/core';
import type { WorkerCtx } from '@fir/hq';
import { DEFAULT_KB_DIR, isMoneyTopic, loadKb, lookup, type KbEntry } from './kb.js';
import { CsStore, type CsTicket } from './store.js';

/** `support_answer`: an answer from the knowledge base, level 1 by default (the trust counter applies). */
export const KIND_ANSWER = 'support_answer';
/** `support_money`: refunds, discounts, disputed charges. Locked at level 0: only the owner decides these. */
export const KIND_MONEY = 'support_money';
/** The unfilled `[...]` templates of a draft as the owner-facing hold of «Одобрить» (null: nothing left to fill). */
const holdOf = (text: unknown): string | null => placeholderHold([...new Set(typeof text === 'string' ? (text.match(/\[[^\]]*\]/g) ?? []) : [])]);


export interface CustomerSupportOptions {
  kbDir?: string;
  /** Hours until an unanswered ticket becomes an alert (env SUPPORT_SLA_HOURS, 4). */
  slaHours?: number;
  /** Initial level of ordinary answers. Money answers are always locked at 0. */
  answerLevel?: 0 | 1;
}

/** What the owner gets once an answer is approved: he sends it to the client himself. */
export interface TicketDelivery {
  text: string;
  ticketId: number;
  contact: string;
  name: string;
  kind: string;
  /** The client's private chat with the public bot, when the ticket came from there: the text goes back to it. */
  chatId?: number;
}

export const hasPlaceholder = (text: string): boolean => /\[[^\]]*\]/.test(text);

const stores = new WeakMap<object, CsStore>();
/** The worker's own tables (`cs_*`) live in the shared HQ database. */
export function csStoreFor(ctx: Pick<WorkerCtx, 'db' | 'now'>): CsStore {
  let s = stores.get(ctx.db);
  if (!s) {
    s = new CsStore(ctx.db, ctx.now);
    stores.set(ctx.db, s);
  }
  return s;
}

/** `/ticket <client>: <text>`; null when the format does not match. */
export function parseTicketArgs(args: string): { client: string; text: string } | null {
  const m = /^\s*([^:]{1,80}?)\s*:\s*([\s\S]+\S)\s*$/.exec(args);
  return m ? { client: m[1]!, text: m[2]! } : null;
}

/** `/client name | contact | product | plan | since`: fields after the name are optional. */
export function parseClientArgs(args: string): { name: string; contact: string; product: string; plan: string; since: string } | null {
  const p = args.split('|').map((s) => s.trim());
  if (!p[0]) return null;
  return { name: p[0], contact: p[1] ?? '', product: p[2] ?? '', plan: p[3] ?? '', since: p[4] ?? '' };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Customer support: a client question becomes a ticket and an answer draft. The draft comes from the knowledge base
 * (`kb/*.md`) with LLM wording; with the model off, the KB text under a greeting. Money questions never get a model
 * answer: only a locked placeholder draft for the owner. Nothing reaches a client by itself: the approved text is
 * handed to the owner to send.
 */
export class CustomerSupportWorker {
  readonly id = 'customer-support';
  private kbCache: KbEntry[] | null = null;
  private readonly kbDir: string;
  readonly slaHours: number;
  private readonly answerLevel: 0 | 1;

  constructor(opts: CustomerSupportOptions = {}) {
    this.kbDir = opts.kbDir ?? DEFAULT_KB_DIR;
    this.slaHours = opts.slaHours ?? 4;
    this.answerLevel = opts.answerLevel ?? 1;
  }

  kb(): KbEntry[] {
    return (this.kbCache ??= loadKb(this.kbDir));
  }

  kindSpecs(ctx: Pick<WorkerCtx, 'db' | 'now'>, deliver: (d: TicketDelivery) => Promise<void>): Record<string, KindSpec> {
    const run = (kind: string) => async (p: Payload): Promise<void> => {
      if (typeof p.text !== 'string' || !p.text.trim()) throw new Error('nothing to deliver');
      if (hasPlaceholder(p.text)) throw new Error('answer still has a placeholder');
      const store = csStoreFor(ctx);
      const known = Number.isInteger(p.ticketId) ? store.ticket(Number(p.ticketId)) : undefined;
      // a cabinet ticket without a Telegram chat has no other channel: the stored answer is what the client sees
      if (!(known?.source === 'cabinet' && typeof p.chatId !== 'number')) {
        await deliver({
          text: p.text, ticketId: Number(p.ticketId), contact: String(p.contact ?? ''), name: String(p.name ?? ''), kind,
          ...(typeof p.chatId === 'number' ? { chatId: p.chatId } : {}),
        });
      }
      if (Number.isInteger(p.ticketId)) store.markAnswered(Number(p.ticketId), p.text);
    };
    return {
      [KIND_ANSWER]: { initialLevel: this.answerLevel, ready: (p) => holdOf(p.text), execute: run(KIND_ANSWER) },
      [KIND_MONEY]: { initialLevel: 0, locked: true, ready: (p) => holdOf(p.text), execute: run(KIND_MONEY) },
    };
  }

  /** The reply text: LLM wording of the KB answer (checked), else greeting + KB text. */
  private async word(ctx: WorkerCtx, name: string, question: string, entry: KbEntry): Promise<string> {
    const template = `Здравствуйте, ${name}.\n\n${entry.answer}`;
    const draft = await tryComplete(ctx.llm, {
      tier: 'sonnet',
      maxTokens: 500,
      system: `Ты помощник поддержки студии Fir Tech (сайты, Telegram-боты, автоматизация). Ответь клиенту по-русски, вежливо, коротко (до 5 предложений), без эмодзи, без markdown, без длинных тире. Используй ТОЛЬКО факты из справки ниже: ничего не добавляй, не называй цен, сроков и обещаний, которых в справке нет. Начни с приветствия по имени.\n\nСправка:\n${entry.answer}`,
      messages: [{ role: 'user', content: `Клиент ${name} пишет: ${clip(question, 1500)}` }],
    });
    const text = draft?.trim();
    const ok = text && text.length >= 40 && text.length <= 1200 && !hasPlaceholder(text) && !/[—–]/.test(text);
    return ok ? text : template;
  }

  /** Creates the ticket and stages the answer for approval. Returns a short line for the owner. */
  async handleTicket(ctx: WorkerCtx, input: { client: string; text: string; chatId?: number; ticketId?: number }): Promise<{ ticket: CsTicket; text: string; line: string }> {
    const store = csStoreFor(ctx);
    const money = isMoneyTopic(input.text);
    const existing = input.ticketId !== undefined ? store.ticket(input.ticketId) : undefined;
    if (existing) store.setMoney(existing.id, money);
    const ticket = existing ? { ...existing, money } : store.addTicket({ clientName: input.client, text: input.text, money });
    const known = store.clientByName(input.client);
    const who = `${ticket.clientName}${known ? '' : ' (нет в базе клиентов: /client)'}`;
    const payload = { ticketId: ticket.id, contact: ticket.contact, name: ticket.clientName, ...(input.chatId !== undefined ? { chatId: input.chatId } : {}) };
    if (money) {
      const text = `Здравствуйте, ${ticket.clientName}. Передал ваш вопрос владельцу студии, он ответит лично. [решение владельца]`;
      await ctx.requestApproval(KIND_MONEY, { ...payload, text }, `Тикет #${ticket.id}, ${who}: вопрос про деньги или возврат. Решаете вы: нажмите «Править» и впишите ответ вместо метки.\nВопрос: ${clip(input.text, 400)}`);
      ctx.log('ticket', `ticket ${ticket.id} money`);
      return { ticket, text, line: `Тикет #${ticket.id} (${who}): вопрос про деньги, ответ только за вами (уровень 0, закрыт от автоматики).` };
    }
    const hit = lookup(this.kb(), input.text);
    const text = hit ? await this.word(ctx, ticket.clientName, input.text, hit.entry) : `Здравствуйте, ${ticket.clientName}. Спасибо за вопрос, уточняю и вернусь с ответом. [ответ по существу]`;
    const via = hit ? `из справки «${hit.entry.title}»` : 'в справке ответа нет, черновик с меткой для вашего текста';
    await ctx.requestApproval(KIND_ANSWER, { ...payload, text }, `Тикет #${ticket.id}, ${who}: ответ клиенту (${via}).\nВопрос: ${clip(input.text, 400)}`);
    ctx.log('ticket', `ticket ${ticket.id} ${hit ? hit.entry.id : 'no-kb'}`);
    return { ticket, text, line: `Тикет #${ticket.id} (${who}): черновик ${hit ? `из справки «${hit.entry.title}»` : 'с меткой, в справке ответа нет'}.` };
  }

  /** SLA check: tickets without an approved answer for `slaHours`, one alert text per ticket (not repeated). */
  slaAlerts(ctx: Pick<WorkerCtx, 'db' | 'now'>): string[] {
    return csStoreFor(ctx)
      .takeSlaBreaches(this.slaHours * 3600_000)
      .map((t) => `Тикет #${t.id} (${t.clientName}) без утверждённого ответа больше ${this.slaHours} ч. Откройте /tickets и /approve.`);
  }

  ticketsText(ctx: Pick<WorkerCtx, 'db' | 'now'>): string {
    const list = csStoreFor(ctx).recent(15);
    if (!list.length) return 'Тикетов нет.';
    const now = ctx.now();
    return list
      .map((t) => {
        const age = Math.floor((now - t.createdAt) / 3600_000);
        return `#${t.id} ${t.status === 'open' ? `ОТКРЫТ ${age} ч` : t.status === 'closed' ? 'закрыт' : 'отвечен'}${t.money ? ' (деньги)' : ''}: ${t.clientName}: ${clip(t.text.replace(/\s+/g, ' '), 70)}`;
      })
      .join('\n');
  }

  clientsText(ctx: Pick<WorkerCtx, 'db' | 'now'>): string {
    const list = csStoreFor(ctx).clients();
    if (!list.length) return 'Клиентов нет. Добавить: /client Имя | контакт | продукт | тариф | с какой даты';
    return list.map((c) => `${c.name}: ${c.product || 'продукт не указан'}, тариф ${c.plan || '-'}, с ${c.since || '-'}, контакт ${c.contact || '-'}`).join('\n');
  }
}
