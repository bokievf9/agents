import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApprovalQueue, MemoryMessenger, MockLlm, OffLlm, openDb, type Button, type LlmClient, type LlmRequest } from '@fir/core';
import { Hq } from '@fir/hq';
import { csStoreFor } from '@fir/worker-customer-support';
import { FinanceWorker } from '@fir/worker-finance';
import { MonitoringWorker } from '@fir/worker-monitoring';
import { ProspectorWorker } from '@fir/worker-prospector';
import { describe, expect, it } from 'vitest';
import { ClientBot } from '../src/client/bot.js';
import { ClientBlockedError } from '../src/client/channel.js';
import { ClientEngine, type ClientTransport, type From } from '../src/client/engine.js';
import { inWindow, linksOnly, RateLimiter, sanitizeAnswer } from '../src/client/sanitize.js';
import { catalogueText, CLASSIC_IDS, nicheHint, PRODUCT_IDS, PRODUCTS } from '../src/client/products.js';
import { systemPrompt } from '../src/client/prompt.js';
import { clientSinks } from '../src/client/sinks.js';
import { Director } from '../src/director.js';
import { SalesHead, seedSales } from '../src/heads/sales.js';
import { SupportHead, seedSupport } from '../src/heads/support.js';
import { seedOrg } from '../src/org.js';
import { Reporter } from '../src/reporter.js';
import { webLeadSchema } from '../src/webhook.js';
import { instructionsDir, NOW, OWNER, routedLlm } from './sales-helpers.js';

/** Telegram in memory: message ids, edits, cleared keyboards, typing; a chat in `blocked` answers 403. */
class MemoryTransport implements ClientTransport {
  private id = 1000;
  readonly sent: { chatId: number; html: string; buttons?: Button[][]; id: number; silent: boolean }[] = [];
  readonly edits: { chatId: number; messageId: number; html: string; buttons?: Button[][] }[] = [];
  readonly cleared: number[] = [];
  readonly blocked = new Set<number>();
  typings = 0;

  send(chatId: number, html: string, buttons?: Button[][], opts?: { silent?: boolean }): Promise<number> {
    if (this.blocked.has(chatId)) return Promise.reject(new ClientBlockedError(chatId));
    const id = ++this.id;
    this.sent.push({ chatId, html, id, silent: Boolean(opts?.silent), ...(buttons ? { buttons } : {}) });
    return Promise.resolve(id);
  }

  edit(chatId: number, messageId: number, html: string, buttons?: Button[][]): Promise<void> {
    this.edits.push({ chatId, messageId, html, ...(buttons ? { buttons } : {}) });
    return Promise.resolve();
  }

  clearButtons(_chatId: number, messageId: number): Promise<void> {
    this.cleared.push(messageId);
    return Promise.resolve();
  }

  typing(): Promise<void> {
    this.typings++;
    return Promise.resolve();
  }

  to(chatId: number) {
    return this.sent.filter((m) => m.chatId === chatId);
  }

  last(chatId: number) {
    return this.to(chatId).at(-1);
  }
}

const CLIENT = 555_001;
const ME: From = { chatId: CLIENT, username: 'dilnoza_salon', firstName: 'Dilnoza', langCode: 'ru' };
const RULES = 'Правила этого ответа';
// 23:30 Tashkent (18:30 UTC): inside the default quiet hours 22:00-08:00
const NIGHT = Date.UTC(2026, 10, 18, 18, 30);

interface Opts {
  replyLevel?: 0 | 1;
  /** The client bot's LLM answer; default a plain on-topic sentence. */
  answer?: (req: LlmRequest) => string;
  llmOff?: boolean;
  perHour?: number;
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
  const transport = new MemoryTransport();
  const engine = new ClientEngine({
    db, now: () => clock.t, tz: () => hq.tz, transport, llm, ownerId: OWNER, instructions: readFileSync(join(instructionsDir, 'client-bot.md'), 'utf8'),
    perHour: o.perHour ?? 20, dailyCap: o.dailyCap ?? 300,
  });
  const sales = new SalesHead({ hq, llm, queue, messenger, ownerId: OWNER, reporter, prospector: new ProspectorWorker(), replyLevel: o.replyLevel ?? 1, client: engine });
  const monitor = new MonitoringWorker({
    urls: [], omnirouteUrl: 'http://omniroute:20128/health', dataDir: '/d', docker: false, dockerSocket: '/s', diskMaxPct: 85, certMinDays: 14, timeoutMs: 1000,
  });
  const support = new SupportHead({ hq, llm, reporter, monitor, finance: new FinanceWorker(), messenger, ownerId: OWNER, client: engine });
  engine.connect(clientSinks({ hq, sales, support, invoicePrefix: 'FT' }));
  const decide = async (action: 'approve' | 'edit' | 'reject', id: number) => {
    await queue.handle(action, id, OWNER);
    director.afterDecision();
  };
  const leadTasks = () => hq.tasks({ dept: 'sales' }).filter((t) => t.meta.action === 'lead');
  const llmCalls = () => (llm instanceof MockLlm ? llm.calls.filter((c) => c.system.includes(RULES)).length : 0);
  /** The live card: the welcome or the intake message whose buttons are current. */
  const card = () => engine.store.get(CLIENT)!.card!;
  /** The 3-step intake by buttons, edited in place. */
  const intake = async (need = 'bot', deadline = 'urgent', budget = 'mid') => {
    await engine.onCommand(ME, 'start', '');
    await engine.onButton(ME, 'm:discuss', card());
    await engine.onButton(ME, `n:${need}`, card());
    await engine.onButton(ME, `d:${deadline}`, card());
    await engine.onButton(ME, `b:${budget}`, card());
  };
  return { clock, db, messenger, hq, queue, llm, director, transport, engine, sales, support, decide, leadTasks, llmCalls, card, intake };
}

