/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { describe, expect, it } from 'vitest';
import { createAdmin } from '../src/admin.js';
import { OWNER, world } from './helpers.js';

function setup(reload?: () => Promise<{ source: 'fetched' | 'cached' | 'fallback'; updatedAt: string }>) {
  const w = world({ presence: true });
  const admin = createAdmin({ hq: w.hq, queue: w.queue, director: w.director, channel: w.channel!, ownerId: OWNER, now: () => w.clock.t, commandNames: [], ...(reload ? { reloadPrices: reload } : {}) });
  return (method: string, path: string) => admin.handle({ method, path, query: new URLSearchParams(), body: undefined }).then((r) => ({ status: r.status, json: r.body as Record<string, any> }));
}

describe('POST /admin/prices/reload', () => {
  it('reloads now and answers the date and the source', async () => {
    let calls = 0;
    const call = setup(() => (calls++, Promise.resolve({ source: 'fetched' as const, updatedAt: '2026-11-21' })));
    expect(await call('POST', '/admin/prices/reload')).toEqual({ status: 200, json: { ok: true, updatedAt: '2026-11-21', source: 'fetched' } });
    expect(calls).toBe(1);
  });
  it('503 without a loader; GET is not a route', async () => {
    expect((await setup()('POST', '/admin/prices/reload')).status).toBe(503);
    expect((await setup(() => Promise.resolve({ source: 'cached' as const, updatedAt: 'x' }))('GET', '/admin/prices/reload')).status).toBe(404);
  });
});
