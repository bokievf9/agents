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
  status TEXT NOT NULL DEFAULT 'ready',
  files TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS cm_articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  niche TEXT NOT NULL,
  status TEXT NOT NULL,
  slug TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  json TEXT NOT NULL DEFAULT '',
  comment TEXT,
  task_id INTEGER,
  issue_number INTEGER,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
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
  /** Slug of the blog article this carousel or reel was made from (repurposing), null for ordinary items. */
  sourceSlug: string | null;
}

export interface ReadyRow {
  id: number;
  itemId: number;
  platform: Platform;
  type: ItemType;
  text: string;
  plannedDate: string;
  status: string;
  /** Rendered PNG files (posts, carousel slides, story frames, highlight covers), in order. Empty for reels. */
  files: string[];
}

/** proposed: with the owner. approved: published by HQ (`/blog`). rejected. failed: the model gave nothing. */
export type ArticleStatus = 'draft' | 'proposed' | 'approved' | 'rejected' | 'failed';
/** `ai`: «ИИ для бизнеса» (niche is `ai`), `niche`: an article for one business niche. */
export type ArticleLine = 'ai' | 'niche';
export interface ArticleRow {
  id: number;
  niche: string;
  line: ArticleLine;
  topicKey: string;
  published: boolean;
  /** Approval day, YYYY-MM-DD (the site's `date`). */
  date: string | null;
  packQueued: boolean;
  status: ArticleStatus;
  slug: string;
  title: string;
  json: string;
  comment: string | null;
  taskId: number | null;
  issueNumber: number | null;
  createdAt: number;
  decidedAt: number | null;
}

