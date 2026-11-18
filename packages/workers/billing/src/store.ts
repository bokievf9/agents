import { migrate, type Db } from '@fir/core';

export type PayMethod = 'kaspi' | 'payme' | 'click' | 'card' | 'usdt';
export const METHOD_LABEL: Record<PayMethod, string> = { kaspi: 'Kaspi', payme: 'Payme', click: 'Click', card: 'Карта', usdt: 'USDT' };

/** "Kaspi", "карта", "usdt" and so on to the key; null when unknown. */
export function parseMethod(s: string): PayMethod | null {
  const t = s.trim().toLowerCase();
  if (/^(kaspi|каспи)$/.test(t)) return 'kaspi';
  if (/^(payme|пейми|пайме)$/.test(t)) return 'payme';
  if (/^(click|клик)$/.test(t)) return 'click';
  if (/^(card|карта|картой)$/.test(t)) return 'card';
  if (/^(usdt|юсдт)$/.test(t)) return 'usdt';
  return null;
}

export type Period = 'month' | 'year';
export type InvoiceStatus = 'draft' | 'issued' | 'paid' | 'void';

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
`;

interface SubRow { id: number; client: string; plan: string; amount_usd: number; period: string; next_due: string; method: string | null; active: number }
interface InvRow {
  id: number; number: string; client: string; amount_usd: number; what: string; method: string | null; due_date: string; status: string;
  subscription_id: number | null; new_project: number; remind3: number; remind0: number; overdue_alerted: number; created_at: number; paid_at: number | null;
}

const toSub = (r: SubRow): Subscription => ({
  id: r.id, client: r.client, plan: r.plan, amountUsd: r.amount_usd, period: r.period as Period, nextDue: r.next_due, method: r.method as PayMethod | null, active: r.active === 1,
});
const toInv = (r: InvRow): Invoice => ({
  id: r.id, number: r.number, client: r.client, amountUsd: r.amount_usd, what: r.what, method: r.method as PayMethod | null, dueDate: r.due_date,
  status: r.status as InvoiceStatus, subscriptionId: r.subscription_id, newProject: r.new_project === 1, remind3: r.remind3 === 1, remind0: r.remind0 === 1,
  overdueAlerted: r.overdue_alerted === 1, createdAt: r.created_at, paidAt: r.paid_at,
});

export interface NewInvoice {
  client: string;
  amountUsd: number;
  what: string;
  method: PayMethod | null;
  dueDate: string;
  subscriptionId?: number | null;
  newProject?: boolean;
}

export class BillingStore {
  constructor(private readonly db: Db, private readonly now: () => number = Date.now, private readonly prefix = 'FT') {
    migrate(db, SCHEMA);
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
    const r = this.db
      .prepare(
        `INSERT INTO bl_invoices (number, year, seq, client, amount_usd, what, method, due_date, subscription_id, new_project, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(number, year, seq, i.client, i.amountUsd, i.what, i.method, i.dueDate, i.subscriptionId ?? null, i.newProject ? 1 : 0, this.now());
    return this.invoice(Number(r.lastInsertRowid))!;
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

  /** A live (not void) invoice of this subscription for this due date already exists. */
  hasInvoiceFor(subscriptionId: number, dueDate: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM bl_invoices WHERE subscription_id = ? AND due_date = ? AND status != 'void'").get(subscriptionId, dueDate));
  }

  setStatus(id: number, status: InvoiceStatus): void {
    this.db.prepare('UPDATE bl_invoices SET status = ?, paid_at = ? WHERE id = ?').run(status, status === 'paid' ? this.now() : null, id);
  }

  setFlag(id: number, flag: 'remind3' | 'remind0' | 'overdue_alerted'): void {
    this.db.prepare(`UPDATE bl_invoices SET ${flag} = 1 WHERE id = ?`).run(id);
  }

  /** Paid revenue in USD for payments in [from, to). */
  revenue(from: number, to: number): number {
    return (this.db.prepare("SELECT COALESCE(SUM(amount_usd), 0) s FROM bl_invoices WHERE status = 'paid' AND paid_at >= ? AND paid_at < ?").get(from, to) as { s: number }).s;
  }
}
