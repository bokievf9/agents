import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createWebhook } from '../src/webhook.js';

/** The methods the site's proxy (`firtech/src/lib/hq-admin.ts`) declares must reach the admin handler, not die with 405. */
async function run() {
  const seen: Array<{ method: string; path: string; body: unknown }> = [];
  const server = createWebhook(() => Promise.resolve(0), undefined, Date.now, undefined, undefined, { token: 't', handle: (r) => { seen.push({ method: r.method, path: r.path, body: r.body }); return Promise.resolve({ status: 200, body: { ok: true } }); } }, {});
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (method: string, path: string, body?: unknown) => fetch(url + path, { method, headers: { 'x-admin-token': 't', 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { seen, call, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe('admin PATCH and DELETE routes', () => {
  it('PATCH /admin/knowledge/:id reaches the handler with its body', async () => {
    const h = await run();
    expect((await h.call('PATCH', '/admin/knowledge/owner-1', { title: 'x' })).status).toBe(200);
    expect(h.seen[0]).toEqual({ method: 'PATCH', path: '/admin/knowledge/owner-1', body: { title: 'x' } });
    await h.close();
  });
  it('DELETE /admin/knowledge/:id and /admin/quality/lessons/:id reach the handler', async () => {
    const h = await run();
    expect((await h.call('DELETE', '/admin/knowledge/owner-1')).status).toBe(200);
    expect((await h.call('DELETE', '/admin/quality/lessons/5')).status).toBe(200);
    expect(h.seen.map((s) => `${s.method} ${s.path}`)).toEqual(['DELETE /admin/knowledge/owner-1', 'DELETE /admin/quality/lessons/5']);
    await h.close();
  });
  it('other PATCH and DELETE paths stay 405 (rebuild is never an id)', async () => {
    const h = await run();
    for (const [m, p] of [['DELETE', '/admin/clients/1'], ['DELETE', '/admin/knowledge/rebuild'], ['PATCH', '/admin/knowledge/rebuild'], ['PATCH', '/admin/tasks/1'], ['DELETE', '/admin/settings'], ['PUT', '/admin/knowledge/a']] as const) {
      expect((await h.call(m, p, m === 'DELETE' ? undefined : {})).status, `${m} ${p}`).toBe(405);
    }
    expect(h.seen).toEqual([]);
    await h.close();
  });
});
