import { z } from 'zod';
import type { KindSpec, Payload } from '@fir/core';
import { costsLine, zonedParts, type Infrastructure } from '@fir/core';
import type { WorkerCtx } from '@fir/hq';
import { addDays, addMonths, dateStr, diffDays, isDate, ruDate } from './dates.js';
import { BillingStore, METHOD_LABEL, PAY_METHODS, parseMethod, type ChainMethod, type Invoice, type Locale, type PayMethod, type Period, type Subscription } from './store.js';
import { chainMethodsOf } from './watch.js';

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

/**
 * `PAYMENT_DETAILS_JSON`: `{"usdt_trc20":"T...","usdt_ton":"UQ...","wallet":"Payeer P123..."}`; the three keys are the studio's
 * methods. Empty is fine; garbage and the old Kaspi, Payme, Click, card keys are errors.
 */
export function parsePaymentDetails(raw: string | undefined): PaymentDetails {
  if (!raw?.trim()) return {};
  let parsed: Record<string, string>;
  try {
    parsed = detailsSchema.parse(JSON.parse(raw));
  } catch {
    throw new Error('PAYMENT_DETAILS_JSON must be JSON like {"usdt_trc20":"...","usdt_ton":"...","wallet":"..."}');
  }
  const out: PaymentDetails = {};
  for (const [k, v] of Object.entries(parsed)) {
    const m = parseMethod(k);
    if (!m) throw new Error(`PAYMENT_DETAILS_JSON: unknown method "${k}" (usdt_trc20, usdt_ton, wallet)`);
    if (v.trim()) out[m] = v.trim();
  }
  return out;
}

export interface BillingOptions {
  /** Invoice number prefix (env INVOICE_PREFIX, `FT`). */
  prefix?: string;
  paymentDetails?: PaymentDetails;
  /** The site that renders the pay page (env SITE_URL, default https://firtech.pro). */
  siteUrl?: string;
}

export const DEFAULT_SITE_URL = 'https://firtech.pro';
/** «150.07»: the exact sum to transfer, always with cents. */
export const usdt = (n: number): string => n.toFixed(2);

export interface BillingDelivery {
  text: string;
  invoiceId: number;
  name: string;
  kind: string;
}

const usd = (n: number): string => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
/** The studio's payment rule (owner decision 2026-11-21), printed in every invoice: by stages, each before its start, the last before handover. */
export const PAYMENT_TERMS = 'Условия: оплата по этапам, каждый этап до его начала, последний до передачи доступов. Комиссии сети и платёжных сервисов оплачивает плательщик. Деньги пришли на счёт студии: оплата засчитана.';
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

/** Where an invoice made by the sales chain comes from: its lead, КП pack, reserved project, the estimate total and the card's chain line. */
export interface InvoiceLink {
  leadId?: number | null;
  packId?: number | null;
  projectId?: number | null;
  totalUsd?: number | null;
  /** The stage this invoice pays and how many stages the project has (payment by stages). */
  stageNo?: number | null;
  stageCount?: number | null;
  /** «КП #12 → договор → счёт этапа 1»: printed in the owner's card so the three cards point at each other. */
  chain?: string;
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
  readonly siteUrl: string;

  constructor(opts: BillingOptions = {}) {
    this.prefix = opts.prefix ?? 'FT';
    this.details = opts.paymentDetails ?? {};
    this.siteUrl = (opts.siteUrl?.trim() || DEFAULT_SITE_URL).replace(/\/+$/, '');
  }

  /** The configured USDT addresses (for the watcher and the pay page). */
  chainAddresses(): Partial<Record<ChainMethod, string>> {
    return { ...(this.details.usdt_trc20 ? { usdt_trc20: this.details.usdt_trc20 } : {}), ...(this.details.usdt_ton ? { usdt_ton: this.details.usdt_ton } : {}) };
  }

  /** USDT methods this invoice can be paid with on the pay page: allowed for the invoice and configured. */
  chainMethods(inv: Pick<Invoice, 'method'>): ChainMethod[] {
    return chainMethodsOf(inv).filter((m) => Boolean(this.details[m]));
  }

