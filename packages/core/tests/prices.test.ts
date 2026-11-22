import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import fallbackJson from '../src/prices.fallback.json' with { type: 'json' };
import {
  allowedAmounts, pricesReloadMs, PRICES_REFRESH_MS, FALLBACK_PRICES, getPrices, loadPrices, parsePrices, planOf, PRICES_SETTING, PRODUCT_KEYS, setPrices, startPricesRefresh, supportMonthly, teamMonthly, teamPrice, teamSetup, type PriceStore,
} from '../src/index.js';

const memStore = (): PriceStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, get: (k) => data.get(k), set: (k, v) => void data.set(k, v) };
};
const reply = (body: unknown, status = 200): typeof fetch => (() => Promise.resolve(new Response(JSON.stringify(body), { status }))) as unknown as typeof fetch;

describe('the bundled fallback snapshot', () => {
  it('carries the v4 defaults, passes the schema and prices a team without the site', () => {
    const parsed = parsePrices(fallbackJson);
    expect(parsed).not.toBeNull();
    const p = FALLBACK_PRICES;
    expect(p.personalPlans?.map((x) => x.byokMonthly)).toEqual([14, 34, 59]);
    expect(p.companyPlan?.byokMonthly).toBe(104);
    expect(p.agentSubscription).toEqual({ setup: 220, monthly: 39, byokMonthly: 19 });
    expect(p.teamDiscountPercent).toBe(15);
    expect(p.companyPerEmployee).toBe(9);
    expect(teamPrice('sales', p)).toEqual({ agents: 3, setup: 561, monthly: 99, byokMonthly: 48 });
  });

  it('has the site shape and today\'s numbers', () => {
    expect(Object.keys(fallbackJson).sort()).toEqual(['agentSubscription', 'catalog', 'companyPerEmployee', 'companyPlan', 'contentPlans', 'currency', 'extraPrice', 'personalPlans', 'products', 'referralPercent', 'smallProjectMaxUsd', 'stages', 'startingPrice', 'teamDiscountPercent', 'updatedAt']);
    expect(parsePrices(fallbackJson)).not.toBeNull();
    const p = FALLBACK_PRICES;
    expect(p.currency).toBe('USD');
    expect(p.products).toEqual({ admin: 290, intake: 220, automation: 230, miniapp: 660, site: 150, bot: 100, app: 800 });
    expect(PRODUCT_KEYS.every((k) => k in p.products)).toBe(true);
    expect(p.startingPrice).toEqual({ websites: 150, bots: 100, apps: 800, automation: 200 });
    expect(p.catalog.websites).toEqual({ variants: { landing: 150, company: 350, shop: 700 }, addons: { language: 40, telegram: 20, payments: 60, cms: 100 } });
    expect(p.catalog.bots).toEqual({ variants: { faq: 100, booking: 250, miniapp: 600 }, addons: { payments: 60, broadcasts: 40, admin: 100, ai: 120 } });
    expect(p.catalog.apps).toEqual({ variants: { pwa: 800, mobile: 2000, internal: 1200 }, addons: { accounts: 150, payments: 100, push: 60, admin: 200 } });
    expect(p.catalog.automation).toEqual({ variants: { integration: 200, crm: 450, assistant: 500 }, addons: { sheets: 50, alerts: 30, training: 50, support: 90 } });
    expect(p.extraPrice.support).toEqual({ from: 20, monthly: true });
    expect([p.extraPrice.seo!.from, p.extraPrice.design!.from, p.extraPrice.rescue!.from]).toEqual([50, 90, 60]);
    expect(planOf('basic')).toEqual({ setup: 290, monthly: 29, byokMonthly: 14 });
    expect(planOf('plus')).toEqual({ setup: 490, monthly: 49, byokMonthly: 34 });
    expect(planOf('max')).toEqual({ setup: 790, monthly: 79, byokMonthly: 59 });
    expect(planOf('company')).toEqual({ setup: 1490, monthly: 149, byokMonthly: 104 });
    expect(p.companyByQuote).toBe(true);
    expect(() => planOf('dono')).toThrow(/no plan/); // retired, the site dropped it
    expect(planOf('content')).toEqual({ setup: 90, monthly: 60 });
    expect(p.referralPercent).toBe(10);
    expect(supportMonthly()).toBe(20);
  });

  it('parses the exact live shape of firtech.pro/api/prices (site ids, plans and quotes mapped to HQ keys)', () => {
    const live = {
      currency: 'USD', updatedAt: '2026-11-19', startingPrice: { websites: 150, bots: 100, apps: 800, automation: 200 },
      catalog: fallbackJson.catalog, extraPrice: fallbackJson.extraPrice,
      agentPlans: [{ id: 'dono', setup: 150, monthly: 15 }, { id: 'polly', setup: 100, monthly: 10 }], contentPlans: [{ id: 'content', setup: 90, monthly: 60 }], referralPercent: 10,
      products: {
        admin: { kind: 'from', from: 290 }, receptionist: { kind: 'from', from: 220 }, automation: { kind: 'from', from: 230 },
        content: { kind: 'plans', plans: [{ id: 'content', setup: 90, monthly: 60 }] }, miniapp: { kind: 'from', from: 660 },
        agent: { kind: 'plans', plans: [{ id: 'dono', setup: 150, monthly: 15 }, { id: 'polly', setup: 100, monthly: 10 }] },
        implementation: { kind: 'from', from: 550 }, custom: { kind: 'quote' },
      },
    };
    const p = parsePrices(live)!;
    expect(p).not.toBeNull();
    expect(p.products).toMatchObject({ admin: 290, intake: 220, automation: 230, miniapp: 660, site: 150, bot: 100, app: 800 });
    expect(planOf('dono', p)).toEqual({ setup: 150, monthly: 15 });
    expect(planOf('content', p)).toEqual({ setup: 90, monthly: 60 });
    expect(parsePrices(p)?.products.intake).toBe(220); // the normalised copy kept in the database parses again
    expect(parsePrices({ ...live, products: { ...live.products, receptionist: { kind: 'from', from: -1 } } })).toBeNull();
  });

  it('reads personalPlans / companyPlan from the top level or from products.<id>.plans, and agentPlans is optional', () => {
    const base = { ...fallbackJson } as Record<string, unknown>;
    delete base.personalPlans; delete base.companyPlan; // only products.personal / products.company carry them
    const p = parsePrices(base)!;
    expect(planOf('plus', p)).toEqual({ setup: 490, monthly: 49 });
    expect(planOf('company', p)).toEqual({ setup: 1490, monthly: 149 });
    expect(parsePrices(p)?.companyPlan).toEqual({ id: 'company', setup: 1490, monthly: 149 }); // the normalised copy parses again
    // the old list (Dono/Polly, no flagships) still parses; the flagships are just absent
    const old = parsePrices({ ...fallbackJson, personalPlans: undefined, companyPlan: undefined, agentPlans: [{ id: 'dono', setup: 150, monthly: 15 }], products: { ...fallbackJson.products, personal: undefined, company: undefined } })!;
    expect(old.personalPlans).toEqual([]);
    expect(old.companyPlan).toBeUndefined();
    expect(planOf('dono', old)).toEqual({ setup: 150, monthly: 15 });
  });

  it('allowedAmounts is every amount of the list and nothing else', () => {
    const a = allowedAmounts(FALLBACK_PRICES);
    for (const n of [290, 220, 230, 660, 150, 100, 800, 90, 60, 29, 49, 79, 490, 790, 1490, 149, 20, 2000, 1200, 700, 40]) expect(a.has(n), String(n)).toBe(true);
    for (const stale of [250 + 50, 550, 300, 400, 500 + 1, 25, 800 + 1]) expect(a.has(stale), String(stale)).toBe(false);
  });

  it('is validated: a broken shape is rejected', () => {
    expect(parsePrices({ ...fallbackJson, currency: 'EUR' })).toBeNull();
    expect(parsePrices({ ...fallbackJson, products: { ...fallbackJson.products, admin: { kind: 'from', from: -5 } } })).toBeNull();
    expect(parsePrices(null)).toBeNull();
    // a product may be `{ from }` too
    const grown = parsePrices({ ...fallbackJson, products: { ...fallbackJson.products, admin: { from: 295, title: 'x' } } });
    expect(grown?.products.admin).toBe(295);
  });
});