interface ReadyDb {
  id: number; item_id: number; platform: Platform; type: ItemType; text: string; planned_date: string; status: string; files: string;
}
const toReady = (r: ReadyDb): ReadyRow => ({
  id: r.id, itemId: r.item_id, platform: r.platform, type: r.type, text: r.text, plannedDate: r.planned_date, status: r.status, files: parseFiles(r.files),
});
function parseFiles(raw: string): string[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

interface ItemDb {
  id: number; pack_id: number | null; seq: number; total: number; type: ItemType; topic_key: string; topic_text: string;
  title: string; text: string; status: ItemStatus; attempt: number; edited: number; planned_date: string;
  comment: string | null;
  source_slug: string | null;
}

const toItem = (r: ItemDb): Item => ({
  id: r.id, packId: r.pack_id, seq: r.seq, total: r.total, type: r.type, topicKey: r.topic_key, topicText: r.topic_text,
  title: r.title, text: r.text, status: r.status, attempt: r.attempt, edited: r.edited === 1, plannedDate: r.planned_date,
  comment: r.comment, sourceSlug: r.source_slug,
});

export class ContentStore {
  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {
    migrate(db, SCHEMA);
    // `files` came later than the table
    const cols = db.prepare('PRAGMA table_info(cm_ready)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'files')) db.exec("ALTER TABLE cm_ready ADD COLUMN files TEXT NOT NULL DEFAULT '[]'");
    // the daily blog (2026-11-19): an approved article is published by HQ itself (`published`, `date`), the line says AI or a niche,
    // `topic_key` keeps the used topic for the 60-day window, `pack_queued` waits for the next weekly pack (carousel + reel from it)
    const acols = db.prepare('PRAGMA table_info(cm_articles)').all() as { name: string }[];
    const addArticle = (name: string, ddl: string) => {
      if (!acols.some((c) => c.name === name)) db.exec(`ALTER TABLE cm_articles ADD COLUMN ${name} ${ddl}`);
    };
    addArticle('published', 'INTEGER NOT NULL DEFAULT 0');
    addArticle('date', 'TEXT');
    addArticle('line', "TEXT NOT NULL DEFAULT 'niche'");
    addArticle('topic_key', "TEXT NOT NULL DEFAULT ''");
    addArticle('pack_queued', 'INTEGER NOT NULL DEFAULT 0');
    const icols = db.prepare('PRAGMA table_info(cm_items)').all() as { name: string }[];
    if (!icols.some((c) => c.name === 'source_slug')) db.exec('ALTER TABLE cm_items ADD COLUMN source_slug TEXT');
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

  insertItem(i: { packId: number | null; seq: number; total: number; type: ItemType; topicKey: string; topicText: string; plannedDate: string; attempt?: number; sourceSlug?: string }): number {
    const r = this.db
      .prepare('INSERT INTO cm_items (pack_id, seq, total, type, topic_key, topic_text, status, attempt, planned_date, created_at, source_slug) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(i.packId, i.seq, i.total, i.type, i.topicKey, i.topicText, 'draft', i.attempt ?? 0, i.plannedDate, this.now(), i.sourceSlug ?? null);
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

  /** Rendered images of an item: stored on its Instagram row (the publisher sends them with the caption). */
  setFiles(itemId: number, files: string[]): void {
    this.db.prepare("UPDATE cm_ready SET files = ? WHERE item_id = ? AND platform = 'instagram'").run(JSON.stringify(files), itemId);
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
    return (this.db.prepare(`SELECT * FROM cm_ready WHERE ${where} ORDER BY planned_date, item_id, id`).all(...args) as ReadyDb[]).map(toReady);
  }

  readyRows(): ReadyRow[] {
    return (this.db.prepare("SELECT * FROM cm_ready WHERE status = 'ready' ORDER BY planned_date, item_id, id").all() as ReadyDb[]).map(toReady);
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

  // ---- blog articles ----
  insertArticle(niche: string, line: ArticleLine = 'niche', topicKey = ''): number {
    return Number(this.db.prepare("INSERT INTO cm_articles (niche, line, topic_key, status, created_at) VALUES (?, ?, ?, 'draft', ?)").run(niche, line, topicKey, this.now()).lastInsertRowid);
  }

  article(id: number): ArticleRow | undefined {
    const r = this.db.prepare('SELECT * FROM cm_articles WHERE id = ?').get(id) as ArticleDb | undefined;
    return r ? toArticle(r) : undefined;
  }

  articles(): ArticleRow[] {
    return (this.db.prepare('SELECT * FROM cm_articles ORDER BY id').all() as ArticleDb[]).map(toArticle);
  }

  setArticle(id: number, f: Partial<{ status: ArticleStatus; slug: string; title: string; json: string; comment: string; taskId: number; issueNumber: number; topicKey: string }>): void {
    const cols: string[] = [];
    const args: unknown[] = [];
    const map: Record<string, string> = { status: 'status', slug: 'slug', title: 'title', json: 'json', comment: 'comment', taskId: 'task_id', issueNumber: 'issue_number', topicKey: 'topic_key' };
    for (const [k, v] of Object.entries(f)) {
      cols.push(`${map[k]!} = ?`);
      args.push(v);
    }
    if (f.status === 'approved' || f.status === 'rejected') {
      cols.push('decided_at = ?');
      args.push(this.now());
    }
    if (cols.length) this.db.prepare(`UPDATE cm_articles SET ${cols.join(', ')} WHERE id = ?`).run(...args, id);
  }

  /** Niches that already have an article that is alive (anything but rejected and failed). */
  coveredNiches(): Set<string> {
    return new Set((this.db.prepare("SELECT niche FROM cm_articles WHERE status IN ('draft', 'proposed', 'approved') AND line = 'niche'").all() as { niche: string }[]).map((r) => r.niche));
  }

  /** Topic keys of live articles (not rejected, not failed) with the time of their last use: the 60-day window reads this. */
  recentArticleTopics(): Map<string, number> {
    const rows = this.db.prepare("SELECT topic_key AS k, MAX(created_at) AS t FROM cm_articles WHERE topic_key != '' AND status IN ('draft', 'proposed', 'approved') GROUP BY topic_key").all() as { k: string; t: number }[];
    return new Map(rows.map((r) => [r.k, r.t]));
  }

  /** Titles of live articles of one niche (so the next one takes another angle). */
  titlesOfNiche(niche: string): string[] {
    return (this.db.prepare("SELECT title FROM cm_articles WHERE niche = ? AND status IN ('proposed', 'approved') AND title != '' ORDER BY id DESC LIMIT 5").all(niche) as { title: string }[]).map((r) => r.title);
  }

  /** Cards the owner has not decided yet. */
  proposedArticles(): number {
    return (this.db.prepare("SELECT COUNT(*) c FROM cm_articles WHERE status = 'proposed'").get() as { c: number }).c;
  }

  /** Approved articles, newest first: what `/blog` serves. */
  publishedArticles(): ArticleRow[] {
    return (this.db.prepare("SELECT * FROM cm_articles WHERE published = 1 AND status = 'approved' ORDER BY date DESC, id DESC").all() as ArticleDb[]).map(toArticle);
  }

  articleBySlug(slug: string): ArticleRow | undefined {
    const r = this.db.prepare("SELECT * FROM cm_articles WHERE published = 1 AND status = 'approved' AND slug = ?").get(slug) as ArticleDb | undefined;
    return r ? toArticle(r) : undefined;
  }

  slugTaken(slug: string, exceptId: number): boolean {
    return this.db.prepare("SELECT 1 FROM cm_articles WHERE published = 1 AND slug = ? AND id != ?").get(slug, exceptId) !== undefined;
  }

  /** The owner approved: the article is published on `date` with its final slug and waits for the next weekly pack. */
  publishArticle(id: number, f: { slug: string; json: string; date: string }): void {
    this.db.prepare("UPDATE cm_articles SET status = 'approved', published = 1, slug = ?, json = ?, date = ?, pack_queued = 1, decided_at = ? WHERE id = ?").run(f.slug, f.json, f.date, this.now(), id);
  }

  /** Approved articles whose carousel and reel are not in a pack yet, oldest first. */
  queuedArticles(): ArticleRow[] {
    return (this.db.prepare("SELECT * FROM cm_articles WHERE pack_queued = 1 AND published = 1 ORDER BY id").all() as ArticleDb[]).map(toArticle);
  }

  unqueueArticle(id: number): void {
    this.db.prepare('UPDATE cm_articles SET pack_queued = 0 WHERE id = ?').run(id);
  }

  /** Items made from an article, newest first (carousel and reel). */
  itemsOfSlug(slug: string): Item[] {
    return (this.db.prepare('SELECT * FROM cm_items WHERE source_slug = ? ORDER BY id').all(slug) as ItemDb[]).map(toItem);
  }

  /** One more `/blog` request served on `date` (YYYY-MM-DD): the analyst's «обращений к блогу». */
  bumpBlogHit(date: string): void {
    this.db.prepare("INSERT INTO cm_kv (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)").run(`blog_hits:${date}`);
  }
}

interface ArticleDb {
  id: number; niche: string; status: ArticleStatus; slug: string; title: string; json: string; comment: string | null;
  task_id: number | null; issue_number: number | null; created_at: number; decided_at: number | null;
  line: ArticleLine; topic_key: string; published: number; date: string | null; pack_queued: number;
}
const toArticle = (r: ArticleDb): ArticleRow => ({
  id: r.id, niche: r.niche, status: r.status, slug: r.slug, title: r.title, json: r.json, comment: r.comment, taskId: r.task_id,
  issueNumber: r.issue_number, createdAt: r.created_at, decidedAt: r.decided_at,
  line: r.line === 'ai' ? 'ai' : 'niche', topicKey: r.topic_key, published: r.published === 1, date: r.date, packQueued: r.pack_queued === 1,
});
