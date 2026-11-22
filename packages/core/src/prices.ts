import { z } from 'zod';
import fallbackJson from './prices.fallback.json' with { type: 'json' };
import { errMsg, log } from './log.js';
import { normalizeStages } from './stage-templates.js';

/**
 * The single source of prices for every agent: the site serves them at `GET <PRICES_URL>` (default
 * https://firtech.pro/api/prices, built from `firtech/src/lib/pricing.ts`). Nobody types a dollar amount of a product
 * into a worker: they read `getPrices()`. Order of trust: a fresh fetch, then the last good copy in the HQ database
 * (`settings.prices_json`), then the bundled `prices.fallback.json`.
 */
const amount = z.number().nonnegative().finite();
const amounts = z.record(z.string(), amount);

export const PRODUCT_KEYS = ['admin', 'intake', 'automation', 'miniapp', 'site', 'bot', 'app'] as const;
export type ProductKey = (typeof PRODUCT_KEYS)[number];

// `byokMonthly` (v4, 2026-11-22): the monthly price when the client brings their own model key.
const plan = z.object({ id: z.string().min(1), setup: amount, monthly: amount, byokMonthly: amount.optional() });
const subscription = z.object({ setup: amount, monthly: amount, byokMonthly: amount.optional() });

// The prices in force; declared before the schema because the schema fills a missing product from it.
let baseProducts: Record<string, number> | undefined;
const warned = new Set<string>();
const catalogEntry = z.object({ variants: amounts, addons: amounts });

export const pricesSchema = z
  .object({
    currency: z.literal('USD'),
    updatedAt: z.string().min(1),
    startingPrice: z.object({ websites: amount, bots: amount, apps: amount, automation: amount }),
    catalog: z.object({ websites: catalogEntry, bots: catalogEntry, apps: catalogEntry, automation: catalogEntry }),
    extraPrice: z.record(z.string(), z.object({ from: amount.nullable(), page: z.string().optional(), monthly: z.boolean().optional() })),
    // The retired Dono/Polly plans (2026-11-22): the site drops them, so they are optional here and nothing requires them.
    agentPlans: z.array(plan).optional(),
    // The flagships (2026-11-22): `personalPlans` basic/plus/max (setup + monthly), `companyPlan` (setup + monthly, the price is «from», the exact sum by quote).
    personalPlans: z.array(plan).optional(),
    companyPlan: plan.optional(),
    contentPlans: z.array(plan),
    // v4: one agent's subscription, the team discount (percent off the sum of the agents) and the per-employee price of the company plan.
    agentSubscription: subscription.optional(),
    teamDiscountPercent: z.number().min(0).max(100).optional(),
    companyPerEmployee: amount.optional(),
    referralPercent: z.number().min(0).max(100),
    // Payment by stages (2026-11-21): templates and the small-project threshold; the built-in copy (`stage-templates.ts`) is used when the site has not published them yet.
    stages: z.unknown().optional(),
    smallProjectMaxUsd: amount.optional(),
    // The builder's bundle discount in percent (the site's `bundleDiscountPercent`); 10 when the site does not publish it yet.
    bundleDiscountPercent: z.number().min(0).max(50).optional(),
    // The site's shape: `{kind:'from', from}`, `{kind:'plans', plans}` or `{kind:'quote'}`. A bare number or `{from}` is read too
    // (our own normalised copy, older shapes). Normalised below to the HQ keys.
    products: z.record(z.string(), z.unknown()),
    // our own normalised copy keeps the live names (see `product-names.ts`)
    titles: z.record(z.string(), z.object({ ru: z.string().optional(), en: z.string().optional() })).optional(),
  })
  .transform((p, ctx) => {
    // site id -> HQ key
    const ID: Record<string, string> = { receptionist: 'intake' };
    // retired product (the site stopped sending it): ignored silently; a team costs `teamMonthly()` of its agents, the whole company is `companyPlan`
    const RETIRED = new Set(['aiteam', 'implementation']);
    const products: Record<string, number> = {};
    // live product names: `products.<id>.title` as a string (Russian) or `{ ru, en }` (the site may publish them; `product-names.ts` reads them first)
    const titles: Record<string, { ru?: string; en?: string }> = { ...(p.titles ?? {}) };
    for (const [id, v] of Object.entries(p.products)) {
      if (RETIRED.has(id)) continue;
      const t = v && typeof v === 'object' ? (v as { title?: unknown }).title : undefined;
      const named = typeof t === 'string' ? { ru: t } : t && typeof t === 'object' ? (t as { ru?: unknown; en?: unknown }) : undefined;
      if (named) {
        const entry: { ru?: string; en?: string } = {};
        if (typeof named.ru === 'string' && named.ru.trim()) entry.ru = named.ru.trim().slice(0, 80);
        if (typeof (named as { en?: unknown }).en === 'string' && (named as { en: string }).en.trim()) entry.en = (named as { en: string }).en.trim().slice(0, 80);
        if (entry.ru || entry.en) titles[ID[id] ?? id] = entry;
      }
      let from: number | undefined;
      if (typeof v === 'number') from = v;
      else if (v && typeof v === 'object' && typeof (v as { from?: unknown }).from === 'number') from = (v as { from: number }).from;
      // kind 'plans' (content, personal, company) comes from contentPlans/personalPlans/companyPlan, kind 'quote' has no price
      if (from !== undefined && Number.isFinite(from) && from >= 0) products[ID[id] ?? id] = from;
      else if (from !== undefined) ctx.addIssue({ code: 'custom', message: `products.${id} is not a valid price` });
    }
    // unknown keys are ignored; a missing product keeps the previous snapshot value (or the bundled default), one warning lists them
    const missing: string[] = [];
    for (const k of PRODUCT_KEYS) {
      if (k in products || k === 'site' || k === 'bot' || k === 'app') continue;
      const keep = baseProducts?.[k];
      if (keep !== undefined) products[k] = keep;
      missing.push(k);
    }
    if (missing.length) {
      const w = missing.join(',');
      if (!warned.has(w)) { warned.add(w); log('warn', 'prices: the site did not send some products, keeping the previous values', { missing }); }
    }
    products.site ??= p.startingPrice.websites;
    products.bot ??= p.startingPrice.bots;
    products.app ??= p.startingPrice.apps;
    // the flagships' plans: the top-level fields, else the `plans` of `products.personal` / `products.company` (the site publishes both)
    const plansOf = (id: string): unknown[] => {
      const v = p.products[id];
      const list = v && typeof v === 'object' ? (v as { plans?: unknown }).plans : undefined;
      return Array.isArray(list) ? list : [];
    };
    const okPlans = (l: unknown[]) => l.flatMap((x) => { const r = plan.safeParse(x); return r.success ? [r.data] : []; });
    const personalPlans = p.personalPlans ?? okPlans(plansOf('personal'));
    const companyPlan = p.companyPlan ?? okPlans(plansOf('company'))[0];
    const byQuote = Boolean(p.products.company && typeof p.products.company === 'object' && (p.products.company as { byQuote?: unknown }).byQuote) || undefined;
    if (!p.contentPlans.some((x) => x.id === 'content')) ctx.addIssue({ code: 'custom', message: 'contentPlans.content is missing' });
    const out = { ...p, agentPlans: p.agentPlans ?? [], personalPlans, bundleDiscountPercent: p.bundleDiscountPercent ?? 10, products, titles, stages: normalizeStages(p.stages, (m, x) => log('warn', m, x)), companyByQuote: byQuote ?? Boolean(companyPlan) };
    return companyPlan ? { ...out, companyPlan } : out;
  });
