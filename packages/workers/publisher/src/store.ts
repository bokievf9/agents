import { migrate, type Db } from '@fir/core';
import type { Platform } from '@fir/worker-content-maker';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pb_posts (
  ready_id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  sent_on TEXT,
  published_at INTEGER,
  url TEXT,
  error TEXT,
  auto_on TEXT
);
CREATE TABLE IF NOT EXISTS pb_quota (
  date TEXT PRIMARY KEY,
  units INTEGER NOT NULL
);
`;

export interface PostRow {
  readyId: number;
  itemId: number;
  platform: Platform;
  sentOn: string | null;
  publishedAt: number | null;
}

export class PublishStore {
  constructor(private readonly db: Db) {
    migrate(db, SCHEMA);
    // url, error, auto_on came with the YouTube poster (2026-11-20)
    const cols = (db.prepare('PRAGMA table_info(pb_posts)').all() as { name: string }[]).map((c) => c.name);
    for (const c of ['url', 'error', 'auto_on']) if (!cols.includes(c)) db.exec(`ALTER TABLE pb_posts ADD COLUMN ${c} TEXT`);
  }

  /** Auto-posting state of a row: the day it was last tried, the URL on success, the reason on failure. */
  auto(readyId: number): { autoOn: string | null; url: string | null; error: string | null } {
    const r = this.db.prepare('SELECT auto_on, url, error FROM pb_posts WHERE ready_id = ?').get(readyId) as { auto_on: string | null; url: string | null; error: string | null } | undefined;
    return { autoOn: r?.auto_on ?? null, url: r?.url ?? null, error: r?.error ?? null };
  }

  /** Written before an upload starts, so a crash or a second run the same day never uploads twice. */
  markAttempt(readyId: number, itemId: number, platform: Platform, day: string): void {
    this.db.prepare('INSERT OR IGNORE INTO pb_posts (ready_id, item_id, platform) VALUES (?, ?, ?)').run(readyId, itemId, platform);
    this.db.prepare('UPDATE pb_posts SET auto_on = ?, error = NULL WHERE ready_id = ?').run(day, readyId);
  }

  setUrl(readyId: number, url: string): void {
    this.db.prepare('UPDATE pb_posts SET url = ?, error = NULL WHERE ready_id = ?').run(url, readyId);
  }

  setError(readyId: number, error: string): void {
    this.db.prepare('UPDATE pb_posts SET error = ? WHERE ready_id = ?').run(error.slice(0, 500), readyId);
  }

  quotaUsed(date: string): number {
    return (this.db.prepare('SELECT units FROM pb_quota WHERE date = ?').get(date) as { units: number } | undefined)?.units ?? 0;
  }

  addQuota(date: string, units: number): void {
    this.db.prepare('INSERT INTO pb_quota (date, units) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET units = units + excluded.units').run(date, units);
  }

  get(readyId: number): PostRow | undefined {
    const r = this.db.prepare('SELECT * FROM pb_posts WHERE ready_id = ?').get(readyId) as
      | { ready_id: number; item_id: number; platform: Platform; sent_on: string | null; published_at: number | null }
      | undefined;
    return r ? { readyId: r.ready_id, itemId: r.item_id, platform: r.platform, sentOn: r.sent_on, publishedAt: r.published_at } : undefined;
  }

  markSent(readyId: number, itemId: number, platform: Platform, day: string): void {
    this.db
      .prepare('INSERT INTO pb_posts (ready_id, item_id, platform, sent_on) VALUES (?, ?, ?, ?) ON CONFLICT(ready_id) DO UPDATE SET sent_on = excluded.sent_on')
      .run(readyId, itemId, platform, day);
  }

  /** Records the publication (first press wins); false when it was already marked. */
  markPublished(readyId: number, itemId: number, platform: Platform, at: number): boolean {
    this.db.prepare('INSERT OR IGNORE INTO pb_posts (ready_id, item_id, platform) VALUES (?, ?, ?)').run(readyId, itemId, platform);
    return this.db.prepare('UPDATE pb_posts SET published_at = ? WHERE ready_id = ? AND published_at IS NULL').run(at, readyId).changes > 0;
  }

  publishedBetween(fromMs: number, toMs: number): { platform: Platform; n: number }[] {
    return this.db
      .prepare('SELECT platform, COUNT(*) n FROM pb_posts WHERE published_at >= ? AND published_at < ? GROUP BY platform')
      .all(fromMs, toMs) as { platform: Platform; n: number }[];
  }
}
