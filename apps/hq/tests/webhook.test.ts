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

  it('limits per visitor IP from x-visitor-ip (20 an hour); the header is read only with a valid token', async () => {
    const { server, url } = await start();
    const withIp = (ip: string, token = 'secret-token') =>
      fetch(`${url}/lead`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lead-token': token, 'x-visitor-ip': ip }, body: JSON.stringify(body) });
    try {
      for (let i = 0; i < 20; i++) expect((await withIp('198.51.100.9')).status).toBe(200);
      expect((await withIp('198.51.100.9')).status).toBe(429);
      expect((await withIp('198.51.100.10')).status).toBe(200); // another visitor
      expect((await withIp('198.51.100.9', 'wrong')).status).toBe(401); // a wrong token never reaches the limiter
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
      // the caller gets its 413 (the socket used to be destroyed before the answer, the site saw a reset: drill 2026-11-21), and the server goes on serving
      for (let i = 0; i < 3; i++) {
        const res = await post(url, 'secret-token', { ...body, message: 'x'.repeat(200_000) });
        expect(res.status).toBe(413);
        expect(await res.json()).toEqual({ ok: false, error: 'too_large' });
      }
      expect((await post(url, 'secret-token', body)).status).toBe(200);
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

describe('required tokens (no fallback to another token)', () => {
  it('ADMIN_TOKEN and WEB_CHAT_TOKEN are read only from their own variables', async () => {
    const { loadConfig } = await import('../src/config.js');
    const base = { HQ_BOT_TOKEN: '1:abc', OWNER_TELEGRAM_ID: '1', OFFICE_TOKEN: 'office', LEAD_WEBHOOK_TOKEN: 'lead' };
    const cfg = loadConfig(base);
    expect(cfg.adminToken).toBeUndefined();
    expect(cfg.webChatToken).toBeUndefined();
    expect(cfg.officeToken).toBe('office');
    expect(cfg.leadWebhookToken).toBe('lead');
    const both = loadConfig({ ...base, ADMIN_TOKEN: 'adm', WEB_CHAT_TOKEN: 'chat' });
    expect(both.adminToken).toBe('adm');
    expect(both.webChatToken).toBe('chat');
  });

  it('without them the routes answer 404, even with the office or lead token in the header', async () => {
    const server = createWebhook(() => Promise.resolve(1), 'lead', Date.now, { token: 'office', get: () => ({}) });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect((await fetch(`${url}/admin/tasks`, { headers: { 'x-admin-token': 'office' } })).status).toBe(404);
      expect((await fetch(`${url}/admin/tasks`, { headers: { 'x-admin-token': 'lead' } })).status).toBe(404);
      expect((await fetch(`${url}/chat`, { method: 'POST', headers: { 'x-chat-token': 'lead' }, body: '{}' })).status).toBe(404);
      expect((await fetch(`${url}/office`, { headers: { 'x-office-token': 'office' } })).status).toBe(200);
    } finally {
      server.close();
    }
  });
});

describe('webLeadSchema: Персональный ИИ', () => {
  it('keeps service personal and the validated personal brief, ignores malformed parts', async () => {
    const { webLeadSchema } = await import('../src/webhook.js');
    const w = webLeadSchema.parse({ name: 'A', contact: '@alice', service: 'personal', brief: { type: 'personal', tier: 'max', byok: false, hand: ['mail'], tone: { formality: 1, brevity: 2, initiative: 0 }, discovery: { si: 'https://a.b' } } });
    expect(w.service).toBe('personal');
    expect(w.brief).toMatchObject({ type: 'personal', tier: 'max', byok: false, hand: ['mail'], discovery: { si: 'https://a.b' } });
    expect(webLeadSchema.parse({ name: 'A', contact: '@alice', brief: { type: 'personal', tier: 'gold', hand: 5 } }).brief).toEqual({ type: 'personal' });
  });
});
