import { openDb, type Payload } from '@fir/core';
import type { WorkerCtx } from '@fir/hq';
import { describe, expect, it } from 'vitest';
import {
  fetchTransfers, parseTon, parseTrc20, sameTonAddress, tonFriendly, tonRaw, USDT_TON_MASTER, USDT_TRC20_CONTRACT, type ChainGet,
} from '../src/chain.js';
import { pageStatus, payKeyOk, publicInvoice } from '../src/page.js';
import { BillingStore, newPayKey, type Invoice } from '../src/store.js';
import { parseTolerance, PaymentWatcher } from '../src/watch.js';
import { BillingWorker, KIND_INVOICE } from '../src/worker.js';

const NOW = Date.UTC(2026, 10, 18, 4, 30); // Wed 09:30 Tashkent
const MIN = 60_000;
const DAY = 86_400_000;
const TRON = 'TQrY8tryqsYVCYS3MFbtffiPp2ccyn4STm';
const TON_RAW = `0:${'ab'.repeat(32)}`;
const TON = tonFriendly(TON_RAW, false)!; // UQ… as the owner pastes it
const USDT_TON_RAW = '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe';

function setup(details: Record<string, string> = { usdt_trc20: TRON, usdt_ton: TON }) {
  const db = openDb(':memory:');
  const clock = { t: NOW };
  const staged: { kind: string; payload: Payload; summary: string }[] = [];
  const ctx: WorkerCtx = {
    llm: { enabled: false, complete: () => Promise.reject(new Error('no llm')) }, db, tz: 'Asia/Tashkent', now: () => clock.t,
    requestApproval: (kind, payload, summary) => Promise.resolve(staged.push({ kind, payload, summary }) - 1),
    log: () => undefined,
  };
  const worker = new BillingWorker({ paymentDetails: details });
  const specs = worker.kindSpecs(ctx, () => Promise.resolve());
  return { db, ctx, clock, staged, worker, specs, store: worker.store(ctx) };
}
type R = ReturnType<typeof setup>;

/** Creates an invoice and approves its text (draft -> issued) at the current clock. */
async function issue(r: R, a: { client?: string; amountUsd: number; method?: 'usdt_trc20' | 'usdt_ton' | 'wallet' | null; dueDate?: string; newProject?: boolean }): Promise<Invoice> {
  const inv = await r.worker.createInvoice(r.ctx, { client: a.client ?? 'Dilnoza Karimova', amountUsd: a.amountUsd, what: 'Сайт-визитка', method: a.method ?? null, dueDate: a.dueDate ?? null, newProject: a.newProject ?? false });
  const item = r.staged.find((s) => s.kind === KIND_INVOICE && s.payload.invoiceId === inv.id)!;
  await r.specs[KIND_INVOICE]!.execute(item.payload, 1);
  return r.store.invoice(inv.id)!;
}

const hex = (n: number): string => n.toString(16).padStart(64, '0');
function trc(o: Partial<{ id: string; value: string; to: string; contract: string; ts: number; type: string; decimals: number }>) {
  return {
    transaction_id: o.id ?? hex(1), token_info: { symbol: 'USDT', address: o.contract ?? USDT_TRC20_CONTRACT, decimals: o.decimals ?? 6, name: 'Tether USD' },
    block_timestamp: o.ts ?? NOW + MIN, from: 'TFromSomebodyElse1111111111111111', to: o.to ?? TRON, type: o.type ?? 'Transfer', value: o.value ?? '150000000',
  };
}
function tonT(o: Partial<{ hash: string; amount: string; dest: string; master: string; ts: number; aborted: boolean }>) {
  return {
    query_id: '0', source: `0:${'cd'.repeat(32)}`, destination: o.dest ?? TON_RAW.toUpperCase(), amount: o.amount ?? '150000000', source_wallet: `0:${'ef'.repeat(32)}`,
    jetton_master: o.master ?? USDT_TON_RAW.toUpperCase(), transaction_hash: o.hash ?? 'dGVzdGhhc2gxMjM0NTY3ODkwYWJjZGVmZ2hpams=', transaction_lt: '1',
    transaction_now: Math.floor((o.ts ?? NOW + MIN) / 1000), transaction_aborted: o.aborted ?? false,
  };
}

