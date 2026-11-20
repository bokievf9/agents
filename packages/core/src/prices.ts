import { z } from 'zod';
import fallbackJson from './prices.fallback.json' with { type: 'json' };
import { errMsg, log } from './log.js';
import { stageTemplateSchema } from './stage-templates.js';

/**
 * The single source of prices for every agent: the site serves them at `GET <PRICES_URL>` (default
 * https://firtech.pro/api/prices, built from `firtech/src/lib/pricing.ts`). Nobody types a dollar amount of a product
 * into a worker: they read `getPrices()`. Order of trust: a fresh fetch, then the last good copy in the HQ database
 * (`settings.prices_json`), then the bundled `prices.fallback.json`.
 */
const amount = z.number().nonnegative().finite();
const amounts = z.record(z.string(), amount);

export const PRODUCT_KEYS = ['admin', 'intake', 'automation', 'miniapp', 'aiteam', 'site', 'bot', 'app'] as const;
export type ProductKey = (typeof PRODUCT_KEYS)[number];

const plan = z.object({ id: z.string().min(1), setup: amount, monthly: amount });
const catalogEntry = z.object({ variants: amounts, addons: amounts });

export const pricesSchema = z
  .object({
    currency: z.literal('USD'),
    updatedAt: z.string().min(1),
    startingPrice: z.object({ websites: amount, bots: amount, apps: amount, automation: amount }),
    catalog: z.object({ websites: catalogEntry, bots: catalogEntry, apps: catalogEntry, automation: catalogEntry }),
    extraPrice: z.record(z.string(), z.object({ from: amount.nullable(), page: z.string().optional(), monthly: z.boolean().optional() })),
    agentPlans: z.array(plan),
    contentPlans: z.array(plan),
    referralPercent: z.number().min(0).max(100),
    // Payment by stages (2026-11-21): templates and the small-project threshold; the built-in copy (`stage-templates.ts`) is used when the site has not published them yet.
    stages: z.array(stageTemplateSchema).optional(),
    smallProjectMaxUsd: amount.optional(),
    // The site's shape: `{kind:'from', from}`, `{kind:'plans', plans}` or `{kind:'quote'}`. A bare number or `{from}` is read too
    // (our own normalised copy, older shapes). Normalised below to the HQ keys.
    products: z.record(z.string(), z.unknown()),
  })
  .transform((p, ctx) => {
    // site id -> HQ key
    const ID: Record<string, string> = { receptionist: 'intake', implementation: 'aiteam' };
    const products: Record<string, number> = {};
    for (const [id, v] of Object.entries(p.products)) {
      let from: number | undefined;
      if (typeof v === 'number') from = v;
      else if (v && typeof v === 'object' && typeof (v as { from?: unknown }).from === 'number') from = (v as { from: number }).from;
      // kind 'plans' (content, agent) comes from contentPlans/agentPlans, kind 'quote' has no price
      if (from !== undefined && Number.isFinite(from) && from >= 0) products[ID[id] ?? id] = from;
      else if (from !== undefined) ctx.addIssue({ code: 'custom', message: `products.${id} is not a valid price` });
    }
    products.site ??= p.startingPrice.websites;
    products.bot ??= p.startingPrice.bots;
    products.app ??= p.startingPrice.apps;
    for (const k of PRODUCT_KEYS) if (!(k in products)) ctx.addIssue({ code: 'custom', message: `products.${k} is missing` });
    for (const id of ['dono', 'polly']) if (!p.agentPlans.some((x) => x.id === id)) ctx.addIssue({ code: 'custom', message: `agentPlans.${id} is missing` });
    if (!p.contentPlans.some((x) => x.id === 'content')) ctx.addIssue({ code: 'custom', message: 'contentPlans.content is missing' });
    return { ...p, products };
  });
export type Prices = z.infer<typeof pricesSchema>;

export const FALLBACK_PRICES: Prices = pricesSchema.parse(fallbackJson);

let current: Prices = FALLBACK_PRICES;

