import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApprovalQueue, MemoryMessenger, MockLlm, OffLlm, openDb, type LlmClient, type LlmRequest } from '@fir/core';
import { Hq } from '@fir/hq';
import { csStoreFor } from '@fir/worker-customer-support';
import { FinanceWorker } from '@fir/worker-finance';
import { MonitoringWorker } from '@fir/worker-monitoring';
import { ProspectorWorker } from '@fir/worker-prospector';
import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/client/sanitize.js';
import { clientSinks } from '../src/client/sinks.js';
import { parseContact, WebChatEngine, type ChatRequest } from '../src/client/web.js';
import { Director } from '../src/director.js';
import { SalesHead, seedSales } from '../src/heads/sales.js';
import { SupportHead, seedSupport } from '../src/heads/support.js';
import { seedOrg } from '../src/org.js';
import { Reporter } from '../src/reporter.js';
import { createWebhook } from '../src/webhook.js';
import { instructionsDir, NOW, OWNER, routedLlm } from './sales-helpers.js';

const RULES = 'Правила этого ответа';
// 23:30 Tashkent: inside the default quiet hours 22:00-08:00
const NIGHT = Date.UTC(2026, 10, 18, 18, 30);
const SID = 'visitor-0001-abcd';

interface Opts {
  answer?: (req: LlmRequest) => string;
  llmOff?: boolean;
  llmPerSession?: number;
  perSessionHour?: number;
  perIpHour?: number;
  dailyCap?: number;
}

function world(o: Opts = {}) {
  const clock = { t: NOW };
  const db = openDb(':memory:');
  const messenger = new MemoryMessenger();
  const hq = new Hq(db, { now: () => clock.t });
  const queue = new ApprovalQueue(db, messenger, OWNER, 20, () => clock.t);
  hq.attachQueue(queue);
  seedOrg(hq, { instructionsDir, marketingBudgetUsd: 0 });
  seedSales(hq, { instructionsDir, salesBudgetUsd: 0 });
  seedSupport(hq, { supportBudgetUsd: 0 }, () => 'Инструкция головы');
  const heads = routedLlm();
  const answer = o.answer ?? (() => 'Да, делаем Telegram-ботов для салонов: запись, напоминания и отзывы. Расскажете, как сейчас идёт запись?');
  const llm: LlmClient = o.llmOff ? new OffLlm() : new MockLlm((req) => (req.system.includes(RULES) ? answer(req) : heads.complete(req)));
  const reporter = new Reporter(undefined, {}, new Map());
  const director = new Director({ hq, llm, messenger, queue, ownerId: OWNER, reporter });
  void director;
  const gate = new RateLimiter(1, o.dailyCap ?? 300, () => clock.t, () => hq.tz);
  const engine = new WebChatEngine({
    db, now: () => clock.t, tz: () => hq.tz, llm, gate, instructions: readFileSync(join(instructionsDir, 'client-bot.md'), 'utf8'),
    ...(o.llmPerSession ? { llmPerSession: o.llmPerSession } : {}), ...(o.perSessionHour ? { perSessionHour: o.perSessionHour } : {}),
    ...(o.perIpHour ? { perIpHour: o.perIpHour } : {}),
  });
  const sales = new SalesHead({ hq, llm, queue, messenger, ownerId: OWNER, reporter, prospector: new ProspectorWorker(), replyLevel: 1 });
  const monitor = new MonitoringWorker({
    urls: [], omnirouteUrl: 'http://omniroute:20128/health', dataDir: '/d', docker: false, dockerSocket: '/s', diskMaxPct: 85, certMinDays: 14, timeoutMs: 1000,
  });
  const support = new SupportHead({ hq, llm, reporter, monitor, finance: new FinanceWorker(), messenger, ownerId: OWNER });
  engine.connect(clientSinks({ hq, sales, support, invoicePrefix: 'FT' }));
  const leadTasks = () => hq.tasks({ dept: 'sales' }).filter((t) => t.meta.action === 'lead');
  const llmCalls = () => (llm instanceof MockLlm ? llm.calls.filter((c) => c.system.includes(RULES)).length : 0);
  /** One request as the HTTP layer would hand it over. */
  const say = async (message: string, extra: Partial<ChatRequest> = {}, ip = '1.1.1.1') => {
    const out = await engine.handle({ sessionId: SID, locale: 'ru', message, ...extra }, ip);
    if (out.kind !== 'ok') throw new Error(out.kind);
    return out.body;
  };
  return { clock, db, hq, engine, gate, say, leadTasks, llmCalls };
}

