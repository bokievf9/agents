import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { ApprovalQueue, MemoryMessenger, MockLlm, openDb } from '@fir/core';
import { Hq } from '@fir/hq';
import { BillingWorker, billingStoreFor, PaymentWatcher, tonFriendly, USDT_TRC20_CONTRACT, type ChainGet } from '@fir/worker-billing';
import { FinanceWorker } from '@fir/worker-finance';
import { MonitoringWorker } from '@fir/worker-monitoring';
import { describe, expect, it } from 'vitest';
import { Director } from '../src/director.js';
import { PAYMENT_WATCH_NAME, SupportHead, seedSupport } from '../src/heads/support.js';
import { payApi } from '../src/pay.js';
import { Reporter } from '../src/reporter.js';
import { createWebhook } from '../src/webhook.js';

const OWNER = 100;
// Wed 2026-11-18 12:00 Tashkent
const T0 = Date.UTC(2026, 10, 18, 7, 0);
const MIN = 60_000;
const TRON = 'TQrY8tryqsYVCYS3MFbtffiPp2ccyn4STm';
const TON = tonFriendly(`0:${'ab'.repeat(32)}`, false)!;

function world() {
  const clock = { t: T0 };
  const db = openDb(':memory:');
  const messenger = new MemoryMessenger();
  const hq = new Hq(db, { now: () => clock.t });
  const queue = new ApprovalQueue(db, messenger, OWNER, 20, () => clock.t);
  hq.attachQueue(queue);
  hq.upsertAgent({ id: 'director', dept: 'hq', role: 'director', title: 'Директор' });
  seedSupport(hq, { supportBudgetUsd: 0 }, () => 'Инструкция головы');
  const reporter = new Reporter(undefined, {}, new Map());
  const llm = new MockLlm(() => '');
  const director = new Director({ hq, llm, messenger, queue, ownerId: OWNER, reporter });
  const billing = new BillingWorker({ paymentDetails: { usdt_trc20: TRON, usdt_ton: TON } });
  const chain: { data: unknown[]; calls: string[] } = { data: [], calls: [] };
  const get: ChainGet = (url) => {
    chain.calls.push(url);
    return Promise.resolve(url.includes('trongrid') ? { ok: true, status: 200, body: { success: true, data: chain.data } } : { ok: true, status: 200, body: { jetton_transfers: [] } });
  };
  const payWatch = new PaymentWatcher({ addresses: billing.chainAddresses(), get });
  const head = new SupportHead({
    hq, llm, reporter, monitor: new MonitoringWorker({ urls: [], omnirouteUrl: 'http://o/h', dataDir: '/d', docker: false, dockerSocket: '/s', diskMaxPct: 85, certMinDays: 14, timeoutMs: 1000 }),
    finance: new FinanceWorker({ fixedCosts: {} }), billing, payWatch, messenger, ownerId: OWNER,
  });
  const started: string[] = [];
  head.onPaid = (inv) => Promise.resolve([`hook ${inv.number} ${inv.paidVia}`]).then((l) => (started.push(...l), l));
  director.onSupportCommand = (name, args) => head.onCommand(name, args);
  /** Sends the batch and approves every pending invoice card (the owner's «Одобрить»). */
  const approveInvoice = async () => {
    await director.sendApprovalBatch(false);
    for (const p of queue.pending().filter((x) => x.kind === 'billing_invoice')) {
      await queue.handle('approve', p.id, OWNER);
      director.afterDecision();
    }
  };
  return { clock, db, hq, messenger, director, head, billing, chain, started, approveInvoice };
}

const trc = (id: string, value: string, ts: number) => ({
  transaction_id: id, token_info: { symbol: 'USDT', address: USDT_TRC20_CONTRACT, decimals: 6, name: 'Tether USD' }, block_timestamp: ts, from: 'TFromX', to: TRON, type: 'Transfer', value,
});

