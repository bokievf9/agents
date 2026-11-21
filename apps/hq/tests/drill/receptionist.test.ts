/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { afterEach, describe, expect, it } from 'vitest';
import { TOKENS, drillWorld, type DrillWorld } from './world.js';
import { useGuard } from './guard.js';

/** ИИ-менеджер заявок 2.0 through the real webhook and the real heads: the site contract of `POST /chat`, the hand-off into the Sales card, a signed-in client, the demo. */
useGuard();
let w: DrillWorld;
afterEach(async () => { await w?.close(); });

const chat = async (body: object, ip = '8.8.8.8') => {
  const r = await w.http('POST', '/chat', { sessionId: 'drill-visitor-0001', locale: 'ru', ...body }, { 'x-chat-token': TOKENS.chat, 'x-visitor-ip': ip });
  return { status: r.status, json: (await r.json()) as Record<string, any> };
};

describe('POST /chat, the site contract', () => {
  it('`text` is read like `message`; a price question comes with the builder link and the call offer, no model', async () => {
    w = await drillWorld();
    const calls = w.calls.length;
    const r = await chat({ text: 'Сколько стоит бот-администратор?' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, state: 'chat', cta: ['builder', 'call'] });
    // «администратор» is the booking need: the link carries the ИИ-администратор
    expect(r.json.builderLink).toBe('https://firtech.pro/ru/builder?b=p.adminbot');
    expect(r.json.reply).toMatch(/Оплата по этапам/);
    expect(w.calls.length).toBe(calls);
    expect((await chat({ sessionId: 'drill-visitor-0002', locale: 'en', message: 'How much does it cost?' })).json.reply).toMatch(/Payment is by stages/);
    // neither field: invalid; a persona outside the list: invalid; a malformed identity is ignored, not an error
    expect((await chat({})).status).toBe(400);
    expect((await chat({ text: 'x', persona: 'bank' })).status).toBe(400);
    expect((await chat({ text: 'Сколько стоит сайт?', clientEmail: 'nonsense' })).status).toBe(200);
  });

  it('a person asked for: the contact is collected, the lead reaches Sales with the hand-off and the summary, and the thread shows in the owner\'s chats', async () => {
    w = await drillWorld();
    const ask = await chat({ sessionId: 'drill-visitor-0003', text: 'Позовите живого менеджера' });
    expect(ask.json).toMatchObject({ state: 'contact', handoff: true });
    const done = await chat({ sessionId: 'drill-visitor-0003', text: '@handoff_user' });
    expect(done.json).toMatchObject({ state: 'done', leadCreated: true, handoff: true });
    await w.beat();
    await w.beat();
    const lead = ((await w.adm('GET', '/admin/crm/leads')).json.items as any[]).find((l) => l.contact === '@handoff_user');
    expect(lead).toBeDefined();
    expect(lead.enrichment.summary[2]).toMatch(/просил живого менеджера/);
    expect(lead.enrichment.intentScore).toBeGreaterThanOrEqual(30);
    const card = (w.db.prepare("SELECT summary FROM task_approvals WHERE kind = 'lead_reply' ORDER BY id DESC").get() as { summary: string }).summary;
    expect(card).toContain('Намерение:');
    expect(card).toContain('просил живого менеджера');
    const chats = (await w.adm('GET', '/admin/chats?status=all')).json.items as any[];
    expect(chats.some((c) => JSON.stringify(c).includes('@handoff_user'))).toBe(true);
  });

  it('a signed-in client\'s project question goes to their support thread and becomes a Support ticket, no new lead', async () => {
    w = await drillWorld({ flow: true });
    const email = 'rano.client@example.com';
    await w.http('POST', '/lead', { name: 'Rano', contact: '@rano_c', service: 'bots', budget: '$300-500', message: 'Нужен бот для записи клиентов в салон, пишут в Instagram', locale: 'ru', source: 'form', clientEmail: email, cabinetId: 'sb-rano', clientName: 'Рано' }, { 'x-lead-token': TOKENS.lead });
    await w.beat();
    const cid = ((await w.adm('GET', `/admin/clients/by-email?email=${encodeURIComponent(email)}`)).json.client.id) as number;
    const leadsBefore = (w.db.prepare('SELECT COUNT(*) n FROM li_leads').get() as { n: number }).n;
    const r = await chat({ sessionId: 'drill-visitor-0004', text: 'Когда будет готов мой проект и какой этап оплаты?', clientEmail: email, clientName: 'Рано' });
    expect(r.json.reply).toMatch(/Передал в вашу переписку с командой/);
    await w.beat();
    expect((w.db.prepare('SELECT COUNT(*) n FROM li_leads').get() as { n: number }).n).toBe(leadsBefore);
    const msgs = (await w.adm('GET', `/admin/clients/${cid}/threads/support/messages`)).json.items as any[];
    expect(msgs.some((m) => m.from === 'client' && /Когда будет готов мой проект/.test(m.text))).toBe(true);
    const tickets = (await w.adm('GET', '/admin/crm/tickets')).json.items as any[];
    expect(tickets.some((t) => /Когда будет готов мой проект/.test(t.text ?? t.question ?? ''))).toBe(true);
  });

  it('a signed-in client who asks for a call makes one lead linked to their cabinet account; asking for a person goes to the thread without a contact', async () => {
    w = await drillWorld({ flow: true });
    const email = 'kamol.chat@example.com';
    await w.http('POST', '/lead', { name: 'Kamol', contact: '@kamol_c', service: 'bots', budget: '$300-500', message: 'Нужен бот для записи клиентов в барбершоп, пишут в Instagram', locale: 'ru', source: 'form', clientEmail: email, cabinetId: 'sb-kamol', clientName: 'Камол' }, { 'x-lead-token': TOKENS.lead });
    await w.beat();
    const cid = ((await w.adm('GET', `/admin/clients/by-email?email=${encodeURIComponent(email)}`)).json.client.id) as number;
    const who = { clientEmail: email, clientName: 'Камол' };
    const person = await chat({ sessionId: 'drill-visitor-0005', text: 'Позовите менеджера', ...who });
    expect(person.json).toMatchObject({ handoff: true });
    expect(person.json.reply).toMatch(/Передал в вашу переписку/);
    const call = await chat({ sessionId: 'drill-visitor-0006', text: 'Давайте созвонимся, хочу ещё один проект', ...who });
    expect(call.json).toMatchObject({ state: 'done', leadCreated: true });
    await w.beat();
    const mine = w.db.prepare("SELECT client_id, contact FROM li_leads WHERE origin = 'web'").all() as { client_id: number; contact: string }[];
    expect(mine).toEqual([{ client_id: cid, contact: email }]);
  });

  it('the demo tab: persona answers without a stored session, a lead or a ticket, even with the model down', async () => {
    w = await drillWorld();
    w.state.down = true;
    const r = await chat({ sessionId: 'drill-demo-0001', text: 'Хочу записаться, меня зовут Анвар +992 90 111 22 33', persona: 'clinic' });
    expect(r.json).toMatchObject({ ok: true, state: 'chat', demo: true });
    expect(r.json.reply).toMatch(/Демо сейчас недоступно/);
    expect((w.db.prepare('SELECT COUNT(*) n FROM web_chat_sessions').get() as { n: number }).n).toBe(0);
    expect(w.hq.tasks({ dept: 'sales' }).filter((t) => t.meta.action === 'lead')).toEqual([]);
    expect(w.lost.recent()).toEqual([]);
  });
});
