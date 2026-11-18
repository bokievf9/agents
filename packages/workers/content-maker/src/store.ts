import { migrate, type Db } from '@fir/core';
import type { ItemType, Platform } from './format.js';
import type { History } from './topics.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cm_topic_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_key TEXT NOT NULL,
  used_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cm_topic_history_key ON cm_topic_history (topic_key, used_at);
CREATE TABLE IF NOT EXISTS cm_packs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cm_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pack_id INTEGER,
  seq INTEGER NOT NULL DEFAULT 1,
  total INTEGER NOT NULL DEFAULT 1,
  type TEXT NOT NULL,
  topic_key TEXT NOT NULL,
  topic_text TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  edited INTEGER NOT NULL DEFAULT 0,
  planned_date TEXT NOT NULL,
  comment TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cm_ready (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  type TEXT NOT NULL,
  text TEXT NOT NULL,
  planned_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready'
);
CREATE TABLE IF NOT EXISTS cm_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/** draft: being generated. proposed: with the owner. ready: approved. rejected. failed: the model gave nothing. */
export type ItemStatus = 'draft' | 'proposed' | 'ready' | 'rejected' | 'failed';

export interface Item {
  id: number;
  packId: number | null;
  seq: number;
  total: number;
  type: ItemType;
  topicKey: string;
  topicText: string;
  title: string;
  text: string;
  status: ItemStatus;
  attempt: number;
  edited: boolean;
  plannedDate: string;
  comment: string | null;
}

export interface ReadyRow {
  id: number;
  itemId: number;
  platform: Platform;
  type: ItemType;
  text: string;
  plannedDate: string;
  status: string;
}

interface ItemDb {
  id: number; pack_id: number | null; seq: number; total: number; type: ItemType; topic_key: string; topic_text: string;
  title: string; text: string; status: ItemStatus; attempt: number; edited: number; planned_date: string;
  comment: string | null;
}

const toItem = (r: ItemDb): Item => ({
  id: r.id, packId: r.pack_id, seq: r.seq, total: r.total, type: r.type, topicKey: r.topic_key, topicText: r.topic_text,
  title: r.title, text: r.text, status: r.status, attempt: r.attempt, edited: r.edited === 1, plannedDate: r.planned_date,
  comment: r.comment,
});

export class ContentStore {
  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {
    migrate(db, SCHEMA);
  }

  history(): History {
    const rows = this.db.prepare('SELECT topic_key AS k, MAX(used_at) AS t FROM cm_topic_history GROUP BY topic_key').all() as { k: string; t: number }[];
    return new Map(rows.map((r) => [r.k, r.t]));
  }

  recordTopic(key: string): void {
    this.db.prepare('INSERT INTO cm_topic_history (topic_key, used_at) VALUES (?, ?)').run(key, this.now());
  }

  packExists(weekStart: string): boolean {
    return this.db.prepare('SELECT 1 FROM cm_packs WHERE week_start = ?').get(weekStart) !== undefined;
  }

  createPack(weekStart: string): number {
    return Number(this.db.prepare('INSERT INTO cm_packs (week_start, created_at) VALUES (?, ?)').run(weekStart, this.now()).lastInsertRowid);
  }