const ids = (b?: { id: string }[]) => (b ?? []).map((x) => x.id);

describe('greeting and language', () => {
  it('/start returns the greeting with three buttons, in the requested language', async () => {
    const w = world();
    const ru = await w.say('/start');
    expect(ru).toMatchObject({ ok: true, state: 'chat' });
    expect(ru.reply).toMatch(/Fir Tech/);
    expect(ru.buttons).toEqual([
      { id: 'intake', label: 'Обсудить проект' }, { id: 'client', label: 'Я уже клиент' }, { id: 'ask', label: 'Задать вопрос' },
    ]);
    const en = await w.say('/start', { sessionId: 'visitor-0002-abcd', locale: 'en' });
    expect(en.reply).toMatch(/Hello/);
    expect(en.buttons!.map((b) => b.label)).toEqual(['Discuss a project', 'I am a client', 'Ask a question']);
    expect(w.llmCalls()).toBe(0);
  });

  it('the first message of a new session is the greeting; a bare hello needs nothing more; a real question gets the greeting and the answer', async () => {
    const w = world();
    const hi = await w.say('Здравствуйте!');
    expect(hi.reply).toMatch(/Fir Tech/);
    expect(ids(hi.buttons)).toEqual(['intake', 'client', 'ask']);
    expect(w.llmCalls()).toBe(0);
    const q = await w.say('Делаете ботов для салонов?', { sessionId: 'visitor-0003-abcd' });
    expect(q.reply).toMatch(/Fir Tech/);
    expect(q.reply).toMatch(/салонов/);
    expect(ids(q.buttons)).toEqual(['intake', 'client', 'ask']);
  });
});

describe('intake to a web lead', () => {
  it('buttons and free text, the contact step, then done: exactly one Sales lead with source web, the contact and the page', async () => {
    const w = world();
    await w.say('/start', { page: '/ru/services' });
    const s1 = await w.say('/btn intake');
    expect(s1).toMatchObject({ state: 'intake' });
    expect(ids(s1.buttons)).toEqual(['need:site', 'need:bot', 'need:app', 'need:automation', 'need:other']);
    const s2 = await w.say('/btn need:bot');
    expect(s2.state).toBe('intake');
    expect(ids(s2.buttons)).toEqual(['deadline:urgent', 'deadline:month', 'deadline:norush']);
    const s3 = await w.say('до конца недели');
    expect(ids(s3.buttons)).toEqual(['budget:lt300', 'budget:mid', 'budget:gt1000', 'budget:unknown']);
    expect(w.leadTasks()).toHaveLength(0);
    const ask = await w.say('/btn budget:mid');
    expect(ask).toMatchObject({ state: 'contact' });
    expect(ask.reply).toMatch(/@username/);
    expect(w.leadTasks()).toHaveLength(0);

    const bad = await w.say('не скажу');
    expect(bad.state).toBe('contact');
    expect(w.leadTasks()).toHaveLength(0);
    const done = await w.say('@dilnoza_salon');
    expect(done).toMatchObject({ ok: true, state: 'done', leadCreated: true });
    expect(done.reply).toMatch(/заявка принята/i);
    const leads = w.leadTasks();
    expect(leads).toHaveLength(1);
    const lead = leads[0]!.meta.lead as Record<string, unknown>;
    expect(lead).toMatchObject({ source: 'web', contact: '@dilnoza_salon', service: 'bots', page: '/ru/services', locale: 'ru' });
    expect(lead).not.toHaveProperty('chatId');
    expect(String(lead.message)).toContain('Срок: до конца недели');
    expect(leads[0]!.title).toContain('веб-чата');

    // the session is back to a normal chat; one more message creates nothing
    const after = await w.say('спасибо');
    expect(after.state).toBe('chat');
    expect(after.leadCreated).toBeUndefined();
    expect(w.leadTasks()).toHaveLength(1);
  });

  it('English intake with a free-text need and an email contact', async () => {
    const w = world();
    const en = { locale: 'en' as const };
    await w.say('/start', en);
    await w.say('/btn intake', en);
    await w.say('A booking site for my barbershop', en);
    await w.say('/btn deadline:month', en);
    await w.say('about 500 dollars', en);
    const done = await w.say('owner@barber.example', en);
    expect(done).toMatchObject({ state: 'done', leadCreated: true });
    expect(done.reply).toMatch(/request received/i);
    const lead = w.leadTasks()[0]!.meta.lead as Record<string, unknown>;
    expect(lead).toMatchObject({ source: 'web', contact: 'owner@barber.example', locale: 'en' });
    expect(String(lead.message)).toContain('A booking site for my barbershop');
  });

  it('night: the lead is still created and the visitor hears the answer comes in the morning', async () => {
    const w = world();
    w.clock.t = NIGHT;
    await w.say('/btn intake');
    await w.say('/btn need:site');
    await w.say('/btn deadline:urgent');
    await w.say('/btn budget:unknown');
    const done = await w.say('+998 90 123 45 67');
    expect(done.state).toBe('done');
    expect(done.reply).toMatch(/ночь/);
    expect(w.leadTasks()).toHaveLength(1);
  });
});

