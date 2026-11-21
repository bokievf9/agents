import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MockLlm, OffLlm, openDb, productList, smallProjectMaxUsd, type LlmClient, type LlmRequest } from '@fir/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeBuild } from '../src/client/builder-link.js';
import { DEMO_TURNS, personaSystem } from '../src/client/persona.js';
import {
  enrichmentOf, findContact, intentScore, MAX_QUALIFY_TURNS, merge, needReply, newQ, nextSlot, normalizeQ, parseModel, priceProducts, summaryLines, wantsPerson, type QState,
} from '../src/client/receptionist.js';
import { PRODUCT_IDS, PRODUCTS } from '../src/client/products.js';
import { RateLimiter } from '../src/client/sanitize.js';
import type { ClientSinks } from '../src/client/engine.js';
import { chatSchema, WebChatEngine, type ChatReply, type ChatRequest } from '../src/client/web.js';
import { instructionsDir } from './helpers.js';

/**
 * ИИ-менеджер заявок 2.0 on the web chat with the model replaced by `MockLlm`: the qualification state machine, the builder link, the persona switch of the demo tab,
 * a signed-in client, the hand-off, the limits and the `text.detect` rewrite. The mock plays the model: it answers the receptionist's JSON contract.
 */
const SID = 'visitor-9001-abcd';
const RULES = 'Правила этого ответа';
const NOW = Date.UTC(2026, 10, 22, 7, 0);

interface ModelTurn {
  reply: string;
  ready?: boolean;
  intent?: string;
  extract?: Record<string, unknown>;
}
const json = (t: ModelTurn): string => JSON.stringify(t);

function world(o: { turns?: (req: LlmRequest, n: number) => string; llm?: LlmClient; slots?: () => Promise<number[]>; perIpDemoHour?: number; llmPerSession?: number; clientMessage?: ClientSinks['clientMessage'] } = {}) {
  const clock = { t: NOW };
  const db = openDb(':memory:');
  const leads: Record<string, unknown>[] = [];
  const tickets: { client: string; text: string }[] = [];
  const toThread: { email: string; text: string }[] = [];
  const sinks: ClientSinks = {
    createLead: (lead) => (leads.push(lead), leads.length),
    createTicket: (client, text) => (tickets.push({ client, text }), Promise.resolve(tickets.length)),
    findClient: () => null,
    leadSlots: () => null,
    clientMessage: o.clientMessage ?? ((c, text) => (toThread.push({ email: c.email, text }), Promise.resolve(1))),
  };
  const mock = new MockLlm((req, n) => {
    if (req.system.includes('Перепиши реплику')) return 'Понял, салон красоты. Что сейчас мешает больше всего: вечерние заявки или ручная запись?';
    return (o.turns ?? (() => json({ reply: 'Расскажите, чем занимаетесь?' })))(req, n);
  });
  const llm: LlmClient = o.llm ?? mock;
  const engine = new WebChatEngine({
    db, now: () => clock.t, tz: () => 'Asia/Dushanbe', llm, gate: new RateLimiter(1, 500, () => clock.t, () => 'Asia/Dushanbe'),
    instructions: readFileSync(join(instructionsDir, 'client-bot.md'), 'utf8'), sinks,
    ...(o.slots ? { slots: o.slots } : {}), ...(o.perIpDemoHour ? { perIpDemoHour: o.perIpDemoHour } : {}), ...(o.llmPerSession ? { llmPerSession: o.llmPerSession } : {}),
  });
  const say = async (message: string, extra: Partial<ChatRequest> = {}, ip = '9.9.9.9'): Promise<ChatReply> => {
    const out = await engine.handle(chatSchema.parse({ sessionId: SID, locale: 'ru', message, ...extra }), ip);
    if (out.kind !== 'ok') throw new Error(out.kind);
    return out.body;
  };
  const raw = async (message: string, extra: Partial<ChatRequest> = {}, ip = '9.9.9.9') => engine.handle(chatSchema.parse({ sessionId: SID, locale: 'ru', message, ...extra }), ip);
  const calls = () => (llm instanceof MockLlm ? llm.calls : []);
  const receptionistCalls = () => calls().filter((c) => c.system.includes(RULES));
  return { clock, db, engine, leads, tickets, toThread, say, raw, calls, receptionistCalls, llm };
}

/** The scripted model of a salon owner's conversation: it reports what it heard and asks the next thing. */
const salonModel = (req: LlmRequest, n: number): string => {
  const said = req.messages.at(-1)!.content;
  if (/салон/i.test(said) && n === 1) return json({ reply: 'Салон красоты, понятно. Что сейчас мешает больше всего: теряются вечерние заявки или запись идёт вручную?', extract: { niche: 'салон красоты', kind: 'salon' } });
  if (/Instagram/i.test(said)) {
    return json({ reply: 'Ясно, заявки приходят в Instagram и вечером остаются без ответа. Для салона обычно подходит бот-администратор: он записывает клиентов сам.', ready: true, extract: { pain: 'вечерние заявки из Instagram остаются без ответа', channels: ['instagram'], goals: ['booking'] } });
  }
  return json({ reply: 'Понял вас. Подскажите, пожалуйста, подробнее.' });
};

