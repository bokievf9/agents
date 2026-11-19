import { randomBytes } from 'node:crypto';
import { migrate, type Db } from '@fir/core';

/**
 * The studio's payment methods (owner decision 2026-11-19): USDT on TRC20 or TON, or the online wallet named in the
 * estimate. Kaspi, Payme, Click and cards are not accepted: `parseMethod` refuses them and old rows read as «any method».
 */
export type PayMethod = 'usdt_trc20' | 'usdt_ton' | 'wallet';
export const PAY_METHODS: PayMethod[] = ['usdt_trc20', 'usdt_ton', 'wallet'];
export const METHOD_LABEL: Record<PayMethod, string> = { usdt_trc20: 'USDT (сеть TRC20)', usdt_ton: 'USDT (сеть TON)', wallet: 'Онлайн-кошелёк из сметы' };

/** "usdt_trc20", "trc20", "ton", "кошелёк" and so on to the key; a bare "usdt" means TRC20; null when unknown or not accepted. */
export function parseMethod(s: string): PayMethod | null {
  const t = s.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (/^(usdt_?trc20|trc20|usdt_?tron|tron|usdt|юсдт)$/.test(t)) return 'usdt_trc20';
  if (/^(usdt_?ton|ton|тон|юсдт_?тон)$/.test(t)) return 'usdt_ton';
  if (/^(wallet|кошелёк|кошелек|онлайн_?кошелёк|онлайн_?кошелек)$/.test(t)) return 'wallet';
  return null;
}

/** A method read from the database: rows made before 2026-11-19 may hold a method that is no longer accepted. */
const storedMethod = (m: string | null): PayMethod | null => (m && (PAY_METHODS as string[]).includes(m) ? (m as PayMethod) : null);

export type Period = 'month' | 'year';
export type InvoiceStatus = 'draft' | 'issued' | 'paid' | 'void';
/** How an invoice got paid: found on-chain by the watcher, or marked by the owner with `/paid`. */
export type PaidVia = 'usdt_trc20' | 'usdt_ton' | 'manual';
export type ChainMethod = 'usdt_trc20' | 'usdt_ton';
export type Locale = 'ru' | 'en';

/** The pay page key: 24 random bytes as base64url, 32 URL-safe characters (192 bits). It is the only thing that protects the page. */
export const newPayKey = (): string => randomBytes(24).toString('base64url');
/** Whole cents of a USD amount (no float drift: 150.07 -> 15007). */
export const toCents = (usd: number): number => Math.round(usd * 100);

export interface Subscription {
  id: number;
  client: string;
  plan: string;
  amountUsd: number;
  period: Period;
  /** `YYYY-MM-DD` of the next payment. */
  nextDue: string;
  method: PayMethod | null;
  active: boolean;
}

export interface Invoice {
  id: number;
  /** `FT-2026-001`. */
  number: string;
  client: string;
  amountUsd: number;
  what: string;
  method: PayMethod | null;
  dueDate: string;
  status: InvoiceStatus;
  subscriptionId: number | null;
  /** Payment of this invoice starts onboarding (a new project). */
  newProject: boolean;
  remind3: boolean;
  remind0: boolean;
  overdueAlerted: boolean;
  createdAt: number;
  paidAt: number | null;
  /** The sales chain this invoice belongs to (КП → договор → счёт 50% → проект): the lead, the presales pack, the reserved project, the estimate total in USD. */
  leadId: number | null;
  packId: number | null;
  projectId: number | null;
  totalUsd: number | null;
  /** The pay page key (`/pay/<number>?k=<key>`), made with the invoice; null only for void rows made before 2026-11-19. */
  payKey: string | null;
  /** What the client transfers: `amountUsd` plus unique cents while another open invoice has the same sum (the КП sum stays `amountUsd`). */
  payAmountUsd: number;
  /** When the owner approved the text (draft -> issued); the on-chain watcher only counts transfers after it. */
  issuedAt: number | null;
  paidVia: PaidVia | null;
  txId: string | null;
  /** The client's language (the lead's, else ru): the pay link and the page follow it. */
  locale: Locale;
  /** The last time the owner reminded the client from the workplace («Пульт v3»); null: never. */
  remindedAt: number | null;
}

