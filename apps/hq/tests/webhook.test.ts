import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createWebhook, tokenOk, type WebLeadInput } from '../src/webhook.js';
import { salesWorld } from './sales-helpers.js';

describe('POST /lead', () => {
  async function start() {
    const w = salesWorld();
    const received: WebLeadInput[] = [];
    const server = createWebhook((lead) => {
      received.push(lead);
      return Promise.resolve(w.sales.createLeadTask({ name: lead.name, contact: lead.contact, service: lead.service, message: lead.message, source: lead.source }, lead.service));
    }, 'secret-token');
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { ...w, received, server, url };
  }
  const body = { name: 'Dilnoza', contact: '@dilnoza', service: 'bots', message: 'Нужен бот для салона, срочно', locale: 'ru' };
  const post = (url: string, token: string | null, b: unknown) =>
    fetch(`${url}/lead`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-lead-token': token } : {}) }, body: JSON.stringify(b) });

  it('checks the token, validates, and creates a Sales task per lead (the head wakes)', async () => {
    const { server, url, hq, received } = await start();
    try {
      expect((await post(url, null, body)).status).toBe(401);
      expect((await post(url, 'wrong', body)).status).toBe(401);
      expect((await post(url, 'secret-token', { name: '' })).status).toBe(400);
      expect(hq.tasks({ dept: 'sales' })).toHaveLength(0);
      const ok = await post(url, 'secret-token', body);
      expect(ok.status).toBe(200);
      const res = (await ok.json()) as { ok: boolean; id: number };
      expect(res.ok).toBe(true);
      const t = hq.task(res.id)!;
      expect(t).toMatchObject({ dept: 'sales', status: 'inbox', meta: { action: 'lead', lead: { contact: '@dilnoza' } } });
      expect(hq.pendingHeartbeats()).toBe(1);
      // honeypot: normal answer, nothing stored
      const bot = await post(url, 'secret-token', { ...body, website: 'http://spam' });
      expect(bot.status).toBe(200);
      expect(received).toHaveLength(1);
      expect((await fetch(`${url}/health`)).status).toBe(200);
      expect((await fetch(`${url}/nope`)).status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('accepts an optional source tag and rejects a bad one', async () => {
    const { server, url, received } = await start();
    try {
      expect((await post(url, 'secret-token', { ...body, source: 'Bad Tag!' })).status).toBe(400);
      expect((await post(url, 'secret-token', { ...body, source: 'x'.repeat(41) })).status).toBe(400);
      expect((await post(url, 'secret-token', { ...body, source: 'instagram_bio' })).status).toBe(200);
      expect(received[0]!.source).toBe('instagram_bio');
      expect((await post(url, 'secret-token', body)).status).toBe(200);
      expect(received[1]!.source).toBe('');
    } finally {
      server.close();
    }
  });

  it('rejects oversized bodies', async () => {
    const { server, url } = await start();
    try {
      const res = await post(url, 'secret-token', { ...body, message: 'x'.repeat(20_000) }).catch(() => null);
      expect(res === null || res.status === 413).toBe(true);
    } finally {
      server.close();
    }
  });

  it('compares tokens in constant time without throwing on other lengths', () => {
    expect(tokenOk('a', 'secret')).toBe(false);
    expect(tokenOk(undefined, 'secret')).toBe(false);
    expect(tokenOk('secret', 'secret')).toBe(true);
  });
});