/** A fake indexer: answers per host, records every call (no network in tests). */
function fakeNet(answers: { trc?: () => { status: number; body: unknown } | 'down'; ton?: () => { status: number; body: unknown } | 'down' }) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const get: ChainGet = (url, headers) => {
    calls.push({ url, headers });
    const a = url.includes('trongrid') ? answers.trc?.() : answers.ton?.();
    if (!a || a === 'down') return Promise.resolve({ ok: false, status: 0, error: 'timeout' });
    return Promise.resolve({ ok: true, status: a.status, body: a.status >= 200 && a.status < 300 ? a.body : null });
  };
  return { calls, get };
}
const trcBody = (...data: unknown[]) => ({ status: 200, body: { success: true, data, meta: {} } });
const tonBody = (...jetton_transfers: unknown[]) => ({ status: 200, body: { jetton_transfers, address_book: {} } });

describe('pay key and link', () => {
  it('keys are 32 URL-safe random characters, unique, and checked in constant time against a hash', () => {
    const keys = new Set(Array.from({ length: 2000 }, () => newPayKey()));
    expect(keys.size).toBe(2000);
    for (const k of [...keys].slice(0, 50)) expect(k).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const k = newPayKey();
    expect(payKeyOk(k, k)).toBe(true);
    expect(payKeyOk(`${k}x`, k)).toBe(false);
    expect(payKeyOk('', k)).toBe(false);
    expect(payKeyOk(k.slice(0, 31), k)).toBe(false); // different lengths do not throw (both sides are hashed first)
    expect(payKeyOk('x'.repeat(32), null)).toBe(false); // the dummy key never opens anything
    expect(payKeyOk('short', 'short')).toBe(false); // a stored key must be a real one
  });

  it('every new invoice gets a key and a link in the client language (lead locale, else ru)', async () => {
    const r = setup();
    r.db.exec("CREATE TABLE li_leads (id INTEGER PRIMARY KEY, lang TEXT NOT NULL DEFAULT 'ru')");
    r.db.exec("INSERT INTO li_leads (id, lang) VALUES (7, 'en'), (8, 'ru')");
    const ru = await r.worker.createInvoice(r.ctx, { client: 'A', amountUsd: 10, what: 'x' });
    const en = await r.worker.createInvoice(r.ctx, { client: 'B', amountUsd: 20, what: 'y', link: { leadId: 7 } });
    expect(ru.payKey).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(r.worker.payUrl(ru)).toBe(`https://firtech.pro/ru/pay/FT-2026-001?k=${ru.payKey}`);
    expect(r.worker.payUrl(en)).toBe(`https://firtech.pro/en/pay/FT-2026-002?k=${en.payKey}`);
    const site = new BillingWorker({ siteUrl: 'https://staging.firtech.pro/', paymentDetails: { usdt_trc20: TRON } });
    expect(site.payUrl(ru)).toMatch(/^https:\/\/staging\.firtech\.pro\/ru\/pay\/FT-2026-001\?k=/);
  });

  it('the migration backfills keys of existing invoices once, keeps the told sum and counts issued rows as issued at creation', () => {
    const db = openDb(':memory:');
    db.exec(`CREATE TABLE bl_invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, number TEXT NOT NULL UNIQUE, year INTEGER NOT NULL, seq INTEGER NOT NULL, client TEXT NOT NULL,
      amount_usd REAL NOT NULL, what TEXT NOT NULL DEFAULT '', method TEXT, due_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', subscription_id INTEGER,
      new_project INTEGER NOT NULL DEFAULT 0, remind3 INTEGER NOT NULL DEFAULT 0, remind0 INTEGER NOT NULL DEFAULT 0, overdue_alerted INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, paid_at INTEGER, UNIQUE (year, seq))`);
    const ins = db.prepare("INSERT INTO bl_invoices (number, year, seq, client, amount_usd, due_date, status, created_at, paid_at) VALUES (?, 2026, ?, 'C', ?, '2026-11-30', ?, ?, ?)");
    ins.run('FT-2026-001', 1, 100, 'issued', NOW - DAY, null);
    ins.run('FT-2026-002', 2, 100, 'issued', NOW - 2 * DAY, null);
    ins.run('FT-2026-003', 3, 50, 'paid', NOW - 3 * DAY, NOW - DAY);
    ins.run('FT-2026-004', 4, 70, 'void', NOW - 3 * DAY, null);
    const s = new BillingStore(db, () => NOW);
    const [a, b, c, d] = [1, 2, 3, 4].map((id) => s.invoice(id)!);
    expect(a!.payKey).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(a!.payKey).not.toBe(b!.payKey);
    expect([a!.payAmountUsd, b!.payAmountUsd]).toEqual([100, 100]); // clients were already told $100: no cents added afterwards
    expect(a!.issuedAt).toBe(NOW - DAY);
    expect(c).toMatchObject({ paidVia: 'manual', issuedAt: NOW - 3 * DAY });
    expect(d!.payKey).toBeNull();
    const again = new BillingStore(db, () => NOW);
    expect(again.invoice(1)!.payKey).toBe(a!.payKey);
  });
});

