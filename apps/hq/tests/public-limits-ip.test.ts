import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createWebhook, setTrustedProxies } from '../src/webhook.js';

afterEach(() => setTrustedProxies([]));

async function run() {
  const server = createWebhook(() => Promise.resolve(0), 'lead-tok', Date.now, undefined, { token: 'chat-tok', handle: () => Promise.reject(new Error('unused')) }, undefined, {
    status: { get: () => ({ ok: true }) },
    pay: { get: () => ({ status: 404, body: { ok: false } }) } as never,
    blog: { list: () => [], get: () => null } as never,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe('P2-9: /status, /blog and /pay limits are per visitor, not one counter and not X-Forwarded-For', () => {
  it('the peer is loopback (trusted): x-real-ip separates visitors, a changing X-Forwarded-For does not reset the limit', async () => {
    const h = await run();
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await fetch(`${h.url}/status`, { headers: { 'x-real-ip': '198.51.100.1', 'x-forwarded-for': `9.9.9.${i}` } })).status;
    expect(last).toBe(429);
    expect((await fetch(`${h.url}/status`, { headers: { 'x-real-ip': '198.51.100.2' } })).status).toBe(200);
    let blog = 0;
    for (let i = 0; i < 61; i++) blog = (await fetch(`${h.url}/blog`, { headers: { 'x-real-ip': '198.51.100.3', 'x-forwarded-for': `8.8.8.${i}` } })).status;
    expect(blog).toBe(429);
    expect((await fetch(`${h.url}/blog`, { headers: { 'x-real-ip': '198.51.100.4' } })).status).toBe(200);
    await h.close();
  });
  it('the site server: x-visitor-ip counts only together with a site token', async () => {
    const h = await run();
    for (let i = 0; i < 30; i++) await fetch(`${h.url}/status`, { headers: { 'x-visitor-ip': '203.0.113.5', 'x-chat-token': 'chat-tok' } });
    expect((await fetch(`${h.url}/status`, { headers: { 'x-visitor-ip': '203.0.113.5', 'x-chat-token': 'chat-tok' } })).status).toBe(429);
    expect((await fetch(`${h.url}/status`, { headers: { 'x-visitor-ip': '203.0.113.6', 'x-chat-token': 'chat-tok' } })).status).toBe(200);
    // without the token the header is ignored: the peer (loopback) is the key, so a fresh visitor name does not get a fresh counter
    for (let i = 0; i < 40; i++) await fetch(`${h.url}/status`, { headers: { 'x-visitor-ip': `203.0.113.${100 + i}` } });
    expect((await fetch(`${h.url}/status`, { headers: { 'x-visitor-ip': '203.0.113.250' } })).status).toBe(429);
    await h.close();
  });
});