describe('qualification: from the first words to the builder link', () => {
  it('a salon owner: two turns, the builder link first, the call second, no Telegram, state kept', async () => {
    const w = world({ turns: salonModel });
    const transcript: string[] = [];
    const a = await w.say('Здравствуйте, у меня салон красоты в Душанбе');
    transcript.push(`Посетитель: Здравствуйте, у меня салон красоты в Душанбе`, `Приёмщик: ${a.reply.replace(/^.*?\n\n/s, '')}`);
    expect(a.cta).toBeUndefined();
    expect(a.reply).toMatch(/Что сейчас мешает/);
    expect(a.builderLink).toBeUndefined();

    const b = await w.say('Теряются заявки вечером, они приходят в Instagram');
    transcript.push('Посетитель: Теряются заявки вечером, они приходят в Instagram', `Приёмщик: ${b.reply}`);
    expect(b.cta).toEqual(['builder', 'call']);
    expect(b.builderLink).toMatch(/^https:\/\/firtech\.pro\/ru\/builder\?b=/);
    // the link is the site's: kind, product (the receptionist's `admin` is the builder's `adminbot`), goal and channel are filled
    const code = decodeURIComponent(new URL(b.builderLink!).searchParams.get('b')!);
    expect(decodeBuild(code)).toEqual({ extras: [], kind: 'salon', products: ['adminbot'], goals: ['booking'], channels: ['instagram'] });
    // the order of the offers: the builder link before the call; Telegram is not mentioned
    expect(b.reply.indexOf('/ru/builder')).toBeGreaterThan(-1);
    expect(b.reply.indexOf('/ru/builder')).toBeLessThan(b.reply.indexOf('созвон'));
    expect(b.reply).not.toMatch(/t\.me|Telegram|телеграм/i);
    expect(b.reply).toMatch(/@username/);
    expect(b.reply).toMatch(/предложу время для созвона/);
    // the text the model wrote is first, the offers follow
    expect(b.reply.startsWith('Ясно, заявки приходят в Instagram')).toBe(true);
    // the model saw the qualification rules, the slots known so far and the question number
    const second = w.receptionistCalls()[1]!.system;
    expect(second).toMatch(/бизнес: салон красоты/);
    expect(second).toMatch(/Цены только из списка/);
    expect(w.receptionistCalls()[0]!.system).toMatch(/это вопрос номер 1/);
    // nothing became a lead yet
    expect(w.leads).toEqual([]);
    // the next turn after the proposal is an answer, not a second proposal
    const c = await w.say('А сколько времени это занимает?');
    expect(c.cta).toBeUndefined();
    expect(c.builderLink).toBeUndefined();
    expect(w.receptionistCalls().at(-1)!.system).toMatch(/Сборка уже предложена/);
    if (process.env.SHOW_TRANSCRIPT) process.stderr.write(`\n${transcript.join('\n')}\n`);
  });

  it('three questions at most: the fourth turn does not ask, it proposes with whatever is known', async () => {
    const w = world({ turns: () => json({ reply: 'Понял. А что ещё для вас важно?' }) });
    expect(MAX_QUALIFY_TURNS).toBe(3);
    for (let i = 1; i <= MAX_QUALIFY_TURNS; i++) {
      const r = await w.say(`ответ ${i}`);
      expect(r.cta).toBeUndefined();
    }
    const last = await w.say('ответ последний');
    expect(w.receptionistCalls().map((c) => /это вопрос номер/.test(c.system))).toEqual([true, true, true, false]);
    expect(w.receptionistCalls().at(-1)!.system).toMatch(/НЕ задавай вопроса/);
    expect(last.cta).toEqual(['builder', 'call']);
    // the proposal carries no trailing question
    expect(last.reply.split('\n\n')[0]).not.toMatch(/\?\s*$/);
    expect(last.builderLink).toMatch(/\/ru\/builder$/);
  });

  it('the slots go in the order of the playbook: business, pain, product, channels, timeline, budget', () => {
    const q: QState = newQ();
    const order: string[] = [];
    const fill: Partial<QState>[] = [{ niche: 'кафе' }, { pain: 'нет ответов ночью' }, { products: ['receptionist'] }, { channels: ['telegram'] }, { timeline: 'month' }, { budget: 'до $500' }];
    let cur = q;
    for (const f of fill) {
      order.push(nextSlot(cur)!);
      cur = { ...cur, ...f };
    }
    expect(order).toEqual(['niche', 'pain', 'product', 'channels', 'timeline', 'budget']);
    expect(nextSlot(cur)).toBeNull();
  });

  it('English locale: the replies and the offers are in English', async () => {
    const w = world({ turns: () => json({ reply: 'A cafe, got it. Anything else?', ready: true, extract: { kind: 'cafe', pain: 'nobody answers at night', product: 'receptionist' } }) });
    const r = await w.say('I run a cafe and nobody answers at night', { locale: 'en' });
    expect(r.reply).toMatch(/You can put the project together yourself/);
    expect(r.reply).toMatch(/If a call is easier/);
    expect(r.builderLink).toMatch(/\/en\/builder\?b=k\.cafe~p\.intake/);
  });

  it('plain text from the model (no JSON) is still the reply, nothing is extracted from it', async () => {
    const w = world({ turns: () => 'Да, делаем ботов для салонов. Расскажите, как сейчас идёт запись?' });
    const r = await w.say('Делаете ботов для салонов?');
    expect(r.reply).toMatch(/Расскажите, как сейчас идёт запись/);
    expect(parseModel('{"reply": 5}').reply).toBe('{"reply": 5}');
  });
});

