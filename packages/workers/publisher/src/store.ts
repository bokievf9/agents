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
CREATE TABLE IF NOT EXISTS pb_comments (
  id TEXT PRIMARY KEY,
  media_id TEXT NOT NULL,
  username TEXT NOT NULL,
  text TEXT NOT NULL,
  at TEXT NOT NULL,
  replied INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pb_ig_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pb_ig_stats (
  date TEXT PRIMARY KEY,
  followers INTEGER,
  media_count INTEGER
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
    // container_id (a Reel still processing at Instagram) and media_id (for insights and comments) came with the Instagram poster
    for (const c of ['url', 'error', 'auto_on', 'container_id', 'media_id']) if (!cols.includes(c)) db.exec(`ALTER TABLE pb_posts ADD COLUMN ${c} TEXT`);
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

  /** A Reel container created at Instagram but not yet published (processing takes longer than one run). */
  container(readyId: number): string | null {
    return (this.db.prepare('SELECT container_id c FROM pb_posts WHERE ready_id = ?').get(readyId) as { c: string | null } | undefined)?.c ?? null;
  }

  setContainer(readyId: number, id: string | null): void {
    this.db.prepare('UPDATE pb_posts SET container_id = ? WHERE ready_id = ?').run(id, readyId);
  }

  setMedia(readyId: number, mediaId: string): void {
    this.db.prepare('UPDATE pb_posts SET media_id = ? WHERE ready_id = ?').run(mediaId, readyId);
  }

  /** Instagram rows published in the window that have a media id (insights, comments). */
  instagramPublished(fromMs: number, toMs: number): { readyId: number; mediaId: string; url: string | null; publishedAt: number }[] {
    return (this.db.prepare("SELECT ready_id, media_id, url, published_at FROM pb_posts WHERE platform = 'instagram' AND media_id IS NOT NULL AND published_at >= ? AND published_at < ? ORDER BY published_at").all(fromMs, toMs) as { ready_id: number; media_id: string; url: string | null; published_at: number }[])
      .map((r) => ({ readyId: r.ready_id, mediaId: r.media_id, url: r.url, publishedAt: r.published_at }));
  }

  igState(key: string): string | null {
    return (this.db.prepare('SELECT value FROM pb_ig_state WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
  }

  setIgState(key: string, value: string): void {
    this.db.prepare('INSERT INTO pb_ig_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** True when the comment is new (the id is the dedupe key). `replied` stays 0 until the Support head answers (TODO: replies). */
  addComment(c: { id: string; mediaId: string; username: string; text: string; at: string }): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO pb_comments (id, media_id, username, text, at, replied) VALUES (?, ?, ?, ?, ?, 0)').run(c.id, c.mediaId, c.username.slice(0, 60), c.text.slice(0, 500), c.at).changes > 0;
  }

  saveIgStats(date: string, followers: number | null, mediaCount: number | null): void {
    this.db.prepare('INSERT INTO pb_ig_stats (date, followers, media_count) VALUES (?, ?, ?) ON CONFLICT(date) DO UPDATE SET followers = excluded.followers, media_count = excluded.media_count').run(date, followers, mediaCount);
  }

  /** Followers on the latest snapshot taken on or before `date`. */
  followersUpTo(date: string): number | null {
    return (this.db.prepare('SELECT followers f FROM pb_ig_stats WHERE date <= ? AND followers IS NOT NULL ORDER BY date DESC LIMIT 1').get(date) as { f: number } | undefined)?.f ?? null;
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