describe('«Я уже клиент»', () => {
  it('unknown name: question, then contact, then a lead with the note; the reply is the same as for a known client', async () => {
    const w = world();
    await w.say('/btn client');
    const q = await w.say('Ромашка');
    expect(q.reply).toMatch(/вопрос/);
    const c = await w.say('Не работает форма на сайте');
    expect(c.state).toBe('contact');
    const done = await w.say('romashka@example.com');
    expect(done).toMatchObject({ state: 'done', leadCreated: true });
    const lead = w.leadTasks()[0]!.meta.lead as Record<string, unknown>;
    expect(lead).toMatchObject({ source: 'web', contact: 'romashka@example.com' });
    expect(String(lead.message)).toContain('не найден');
    expect(String(lead.message)).toContain('Не работает форма');
  });

  it('known client: a Support ticket without a chat id (the answer goes to the owner), no lead', async () => {
    const w = world();
    csStoreFor({ db: w.db, now: w.hq.now }).upsertClient({ name: 'Cambridge', contact: '@cambridge', product: 'бот записи' });
    await w.say('/btn client');
    await w.say('cambridge');
    await w.say('Как поменять пароль от админки?');
    const done = await w.say('@cambridge_admin');
    expect(done).toMatchObject({ state: 'done', leadCreated: true });
    expect(w.leadTasks()).toHaveLength(0);
    const ticket = w.hq.tasks({ dept: 'support' }).find((t) => t.meta.action === 'ticket')!;
    expect(ticket).toBeTruthy();
    expect(ticket.meta).not.toHaveProperty('chatId');
    expect(String(ticket.meta.args)).toContain('@cambridge_admin');
  });
});

describe('/btn handling', () => {
  it('a button of another step or an unknown id repeats the current question; ask opens the free conversation', async () => {
    const w = world();
    await w.say('/start');
    const stale = await w.say('/btn budget:mid');
    expect(ids(stale.buttons)).toEqual(['intake', 'client', 'ask']);
    expect(w.leadTasks()).toHaveLength(0);
    await w.say('/btn intake');
    const again = await w.say('/btn nonsense');
    expect(ids(again.buttons)).toContain('need:site');
    const ask = await w.say('/btn ask');
    expect(ask).toMatchObject({ state: 'chat' });
    expect(ids(ask.buttons)).toEqual(['intake']);
  });

  it('«other» asks for the task in words', async () => {
    const w = world();
    await w.say('/btn intake');
    const r = await w.say('/btn need:other');
    expect(r.reply).toMatch(/Опишите задачу/);
    expect(r.buttons).toBeUndefined();
  });
});

