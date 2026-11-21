import { once } from 'node:events';
import type { IncomingMessage } from 'node:http';
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
import { chatSchema, parseContact, WebChatEngine, type ChatRequest } from '../src/client/web.js';
import { Director } from '../src/director.js';
import { SalesHead, seedSales } from '../src/heads/sales.js';
import { SupportHead, seedSupport } from '../src/heads/support.js';
import { seedOrg } from '../src/org.js';
import { Reporter } from '../src/reporter.js';
import { createWebhook, isTrustedPeer, visitorIp } from '../src/webhook.js';
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
  /** The menu buttons start the receptionist's conversation (ИИ-менеджер заявок 2.0); the older tests of this file describe the scripted intake. */
  conversation?: boolean;
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
    db, now: () => clock.t, tz: () => hq.tz, llm, gate, instructions: readFileSync(join(instructionsDir, 'client-bot.md'), 'utf8'), conversation: o.conversation ?? false,
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
  it('/start returns the greeting with four buttons, in the requested language', async () => {
    const w = world();
    const ru = await w.say('/start');
    expect(ru).toMatchObject({ ok: true, state: 'chat' });
    expect(ru.reply).toMatch(/Fir Tech/);
    expect(ru.buttons).toEqual([
      { id: 'intake', label: 'Обсудить проект' }, { id: 'products', label: 'Продукты' }, { id: 'client', label: 'Я уже клиент' }, { id: 'ask', label: 'Задать вопрос' },
    ]);
    const en = await w.say('/start', { sessionId: 'visitor-0002-abcd', locale: 'en' });
    expect(en.reply).toMatch(/Hello/);
    expect(en.buttons!.map((b) => b.label)).toEqual(['Discuss a project', 'Products', 'I am a client', 'Ask a question']);
    expect(w.llmCalls()).toBe(0);
  });

  it('the first message of a new session is the greeting; a bare hello needs nothing more; a real question gets the greeting and the answer', async () => {
    const w = world();
    const hi = await w.say('Здравствуйте!');
    expect(hi.reply).toMatch(/Fir Tech/);
    expect(ids(hi.buttons)).toEqual(['intake', 'products', 'client', 'ask']);
    expect(w.llmCalls()).toBe(0);
    const q = await w.say('Делаете ботов для салонов?', { sessionId: 'visitor-0003-abcd' });
    expect(q.reply).toMatch(/Fir Tech/);
    expect(q.reply).toMatch(/салонов/);
    expect(ids(q.buttons)).toEqual(['intake', 'products', 'client', 'ask']);
  });
});

describe('demo in the web chat', () => {
  it('«demo» or mode: demo answers with the script and the deep link, no LLM, no sandbox, no lead', async () => {
    const w = world();
    for (const r of [await w.say('demo'), await w.say('Demo', { sessionId: 'visitor-0002-abcd', locale: 'en' }), await w.say('x', { sessionId: 'visitor-0003-abcd', mode: 'demo' })]) {
      expect(r).toMatchObject({ ok: true, state: 'chat' });
      expect(r.reply).toContain('https://t.me/firtech_bot?start=demo_salon');
    }
    expect((await w.say('demo', { sessionId: 'visitor-0004-abcd' })).reply).toContain('Салона Лайм');
    expect((await w.say('demo', { sessionId: 'visitor-0005-abcd', locale: 'en' })).reply).toContain('Lime Salon');
    expect(w.llmCalls()).toBe(0);
    expect(w.leadTasks()).toHaveLength(0);
  });
});

