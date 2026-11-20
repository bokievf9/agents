import { migrate, type Db } from '@fir/core';

/**
 * Versions of a review item (`docs/admin-crm-api.md`, «Ревью-центр»). Keyed by the review id (`ap_<task_approvals.id>`). Version 1 is the worker's
 * original; it is written when the first owner edit happens (a snapshot of the state before it), so an item nobody touched has no rows and shows
 * its current state as v1. Texts and media are JSON, never logged.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS review_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  approval_id TEXT NOT NULL,
  v INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  text TEXT NOT NULL,
  media TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL CHECK (author IN ('owner','worker')),
  UNIQUE (approval_id, v)
);
`;

export interface ReviewVersion {
  v: number;
  createdAt: string;
  text: Record<string, unknown>;
  media: unknown[];
  note: string;
  author: 'owner' | 'worker';
}

interface Row {
  v: number; created_at: number; text: string; media: string; note: string; author: 'owner' | 'worker';
}

const parse = <T>(raw: string, fallback: T): T => {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

export class ReviewVersions {
  constructor(private readonly db: Db, private readonly now: () => number) {
    migrate(db, SCHEMA);
  }

  list(key: string): ReviewVersion[] {
    return (this.db.prepare('SELECT v, created_at, text, media, note, author FROM review_versions WHERE approval_id = ? ORDER BY v').all(key) as Row[]).map((r) => ({
      v: r.v, createdAt: new Date(r.created_at).toISOString(), text: parse<Record<string, unknown>>(r.text, {}), media: parse<unknown[]>(r.media, []), note: r.note, author: r.author,
    }));
  }

  /** Adds the next version (v1 on the first call). `base` is stored first when nothing exists yet: the state the item had before this change. */
  add(key: string, v: { text: Record<string, unknown>; media: unknown[]; note: string; author: 'owner' | 'worker' }, base?: { text: Record<string, unknown>; media: unknown[]; note: string; at: number }): number {
    const tx = this.db.transaction(() => {
      const last = (this.db.prepare('SELECT MAX(v) m FROM review_versions WHERE approval_id = ?').get(key) as { m: number | null }).m ?? 0;
      const ins = this.db.prepare('INSERT INTO review_versions (approval_id, v, created_at, text, media, note, author) VALUES (?, ?, ?, ?, ?, ?, ?)');
      let n = last;
      if (n === 0 && base) {
        ins.run(key, 1, base.at, JSON.stringify(base.text), JSON.stringify(base.media), base.note, 'worker');
        n = 1;
      }
      n += 1;
      ins.run(key, n, this.now(), JSON.stringify(v.text), JSON.stringify(v.media), v.note.slice(0, 4000), v.author);
      return n;
    });
    return tx();
  }
}
