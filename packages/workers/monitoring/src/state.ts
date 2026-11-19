import type { Db } from '@fir/core';
import { DAY_MS } from './checks.js';

export const FAIL_THRESHOLD = 2;

/** Per-check state machine: `down` after FAIL_THRESHOLD failures in a row, `ok` again at the first pass. */
export interface CheckState {
  status: 'ok' | 'down';
  /** Failures in a row. */
  fails: number;
  /** When the current failure streak started (ms), 0 when passing. */
  failSince: number;
}

export interface StepResult {
  next: CheckState;
  /** `down`: alert once. `recovered`: say so once. null: say nothing. */
  event: 'down' | 'recovered' | null;
  /** Length of the outage for `recovered`. */
  downMs?: number;
}

export const initialState = (): CheckState => ({ status: 'ok', fails: 0, failSince: 0 });

/** Pure hysteresis: one failure is noise, two in a row is an incident, the first pass ends it. No repeats while it lasts. */
export function step(prev: CheckState | undefined, ok: boolean, now: number, threshold = FAIL_THRESHOLD): StepResult {
  const cur = prev ?? initialState();
  if (ok) {
    if (cur.status === 'down') return { next: initialState(), event: 'recovered', downMs: now - cur.failSince };
    return { next: initialState(), event: null };
  }
  const fails = cur.fails + 1;
  const failSince = cur.fails === 0 ? now : cur.failSince;
  if (cur.status === 'ok' && fails >= threshold) return { next: { status: 'down', fails, failSince }, event: 'down' };
  return { next: { status: cur.status, fails, failSince }, event: null };
}

export interface Incident {
  checkId: string;
  startedAt: number;
  endedAt: number | null;
  detail: string;
}

/** The worker's own tables (prefix `mon_`) in the shared HQ database. */
export class MonitorStore {
  constructor(private readonly db: Db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mon_state (
        check_id TEXT PRIMARY KEY, status TEXT NOT NULL, fails INTEGER NOT NULL, fail_since INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mon_samples (at INTEGER NOT NULL, check_id TEXT NOT NULL, ok INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mon_urls (url TEXT PRIMARY KEY);
      CREATE INDEX IF NOT EXISTS mon_samples_at ON mon_samples (at);
      CREATE TABLE IF NOT EXISTS mon_incidents (
        id INTEGER PRIMARY KEY AUTOINCREMENT, check_id TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, detail TEXT NOT NULL DEFAULT ''
      );
    `);
  }

  /** URLs added at runtime (on top of MONITOR_URLS). Returns false when it is already there. */
  addUrl(url: string): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO mon_urls (url) VALUES (?)').run(url).changes > 0;
  }

  urls(): string[] {
    return (this.db.prepare('SELECT url FROM mon_urls ORDER BY rowid').all() as { url: string }[]).map((r) => r.url);
  }

  state(checkId: string): CheckState | undefined {
    const r = this.db.prepare('SELECT status, fails, fail_since FROM mon_state WHERE check_id = ?').get(checkId) as
      | { status: 'ok' | 'down'; fails: number; fail_since: number }
      | undefined;
    return r ? { status: r.status, fails: r.fails, failSince: r.fail_since } : undefined;
  }

  /** Every check's current state (the public status page reads this). */
  allStates(): (CheckState & { checkId: string })[] {
    return (this.db.prepare('SELECT check_id, status, fails, fail_since FROM mon_state ORDER BY check_id').all() as { check_id: string; status: 'ok' | 'down'; fails: number; fail_since: number }[]).map(
      (r) => ({ checkId: r.check_id, status: r.status, fails: r.fails, failSince: r.fail_since }),
    );
  }

  /** Time of the newest sample (ms), null when the worker never ran. */
  lastSampleAt(): number | null {
    return (this.db.prepare('SELECT MAX(at) AS t FROM mon_samples').get() as { t: number | null }).t;
  }

  saveState(checkId: string, s: CheckState): void {
    this.db
      .prepare(
        `INSERT INTO mon_state (check_id, status, fails, fail_since) VALUES (?, ?, ?, ?)
         ON CONFLICT(check_id) DO UPDATE SET status = excluded.status, fails = excluded.fails, fail_since = excluded.fail_since`,
      )
      .run(checkId, s.status, s.fails, s.failSince);
  }

  sample(at: number, checkId: string, ok: boolean): void {
    this.db.prepare('INSERT INTO mon_samples (at, check_id, ok) VALUES (?, ?, ?)').run(at, checkId, ok ? 1 : 0);
  }

  /** Keeps a week of samples. */
  prune(now: number): void {
    this.db.prepare('DELETE FROM mon_samples WHERE at < ?').run(now - 7 * DAY_MS);
    this.db.prepare('DELETE FROM mon_incidents WHERE ended_at IS NOT NULL AND ended_at < ?').run(now - 30 * DAY_MS);
  }

  openIncident(checkId: string, startedAt: number, detail: string): void {
    this.db.prepare('INSERT INTO mon_incidents (check_id, started_at, detail) VALUES (?, ?, ?)').run(checkId, startedAt, detail.slice(0, 200));
  }

  closeIncident(checkId: string, endedAt: number): void {
    this.db.prepare('UPDATE mon_incidents SET ended_at = ? WHERE check_id = ? AND ended_at IS NULL').run(endedAt, checkId);
  }

  /** Uptime over the window: passed samples over all samples, in percent (null: no samples). */
  uptime(since: number): { pct: number | null; samples: number; perCheck: { checkId: string; pct: number }[] } {
    const rows = this.db.prepare('SELECT check_id c, COUNT(*) n, SUM(ok) ok FROM mon_samples WHERE at >= ? GROUP BY check_id ORDER BY check_id').all(since) as {
      c: string; n: number; ok: number;
    }[];
    const n = rows.reduce((a, r) => a + r.n, 0);
    const ok = rows.reduce((a, r) => a + r.ok, 0);
    return {
      pct: n ? Math.round((ok / n) * 1000) / 10 : null,
      samples: n,
      perCheck: rows.map((r) => ({ checkId: r.c, pct: Math.round((r.ok / r.n) * 1000) / 10 })),
    };
  }

  /** Incidents that started in the window or are still open. */
  incidents(since: number): Incident[] {
    return (this.db.prepare('SELECT check_id, started_at, ended_at, detail FROM mon_incidents WHERE started_at >= ? OR ended_at IS NULL ORDER BY id').all(since) as {
      check_id: string; started_at: number; ended_at: number | null; detail: string;
    }[]).map((r) => ({ checkId: r.check_id, startedAt: r.started_at, endedAt: r.ended_at, detail: r.detail }));
  }
}