  /** `https://firtech.pro/ru/pay/FT-2026-001?k=<key>` (EN clients get /en/); null without a key. */
  payUrl(inv: Pick<Invoice, 'number' | 'payKey' | 'locale'>): string | null {
    if (!inv.payKey) return null;
    return `${this.siteUrl}/${inv.locale === 'en' ? 'en' : 'ru'}/pay/${encodeURIComponent(inv.number)}?k=${encodeURIComponent(inv.payKey)}`;
  }

  /**
   * How to pay, for chat texts. USDT goes through the pay page (address and QR are there, never in the chat): the exact sum and the link.
   * The online wallet, when the invoice allows it, stays a line. Nothing configured: a `[placeholder]` that blocks sending.
   */
  howToPay(inv: Invoice): string {
    const chain = this.chainMethods(inv);
    const url = this.payUrl(inv);
    const lines: string[] = [];
    if (chain.length && url) {
      lines.push(`- USDT (${chain.map((m) => (m === 'usdt_trc20' ? 'TRC20' : 'TON')).join(' или ')}): переведите ровно ${usdt(inv.payAmountUsd)} USDT, адрес и QR на странице оплаты: ${url}`);
      if ((inv.method === null || inv.method === 'wallet') && this.details.wallet) lines.push(`- ${METHOD_LABEL.wallet}: ${this.details.wallet}`);
      return lines.join('\n');
    }
    return this.paymentLines(inv.method);
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
    const methods = method ? [method] : PAY_METHODS.filter((m) => this.details[m]);
    if (methods.length === 0) return '- [реквизиты оплаты]';
    return methods.map((m) => `- ${METHOD_LABEL[m]}: ${this.details[m] ?? `[реквизиты ${METHOD_LABEL[m]}]`}`).join('\n');
  }

  /**
   * The invoice for the owner to send. A project invoice (not a subscription payment) carries the fixed conditions line: domain, hosting,
   * server and paid third-party services are not in the sum. `infra` is what the client already has (from the lead's brief); unknown is the default line.
   */
  invoiceText(inv: Invoice, infra: Infrastructure = {}): string {
    const page = this.chainMethods(inv).length > 0 && this.payUrl(inv) !== null;
    return [
      `Счёт ${inv.number}`,
      `Клиент: ${inv.client}`,
      `За что: ${inv.what}`,
      `Сумма: ${usd(inv.amountUsd)}`,
      ...(page ? [`Сумма к переводу: ${usdt(inv.payAmountUsd)} USDT (ровно эта сумма: по ней платёж находится автоматически)`] : []),
      `Оплатить до: ${ruDate(inv.dueDate)}`,
      ...(inv.subscriptionId === null ? ['', `Что не входит в сумму: ${costsLine(infra)}`] : []),
      '',
      `Как оплатить${inv.method ? '' : ' (любой способ)'}:`,
      this.howToPay(inv),
      '',
      PAYMENT_TERMS,
      '',
      page
        ? 'Оплата USDT подтверждается автоматически в течение нескольких минут, страница по ссылке покажет «оплачено». Если платили другим способом, пришлите чек в этот чат. Спасибо!'
        : 'После оплаты пришлите чек или скриншот в этот чат. Спасибо!',
    ].join('\n');
  }

  /** The card lines: the link and the exact sum (only when the invoice can be paid in USDT through the page). */
  payLinkLines(inv: Invoice): string {
    const url = this.payUrl(inv);
    if (!url || this.chainMethods(inv).length === 0) return '';
    return `\nСсылка на оплату: ${url}\nСумма к переводу: ${usdt(inv.payAmountUsd)} USDT${inv.payAmountUsd !== inv.amountUsd ? ` (к ${usd(inv.amountUsd)} добавлены центы: другой открытый счёт на ту же сумму)` : ''}`;
  }

  reminderText(inv: Invoice, daysToDue: number): string {
    const when = daysToDue > 0 ? `через ${daysToDue} дн. (${ruDate(inv.dueDate)})` : `сегодня (${ruDate(inv.dueDate)})`;
    return `Здравствуйте, ${inv.client}. Напоминаем: счёт ${inv.number} на ${usd(inv.amountUsd)} за «${inv.what}» нужно оплатить ${when}.\n\nКак оплатить:\n${this.howToPay(inv)}\n\nЕсли уже оплатили, пришлите чек в этот чат, мы отметим счёт.`;
  }

