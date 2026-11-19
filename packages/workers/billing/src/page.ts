import { createHash, timingSafeEqual } from 'node:crypto';
import { addDays, dateStr } from './dates.js';
import type { ChainMethod, Invoice, Locale, PaidVia } from './store.js';
import { WATCH_DAYS } from './watch.js';

/** An issued invoice reads as `expired` on the page this many days after its due date (status only: `/paid` still works). */
export const EXPIRE_AFTER_DUE_DAYS = 14;

export type PageStatus = 'issued' | 'paid' | 'void' | 'expired';

export interface PayMethodView {
  id: ChainMethod;
  network: string;
  address: string;
  note: string;
}

/** The JSON the site's pay page renders (`GET /pay/:number?k=`), see `docs/public-api.md`. */
export interface PublicInvoice {
  number: string;
  title: string;
  clientFirstName: string;
  amountUsd: number;
  payAmountUsd: number;
  status: PageStatus;
  dueDate: string;
  issuedAt: string | null;
  paidAt: string | null;
  paidVia: PaidVia | null;
  txId: string | null;
  locale: Locale;
  methods: PayMethodView[];
}

const NETWORK: Record<ChainMethod, string> = { usdt_trc20: 'TRON (TRC20)', usdt_ton: 'TON' };
const NOTE: Record<ChainMethod, Record<Locale, string>> = {
  usdt_trc20: {
    ru: 'Только USDT в сети TRON (TRC20). Другие монеты и сети не дойдут. Переведите ровно указанную сумму: по ней платёж находится автоматически.',
    en: 'USDT on the TRON (TRC20) network only. Other coins and networks will not arrive. Send exactly the amount shown: that is how the payment is found automatically.',
  },
  usdt_ton: {
    ru: 'Только USDT в сети TON. Другие монеты и сети не дойдут. Переведите ровно указанную сумму: по ней платёж находится автоматически.',
    en: 'USDT on the TON network only. Other coins and networks will not arrive. Send exactly the amount shown: that is how the payment is found automatically.',
  },
};

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();
/** A key no invoice has: an unknown number is compared against it, so both 404 paths do the same work. */
const DUMMY_KEY = 'x'.repeat(32);

/** Constant-time key check (both sides hashed to 32 bytes first, so length differences do not leak). A missing stored key never matches. */
export function payKeyOk(given: string, stored: string | null | undefined): boolean {
  const eq = timingSafeEqual(digest(given), digest(stored ?? DUMMY_KEY));
  return eq && typeof stored === 'string' && stored.length >= 24;
}

/** The page status: drafts are not visible at all (null); an issued invoice past its window reads `expired`. */
export function pageStatus(inv: Invoice, now: number, tz: string): PageStatus | null {
  if (inv.status === 'draft') return null;
  if (inv.status !== 'issued') return inv.status;
  const issued = inv.issuedAt ?? inv.createdAt;
  if (now - issued > WATCH_DAYS * 86_400_000) return 'expired';
  if (dateStr(now, tz) > addDays(inv.dueDate, EXPIRE_AFTER_DUE_DAYS)) return 'expired';
  return 'issued';
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/**
 * The public view of an invoice, or null (the caller answers 404) for an unknown number, a wrong key or a draft. The addresses are
 * listed only while the invoice can be paid (`issued`); paid, void and expired views carry none.
 */
export function publicInvoice(
  inv: Invoice | undefined, key: string, opts: { now: number; tz: string; methods: (inv: Invoice) => ChainMethod[]; addresses: Partial<Record<ChainMethod, string>> },
): PublicInvoice | null {
  const ok = payKeyOk(key, inv?.payKey);
  if (!inv || !ok) return null;
  const status = pageStatus(inv, opts.now, opts.tz);
  if (!status) return null;
  const methods = status === 'issued'
    ? opts.methods(inv).flatMap((m) => (opts.addresses[m] ? [{ id: m, network: NETWORK[m], address: opts.addresses[m]!, note: NOTE[m][inv.locale] }] : []))
    : [];
  const paid = inv.status === 'paid';
  return {
    number: inv.number,
    title: inv.what,
    clientFirstName: inv.client.trim().split(/\s+/)[0] ?? '',
    amountUsd: inv.amountUsd,
    payAmountUsd: inv.payAmountUsd,
    status,
    dueDate: inv.dueDate,
    issuedAt: iso(inv.issuedAt),
    paidAt: paid ? iso(inv.paidAt) : null,
    paidVia: paid ? inv.paidVia : null,
    txId: paid ? inv.txId : null,
    locale: inv.locale,
    methods,
  };
}
