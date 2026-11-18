import { z } from 'zod';
import type { KindSpec, Payload } from '@fir/core';
import { zonedParts } from '@fir/core';
import type { WorkerCtx } from '@fir/hq';
import { addDays, addMonths, dateStr, diffDays, isDate, ruDate } from './dates.js';
import { BillingStore, METHOD_LABEL, parseMethod, type Invoice, type PayMethod, type Period, type Subscription } from './store.js';

/** `billing_invoice`: invoice text for the owner to send. Money: locked at level 0. */
export const KIND_INVOICE = 'billing_invoice';
/** `billing_reminder`: payment reminder draft (3 days before and on the due date). Locked at level 0. */
export const KIND_REMINDER = 'billing_reminder';

/** After this many days past the due date the owner gets an alert. */
export const OVERDUE_DAYS = 5;
/** A subscription gets its next invoice draft this many days before the due date. */
export const SUBSCRIPTION_LEAD_DAYS = 7;
const DEFAULT_DUE_DAYS = 7;

export type PaymentDetails = Partial<Record<PayMethod, string>>;

const detailsSchema = z.record(z.string(), z.string());

/** `PAYMENT_DETAILS_JSON`: `{"payme":"...","kaspi":"...","usdt":"..."}`; keys: kaspi, payme, click, card, usdt. Empty is fine; garbage is an error. */
export function parsePaymentDetails(raw: string | undefined): PaymentDetails {
  if (!raw?.trim()) return {};
  let parsed: Record<string, string>;
  try {
    parsed = detailsSchema.parse(JSON.parse(raw));
  } catch {
    throw new Error('PAYMENT_DETAILS_JSON must be JSON like {"payme":"...","kaspi":"...","usdt":"..."}');
  }
  const out: PaymentDetails = {};
  for (const [k, v] of Object.entries(parsed)) {
    const m = parseMethod(k);
    if (!m) throw new Error(`PAYMENT_DETAILS_JSON: unknown method "${k}" (kaspi, payme, click, card, usdt)`);
    if (v.trim()) out[m] = v.trim();
  }
  return out;
}

export interface BillingOptions {
  /** Invoice number prefix (env INVOICE_PREFIX, `FT`). */
  prefix?: string;
  paymentDetails?: PaymentDetails;
}

export interface BillingDelivery {
  text: string;
  invoiceId: number;
  name: string;
  kind: string;
}

const usd = (n: number): string => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
export const hasPlaceholder = (text: string): boolean => /\[[^\]]*\]/.test(text);

const stores = new WeakMap<object, BillingStore>();
export function billingStoreFor(ctx: Pick<WorkerCtx, 'db' | 'now'>, prefix = 'FT'): BillingStore {
  let s = stores.get(ctx.db);
  if (!s) {
    s = new BillingStore(ctx.db, ctx.now, prefix);
    stores.set(ctx.db, s);
  }
  return s;
}

export interface InvoiceArgs {
  client: string;
  amountUsd: number;
  what: string;
  dueDate: string | null;
  method: PayMethod | null;
  newProject: boolean;
}

const AMOUNT = /^\$?(\d+(?:[.,]\d+)?)$/;

/**
 * `/invoice <client> <amount> <what> [due=YYYY-MM-DD] [method=payme] [new]`. The client may have several words: it is
 * everything before the first amount. `new` marks a new project: paying it starts onboarding.
 */
export function parseInvoiceArgs(args: string): InvoiceArgs | null {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const i = tokens.findIndex((t, idx) => idx >= 1 && AMOUNT.test(t));
  if (i < 1) return null;
  const amountUsd = Number(AMOUNT.exec(tokens[i]!)![1]!.replace(',', '.'));
  if (!(amountUsd > 0)) return null;
  let dueDate: string | null = null;
  let method: PayMethod | null = null;
  let newProject = false;
  const what: string[] = [];
  for (const t of tokens.slice(i + 1)) {
    const d = /^due=(.+)$/i.exec(t)?.[1];
    const m = /^method=(.+)$/i.exec(t)?.[1];
    if (d) {
      if (!isDate(d)) return null;
      dueDate = d;
    } else if (m) {
      method = parseMethod(m);
      if (!method) return null;
    } else if (/^(new|новый)$/i.test(t)) newProject = true;
    else what.push(t);
  }
  return { client: tokens.slice(0, i).join(' '), amountUsd, what: what.join(' '), dueDate, method, newProject };
}

/** `/sub <client> <amount> <month|year> <method> <YYYY-MM-DD> [plan]`. */
export function parseSubArgs(args: string): { client: string; amountUsd: number; period: Period; method: PayMethod | null; nextDue: string; plan: string } | null {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const i = tokens.findIndex((t, idx) => idx >= 1 && AMOUNT.test(t));
  if (i < 1) return null;
  const [per, meth, due, ...plan] = tokens.slice(i + 1);
  const period = /^(month|месяц|мес)$/i.test(per ?? '') ? 'month' : /^(year|год)$/i.test(per ?? '') ? 'year' : null;
  const method = parseMethod(meth ?? '');
  if (!period || !method || !due || !isDate(due)) return null;
  return { client: tokens.slice(0, i).join(' '), amountUsd: Number(AMOUNT.exec(tokens[i]!)![1]!.replace(',', '.')), period, method, nextDue: due, plan: plan.join(' ') };
}

