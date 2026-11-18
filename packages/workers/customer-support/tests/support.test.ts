import { MockLlm, OffLlm, openDb, type LlmClient, type Payload } from '@fir/core';
import type { WorkerCtx } from '@fir/hq';
import { describe, expect, it } from 'vitest';
import { isMoneyTopic, loadKb, lookup, parseKbEntry } from '../src/kb.js';
import { csStoreFor, CustomerSupportWorker, KIND_ANSWER, KIND_MONEY, parseClientArgs, parseTicketArgs, type TicketDelivery } from '../src/worker.js';

const NOW = Date.UTC(2026, 10, 18, 7, 0);

function setup(llm: LlmClient = new OffLlm()) {
  const db = openDb(':memory:');
  const clock = { t: NOW };
  const staged: { kind: string; payload: Payload; summary: string }[] = [];
  const ctx: WorkerCtx = {
    llm, db, tz: 'Asia/Tashkent', now: () => clock.t,
    requestApproval: (kind, payload, summary) => Promise.resolve(staged.push({ kind, payload, summary }) - 1),
    log: () => undefined,
  };
  const worker = new CustomerSupportWorker();
  const delivered: TicketDelivery[] = [];
  const specs = worker.kindSpecs(ctx, (d) => Promise.resolve(void delivered.push(d)));
  return { db, ctx, clock, staged, worker, delivered, specs };
}

describe('knowledge base', () => {
  const kb = loadKb();
  it('ships 6 to 8 answers, each with title and keywords', () => {
    expect(kb.length).toBeGreaterThanOrEqual(6);
    expect(kb.length).toBeLessThanOrEqual(8);
    for (const e of kb) expect(e.keywords.length).toBeGreaterThan(0);
  });

  it('finds the right entry by wording, with Russian endings', () => {
    expect(lookup(kb, 'Как поменять текст приветствия в боте?')?.entry.id).toBe('change-bot-texts');
    expect(lookup(kb, 'куда приходят заявки с сайта')?.entry.id).toBe('leads-arrive');
    expect(lookup(kb, 'Как оплатить подписку? Есть Kaspi?')?.entry.id).toBe('how-to-pay');
    expect(lookup(kb, 'до скольки вы работаете, какой график')?.entry.id).toBe('support-hours');
    expect(lookup(kb, 'сайт не открывается, срочно')?.entry.id).toBe('outage-policy');
    expect(lookup(kb, 'хочу добавить новую функцию')?.entry.id).toBe('request-change');
  });

  it('returns null for an unrelated question', () => {
    expect(lookup(kb, 'какая погода завтра')).toBeNull();
  });

  it('parses the entry format and skips broken files', () => {
    expect(parseKbEntry('x', '# T\nключи: а, б\n\nТекст')).toMatchObject({ title: 'T', keywords: ['а', 'б'], answer: 'Текст' });
    expect(parseKbEntry('x', 'без заголовка')).toBeNull();
  });

  it('flags money topics', () => {
    expect(isMoneyTopic('Верните деньги за сайт')).toBe(true);
    expect(isMoneyTopic('нужна скидка')).toBe(true);
    expect(isMoneyTopic('как оплатить')).toBe(false);
  });
});