describe('the live v4 payload of firtech.pro/api/prices', () => {
  const v4 = {
    currency: 'USD', updatedAt: '2026-11-21', startingPrice: { websites: 150, bots: 100, apps: 800, automation: 200 },
    catalog: fallbackJson.catalog, extraPrice: fallbackJson.extraPrice,
    personalPlans: [{ id: 'basic', setup: 290, monthly: 29, byokMonthly: 14 }, { id: 'plus', setup: 490, monthly: 59, byokMonthly: 34 }, { id: 'max', setup: 790, monthly: 99, byokMonthly: 59 }],
    companyPlan: { id: 'company', setup: 1490, monthly: 149, byokMonthly: 104 },
    agentSubscription: { setup: 220, monthly: 39, byokMonthly: 19 }, teamDiscountPercent: 15, companyPerEmployee: 9,
    agentPlans: [{ id: 'dono', setup: 150, monthly: 15 }, { id: 'polly', setup: 100, monthly: 10 }],
    contentPlans: [{ id: 'content', setup: 90, monthly: 60 }], referralPercent: 10, smallProjectMaxUsd: 300, bundleDiscountPercent: 10,
    products: {
      personal: { kind: 'plans', plans: [{ id: 'basic', setup: 290, monthly: 29, byokMonthly: 14 }] }, company: { kind: 'plans', plans: [{ id: 'company', setup: 1490, monthly: 149, byokMonthly: 104 }], byQuote: true },
      admin: { kind: 'from', from: 290 }, receptionist: { kind: 'from', from: 220 }, automation: { kind: 'from', from: 230 },
      content: { kind: 'plans', plans: [{ id: 'content', setup: 90, monthly: 60 }] }, miniapp: { kind: 'from', from: 660 },
    },
  };
  it('parses without products.implementation / aiteam, no aiteam key and no warning', () => {
    setPrices(FALLBACK_PRICES);
    const p = parsePrices(v4)!;
    expect(p).not.toBeNull();
    expect(p.products).toMatchObject({ admin: 290, intake: 220, automation: 230, miniapp: 660, site: 150, bot: 100, app: 800 });
    expect(p.products).not.toHaveProperty('aiteam');
  });
  it('an extra products.aiteam / products.implementation from the site is ignored silently', () => {
    const p = parsePrices({ ...v4, products: { ...v4.products, aiteam: { kind: 'from', from: 999 }, implementation: { kind: 'from', from: 550 } } })!;
    expect(p).not.toBeNull();
    expect(p.products).not.toHaveProperty('aiteam');
    expect(p.products).not.toHaveProperty('implementation');
    expect(Object.values(p.products)).not.toContain(999);
  });
  it('an ИИ-команда costs the agents minus the team discount: setup, monthly and BYOK, rounded the same way', () => {
    const p = parsePrices(v4)!;
    expect(teamSetup([220, 220, 220], p)).toBe(561);
    expect(teamPrice('sales', p)).toEqual({ agents: 3, setup: 561, monthly: 99, byokMonthly: 48 });
    expect(teamPrice('support', p)).toEqual({ agents: 3, setup: 561, monthly: 99, byokMonthly: 48 });
    expect(teamPrice('marketing', p)).toEqual({ agents: 5, setup: 935, monthly: 166, byokMonthly: 81 });
    const a = allowedAmounts(p);
    for (const n of [561, 99, 48, 935, 166, 81]) expect(a.has(n)).toBe(true);
    expect(teamPrice('sales', FALLBACK_PRICES)).toEqual({ agents: 3, setup: 561, monthly: 99, byokMonthly: 48 });
  });
  it('carries setup + monthly + BYOK, the agent subscription and the team discount', () => {
    const p = parsePrices(v4)!;
    expect(planOf('plus', p)).toEqual({ setup: 490, monthly: 59, byokMonthly: 34 });
    expect(planOf('company', p)).toEqual({ setup: 1490, monthly: 149, byokMonthly: 104 });
    expect(p.agentSubscription).toEqual({ setup: 220, monthly: 39, byokMonthly: 19 });
    expect(p.teamDiscountPercent).toBe(15);
    expect(p.companyPerEmployee).toBe(9);
    expect(teamMonthly([39, 39, 39], p)).toBe(99);
    expect(allowedAmounts(p).has(104)).toBe(true);
    expect(parsePrices(p)?.companyPlan?.byokMonthly).toBe(104);
  });
  it('unknown product keys are ignored, missing ones keep the previous snapshot', async () => {
    setPrices({ ...FALLBACK_PRICES, products: { ...FALLBACK_PRICES.products, miniapp: 600 } });
    const r = await loadPrices({ store: memStore(), fetchImpl: reply({ ...v4, products: { ...v4.products, miniapp: undefined, brandNew: { kind: 'quote' } } }) });
    expect(r.source).toBe('fetched');
    expect(getPrices().products.miniapp).toBe(600);
    setPrices(FALLBACK_PRICES);
  });
  it('still parses the old shape (with implementation), which is dropped', () => {
    const old = { ...fallbackJson, products: { ...fallbackJson.products, implementation: { kind: 'from', from: 550 } } };
    expect(parsePrices(old)?.products).not.toHaveProperty('aiteam');
  });
});