const buttonTexts = (b?: Button[][]) => (b ?? []).flat().map((x) => x.text);

describe('welcome and language', () => {
  it('/start: a short HTML welcome with the menu buttons, one emoji each; English switches in place and is remembered', async () => {
    const w = world();
    await w.engine.onCommand(ME, 'start', '');
    const welcome = w.transport.last(CLIENT)!;
    expect(welcome.html).toContain('<b>Fir Tech</b>');
    expect(welcome.html).toContain('Dilnoza');
    expect(welcome.html).toMatch(/Dono/);
    expect(welcome.html).toMatch(/Polly/);
    expect(welcome.html).not.toContain('!');
    expect(welcome.html.length).toBeLessThan(700);
    expect(welcome.html).toContain('Строим бота-администратора для записи, ИИ-приёмщика заявок, автоматизацию, Mini Apps, личных агентов и внедряем ИИ в компании');
    expect(buttonTexts(welcome.buttons)).toEqual(['💬 Обсудить проект', '🧩 Продукты', '🧾 Я уже клиент', '👤 Позвать человека', '🇬🇧 English']);
    for (const t of buttonTexts(welcome.buttons)) expect((t.match(/\p{Extended_Pictographic}/gu) ?? []).length).toBeLessThanOrEqual(1);

    await w.engine.onButton(ME, 'm:lang', welcome.id);
    const edited = w.transport.edits.at(-1)!;
    expect(edited.messageId).toBe(welcome.id);
    expect(edited.html).toContain('We build a booking assistant bot');
    expect(buttonTexts(edited.buttons)).toContain('🇷🇺 Русский');
    expect(w.engine.store.get(CLIENT)!.lang).toBe('en');
    await w.engine.onCommand(ME, 'start', '');
    expect(w.transport.last(CLIENT)!.html).toContain('How can we help?');
    expect(w.transport.cleared).toContain(welcome.id); // the old keyboard went away
  });

  it('an English Telegram client starts in English; /lang toggles back', async () => {
    const w = world();
    await w.engine.onCommand({ ...ME, langCode: 'en-GB' }, 'start', '');
    expect(w.transport.last(CLIENT)!.html).toContain('Hello, Dilnoza');
    await w.engine.onCommand(ME, 'lang', '');
    expect(w.transport.last(CLIENT)!.html).toContain('Здравствуйте');
  });

  it('a new person who just writes gets the welcome first; a bare greeting gets only the welcome', async () => {
    const w = world();
    await w.engine.onText(ME, 'Здравствуйте!');
    expect(w.transport.to(CLIENT)).toHaveLength(1);
    expect(w.transport.last(CLIENT)!.html).toContain('Чем помочь?');
    expect(w.llmCalls()).toBe(0);
    const other: From = { chatId: CLIENT + 1, firstName: 'Ann', langCode: 'ru' };
    await w.engine.onText(other, 'Вы делаете ботов для салонов?');
    const msgs = w.transport.to(CLIENT + 1);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.html).toContain('Чем помочь?');
    expect(msgs[1]!.html).toContain('делаем Telegram-ботов');
  });

  it('a photo or voice gets the «text only» answer; /help lists the commands', async () => {
    const w = world();
    await w.engine.onMedia(ME, 'голосовое');
    expect(w.transport.last(CLIENT)!.html).toContain('только текст');
    await w.engine.onCommand(ME, 'help', '');
    expect(w.transport.last(CLIENT)!.html).toContain('/human');
  });
});

