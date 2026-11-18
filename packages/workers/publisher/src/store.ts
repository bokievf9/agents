import { migrate, type Db } from '@fir/core';
import type { Platform } from '@fir/worker-content-maker';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pb_posts (
  ready_id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  sent_on TEXT,
  published_at INTEGER
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
