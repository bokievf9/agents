import type { Db } from '../db.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tool_cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tool_cache_expires ON tool_cache (expires_at);
`;

/** Largest value kept (64 KB of JSON). */
export const CACHE_MAX_BYTES = 65_536;

/**
 * Key-value cache for answers of outside services (search results, trends, Search Console). SQLite when a database is
 * given (survives restarts, shared by every agent), else memory. Expired rows are invisible and removed by `sweep`.
 */
export class ToolCache {
  private readonly mem = new Map<string, { value: string; expiresAt: number }>();
  private lastSweep = 0;

  constructor(private readonly db: Db | undefined, private readonly now: () => number = Date.now) {
    if (db) db.exec(SCHEMA);
  }

  get(key: string): string | null {
    const t = this.now();
    if (t - this.lastSweep > 3_600_000) this.sweep();
    if (!this.db) {
      const hit = this.mem.get(key);
      if (!hit) return null;
      if (hit.expiresAt <= t) {
        this.mem.delete(key);
        return null;
      }
      return hit.value;
    }
    const r = this.db.prepare('SELECT value, expires_at FROM tool_cache WHERE key = ?').get(key) as { value: string; expires_at: number } | undefined;
    if (!r) return null;
    if (r.expires_at <= t) {
      this.del(key);
      return null;
    }
    return r.value;
  }

  /** false when the value is over `CACHE_MAX_BYTES` (nothing stored) or the TTL is not positive. */
  set(key: string, value: string, ttlMs: number): boolean {
    if (!(ttlMs > 0) || Buffer.byteLength(value) > CACHE_MAX_BYTES) return false;
    const expiresAt = this.now() + ttlMs;
    if (!this.db) this.mem.set(key, { value, expiresAt });
    else this.db.prepare('INSERT INTO tool_cache (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at').run(key, value, expiresAt);
    return true;
  }

  del(key: string): void {
    if (!this.db) this.mem.delete(key);
    else this.db.prepare('DELETE FROM tool_cache WHERE key = ?').run(key);
  }

  /** Removes expired rows; returns how many. */
  sweep(): number {
    const t = this.now();
    this.lastSweep = t;
    if (!this.db) {
      let n = 0;
      for (const [k, v] of this.mem) if (v.expiresAt <= t) {
        this.mem.delete(k);
        n++;
      }
      return n;
    }
    return this.db.prepare('DELETE FROM tool_cache WHERE expires_at <= ?').run(t).changes;
  }

  /** JSON helpers: a value that does not parse counts as a miss. */
  getJson<T>(key: string): T | null {
    const v = this.get(key);
    if (v === null) return null;
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }

  setJson(key: string, value: unknown, ttlMs: number): boolean {
    return this.set(key, JSON.stringify(value), ttlMs);
  }
}