describe('the 3-step intake', () => {
  it('buttons edit one card in place and end with «Готово»; exactly one lead task, source telegram, with the chat id', async () => {
    const w = world();
    await w.intake();
    // one welcome message, everything after it was edited in place
    expect(w.transport.to(CLIENT)).toHaveLength(1);
    const steps = w.transport.edits.map((e) => e.html);
    expect(steps[0]).toContain('1 из 3');
    expect(steps[1]).toContain('2 из 3');
    expect(steps[2]).toContain('3 из 3');
    expect(buttonTexts(w.transport.edits[2]!.buttons)).toEqual(['до $300', '$300–1000', '$1000+', 'Пока не знаю']);
    const done = w.transport.edits.at(-1)!;
    expect(done.html).toContain('Готово');
    expect(done.html).toContain('Telegram-бот');
    expect(done.html).toContain('в течение рабочего дня');
    expect(done.buttons).toBeUndefined(); // buttons disappear after use
    const tasks = w.leadTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.title).toBe('Лид из Telegram (bots)');
    expect(tasks[0]!.meta.lead).toMatchObject({ source: 'telegram', chatId: CLIENT, username: 'dilnoza_salon', contact: '@dilnoza_salon', budget: '$300–1000', locale: 'ru' });
    // per chat: a masked summary only, the draft is cleared
    const chat = w.engine.store.get(CLIENT)!;
    expect(chat.draft).toEqual({});
    expect(chat.summary).toContain('проект: Telegram-бот, срочно');
    // a second press on the old card is stale and creates nothing
    expect(await w.engine.onButton(ME, 'b:mid', done.messageId)).toBe('Уже неактуально');
    expect(w.leadTasks()).toHaveLength(1);
    // the owner heard about it in the client bot
    expect(w.transport.last(OWNER)!.html).toContain('Заявка в клиентском боте');
  });

  it('free text answers are accepted at every step: new cards, the old keyboard disappears', async () => {
    const w = world();
    await w.engine.onCommand(ME, 'start', '');
    await w.engine.onButton(ME, 'm:discuss', w.card());
    await w.engine.onButton(ME, 'n:other', w.card());
    expect(w.transport.edits.at(-1)!.html).toContain('Опишите задачу');
    const first = w.card();
    await w.engine.onText(ME, 'Салон красоты, нужна онлайн-запись и напоминания');
    expect(w.transport.cleared).toContain(first);
    expect(w.transport.last(CLIENT)!.html).toContain('2 из 3');
    await w.engine.onText(ME, 'к декабрю');
    await w.engine.onText(ME, 'пока не знаю');
    expect(w.transport.last(CLIENT)!.html).toContain('Готово');
    const lead = w.leadTasks()[0]!.meta.lead as Record<string, unknown>;
    expect(lead.message).toContain('Салон красоты');
    expect(lead.service).toBe('other');
    expect(w.engine.store.get(CLIENT)!.summary).not.toContain('Салон'); // the summary is masked
  });
});

describe('replies back to the client', () => {
  it('level 1: the first reply goes into the chat by itself, not to the owner', async () => {
    const w = world();
    await w.intake();
    await w.sales.onHeartbeat();
    const reply = w.transport.last(CLIENT)!;
    expect(reply.html).toContain('Спасибо за заявку');
    expect(reply.html).toContain('1)');
    expect(w.messenger.sent.some((m) => m.text.includes('ответ утверждён'))).toBe(false);
    expect(w.queue.trustTable().find((r) => r.kind === 'lead_reply')!.level).toBe(1);
    // the lead card tells the owner where the reply goes
    expect(w.hq.task(w.leadTasks()[0]!.id)!.result).toContain('Источник: Telegram');
    // «1» picks the first call slot
    await w.engine.onText(ME, '1');
    expect(w.transport.last(CLIENT)!.html).toContain('Записал звонок');
    expect(w.transport.last(OWNER)!.html).toContain('выбрал звонок');
  });

  it('level 0: the reply waits for the owner, then the bot sends it', async () => {
    const w = world({ replyLevel: 0 });
    await w.intake();
    await w.sales.onHeartbeat();
    const before = w.transport.to(CLIENT).length;
    expect(await w.director.sendApprovalBatch(false)).toBe(1);
    const pending = w.queue.pending()[0]!;
    expect(pending.kind).toBe('lead_reply');
    expect(pending.payload.chatId).toBe(CLIENT);
    expect(w.transport.to(CLIENT)).toHaveLength(before);
    await w.decide('approve', pending.id);
    expect(w.transport.to(CLIENT)).toHaveLength(before + 1);
    expect(w.transport.last(CLIENT)!.html).toContain('Спасибо за заявку');
    expect(w.queue.get(pending.id)!.status).toBe('executed');
  });

  const priceLead = async (w: ReturnType<typeof world>) => {
    await w.engine.onCommand(ME, 'start', '');
    await w.engine.onButton(ME, 'm:discuss', w.card());
    await w.engine.onText(ME, 'Сколько стоит бот для записи в салон?');
    await w.engine.onButton(ME, 'd:month', w.card());
    await w.engine.onButton(ME, 'b:unknown', w.card());
    await w.sales.onHeartbeat();
    await w.director.sendApprovalBatch(false);
    return w.queue.pending().find((p) => p.kind === 'lead_price')!;
  };

  it('a price never goes out on its own: locked at level 0, delivered by the bot only after the owner filled it in and approved', async () => {
    const w = world();
    const price = await priceLead(w);
    expect(price.payload.chatId).toBe(CLIENT);
    expect(w.queue.trustTable().find((r) => r.kind === 'lead_price')).toMatchObject({ level: 0, locked: true });
    const before = w.transport.to(CLIENT).map((m) => m.html);
    expect(before.some((h) => /\$\s?\d|\[цена\]/.test(h))).toBe(false); // the first reply went, the price did not
    await w.queue.applyEdit(price.id, 'Бот записи: $400, запуск за 2 недели.');
    await w.decide('approve', price.id);
    expect(w.transport.last(CLIENT)!.html).toContain('$400');
  });

  it('a price with the placeholder still in it is refused and never reaches the client', async () => {
    const w = world();
    const price = await priceLead(w);
    const before = w.transport.to(CLIENT).length;
    await w.decide('approve', price.id);
    expect(w.queue.get(price.id)!.status).toBe('failed');
    expect(w.transport.to(CLIENT)).toHaveLength(before);
  });

  it('a client who blocked the bot: delivery fails, the owner gets the text to send by hand', async () => {
    const w = world();
    await w.intake();
    w.transport.blocked.add(CLIENT);
    await w.sales.onHeartbeat();
    const note = w.messenger.sent.find((m) => m.text.includes('клиент заблокировал бота'))!;
    expect(note.chatId).toBe(OWNER);
    expect(note.text).toContain('@dilnoza_salon');
    expect(w.engine.store.get(CLIENT)!.blocked).toBe(true);
    const approval = w.db.prepare("SELECT status FROM approvals WHERE kind = 'lead_reply'").get() as { status: string };
    expect(approval.status).toBe('failed');
  });
});

