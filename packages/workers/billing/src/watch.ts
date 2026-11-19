import { fetchTransfers, microToCents, type ChainGet, type ChainTransfer } from './chain.js';
import { toCents, type BillingStore, type ChainMethod, type Invoice } from './store.js';

/** The watcher looks at invoices issued in the last 45 days. */
export const WATCH_DAYS = 45;
/** After this long without a good answer from a provider the owner gets one alert. */
export const PROVIDER_ALERT_MS = 30 * 60_000;
const BACKOFF_MIN_MS = 2 * 60_000;
const BACKOFF_MAX_MS = 30 * 60_000;
const DAY = 86_400_000;
/** The largest under-payment `PAY_TOLERANCE` may allow, in percent. */
export const MAX_TOLERANCE_PCT = 0.5;

const PROVIDER: Record<ChainMethod, string> = { usdt_trc20: 'TronGrid (USDT TRC20)', usdt_ton: 'toncenter (USDT TON)' };
const NET: Record<ChainMethod, string> = { usdt_trc20: 'TRC20', usdt_ton: 'TON' };

/** `PAY_TOLERANCE`: under-payment allowed, in percent (`0.5`, `0.5%`); empty is 0 (exact). Above 0.5% or garbage is an error. */
export function parseTolerance(raw: string | undefined): number {
  if (!raw?.trim()) return 0;
  const m = /^(\d+(?:\.\d+)?)\s*%?$/.exec(raw.trim());
  const v = m ? Number(m[1]) : Number.NaN;
  if (!Number.isFinite(v) || v < 0 || v > MAX_TOLERANCE_PCT) throw new Error(`PAY_TOLERANCE must be a percent between 0 and ${MAX_TOLERANCE_PCT} (for example 0.5)`);
  return v;
}

export interface WatchOptions {
  /** Our receiving addresses (from `PAYMENT_DETAILS_JSON`). */
  addresses: Partial<Record<ChainMethod, string>>;
  get: ChainGet;
  keys?: { trongrid?: string; toncenter?: string };
  /** Allowed under-payment in percent (0 = exact, the default). */
  tolerancePct?: number;
}

export interface WatchMatch {
  invoice: Invoice;
  transfer: ChainTransfer;
}

export interface WatchResult {
  matched: WatchMatch[];
  /** Owner alerts: unmatched transfers (once each), a provider down for 30 minutes (once per outage) and its recovery. */
  alerts: string[];
  /** Methods asked this cycle (for tests and logs). */
  polled: ChainMethod[];
}

interface ProviderState {
  failingSince: number | null;
  backoffMs: number;
  nextTryAt: number;
  alerted: boolean;
}

/** Which chain methods an invoice may be paid with: its own USDT method, or both when it names none. A wallet-only invoice has none. */
export function chainMethodsOf(inv: Pick<Invoice, 'method'>): ChainMethod[] {
  if (inv.method === 'usdt_trc20' || inv.method === 'usdt_ton') return [inv.method];
  if (inv.method === 'wallet') return [];
  return ['usdt_trc20', 'usdt_ton'];
}

const amount = (micro: bigint): string => (Number(micro) / 1e6).toFixed(2);

/**
 * The on-chain payment watcher (every 2 minutes, day and night). One request per method and cycle, then every new transfer is
 * matched to the open invoices: same chain method allowed, arrived after the invoice was issued, amount equal to the pay amount in
 * cents (or, with `PAY_TOLERANCE`, short of it by at most that percent and then only when exactly one invoice fits). Exact beats
 * tolerance; among exact matches the oldest invoice wins. A transfer that fits nothing is stored unmatched and reported once.
 */
export class PaymentWatcher {
  private readonly state = new Map<ChainMethod, ProviderState>();
  private readonly tolerance: number;

  constructor(private readonly opts: WatchOptions) {
    this.tolerance = opts.tolerancePct ?? 0;
  }

  get enabled(): boolean {
    return Boolean(this.opts.addresses.usdt_trc20 || this.opts.addresses.usdt_ton);
  }