export type Prices = z.infer<typeof pricesSchema>;

export const FALLBACK_PRICES: Prices = pricesSchema.parse(fallbackJson);
baseProducts = FALLBACK_PRICES.products;
let current: Prices = FALLBACK_PRICES;

/** The prices in force right now (synchronous: fresh fetch, last good copy, or the bundled snapshot). */
export function getPrices(): Prices {
  return current;
}

/** For tests and for the loader. */
export function setPrices(p: Prices): void {
  current = p;
  baseProducts = p.products;
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
export type PlanId = 'dono' | 'polly' | 'content' | 'basic' | 'plus' | 'max' | 'company';
/** A plan of the list by id: the content plan, a Персональный ИИ level (`basic`/`plus`/`max`), the ИИ-компания plan (`company`, «from», the exact sum by quote) or a retired Dono/Polly plan. */
export function planOf(id: PlanId, p: Prices = current): SubscriptionPlan & { byokMonthly?: number } {
  const x = [...(p.agentPlans ?? []), ...p.contentPlans, ...(p.personalPlans ?? []), ...(p.companyPlan ? [p.companyPlan] : [])].find((q) => q.id === id);
  if (!x) throw new Error(`prices: no plan "${id}" in the list`);
  return x.byokMonthly === undefined ? { setup: x.setup, monthly: x.monthly } : { setup: x.setup, monthly: x.monthly, byokMonthly: x.byokMonthly };
}

/** The Персональный ИИ levels of the list, cheapest first (empty when the site has not published them). */
export const personalPlans = (p: Prices = current): Array<SubscriptionPlan & { id: string }> => [...(p.personalPlans ?? [])].sort((a, b) => a.setup - b.setup);
/** One agent's subscription (setup, monthly, own-key monthly), or undefined when the site has not published it. */
export const agentSubscription = (p: Prices = current): (SubscriptionPlan & { byokMonthly?: number }) | undefined => p.agentSubscription;
/** A team's monthly price: the sum of the agents' monthly prices minus the team discount (`teamDiscountPercent`, 0 when absent). */
export const teamMonthly = (agentMonthlies: number[], p: Prices = current): number => {
  const sum = agentMonthlies.reduce((a, b) => a + b, 0);
  return Math.round(sum * (1 - (p.teamDiscountPercent ?? 0) / 100));
};

/** A team's one-time setup: the sum of the agents' setup prices minus the same team discount, rounded the same way as `teamMonthly()`. */
export const teamSetup = (agentSetups: number[], p: Prices = current): number => teamMonthly(agentSetups, p);

/** The agents a department sells as one ИИ-команда: the roles of its chart row (`role-titles.ts`, those with a `company` title; heads are not sold). */
export const DEPARTMENT_AGENTS = {
  sales: ['lead-intake', 'prospector', 'presales'],
  marketing: ['content-maker', 'trend-scout', 'publisher', 'seo', 'analyst'],
  support: ['customer-support', 'monitoring', 'billing'],
  production: ['project-manager', 'reviewer', 'deployer'],
  backoffice: ['finance', 'documents', 'knowledge'],
} as const;
export type TeamDepartment = keyof typeof DEPARTMENT_AGENTS;
export const TEAM_DEPARTMENTS = Object.keys(DEPARTMENT_AGENTS) as TeamDepartment[];

export interface TeamPrice {
  agents: number;
  setup: number;
  monthly: number;
  /** Monthly with the client's own model key; absent when the agent subscription has no BYOK price. */
  byokMonthly?: number;
}
/** An ИИ-команда of a department: every agent at `agentSubscription`, setup and monthly (and BYOK) minus `teamDiscountPercent`. Undefined when the site has not published the agent subscription. */
export function teamPrice(dept: TeamDepartment, p: Prices = current): TeamPrice | undefined {
  const a = p.agentSubscription;
  if (!a) return undefined;
  const n = DEPARTMENT_AGENTS[dept].length;
  const each = (v: number) => Array<number>(n).fill(v);
  const out: TeamPrice = { agents: n, setup: teamSetup(each(a.setup), p), monthly: teamMonthly(each(a.monthly), p) };
  if (a.byokMonthly !== undefined) out.byokMonthly = teamMonthly(each(a.byokMonthly), p);
  return out;
}

/** The ИИ-компания plan, or undefined. */
export const companyPlan = (p: Prices = current): (SubscriptionPlan & { id: string }) | undefined => p.companyPlan;

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
  for (const q of [...(p.agentPlans ?? []), ...p.contentPlans, ...(p.personalPlans ?? []), ...(p.companyPlan ? [p.companyPlan] : [])]) {
    add(q.setup);
    add(q.monthly);
    add(q.byokMonthly);
  }
  if (p.agentSubscription) for (const n of [p.agentSubscription.setup, p.agentSubscription.monthly, p.agentSubscription.byokMonthly]) add(n);
  add(p.companyPerEmployee);
  for (const dept of TEAM_DEPARTMENTS) {
    const t = teamPrice(dept, p);
    if (t) { add(t.setup); add(t.monthly); add(t.byokMonthly); }
  }
  return s;
}

export interface PriceStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}
export const PRICES_SETTING = 'prices_json';
export const DEFAULT_PRICES_URL = 'https://firtech.pro/api/prices';
/** Reload interval: 15 minutes (the site's Пульт edits prices without a deploy); env `PRICES_RELOAD_MS` overrides it. */
export const PRICES_REFRESH_MS = 15 * 60_000;
export function pricesReloadMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.PRICES_RELOAD_MS);
  return Number.isFinite(n) && n >= 1000 ? Math.floor(n) : PRICES_REFRESH_MS;
}

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
    baseProducts = parsed.products;
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
        baseProducts = cached.products;
        return { source: 'cached', prices: cached };
      }
    }
  } catch {
    /* falls through to the bundled snapshot */
  }
  return { source: 'fallback', prices: current };
}

/** Loads now and then every `PRICES_RELOAD_MS` (default 15 minutes). Returns a stop function. */
export function startPricesRefresh(opts: LoadPricesOptions = {}, everyMs = pricesReloadMs()): { ready: Promise<LoadPricesResult>; stop: () => void } {
  const ready = loadPrices(opts);
  const timer = setInterval(() => void loadPrices(opts), everyMs);
  timer.unref();
  return { ready, stop: () => clearInterval(timer) };
}