describe('free conversation', () => {
  it('the sanitiser strips a price from the model answer', async () => {
    const w = world({ answer: () => 'Делаем ботов для салонов. Стоимость такого бота от $300 за проект. Расскажете о вашем салоне?' });
    await w.say('/start');
    const r = await w.say('Что вы умеете для салона красоты?');
    expect(r.reply).not.toMatch(/\$|300/);
    expect(r.reply).toMatch(/салонов/);
    expect(w.llmCalls()).toBe(1);
  });

  it('quiet hours: the LLM still answers questions at night', async () => {
    const w = world();
    w.clock.t = NIGHT;
    await w.say('/start');
    const r = await w.say('Что вы умеете?');
    expect(w.llmCalls()).toBe(1);
    expect(r.reply).not.toMatch(/ночь/);
  });

  it('a direct price question gets the template without the LLM', async () => {
    const w = world();
    await w.say('/start');
    const r = await w.say('Сколько стоит сайт?');
    expect(w.llmCalls()).toBe(0);
    expect(r.reply).toMatch(/три коротких вопроса/);
  });

  it('per-session cap: after N answers the intake is offered and the LLM is not called again', async () => {
    const w = world({ llmPerSession: 2 });
    await w.say('/start');
    await w.say('Расскажите про ботов');
    await w.say('А про сайты?');
    expect(w.llmCalls()).toBe(2);
    const r = await w.say('А про приложения?');
    expect(w.llmCalls()).toBe(2);
    expect(r.reply).toMatch(/заявку/);
    expect(ids(r.buttons)).toEqual(['intake']);
  });

  it('the global daily cap is the shared counter; LLM off falls back to the intake offer', async () => {
    const w = world({ dailyCap: 1 });
    w.gate.llmUsed();
    await w.say('/start');
    const r = await w.say('Расскажите про ботов');
    expect(w.llmCalls()).toBe(0);
    expect(ids(r.buttons)).toEqual(['intake']);
    const off = world({ llmOff: true });
    await off.say('/start');
    expect(ids((await off.say('Привет, как дела у вас?')).buttons)).toEqual(['intake']);
  });
});

describe('sessions', () => {
  it('live in SQLite with counters and a masked summary, and expire after 24 hours', async () => {
    const w = world();
    await w.say('/start');
    await w.say('/btn intake');
    await w.say('/btn need:site');
    await w.say('/btn deadline:urgent');
    await w.say('/btn budget:mid');
    await w.say('@dilnoza_salon');
    const s = w.engine.store.get(SID)!;
    expect(s).toMatchObject({ state: 'idle', locale: 'ru', messages: 6 });
    expect(s.summary).toContain('проект: сайт');
    expect(s.summary).not.toContain('dilnoza');
    expect(JSON.stringify(s)).not.toContain('dilnoza');
    w.clock.t += 25 * 3_600_000;
    await w.say('привет', { sessionId: 'visitor-0009-abcd' });
    expect(w.engine.store.get(SID)).toBeUndefined();
  });
});

describe('contact parsing', () => {
  it('accepts a Telegram username, a t.me link, a phone and an email; rejects the rest', () => {
    expect(parseContact('@dilnoza_salon')).toBe('@dilnoza_salon');
    expect(parseContact('https://t.me/dilnoza_salon')).toBe('@dilnoza_salon');
    expect(parseContact('+998 (90) 123-45-67')).toBe('+998 (90) 123-45-67');
    expect(parseContact('a@b.co')).toBe('a@b.co');
    for (const bad of ['dilnoza', '@ab', '12345', 'hello world', '', '1'.repeat(30)]) expect(parseContact(bad)).toBeNull();
  });
});