  insertItem(i: { packId: number | null; seq: number; total: number; type: ItemType; topicKey: string; topicText: string; plannedDate: string; attempt?: number }): number {
    const r = this.db
      .prepare('INSERT INTO cm_items (pack_id, seq, total, type, topic_key, topic_text, status, attempt, planned_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(i.packId, i.seq, i.total, i.type, i.topicKey, i.topicText, 'draft', i.attempt ?? 0, i.plannedDate, this.now());
    return Number(r.lastInsertRowid);
  }

  item(id: number): Item | undefined {
    const r = this.db.prepare('SELECT * FROM cm_items WHERE id = ?').get(id) as ItemDb | undefined;
    return r ? toItem(r) : undefined;
  }

  setProposed(id: number, text: string, title: string): void {
    this.db.prepare("UPDATE cm_items SET status = 'proposed', text = ?, title = ? WHERE id = ?").run(text, title, id);
  }

  setText(id: number, text: string, title: string): void {
    this.db.prepare('UPDATE cm_items SET text = ?, title = ? WHERE id = ?').run(text, title, id);
  }

  setStatus(id: number, status: ItemStatus, comment?: string): void {
    this.db.prepare('UPDATE cm_items SET status = ?, comment = COALESCE(?, comment) WHERE id = ?').run(status, comment ?? null, id);
  }

  /** Approved: the item becomes ready and gets one row per platform (the Publisher head reads `ready`). */
  markReady(id: number, text: string, edited: boolean, rows: { platform: Platform; text: string }[]): void {
    const item = this.item(id);
    if (!item) throw new Error(`item ${id} not found`);
    const tx = this.db.transaction(() => {
      this.db.prepare("UPDATE cm_items SET status = 'ready', text = ?, edited = ? WHERE id = ?").run(text, edited ? 1 : 0, id);
      const ins = this.db.prepare('INSERT INTO cm_ready (item_id, platform, type, text, planned_date) VALUES (?, ?, ?, ?, ?)');
      for (const r of rows) ins.run(id, r.platform, item.type, r.text, item.plannedDate);
    });
    tx();
  }

  /** The owner posted this platform's copy by hand (Publisher): it leaves the ready queue. */
  markPublished(readyId: number): boolean {
    return this.db.prepare("UPDATE cm_ready SET status = 'published' WHERE id = ? AND status = 'ready'").run(readyId).changes > 0;
  }

  readyRow(readyId: number): ReadyRow | undefined {
    return this.readyRowsWhere('id = ?', readyId)[0];
  }

  /** Rows of one item, any status (the Publisher and the Analyst count published ones). */
  rowsOfItem(itemId: number): ReadyRow[] {
    return this.readyRowsWhere('item_id = ?', itemId);
  }

  private readyRowsWhere(where: string, ...args: unknown[]): ReadyRow[] {
    const rows = this.db.prepare(`SELECT * FROM cm_ready WHERE ${where} ORDER BY planned_date, item_id, id`).all(...args) as {
      id: number; item_id: number; platform: Platform; type: ItemType; text: string; planned_date: string; status: string;
    }[];
    return rows.map((r) => ({ id: r.id, itemId: r.item_id, platform: r.platform, type: r.type, text: r.text, plannedDate: r.planned_date, status: r.status }));
  }

  readyRows(): ReadyRow[] {
    const rows = this.db.prepare("SELECT * FROM cm_ready WHERE status = 'ready' ORDER BY planned_date, item_id, id").all() as {
      id: number; item_id: number; platform: Platform; type: ItemType; text: string; planned_date: string; status: string;
    }[];
    return rows.map((r) => ({ id: r.id, itemId: r.item_id, platform: r.platform, type: r.type, text: r.text, plannedDate: r.planned_date, status: r.status }));
  }

  /** Approved rows whose planned date is `date` (YYYY-MM-DD). */
  readyOn(date: string): ReadyRow[] {
    return this.readyRows().filter((r) => r.plannedDate === date);
  }

  counts(): { ready: number; rejected: number; proposed: number; failed: number; edited: number; regenerated: number } {
    const n = (sql: string) => (this.db.prepare(sql).get() as { c: number }).c;
    return {
      ready: n("SELECT COUNT(*) c FROM cm_items WHERE status = 'ready'"),
      rejected: n("SELECT COUNT(*) c FROM cm_items WHERE status = 'rejected'"),
      proposed: n("SELECT COUNT(*) c FROM cm_items WHERE status = 'proposed'"),
      failed: n("SELECT COUNT(*) c FROM cm_items WHERE status = 'failed'"),
      edited: n("SELECT COUNT(*) c FROM cm_items WHERE status = 'ready' AND edited = 1"),
      regenerated: n('SELECT COUNT(*) c FROM cm_items WHERE attempt > 0'),
    };
  }

  getKv(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM cm_kv WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }

  setKv(key: string, value: string | null): void {
    if (value === null) this.db.prepare('DELETE FROM cm_kv WHERE key = ?').run(key);
    else this.db.prepare('INSERT INTO cm_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
}