describe('the lead of a conversation: enrichment on the card', () => {
  it('a contact after the proposal makes one lead with the summary, the product family, the niche, the intent score and the link', async () => {
    const w = world({ turns: salonModel });
    await w.say('У меня салон красоты');
    const prop = await w.say('Теряются заявки вечером, они приходят в Instagram');
    const done = await w.say('Хорошо, мой телеграм @dilnoza_salon');
    expect(done).toMatchObject({ state: 'done', leadCreated: true });
    expect(done.reply).toMatch(/Записал, менеджер напишет/);
    expect(w.leads).toHaveLength(1);
    const lead = w.leads[0]!;
    expect(lead).toMatchObject({ contact: '@dilnoza_salon', service: 'bots', product: 'ИИ-администратор', source: 'web', estimate: '' });
    const e = lead.enrichment as { summary: string[]; productFamily: string; niche: string; intentScore: number; builderLink: string };
    expect(e.summary).toHaveLength(3);
    expect(e.summary[0]).toMatch(/Бизнес: салон красоты; задача: вечерние заявки/);
    expect(e.summary[1]).toMatch(/Подходит: ИИ-администратор; каналы: instagram/);
    expect(e.summary[2]).toMatch(/Предложено: сборку по ссылке, созвон; контакт оставил/);
    expect(e).toMatchObject({ productFamily: 'admin', niche: 'салон красоты' });
    expect(e.intentScore).toBeGreaterThanOrEqual(60);
    expect(e.builderLink).toBe(new URL(prop.builderLink!).pathname + new URL(prop.builderLink!).search);
    expect(lead.message).toMatch(/Задача \(словами клиента\): вечерние заявки/);
    // the session summary has no words of the visitor
    expect(w.engine.store.get(SID)!.summary).toMatch(/разговор: admin, намерение \d+ · задача #1/);
  });

  it('the intent score grows with what the visitor gave; the summary is always three lines', () => {
    const q = newQ();
    const scores = [intentScore(q, false)];
    q.kind = 'salon';
    scores.push(intentScore(q, false));
    q.pain = 'x';
    q.products = ['admin'];
    scores.push(intentScore(q, false));
    q.timeline = 'asap';
    q.askedPrice = true;
    scores.push(intentScore(q, false), intentScore(q, true));
    expect([...scores].sort((a, b) => a - b)).toEqual(scores);
    expect(scores.at(-1)).toBeLessThanOrEqual(100);
    expect(summaryLines(q)).toHaveLength(3);
    expect(enrichmentOf({ ...q, link: '/ru/builder?b=k.salon' }, true)).toMatchObject({ productFamily: 'admin', niche: 'salon', builderLink: '/ru/builder?b=k.salon' });
  });

  it('a signed-in visitor\'s lead is linked to the account (email, id, name travel with it) and the contact is the email', async () => {
    const w = world({ turns: salonModel });
    await w.say('У меня салон красоты', { clientEmail: 'anvar@example.com', cabinetId: 'sb-1', clientName: 'Анвар' });
    const r = await w.say('Заявки в Instagram теряются', { clientEmail: 'anvar@example.com', cabinetId: 'sb-1', clientName: 'Анвар' });
    expect(r.cta).toEqual(['builder', 'call']);
    // a contact is not asked for from a signed-in client: the account is the contact
    expect(w.leads).toEqual([]);
    const call = await w.say('Давайте созвонимся', { clientEmail: 'anvar@example.com', cabinetId: 'sb-1', clientName: 'Анвар' });
    expect(call).toMatchObject({ state: 'done', leadCreated: true });
    expect(w.leads).toHaveLength(1);
    expect(w.leads[0]).toMatchObject({ contact: 'anvar@example.com', name: 'Анвар', clientEmail: 'anvar@example.com', cabinetId: 'sb-1', clientName: 'Анвар', product: 'ИИ-администратор' });
    expect((w.leads[0]!.enrichment as { builderLink: string }).builderLink).toMatch(/^\/ru\/builder\?b=k\.salon/);
    // asked once: a second call request makes no second lead
    await w.say('И ещё раз про созвон', { clientEmail: 'anvar@example.com', cabinetId: 'sb-1', clientName: 'Анвар' });
    expect(w.leads).toHaveLength(1);
  });
});

describe('prices: only from the price list, with the stage rule', () => {
  it('a price question: the list of getPrices(), the stage rule with the small-project limit, the builder link; the model is not called', async () => {
    const w = world();
    const r = await w.say('Сколько стоит бот?');
    expect(w.calls()).toHaveLength(0);
    expect(r.reply).toMatch(/Цены на сайте, в долларах: .*от \$\d+/s);
    expect(r.reply).toContain(`проект до $${smallProjectMaxUsd()} идёт в два этапа 50 на 50`);
    expect(r.reply).toMatch(/Точную цену и срок называем до старта/);
    expect(r.cta).toEqual(['builder', 'call']);
    const en = await w.say('How much does it cost?', { locale: 'en' });
    expect(en.reply).toMatch(/Prices as on the site, in USD/);
    expect(en.reply).toMatch(/Payment is by stages/);
  });

  it('a price the model invents never reaches the visitor (the sentence is cut by the sanitiser)', async () => {
    const w = world({ turns: () => json({ reply: 'Бот-администратор стоит $999 вместо обычных. Расскажите про ваш бизнес, подберу формат?' }) });
    const r = await w.say('Расскажите про бота');
    expect(r.reply).not.toContain('$999');
    expect(r.reply).toMatch(/Расскажите про ваш бизнес/);
  });
});

describe('hand-off: a person on request or frustration', () => {
  it('asks for a person: a contact is asked for, then one lead that says so, in the owner\'s chats; the model is not called', async () => {
    const w = world({ turns: salonModel });
    await w.say('У меня салон красоты');
    const calls = w.receptionistCalls().length;
    const ask = await w.say('Позовите живого менеджера');
    expect(ask).toMatchObject({ state: 'contact', handoff: true });
    expect(ask.reply).toMatch(/Передаю разговор человеку/);
    expect(w.receptionistCalls()).toHaveLength(calls);
    const done = await w.say('+992 90 123 45 67');
    expect(done).toMatchObject({ state: 'done', leadCreated: true, handoff: true });
    expect(w.leads).toHaveLength(1);
    expect(w.leads[0]).toMatchObject({ handoff: true, contact: '+992 90 123 45 67' });
    expect((w.leads[0]!.enrichment as { summary: string[] }).summary[2]).toMatch(/просил живого менеджера/);
    expect(w.leads[0]!.message).toMatch(/Ниша: салон красоты/);
  });

  it('frustration: an upset visitor, or the same message three times, calls a person; «не надо» leaves the contact step', async () => {
    const w = world({ turns: salonModel });
    const upset = await w.say('Это бред, вы меня не понимаете');
    expect(upset).toMatchObject({ state: 'contact', handoff: true });
    expect(upset.reply).toMatch(/позову человека/);
    const out = await w.say('не надо');
    expect(out).toMatchObject({ state: 'chat' });
    const w3 = world({ turns: () => json({ reply: 'Расскажите подробнее?' }) });
    await w3.say('а?');
    await w3.say('а?');
    const third = await w3.say('а?');
    expect(third).toMatchObject({ state: 'contact', handoff: true });
  });

  it('a signed-in client who asks for a person, or about their project, goes to their thread: no new lead, a thread message and a ticket path', async () => {
    const w = world({ turns: salonModel });
    const who = { clientEmail: 'dilnoza@example.com', clientName: 'Дилноза' };
    const q = await w.say('Когда будет готов мой проект и этап оплаты?', who);
    expect(q.reply).toMatch(/Передал в вашу переписку с командой/);
    const p = await w.say('Хочу поговорить с менеджером', who);
    expect(p).toMatchObject({ handoff: true });
    expect(w.toThread).toHaveLength(2);
    expect(w.toThread[0]).toMatchObject({ email: 'dilnoza@example.com' });
    expect(w.toThread[1]!.text).toMatch(/Просит живого менеджера в чате на сайте/);
    expect(w.leads).toEqual([]);
    expect(w.receptionistCalls()).toHaveLength(0);
  });

  it('wantsPerson reads both languages and does not fire on ordinary words', () => {
    for (const t of ['позовите человека', 'хочу поговорить с менеджером', 'соедините с оператором', 'I want a real person', 'let me talk to a human', 'это бред']) expect(wantsPerson(t), t).not.toBeNull();
    for (const t of ['нужен бот для менеджеров по продажам', 'сколько стоит', 'we are an HR agency']) expect(wantsPerson(t), t).toBeNull();
  });
});

describe('Telegram only when the visitor insists', () => {
  it('the proposal never carries Telegram; «давайте в Telegram» adds it after the builder', async () => {
    const w = world({ turns: salonModel });
    await w.say('У меня салон красоты');
    const prop = await w.say('Заявки в Instagram теряются');
    expect(prop.reply).not.toMatch(/t\.me/);
    const tg = await w.say('Давайте лучше в Telegram');
    expect(tg.cta).toContain('telegram');
    expect(tg.reply).toContain('https://t.me/firtech_bot');
    // the t.me link is allowed, but one line pulls back to the builder: always the builder offer with the link in the text
    expect(tg.cta).toContain('builder');
    expect(tg.reply.indexOf('t.me')).toBeLessThan(tg.reply.indexOf('/builder'));
    expect(tg.reply).toMatch(/Если хотите, за минуту соберу проект, чтобы в Telegram говорить уже с ценой: https:\/\/firtech\.pro\/ru\/builder/);
    expect(tg.builderLink).toMatch(/\/ru\/builder\?b=/);
    expect(w.receptionistCalls()).toHaveLength(2);
  });
});

describe('a call: the site\'s slots when reachable, «предложу время» otherwise', () => {
  const ms = (d: number, h: number) => Date.UTC(2026, 10, d, h, 0);
  it('the free slots of the site are named; a failing slots source falls back to the plain offer', async () => {
    const ok = world({ turns: salonModel, slots: () => Promise.resolve([ms(23, 5), ms(24, 9), ms(25, 5)]) });
    await ok.say('У меня салон красоты');
    const r = await ok.say('Заявки в Instagram теряются');
    expect(r.reply).toMatch(/ближайшие окна для созвона: [^.]*23[^.]*; [^.]*24/);
    const bad = world({ turns: salonModel, slots: () => Promise.reject(new Error('site down')) });
    await bad.say('У меня салон красоты');
    expect((await bad.say('Заявки в Instagram теряются')).reply).toMatch(/предложу время для созвона/);
  });

  it('«давайте созвонимся» is answered with the offers at once, the model is not called', async () => {
    const w = world();
    const r = await w.say('Давайте созвонимся');
    expect(w.calls()).toHaveLength(0);
    expect(r.cta).toContain('call');
  });
});

describe('own words: text.detect on every reply, one rewrite', () => {
  const slop = 'Это не просто бот, это революционное решение для вашего салона в современном мире.';
  it('a flagged reply is rewritten once and the rewrite is what the visitor gets', async () => {
    const w = world({ turns: () => json({ reply: slop }) });
    const r = await w.say('У меня салон красоты');
    expect(r.reply.endsWith('Понял, салон красоты. Что сейчас мешает больше всего: вечерние заявки или ручная запись?')).toBe(true);
    expect(r.reply).not.toContain('революционное');
    expect(w.calls().filter((c) => c.system.includes('Перепиши реплику'))).toHaveLength(1);
    expect(w.calls()).toHaveLength(2);
    expect(w.calls()[1]!.system).toMatch(/революционное|современном мире/);
  });

  it('a clean reply is left alone: no rewrite call', async () => {
    const w = world({ turns: () => json({ reply: 'Понял, салон красоты. А что сейчас мешает: теряются заявки вечером или запись идёт вручную?' }) });
    await w.say('У меня салон красоты');
    expect(w.calls()).toHaveLength(1);
  });

  it('a rewrite that comes back as a stub is not taken', async () => {
    const llm = new MockLlm((req) => (req.system.includes('Перепиши реплику') ? 'ок' : json({ reply: slop })));
    const w = world({ llm });
    const r = await w.say('У меня салон красоты');
    expect(r.reply.endsWith(slop)).toBe(true);
  });
});

describe('the demo tab: persona', () => {
  const demoModel = (req: LlmRequest): string => (/Клиника «Здоровье\+»/.test(req.system) ? 'Здравствуйте, клиника «Здоровье+». Записать вас к терапевту или стоматологу?' : 'Здравствуйте, салон «Лиза». Какая услуга нужна?');

  it('persona switches the voice to the niche, nothing is stored, no lead, no ticket, no session row', async () => {
    const w = world({ turns: demoModel });
    const clinic = await w.say('Хочу записаться', { persona: 'clinic' });
    expect(clinic).toMatchObject({ ok: true, state: 'chat', demo: true });
    expect(clinic.reply).toMatch(/клиника «Здоровье\+»/);
    const salon = await w.say('Хочу записаться', { persona: 'salon', sessionId: 'visitor-9003-abcd' });
    expect(salon.reply).toMatch(/салон «Лиза»/);
    // the system prompt of the demo is the persona of the niche with its facts and slots
    expect(w.calls()[0]!.system).toMatch(/Принимают терапевт, стоматолог, невролог/);
    expect(w.calls()[0]!.system).toMatch(/Это демонстрация: ничего не записывается/);
    // a contact in a demo is not a lead
    await w.say('Меня зовут Анвар, +992 90 123 45 67', { persona: 'clinic' });
    expect(w.leads).toEqual([]);
    expect(w.tickets).toEqual([]);
    expect(w.engine.store.count()).toBe(0);
    expect(w.engine.store.get(SID)).toBeUndefined();
  });

  it('the demo keeps its own turns (the model sees the earlier ones) and a «живой человек» is a line of the demo, not a hand-off', async () => {
    const w = world({ turns: demoModel });
    await w.say('Хочу записаться', { persona: 'clinic' });
    await w.say('На завтра', { persona: 'clinic' });
    const last = w.calls().at(-1)!;
    expect(last.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    const p = await w.say('позовите менеджера', { persona: 'clinic' });
    expect(p.handoff).toBeUndefined();
    expect(p.state).toBe('chat');
    expect(w.leads).toEqual([]);
  });

  it('per-IP limit of demo sessions, and a cap on replies per session', async () => {
    const w = world({ turns: demoModel, perIpDemoHour: 3 });
    for (let i = 0; i < 3; i++) await w.say('привет', { persona: 'shop', sessionId: `visitor-91${i}-abcdef` }, '5.5.5.5');
    expect((await w.raw('привет', { persona: 'shop', sessionId: 'visitor-9199-abcdef' }, '5.5.5.5')).kind).toBe('rate_limited');
    // another address is not affected
    expect((await w.raw('привет', { persona: 'shop', sessionId: 'visitor-9199-abcdef' }, '6.6.6.6')).kind).toBe('ok');
    const v = world({ turns: demoModel });
    let last: ChatReply | null = null;
    for (let i = 0; i <= DEMO_TURNS; i++) last = await v.say(`вопрос ${i}`, { persona: 'cafe' }, `7.7.${i}.1`);
    expect(last!.reply).toMatch(/Это демо, в нём ограничено число реплик/);
    expect(v.calls()).toHaveLength(DEMO_TURNS);
  });

  it('the log of a demo has counts only, never the words', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const w = world({ turns: demoModel });
      await w.say('секретная фраза посетителя', { persona: 'salon' });
      const lines = spy.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes('web chat demo'))).toBe(true);
      expect(lines.join('\n')).not.toContain('секретная фраза');
      const demoLine = JSON.parse(lines.find((l) => l.includes('web chat demo'))!) as Record<string, unknown>;
      expect(Object.keys(demoLine).sort()).toEqual(['level', 'msg', 'persona', 'sessions', 't']);
    } finally {
      spy.mockRestore();
    }
  });

  it('the model off or the gateway down: a scripted line, never an error; English visitors get English', async () => {
    const w = world({ llm: new OffLlm() });
    expect((await w.say('привет', { persona: 'salon' })).reply).toMatch(/Демо сейчас недоступно/);
    expect((await w.say('hi', { persona: 'salon', locale: 'en', sessionId: 'visitor-9004-abcd' })).reply).toMatch(/The demo is not available/);
  });

  it('the schema: persona is one of the niches, `text` and `message` both carry the words, one of them is required', () => {
    const ok = { sessionId: SID, locale: 'ru' };
    expect(chatSchema.safeParse({ ...ok, message: 'привет', persona: 'clinic' }).success).toBe(true);
    expect(chatSchema.safeParse({ ...ok, text: 'привет', persona: 'shop' })).toMatchObject({ success: true, data: { message: 'привет' } });
    expect(chatSchema.safeParse({ ...ok, text: 'привет', persona: 'bank' }).success).toBe(false);
    expect(chatSchema.safeParse(ok).success).toBe(false);
    expect(chatSchema.safeParse({ ...ok, message: 'привет', clientEmail: 'not-an-email' })).toMatchObject({ success: true, data: { clientEmail: undefined } });
    expect(personaSystem('shop', 'ru', NOW, 'Asia/Dushanbe')).toMatch(/Магазин «Дом и уют»/);
  });
});