  private st(m: ChainMethod): ProviderState {
    let s = this.state.get(m);
    if (!s) {
      s = { failingSince: null, backoffMs: 0, nextTryAt: 0, alerted: false };
      this.state.set(m, s);
    }
    return s;
  }

  async cycle(store: BillingStore, now: number): Promise<WatchResult> {
    const out: WatchResult = { matched: [], alerts: [], polled: [] };
    const open = store.openForWatch(now - WATCH_DAYS * DAY);
    const taken = new Set<number>();
    for (const method of ['usdt_trc20', 'usdt_ton'] as const) {
      const address = this.opts.addresses[method];
      if (!address) continue;
      const mine = open.filter((i) => chainMethodsOf(i).includes(method));
      if (mine.length === 0) continue;
      const s = this.st(method);
      if (now < s.nextTryAt) {
        this.maybeAlertDown(method, s, now, out);
        continue;
      }
      out.polled.push(method);
      const since = Math.min(...mine.map((i) => i.issuedAt!));
      const key = method === 'usdt_trc20' ? this.opts.keys?.trongrid : this.opts.keys?.toncenter;
      const r = await fetchTransfers(this.opts.get, method, address, since, key);
      if (!r.ok) {
        s.failingSince ??= now;
        s.backoffMs = Math.min(BACKOFF_MAX_MS, Math.max(BACKOFF_MIN_MS, s.backoffMs * 2));
        s.nextTryAt = now + (r.retryable ? s.backoffMs : BACKOFF_MIN_MS);
        this.maybeAlertDown(method, s, now, out);
        continue;
      }
      if (s.alerted) out.alerts.push(`${PROVIDER[method]} снова отвечает, проверка оплат ${NET[method]} работает.`);
      this.state.set(method, { failingSince: null, backoffMs: 0, nextTryAt: 0, alerted: false });
      const transfers = [...r.transfers].sort((a, b) => a.txTime - b.txTime || a.txId.localeCompare(b.txId));
      const seenNow = new Set<string>();
      for (const t of transfers) {
        if (seenNow.has(t.txId) || store.payment(t.txId)) continue;
        seenNow.add(t.txId);
        const inv = this.pick(mine.filter((i) => !taken.has(i.id) && i.issuedAt! <= t.txTime), t);
        if (inv && store.recordChainPayment(inv.id, t)) {
          taken.add(inv.id);
          out.matched.push({ invoice: store.invoice(inv.id)!, transfer: t });
          continue;
        }
        if (t.txTime < since) continue; // older than every open invoice: not ours to judge (the provider filter should already drop it)
        if (store.recordUnmatched(t)) {
          out.alerts.push(`Пришёл перевод ${amount(t.amountMicro)} USDT (${NET[t.method]}), tx ${t.txId}, но ни один открытый счёт не совпал по сумме и времени. Проверьте и отметьте счёт вручную: /paid <номер>.`);
        }
      }
    }
    return out;
  }

  /** The invoice a transfer pays, or null when none fits or the fit is ambiguous. */
  private pick(cands: Invoice[], t: ChainTransfer): Invoice | null {
    const cents = microToCents(t.amountMicro);
    const exact = cands.filter((i) => toCents(i.payAmountUsd) === cents);
    if (exact.length) return exact[0]!; // candidates come oldest first
    if (this.tolerance <= 0) return null;
    const near = cands.filter((i) => {
      const want = toCents(i.payAmountUsd);
      return cents < want && cents >= Math.ceil(want * (1 - this.tolerance / 100));
    });
    return near.length === 1 ? near[0]! : null;
  }

  private maybeAlertDown(method: ChainMethod, s: ProviderState, now: number, out: WatchResult): void {
    if (s.failingSince !== null && !s.alerted && now - s.failingSince >= PROVIDER_ALERT_MS) {
      s.alerted = true;
      out.alerts.push(`${PROVIDER[method]} не отвечает больше 30 минут: оплаты ${NET[method]} сейчас не проверяются автоматически. Если клиент прислал чек, отметьте счёт вручную: /paid <номер>.`);
    }
  }
}