describe('unique payable amount', () => {
  it('two open invoices never share a sum: the lowest free cents are added; the КП sum stays', async () => {
    const r = setup();
    const a = await issue(r, { amountUsd: 150 });
    const b = await issue(r, { amountUsd: 150 });
    const c = await r.worker.createInvoice(r.ctx, { client: 'C', amountUsd: 150, what: 'z' }); // a draft counts too
    expect([a.payAmountUsd, b.payAmountUsd, c.payAmountUsd]).toEqual([150, 150.01, 150.02]);
    expect([a.amountUsd, b.amountUsd, c.amountUsd]).toEqual([150, 150, 150]);
    const card = r.staged.find((s) => s.payload.invoiceId === b.id)!;
    expect(card.summary).toContain('Сумма к переводу: 150.01 USDT (к $150 добавлены центы');
    expect(String(card.payload.text)).toContain('Сумма: $150\nСумма к переводу: 150.01 USDT');
    expect(String(card.payload.text)).toContain('переведите ровно 150.01 USDT');
    // a paid invoice frees its sum
    r.worker.markPaid(r.ctx, a.number);
    expect((await r.worker.createInvoice(r.ctx, { client: 'D', amountUsd: 150, what: 'w' })).payAmountUsd).toBe(150);
    // a sum with its own cents: 149.99 and 150.00 are different sums
    expect((await r.worker.createInvoice(r.ctx, { client: 'E', amountUsd: 149.99, what: 'v' })).payAmountUsd).toBe(149.99);
  });

  it('refuses the 101st open invoice of one sum instead of repeating an amount', async () => {
    const r = setup();
    for (let i = 0; i < 100; i++) await r.worker.createInvoice(r.ctx, { client: `C${i}`, amountUsd: 10, what: 'x' });
    expect(r.store.invoices(['draft'], 200).map((i) => Math.round(i.payAmountUsd * 100)).sort((x, y) => x - y)).toEqual(Array.from({ length: 100 }, (_, i) => 1000 + i));
    await expect(r.worker.createInvoice(r.ctx, { client: 'X', amountUsd: 10, what: 'x' })).rejects.toThrow(/no free cents/);
  });

  it('a wallet-only invoice and an empty config keep the old payment lines; the raw USDT addresses never reach a chat text', async () => {
    const r = setup({ usdt_trc20: TRON, usdt_ton: TON, wallet: 'Payeer P1' });
    await issue(r, { amountUsd: 30, method: 'wallet' });
    const t = String(r.staged[0]!.payload.text);
    expect(t).toContain('Онлайн-кошелёк из сметы: Payeer P1');
    expect(t).not.toContain('/pay/');
    expect(r.staged[0]!.summary).not.toContain('Ссылка на оплату');
    await issue(r, { amountUsd: 40 });
    const both = String(r.staged[1]!.payload.text);
    expect(both).not.toContain(TRON);
    expect(both).not.toContain(TON);
    expect(both).toContain('/ru/pay/FT-2026-002?k=');
  });
});

