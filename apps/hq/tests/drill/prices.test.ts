/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles and JSON bodies */
import { loadPrices, FALLBACK_PRICES } from '@fir/core';
import { afterEach, describe, expect, it } from 'vitest';
import { drillWorld, type DrillWorld } from './world.js';
import { useGuard } from './guard.js';

const g = useGuard();
let w: DrillWorld;
afterEach(async () => { await w?.close(); });

describe('the price list: every way the site can answer', () => {
  const store = (map: Map<string, string>) => ({ get: (k: string) => map.get(k), set: (k: string, v: string) => void map.set(k, v) });
  const good = () => Promise.resolve(Response.json(JSON.parse(JSON.stringify(FALLBACK_PRICES))));
  it('fetched, then cached after a failure, then the bundled snapshot; never a throw', async () => {
    const mem = new Map<string, string>();
    expect((await loadPrices({ url: 'https://x.test/p', fetchImpl: good as any, store: store(mem) })).source).toBe('fetched');
    for (const bad of [() => Promise.resolve(new Response('nope', { status: 500 })), () => Promise.resolve(new Response('<html>', { status: 200 })), () => Promise.resolve(Response.json({ currency: 'EUR' })), () => Promise.reject(new Error('ECONNREFUSED')), () => Promise.reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' }))]) {
      expect((await loadPrices({ url: 'https://x.test/p', fetchImpl: bad as any, store: store(mem) })).source).toBe('cached');
    }
    expect((await loadPrices({ url: 'https://x.test/p', fetchImpl: (() => Promise.reject(new Error('down'))) as any, store: store(new Map()) })).source).toBe('fallback');
    expect((await loadPrices({ url: 'https://x.test/p', fetchImpl: (() => Promise.reject(new Error('down'))) as any, store: store(new Map([['prices_json', '{broken']])) })).source).toBe('fallback');
    expect(g.errors()).toEqual([]);
    g.lines.length = 0;
  });
  it('POST /admin/prices/reload answers its contract', async () => {
    w = await drillWorld();
    const r = await w.adm('POST', '/admin/prices/reload', {});
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, source: 'fetched', updatedAt: expect.any(String) });
    expect(w.reloads.n).toBe(1);
  });
});
