import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import fallbackJson from '../src/prices.fallback.json' with { type: 'json' };
import {
  allowedAmounts, FALLBACK_PRICES, getPrices, loadPrices, parsePrices, planOf, PRICES_SETTING, PRODUCT_KEYS, setPrices, startPricesRefresh, supportMonthly, type PriceStore,
} from '../src/index.js';

const memStore = (): PriceStore & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return { data, get: (k) => data.get(k), set: (k, v) => void data.set(k, v) };
};
const reply = (body: unknown, status = 200): typeof fetch => (() => Promise.resolve(new Response(JSON.stringify(body), { status }))) as unknown as typeof fetch;

describe('the bundled fallback snapshot', () => {
  it('has the site shape and today\'s numbers', () => {
    expect(Object.keys(fallbackJson).sort()).toEqual(['agentPlans', 'catalog', 'contentPlans', 'currency', 'extraPrice', 'products', 'referralPercent', 'startingPrice', 'updatedAt']);
    expect(parsePrices(fallbackJson)).not.toBeNull();
    const p = FALLBACK_PRICES;
    expect(p.currency).toBe('USD');
    expect(p.products).toEqual({ admin: 290, intake: 220, automation: 230, miniapp: 660, aiteam: 550, site: 150, bot: 100, app: 800 });
    expect(PRODUCT_KEYS.every((k) => k in p.products)).toBe(true);
    expect(p.startingPrice).toEqual({ websites: 150, bots: 100, apps: 800, automation: 200 });
    expect(p.catalog.websites).toEqual({ variants: { landing: 150, company: 350, shop: 700 }, addons: { language: 40, telegram: 20, payments: 60, cms: 100 } });
    expect(p.catalog.bots).toEqual({ variants: { faq: 100, booking: 250, miniapp: 600 }, addons: { payments: 60, broadcasts: 40, admin: 100, ai: 120 } });
    expect(p.catalog.apps).toEqual({ variants: { pwa: 800, mobile: 2000, internal: 1200 }, addons: { accounts: 150, payments: 100, push: 60, admin: 200 } });
    expect(p.catalog.automation).toEqual({ variants: { integration: 200, crm: 450, assistant: 500 }, addons: { sheets: 50, alerts: 30, training: 50, support: 90 } });
    expect(p.extraPrice.support).toEqual({ from: 20, monthly: true });
    expect([p.extraPrice.seo!.from, p.extraPrice.design!.from, p.extraPrice.rescue!.from]).toEqual([50, 90, 60]);
    expect(planOf('dono')).toEqual({ setup: 150, monthly: 15 });
    expect(planOf('polly')).toEqual({ setup: 100, monthly: 10 });
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
    expect(p.products).toMatchObject({ admin: 290, intake: 220, automation: 230, miniapp: 660, aiteam: 550, site: 150, bot: 100, app: 800 });
    expect(planOf('dono', p)).toEqual({ setup: 150, monthly: 15 });
    expect(planOf('content', p)).toEqual({ setup: 90, monthly: 60 });
    expect(parsePrices(p)?.products.intake).toBe(220); // the normalised copy kept in the database parses again
    expect(parsePrices({ ...live, products: { ...live.products, receptionist: { kind: 'from', from: -1 } } })).toBeNull();
  });

  it('allowedAmounts is every amount of the list and nothing else', () => {
    const a = allowedAmounts(FALLBACK_PRICES);
    for (const n of [290, 220, 230, 660, 550, 150, 100, 800, 90, 60, 15, 10, 20, 2000, 1200, 700, 40]) expect(a.has(n), String(n)).toBe(true);
    for (const stale of [250 + 50, 300, 400, 500 + 1, 25, 800 + 1]) expect(a.has(stale), String(stale)).toBe(false);
  });

  it('is validated: a broken shape is rejected', () => {
    expect(parsePrices({ ...fallbackJson, currency: 'EUR' })).toBeNull();
    expect(parsePrices({ ...fallbackJson, products: { admin: { kind: 'from', from: 1 } } })).toBeNull();
    expect(parsePrices({ ...fallbackJson, agentPlans: [] })).toBeNull();
    expect(parsePrices({ ...fallbackJson, products: { ...fallbackJson.products, admin: { kind: 'from', from: -5 } } })).toBeNull();
    expect(parsePrices(null)).toBeNull();
    // a product may be `{ from }` too
    const grown = parsePrices({ ...fallbackJson, products: { ...fallbackJson.products, admin: { from: 295, title: 'x' } } });
    expect(grown?.products.admin).toBe(295);
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