describe('USDT pay links: HQ end to end', () => {
  it('/invoice puts the link and the exact sum in the card; the watcher finds the transfer and runs the /paid steps with the tx', async () => {
    const w = world();
    await w.director.onCommand('invoice', 'Dilnoza Karimova 150 бот записи new');
    await w.director.onCommand('invoice', 'Roza 150 сайт');
    const store = billingStoreFor({ db: w.db, now: w.hq.now });
    const [a, b] = [store.invoice(1)!, store.invoice(2)!];
    expect([a.payAmountUsd, b.payAmountUsd]).toEqual([150, 150.01]);
    const cards = w.hq.queuedApprovals().filter((x) => x.kind === 'billing_invoice');
    expect(cards).toHaveLength(2);
    await w.approveInvoice();
    expect(store.invoice(1)!.status).toBe('issued');
    const sentToOwner = w.messenger.sent.map((m) => m.text).join('\n');
    expect(sentToOwner).toContain(`Ссылка на оплату: https://firtech.pro/ru/pay/FT-2026-001?k=${a.payKey}`);
    expect(sentToOwner).toContain('Сумма к переводу: 150.01 USDT');
    expect(sentToOwner).not.toContain(TRON);
    // /invoices lists the links
    expect(await w.head.onCommand('invoices', '')).toContain(`https://firtech.pro/ru/pay/FT-2026-002?k=${b.payKey}`);

    // the client pays 150.01 on TRC20: the watcher marks FT-2026-002, Production/Sales hook runs, the owner gets the line with the tx
    const tx = 'f'.repeat(64);
    w.chain.data = [trc(tx, '150010000', T0 + 5 * MIN)];
    w.clock.t = T0 + 6 * MIN;
    const before = w.messenger.sent.length;
    const texts = await w.head.paymentTick();
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain(`Оплачено: счёт FT-2026-002 (Roza, $150), пришло 150.01 USDT в сети TRC20, tx ${tx}`);
    expect(texts[0]).toContain('hook FT-2026-002 usdt_trc20');
    expect(w.messenger.sent.slice(before).map((m) => m.text)).toContain(texts[0]);
    expect(store.invoice(2)).toMatchObject({ status: 'paid', paidVia: 'usdt_trc20', txId: tx });
    expect(w.hq.tasks({ dept: 'support' }).find((t) => t.title.startsWith('Оплата: FT-2026-002'))!.status).toBe('done');
    // the next cycles change nothing; /paid says it was paid on-chain
    expect(await w.head.paymentTick()).toEqual([]);
    expect(await w.head.onCommand('paid', 'FT-2026-002')).toContain(`уже отмечен оплаченным (USDT, tx ${tx})`);
    expect(w.started).toEqual(['hook FT-2026-002 usdt_trc20']);

    // the manual path keeps working and starts onboarding for a new project
    const manual = await w.head.onCommand('paid', 'FT-2026-001');
    expect(manual).toContain('Счёт FT-2026-001 (Dilnoza Karimova, $150) оплачен');
    expect(manual).toContain('hook FT-2026-001 manual');
    expect(manual).toContain('Онбординг');
    expect(store.invoice(1)).toMatchObject({ paidVia: 'manual', txId: null });
    const list = await w.head.onCommand('invoices', '');
    expect(list).toContain(`FT-2026-002 Roza: $150, USDT TRC20, tx ${tx}`);
    expect(list).toContain('FT-2026-001 Dilnoza Karimova: $150, вручную (/paid)');
    expect(PAYMENT_WATCH_NAME).toBe('billing-payment-watch');
  });

  it('the watcher alerts the owner about a transfer that fits no invoice', async () => {
    const w = world();
    await w.director.onCommand('invoice', 'Roza 70 сайт');
    await w.approveInvoice();
    w.chain.data = [trc('e'.repeat(64), '69000000', T0 + MIN)];
    w.clock.t = T0 + 2 * MIN;
    const alerts: string[] = [];
    w.hq.onAlert((t) => void alerts.push(t));
    expect(await w.head.paymentTick()).toEqual([]);
    expect(alerts).toEqual([expect.stringContaining('Пришёл перевод 69.00 USDT (TRC20)')]);
    await w.head.paymentTick();
    expect(alerts).toHaveLength(1);
  });
});

