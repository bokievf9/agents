import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { MockLlm } from '@fir/core';
import { createWebhook, tokenOk } from '../src/webhook.js';
import { CLIENT, OWNER, setup } from './helpers.js';

describe('with an LLM (mock)', () => {
  it('uses the model extraction, retries garbage, and drafts the price text with placeholders', async () => {
    let extractCalls = 0;
    const llm = new MockLlm((req) => {
      if (req.tier === 'haiku') {
        extractCalls++;
        return extractCalls === 1 ? 'не знаю' : '{"niche":"стоматология","task":"бот для записи","deadline":"до конца месяца"}';
      }
      return 'Стоимость: [price], срок: [term].';
    });
    const { messenger, queue, say } = setup({ llm });
    await say('Здравствуйте! Мы стоматология, нужен бот записи до конца месяца. Сколько стоит?');
    expect(extractCalls).toBe(2);
    expect(messenger.to(OWNER).some((t) => t.includes('ТЁПЛЫЙ') || t.includes('ГОРЯЧИЙ'))).toBe(true);
    const price = queue.pending()[0]!;
    expect(price.payload.text).toContain('[price]');
    expect(messenger.to(CLIENT).some((t) => t.includes('['))).toBe(false);
  });

  it('falls back to heuristics when the model keeps returning garbage', async () => {
    const { messenger, say } = setup({ llm: new MockLlm(() => 'nothing useful') });
    await say('Нужен сайт для кафе, срочно');
    expect(messenger.to(CLIENT).length).toBeGreaterThan(0);
  });
});

describe('POST /lead', () => {
  async function start() {
    const ctx = setup();
    const server = createWebhook(ctx.agent, 'secret-token');
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { ...ctx, server, url };
  }
  const body = { name: 'Dilnoza', contact: '@dilnoza', service: 'bots', message: 'Нужен бот для салона, срочно', locale: 'ru' };
  const post = (url: string, token: string | null, b: unknown) =>
    fetch(`${url}/lead`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-lead-token': token } : {}) }, body: JSON.stringify(b) });

  it('checks the token, validates, stores and sends a card to the owner', async () => {
    const { server, url, messenger, leadsFile } = await start();
    try {
      expect((await post(url, null, body)).status).toBe(401);
      expect((await post(url, 'wrong', body)).status).toBe(401);
      expect((await post(url, 'secret-token', { name: '' })).status).toBe(400);
      const ok = await post(url, 'secret-token', body);
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ ok: true, id: 1 });
      const card = messenger.to(OWNER)[0]!;
      expect(card).toContain('форма firtech.pro');
      expect(card).toContain('Контакт: @dilnoza');
      expect(card).toContain('связаться вручную');
      expect((await import('node:fs')).readFileSync(leadsFile, 'utf8')).toContain('@dilnoza');
      // honeypot: normal answer, nothing stored
      const bot = await post(url, 'secret-token', { ...body, website: 'http://spam' });
      expect(bot.status).toBe(200);
      expect(messenger.to(OWNER)).toHaveLength(1);
      expect((await fetch(`${url}/health`)).status).toBe(200);
    } finally {
      server.close();
    }
  });

  it('accepts an optional source tag and puts it on the card and in the export', async () => {
    const { server, url, messenger, leadsFile } = await start();
    try {
      expect((await post(url, 'secret-token', { ...body, source: 'Bad Tag!' })).status).toBe(400);
      expect((await post(url, 'secret-token', { ...body, source: 'x'.repeat(41) })).status).toBe(400);
      expect((await post(url, 'secret-token', { ...body, source: 'instagram_bio' })).status).toBe(200);
      expect(messenger.to(OWNER)[0]).toContain('Метка источника: instagram_bio');
      const line = JSON.parse((await import('node:fs')).readFileSync(leadsFile, 'utf8').trim()) as { origin: string };
      expect(line.origin).toBe('instagram_bio');
      // without the field the lead still works and has no tag
      expect((await post(url, 'secret-token', body)).status).toBe(200);
      expect(messenger.to(OWNER)[1]).not.toContain('Метка источника');
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
