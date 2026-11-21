import { openDb, type Payload } from '@fir/core';
import type { WorkerCtx } from '@fir/hq';
import { describe, expect, it } from 'vitest';
import { addMonths, dateStr, diffDays } from '../src/dates.js';
import { parseMethod } from '../src/store.js';
import { BillingWorker, KIND_INVOICE, KIND_REMINDER, parseInvoiceArgs, parsePaymentDetails, parseSubArgs, type BillingDelivery } from '../src/worker.js';

const NOW = Date.UTC(2026, 10, 18, 4, 30); // Wed 09:30 Tashkent
const DAY = 86_400_000;

function setup(details = { usdt_trc20: 'TXyz', usdt_ton: 'UQabc', wallet: 'Payeer P1234567' }) {
  const db = openDb(':memory:');
  const clock = { t: NOW };
  const staged: { kind: string; payload: Payload; summary: string }[] = [];
  const ctx: WorkerCtx = {
    llm: { enabled: false, complete: () => Promise.reject(new Error('no llm')) }, db, tz: 'Asia/Tashkent', now: () => clock.t,
    requestApproval: (kind, payload, summary) => Promise.resolve(staged.push({ kind, payload, summary }) - 1),
    log: () => undefined,
  };
  const worker = new BillingWorker({ paymentDetails: details });
  const delivered: BillingDelivery[] = [];
  const specs = worker.kindSpecs(ctx, (d) => Promise.resolve(void delivered.push(d)));
  return { db, ctx, clock, staged, worker, delivered, specs, store: worker.store(ctx) };
}

describe('parsing', () => {
  it('parses /invoice with a multi-word client, flags and the description', () => {
    expect(parseInvoiceArgs('Салон Роза 120 сайт под ключ due=2026-12-01 method=usdt_ton new')).toEqual({
      client: 'Салон Роза', amountUsd: 120, what: 'сайт под ключ', dueDate: '2026-12-01', method: 'usdt_ton', newProject: true,
    });
    expect(parseInvoiceArgs('Dilnoza $49,5 поддержка')).toMatchObject({ client: 'Dilnoza', amountUsd: 49.5, newProject: false });
    expect(parseInvoiceArgs('Dilnoza поддержка')).toBeNull();
    expect(parseInvoiceArgs('Dilnoza 10 x due=завтра')).toBeNull();
  });

  it('parses /sub and payment details', () => {
    expect(parseSubArgs('Dilnoza 30 month usdt_trc20 2026-12-01 базовый тариф')).toMatchObject({ client: 'Dilnoza', amountUsd: 30, period: 'month', method: 'usdt_trc20', plan: 'базовый тариф' });
    expect(parseSubArgs('Dilnoza 30 week usdt_trc20 2026-12-01')).toBeNull();
    expect(parsePaymentDetails('{"usdt_trc20":"1","usdt_ton":"2","wallet":"3"}')).toEqual({ usdt_trc20: '1', usdt_ton: '2', wallet: '3' });
    expect(parsePaymentDetails(undefined)).toEqual({});
    expect(() => parsePaymentDetails('{"stripe":"x"}')).toThrow(/unknown method/);
    for (const old of ['payme', 'kaspi', 'click', 'card']) expect(() => parsePaymentDetails(`{"${old}":"x"}`), old).toThrow(/usdt_trc20, usdt_ton, wallet/);
    expect(parseInvoiceArgs('Roza 10 x method=kaspi')).toBeNull(); // no longer accepted
    expect(parseMethod('USDT')).toBe('usdt_trc20');
    expect(parseMethod('кошелёк')).toBe('wallet');
    expect(() => parsePaymentDetails('nope')).toThrow(/PAYMENT_DETAILS_JSON/);
  });

  it('date helpers', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
    expect(diffDays('2026-11-18', '2026-11-21')).toBe(3);
    expect(dateStr(NOW, 'Asia/Tashkent')).toBe('2026-11-18');
  });
});