describe('the website webhook', () => {
  it('cannot route a reply into somebody\'s chat: chatId and username are not accepted from the form', () => {
    const lead = webLeadSchema.parse({ name: 'X', contact: '@x_x', chatId: 42, username: 'victim' }) as Record<string, unknown>;
    expect(lead.chatId).toBeUndefined();
    expect(lead.username).toBeUndefined();
  });
});

describe('«Я уже клиент»', () => {
  it('a known client: a Support ticket with the chat id, the acknowledgement, and the KB answer goes back to the chat', async () => {
    const w = world();
    csStoreFor({ db: w.db, now: w.hq.now }).upsertClient({ name: 'Cambridge', contact: '@cambridge', product: 'бот записи' });
    await w.engine.onCommand(ME, 'start', '');
    await w.engine.onButton(ME, 'm:client', w.card());
    expect(w.transport.edits.at(-1)!.html).toContain('название компании или номер счёта');
    await w.engine.onText(ME, 'cambridge');
    expect(w.transport.last(CLIENT)!.html).toContain('опишите вопрос');
    await w.engine.onText(ME, 'Как поменять пароль от админки?');
    const texts = w.transport.to(CLIENT).map((m) => m.html);
    expect(texts.some((h) => h.includes('Приняли') && h.includes('в течение часа'))).toBe(true);
    const ticket = w.hq.tasks({ dept: 'support' }).find((t) => t.meta.action === 'ticket')!;
    expect(ticket.meta.chatId).toBe(CLIENT);
    // level 1 KB answer: delivered by the bot, not handed to the owner
    expect(w.transport.last(CLIENT)!.html).toContain('доступ');
    expect(w.messenger.sent.some((m) => m.text.includes('ответ утверждён'))).toBe(false);
    expect(w.leadTasks()).toHaveLength(0);
  });

  it('an unknown name becomes a lead with the note «пишет как клиент»; the reply never says who is a client', async () => {
    const w = world();
    await w.engine.onCommand(ME, 'start', '');
    await w.engine.onButton(ME, 'm:client', w.card());
    await w.engine.onText(ME, 'Nobody LLC');
    expect(w.transport.last(CLIENT)!.html).toContain('опишите вопрос'); // same answer as for a known client
    await w.engine.onText(ME, 'Бот перестал отвечать');
    const lead = w.leadTasks()[0]!.meta.lead as Record<string, unknown>;
    expect(lead.message).toContain('Пишет как клиент');
    expect(lead.chatId).toBe(CLIENT);
    expect(w.hq.tasks({ dept: 'support' }).filter((t) => t.meta.action === 'ticket')).toHaveLength(0);
  });
});