describe('GET /pay/:number (public, the key is the protection)', () => {
  async function start() {
    const w = world();
    await w.director.onCommand('invoice', 'Dilnoza Karimova 150 бот записи');
    await w.approveInvoice();
    await w.director.onCommand('invoice', 'Roza 20 черновик'); // stays a draft
    const store = billingStoreFor({ db: w.db, now: w.hq.now });
    const server = createWebhook(() => Promise.resolve(0), undefined, () => w.clock.t, undefined, undefined, undefined, { pay: payApi(w.db, w.billing, w.hq.now, () => 'Asia/Tashkent') });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { ...w, store, server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }

  it('returns the documented JSON with the right key, and the same 404 for an unknown number, a wrong key, a draft', async () => {
    const { server, url, store } = await start();
    try {
      const inv = store.invoice(1)!;
      const ok = await fetch(`${url}/pay/${inv.number}?k=${inv.payKey}`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get('cache-control')).toBe('no-store');
      const body = (await ok.json()) as { ok: boolean; invoice: Record<string, unknown> };
      expect(body.ok).toBe(true);
      expect(Object.keys(body.invoice).sort()).toEqual(['amountUsd', 'clientFirstName', 'dueDate', 'issuedAt', 'locale', 'methods', 'number', 'paidAt', 'paidVia', 'payAmountUsd', 'status', 'title', 'txId'].sort());
      expect(body.invoice).toMatchObject({ number: 'FT-2026-001', clientFirstName: 'Dilnoza', amountUsd: 150, payAmountUsd: 150, status: 'issued', paidVia: null, txId: null, locale: 'ru' });
      expect(body.invoice.methods).toEqual([
        { id: 'usdt_trc20', network: 'TRON (TRC20)', address: TRON, note: expect.stringContaining('Только USDT в сети TRON') },
        { id: 'usdt_ton', network: 'TON', address: TON, note: expect.stringContaining('Только USDT в сети TON') },
      ]);
      const draft = store.invoice(2)!;
      const misses = [
        `${url}/pay/FT-2026-099?k=${inv.payKey}`, `${url}/pay/${inv.number}?k=${'A'.repeat(32)}`, `${url}/pay/${inv.number}`, `${url}/pay/${draft.number}?k=${draft.payKey}`,
        `${url}/pay/FT-2026-001%2F..?k=x`, `${url}/pay/%E0%A4%A?k=x`, `${url}/pay/ft-2026-001?k=${'b'.repeat(200)}`,
      ];
      for (const m of misses) {
        const r = await fetch(m);
        expect(r.status, m).toBe(404);
        expect(await r.text(), m).toBe('{"ok":false,"error":"not_found"}');
      }
      // lower-case number works too (the site may pass it through as typed)
      expect((await fetch(`${url}/pay/ft-2026-001?k=${inv.payKey}`)).status).toBe(200);
    } finally {
      server.close();
    }
  });

  it('shows paid with the tx within the 10 s cache and limits one IP to 60 a minute', async () => {
    const w = await start();
    try {
      const inv = w.store.invoice(1)!;
      const tx = 'a'.repeat(64);
      w.chain.data = [trc(tx, '150000000', T0 + MIN)];
      w.clock.t = T0 + 2 * MIN;
      await w.head.paymentTick();
      w.clock.t += 11_000;
      const paid = (await (await fetch(`${w.url}/pay/${inv.number}?k=${inv.payKey}`)).json()) as { invoice: Record<string, unknown> };
      expect(paid.invoice).toMatchObject({ status: 'paid', paidVia: 'usdt_trc20', txId: tx, methods: [], paidAt: new Date(T0 + 2 * MIN).toISOString() });
      for (let i = 0; i < 59; i++) await fetch(`${w.url}/pay/${inv.number}?k=${inv.payKey}`);
      // 60 requests in this minute so far: the 61st is refused
      const limited = await fetch(`${w.url}/pay/${inv.number}?k=${inv.payKey}`);
      expect(limited.status).toBe(429);
    } finally {
      w.server.close();
    }
  });

  it('without the pay api the route does not exist', async () => {
    const server = createWebhook(() => Promise.resolve(0), undefined);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      expect((await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/pay/FT-2026-001?k=x`)).status).toBe(404);
    } finally {
      server.close();
    }
  });
});

describe('payApi cache', () => {
  it('keeps the row 10 s per number but checks the key on every request', async () => {
    const db = openDb(':memory:');
    const clock = { t: T0 };
    const billing = new BillingWorker({ paymentDetails: { usdt_trc20: TRON } });
    const store = billing.store({ db, now: () => clock.t });
    const inv = store.addInvoice({ client: 'A B', amountUsd: 10, what: 'x', method: null, dueDate: '2026-11-30' }, 2026);
    store.setStatus(inv.id, 'issued');
    const api = payApi(db, billing, () => clock.t, () => 'Asia/Tashkent');
    expect(api.get(inv.number, inv.payKey!)!.invoice.status).toBe('issued');
    store.markManualPaid(inv.id);
    expect(api.get(inv.number, inv.payKey!)!.invoice.status).toBe('issued'); // cached
    expect(api.get(inv.number, 'wrong')).toBeNull();
    clock.t += 10_001;
    expect(api.get(inv.number, inv.payKey!)!.invoice).toMatchObject({ status: 'paid', paidVia: 'manual', methods: [] });
  });
});