describe('the public view', () => {
  const view = (r: R, inv: Invoice | undefined, key: string) =>
    publicInvoice(inv, key, { now: r.clock.t, tz: 'Asia/Tashkent', methods: (i) => r.worker.chainMethods(i), addresses: r.worker.chainAddresses() });

  it('has exactly the documented shape for an issued invoice', async () => {
    const r = setup();
    const inv = await issue(r, { amountUsd: 150, client: 'Dilnoza Karimova', dueDate: '2026-11-25' });
    const v = view(r, inv, inv.payKey!);
    expect(v).toEqual({
      number: 'FT-2026-001', title: 'Сайт-визитка', clientFirstName: 'Dilnoza', amountUsd: 150, payAmountUsd: 150, status: 'issued', dueDate: '2026-11-25',
      issuedAt: new Date(NOW).toISOString(), paidAt: null, paidVia: null, txId: null, locale: 'ru',
      methods: [
        { id: 'usdt_trc20', network: 'TRON (TRC20)', address: TRON, note: expect.stringContaining('Только USDT в сети TRON (TRC20). Другие монеты и сети не дойдут') },
        { id: 'usdt_ton', network: 'TON', address: TON, note: expect.stringContaining('Только USDT в сети TON. Другие монеты и сети не дойдут') },
      ],
    });
    expect(JSON.stringify(v)).not.toContain('Karimova'); // first name only
  });

  it('an unknown number, a wrong key and a draft give the same null; void, paid and expired carry no addresses', async () => {
    const r = setup();
    const inv = await issue(r, { amountUsd: 150, dueDate: '2026-11-25', method: 'usdt_ton' });
    expect(view(r, inv, inv.payKey!)!.methods.map((m) => m.id)).toEqual(['usdt_ton']); // the invoice's own method only
    expect(view(r, undefined, inv.payKey!)).toBeNull();
    expect(view(r, inv, 'x'.repeat(32))).toBeNull();
    expect(view(r, inv, '')).toBeNull();
    const draft = await r.worker.createInvoice(r.ctx, { client: 'Z', amountUsd: 5, what: 'q' });
    expect(view(r, draft, draft.payKey!)).toBeNull();
    r.store.setStatus(draft.id, 'void');
    expect(view(r, r.store.invoice(draft.id), draft.payKey!)).toMatchObject({ status: 'void', methods: [], paidVia: null });
    r.worker.markPaid(r.ctx, inv.number);
    expect(view(r, r.store.invoice(inv.id), inv.payKey!)).toMatchObject({ status: 'paid', paidVia: 'manual', txId: null, methods: [], paidAt: new Date(NOW).toISOString() });
  });

  it('an issued invoice expires on the page 14 days after the due date or 45 days after issue', async () => {
    const r = setup();
    const inv = await issue(r, { amountUsd: 150, dueDate: '2026-11-25' });
    r.clock.t = Date.UTC(2026, 11, 9, 12); // 09.12 = due + 14: still open
    expect(pageStatus(r.store.invoice(inv.id)!, r.clock.t, 'Asia/Tashkent')).toBe('issued');
    r.clock.t = Date.UTC(2026, 11, 10, 12); // 10.12
    expect(view(r, r.store.invoice(inv.id), inv.payKey!)).toMatchObject({ status: 'expired', methods: [] });
    const r2 = setup();
    const long = await issue(r2, { amountUsd: 150, dueDate: '2027-06-01' });
    r2.clock.t = NOW + 45 * DAY;
    expect(pageStatus(long, r2.clock.t, 'Asia/Tashkent')).toBe('issued');
    r2.clock.t = NOW + 45 * DAY + MIN;
    expect(pageStatus(long, r2.clock.t, 'Asia/Tashkent')).toBe('expired');
    expect(r2.worker.markPaid(r2.ctx, long.number)?.invoice.status).toBe('paid'); // the owner can still mark it by hand
  });
});