describe('limits and fallbacks', () => {
  it('the per-session cap of model answers sends the visitor to the scripted intake offer', async () => {
    const w = world({ turns: () => json({ reply: 'Понял. Расскажите ещё?' }), llmPerSession: 2 });
    await w.say('раз');
    await w.say('два');
    const r = await w.say('три');
    expect(w.receptionistCalls()).toHaveLength(2);
    expect(r.buttons?.map((b) => b.id)).toEqual(['intake']);
  });

  it('the menu button starts the conversation (a scripted first question, no model call, no form); with the model off it is the scripted intake', async () => {
    const w = world({ turns: salonModel });
    await w.say('/start');
    const r = await w.say('/btn intake');
    expect(r.reply).toMatch(/чем занимается ваш бизнес/);
    expect(r.buttons).toBeUndefined();
    expect(w.calls()).toHaveLength(0);
    const off = world({ llm: new OffLlm() });
    await off.say('/start');
    expect((await off.say('/btn intake')).buttons?.length).toBeGreaterThan(3);
  });

  it('a contact written by itself, with no conversation, still makes a lead (never lost)', async () => {
    const w = world();
    const r = await w.say('Мой email anvar@example.com, пишите');
    expect(r).toMatchObject({ state: 'done', leadCreated: true });
    expect(w.leads[0]).toMatchObject({ contact: 'anvar@example.com' });
  });

  it('findContact: an amount of money is not a phone', () => {
    expect(findContact('бюджет 1 000 000 сум')).toBeNull();
    expect(findContact('до $5000')).toBeNull();
    expect(findContact('мой номер +998 90 123 45 67')).toBe('+998 90 123 45 67');
    expect(findContact('пишите @dilnoza_salon')).toBe('@dilnoza_salon');
    expect(findContact('https://t.me/dilnoza_salon')).toBe('@dilnoza_salon');
  });
});

