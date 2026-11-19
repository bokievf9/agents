import type { Db } from '@fir/core';
import { publicInvoice, type BillingWorker, type Invoice, type PublicInvoice } from '@fir/worker-billing';

export interface PayApi {
  /** `GET /pay/:number?k=<key>`: the invoice for the site's pay page, or null (404) for an unknown number, a wrong key or a draft. */
  get: (number: string, key: string) => { ok: true; invoice: PublicInvoice } | null;
}

/** Invoice numbers look like `FT-2026-001`; anything else is a 404 without touching the database. */
const NUMBER = /^[A-Z0-9]{1,10}-\d{4}-\d{1,6}$/;
const MAX_CACHE = 500;

/**
 * The public pay page data (no token: the key in the link is the only protection, compared in constant time). The invoice row is kept
 * for 10 s per number, the key is checked on every request; an unknown number and a wrong key give the same null after the same work.
 */
export function payApi(db: Db, billing: BillingWorker, now: () => number = Date.now, tz: () => string = () => 'UTC', ttlMs = 10_000): PayApi {
  const cache = new Map<string, { at: number; inv: Invoice | undefined }>();
  const lookup = (number: string): Invoice | undefined => {
    const t = now();
    const hit = cache.get(number);
    if (hit && t - hit.at < ttlMs) return hit.inv;
    const inv = billing.store({ db, now }).byNumber(number);
    if (cache.size >= MAX_CACHE) cache.clear();
    cache.set(number, { at: t, inv });
    return inv;
  };
  return {
    get: (number, key) => {
      const n = number.trim().toUpperCase();
      const inv = NUMBER.test(n) && key.length <= 128 ? lookup(n) : undefined;
      const view = publicInvoice(inv, key, { now: now(), tz: tz(), methods: (i) => billing.chainMethods(i), addresses: billing.chainAddresses() });
      return view ? { ok: true, invoice: view } : null;
    },
  };
}