describe('«Позвать человека»', () => {
  it('mutes the bot and pings the owner; client texts are forwarded; the owner answers by reply or /reply; /resume brings the bot back', async () => {
    const w = world();
    await w.engine.onCommand(ME, 'start', '');
    await w.engine.onButton(ME, 'm:human', w.card());
    expect(w.engine.store.get(CLIENT)!.muted).toBe(true);
    expect(w.transport.last(CLIENT)!.html).toContain('Зову человека');
    const ping = w.transport.last(OWNER)!;
    expect(ping.html).toContain('Зовут человека');
    expect(ping.html).toContain(`/resume ${CLIENT}`);
    expect(ping.html).toContain('https://t.me/dilnoza_salon');

    await w.engine.onText(ME, 'Хочу обсудить бота для двух филиалов');
    expect(w.llmCalls()).toBe(0);
    const forwarded = w.transport.last(OWNER)!;
    expect(forwarded.html).toContain('двух филиалов');

    // Telegram reply to the forwarded notice: relayed verbatim (HTML-escaped)
    await w.engine.onText({ chatId: OWNER }, 'Здравствуйте, это Фирдавс. Удобно созвониться <завтра>?', forwarded.id);
    expect(w.transport.last(CLIENT)!.html).toBe('Здравствуйте, это Фирдавс. Удобно созвониться &lt;завтра&gt;?');
    await w.engine.onCommand({ chatId: OWNER }, 'reply', `${CLIENT} Жду ваш номер`);
    expect(w.transport.last(CLIENT)!.html).toBe('Жду ваш номер');
    expect(w.transport.last(OWNER)!.html).toContain('Отправлено');

    await w.engine.onCommand({ chatId: OWNER }, 'chats', '');
    const chats = w.transport.last(OWNER)!.html;
    expect(chats).toContain(String(CLIENT));
    expect(chats).toContain('@di***');
    expect(chats).not.toContain('dilnoza_salon');
    expect(chats).toContain('бот молчит');

    await w.engine.onCommand({ chatId: OWNER }, 'resume', String(CLIENT));
    expect(w.engine.store.get(CLIENT)!.muted).toBe(false);
    await w.engine.onText(ME, 'А вы делаете ботов для салонов?');
    expect(w.llmCalls()).toBe(1);
    expect(w.transport.typings).toBe(1);
    await w.engine.onCommand({ chatId: OWNER }, 'mute', String(CLIENT));
    expect(w.engine.store.get(CLIENT)!.muted).toBe(true);
  });

  it('/human works as a command; the owner\'s other texts get a hint, not the client flow', async () => {
    const w = world();
    await w.engine.onCommand(ME, 'human', '');
    expect(w.engine.store.get(CLIENT)!.muted).toBe(true);
    await w.engine.onCommand(ME, 'human', '');
    expect(w.transport.last(CLIENT)!.html).toContain('уже в курсе');
    await w.engine.onText({ chatId: OWNER }, 'привет');
    expect(w.transport.last(OWNER)!.html).toContain('/reply');
    expect(w.engine.store.get(OWNER)).toBeUndefined();
  });
});

