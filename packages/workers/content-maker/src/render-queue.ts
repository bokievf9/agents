import { migrate, type Db } from '@fir/core';

/**
 * Queue of video render jobs in the shared SQLite file. HQ enqueues (on approval of a reel, on `/render`); the single
 * `renderer` process claims one job at a time. Both processes open the same file (WAL), so every step here is a single
 * statement or one transaction.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS cm_render_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'reel',
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  output_path TEXT
);
CREATE INDEX IF NOT EXISTS cm_render_jobs_status ON cm_render_jobs (status, id);
CREATE INDEX IF NOT EXISTS cm_render_jobs_item ON cm_render_jobs (item_id, id);
`;

export type RenderKind = 'reel';
export type RenderStatus = 'queued' | 'running' | 'done' | 'failed';
export const MAX_RENDER_ATTEMPTS = 2;

export interface RenderJob {
  id: number;
  itemId: number;
  kind: RenderKind;
  status: RenderStatus;
  attempts: number;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  outputPath: string | null;
}

interface Row {
  id: number; item_id: number; kind: RenderKind; status: RenderStatus; attempts: number; error: string | null;
  created_at: number; started_at: number | null; finished_at: number | null; output_path: string | null;
}

const job = (r: Row): RenderJob => ({
  id: r.id, itemId: r.item_id, kind: r.kind, status: r.status, attempts: r.attempts, error: r.error,
  createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at, outputPath: r.output_path,
});

/** The short reason shown to the owner: one line, no paths or stack. */
export function shortReason(error: string | null | undefined): string {
  const line = (error ?? '').split('\n').find((l) => l.trim()) ?? 'неизвестная ошибка';
  return line.replace(/\/[^\s]+/g, '…').trim().slice(0, 120);
}

export class RenderQueue {
  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {
    migrate(db, SCHEMA);
  }

  get(id: number): RenderJob | undefined {
    const r = this.db.prepare('SELECT * FROM cm_render_jobs WHERE id = ?').get(id) as Row | undefined;
    return r ? job(r) : undefined;
  }

  /** The newest job of an item. */
  latest(itemId: number, kind: RenderKind = 'reel'): RenderJob | undefined {
    const r = this.db.prepare('SELECT * FROM cm_render_jobs WHERE item_id = ? AND kind = ? ORDER BY id DESC LIMIT 1').get(itemId, kind) as Row | undefined;
    return r ? job(r) : undefined;
  }

  /** Puts a job in the queue; an item that already has a queued or running job keeps it (no duplicates). */
  enqueue(itemId: number, kind: RenderKind = 'reel'): RenderJob {
    const cur = this.latest(itemId, kind);
    if (cur && (cur.status === 'queued' || cur.status === 'running')) return cur;
    const id = this.db.prepare('INSERT INTO cm_render_jobs (item_id, kind, created_at) VALUES (?, ?, ?)').run(itemId, kind, this.now()).lastInsertRowid;
    return this.get(Number(id))!;
  }

  /** Re-queues an item: new job unless one is active (`/render`, and the daily retry of a failed job). */
  requeue(itemId: number, kind: RenderKind = 'reel'): RenderJob {
    return this.enqueue(itemId, kind);
  }

  /** The oldest queued job becomes running (attempts + 1); null when nothing waits or one already runs. */
  claim(): RenderJob | null {
    return this.db.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM cm_render_jobs WHERE status = 'running'").get()) return null;
      const r = this.db.prepare("SELECT * FROM cm_render_jobs WHERE status = 'queued' ORDER BY id LIMIT 1").get() as Row | undefined;
      if (!r) return null;
      this.db.prepare("UPDATE cm_render_jobs SET status = 'running', attempts = attempts + 1, started_at = ?, finished_at = NULL WHERE id = ?").run(this.now(), r.id);
      return this.get(r.id)!;
    })();
  }

  complete(id: number, outputPath: string): void {
    this.db.prepare("UPDATE cm_render_jobs SET status = 'done', error = NULL, output_path = ?, finished_at = ? WHERE id = ?").run(outputPath, this.now(), id);
  }

  /** A failed attempt: back to the queue while attempts remain, else `failed` for good (the head retries it next day). */
  fail(id: number, error: string, maxAttempts = MAX_RENDER_ATTEMPTS): RenderJob {
    const cur = this.get(id);
    if (!cur) throw new Error(`no render job ${id}`);
    const final = cur.attempts >= maxAttempts;
    this.db.prepare('UPDATE cm_render_jobs SET status = ?, error = ?, finished_at = ? WHERE id = ?').run(final ? 'failed' : 'queued', error.slice(0, 500), final ? this.now() : null, id);
    return this.get(id)!;
  }

  /** At renderer start: a job left `running` by a crash counts as a failed attempt. */
  recoverStale(): number {
    const rows = this.db.prepare("SELECT id FROM cm_render_jobs WHERE status = 'running'").all() as { id: number }[];
    for (const r of rows) this.fail(r.id, 'рендер прерван (перезапуск)');
    return rows.length;
  }

  counts(): Record<RenderStatus, number> {
    const out: Record<RenderStatus, number> = { queued: 0, running: 0, done: 0, failed: 0 };
    for (const r of this.db.prepare('SELECT status, COUNT(*) n FROM cm_render_jobs GROUP BY status').all() as { status: RenderStatus; n: number }[]) out[r.status] = r.n;
    return out;
  }
}
