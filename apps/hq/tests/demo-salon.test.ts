import { openDb, MockLlm, type Button } from '@fir/core';
import { describe, expect, it } from 'vitest';
import { ClientBlockedError } from '../src/client/channel.js';
import { DEMO_LINK, DEMO_TTL_MS, demoSlots, REMINDER_DELAY_MS } from '../src/client/demo.js';
import { ClientEngine, type ClientSinks, type ClientTransport, type From } from '../src/client/engine.js';

class MemoryTransport implements ClientTransport {
  private id = 1000;
  readonly sent: { chatId: number; html: string; buttons?: Button[][]; id: number }[] = [];
  readonly edits: { chatId: number; messageId: number; html: string; buttons?: Button[][] }[] = [];
  send(chatId: number, html: string, buttons?: Button[][]): Promise<number> {
    if (chatId === 666) return Promise.reject(new ClientBlockedError(chatId));
    const id = ++this.id;
    this.sent.push({ chatId, html, id, ...(buttons ? { buttons } : {}) });
    return Promise.resolve(id);
  }
  edit(chatId: number, messageId: number, html: string, buttons?: Button[][]): Promise<void> {
    this.edits.push({ chatId, messageId, html, ...(buttons ? { buttons } : {}) });
    return Promise.resolve();
  }
  clearButtons(): Promise<void> {
    return Promise.resolve();
  }
  typing(): Promise<void> {
    return Promise.resolve();
  }
}

const CHAT = 777_001;
const ME: From = { chatId: CHAT, username: 'dilnoza', firstName: 'Dilnoza', langCode: 'ru' };
// 2026-11-18 07:00 UTC = 12:00 Tashkent: there are slots left today
const NOW = Date.UTC(2026, 10, 18, 7, 0);
const OWNER = 100;

function world(lang: 'ru' | 'en' = 'ru', audit?: ClientSinks['createAudit']) {
  const clock = { t: NOW };
  const db = openDb(':memory:');
  const transport = new MemoryTransport();
  const leads: Record<string, unknown>[] = [];
  const sinks: ClientSinks = {
    createLead: (lead) => (leads.push(lead), leads.length),
    createTicket: () => Promise.resolve(1),
    findClient: () => null,
    leadSlots: () => null,
    ...(audit ? { createAudit: audit } : {}),
  };
  const engine = new ClientEngine({
    db, now: () => clock.t, tz: () => 'Asia/Tashkent', transport, llm: new MockLlm(() => 'нет'), ownerId: OWNER, instructions: 'x', sinks,
  });
  const from: From = { ...ME, langCode: lang };
  /** The live demo message: the last one sent with buttons (the demo edits it in place). */
  const live = () => [...transport.sent].reverse().find((m) => m.chatId === CHAT && m.buttons)!;
  const lastHtml = () => transport.edits.filter((e) => e.chatId === CHAT).at(-1)?.html ?? live().html;
  const lastButtons = () => transport.edits.filter((e) => e.chatId === CHAT).at(-1)?.buttons ?? live().buttons!;
  const press = (data: string) => engine.onButton(from, data, live().id);
  /** Reminders still waiting in the database. */
  const reminders = () => db.prepare('SELECT chat_id, seq, due_at FROM cb_demo_reminders ORDER BY seq').all() as { chat_id: number; seq: number; due_at: number }[];
  return { clock, db, transport, reminders, leads, engine, from, live, lastHtml, lastButtons, press };
}

const texts = (b: Button[][]) => b.flat().map((x) => x.text);

describe('demo salon: the reminder survives a restart', () => {
  it('a booking made before a deploy still gets its reminder from a new process, once', async () => {
    const w = world();
    await w.engine.onCommand(w.from, 'start', 'demo_salon');
    await w.press('dm:s:0');
    await w.press('dm:m:0');
    await w.press('dm:d:1');
    await w.press(`dm:t:${demoSlots(0, 1, NOW, 'Asia/Tashkent')[0]!.replace(':', '')}`);
    await w.press('dm:ok');
    // the process dies here; a new one starts on the same database 90 s later (the 30 s ticker had no chance to run)
    w.clock.t += 90_000;
    const transport = new MemoryTransport();
    const restarted = new ClientEngine({ db: w.db, now: () => w.clock.t, tz: () => 'Asia/Tashkent', transport, llm: new MockLlm(() => 'нет'), ownerId: OWNER, instructions: 'x' });
    expect(await restarted.demo.tick()).toBe(1);
    expect(transport.sent.at(-1)!.html).toContain('Так клиент получит напоминание за день');
    expect(await restarted.demo.tick()).toBe(0);
    expect(w.reminders()).toHaveLength(0);
  });
});