/** Billing: subscriptions, invoices, reminders, paid marks. No payment provider: the owner sends every text himself. */
export class BillingWorker {
  readonly id = 'billing';
  readonly prefix: string;
  private readonly details: PaymentDetails;

  constructor(opts: BillingOptions = {}) {
    this.prefix = opts.prefix ?? 'FT';
    this.details = opts.paymentDetails ?? {};
  }

  store(ctx: Pick<WorkerCtx, 'db' | 'now'>): BillingStore {
    return billingStoreFor(ctx, this.prefix);
  }

  kindSpecs(ctx: Pick<WorkerCtx, 'db' | 'now'>, deliver: (d: BillingDelivery) => Promise<void>): Record<string, KindSpec> {
    const run = (kind: string) => async (p: Payload): Promise<void> => {
      if (typeof p.text !== 'string' || !p.text.trim()) throw new Error('nothing to deliver');
      if (hasPlaceholder(p.text)) throw new Error('text still has a placeholder (payment details?)');
      await deliver({ text: p.text, invoiceId: Number(p.invoiceId), name: String(p.name ?? ''), kind });
      if (kind === KIND_INVOICE && Number.isInteger(p.invoiceId)) {
        const s = this.store(ctx);
        const inv = s.invoice(Number(p.invoiceId));
        if (inv?.status === 'draft') s.setStatus(inv.id, 'issued');
      }
    };
    return {
      [KIND_INVOICE]: { initialLevel: 0, locked: true, execute: run(KIND_INVOICE) },
      [KIND_REMINDER]: { initialLevel: 0, locked: true, execute: run(KIND_REMINDER) },
    };
  }

  /** Payment instructions block; a missing method becomes a `[placeholder]` that blocks sending until the owner fills it. */
  paymentLines(method: PayMethod | null): string {
    const methods = method ? [method] : (Object.keys(this.details) as PayMethod[]);
    if (methods.length === 0) return '- [реквизиты оплаты]';
    return methods.map((m) => `- ${METHOD_LABEL[m]}: ${this.details[m] ?? `[реквизиты ${METHOD_LABEL[m]}]`}`).join('\n');
  }

  invoiceText(inv: Invoice): string {
    return [
      `Счёт ${inv.number}`,
      `Клиент: ${inv.client}`,
      `За что: ${inv.what}`,
      `Сумма: ${usd(inv.amountUsd)}`,
      `Оплатить до: ${ruDate(inv.dueDate)}`,
      '',
      `Как оплатить${inv.method ? '' : ' (любой способ)'}:`,
      this.paymentLines(inv.method),
      '',
      'После оплаты пришлите чек или скриншот в этот чат. Спасибо!',
    ].join('\n');
  }

  reminderText(inv: Invoice, daysToDue: number): string {
    const when = daysToDue > 0 ? `через ${daysToDue} дн. (${ruDate(inv.dueDate)})` : `сегодня (${ruDate(inv.dueDate)})`;
    return `Здравствуйте, ${inv.client}. Напоминаем: счёт ${inv.number} на ${usd(inv.amountUsd)} за «${inv.what}» нужно оплатить ${when}.\n\nКак оплатить:\n${this.paymentLines(inv.method)}\n\nЕсли уже оплатили, пришлите чек в этот чат, мы отметим счёт.`;
  }

  /** Creates an invoice and stages its text for the owner (locked, level 0). */
  async createInvoice(ctx: WorkerCtx, a: { client: string; amountUsd: number; what: string; dueDate?: string | null; method?: PayMethod | null; newProject?: boolean; subscriptionId?: number | null }): Promise<Invoice> {
    const store = this.store(ctx);
    const year = zonedParts(ctx.now(), ctx.tz).y;
    const due = a.dueDate ?? addDays(dateStr(ctx.now(), ctx.tz), DEFAULT_DUE_DAYS);
    const inv = store.addInvoice(
      { client: a.client, amountUsd: a.amountUsd, what: a.what.trim() || 'Услуги Fir Tech', method: a.method ?? null, dueDate: due, subscriptionId: a.subscriptionId ?? null, newProject: a.newProject ?? false },
      year,
    );
    await ctx.requestApproval(
      KIND_INVOICE,
      { text: this.invoiceText(inv), invoiceId: inv.id, name: inv.client },
      `Счёт ${inv.number} для ${inv.client}: ${usd(inv.amountUsd)}, до ${ruDate(inv.dueDate)}. Одобрение = «счёт утверждён», отправьте его клиенту сами. Метка в скобках означает, что реквизитов нет в PAYMENT_DETAILS_JSON: нажмите «Править».`,
    );
    ctx.log('invoice', inv.number);
    return inv;
  }