describe('free conversation', () => {
  it('LLM answer is sanitised: a price or a date promise never reaches the client; the owner hears about it', async () => {
    const w = world({ answer: () => 'Делаем ботов для салонов. Такой бот стоит от 300 долларов. Сделаем за 5 дней. Расскажите о салоне?' });
    await w.engine.onText(ME, 'Вы делаете ботов для салонов?');
    const out = w.transport.last(CLIENT)!.html;
    expect(out).toContain('Делаем ботов для салонов.');
    expect(out).not.toMatch(/300|5 дней/);
    expect(out).toContain('Стоимость и сроки назовём');
    expect(w.transport.last(OWNER)!.html).toContain('Вопрос о цене или сроках');
  });

  it('a direct price question gets the template and the intake button, without the LLM', async () => {
    const w = world();
    await w.engine.onText(ME, 'Сколько стоит сайт?');
    expect(w.llmCalls()).toBe(0);
    const m = w.transport.last(CLIENT)!;
    expect(m.html).toContain('Про стоимость');
    expect(buttonTexts(m.buttons)).toContain('💬 Обсудить проект');
  });

  it('the [[team]] marker is stripped and the question goes to the owner; LLM failure falls back to «передал команде»', async () => {
    const w = world({ answer: (req) => (req.messages.at(-1)!.content.includes('договор') ? 'Уточню у команды и вернусь здесь.\n[[team]]' : '') });
    await w.engine.onText(ME, 'Можно изменить договор?');
    expect(w.transport.last(CLIENT)!.html).toBe('Уточню у команды и вернусь здесь.');
    expect(w.transport.last(OWNER)!.html).toContain('Нужен человек');
    await w.engine.onText(ME, 'Ещё вопрос про интеграцию');
    expect(w.transport.last(CLIENT)!.html).toContain('Передал команде');
    expect(w.transport.last(OWNER)!.html).toContain('интеграцию');
  });

  it('LLM off: template plus «передал команде»', async () => {
    const w = world({ llmOff: true });
    await w.engine.onText(ME, 'Вы делаете приложения?');
    expect(w.transport.last(CLIENT)!.html).toContain('Передал команде');
  });

  it('quiet hours: the bot still answers with the LLM, only the intake says a human replies in the morning', async () => {
    const w = world();
    w.clock.t = NIGHT;
    expect(w.engine.isNight()).toBe(true);
    await w.engine.onText(ME, 'Вы делаете ботов?');
    expect(w.llmCalls()).toBe(1);
    expect(w.transport.last(CLIENT)!.html).not.toContain('ответит утром');
    // the intake still works at night and says the answer comes in the morning
    await w.intake();
    expect(w.transport.edits.at(-1)!.html).toContain('утром');
    expect(w.leadTasks()).toHaveLength(1);
  });

  it('rate limit per chat: one warning over the limit, then silence; the daily LLM cap falls back to the template', async () => {
    const w = world({ perHour: 3, dailyCap: 1 });
    await w.engine.onText(ME, 'Вопрос один про ботов');
    await w.engine.onText(ME, 'Вопрос два про сайты');
    expect(w.llmCalls()).toBe(1); // the cap is 1: the second answer is a template
    expect(w.transport.last(CLIENT)!.html).toContain('Передал команде');
    await w.engine.onText(ME, 'Вопрос три');
    const n = w.transport.to(CLIENT).length;
    await w.engine.onText(ME, 'Вопрос четыре');
    expect(w.transport.to(CLIENT)).toHaveLength(n + 1);
    expect(w.transport.last(CLIENT)!.html).toContain('Сообщений много');
    await w.engine.onText(ME, 'Вопрос пять');
    expect(w.transport.to(CLIENT)).toHaveLength(n + 1);
    w.clock.t += 3600_001;
    await w.engine.onText(ME, 'Вопрос шесть');
    expect(w.transport.to(CLIENT)).toHaveLength(n + 2);
  });

  it('spam: links only and the same text a third time are dropped silently', async () => {
    const w = world();
    await w.engine.onText(ME, 'https://spam.example/x https://t.me/joinchat');
    expect(w.transport.to(CLIENT)).toHaveLength(0);
    await w.engine.onText(ME, 'Есть боты?');
    await w.engine.onText(ME, 'Есть боты?');
    await w.engine.onText(ME, 'Есть боты?');
    expect(w.transport.to(CLIENT)).toHaveLength(2);
  });
});

describe('sanitiser and limits', () => {
  const NOTE = 'Стоимость и сроки назовём после короткого разговора с командой.';
  it('drops price and date sentences, keeps the rest, adds one note', () => {
    const r = sanitizeAnswer('Мы делаем ботов. Цена от 500 у.е. Стоит $300. Будет готово к пятнице. Работает 24/7.', NOTE);
    expect(r.text).toBe(`Мы делаем ботов. Работает 24/7.\n${NOTE}`);
    expect(r.removed).toBe(3);
    for (const s of ['Сделаем за 3 дня.', 'Запустим до 25 ноября.', 'Около 2 млн сум.', 'It costs $450.', 'Ready within 2 weeks.', 'Будет бесплатно.', '1500 USD', 'Сдадим 12.12.2026.', '5к и готово.']) {
      expect(sanitizeAnswer(s, NOTE).text).toBe(NOTE);
    }
    expect(sanitizeAnswer('Расскажите о задаче, и мы предложим решение.', NOTE)).toEqual({ text: 'Расскажите о задаче, и мы предложим решение.', removed: 0 });
  });

  it('strips markdown and long dashes, cuts to 600 at a sentence end', () => {
    const long = Array.from({ length: 40 }, (_, i) => `Предложение номер ${'х'.repeat(i % 3)} о ботах.`).join(' ');
    const r = sanitizeAnswer(`**Да** — мы делаем ботов.\n${long}`, NOTE);
    expect(r.text.startsWith('Да, мы делаем ботов.')).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(600);
    expect(r.text.endsWith('.')).toBe(true);
  });

  it('quiet window across midnight; links-only detection; limiter windows', () => {
    const tz = 'Asia/Tashkent';
    expect(inWindow(NIGHT, tz, '22:00-08:00')).toBe(true);
    expect(inWindow(NOW, tz, '22:00-08:00')).toBe(false);
    expect(inWindow(NIGHT, tz, '')).toBe(false);
    expect(linksOnly('https://a.b/c  www.x.y')).toBe(true);
    expect(linksOnly('Посмотрите наш сайт https://a.b/c')).toBe(false);
    const clock = { t: NOW };
    const l = new RateLimiter(2, 2, () => clock.t, () => tz);
    expect([l.hit(1), l.hit(1), l.hit(1), l.hit(1), l.hit(2)]).toEqual(['ok', 'ok', 'warn', 'drop', 'ok']);
    l.llmUsed();
    l.llmUsed();
    expect(l.llmAllowed()).toBe(false);
    clock.t += 86_400_000;
    expect(l.llmAllowed()).toBe(true);
  });
});