describe('loadPrices', () => {
  it('fetches, validates, caches in memory and in the store with the fetch time', async () => {
    const store = memStore();
    const body = { ...fallbackJson, updatedAt: '2026-12-01', products: { ...fallbackJson.products, admin: 310 } };
    const r = await loadPrices({ url: 'https://x.test/api/prices', store, fetchImpl: reply(body), now: () => Date.UTC(2026, 11, 1, 10) });
    expect(r.source).toBe('fetched');
    expect(getPrices().products.admin).toBe(310);
    const saved = JSON.parse(store.data.get(PRICES_SETTING)!) as { fetchedAt: string; prices: { updatedAt: string } };
    expect(saved.fetchedAt).toBe('2026-12-01T10:00:00.000Z');
    expect(saved.prices.updatedAt).toBe('2026-12-01');
  });

  it('a restart without network uses the last good copy from the store', async () => {
    const store = memStore();
    await loadPrices({ store, fetchImpl: reply({ ...fallbackJson, products: { ...fallbackJson.products, site: 175 } }) });
    setPrices(FALLBACK_PRICES); // a fresh process starts from the snapshot
    expect(getPrices().products.site).toBe(150);
    const down = (() => Promise.reject(new Error('ENOTFOUND'))) as unknown as typeof fetch;
    const r = await loadPrices({ store, fetchImpl: down });
    expect(r.source).toBe('cached');
    expect(getPrices().products.site).toBe(175);
  });

  it('a bad answer (HTTP error, garbage, wrong shape) keeps what is in force; with no copy at all the snapshot stays', async () => {
    setPrices(FALLBACK_PRICES);
    for (const f of [reply({}, 500), reply({ nope: true }), (() => Promise.resolve(new Response('<html>', { status: 200 }))) as unknown as typeof fetch]) {
      const r = await loadPrices({ store: memStore(), fetchImpl: f });
      expect(r.source).toBe('fallback');
      expect(getPrices()).toBe(FALLBACK_PRICES);
    }
    const store = memStore();
    store.set(PRICES_SETTING, '{broken');
    expect((await loadPrices({ store, fetchImpl: reply({}, 503) })).source).toBe('fallback');
  });

  it('gives up after the timeout (5 s by default) instead of hanging the start', async () => {
    const slow = ((_u: string, init?: RequestInit) => new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))))) as unknown as typeof fetch;
    const t0 = Date.now();
    const r = await loadPrices({ fetchImpl: slow, timeoutMs: 120 });
    expect(r.source).toBe('fallback');
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('startPricesRefresh loads at once and again on the interval', async () => {
    let calls = 0;
    const f = (() => (calls++, Promise.resolve(new Response(JSON.stringify(fallbackJson))))) as unknown as typeof fetch;
    const h = startPricesRefresh({ fetchImpl: f }, 40);
    await h.ready;
    await new Promise((r) => setTimeout(r, 130));
    h.stop();
    expect(calls).toBeGreaterThanOrEqual(3);
  });
});