describe('intake to a web lead', () => {
  it('buttons and free text, the contact step, then done: exactly one Sales lead with source web, the contact and the page', async () => {
    const w = world();
    await w.say('/start', { page: '/ru/services' });
    const s1 = await w.say('/btn intake');
    expect(s1).toMatchObject({ state: 'intake' });
    expect(ids(s1.buttons)).toEqual(['need:admin', 'need:receptionist', 'need:automation', 'need:content', 'need:miniapp', 'need:agent', 'need:ai', 'need:site', 'need:other']);
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

describe('products in the web chat', () => {
  it('greeting carries the product line; /btn products lists, product:<id> opens the card, need:<id> starts the intake with the product', async () => {
    const w = world();
    const hi = await w.say('/start');
    expect(hi.reply).toContain('Я ИИ-менеджер заявок Fir Tech: так же я могу принимать клиентов вашего бизнеса. Что мы делаем: ИИ-администратор, ИИ-менеджер заявок');
    const list = await w.say('/btn products');
    expect(ids(list.buttons)).toEqual(['product:admin', 'product:receptionist', 'product:automation', 'product:content', 'product:miniapp', 'product:agent', 'product:ai', 'product:site']);
    const card = await w.say('/btn product:receptionist');
    expect(card.reply).toContain('ИИ-менеджер заявок');
    expect(card.reply).toContain('Для кого');
    expect(card.reply).toContain('Что внутри');
    expect(card.reply).toContain('Этот чат и есть демо');
    expect(ids(card.buttons)).toEqual(['need:receptionist', 'products']);
    const started = await w.say('/btn need:receptionist');
    expect(started.state).toBe('intake');
    expect(ids(started.buttons)).toEqual(['deadline:urgent', 'deadline:month', 'deadline:norush']);
    await w.say('/btn deadline:month');
    await w.say('/btn budget:mid');
    await w.say('@dilnoza_salon');
    const lead = w.leadTasks()[0]!.meta.lead as Record<string, unknown>;
    expect(lead).toMatchObject({ product: 'ИИ-менеджер заявок', service: 'bots', source: 'web' });
    expect(String(lead.message)).toContain('Продукт: ИИ-менеджер заявок');
  });

  it('English cards and a niche hint after a free-text need', async () => {
    const w = world();
    const en = { locale: 'en' as const };
    await w.say('/start', en);
    const card = await w.say('/btn product:admin', en);
    expect(card.reply).toContain('AI booking assistant');
    expect(card.reply).toContain('barbershops');
    await w.say('/btn intake', en);
    const r = await w.say('We run a dental clinic', en);
    expect(r.reply).toContain('For a clinic we usually suggest “AI booking assistant”');
    expect(ids(r.buttons)).toEqual(['deadline:urgent', 'deadline:month', 'deadline:norush']);
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
    expect(ids(stale.buttons)).toEqual(['intake', 'products', 'client', 'ask']);
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

  it('a direct price question gets the price list, the stage rule and the builder link without the LLM', async () => {
    const w = world();
    await w.say('/start');
    const r = await w.say('Сколько стоит сайт?');
    expect(w.llmCalls()).toBe(0);
    expect(r.reply).toMatch(/Цены на сайте, в долларах/);
    expect(r.reply).toMatch(/Оплата по этапам/);
    expect(r.builderLink).toMatch(/^https:\/\/firtech\.pro\/ru\/builder/);
    expect(r.cta).toEqual(['builder', 'call']);
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

describe('referral in the web chat', () => {
  const finishIntake = async (w: ReturnType<typeof world>, extra: Partial<ChatRequest> = {}) => {
    await w.say('/start', extra);
    await w.say('/btn intake', extra);
    await w.say('/btn need:site', extra);
    await w.say('/btn deadline:urgent', extra);
    await w.say('/btn budget:mid', extra);
    return w.say('@dilnoza_salon', extra);
  };

  it('ref in the request is stored for the session and the lead carries source ref:<slug> (also when later messages omit it)', async () => {
    const w = world();
    await w.say('/start', { ref: 'dilnoza-77' });
    await w.say('/btn intake');
    await w.say('/btn need:site');
    await w.say('/btn deadline:urgent');
    await w.say('/btn budget:mid');
    const r = await w.say('@dilnoza_salon');
    expect(r.leadCreated).toBe(true);
    expect(w.leadTasks()[0]!.meta.lead).toMatchObject({ source: 'ref:dilnoza-77', contact: '@dilnoza_salon' });
  });

  it('without ref the source stays web; the first slug wins; a wrong pattern is rejected at the schema', async () => {
    const w = world();
    await finishIntake(w);
    expect(w.leadTasks()[0]!.meta.lead).toMatchObject({ source: 'web' });
    const v = world();
    await v.say('/start', { ref: 'first_one' });
    await finishIntake(v, { ref: 'second_one' });
    expect(v.leadTasks()[0]!.meta.lead).toMatchObject({ source: 'ref:first_one' });
    const ok = { sessionId: SID, locale: 'ru', message: 'hi' };
    expect(chatSchema.safeParse({ ...ok, ref: 'ab-c_9' }).success).toBe(true);
    expect(chatSchema.safeParse(ok).success).toBe(true);
    for (const ref of ['', 'Upper', 'has space', 'a'.repeat(33), 'sl/ash', 'ё']) expect(chatSchema.safeParse({ ...ok, ref }).success, ref).toBe(false);
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

describe('visitor IP', () => {
  const fake = (peer: string | undefined, headers: Record<string, string> = {}) => ({ socket: { remoteAddress: peer }, headers }) as unknown as IncomingMessage;

  it('x-visitor-ip counts only from loopback or the docker gateway AND with a valid site token', () => {
    for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '172.18.0.1', '172.17.0.1', '::ffff:172.20.0.1', '192.168.16.1']) {
      expect(isTrustedPeer(peer), peer).toBe(true);
      expect(visitorIp(fake(peer, { 'x-visitor-ip': '203.0.113.7' }), true), peer).toBe('203.0.113.7');
      // no valid token: the header is not believed
      expect(visitorIp(fake(peer, { 'x-visitor-ip': '203.0.113.7' }), false), peer).toBe(peer.replace('::ffff:', ''));
    }
    // any other peer: the header is ignored even with a valid token
    for (const peer of ['203.0.113.50', '8.8.8.8', '172.32.0.1', '172.15.0.1', '10.0.0.5', '2001:db8::1', undefined]) {
      expect(isTrustedPeer(peer), String(peer)).toBe(false);
      expect(visitorIp(fake(peer, { 'x-visitor-ip': '1.2.3.4' }), true)).toBe(peer ?? 'unknown');
    }
  });

  it('a missing or malformed x-visitor-ip falls back to the socket address; x-forwarded-for is never used', () => {
    expect(visitorIp(fake('127.0.0.1'), true)).toBe('127.0.0.1');
    for (const bad of ['', 'not-an-ip', '1.2.3.4, 5.6.7.8', '999.1.1.1', '<script>']) expect(visitorIp(fake('127.0.0.1', { 'x-visitor-ip': bad }), true)).toBe('127.0.0.1');
    expect(visitorIp(fake('127.0.0.1', { 'x-forwarded-for': '5.5.5.5' }), true)).toBe('127.0.0.1');
    expect(visitorIp(fake('172.18.0.1', { 'x-visitor-ip': '2001:db8::7' }), true)).toBe('2001:db8::7');
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
      expect(j.buttons).toHaveLength(4);
      expect(j).not.toHaveProperty('leadCreated');
    } finally {
      server.close();
    }
  });

  it('404 without WEB_CHAT_TOKEN (the route does not exist), and the lead route is off without its token', async () => {
    const server = createWebhook(() => Promise.resolve(0), undefined);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const r = await fetch(`${url}/chat`, { method: 'POST', headers: { 'x-chat-token': 'x' }, body: JSON.stringify(body) });
      expect(r.status).toBe(404);
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

  it('429 after 30 messages an hour per session (and the hour passes), 429 per visitor IP from x-visitor-ip, x-forwarded-for is ignored', async () => {
    const { server, post, clock } = await start({ perIpHour: 40 });
    try {
      for (let i = 0; i < 30; i++) expect((await post('chat-secret', { ...body, message: `/start` }, { 'x-visitor-ip': '9.9.9.9', 'x-forwarded-for': '1.1.1.1' })).status).toBe(200);
      expect((await post('chat-secret', body, { 'x-visitor-ip': '9.9.9.9', 'x-forwarded-for': '2.2.2.2' })).status).toBe(429);
      // another session from the same IP still has room, until the IP limit
      let last = 200;
      for (let i = 0; i < 12; i++) last = (await post('chat-secret', { ...body, sessionId: `other-session-${i}-xx` }, { 'x-visitor-ip': '9.9.9.9', 'x-forwarded-for': '2.2.2.2' })).status;
      expect(last).toBe(429);
      // a different IP is unaffected
      expect((await post('chat-secret', { ...body, sessionId: 'another-visitor-01' }, { 'x-visitor-ip': '8.8.8.8' })).status).toBe(200);
      clock.t += 3_700_000;
      expect((await post('chat-secret', body, { 'x-visitor-ip': '9.9.9.9', 'x-forwarded-for': '2.2.2.2' })).status).toBe(200);
    } finally {
      server.close();
    }
  });
});