describe('POST /chat over HTTP', () => {
  async function start(o: Opts = {}) {
    const w = world(o);
    const server = createWebhook(() => Promise.resolve(0), undefined, Date.now, undefined, { token: 'chat-secret', handle: (r, ip) => w.engine.handle(r, ip) });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (token: string | null, body: unknown, headers: Record<string, string> = {}) =>
      fetch(`${url}/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-chat-token': token } : {}), ...headers }, body: JSON.stringify(body),
      });
    return { ...w, server, url, post };
  }
  const body = { sessionId: SID, locale: 'ru', message: '/start' };

  it('checks the token (401), validates the body (400) and answers with the contract shape', async () => {
    const { server, post, url } = await start();
    try {
      expect((await post(null, body)).status).toBe(401);
      expect((await post('wrong', body)).status).toBe(401);
      for (const bad of [
        { ...body, sessionId: 'short' }, { ...body, sessionId: 'has space in it!!' }, { ...body, sessionId: 'a'.repeat(65) },
        { ...body, locale: 'de' }, { ...body, message: '' }, { ...body, message: '   ' }, { ...body, message: 'x'.repeat(1001) },
        { ...body, page: 'p'.repeat(201) }, { locale: 'ru', message: 'hi' },
      ]) {
        const r = await post('chat-secret', bad);
        expect(r.status).toBe(400);
        expect(await r.json()).toMatchObject({ ok: false, error: 'invalid' });
      }
      const broken = await fetch(`${url}/chat`, { method: 'POST', headers: { 'x-chat-token': 'chat-secret' }, body: '{nope' });
      expect(broken.status).toBe(400);
      const ok = await post('chat-secret', { ...body, page: '/ru' });
      expect(ok.status).toBe(200);
      const j = (await ok.json()) as Record<string, unknown>;
      expect(j).toMatchObject({ ok: true, state: 'chat' });
      expect(typeof j.reply).toBe('string');
      expect(j.buttons).toHaveLength(3);
      expect(j).not.toHaveProperty('leadCreated');
    } finally {
      server.close();
    }
  });

  it('503 when the engine is not wired, and the lead route is off without its token', async () => {
    const server = createWebhook(() => Promise.resolve(0), undefined);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const r = await fetch(`${url}/chat`, { method: 'POST', headers: { 'x-chat-token': 'x' }, body: JSON.stringify(body) });
      expect(r.status).toBe(503);
      expect((await fetch(`${url}/lead`, { method: 'POST', body: '{}' })).status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('503 while the company is not connected', async () => {
    const w = world();
    const bare = new WebChatEngine({ db: w.db, now: () => NOW, tz: () => 'Asia/Tashkent', llm: new OffLlm(), instructions: '', gate: w.gate });
    expect(await bare.handle({ sessionId: SID, locale: 'ru', message: 'hi' }, '1.1.1.1')).toEqual({ kind: 'unavailable' });
  });

  it('429 after 30 messages an hour per session (and the hour passes), 429 per IP, x-forwarded-for first value wins', async () => {
    const { server, post, clock } = await start({ perIpHour: 40 });
    try {
      for (let i = 0; i < 30; i++) expect((await post('chat-secret', { ...body, message: `/start` }, { 'x-forwarded-for': '9.9.9.9, 10.0.0.1' })).status).toBe(200);
      expect((await post('chat-secret', body, { 'x-forwarded-for': '9.9.9.9' })).status).toBe(429);
      // another session from the same IP still has room, until the IP limit
      let last = 200;
      for (let i = 0; i < 12; i++) last = (await post('chat-secret', { ...body, sessionId: `other-session-${i}-xx` }, { 'x-forwarded-for': '9.9.9.9' })).status;
      expect(last).toBe(429);
      // a different IP is unaffected
      expect((await post('chat-secret', { ...body, sessionId: 'another-visitor-01' }, { 'x-forwarded-for': '8.8.8.8' })).status).toBe(200);
      clock.t += 3_700_000;
      expect((await post('chat-secret', body, { 'x-forwarded-for': '9.9.9.9' })).status).toBe(200);
    } finally {
      server.close();
    }
  });
});