describe('invoice numbering and text', () => {
  it('numbers FT-YYYY-NNN per year, stages one locked invoice item with payment details', async () => {
    const r = setup();
    const a = await r.worker.createInvoice(r.ctx, { client: 'Dilnoza', amountUsd: 120, what: 'сайт' });
    const b = await r.worker.createInvoice(r.ctx, { client: 'Roza', amountUsd: 60, what: 'бот', method: 'usdt_ton' });
    expect([a.number, b.number]).toEqual(['FT-2026-001', 'FT-2026-002']);
    expect(r.staged[0]!.kind).toBe(KIND_INVOICE);
    const text = String(r.staged[0]!.payload.text);
    expect(text).toContain('Счёт FT-2026-001');
    expect(text).toContain('Сумма: $120');
    // USDT goes through the pay page: the exact sum and the link, never the raw addresses in the chat
    expect(text).toContain('Сумма к переводу: 120.00 USDT');
    expect(text).toMatch(/USDT \(TRC20 или TON\): переведите ровно 120\.00 USDT, адрес и QR на странице оплаты: https:\/\/firtech\.pro\/ru\/pay\/FT-2026-001\?k=[A-Za-z0-9_-]{32}/);
    expect(text).not.toContain('TXyz');
    expect(text).not.toContain('UQabc');
    expect(text).toContain('Онлайн-кошелёк из сметы: Payeer P1234567');
    expect(r.staged[0]!.summary).toMatch(/Ссылка на оплату: https:\/\/firtech\.pro\/ru\/pay\/FT-2026-001\?k=/);
    expect(r.staged[0]!.summary).toContain('Сумма к переводу: 120.00 USDT');
    expect(text).toContain('оплата по этапам, каждый этап до его начала, последний до передачи доступов');
    expect(text).not.toMatch(/50%|предоплат/);
    expect(text).not.toMatch(/Kaspi|Payme|Click|карт/i);
    const only = String(r.staged[1]!.payload.text);
    expect(only).toContain('USDT (TON)');
    expect(only).not.toContain('TRC20');
    expect(only).not.toContain('Payeer');
    expect(a.dueDate).toBe('2026-11-25');
    expect(r.specs[KIND_INVOICE]).toMatchObject({ initialLevel: 0, locked: true });
    r.clock.t = Date.UTC(2027, 0, 5);
    expect((await r.worker.createInvoice(r.ctx, { client: 'X', amountUsd: 1, what: 'y' })).number).toBe('FT-2027-001');
  });

  it('missing payment details become a placeholder that blocks sending; approved invoice becomes issued', async () => {
    const r = setup({} as never);
    const inv = await r.worker.createInvoice(r.ctx, { client: 'A', amountUsd: 10, what: 'x', method: 'usdt_trc20' });
    expect(String(r.staged[0]!.payload.text)).toContain('[реквизиты USDT (сеть TRC20)]');
    await expect(r.specs[KIND_INVOICE]!.execute(r.staged[0]!.payload, 1)).rejects.toThrow(/placeholder/);
    const ok = setup();
    const i2 = await ok.worker.createInvoice(ok.ctx, { client: 'A', amountUsd: 10, what: 'x' });
    expect(ok.store.invoice(i2.id)?.status).toBe('draft');
    await ok.specs[KIND_INVOICE]!.execute(ok.staged[0]!.payload, 1);
    expect(ok.store.invoice(i2.id)?.status).toBe('issued');
    expect(inv.number).toBe('FT-2026-001');
  });
});

async function issued(r: ReturnType<typeof setup>, due: string) {
  const inv = await r.worker.createInvoice(r.ctx, { client: 'Dilnoza', amountUsd: 100, what: 'сайт', dueDate: due });
  r.store.setStatus(inv.id, 'issued');
  r.staged.length = 0;
  return inv;
}