/** An incoming USDT transfer the watcher has seen: matched to an invoice, or kept unmatched (so it is reported once and never reused). */
export interface Payment {
  id: number;
  txId: string;
  method: ChainMethod;
  amountUsd: number;
  invoiceId: number | null;
  txTime: number;
  seenAt: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bl_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT '',
  amount_usd REAL NOT NULL,
  period TEXT NOT NULL DEFAULT 'month',
  next_due TEXT NOT NULL,
  method TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS bl_invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  year INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  client TEXT NOT NULL,
  amount_usd REAL NOT NULL,
  what TEXT NOT NULL DEFAULT '',
  method TEXT,
  due_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  subscription_id INTEGER,
  new_project INTEGER NOT NULL DEFAULT 0,
  remind3 INTEGER NOT NULL DEFAULT 0,
  remind0 INTEGER NOT NULL DEFAULT 0,
  overdue_alerted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  paid_at INTEGER,
  UNIQUE (year, seq)
);
CREATE INDEX IF NOT EXISTS bl_invoices_status ON bl_invoices (status);
CREATE TABLE IF NOT EXISTS bl_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tx_id TEXT NOT NULL UNIQUE,
  method TEXT NOT NULL,
  amount_usd REAL NOT NULL,
  amount_micro TEXT NOT NULL,
  invoice_id INTEGER,
  tx_time INTEGER NOT NULL,
  seen_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS bl_payments_invoice ON bl_payments (invoice_id) WHERE invoice_id IS NOT NULL;