/** The prices in force right now (synchronous: fresh fetch, last good copy, or the bundled snapshot). */
export function getPrices(): Prices {
  return current;
}

/** For tests and for the loader. */
export function setPrices(p: Prices): void {
  current = p;
}

export function parsePrices(raw: unknown): Prices | null {
  const r = pricesSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/** Starting price of a site product, USD. */
export const productFrom = (key: ProductKey, p: Prices = current): number => p.products[key]!;

export interface SubscriptionPlan {
  setup: number;
  monthly: number;
}
export function planOf(id: 'dono' | 'polly' | 'content', p: Prices = current): SubscriptionPlan {
  const x = [...p.agentPlans, ...p.contentPlans].find((q) => q.id === id)!;
  return { setup: x.setup, monthly: x.monthly };
}

/** Monthly support, USD (the site's `extraPrice.support`). */
export const supportMonthly = (p: Prices = current): number => p.extraPrice.support?.from ?? 0;

export const usd = (n: number): string => `$${n}`;

/** Every dollar amount a text may contain: products, plans, catalog variants and add-ons, extras, starting prices. */
export function allowedAmounts(p: Prices = current): Set<number> {
  const s = new Set<number>();
  const add = (n: number | null | undefined) => {
    if (n) s.add(n);
  };
  for (const n of Object.values(p.products)) add(n);
  for (const n of Object.values(p.startingPrice)) add(n);
  for (const c of Object.values(p.catalog)) for (const n of [...Object.values(c.variants), ...Object.values(c.addons)]) add(n);
  for (const e of Object.values(p.extraPrice)) add(e.from);
  for (const q of [...p.agentPlans, ...p.contentPlans]) {
    add(q.setup);
    add(q.monthly);
  }
  return s;
}

export interface PriceStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}
export const PRICES_SETTING = 'prices_json';
export const DEFAULT_PRICES_URL = 'https://firtech.pro/api/prices';
export const PRICES_REFRESH_MS = 6 * 3_600_000;

export interface LoadPricesOptions {
  url?: string;
  store?: PriceStore;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}
export interface LoadPricesResult {
  source: 'fetched' | 'cached' | 'fallback';
  prices: Prices;
}

/**
 * Fetches the site's prices (5 s timeout), validates, keeps them in memory and in the store. On any failure the last
 * good copy from the store stays in force; with none, the bundled snapshot. Never throws.
 */
export async function loadPrices(opts: LoadPricesOptions = {}): Promise<LoadPricesResult> {
  const url = opts.url ?? (process.env.PRICES_URL?.trim() || DEFAULT_PRICES_URL);
  const f = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  try {
    const res = await f(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 5000), headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = parsePrices(await res.json());
    if (!parsed) throw new Error('invalid prices payload');
    current = parsed;
    try {
      opts.store?.set(PRICES_SETTING, JSON.stringify({ fetchedAt: new Date(now()).toISOString(), prices: parsed }));
    } catch (e) {
      log('warn', 'prices: cannot save the copy', { err: errMsg(e) });
    }
    return { source: 'fetched', prices: parsed };
  } catch (e) {
    log('warn', 'prices: fetch failed, using the last good copy', { err: errMsg(e) });
  }
  try {
    const raw = opts.store?.get(PRICES_SETTING);
    if (raw) {
      const cached = parsePrices((JSON.parse(raw) as { prices?: unknown }).prices);
      if (cached) {
        current = cached;
        return { source: 'cached', prices: cached };
      }
    }
  } catch {
    /* falls through to the bundled snapshot */
  }
  return { source: 'fallback', prices: current };
}

/** Loads now and then every 6 hours. Returns a stop function. */
export function startPricesRefresh(opts: LoadPricesOptions = {}, everyMs = PRICES_REFRESH_MS): { ready: Promise<LoadPricesResult>; stop: () => void } {
  const ready = loadPrices(opts);
  const timer = setInterval(() => void loadPrices(opts), everyMs);
  timer.unref();
  return { ready, stop: () => clearInterval(timer) };
}