describe('ticket', () => {
  it('parses /ticket and /client arguments', () => {
    expect(parseTicketArgs('Dilnoza: как поменять текст бота')).toEqual({ client: 'Dilnoza', text: 'как поменять текст бота' });
    expect(parseTicketArgs('нет двоеточия')).toBeNull();
    expect(parseClientArgs('Dilnoza | @dil | бот записи | базовый | 2026-11-01')).toMatchObject({ name: 'Dilnoza', contact: '@dil', plan: 'базовый' });
  });

  it('LLM off: greeting plus the KB text, one level-1 answer approval', async () => {
    const r = setup();
    csStoreFor(r.ctx).upsertClient({ name: 'Dilnoza', contact: '@dil', product: 'бот записи' });
    const res = await r.worker.handleTicket(r.ctx, { client: 'dilnoza', text: 'Как поменять текст приветствия в боте?' });
    expect(r.staged).toHaveLength(1);
    expect(r.staged[0]!.kind).toBe(KIND_ANSWER);
    expect(String(r.staged[0]!.payload.text)).toContain('Здравствуйте, Dilnoza');
    expect(String(r.staged[0]!.payload.text)).toContain('Тексты бота');
    expect(r.staged[0]!.payload).toMatchObject({ ticketId: 1, contact: '@dil' });
    expect(res.line).toContain('Как поменять тексты бота');
    expect(r.specs[KIND_ANSWER]!.initialLevel).toBe(1);
  });

  it('uses the model wording when it is clean, falls back when it names money or leaves a placeholder', async () => {
    const good = setup(new MockLlm(() => 'Здравствуйте, Dilnoza! Напишите нам, какой текст заменить, и мы обновим его в течение рабочего дня.'));
    await good.worker.handleTicket(good.ctx, { client: 'Dilnoza', text: 'как поменять текст бота' });
    expect(String(good.staged[0]!.payload.text)).toContain('в течение рабочего дня');
    const bad = setup(new MockLlm(() => 'Здравствуйте! Это стоит [цена] долларов, пишите.'));
    await bad.worker.handleTicket(bad.ctx, { client: 'Dilnoza', text: 'как поменять текст бота' });
    expect(String(bad.staged[0]!.payload.text)).toContain('Тексты бота');
  });

  it('money question: locked level-0 kind with a placeholder, no model call', async () => {
    const llm = new MockLlm(() => 'не должен вызываться');
    const r = setup(llm);
    await r.worker.handleTicket(r.ctx, { client: 'Dilnoza', text: 'Хочу вернуть деньги, сайт не нужен' });
    expect(r.staged[0]!.kind).toBe(KIND_MONEY);
    expect(r.specs[KIND_MONEY]).toMatchObject({ initialLevel: 0, locked: true });
    expect(llm.calls).toHaveLength(0);
    await expect(r.specs[KIND_MONEY]!.execute(r.staged[0]!.payload, 1)).rejects.toThrow(/placeholder/);
  });

  it('no KB match: draft with a placeholder that blocks sending until edited', async () => {
    const r = setup();
    await r.worker.handleTicket(r.ctx, { client: 'Новый', text: 'какая погода завтра' });
    expect(String(r.staged[0]!.payload.text)).toContain('[');
    await expect(r.specs[KIND_ANSWER]!.execute(r.staged[0]!.payload, 1)).rejects.toThrow();
  });

  it('approved answer is delivered and closes the ticket', async () => {
    const r = setup();
    await r.worker.handleTicket(r.ctx, { client: 'Dilnoza', text: 'как оплатить' });
    await r.specs[KIND_ANSWER]!.execute(r.staged[0]!.payload, 1);
    expect(r.delivered).toHaveLength(1);
    expect(csStoreFor(r.ctx).ticket(1)?.status).toBe('answered');
  });
});

describe('SLA and lists', () => {
  it('alerts once for a ticket open longer than 4 hours; answered tickets never alert', async () => {
    const r = setup();
    await r.worker.handleTicket(r.ctx, { client: 'A', text: 'как поменять текст бота' });
    await r.worker.handleTicket(r.ctx, { client: 'B', text: 'как оплатить' });
    await r.specs[KIND_ANSWER]!.execute(r.staged[1]!.payload, 1);
    r.clock.t += 3 * 3600_000;
    expect(r.worker.slaAlerts(r.ctx)).toEqual([]);
    r.clock.t += 1.1 * 3600_000;
    const alerts = r.worker.slaAlerts(r.ctx);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('#1');
    expect(alerts[0]).toContain('4 ч');
    expect(r.worker.slaAlerts(r.ctx)).toEqual([]);
  });

  it('/tickets lists open first with their age; /clients lists clients', async () => {
    const r = setup();
    csStoreFor(r.ctx).upsertClient({ name: 'A', product: 'сайт' });
    await r.worker.handleTicket(r.ctx, { client: 'A', text: 'как поменять текст бота' });
    r.clock.t += 2 * 3600_000;
    expect(r.worker.ticketsText(r.ctx)).toMatch(/#1 ОТКРЫТ 2 ч: A: как поменять/);
    expect(r.worker.clientsText(r.ctx)).toContain('A: сайт');
    expect(setup().worker.ticketsText(setup().ctx)).toBe('Тикетов нет.');
  });
});