`;

interface SubRow { id: number; client: string; plan: string; amount_usd: number; period: string; next_due: string; method: string | null; active: number }
interface InvRow {
  id: number; number: string; client: string; amount_usd: number; what: string; method: string | null; due_date: string; status: string;
  subscription_id: number | null; new_project: number; remind3: number; remind0: number; overdue_alerted: number; created_at: number; paid_at: number | null;
  lead_id: number | null; pack_id: number | null; project_id: number | null; total_usd: number | null;
  pay_key: string | null; pay_amount_usd: number | null; issued_at: number | null; paid_via: string | null; tx_id: string | null; locale: string | null;
  reminded_at: number | null;
}
interface PayRow { id: number; tx_id: string; method: string; amount_usd: number; invoice_id: number | null; tx_time: number; seen_at: number }

const toSub = (r: SubRow): Subscription => ({
  id: r.id, client: r.client, plan: r.plan, amountUsd: r.amount_usd, period: r.period as Period, nextDue: r.next_due, method: storedMethod(r.method), active: r.active === 1,
});
const toInv = (r: InvRow): Invoice => ({
  id: r.id, number: r.number, client: r.client, amountUsd: r.amount_usd, what: r.what, method: storedMethod(r.method), dueDate: r.due_date,
  status: r.status as InvoiceStatus, subscriptionId: r.subscription_id, newProject: r.new_project === 1, remind3: r.remind3 === 1, remind0: r.remind0 === 1,
  overdueAlerted: r.overdue_alerted === 1, createdAt: r.created_at, paidAt: r.paid_at,
  leadId: r.lead_id, packId: r.pack_id, projectId: r.project_id, totalUsd: r.total_usd,
  payKey: r.pay_key, payAmountUsd: r.pay_amount_usd ?? r.amount_usd, issuedAt: r.issued_at,
  paidVia: r.paid_via === 'usdt_trc20' || r.paid_via === 'usdt_ton' || r.paid_via === 'manual' ? r.paid_via : null, txId: r.tx_id, locale: r.locale === 'en' ? 'en' : 'ru', remindedAt: r.reminded_at ?? null,
});
const toPay = (r: PayRow): Payment => ({ id: r.id, txId: r.tx_id, method: r.method as ChainMethod, amountUsd: r.amount_usd, invoiceId: r.invoice_id, txTime: r.tx_time, seenAt: r.seen_at });

export interface NewInvoice {
  client: string;
  amountUsd: number;
  what: string;
  method: PayMethod | null;
  dueDate: string;
  subscriptionId?: number | null;
  newProject?: boolean;
  /** The sales chain link (see `Invoice.leadId`). */
  leadId?: number | null;
  packId?: number | null;
  projectId?: number | null;
  totalUsd?: number | null;
  locale?: Locale;
}

/** The highest number of cents added to make a pay amount unique (0.01 ... 0.99). */
export const MAX_UNIQUE_CENTS = 99;

export class BillingStore {
  constructor(private readonly db: Db, private readonly now: () => number = Date.now, private readonly prefix = 'FT') {
    migrate(db, SCHEMA);
    // added later: the sales chain an invoice belongs to
    const cols = db.prepare('PRAGMA table_info(bl_invoices)').all() as { name: string }[];
    for (const c of ['lead_id', 'pack_id', 'project_id']) if (!cols.some((x) => x.name === c)) db.exec(`ALTER TABLE bl_invoices ADD COLUMN ${c} INTEGER`);
    if (!cols.some((x) => x.name === 'total_usd')) db.exec('ALTER TABLE bl_invoices ADD COLUMN total_usd REAL');
    // added 2026-11-19: the pay page and the on-chain watcher
    for (const [c, t] of [['pay_key', 'TEXT'], ['pay_amount_usd', 'REAL'], ['issued_at', 'INTEGER'], ['paid_via', 'TEXT'], ['tx_id', 'TEXT'], ['locale', "TEXT NOT NULL DEFAULT 'ru'"]] as const) {
      if (!cols.some((x) => x.name === c)) db.exec(`ALTER TABLE bl_invoices ADD COLUMN ${c} ${t}`);
    }
    if (!cols.some((x) => x.name === 'reminded_at')) db.exec('ALTER TABLE bl_invoices ADD COLUMN reminded_at INTEGER');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS bl_invoices_pay_key ON bl_invoices (pay_key) WHERE pay_key IS NOT NULL');
    this.backfill();
  }

  /**
   * Rows made before the pay page: every open or paid invoice gets a key; the pay amount stays the sum the client was already told
   * (no cents added afterwards), an issued row counts as issued at its creation. Idempotent.
   */
  private backfill(): void {
    this.db.transaction(() => {
      const rows = this.db.prepare("SELECT id FROM bl_invoices WHERE pay_key IS NULL AND status != 'void'").all() as { id: number }[];
      for (const r of rows) this.db.prepare('UPDATE bl_invoices SET pay_key = ? WHERE id = ?').run(newPayKey(), r.id);
      this.db.prepare('UPDATE bl_invoices SET pay_amount_usd = amount_usd WHERE pay_amount_usd IS NULL').run();
      this.db.prepare("UPDATE bl_invoices SET issued_at = created_at WHERE issued_at IS NULL AND status IN ('issued', 'paid')").run();
      this.db.prepare("UPDATE bl_invoices SET paid_via = 'manual' WHERE paid_via IS NULL AND status = 'paid'").run();
    })();
  }

  /**
   * The amount the client transfers: `amountUsd` when no other open (draft or issued) invoice asks for it, else plus the lowest free
   * 0.01 ... 0.99. Null when all 99 are taken (the caller refuses to make the invoice: never two open invoices with one sum).
   */
  uniquePayAmount(amountUsd: number, exceptId = 0): number | null {
    const taken = new Set((this.db.prepare("SELECT pay_amount_usd p FROM bl_invoices WHERE status IN ('draft', 'issued') AND id != ? AND pay_amount_usd IS NOT NULL").all(exceptId) as { p: number }[]).map((r) => toCents(r.p)));
    const base = toCents(amountUsd);
    for (let add = 0; add <= MAX_UNIQUE_CENTS; add++) if (!taken.has(base + add)) return (base + add) / 100;
    return null;
  }

  addSubscription(s: { client: string; plan: string; amountUsd: number; period: Period; nextDue: string; method: PayMethod | null }): Subscription {
    const r = this.db
      .prepare('INSERT INTO bl_subscriptions (client, plan, amount_usd, period, next_due, method, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(s.client, s.plan, s.amountUsd, s.period, s.nextDue, s.method, this.now());
    return this.subscription(Number(r.lastInsertRowid))!;
  }

  subscription(id: number): Subscription | undefined {
    const r = this.db.prepare('SELECT * FROM bl_subscriptions WHERE id = ?').get(id) as SubRow | undefined;
    return r ? toSub(r) : undefined;
  }

  subscriptions(): Subscription[] {
    return (this.db.prepare('SELECT * FROM bl_subscriptions WHERE active = 1 ORDER BY next_due, id').all() as SubRow[]).map(toSub);
  }

  setNextDue(id: number, nextDue: string): void {
    this.db.prepare('UPDATE bl_subscriptions SET next_due = ? WHERE id = ?').run(nextDue, id);
  }

  /** Next number of the year: `FT-2026-001`. The year is the local one of `yearOf`. */
  addInvoice(i: NewInvoice, year: number): Invoice {
    const seq = ((this.db.prepare('SELECT COALESCE(MAX(seq), 0) m FROM bl_invoices WHERE year = ?').get(year) as { m: number }).m) + 1;
    const number = `${this.prefix}-${year}-${String(seq).padStart(3, '0')}`;
    const id = this.db.transaction(() => {
      const pay = this.uniquePayAmount(i.amountUsd);
      if (pay === null) throw new Error(`no free cents for $${i.amountUsd}: ${MAX_UNIQUE_CENTS + 1} open invoices ask for this sum`);
      const r = this.db
        .prepare(
          `INSERT INTO bl_invoices (number, year, seq, client, amount_usd, what, method, due_date, subscription_id, new_project, created_at, lead_id, pack_id, project_id, total_usd, pay_key, pay_amount_usd, locale)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(number, year, seq, i.client, i.amountUsd, i.what, i.method, i.dueDate, i.subscriptionId ?? null, i.newProject ? 1 : 0, this.now(), i.leadId ?? null, i.packId ?? null, i.projectId ?? null, i.totalUsd ?? null, newPayKey(), pay, i.locale ?? 'ru');
      return Number(r.lastInsertRowid);
    })();
    return this.invoice(id)!;
  }

  /** Exact number lookup (`FT-2026-001`, case as stored), for the public pay page. */
  byNumber(number: string): Invoice | undefined {
    const r = this.db.prepare('SELECT * FROM bl_invoices WHERE number = ?').get(number) as InvRow | undefined;
    return r ? toInv(r) : undefined;
  }

  /** The lead's language when the lead table exists and knows it; else ru. */
  leadLocale(leadId: number | null | undefined): Locale {
    if (!leadId) return 'ru';
    try {
      const r = this.db.prepare('SELECT lang FROM li_leads WHERE id = ?').get(leadId) as { lang: string } | undefined;
      return r?.lang === 'en' ? 'en' : 'ru';
    } catch {
      return 'ru';
    }
  }

  /** Issued invoices issued at or after `since` (the watcher's window), oldest first. */
  openForWatch(since: number): Invoice[] {
    return (this.db.prepare("SELECT * FROM bl_invoices WHERE status = 'issued' AND issued_at IS NOT NULL AND issued_at >= ? ORDER BY issued_at, id").all(since) as InvRow[]).map(toInv);
  }

  payment(txId: string): Payment | undefined {
    const r = this.db.prepare('SELECT * FROM bl_payments WHERE tx_id = ?').get(txId) as PayRow | undefined;
    return r ? toPay(r) : undefined;
  }

  /** An incoming transfer that matched no invoice: kept so it is reported once and can never be matched later. False when already known. */
  recordUnmatched(p: { txId: string; method: ChainMethod; amountMicro: bigint; txTime: number }): boolean {
    const r = this.db
      .prepare('INSERT OR IGNORE INTO bl_payments (tx_id, method, amount_usd, amount_micro, invoice_id, tx_time, seen_at) VALUES (?, ?, ?, ?, NULL, ?, ?)')
      .run(p.txId, p.method, Number(p.amountMicro) / 1e6, p.amountMicro.toString(), p.txTime, this.now());
    return r.changes === 1;
  }

  /**
   * The on-chain payment of an issued invoice, atomically: the transfer is recorded (its tx id is unique, an invoice has at most one)
   * and the invoice becomes paid only if it is still `issued`. Returns false and changes nothing when the tx is already used, the
   * invoice already has a payment, or the invoice is no longer issued (paid by hand, void).
   */
  recordChainPayment(invoiceId: number, p: { txId: string; method: ChainMethod; amountMicro: bigint; txTime: number }): boolean {
    return this.db.transaction(() => {
      const inv = this.invoice(invoiceId);
      if (!inv || inv.status !== 'issued' || this.payment(p.txId)) return false;
      if (this.db.prepare('SELECT 1 FROM bl_payments WHERE invoice_id = ?').get(invoiceId)) return false;
      this.db
        .prepare('INSERT INTO bl_payments (tx_id, method, amount_usd, amount_micro, invoice_id, tx_time, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(p.txId, p.method, Number(p.amountMicro) / 1e6, p.amountMicro.toString(), invoiceId, p.txTime, this.now());
      const u = this.db.prepare("UPDATE bl_invoices SET status = 'paid', paid_at = ?, paid_via = ?, tx_id = ? WHERE id = ? AND status = 'issued'").run(this.now(), p.method, p.txId, invoiceId);
      if (u.changes !== 1) throw new Error('invoice changed under the payment'); // rolls the payment row back
      return true;
    })();
  }

  /** The owner's `/paid`: paid by hand. */
  markManualPaid(id: number): void {
    this.db.prepare("UPDATE bl_invoices SET status = 'paid', paid_at = ?, paid_via = 'manual' WHERE id = ? AND status != 'paid'").run(this.now(), id);
  }

  /** Recently paid invoices, newest first (the owner's list shows how each was paid). */
  recentPaid(limit = 5): Invoice[] {
    return (this.db.prepare("SELECT * FROM bl_invoices WHERE status = 'paid' ORDER BY paid_at DESC, id DESC LIMIT ?").all(limit) as InvRow[]).map(toInv);
  }

  invoice(id: number): Invoice | undefined {
    const r = this.db.prepare('SELECT * FROM bl_invoices WHERE id = ?').get(id) as InvRow | undefined;
    return r ? toInv(r) : undefined;
  }

  /** `FT-2026-001` (any case), `2026-001`, or a bare sequence number of `year` (`1`, `001`). */
  byRef(ref: string, year: number): Invoice | undefined {
    const t = ref.trim().toUpperCase().replace(/^#/, '');
    let r: InvRow | undefined;
    if (/^\d+$/.test(t)) r = this.db.prepare('SELECT * FROM bl_invoices WHERE year = ? AND seq = ?').get(year, Number(t)) as InvRow | undefined;
    else {
      const m = /^(?:[A-Z]+-)?(\d{4})-(\d+)$/.exec(t);
      if (m) r = this.db.prepare('SELECT * FROM bl_invoices WHERE year = ? AND seq = ?').get(Number(m[1]), Number(m[2])) as InvRow | undefined;
    }
    return r ? toInv(r) : undefined;
  }

  invoices(status?: InvoiceStatus[], limit = 30): Invoice[] {
    const where = status?.length ? `WHERE status IN (${status.map(() => '?').join(',')})` : '';
    return (this.db.prepare(`SELECT * FROM bl_invoices ${where} ORDER BY id DESC LIMIT ?`).all(...(status ?? []), limit) as InvRow[]).map(toInv);
  }

  /** How many invoices of this lead are paid (the first one starts the project and the referral payout). */
  paidCountForLead(leadId: number): number {
    return (this.db.prepare("SELECT COUNT(*) c FROM bl_invoices WHERE lead_id = ? AND status = 'paid'").get(leadId) as { c: number }).c;
  }

  /** A live (not void) invoice of this subscription for this due date already exists. */
  hasInvoiceFor(subscriptionId: number, dueDate: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM bl_invoices WHERE subscription_id = ? AND due_date = ? AND status != 'void'").get(subscriptionId, dueDate));
  }

  setStatus(id: number, status: InvoiceStatus): void {
    this.db.prepare('UPDATE bl_invoices SET status = ?, paid_at = ? WHERE id = ?').run(status, status === 'paid' ? this.now() : null, id);
    if (status === 'issued') this.db.prepare('UPDATE bl_invoices SET issued_at = COALESCE(issued_at, ?) WHERE id = ?').run(this.now(), id);
    if (status === 'paid') this.db.prepare("UPDATE bl_invoices SET paid_via = COALESCE(paid_via, 'manual') WHERE id = ?").run(id);
  }

  /** The owner reminded the client from the workplace. */
  markReminded(id: number): void {
    this.db.prepare('UPDATE bl_invoices SET reminded_at = ? WHERE id = ?').run(this.now(), id);
  }

  setFlag(id: number, flag: 'remind3' | 'remind0' | 'overdue_alerted'): void {
    this.db.prepare(`UPDATE bl_invoices SET ${flag} = 1 WHERE id = ?`).run(id);
  }

  /** Paid revenue in USD for payments in [from, to). */
  revenue(from: number, to: number): number {
    return (this.db.prepare("SELECT COALESCE(SUM(amount_usd), 0) s FROM bl_invoices WHERE status = 'paid' AND paid_at >= ? AND paid_at < ?").get(from, to) as { s: number }).s;
  }
}
