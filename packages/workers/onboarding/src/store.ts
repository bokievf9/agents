import { migrate, type Db } from '@fir/core';
import type { ProductType } from './product.js';

export type ItemKind = 'access' | 'guide' | 'checkin';

export interface ObItem {
  id: number;
  onboardingId: number;
  kind: ItemKind;
  title: string;
  /** Check-ins: when to remind the owner (ms). */
  dueAt: number | null;
  done: boolean;
}

export interface Onboarding {
  id: number;
  client: string;
  product: string;
  productType: ProductType;
  /** The blocked HQ task that holds the checklist for the owner. */
  taskId: number | null;
  invoiceNumber: string;
  createdAt: number;
  finishedAt: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ob_onboardings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client TEXT NOT NULL,
  product TEXT NOT NULL DEFAULT '',
  product_type TEXT NOT NULL DEFAULT 'other',
  task_id INTEGER,
  invoice_number TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE TABLE IF NOT EXISTS ob_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  onboarding_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  due_at INTEGER,
  done INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ob_items_due ON ob_items (kind, done, due_at);
`;

interface ObRow { id: number; client: string; product: string; product_type: string; task_id: number | null; invoice_number: string; created_at: number; finished_at: number | null }
interface ItemRow { id: number; onboarding_id: number; kind: string; title: string; due_at: number | null; done: number }

const toOb = (r: ObRow): Onboarding => ({
  id: r.id, client: r.client, product: r.product, productType: r.product_type as ProductType, taskId: r.task_id, invoiceNumber: r.invoice_number,
  createdAt: r.created_at, finishedAt: r.finished_at,
});
const toItem = (r: ItemRow): ObItem => ({ id: r.id, onboardingId: r.onboarding_id, kind: r.kind as ItemKind, title: r.title, dueAt: r.due_at, done: r.done === 1 });

export class ObStore {
  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {
    migrate(db, SCHEMA);
  }

  /** The running (unfinished) onboarding of a client, if any: `/onboard` twice does not duplicate. */
  openFor(client: string): Onboarding | undefined {
    const r = this.db.prepare('SELECT * FROM ob_onboardings WHERE lower(client) = lower(?) AND finished_at IS NULL ORDER BY id DESC').get(client.trim()) as ObRow | undefined;
    return r ? toOb(r) : undefined;
  }

  get(id: number): Onboarding | undefined {
    const r = this.db.prepare('SELECT * FROM ob_onboardings WHERE id = ?').get(id) as ObRow | undefined;
    return r ? toOb(r) : undefined;
  }

  create(o: { client: string; product: string; productType: ProductType; invoiceNumber?: string }, items: { kind: ItemKind; title: string; dueAt?: number }[]): Onboarding {
    const tx = this.db.transaction(() => {
      const r = this.db
        .prepare('INSERT INTO ob_onboardings (client, product, product_type, invoice_number, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(o.client.trim(), o.product, o.productType, o.invoiceNumber ?? '', this.now());
      const id = Number(r.lastInsertRowid);
      for (const i of items) this.db.prepare('INSERT INTO ob_items (onboarding_id, kind, title, due_at) VALUES (?, ?, ?, ?)').run(id, i.kind, i.title, i.dueAt ?? null);
      return id;
    });
    return this.get(tx())!;
  }

  setTask(id: number, taskId: number): void {
    this.db.prepare('UPDATE ob_onboardings SET task_id = ? WHERE id = ?').run(taskId, id);
  }

  items(onboardingId: number): ObItem[] {
    return (this.db.prepare('SELECT * FROM ob_items WHERE onboarding_id = ? ORDER BY id').all(onboardingId) as ItemRow[]).map(toItem);
  }

  /** Check-ins due now and not yet sent, with their onboarding. */
  dueCheckins(now: number): { item: ObItem; onboarding: Onboarding }[] {
    const rows = this.db.prepare("SELECT * FROM ob_items WHERE kind = 'checkin' AND done = 0 AND due_at <= ? ORDER BY due_at, id").all(now) as ItemRow[];
    return rows.map((r) => ({ item: toItem(r), onboarding: this.get(r.onboarding_id)! }));
  }

  markDone(itemId: number): void {
    this.db.prepare('UPDATE ob_items SET done = 1 WHERE id = ?').run(itemId);
  }

  /** Closes the onboarding once every check-in was sent. Returns it when it was just closed. */
  finishIfComplete(id: number): Onboarding | undefined {
    const left = (this.db.prepare("SELECT COUNT(*) c FROM ob_items WHERE onboarding_id = ? AND kind = 'checkin' AND done = 0").get(id) as { c: number }).c;
    if (left > 0) return undefined;
    const r = this.db.prepare('UPDATE ob_onboardings SET finished_at = ? WHERE id = ? AND finished_at IS NULL').run(this.now(), id);
    return r.changes === 1 ? this.get(id) : undefined;
  }

  recent(limit = 10): Onboarding[] {
    return (this.db.prepare('SELECT * FROM ob_onboardings ORDER BY id DESC LIMIT ?').all(limit) as ObRow[]).map(toOb);
  }
}