describe('reminders', () => {
  it('3 days before, on the due date (each once), overdue alert after 5 days (once)', async () => {
    const r = setup();
    await issued(r, '2026-11-21');
    let d = await r.worker.daily(r.ctx);
    expect(d.lines).toHaveLength(1);
    expect(r.staged.map((s) => s.kind)).toEqual([KIND_REMINDER]);
    expect(String(r.staged[0]!.payload.text)).toContain('через 3 дн.');
    expect(r.specs[KIND_REMINDER]).toMatchObject({ initialLevel: 0, locked: true });
    d = await r.worker.daily(r.ctx);
    expect(d.lines).toEqual([]);
    r.clock.t += 3 * DAY; // 21.11
    d = await r.worker.daily(r.ctx);
    expect(String(r.staged[1]!.payload.text)).toContain('сегодня');
    expect(d.alerts).toEqual([]);
    r.clock.t += 4 * DAY; // 25.11, 4 days overdue
    expect((await r.worker.daily(r.ctx)).alerts).toEqual([]);
    r.clock.t += DAY; // 26.11, 5 days overdue
    const late = await r.worker.daily(r.ctx);
    expect(late.alerts).toHaveLength(1);
    expect(late.alerts[0]).toContain('просрочен на 5 дн.');
    expect((await r.worker.daily(r.ctx)).alerts).toEqual([]);
    expect(r.staged).toHaveLength(2);
  });

  it('paid invoices get no reminders', async () => {
    const r = setup();
    const inv = await issued(r, '2026-11-20');
    r.worker.markPaid(r.ctx, inv.number);
    expect((await r.worker.daily(r.ctx)).lines).toEqual([]);
  });

  it('subscription invoice drafts appear 7 days before the due date, once; paying moves the due date', async () => {
    const r = setup();
    const sub = r.store.addSubscription({ client: 'Roza', plan: 'базовый', amountUsd: 30, period: 'month', nextDue: '2026-11-30', method: 'usdt_trc20' });
    expect((await r.worker.daily(r.ctx)).lines).toEqual([]); // 12 days ahead
    r.clock.t += 5 * DAY;
    const d = await r.worker.daily(r.ctx);
    expect(d.lines[0]).toContain('по подписке Roza');
    expect(String(r.staged[0]!.payload.text)).toContain('Подписка: базовый');
    expect((await r.worker.daily(r.ctx)).lines.filter((l) => l.includes('по подписке'))).toEqual([]);
    const paid = r.worker.markPaid(r.ctx, 'FT-2026-001');
    expect(paid?.nextDue).toBe('2026-12-30');
    expect(r.store.subscription(sub.id)?.nextDue).toBe('2026-12-30');
  });
});

describe('paid and revenue', () => {
  it('/paid accepts number forms, is idempotent, and feeds paid revenue', async () => {
    const r = setup();
    const a = await r.worker.createInvoice(r.ctx, { client: 'A', amountUsd: 100, what: 'x', newProject: true });
    await r.worker.createInvoice(r.ctx, { client: 'B', amountUsd: 50, what: 'y' });
    expect(r.store.revenue(0, NOW + DAY)).toBe(0);
    const res = r.worker.markPaid(r.ctx, 'ft-2026-001');
    expect(res?.invoice).toMatchObject({ status: 'paid', newProject: true });
    expect(res?.already).toBe(false);
    expect(r.worker.markPaid(r.ctx, '1')?.already).toBe(true);
    expect(r.worker.markPaid(r.ctx, 'FT-2026-099')).toBeNull();
    expect(r.store.revenue(NOW - 1, NOW + DAY)).toBe(100);
    r.worker.markPaid(r.ctx, '#2');
    expect(r.store.revenue(NOW - 1, NOW + DAY)).toBe(150);
    expect(r.worker.invoicesText(r.ctx)).toBe('Неоплаченных счетов нет.\n\nПоследние оплаченные:\nFT-2026-002 B: $50, вручную (/paid)\nFT-2026-001 A: $100, вручную (/paid)');
    expect(r.store.invoice(a.id)).toMatchObject({ paidVia: 'manual', txId: null });
    expect(a.number).toBe('FT-2026-001');
  });
});