describe('demo salon: the state machine', () => {
  it('walks service -> master -> day -> time -> confirm -> reminder -> review -> intake with source demo_salon', async () => {
    const w = world();
    await w.engine.onCommand(w.from, 'demo', '');
    const first = w.live();
    expect(first.html).toContain('Салон Лайм');
    expect(first.html).toContain('Демо, записи не настоящие');
    expect(texts(first.buttons!)).toEqual(['Стрижка', 'Окрашивание', 'Маникюр']);
    expect(w.engine.demo.get(CHAT)).toMatchObject({ step: 'service' });

    await w.press('dm:s:1');
    expect(w.engine.demo.get(CHAT)).toMatchObject({ step: 'master', picks: { service: 1 } });
    expect(texts(w.lastButtons())).toContain('👩 Алина');
    expect(w.lastHtml()).toContain('Демо, записи не настоящие');

    await w.press('dm:m:0');
    expect(texts(w.lastButtons()).filter((t) => /^(Сегодня|Завтра|Послезавтра)/.test(t))).toHaveLength(3);
    await w.press('dm:d:1');
    const slots = demoSlots(0, 1, NOW, 'Asia/Tashkent');
    expect(slots.length).toBeGreaterThan(2);
    expect(texts(w.lastButtons())).toEqual(expect.arrayContaining(slots));
    const slot = slots[0]!;
    await w.press(`dm:t:${slot.replace(':', '')}`);
    expect(w.engine.demo.get(CHAT)).toMatchObject({ step: 'confirm', picks: { time: slot } });
    expect(w.lastHtml()).toContain('Окрашивание');
    expect(w.lastHtml()).toContain('Алина');

    // nothing leaves the sandbox yet
    await w.press('dm:ok');
    expect(w.engine.demo.get(CHAT)).toMatchObject({ step: 'booked' });
    expect(w.lastHtml()).toContain('Вы записаны');
    expect(texts(w.lastButtons())).toEqual(expect.arrayContaining(['Перенести', 'Отменить', 'Оставить отзыв']));
    expect(w.reminders()).toHaveLength(1);
    expect(w.reminders()[0]!.due_at).toBe(NOW + REMINDER_DELAY_MS);
    expect(w.leads).toHaveLength(0);

    // not yet due; after 60 seconds the ticker sends it, exactly once for this booking
    const before = w.transport.sent.length;
    expect(await w.engine.demo.tick()).toBe(0);
    w.clock.t += REMINDER_DELAY_MS;
    expect(await w.engine.demo.tick()).toBe(1);
    expect(await w.engine.demo.tick()).toBe(0);
    expect(w.transport.sent).toHaveLength(before + 1);
    expect(w.transport.sent.at(-1)!.html).toContain('Так клиент получит напоминание за день');
    expect(w.transport.sent.at(-1)!.html).toContain('Демо, записи не настоящие');

    // review: stars, then the thank-you
    await w.press('dm:rv');
    expect(texts(w.lastButtons())).toEqual(['1 ⭐', '2 ⭐', '3 ⭐', '4 ⭐', '5 ⭐']);
    await w.press('dm:r:5');
    expect(w.lastHtml()).toContain('Спасибо за оценку ⭐⭐⭐⭐⭐');
    expect(w.engine.demo.get(CHAT)).toMatchObject({ step: 'reviewed', picks: { rating: 5 } });
    expect(w.leads).toHaveLength(0);

    // «Хочу такого бота себе»: the normal intake, product chosen, source demo_salon
    await w.press('dm:want');
    expect(w.engine.demo.get(CHAT)).toBeUndefined();
    expect(w.lastHtml()).toContain('2 из 4');
    const card = w.engine.store.get(CHAT)!.card!;
    await w.engine.onButton(w.from, 'd:urgent', card);
    await w.engine.onButton(w.from, 'b:mid', card);
    await w.engine.onButton(w.from, 'h:none', card);
    expect(w.leads).toHaveLength(1);
    expect(w.leads[0]).toMatchObject({ source: 'demo_salon', chatId: CHAT, product: 'Бот-администратор для услуг', service: 'bots' });
    expect(String(w.leads[0]!.message)).toContain('Салон Лайм');
  });

  it('reschedule returns to the day, cancel ends the booking and the old reminder stays silent', async () => {
    const w = world();
    await w.engine.onCommand(w.from, 'start', 'demo_salon');
    await w.press('dm:s:0');
    await w.press('dm:m:1');
    await w.press('dm:d:2');
    await w.press(`dm:t:${demoSlots(1, 2, NOW, 'Asia/Tashkent')[0]!.replace(':', '')}`);
    await w.press('dm:ok');
    await w.press('dm:rs');
    expect(w.engine.demo.get(CHAT)).toMatchObject({ step: 'day' });
    const sent = w.transport.sent.length;
    w.clock.t += REMINDER_DELAY_MS;
    await w.engine.demo.tick();
    expect(w.transport.sent).toHaveLength(sent); // the first booking is gone, no reminder
    await w.press('dm:d:1');
    await w.press(`dm:t:${demoSlots(1, 1, NOW, 'Asia/Tashkent')[0]!.replace(':', '')}`);
    await w.press('dm:ok');
    expect(w.reminders()).toHaveLength(1);
    await w.press('dm:cx');
    expect(w.engine.demo.get(CHAT)).toMatchObject({ step: 'cancelled' });
    expect(w.lastHtml()).toContain('Запись отменена');
    expect(w.leads).toHaveLength(0);
  });

  it('out-of-order and stale buttons do nothing; a slot that is not offered is refused', async () => {
    const w = world();
    await w.engine.onCommand(w.from, 'demo', '');
    expect(await w.press('dm:ok')).toBe('Уже неактуально');
    expect(await w.press('dm:t:1000')).toBe('Уже неактуально');
    await w.press('dm:s:0');
    await w.press('dm:m:0');
    await w.press('dm:d:1');
    const taken = ['10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00'].find((s) => !demoSlots(0, 1, NOW, 'Asia/Tashkent').includes(s))!;
    expect(await w.press(`dm:t:${taken.replace(':', '')}`)).toBe('Уже неактуально');
    expect(w.engine.demo.get(CHAT)).toMatchObject({ step: 'time' });
  });

  it('/start wipes the demo, and a demo older than 24 h is gone', async () => {
    const w = world();
    await w.engine.onCommand(w.from, 'demo', '');
    await w.press('dm:s:0');
    await w.engine.onCommand(w.from, 'start', '');
    expect(w.engine.demo.get(CHAT)).toBeUndefined();
    await w.engine.onCommand(w.from, 'demo', '');
    expect(w.engine.demo.get(CHAT)).toBeDefined();
    w.clock.t += DEMO_TTL_MS + 1;
    expect(w.engine.demo.get(CHAT)).toBeUndefined();
    expect(await w.press('dm:s:0')).toBe('Уже неактуально');
  });

  it('the menu button opens the demo; the deep link is documented in the bot', async () => {
    const w = world();
    await w.engine.onCommand(w.from, 'start', '');
    const welcome = w.live();
    expect(texts(welcome.buttons!)).toContain('🧪 Попробовать демо');
    await w.engine.onButton(w.from, 'm:demo', welcome.id);
    expect(w.engine.demo.get(CHAT)).toMatchObject({ step: 'service' });
    expect(DEMO_LINK).toBe('https://t.me/firtech_bot?start=demo_salon');
  });

  it('English: labels, masters and the disclaimer', async () => {
    const w = world('en');
    await w.engine.onCommand(w.from, 'demo', '');
    expect(w.live().html).toContain('Lime Salon');
    expect(w.live().html).toContain('bookings are not real');
    expect(texts(w.live().buttons!)).toEqual(['Haircut', 'Colouring', 'Manicure']);
    await w.press('dm:s:2');
    expect(texts(w.lastButtons())).toContain('👩 Madina');
  });
});

