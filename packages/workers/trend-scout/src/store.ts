import { migrate, type Db } from '@fir/core';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ts_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  rank INTEGER NOT NULL,
  hook TEXT NOT NULL,
  format TEXT NOT NULL,
  why TEXT NOT NULL,
  source TEXT NOT NULL,
  url TEXT NOT NULL,
  direction TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ts_items_day ON ts_items (day, rank);
`;

export interface TrendItem {
  id: number;
  day: string;
  rank: number;
  hook: string;
  format: string;
  why: string;
  source: string;
  url: string;
  direction: string | null;
}

export type NewTrendItem = Omit<TrendItem, 'id' | 'day' | 'rank'>;

export class TrendStore {
  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {
    migrate(db, SCHEMA);
  }

  hasDay(day: string): boolean {
    return this.db.prepare('SELECT 1 FROM ts_items WHERE day = ?').get(day) !== undefined;
  }

  /** Replaces the day's items (a forced re-run does not duplicate). */
  saveDay(day: string, items: NewTrendItem[]): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM ts_items WHERE day = ?').run(day);
      const ins = this.db.prepare('INSERT INTO ts_items (day, rank, hook, format, why, source, url, direction, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      items.forEach((i, n) => ins.run(day, n + 1, i.hook, i.format, i.why, i.source, i.url, i.direction, this.now()));
    });
    tx();
  }

  /** Items of the newest day that has any, but not older than `maxAgeDays`. */
  latest(today: string, maxAgeDays = 7): TrendItem[] {
    const since = new Date(Date.parse(`${today}T00:00:00Z`) - maxAgeDays * 86_400_000).toISOString().slice(0, 10);
    const day = (this.db.prepare('SELECT MAX(day) d FROM ts_items WHERE day >= ?').get(since) as { d: string | null }).d;
    return day ? this.since(day, day) : [];
  }

  /** Items from `from` to `to` inclusive (YYYY-MM-DD). */
  since(from: string, to: string): TrendItem[] {
    return (this.db.prepare('SELECT * FROM ts_items WHERE day >= ? AND day <= ? ORDER BY day DESC, rank').all(from, to) as {
      id: number; day: string; rank: number; hook: string; format: string; why: string; source: string; url: string; direction: string | null;
    }[]).map((r) => ({ id: r.id, day: r.day, rank: r.rank, hook: r.hook, format: r.format, why: r.why, source: r.source, url: r.url, direction: r.direction }));
  }
}