afterEach(() => vi.restoreAllMocks());

describe('receptionist gaps (owner remarks 2026-11-21): need first, right link, one question, honest prices', () => {
  const dump = (): string => `Мы делаем: ${productList('ru')}. Что вас интересует?`;

  it('a named need is answered with its product and ONE question, never the list of all products; the list comes on «что вы делаете»', async () => {
    const w = world({ turns: (_req, n) => (n === 1 ? json({ reply: dump(), extract: { product: 'bot', kind: 'salon' } }) : json({ reply: dump() })) });
    const first = await w.say('хочу бота для салона');
    expect(PRODUCT_IDS.filter((id) => first.reply.split('\n\n')[1]!.includes(PRODUCTS[id].name.ru)).length).toBeLessThanOrEqual(1);
    // the greeting in front of it is the short one: no list of the seven products on a first message that names a need
    expect(first.reply).toMatch(/^Здравствуйте\. Я ИИ-менеджер заявок Fir Tech\.\n\n/);
    expect(first.reply).toContain('ИИ-администратор');
    expect(first.reply.match(/\?/g)).toHaveLength(1);
    expect(first.cta).toBeUndefined();
    // «что вы делаете»: here the list is wanted
    const all = await w.say('а что вы делаете вообще?');
    // a fresh visitor who asks that gets the whole welcome with the list
    const asked = await world({ turns: () => json({ reply: 'Расскажу.' }) }).say('Что вы делаете?', { sessionId: 'visitor-9200-abcd' });
    expect(PRODUCT_IDS.filter((id) => asked.reply.includes(PRODUCTS[id].name.ru))).toHaveLength(PRODUCT_IDS.length);
    expect(PRODUCT_IDS.filter((id) => all.reply.includes(PRODUCTS[id].name.ru)).length).toBeGreaterThanOrEqual(4);
  });

  it('a salon\'s «бот» is the ИИ-администратор in the link (k.salon~p.adminbot), never p.bot, even when the model says bot', async () => {
    const w = world({
      turns: (_req, n) => (n === 1
        ? json({ reply: 'Понял, салон. Что сейчас теряется?', extract: { product: 'bot', kind: 'salon', niche: 'салон' } })
        : json({ reply: 'Ясно, вечерние заявки теряются.', ready: true, extract: { pain: 'заявки вечером', product: 'bot' } })),
    });
    await w.say('хочу бота для салона');
    const r = await w.say('вечером заявки теряются');
    expect(r.cta).toContain('builder');
    expect(r.builderLink).toBe('https://firtech.pro/ru/builder?b=k.salon~p.adminbot');
    expect(decodeBuild(new URL(r.builderLink!).searchParams.get('b'))).toMatchObject({ kind: 'salon', products: ['adminbot'] });
  });

  it('«не хочу сайт, только агент» after the proposal: the link is regenerated with l.playground and z.no and always sent as the builder offer, no model call', async () => {
    const w = world({ turns: salonModel });
    await w.say('У меня салон красоты');
    const prop = await w.say('Заявки в Instagram теряются');
    expect(prop.builderLink).not.toMatch(/z\.no/);
    const calls = w.receptionistCalls().length;
    const r = await w.say('не хочу сайт, только агент');
    expect(r.cta).toEqual(['builder']);
    expect(r.builderLink).toMatch(/~l\.playground~z\.no/);
    expect(r.reply).toContain(r.builderLink);
    expect(decodeBuild(new URL(r.builderLink!).searchParams.get('b'))).toMatchObject({ delivery: ['playground'], siteNeed: 'no' });
    expect(w.receptionistCalls()).toHaveLength(calls);
  });

  it('the price answer names the 1-3 products that fit, no Dono or Polly, no double period, and points to the builder for the rest', async () => {
    const w = world({ turns: salonModel });
    await w.say('У меня салон красоты');
    await w.say('Заявки в Instagram теряются');
    const r = await w.say('сколько стоит?');
    expect(r.reply).not.toMatch(/Dono|Polly/);
    expect(r.reply).not.toMatch(/\.\./);
    expect(r.reply).toMatch(/Остальное и точную сумму под вас считает сборка проекта/);
    const named = PRODUCT_IDS.filter((id) => r.reply.split('\n\n')[0]!.includes(PRODUCTS[id].name.ru));
    expect(named.length).toBeGreaterThanOrEqual(1);
    expect(named.length).toBeLessThanOrEqual(3);
    expect(r.reply).toContain('ИИ-администратор от $');
    expect(r.builderLink).toMatch(/p\.adminbot/);
    // a visitor with no known need gets a default of three, still without the personal agents
    const cold = await world({ turns: salonModel }).say('Сколько стоит?', { sessionId: 'visitor-9100-abcd' });
    expect(cold.reply).not.toMatch(/Dono|Polly|Персональный ИИ-ассистент/);
    expect(cold.reply).not.toMatch(/\.\./);
  });

  it('the demo takes no contact: the persona prompt offers a time to book and closes politely; no «приёмщик» anywhere in it', () => {
    for (const persona of ['salon', 'clinic', 'shop', 'cafe', 'service', 'courses'] as const) {
      const system = personaSystem(persona, 'ru', NOW, 'Asia/Dushanbe');
      expect(system, persona).toContain('На какое время вас записать?');
      expect(system, persona).toMatch(/НЕ спрашивай и не проси оставить/);
      expect(system, persona).not.toMatch(/собирать (заказы и )?контакты|сбор контактов/);
      expect(system, persona).not.toMatch(/приём?щик/iu);
    }
    expect(DEMO_TURNS).toBeGreaterThan(0);
  });
});