describe('grammy wiring', () => {
  /** A ClientBot whose API calls are answered in memory. */
  function fakeBot() {
    const w = world();
    const calls: { method: string; payload: Record<string, unknown> }[] = [];
    const bot = new ClientBot({
      token: '1:test', db: w.db, now: () => w.clock.t, tz: () => w.hq.tz, llm: w.llm, ownerId: OWNER, instructions: 'x', quietHours: '22:00-08:00', perHour: 20, dailyCap: 10,
    });
    bot.bot.botInfo = { id: 1, is_bot: true, first_name: 'Fir Tech', username: 'firtech_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false } as typeof bot.bot.botInfo;
    bot.bot.api.config.use((_prev, method, payload) => {
      calls.push({ method, payload: payload as Record<string, unknown> });
      return Promise.resolve({ ok: true, result: method === 'sendMessage' ? { message_id: calls.length, date: 0, chat: { id: 1, type: 'private' } } : true } as never);
    });
    const msg = (chat: { id: number; type: string }, text: string) => ({
      update_id: calls.length + 1,
      message: { message_id: 1, date: 0, chat, from: { id: chat.id > 0 ? chat.id : 7, is_bot: false, first_name: 'Dilnoza' }, text, ...(text.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }] } : {}) },
    });
    return { bot, calls, msg };
  }

  it('private /start sends the HTML welcome with an inline keyboard; groups and channels are ignored', async () => {
    const { bot, calls, msg } = fakeBot();
    await bot.bot.handleUpdate(msg({ id: -100123, type: 'supergroup' }, '/start') as never);
    await bot.idle();
    expect(calls).toHaveLength(0);
    await bot.bot.handleUpdate(msg({ id: CLIENT, type: 'private' }, '/start') as never);
    await bot.idle();
    const send = calls.find((c) => c.method === 'sendMessage')!;
    expect(send.payload.chat_id).toBe(CLIENT);
    expect(send.payload.parse_mode).toBe('HTML');
    expect(JSON.stringify(send.payload.reply_markup)).toContain('m:discuss');
  });

  it('setup sets commands in RU and EN, the owner\'s commands and both descriptions, ignoring errors', async () => {
    const { bot, calls } = fakeBot();
    await bot.setup();
    const methods = calls.map((c) => c.method);
    expect(methods.filter((m) => m === 'setMyCommands')).toHaveLength(3);
    expect(methods.filter((m) => m === 'setMyDescription')).toHaveLength(2);
    expect(methods.filter((m) => m === 'setMyShortDescription')).toHaveLength(2);
    for (const c of calls.filter((x) => x.method === 'setMyShortDescription')) expect(String(c.payload.short_description).length).toBeLessThanOrEqual(120);
    for (const c of calls.filter((x) => x.method === 'setMyDescription')) expect(String(c.payload.description).length).toBeLessThanOrEqual(512);
  });
});