  /** Creates an invoice and stages its text for the owner (locked, level 0). */
  async createInvoice(ctx: WorkerCtx, a: { client: string; amountUsd: number; what: string; dueDate?: string | null; method?: PayMethod | null; newProject?: boolean; subscriptionId?: number | null; link?: InvoiceLink; infra?: Infrastructure; locale?: Locale }): Promise<Invoice> {
    const store = this.store(ctx);
    const year = zonedParts(ctx.now(), ctx.tz).y;
    const due = a.dueDate ?? addDays(dateStr(ctx.now(), ctx.tz), DEFAULT_DUE_DAYS);
    const inv = store.addInvoice(
      {
        client: a.client, amountUsd: a.amountUsd, what: a.what.trim() || 'Услуги Fir Tech', method: a.method ?? null, dueDate: due, subscriptionId: a.subscriptionId ?? null, newProject: a.newProject ?? false,
        leadId: a.link?.leadId ?? null, packId: a.link?.packId ?? null, projectId: a.link?.projectId ?? null, totalUsd: a.link?.totalUsd ?? null, stageNo: a.link?.stageNo ?? null,
        locale: a.locale ?? store.leadLocale(a.link?.leadId),
      },
      year,
    );
    await ctx.requestApproval(
      KIND_INVOICE,
      { text: this.invoiceText(inv, a.infra), invoiceId: inv.id, name: inv.client },
      `${a.link?.chain ? `${a.link.chain}\n` : ''}Счёт ${inv.number} для ${inv.client}: ${usd(inv.amountUsd)}, до ${ruDate(inv.dueDate)}. Одобрение = «счёт утверждён», отправьте его клиенту сами. Метка в скобках означает, что реквизитов нет в PAYMENT_DETAILS_JSON: нажмите «Править».${a.link?.totalUsd ? ` Сумма: ${a.link.stageNo ? `этап ${a.link.stageNo}${a.link.stageCount ? ` из ${a.link.stageCount}` : ''}` : 'часть'} точной цены пакета из КП (всего ${usd(a.link.totalUsd)}), проверьте и поправьте текст.` : ''}${this.payLinkLines(inv)}`,
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
    store.markManualPaid(inv.id);
    return this.afterPaid(store, inv.id);
  }

  /** What follows any payment (manual or on-chain): a subscription invoice moves the subscription's next due date by one period. */
  afterPaid(store: BillingStore, invoiceId: number): { invoice: Invoice; already: false; nextDue?: string } {
    const inv = store.invoice(invoiceId)!;
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
    const openLine = (i: Invoice): string => {
      const url = i.status === 'issued' && this.chainMethods(i).length ? this.payUrl(i) : null;
      return `${i.number} ${i.client}: ${usd(i.amountUsd)}${i.payAmountUsd !== i.amountUsd ? ` (к переводу ${usdt(i.payAmountUsd)} USDT)` : ''}, до ${ruDate(i.dueDate)}${i.status === 'draft' ? ' (черновик, не утверждён)' : ''}${url ? `\n  ${url}` : ''}`;
    };
    out.push(open.length ? `Неоплаченные счета (оплата USDT по ссылке проверяется автоматически каждые 2 минуты):\n${open.map(openLine).join('\n')}` : 'Неоплаченных счетов нет.');
    const paid = store.recentPaid(5);
    if (paid.length) {
      const via = (i: Invoice): string => (i.paidVia === 'manual' ? 'вручную (/paid)' : i.paidVia ? `${i.paidVia === 'usdt_trc20' ? 'USDT TRC20' : 'USDT TON'}, tx ${i.txId ?? '?'}` : 'вручную');
      out.push(`Последние оплаченные:\n${paid.map((i) => `${i.number} ${i.client}: ${usd(i.amountUsd)}, ${via(i)}`).join('\n')}`);
    }
    if (subs.length) out.push(`Подписки:\n${subs.map((s) => `${s.client}: ${usd(s.amountUsd)}/${s.period === 'year' ? 'год' : 'мес'}, следующая оплата ${ruDate(s.nextDue)}${s.method ? `, ${METHOD_LABEL[s.method]}` : ''}`).join('\n')}`);
    return out.join('\n\n');
  }
}