describe('/audit in the client bot', () => {
  it('validates the URL, passes the chat username as contact and answers per outcome; never a lead', async () => {
    const calls: Record<string, unknown>[] = [];
    let outcome: 'ok' | 'duplicate' | 'rate_limited' = 'ok';
    const w = world('ru', (a) => (calls.push(a), Promise.resolve(outcome)));
    await w.engine.onText(w.from, '/audit');
    expect(w.transport.sent.at(-1)!.html).toContain('/audit example.com');
    await w.engine.onText(w.from, '/audit http://127.0.0.1/admin');
    expect(calls).toHaveLength(0);
    await w.engine.onText(w.from, '/audit lime.example');
    expect(calls).toEqual([{ url: 'https://lime.example', contact: '@dilnoza', locale: 'ru', chatId: CHAT }]);
    expect(w.transport.sent.at(-1)!.html).toContain('в течение рабочего дня');
    outcome = 'duplicate';
    await w.engine.onText(w.from, '/audit lime.example');
    expect(w.transport.sent.at(-1)!.html).toContain('уже в работе');
    outcome = 'rate_limited';
    await w.engine.onText(w.from, '/audit lime.example');
    expect(w.transport.sent.at(-1)!.html).toContain('много заявок');
    expect(w.leads).toHaveLength(0);
  });

  it('a chat without a username uses tg:<id>; without the sink the command says it is unavailable', async () => {
    const calls: Record<string, unknown>[] = [];
    const w = world('en', (a) => (calls.push(a), Promise.resolve('ok' as const)));
    await w.engine.onText({ chatId: 5, firstName: 'No', langCode: 'en' }, '/audit https://lime.example/page');
    expect(calls[0]).toMatchObject({ contact: 'tg:5', locale: 'en', chatId: 5 });
    const off = world('en');
    await off.engine.onText(off.from, '/audit lime.example');
    expect(off.transport.sent.at(-1)!.html).toContain('unavailable');
  });
});