describe('products in the chat', () => {
  it('the catalogue is complete in Russian and English: seven products and the classics', () => {
    expect(PRODUCT_IDS).toHaveLength(7);
    expect(CLASSIC_IDS).toEqual(['site', 'bot', 'app']);
    for (const id of [...PRODUCT_IDS, ...CLASSIC_IDS]) {
      const p = PRODUCTS[id];
      for (const lang of ['ru', 'en'] as const) {
        expect(p.name[lang].length).toBeGreaterThan(2);
        expect(p.benefit[lang].length).toBeGreaterThan(20);
        expect(p.inside[lang]).toHaveLength(3);
        expect(p.demo[lang].length).toBeGreaterThan(10);
        expect(`${p.name[lang]}${p.benefit[lang]}${p.inside[lang].join('')}`).not.toMatch(/[—–]/);
      }
      expect(p.pairs.length).toBeGreaterThan(0);
      if (PRODUCT_IDS.includes(id as never)) expect(p.kinds.length).toBeGreaterThan(0);
    }
    expect(catalogueText('ru')).toContain('Бот-администратор для услуг');
    expect(catalogueText('en')).toContain('Booking assistant bot');
  });

  it('the LLM system prompt carries the catalogue and the price rule', () => {
    const sys = systemPrompt('Инструкции', 'ru');
    expect(sys).toContain('ИИ-приёмщик заявок 24/7');
    expect(sys).toContain('Dono: $150 + $15/мес');
    expect(sys).toContain('Подбери продукт');
    expect(systemPrompt('x', 'en')).toContain('Polly: $100 + $10/month');
  });

  it('«Продукты» shows a list in place, a card per product, and «Обсудить» starts the intake with the product chosen', async () => {
    const w = world();
    await w.engine.onCommand(ME, 'start', '');
    const welcome = w.card();
    await w.engine.onButton(ME, 'm:products', welcome);
    const list = w.transport.edits.at(-1)!;
    expect(list.messageId).toBe(welcome);
    expect(buttonTexts(list.buttons)).toHaveLength(8);
    expect(buttonTexts(list.buttons)[0]).toContain('Бот-администратор для услуг');
    expect(list.buttons!.flat()[0]!.data).toBe('p:admin');
    await w.engine.onButton(ME, 'p:admin', welcome);
    const card = w.transport.edits.at(-1)!;
    expect(card.html).toContain('Бот-администратор для услуг');
    expect(card.html).toContain('Для кого');
    expect(card.html).toContain('барбершопы');
    expect(card.html).toContain('Что внутри');
    expect(card.html).toContain('•');
    expect(card.buttons!.flat().map((b) => b.data)).toEqual(['pd:admin', 'm:products']);
    await w.engine.onButton(ME, 'pd:admin', welcome);
    expect(w.transport.edits.at(-1)!.html).toContain('2 из 3'); // step 1 skipped
    await w.engine.onButton(ME, 'd:month', w.card());
    await w.engine.onButton(ME, 'b:mid', w.card());
    const lead = w.leadTasks()[0]!.meta.lead as Record<string, unknown>;
    expect(lead).toMatchObject({ product: 'Бот-администратор для услуг', service: 'bots' });
    expect(String(lead.message)).toContain('Продукт: Бот-администратор для услуг');
  });

  it('intake step 1 offers the products as buttons and stores the chosen one; the agent card shows only the public prices', async () => {
    const w = world();
    await w.engine.onCommand(ME, 'start', '');
    await w.engine.onButton(ME, 'm:discuss', w.card());
    const step1 = w.transport.edits.at(-1)!;
    expect(step1.buttons!.flat().map((b) => b.data)).toEqual([
      'n:admin', 'n:receptionist', 'n:automation', 'n:content', 'n:miniapp', 'n:agent', 'n:ai', 'n:site', 'n:other',
    ]);
    await w.engine.onButton(ME, 'n:miniapp', w.card());
    await w.engine.onButton(ME, 'd:month', w.card());
    await w.engine.onButton(ME, 'b:mid', w.card());
    expect(w.leadTasks()[0]!.meta.lead).toMatchObject({ product: 'Telegram Mini App', service: 'app' });
    await w.engine.onButton(ME, 'p:agent', w.card()).catch(() => undefined);
    const agent = (await import('../src/client/texts.js')).productCardHtml('ru', 'agent');
    expect(agent).toContain('$150 + $15/мес');
    expect(agent).toContain('$100 + $10/мес');
  });

  it('a niche in free text gets one line with the typical product and its pairing', async () => {
    const w = world();
    await w.engine.onCommand(ME, 'start', '');
    await w.engine.onButton(ME, 'm:discuss', w.card());
    await w.engine.onText(ME, 'У меня барбершоп, клиенты пишут в директ');
    const step2 = w.transport.last(CLIENT)!;
    expect(step2.html).toContain('Для барбершопа обычно подходит «Бот-администратор для услуг»');
    expect(step2.html).toContain('Контент на автопилоте');
    expect(step2.html).toContain('2 из 3');
    expect(nicheHint('ru', 'кафе в центре')).toContain('Telegram Mini App');
    expect(nicheHint('en', 'we run a dental clinic')).toContain('Booking assistant bot');
    expect(nicheHint('ru', 'что-то непонятное')).toBe('');
  });

  it('the sanitiser lets the Dono and Polly prices through and still strips every other price', () => {
    const NOTE = 'Стоимость и сроки назовём после короткого разговора с командой.';
    const ok = sanitizeAnswer('Dono стоит $150 + $15/мес. Polly: $100 + $10/мес.', NOTE);
    expect(ok.removed).toBe(0);
    expect(ok.text).toContain('$150 + $15/мес');
    expect(ok.text).toContain('$100 + $10/мес');
    expect(sanitizeAnswer('Dono: $150 + $15/month.', NOTE).removed).toBe(0);
    for (const bad of ['Dono стоит $200 + $15/мес.', 'Dono: $150 + $25/мес.', 'Бот-администратор стоит $150.', 'Polly: $150 + $10/мес.', 'Сайт от 300 долларов.']) {
      const r = sanitizeAnswer(bad, NOTE);
      expect(r.removed, bad).toBe(1);
      expect(r.text).toBe(NOTE);
    }
  });
});