  /**
   * The daily 09:30 pass: invoice drafts for subscriptions due within a week, reminders 3 days before and on the due
   * date (staged for the owner), overdue after 5 days as alerts. Each step happens once per invoice.
   */
  async daily(ctx: WorkerCtx): Promise<{ lines: string[]; alerts: string[] }> {
    const store = this.store(ctx);
    const today = dateStr(ctx.now(), ctx.tz);
    const lines: string[] = [];
    const alerts: string[] = [];
    for (const sub of store.subscriptions()) {
      if (diffDays(today, sub.nextDue) <= SUBSCRIPTION_LEAD_DAYS && !store.hasInvoiceFor(sub.id, sub.nextDue)) {
        const inv = await this.createInvoice(ctx, {
          client: sub.client, amountUsd: sub.amountUsd, what: sub.plan ? `Подписка: ${sub.plan}` : 'Подписка на сопровождение', dueDate: sub.nextDue, method: sub.method, subscriptionId: sub.id,
        });
        lines.push(`Счёт ${inv.number} по подписке ${sub.client} (${usd(inv.amountUsd)}) на утверждении.`);
      }
    }
    for (const inv of store.invoices(['issued'], 500)) {
      const toDue = diffDays(today, inv.dueDate);
      if (toDue >= 1 && toDue <= 3 && !inv.remind3) {
        store.setFlag(inv.id, 'remind3');
        await ctx.requestApproval(KIND_REMINDER, { text: this.reminderText(inv, toDue), invoiceId: inv.id, name: inv.client }, `Напоминание об оплате: ${inv.number}, ${inv.client}, до оплаты ${toDue} дн. Отправьте клиенту сами.`);
        lines.push(`Напоминание по ${inv.number} (${inv.client}): срок через ${toDue} дн.`);
      } else if (toDue === 0 && !inv.remind0) {
        store.setFlag(inv.id, 'remind0');
        await ctx.requestApproval(KIND_REMINDER, { text: this.reminderText(inv, 0), invoiceId: inv.id, name: inv.client }, `Напоминание об оплате: ${inv.number}, ${inv.client}, срок сегодня. Отправьте клиенту сами.`);
        lines.push(`Напоминание по ${inv.number} (${inv.client}): срок сегодня.`);
      }
      if (-toDue >= OVERDUE_DAYS && !inv.overdueAlerted) {
        store.setFlag(inv.id, 'overdue_alerted');
        alerts.push(`Счёт ${inv.number} (${inv.client}, ${usd(inv.amountUsd)}) просрочен на ${-toDue} дн. Отметить оплату: /paid ${inv.number}.`);
      }
    }
    return { lines, alerts };
  }

  /**
   * Marks an invoice paid. A subscription invoice moves the subscription's next due date by one period.
   * Returns null when the reference is unknown; `already` when it was paid before.
   */
  markPaid(ctx: Pick<WorkerCtx, 'db' | 'now' | 'tz'>, ref: string): { invoice: Invoice; already: boolean; nextDue?: string } | null {
    const store = this.store(ctx);
    const inv = store.byRef(ref, zonedParts(ctx.now(), ctx.tz).y);
    if (!inv) return null;
    if (inv.status === 'paid') return { invoice: inv, already: true };
    store.setStatus(inv.id, 'paid');
    let nextDue: string | undefined;
    const sub: Subscription | undefined = inv.subscriptionId ? store.subscription(inv.subscriptionId) : undefined;
    if (sub && sub.nextDue === inv.dueDate) {
      nextDue = sub.period === 'year' ? addMonths(sub.nextDue, 12) : addMonths(sub.nextDue, 1);
      store.setNextDue(sub.id, nextDue);
    }
    return { invoice: store.invoice(inv.id)!, already: false, ...(nextDue ? { nextDue } : {}) };
  }

  invoicesText(ctx: Pick<WorkerCtx, 'db' | 'now' | 'tz'>): string {
    const store = this.store(ctx);
    const open = store.invoices(['draft', 'issued'], 30);
    const subs = store.subscriptions();
    const out: string[] = [];
    out.push(open.length ? `Неоплаченные счета:\n${open.map((i) => `${i.number} ${i.client}: ${usd(i.amountUsd)}, до ${ruDate(i.dueDate)}${i.status === 'draft' ? ' (черновик, не утверждён)' : ''}`).join('\n')}` : 'Неоплаченных счетов нет.');
    if (subs.length) out.push(`Подписки:\n${subs.map((s) => `${s.client}: ${usd(s.amountUsd)}/${s.period === 'year' ? 'год' : 'мес'}, следующая оплата ${ruDate(s.nextDue)}${s.method ? `, ${METHOD_LABEL[s.method]}` : ''}`).join('\n')}`);
    return out.join('\n\n');
  }
}