describe('TRC20 and TON parsing', () => {
  it('keeps only USDT to our address with a sane id, amount and time', () => {
    const body = { success: true, data: [
      trc({ id: hex(1) }), trc({ id: hex(2), contract: 'TFakeUsdtContract11111111111111111' }), trc({ id: hex(3), to: 'TSomeoneElse1111111111111111111111' }),
      trc({ id: 'nothex' }), trc({ id: hex(4), value: '-5' }), trc({ id: hex(5), value: '1.5' }), trc({ id: hex(6), decimals: 18 }), trc({ id: hex(7), type: 'Approval' }), 'junk',
    ] };
    expect(parseTrc20(body, TRON)).toEqual([{ method: 'usdt_trc20', txId: hex(1), amountMicro: 150_000_000n, txTime: NOW + MIN }]);
    expect(parseTrc20({ success: false, data: [] }, TRON)).toBeNull();
    expect(parseTrc20({ nope: 1 }, TRON)).toBeNull();
  });

  it('TON addresses compare in raw and user-friendly forms, with the CRC checked', () => {
    expect(tonRaw(USDT_TON_MASTER)).toBe(USDT_TON_RAW);
    expect(tonRaw('EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDt')).toBeNull(); // one character off: CRC fails
    expect(sameTonAddress(TON, TON_RAW.toUpperCase())).toBe(true);
    expect(sameTonAddress(tonFriendly(TON_RAW, true)!, TON)).toBe(true); // EQ and UQ of one account
    expect(sameTonAddress(TON, `0:${'ac'.repeat(32)}`)).toBe(false);
    expect(sameTonAddress('garbage', 'garbage')).toBe(false);
    const body = { jetton_transfers: [
      tonT({ hash: 'aGFzaDE=aGFzaDEaGFzaDE=' }), tonT({ hash: 'aGFzaDIaGFzaDIaGFzaDI=', master: `0:${'11'.repeat(32)}` }), tonT({ hash: 'aGFzaDMaGFzaDMaGFzaDM=', dest: `0:${'22'.repeat(32)}` }),
      tonT({ hash: 'aGFzaDQaGFzaDQaGFzaDQ=', aborted: true }), tonT({ hash: 'aGFzaDUaGFzaDUaGFzaDU=', master: USDT_TON_MASTER, dest: tonFriendly(TON_RAW, true)! }),
    ] };
    expect(parseTon(body, TON)?.map((t) => t.txId)).toEqual(['aGFzaDE=aGFzaDEaGFzaDE=', 'aGFzaDUaGFzaDUaGFzaDU=']);
    expect(parseTon({ data: [] }, TON)).toBeNull();
  });

  it('asks the documented URLs with the optional key headers; 429 and 5xx are retryable', async () => {
    const net = fakeNet({ trc: () => trcBody(), ton: () => ({ status: 429, body: null }) });
    expect(await fetchTransfers(net.get, 'usdt_trc20', TRON, NOW, 'k1')).toEqual({ ok: true, transfers: [] });
    expect(await fetchTransfers(net.get, 'usdt_ton', TON, NOW + 999, 'k2')).toEqual({ ok: false, retryable: true, reason: 'http 429' });
    expect(net.calls[0]!.url).toBe(`https://api.trongrid.io/v1/accounts/${TRON}/transactions/trc20?only_to=true&only_confirmed=true&limit=50&contract_address=${USDT_TRC20_CONTRACT}&min_timestamp=${NOW}`);
    expect(net.calls[0]!.headers).toEqual({ 'TRON-PRO-API-KEY': 'k1' });
    const u = new URL(net.calls[1]!.url);
    expect(`${u.origin}${u.pathname}`).toBe('https://toncenter.com/api/v3/jetton/transfers');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ owner_address: TON, jetton_address: USDT_TON_MASTER, direction: 'in', limit: '50', start_utime: String(Math.floor((NOW + 999) / 1000)) });
    expect(net.calls[1]!.headers).toEqual({ 'X-API-Key': 'k2' });
    expect((await fetchTransfers(net.get, 'usdt_trc20', TRON, NOW)).ok).toBe(true);
    expect(net.calls[2]!.headers).toEqual({});
  });
});

