/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { MockLlm, OffLlm, openDb, type LlmRequest } from '@fir/core';
import { Hq } from '@fir/hq';
import { describe, expect, it } from 'vitest';
import { ensureCabinetTables } from '../src/cabinet.js';
import { buildPersona, detectNiche, DEMOS, NICHES, personaInputFromLead, Playground } from '../src/playground.js';
import { NOW } from './helpers.js';

const DAY = 86_400_000;

function setup(handler?: (req: LlmRequest, n: number) => string, o: { llm?: OffLlm } = {}) {
  const db = openDb(':memory:');
  const clock = { t: NOW };
  new Hq(db, { now: () => clock.t });
  ensureCabinetTables(db);
  db.prepare("INSERT INTO cab_clients (id, email, name, created_at, updated_at) VALUES (1, 'liza@example.com', 'Лиза', 1, 1), (2, 'other@example.com', 'Другой', 1, 1)").run();
  const llm = o.llm ?? new MockLlm(handler ?? (() => JSON.stringify({ reply: 'Здравствуйте!' })));
  const handoffs: { clientId: number; agentId: number }[] = [];
  const owner: string[] = [];
  const pg = new Playground({
    db, now: () => clock.t, tz: () => 'Asia/Dushanbe', llm, secret: 'unit-secret', handoff: (clientId, agentId) => void handoffs.push({ clientId, agentId }), notifyOwner: (t) => void owner.push(t),
    uploadText: (cid, uid) => (cid === 1 && uid === 'up_text_ok_1' ? { name: 'faq.txt', text: 'Доставка по городу бесплатно от 50 долларов.' } : null),
  });
  return { db, clock, pg, handoffs, owner, llm: llm as MockLlm };
}
const make = (pg: Playground, body: Record<string, unknown> = { company: 'Салон Лиза', niche: 'салон красоты' }) => {
  const r = pg.create(1, body);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { id: (r.body.item as any).id as number, token: r.body.token as string, item: r.body.item as any };
};

describe('the persona is built from the builder answers of the lead', () => {
  it('reads Ниша, Цели, Тон, Компания and languages from the builder summary, falls back to the lead columns and the words of the request', () => {
    const input = personaInputFromLead({
      name: 'Лиза', niche: '', task: 'Нужен бот', lang: 'ru',
      estimate: 'Пакет: Бот-администратор\nНиша: салон красоты\nЦели: запись клиентов; ответы на вопросы; сбор контактов\nТон: тёплый, без канцелярита\nКомпания: Салон «Лиза»\nЯзыки: ru, en',
    });
    expect(input).toEqual({
      company: 'Салон «Лиза»', niche: 'салон красоты', goals: ['запись клиентов', 'ответы на вопросы', 'сбор контактов'], tone: 'тёплый, без канцелярита', languages: ['ru', 'en'],
    });
    const persona = buildPersona(input);
    expect(persona).toContain('Салон «Лиза»');
    expect(persona).toContain('запись клиентов; ответы на вопросы; сбор контактов');
    expect(persona).toContain('тёплый, без канцелярита');
    expect(persona).toContain('handoff_human');
    // a lead without builder answers: the lead's own columns and the niche words of its request
    expect(personaInputFromLead({ name: 'Анвар', niche: '', task: 'Хочу бота для стоматологической клиники', estimate: '', lang: 'en' })).toMatchObject({ company: 'Анвар', niche: 'клиника', languages: ['en'] });
    expect(detectNiche('кофейня на углу')).toBe('cafe');
    expect(detectNiche('что-то непонятное')).toBe('');
  });

  it('create from a lead: the persona, the project and the token shown once; only the client\'s own lead counts', () => {
    const { db, pg } = setup();
    db.exec('CREATE TABLE li_leads (id INTEGER PRIMARY KEY, name TEXT, niche TEXT, task TEXT, estimate TEXT, lang TEXT, client_id INTEGER)');
    db.prepare("INSERT INTO li_leads VALUES (7, 'Лиза', 'салон', 'бот', 'Цели: запись; контакты\nТон: тёплый', 'ru', 1), (8, 'Чужой', '', 'x', '', 'ru', 2)").run();
    const r = pg.create(1, { leadId: 7 });
    expect(r.status).toBe(200);
    const item = r.body.item as any;
    expect(item).toMatchObject({ company: 'Лиза', state: 'draft', goals: ['запись', 'контакты'], tone: 'тёплый', leadId: 7, tools: expect.arrayContaining(['faq_search', 'handoff_human']), limits: { msgsPerDay: 50 } });
    expect(item.persona).toContain('запись; контакты');
    expect(r.body.token).toMatch(/^ft_[A-Za-z0-9_-]{30,}$/);
    expect(JSON.stringify(pg.get(1, item.id).body)).not.toContain(r.body.token as string);
    expect(pg.create(1, { leadId: 8 }).status).toBe(404);
    expect(pg.create(1, { leadId: 999 }).status).toBe(404);
    expect(pg.create(99, { company: 'x' }).status).toBe(404);
    expect(pg.create(1, {}).status).toBe(400);
    expect(pg.create(1, { company: 'x', tools: ['rm_rf'] }).status).toBe(400);
  });

  it('three agents at most per client; one client cannot read or change another\'s', () => {
    const { pg } = setup();
    const a = make(pg);
    make(pg);
    make(pg);
    expect(pg.create(1, { company: 'Четвёртый' }).status).toBe(409);
    expect(pg.get(2, a.id).status).toBe(404);
    expect(pg.patch(2, a.id, { state: 'live' }).status).toBe(404);
    expect(pg.rotateToken(2, a.id).status).toBe(404);
    expect(pg.list(2).body.items).toEqual([]);
  });
});