describe('several products in one dialogue (the builder allows several)', () => {
  const start = (products: QState['products'], extra: Partial<QState> = {}): QState => ({ ...newQ(), kind: 'salon', ...(products ? { products } : {}), ...extra });

  /** [state before, visitor's words, products after]: an explicit need adds, «только» replaces, a negated need removes, a guess nobody saw is replaced. */
  const rows: [string, QState, string, string[]][] = [
    ['adds «и ещё сайт» to an explicit administrator', start(['admin']), 'и ещё сайт', ['admin', 'site']],
    ['adds in the catalogue order, not the order of speech', start(['site']), 'и ещё администратор', ['admin', 'site']],
    ['two needs in one message', start([]), 'нужен администратор и сайт', ['admin', 'site']],
    ['«только X» replaces the list', start(['admin', 'site']), 'только сайт', ['site']],
    ['«не нужен X» removes one', start(['admin', 'site']), 'сайт не нужен', ['admin']],
    ['«не хочу сайт» removes the site and sets z.no', start(['admin', 'site']), 'не хочу сайт', ['admin']],
    ['a repeated need is not doubled', start(['admin']), 'нужен администратор для записи', ['admin']],
    ['a guess nobody saw is replaced by the first explicit need', start(['admin'], { productsGuessed: true }), 'нужен сайт', ['site']],
    ['a guess already offered in a link is kept and added to', start(['admin'], { productsGuessed: true, offered: { builder: 1, call: 0, telegram: 0 } }), 'нужен сайт', ['admin', 'site']],
    ['«ещё» keeps a guess', start(['admin'], { productsGuessed: true }), 'и ещё сайт', ['admin', 'site']],
    ['a generic «бот» only fills an empty list', start(['site']), 'и ещё бота', ['site']],
  ];
  it.each(rows)('%s', (_name, before, said, after) => {
    expect(merge(before, { reply: '' }, said).products).toEqual(after);
    // the turn merges twice (before and after the model): the same words change nothing the second time
    expect(merge(merge(before, { reply: '' }, said), { reply: '' }, said).products).toEqual(after);
  });

  it('«не хочу сайт» sets z.no and the playground; the model\'s product only fills an empty or guessed list', () => {
    const q = merge(start(['admin', 'site']), { reply: '' }, 'не хочу сайт');
    expect(q).toMatchObject({ siteNeed: 'no', delivery: ['playground'], products: ['admin'] });
    expect(merge(start(['admin']), { reply: '', extract: { product: 'content' } }, 'расскажите подробнее').products).toEqual(['admin']);
    expect(merge(start([]), { reply: '', extract: { product: 'content' } }, 'расскажите').products).toEqual(['content']);
  });

  it('a state saved with the single `product` is read as a one-item list', () => {
    const old = { ...newQ(), product: 'admin' } as unknown as QState;
    expect(normalizeQ(old).products).toEqual(['admin']);
    expect('product' in normalizeQ(old)).toBe(false);
    expect(normalizeQ({ ...newQ(), product: 'bot', kind: 'salon' } as unknown as QState).products).toEqual(['admin']);
  });

  it('the price answer covers the listed products, three at most; one product keeps its companions; the personal agent is never named', () => {
    expect(priceProducts({ products: ['admin', 'site'] })).toEqual(['admin', 'site']);
    expect(priceProducts({ products: ['admin', 'content', 'miniapp', 'site'] })).toEqual(['admin', 'content', 'miniapp']);
    expect(priceProducts({ products: ['agent', 'site'] })).not.toContain('agent');
    expect(priceProducts({ products: ['admin'] })).toHaveLength(3);
    expect(priceProducts({})).toHaveLength(3);
    expect(needReply({ ...newQ(), products: ['admin', 'site'] }, 'ru', true)).toBe('Для этого подойдут «ИИ-администратор», «Сайт».');
  });

  it('a dialogue: administrator, then «и ещё сайт»: the link carries both, the price answer and the lead list both, «только сайт» and «не нужен сайт» change them back', async () => {
    const w = world({ turns: (_req, n) => json(n === 1 ? { reply: 'Понял, салон. Что теряется?', extract: { kind: 'salon', niche: 'салон' } } : { reply: 'Ясно, заявки теряются вечером.', ready: true, extract: { pain: 'заявки вечером' } }) });
    await w.say('У меня салон, нужен администратор для записи');
    const prop = await w.say('Вечером теряются заявки');
    expect(prop.builderLink).toMatch(/p\.adminbot(~|$)/);
    expect(prop.builderLink).not.toMatch(/site/);
    const calls = w.receptionistCalls().length;
    const more = await w.say('и ещё сайт');
    expect(more.cta).toEqual(['builder']);
    expect(w.receptionistCalls()).toHaveLength(calls); // the link is regenerated by the code
    expect(decodeBuild(new URL(more.builderLink!).searchParams.get('b'))).toMatchObject({ kind: 'salon', products: ['adminbot', 'site'] });
    expect(more.builderLink).toMatch(/p\.adminbot-site/);
    const price = await w.say('сколько стоит?');
    const head = price.reply.split('\n\n')[0]!;
    expect(head).toContain('ИИ-администратор от $');
    expect(head).toContain('Сайт от $');
    expect(head.split(';')).toHaveLength(2);
    expect(price.builderLink).toMatch(/p\.adminbot-site/);
    const only = await w.say('только сайт');
    expect(only.builderLink).toMatch(/p\.site(~|&|$)/);
    expect(only.builderLink).not.toMatch(/adminbot/);
    const back = await w.say('и ещё администратор');
    expect(back.builderLink).toMatch(/p\.adminbot-site/);
    const less = await w.say('сайт не нужен');
    expect(less.builderLink).toMatch(/p\.adminbot~l\.playground~z\.no/);
    const done = await w.say('мой телеграм @dilnoza_salon');
    expect(done).toMatchObject({ leadCreated: true });
    expect(w.leads[0]).toMatchObject({ product: 'ИИ-администратор', service: 'bots' });
  });

  it('the lead and the summary list all products', async () => {
    const w = world({ turns: (_req, n) => json(n === 1 ? { reply: 'Понял. Что теряется?', extract: { kind: 'salon', niche: 'салон' } } : { reply: 'Ясно.', ready: true, extract: { pain: 'заявки вечером' } }) });
    await w.say('У меня салон, нужен администратор и сайт');
    await w.say('Вечером теряются заявки');
    await w.say('мой телеграм @dilnoza_salon');
    const lead = w.leads[0]!;
    expect(lead).toMatchObject({ product: 'ИИ-администратор, Сайт', service: 'bots' });
    expect((lead.enrichment as { summary: string[]; productFamily: string }).summary[1]).toMatch(/Подходит: ИИ-администратор, Сайт;/);
    expect((lead.enrichment as { productFamily: string }).productFamily).toBe('admin, site');
    expect(String(lead.message)).toContain('Продукт: ИИ-администратор, Сайт');
  });
});