describe('the watcher', () => {
  const watcher = (r: R, net: ReturnType<typeof fakeNet>, tolerancePct = 0) => new PaymentWatcher({ addresses: r.worker.chainAddresses(), get: net.get, tolerancePct });

  it('TRC20: an exact transfer after the issue pays the invoice once, with the tx; nothing is double-marked on the next cycles', async () => {
    const r = setup();
    const inv = await issue(r, { amountUsd: 150 });
    const other = await issue(r, { amountUsd: 150 }); // 150.01
    r.clock.t += 5 * MIN;
    const net = fakeNet({ trc: () => trcBody(trc({ id: hex(9), value: '150010000', ts: NOW + 2 * MIN })), ton: () => tonBody() });
    const w = watcher(r, net);
    const res = await w.cycle(r.store, r.clock.t);
    expect(res.matched.map((m) => m.invoice.number)).toEqual([other.number]);
    expect(r.store.invoice(other.id)).toMatchObject({ status: 'paid', paidVia: 'usdt_trc20', txId: hex(9) });
    expect(r.store.invoice(inv.id)!.status).toBe('issued');
    expect(res.alerts).toEqual([]);
    expect(net.calls).toHaveLength(2); // one request per method
    const again = await w.cycle(r.store, r.clock.t + 2 * MIN);
    expect(again).toMatchObject({ matched: [], alerts: [] });
    expect(r.store.payment(hex(9))).toMatchObject({ invoiceId: other.id, method: 'usdt_trc20', amountUsd: 150.01 });
  });

  it('TRC20: wrong contract, wrong recipient, before the issue, a different sum: nothing is paid; unknown transfers are reported once', async () => {
    const r = setup();
    r.clock.t = NOW;
    const inv = await issue(r, { amountUsd: 150 });
    const net = fakeNet({
      trc: () => trcBody(
        trc({ id: hex(1), contract: 'TFakeUsdtContract11111111111111111' }),
        trc({ id: hex(2), to: 'TSomeoneElse1111111111111111111111' }),
        trc({ id: hex(3), ts: NOW - MIN }), // paid before the invoice was issued
        trc({ id: hex(4), value: '149990000' }), // one cent short
        trc({ id: hex(5), value: '150004999' }), // rounds to 150.00: exact after rounding to cents
      ),
    });
    const w = watcher(r, net);
    r.clock.t = NOW + 3 * MIN;
    let res = await w.cycle(r.store, r.clock.t);
    expect(res.matched.map((m) => m.transfer.txId)).toEqual([hex(5)]);
    expect(r.store.invoice(inv.id)!.txId).toBe(hex(5));
    // tx 3 is older than every open invoice: the provider filter normally drops it; it is ignored, not reported
    expect(res.alerts).toHaveLength(1);
    expect(res.alerts[0]).toContain(`Пришёл перевод 149.99 USDT (TRC20), tx ${hex(4)}`);
    const inv2 = await issue(r, { amountUsd: 149.99 }); // issued after tx 4: tx 4 stays unmatched forever
    res = await w.cycle(r.store, r.clock.t + 2 * MIN);
    expect(res).toMatchObject({ matched: [], alerts: [] });
    expect(r.store.invoice(inv2.id)!.status).toBe('issued');
  });

  it('a duplicate tx in one answer pays only once; one tx never pays two invoices; the oldest invoice wins a tie', async () => {
    const r = setup();
    const a = await issue(r, { amountUsd: 80 });
    // a legacy duplicate (two invoices told the same sum before the pay page): force the tie
    const b = await issue(r, { amountUsd: 90 });
    r.db.prepare('UPDATE bl_invoices SET pay_amount_usd = 80 WHERE id = ?').run(b.id);
    const net = fakeNet({ trc: () => trcBody(trc({ id: hex(7), value: '80000000' }), trc({ id: hex(7), value: '80000000' })) });
    const res = await watcher(r, net).cycle(r.store, NOW + 5 * MIN);
    expect(res.matched.map((m) => m.invoice.id)).toEqual([a.id]);
    expect(r.store.invoice(b.id)!.status).toBe('issued');
    // a second transfer of the same sum then pays the other one
    const net2 = fakeNet({ trc: () => trcBody(trc({ id: hex(7), value: '80000000' }), trc({ id: hex(8), value: '80000000', ts: NOW + 3 * MIN })) });
    expect((await watcher(r, net2).cycle(r.store, NOW + 7 * MIN)).matched.map((m) => m.invoice.id)).toEqual([b.id]);
  });

  it('an invoice paid by hand is never marked again by a later transfer; the transfer is reported for the owner', async () => {
    const r = setup();
    const inv = await issue(r, { amountUsd: 150 });
    expect(r.worker.markPaid(r.ctx, inv.number)?.invoice).toMatchObject({ status: 'paid', paidVia: 'manual' });
    const other = await issue(r, { amountUsd: 60 }); // keeps the watcher polling
    const net = fakeNet({ trc: () => trcBody(trc({ id: hex(3), value: '150000000' })) });
    const res = await watcher(r, net).cycle(r.store, NOW + 5 * MIN);
    expect(res.matched).toEqual([]);
    expect(res.alerts[0]).toContain('ни один открытый счёт не совпал');
    expect(r.store.invoice(inv.id)).toMatchObject({ paidVia: 'manual', txId: null });
    expect(r.store.invoice(other.id)!.status).toBe('issued');
    expect(r.store.recordChainPayment(inv.id, { txId: hex(4), method: 'usdt_trc20', amountMicro: 150_000_000n, txTime: NOW })).toBe(false);
  });

  it('TON: matches by the raw destination and jetton master; a TON-only invoice ignores TRC20 transfers', async () => {
    const r = setup();
    const ton = await issue(r, { amountUsd: 99, method: 'usdt_ton' });
    const net = fakeNet({ trc: () => trcBody(trc({ id: hex(1), value: '99000000' })), ton: () => tonBody(tonT({ hash: 'dG9uaGFzaDAwMDAwMDAwMDAwMA==', amount: '99000000' })) });
    const res = await watcher(r, net).cycle(r.store, NOW + 5 * MIN);
    expect(net.calls.map((c) => new URL(c.url).hostname)).toEqual(['toncenter.com']); // nobody waits for TRC20
    expect(res.matched.map((m) => m.invoice.id)).toEqual([ton.id]);
    expect(r.store.invoice(ton.id)).toMatchObject({ status: 'paid', paidVia: 'usdt_ton', txId: 'dG9uaGFzaDAwMDAwMDAwMDAwMA==' });
  });

  it('PAY_TOLERANCE: off by default; when set, a short payment within it counts only if exactly one invoice fits', async () => {
    expect(parseTolerance(undefined)).toBe(0);
    expect(parseTolerance('0.5%')).toBe(0.5);
    expect(() => parseTolerance('1')).toThrow(/PAY_TOLERANCE/);
    expect(() => parseTolerance('abc')).toThrow(/PAY_TOLERANCE/);
    const r = setup();
    const inv = await issue(r, { amountUsd: 200 });
    const short = () => trcBody(trc({ id: hex(1), value: '199000000' })); // 0.5% short
    expect((await watcher(r, fakeNet({ trc: short })).cycle(r.store, NOW + MIN * 5)).matched).toEqual([]);
    const r2 = setup();
    const inv2 = await issue(r2, { amountUsd: 200 });
    expect((await watcher(r2, fakeNet({ trc: short }), 0.5).cycle(r2.store, NOW + MIN * 5)).matched.map((m) => m.invoice.id)).toEqual([inv2.id]);
    const r3 = setup();
    await issue(r3, { amountUsd: 200 });
    await issue(r3, { amountUsd: 199.5 }); // both within 0.5%: ambiguous, nothing is marked
    const res = await watcher(r3, fakeNet({ trc: short }), 0.5).cycle(r3.store, NOW + MIN * 5);
    expect(res.matched).toEqual([]);
    expect(res.alerts).toHaveLength(1);
    expect(r.store.invoice(inv.id)!.status).toBe('issued');
  });

  it('a provider down: exponential backoff, one alert after 30 minutes, one recovery line; the other network keeps working', async () => {
    const r = setup();
    await issue(r, { amountUsd: 10 });
    const state = { trc: 'down' as 'down' | 'up' };
    const net = fakeNet({ trc: () => (state.trc === 'down' ? 'down' : trcBody()), ton: () => tonBody() });
    const w = watcher(r, net);
    const alerts: string[] = [];
    const trcCalls = () => net.calls.filter((c) => c.url.includes('trongrid')).length;
    for (let m = 2; m <= 40; m += 2) alerts.push(...(await w.cycle(r.store, NOW + m * MIN)).alerts);
    expect(trcCalls()).toBeLessThan(8); // 2, 4, 8, 16 minute gaps instead of every 2 minutes
    expect(net.calls.filter((c) => c.url.includes('toncenter')).length).toBe(20);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('TronGrid (USDT TRC20) не отвечает больше 30 минут');
    state.trc = 'up';
    for (let m = 42; m <= 80; m += 2) alerts.push(...(await w.cycle(r.store, NOW + m * MIN)).alerts);
    expect(alerts).toHaveLength(2);
    expect(alerts[1]).toContain('снова отвечает');
  });

  it('nothing is asked without open invoices or without addresses', async () => {
    const r = setup();
    const net = fakeNet({ trc: () => trcBody(), ton: () => tonBody() });
    expect((await watcher(r, net).cycle(r.store, NOW)).polled).toEqual([]);
    await r.worker.createInvoice(r.ctx, { client: 'D', amountUsd: 5, what: 'x' }); // a draft is not watched
    expect((await watcher(r, net).cycle(r.store, NOW)).polled).toEqual([]);
    const inv = await issue(r, { amountUsd: 6 });
    r.clock.t = NOW + 46 * DAY; // older than 45 days: not watched any more
    expect((await watcher(r, net).cycle(r.store, r.clock.t)).polled).toEqual([]);
    expect(new PaymentWatcher({ addresses: {}, get: net.get }).enabled).toBe(false);
    expect(net.calls).toHaveLength(0);
    expect(inv.status).toBe('issued');
  });
});