describe('settings', () => {
  it('patch: the profile rebuilds the persona unless one is sent; limits, tools, state, channels; the Telegram token is stored encrypted and never returned', () => {
    const { db, pg } = setup();
    const a = make(pg);
    const p1 = pg.patch(1, a.id, { tone: 'строгий', goals: ['записывать'] });
    expect((p1.body.item as any).persona).toContain('строгий');
    const own = 'Ты ассистент салона. Отвечай коротко и по делу, всегда на вы.';
    expect((pg.patch(1, a.id, { tone: 'другой', persona: own }).body.item as any).persona).toBe(own);
    const p2 = pg.patch(1, a.id, { state: 'live', limits: { msgsPerDay: 5 }, tools: ['faq_search'], channels: { siteWidget: 'https://Liza.example', telegram: { botToken: '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0' } } });
    expect(p2.status, JSON.stringify(p2.body)).toBe(200);
    const item = p2.body.item as any;
    expect(item).toMatchObject({ state: 'live', limits: { msgsPerDay: 5 }, tools: ['faq_search'], channels: { web: true, telegram: { connected: true }, siteWidget: 'https://liza.example' } });
    expect(JSON.stringify(item)).not.toContain('AAHdqTcv');
    const raw = (db.prepare('SELECT channels FROM pg_agents WHERE id = ?').get(a.id) as { channels: string }).channels;
    expect(raw).not.toContain('AAHdqTcv');
    expect(pg.telegramToken(a.id)).toBe('123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0');
    expect((pg.patch(1, a.id, { channels: { telegram: null } }).body.item as any).channels.telegram).toEqual({ connected: false });
    for (const bad of [{ state: 'deleted' }, { limits: { msgsPerDay: 0 } }, { channels: { siteWidget: 'javascript:1' } }, { channels: { telegram: { botToken: 'nope' } } }, { persona: 'short' }, { unknown: 1 }]) {
      expect(pg.patch(1, a.id, bad).status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('without a secret a Telegram token is refused instead of being stored plain', () => {
    const db = openDb(':memory:');
    new Hq(db, { now: () => NOW });
    ensureCabinetTables(db);
    db.prepare("INSERT INTO cab_clients (id, email, created_at, updated_at) VALUES (1, 'a@b.co', 1, 1)").run();
    const pg = new Playground({ db, now: () => NOW, tz: () => 'UTC', llm: new OffLlm() });
    const a = pg.create(1, { company: 'X' }).body.item as any;
    expect(pg.patch(1, a.id, { channels: { telegram: { botToken: '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0' } } }).status).toBe(503);
  });

  it('knowledge: a note or a text upload of the client; a foreign upload or a missing text is refused', () => {
    const { pg } = setup();
    const a = make(pg);
    expect(pg.addKnowledge(1, a.id, { title: 'Часы', text: 'Работаем с 10 до 20.' }).status).toBe(200);
    expect(pg.addKnowledge(1, a.id, { uploadId: 'up_text_ok_1' }).body.item).toMatchObject({ title: 'faq.txt' });
    expect(pg.addKnowledge(2, a.id, { text: 'x' }).status).toBe(404);
    expect(pg.addKnowledge(1, a.id, { uploadId: 'up_not_mine_1' }).status).toBe(400);
    expect(pg.addKnowledge(1, a.id, {}).status).toBe(400);
    const list = (pg.knowledge(1, a.id).body.items as any[]);
    expect(list.map((k) => k.title)).toEqual(['Часы', 'faq.txt']);
    expect(pg.removeKnowledge(1, a.id, list[0].id).status).toBe(200);
    expect(pg.removeKnowledge(1, a.id, list[0].id).status).toBe(404);
  });
});

describe('chat: the gateway LLM with memory per conversation and the tools', () => {
  it('answers, remembers the conversation (and only that one), counts messages in the journal without any text', async () => {
    const seen: LlmRequest[] = [];
    const { pg, db } = setup((req) => (seen.push(req), JSON.stringify({ reply: `Ответ ${seen.length}` })));
    const a = make(pg);
    const one = await pg.chatAdmin(1, a.id, { conversationId: 'conv-aaaaaaaa', text: 'Привет, я Анвар' });
    expect(one.body).toMatchObject({ ok: true, reply: 'Ответ 1', conversationId: 'conv-aaaaaaaa', usedTools: [] });
    await pg.chatAdmin(1, a.id, { conversationId: 'conv-aaaaaaaa', text: 'Как меня зовут?' });
    expect(seen[1]!.messages.map((m) => m.content)).toEqual(['Привет, я Анвар', 'Ответ 1', 'Как меня зовут?']);
    await pg.chatAdmin(1, a.id, { conversationId: 'conv-bbbbbbbb', text: 'Новый разговор' });
    expect(seen[2]!.messages.map((m) => m.content)).toEqual(['Новый разговор']); // no memory across conversations
    expect(seen[0]!.system).toContain('Салон Лиза');
    expect(seen[0]!.system).toContain('Формат ответа: только JSON');
    const conv = pg.conversations(1, a.id).body.items as any[];
    expect(conv.map((c) => c.id).sort()).toEqual(['conv-aaaaaaaa', 'conv-bbbbbbbb']);
    expect(conv.find((c) => c.id === 'conv-aaaaaaaa')).toMatchObject({ messages: 4, channel: 'cabinet' });
    const journal = pg.journalOf(1, a.id).body.items as any[];
    expect(journal[0].counts).toEqual({ message: 3 });
    expect(JSON.stringify(db.prepare('SELECT * FROM pg_journal').all())).not.toMatch(/Анвар|Привет/);
    expect((await pg.chatAdmin(2, a.id, { text: 'чужой' })).status).toBe(404);
    expect((await pg.chatAdmin(1, a.id, { text: '' })).status).toBe(400);
    expect((await pg.chatAdmin(1, a.id, { text: 'x', conversationId: '../x' })).status).toBe(400);
  });

  it('tools: FAQ from the knowledge notes, booking slots (a stub), lead capture, handoff to a human', async () => {
    let step = 0;
    const script = [
      { reply: 'Ищу', tool: { name: 'faq_search', args: { q: 'сколько стоит доставка' } } },
      { reply: 'Доставка бесплатно от 50 долларов.' },
      { reply: 'Смотрю окна', tool: { name: 'booking_slots', args: {} } },
      { reply: 'Есть окна завтра.' },
      { reply: 'Записываю', tool: { name: 'capture_lead', args: { name: 'Анвар', contact: '@anvar', note: 'хочет окрашивание' } } },
      { reply: 'Контакт сохранён.' },
      { reply: 'Зову человека', tool: { name: 'handoff_human', args: { reason: 'просит живого сотрудника' } } },
    ];
    const { pg, db, handoffs, owner, clock } = setup((req) => {
      const out = JSON.stringify(script[step++]);
      if (step === 2) expect(req.messages.at(-1)!.content).toContain('Доставка по городу'); // the FAQ result reached the model
      return out;
    });
    const a = make(pg);
    pg.addKnowledge(1, a.id, { uploadId: 'up_text_ok_1' });
    const r1 = await pg.chatAdmin(1, a.id, { conversationId: 'conv-11111111', text: 'Сколько стоит доставка?' });
    expect(r1.body).toMatchObject({ reply: 'Доставка бесплатно от 50 долларов.', usedTools: ['faq_search'] });
    const r2 = await pg.chatAdmin(1, a.id, { conversationId: 'conv-11111111', text: 'Когда можно записаться?' });
    expect(r2.body).toMatchObject({ usedTools: ['booking_slots'] });
    const r3 = await pg.chatAdmin(1, a.id, { conversationId: 'conv-11111111', text: 'Я Анвар, @anvar, хочу окрашивание' });
    expect(r3.body.usedTools).toEqual(['capture_lead']);
    expect(db.prepare('SELECT name, contact, note FROM pg_leads').all()).toEqual([{ name: 'Анвар', contact: '@anvar', note: 'хочет окрашивание' }]);
    // the client reads the captured contact in his agent thread; the owner's inbox gets the fact only
    expect(db.prepare("SELECT text FROM cab_tmsgs WHERE thread = ? AND \"from\" = 'agent'").get(`agent-${a.id}`)).toMatchObject({ text: expect.stringContaining('@anvar') });
    expect(owner.join()).not.toContain('@anvar');
    const r4 = await pg.chatAdmin(1, a.id, { conversationId: 'conv-11111111', text: 'Позовите человека' });
    expect(r4.body.usedTools).toEqual(['handoff_human']);
    expect(handoffs).toEqual([{ clientId: 1, agentId: a.id }]);
    // P-21: the line is the client's (his agent thread): the reason, the visitor's words and the contact he gave in this conversation; a test chat is not mailed
    const line = db.prepare("SELECT text, notify FROM cab_tmsgs WHERE thread = ? AND \"from\" = 'agent' ORDER BY id DESC LIMIT 1").get(`agent-${a.id}`) as { text: string; notify: number };
    expect(line.text).toMatch(/^Посетитель просит человека \(просит живого сотрудника\), агент «[^»]+» передал разговор вам\. Его сообщение: «Позовите человека»\. Контакт: Анвар, @anvar\./);
    expect(line.notify).toBe(0);
    expect(pg.leadsOf(1, a.id).body.items).toHaveLength(1);
    const counts = (pg.journalOf(1, a.id).body.items as any[])[0].counts;
    expect(counts).toMatchObject({ message: 4, handoff: 1, lead_captured: 1, 'tool:faq_search': 1, 'tool:booking_slots': 1 });
    expect(clock.t).toBe(NOW);
  });

  it('booking: only a slot that was offered is booked (and it is a stub: a request, not a calendar entry)', async () => {
    let step = 0;
    const offered = new Set<string>();
    const { pg, db } = setup((req) => {
      step++;
      if (step === 1) return JSON.stringify({ reply: 'Смотрю', tool: { name: 'booking_slots', args: {} } });
      if (step === 2) {
        const slots = JSON.parse(/: (\{.*\})\. Теперь/s.exec(req.messages.at(-1)!.content)![1]!).slots as string[];
        slots.forEach((s) => offered.add(s));
        return JSON.stringify({ reply: 'Записываю', tool: { name: 'book_slot', args: { slot: '2000-01-01 10:00', name: 'А', contact: '@a' } } });
      }
      if (step === 3) return JSON.stringify({ reply: 'Записываю на другое', tool: { name: 'book_slot', args: { slot: [...offered][1], name: 'Анвар', contact: '@anvar' } } });
      return JSON.stringify({ reply: 'Готово.' });
    });
    const a = make(pg);
    const r = await pg.chatAdmin(1, a.id, { conversationId: 'conv-22222222', text: 'Запишите меня' });
    expect(r.body.reply).toBe('Готово.');
    const rows = db.prepare('SELECT slot, name FROM pg_bookings').all() as { slot: string; name: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('Анвар');
    expect(offered.has(rows[0]!.slot)).toBe(true);
    expect(offered.size).toBe(12); // three days, four slots a day
  });

  it('a tool outside the allowlist is not run; a model that answers garbage gets a FAQ answer or a polite handoff, never an invented answer', async () => {
    const { pg, db, handoffs } = setup(() => 'not json at all');
    const a = make(pg, { company: 'Салон', niche: 'салон', tools: ['faq_search', 'handoff_human'] });
    pg.addKnowledge(1, a.id, { title: 'Часы работы', text: 'Работаем с 10 до 20 без выходных.' });
    const known = await pg.chatAdmin(1, a.id, { conversationId: 'conv-33333333', text: 'Какие у вас часы работы?' });
    expect(known.body).toMatchObject({ reply: 'Работаем с 10 до 20 без выходных.', usedTools: ['faq_search'] });
    const unknown = await pg.chatAdmin(1, a.id, { conversationId: 'conv-33333333', text: 'Сколько стоит операция на сердце?' });
    expect(unknown.body.reply).toMatch(/Передал его менеджеру/);
    expect(unknown.body.usedTools).toEqual(['handoff_human']);
    expect(handoffs).toHaveLength(1);
    expect((pg.journalOf(1, a.id).body.items as any[])[0].counts.llm_fail).toBe(2);
    // a tool the agent is not allowed to use is told to the model, not run
    let n = 0;
    const s2 = setup(() => JSON.stringify(n++ === 0 ? { reply: 'x', tool: { name: 'capture_lead', args: { contact: '@zzz' } } } : { reply: 'Без инструмента.' }));
    const b = s2.pg.create(1, { company: 'С', niche: 'с', tools: ['faq_search'] }).body.item as any;
    expect((await s2.pg.chatAdmin(1, b.id, { text: 'контакт @zzz' })).body).toMatchObject({ reply: 'Без инструмента.', usedTools: [] });
    expect(s2.db.prepare('SELECT COUNT(*) n FROM pg_leads').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) n FROM pg_leads').get()).toEqual({ n: 0 });
  });

  it('without a model (LLM off) the FAQ still answers and nothing is invented', async () => {
    const { pg } = setup(undefined, { llm: new OffLlm() });
    const a = make(pg);
    pg.addKnowledge(1, a.id, { title: 'Доставка', text: 'Доставляем за два дня.' });
    expect((await pg.chatAdmin(1, a.id, { text: 'Сколько дней доставка?' })).body.reply).toBe('Доставляем за два дня.');
    expect((await pg.chatAdmin(1, a.id, { text: 'Расскажите про гарантию' })).body.reply).toMatch(/менеджеру/);
  });

  it('limits per day: the limit message is refused with 429, the next day it works again; a draft has the smaller default', async () => {
    const { pg, clock } = setup();
    const a = make(pg);
    pg.patch(1, a.id, { limits: { msgsPerDay: 3 } });
    for (let i = 0; i < 3; i++) expect((await pg.chatAdmin(1, a.id, { text: `вопрос ${i}` })).status).toBe(200);
    const over = await pg.chatAdmin(1, a.id, { text: 'ещё' });
    expect(over.status).toBe(429);
    expect(over.body.error).toBe('limit_reached');
    expect(((pg.journalOf(1, a.id).body.items as any[])[0]).counts).toMatchObject({ message: 3, limit_hit: 1 });
    clock.t += DAY;
    expect((await pg.chatAdmin(1, a.id, { text: 'завтра' })).status).toBe(200);
  });
});

describe('the public chat of a live agent (the site widget)', () => {
  it('the per-agent token, a live agent and the origin the client set; a rotated token kills the old one', async () => {
    const { pg } = setup((req) => JSON.stringify({ reply: `Ответ про ${req.system.includes('Салон Лиза') ? 'салон' : '?'}` }));
    const a = make(pg);
    const ask = (token: string, origin = '', body: unknown = { text: 'Здравствуйте' }) => pg.chatPublic((a.item as any).publicId, { token, origin, body });
    expect((await ask(a.token)).status).toBe(403); // draft
    expect((await ask(a.token)).body.error).toBe('not_live');
    pg.patch(1, a.id, { state: 'live', channels: { siteWidget: 'https://liza.example' } });
    const ok = await ask(a.token, 'https://liza.example');
    expect(ok).toMatchObject({ status: 200, allowOrigin: 'https://liza.example', body: { ok: true, reply: 'Ответ про салон', usedTools: [] } });
    expect(String(ok.body.conversationId)).toMatch(/^w-/);
    expect((await ask(a.token, 'https://evil.example')).body.error).toBe('origin');
    expect((await ask('ft_wrong')).status).toBe(401);
    expect((await pg.chatPublic('ag_nonexistent', { token: a.token, origin: '', body: { text: 'x' } })).status).toBe(401);
    expect((await ask(a.token, 'https://liza.example', { text: '' })).status).toBe(400);
    // the conversation goes on with its id, another agent's conversation id does not leak into this one
    const again = await ask(a.token, 'https://liza.example', { text: 'ещё', conversationId: ok.body.conversationId });
    expect(again.body.conversationId).toBe(ok.body.conversationId);
    const rotated = pg.rotateToken(1, a.id).body.token as string;
    expect((await ask(a.token, 'https://liza.example')).status).toBe(401);
    expect((await ask(rotated, 'https://liza.example')).status).toBe(200);
    const conv = pg.conversations(1, a.id).body.items as any[];
    expect(conv.every((c) => c.channel === 'widget')).toBe(true);
  });
});

describe('the DEMO persona of the builder preview', () => {
  it('one per niche (салон, клиника, магазин, кафе, сервис, курсы); no token, nothing stored, no memory across sessions', async () => {
    const seen: LlmRequest[] = [];
    const { pg, db } = setup((req) => (seen.push(req), JSON.stringify({ reply: 'Демо-ответ' })));
    expect([...NICHES]).toEqual(['salon', 'clinic', 'shop', 'cafe', 'service', 'courses']);
    for (const niche of NICHES) {
      expect(DEMOS[niche].faq.length).toBeGreaterThanOrEqual(3);
      const r = await pg.handlePublic(`demo-${niche}`, { token: '', origin: '', body: { sessionId: `session-${niche}-1`, text: 'Здравствуйте' } });
      expect(r, niche).toMatchObject({ status: 200, body: { ok: true, reply: 'Демо-ответ', conversationId: `session-${niche}-1` } });
      expect(seen.at(-1)!.system).toContain(DEMOS[niche].company);
      expect(seen.at(-1)!.system).toContain('ничего не записывается на самом деле');
    }
    // memory inside one session only
    await pg.handlePublic('demo-salon', { token: '', origin: '', body: { sessionId: 'session-salon-1', text: 'Второе сообщение' } });
    expect(seen.at(-1)!.messages.map((m) => m.content)).toEqual(['Здравствуйте', 'Демо-ответ', 'Второе сообщение']);
    await pg.handlePublic('demo-salon', { token: '', origin: '', body: { sessionId: 'session-salon-2', text: 'Новая сессия' } });
    expect(seen.at(-1)!.messages.map((m) => m.content)).toEqual(['Новая сессия']);
    // nothing in the database but one counter of the day
    for (const t of ['pg_conversations', 'pg_messages', 'pg_leads', 'pg_bookings', 'pg_journal']) expect(db.prepare(`SELECT COUNT(*) n FROM ${t}`).get(), t).toEqual({ n: 0 });
    expect((db.prepare("SELECT key, value FROM settings WHERE key LIKE 'pg.demo.%'").get() as any).value).toBe('8');
    expect((await pg.handlePublic('demo-unknown', { token: '', origin: '', body: { sessionId: 'session-x-1', text: 'x' } })).status).toBe(404);
    expect((await pg.handlePublic('demo-salon', { token: '', origin: '', body: { sessionId: 'bad id', text: 'x' } })).status).toBe(400);
  });

  it('the demo\'s tools work on its own notes; capture and booking store nothing; a session is capped', async () => {
    let step = 0;
    const { pg, db } = setup(() => JSON.stringify(step++ === 0 ? { reply: 'Ищу', tool: { name: 'faq_search', args: { q: 'график работы салона' } } } : { reply: 'Ежедневно с 10 до 20.' }));
    const r = await pg.chatDemo('salon', { sessionId: 'session-abc-123', text: 'Какой у вас график?' });
    expect(r.body).toMatchObject({ reply: 'Ежедневно с 10 до 20.', usedTools: ['faq_search'] });
    let s = 0;
    const cap = setup(() => JSON.stringify(s++ === 0 ? { reply: 'Сохраняю', tool: { name: 'capture_lead', args: { contact: '@someone' } } } : { reply: 'Сохранил.' }));
    expect((await cap.pg.chatDemo('cafe', { sessionId: 'session-cap-1234', text: 'мой контакт @someone' })).body.usedTools).toEqual(['capture_lead']);
    expect(cap.db.prepare('SELECT COUNT(*) n FROM pg_leads').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) n FROM pg_messages').get()).toEqual({ n: 0 });
    const capped = setup();
    let last = 200;
    for (let i = 0; i < 12; i++) last = (await capped.pg.chatDemo('shop', { sessionId: 'session-cap-5678', text: `q${i}` })).status;
    expect(last).toBe(200);
    expect((await capped.pg.chatDemo('shop', { sessionId: 'session-cap-5678', text: 'q13' })).status).toBe(429);
  });
});