/** Every file of a folder tree, without build output and node_modules. */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    if (n === 'node_modules' || n === 'dist') return [];
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('no hardcoded product price in the agents', () => {
  const root = join(__dirname, '..', '..', '..');
  const workerFiles = walk(join(root, 'packages', 'workers')).filter((f) => /\/src\/.*\.ts$/.test(f) || /\/(prompts|kb|templates)\/.*\.md$/.test(f));
  const clientFiles = ['products.ts', 'sanitize.ts', 'prompt.ts'].map((f) => join(root, 'apps', 'hq', 'src', 'client', f));

  it('finds the worker files it is meant to scan', () => {
    expect(workerFiles.length).toBeGreaterThan(40);
    expect(workerFiles.some((f) => f.endsWith('presales/src/offers.ts'))).toBe(true);
    expect(workerFiles.some((f) => f.endsWith('prospector/src/offers.ts'))).toBe(true);
    expect(workerFiles.some((f) => f.endsWith('content-maker/src/directions.ts'))).toBe(true);
  });

  it('no `$` amount literal in the workers (src, prompts, knowledge, templates) nor in the client bot\'s price code: they read getPrices()', () => {
    const offenders: string[] = [];
    for (const f of [...workerFiles, ...clientFiles]) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/\$\s?\d{2,}/g)) offenders.push(`${f.slice(root.length)}: ${m[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  it('the old hardcoded tables are gone', () => {
    for (const f of ['presales/src/offers.ts', 'prospector/src/offers.ts', 'content-maker/src/directions.ts']) {
      const text = readFileSync(join(root, 'packages', 'workers', f), 'utf8');
      expect(text, f).toContain('getPrices');
      expect(text, f).not.toMatch(/fromUsd:\s*\d|from:\s*\d{2}|SUPPORT_MONTHLY_USD\s*=\s*\d/);
    }
  });
});

describe('reload interval', () => {
  it('15 minutes by default, PRICES_RELOAD_MS overrides, garbage falls back', () => {
    expect(PRICES_REFRESH_MS).toBe(900_000);
    expect(pricesReloadMs({})).toBe(900_000);
    expect(pricesReloadMs({ PRICES_RELOAD_MS: '60000' })).toBe(60_000);
    expect(pricesReloadMs({ PRICES_RELOAD_MS: 'x' })).toBe(900_000);
    expect(pricesReloadMs({ PRICES_RELOAD_MS: '5' })).toBe(900_000);
  });
});