describe('the conditions line in the invoice', () => {
  it('a project invoice says what is not in the sum and keeps the stage payment rule; the client\'s own domain and hosting change the line; a subscription invoice has none', async () => {
    const r = setup();
    const inv = await r.worker.createInvoice(r.ctx, { client: 'Dilnoza', amountUsd: 145, what: 'Этап 1 из 2 по КП', newProject: true });
    const text = String(r.staged[0]!.payload.text);
    expect(text).toContain('Что не входит в сумму: Домен, хостинг, сервер и платные сторонние сервисы (SMS, API, платежи) в сумму не входят: заказчик оплачивает их напрямую, цена у всех разная. Для ориентира: домен $10-15 в год, хостинг от $5 в месяц.');
    expect(text).toContain('оплата по этапам, каждый этап до его начала, последний до передачи доступов');
    expect(text).not.toMatch(/50%|предоплат/);
    const own = r.worker.invoiceText(inv, { hasDomain: true, hasHosting: true });
    expect(own).toContain('Что не входит в сумму: Домен и хостинг у заказчика есть, используем их; платные сторонние сервисы (SMS, API, платежи) оплачиваются отдельно.');
    const sub = r.store.addSubscription({ client: 'Roza', plan: 'поддержка', amountUsd: 20, period: 'month', method: null, nextDue: '2026-12-01' });
    const subInv = await r.worker.createInvoice(r.ctx, { client: 'Roza', amountUsd: 20, what: 'Подписка', subscriptionId: sub.id });
    expect(r.worker.invoiceText(subInv)).not.toContain('Что не входит в сумму');
  });
});

describe('payment by stages: an invoice pays one stage of a project', () => {
  it('stageNo is stored with the invoice, the card names the stage, forStage finds the live invoice (a void one is skipped)', async () => {
    const r = setup();
    const inv = await r.worker.createInvoice(r.ctx, { client: 'Dilnoza', amountUsd: 300, what: 'Этап 1 из 3', newProject: true, link: { projectId: 7, totalUsd: 1000, stageNo: 1, stageCount: 3 } });
    expect(inv.stageNo).toBe(1);
    expect(r.staged[0]!.summary).toContain('этап 1 из 3 точной цены пакета из КП (всего $1000)');
    expect(r.store.forStage(7, 1)!.id).toBe(inv.id);
    expect(r.store.forStage(7, 2)).toBeUndefined();
    r.store.setStatus(inv.id, 'void');
    expect(r.store.forStage(7, 1)).toBeUndefined();
    const plain = await r.worker.createInvoice(r.ctx, { client: 'Roza', amountUsd: 20, what: 'x' });
    expect(plain.stageNo).toBeNull();
  });
});

describe('a stale card (drill 2026-11-21): the invoice was voided or paid before the owner decided', () => {
  it('«ready» holds the approval with the reason, and a clean invoice is ready', async () => {
    const { worker, ctx, specs, store, delivered } = setup();
    const inv = await worker.createInvoice(ctx, { client: 'Анна', amountUsd: 100, what: 'бот', dueDate: '2026-11-25', method: 'usdt_trc20', subscriptionId: null });
    const payload = { text: 'Счёт: оплата по ссылке', invoiceId: inv.id, name: 'Анна' };
    expect(specs[KIND_INVOICE]!.ready!(payload)).toBeNull();
    store.setStatus(inv.id, 'void');
    expect(specs[KIND_INVOICE]!.ready!(payload)).toContain('аннулирован');
    expect(specs[KIND_REMINDER]!.ready!(payload)).toContain('аннулирован');
    store.setStatus(inv.id, 'paid');
    expect(specs[KIND_REMINDER]!.ready!(payload)).toContain('оплачен');
    expect(specs[KIND_INVOICE]!.ready!({ ...payload, invoiceId: 9999 })).toBeNull(); // an unknown invoice is not this check's business
    expect(delivered).toHaveLength(0);
  });
});

describe('the invoice names the legal customer', () => {
  it('invoiceText prints the legal label instead of the client name when it is given', () => {
    const r = setup();
    const inv = r.store.addInvoice({ client: 'Алиса', amountUsd: 100, what: 'Этап 1', method: null, dueDate: '2026-11-30', subscriptionId: null, newProject: true } as never, 2026);
    expect(r.worker.invoiceText(inv, {}, 'ООО Ромашка, адрес: Душанбе')).toContain('Клиент: ООО Ромашка, адрес: Душанбе');
    expect(r.worker.invoiceText(inv)).toContain('Клиент: Алиса');
  });
});
