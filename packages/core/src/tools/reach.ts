import { createHash } from 'node:crypto';
import type { Db } from '../db.js';
import type { Kit } from './kit.js';
import { REACH_ACTIONS, cleanArgs, reachSpec, type ReachChannel } from './reach-spec.js';
import { fail, okv, type ToolResult } from './result.js';

export * from './reach-spec.js';

/**
 * Agent Reach on the owner's Mac (`packages/mac-poster`, `reach:run`): the browser and Python cannot run in the HQ container, so a worker asks and the Mac
 * answers later. `ctx.tools.reach.<channel>.<action>(args)` never waits: it answers `{ state: 'queued', jobId }` (the job sits in `rc_jobs` until the Mac claims
 * it) or, when the same call finished within 24 hours, `{ state: 'done', result }` from the table. Spec: `docs/tools.md`, `docs/admin-crm-api.md` «Reach».
 */
export const REACH_CACHE_MS = 24 * 3_600_000;
/** A failed job is not asked again for an hour (the Mac is off, the channel is not logged in, the page is gone). */
export const REACH_FAIL_MS = 3_600_000;
export const REACH_TTL_MS = 7 * 86_400_000;
export const REACH_DAILY_CAP = 200;
/** Queued and never claimed for this long: the Mac is off, the job fails and the waiting task goes on without it. */
export const REACH_QUEUE_EXPIRE_MS = 6 * 3_600_000;
/** Claimed and not answered for this long: the run died. */
export const REACH_RUN_EXPIRE_MS = 30 * 60_000;
export const REACH_RESULT_CAP = 200_000;

export const REACH_SCHEMA = `
CREATE TABLE IF NOT EXISTS rc_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  channel TEXT NOT NULL,
  action TEXT NOT NULL,
  args TEXT NOT NULL,
  task_id INTEGER,
  waiters TEXT NOT NULL DEFAULT '[]',
  agent_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  ttl INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS rc_jobs_key ON rc_jobs (key, id);
CREATE INDEX IF NOT EXISTS rc_jobs_status ON rc_jobs (status, id);
CREATE UNIQUE INDEX IF NOT EXISTS rc_jobs_open ON rc_jobs (key) WHERE status IN ('queued','running');
`;

export type ReachStatus = 'queued' | 'running' | 'done' | 'failed';

/** What the CLI printed, as data: `ok`, `items` (title, url, author, published_at, text), `meta`, `error` (code, message, hint). Never executed or followed. */
export interface ReachResult {
  ok: boolean;
  items: Record<string, unknown>[];
  meta: Record<string, unknown>;
  error?: { code?: string; message?: string; hint?: string };
}

export interface ReachJob {
  id: number;
  key: string;
  channel: string;
  action: string;
  args: Record<string, string | number>;
  taskId: number | null;
  waiters: number[];
  agentId: string | null;
  status: ReachStatus;
  result: ReachResult | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  ttl: number;
}

interface Row {
  id: number; key: string; channel: string; action: string; args: string; task_id: number | null; waiters: string; agent_id: string | null; status: ReachStatus;
  result: string | null; error: string | null; created_at: number; started_at: number | null; finished_at: number | null; ttl: number;
}
const parse = <T>(s: string | null, def: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : def;
  } catch {
    return def;
  }
};
const toJob = (r: Row): ReachJob => ({
  id: r.id, key: r.key, channel: r.channel, action: r.action, args: parse(r.args, {}), taskId: r.task_id, waiters: parse<number[]>(r.waiters, []), agentId: r.agent_id, status: r.status,
  result: parse<ReachResult | null>(r.result, null), error: r.error, createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at, ttl: r.ttl,
});

/** The same (channel, action, args) is the same job: sha256 of the canonical form (keys sorted). */
export function reachKey(channel: string, action: string, args: Record<string, string | number>): string {
  const canon = JSON.stringify(Object.keys(args).sort().map((k) => [k, args[k]]));
  return createHash('sha256').update(`${channel}\0${action}\0${canon}`).digest('hex');
}

const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n));

/**
 * The Mac's answer, bounded: at most `REACH_RESULT_CAP` bytes of JSON. Long item texts are halved until it fits, then items are dropped from the end;
 * `meta.truncated` says it happened. Only the four known keys are kept.
 */
export function capResult(r: ReachResult, cap = REACH_RESULT_CAP): ReachResult {
  const items = Array.isArray(r.items) ? r.items.filter((i) => i && typeof i === 'object' && !Array.isArray(i)) : [];
  let out: ReachResult = {
    ok: r.ok === true, items, meta: r.meta && typeof r.meta === 'object' && !Array.isArray(r.meta) ? r.meta : {},
    ...(r.error && typeof r.error === 'object' ? { error: r.error } : {}),
  };
  const size = (x: ReachResult) => Buffer.byteLength(JSON.stringify(x));
  if (size(out) <= cap) return out;
  out = { ...out, items: items.map((i) => ({ ...i })), meta: { ...out.meta, truncated: true } };
  for (let n = 0; n < 24 && size(out) > cap; n++) {
    for (const i of out.items) for (const k of ['text', 'raw']) if (typeof i[k] === 'string' && (i[k] as string).length > 400) i[k] = (i[k] as string).slice(0, Math.floor((i[k] as string).length / 2));
    if (n > 8) while (out.items.length > 1 && size(out) > cap) out.items.pop();
  }
  if (size(out) > cap) out = { ok: out.ok, items: [], meta: { truncated: true }, ...(out.error ? { error: out.error } : {}) };
  return out;
}

export class ReachStore {
  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {
    db.exec(REACH_SCHEMA);
  }

  get(id: number): ReachJob | undefined {
    const r = this.db.prepare('SELECT * FROM rc_jobs WHERE id = ?').get(id) as Row | undefined;
    return r ? toJob(r) : undefined;
  }

  list(status: ReachStatus | undefined, limit = 20): ReachJob[] {
    const n = Math.min(Math.max(limit, 1), 100);
    const rows = status ? (this.db.prepare('SELECT * FROM rc_jobs WHERE status = ? ORDER BY id LIMIT ?').all(status, n) as Row[]) : (this.db.prepare('SELECT * FROM rc_jobs ORDER BY id DESC LIMIT ?').all(n) as Row[]);
    return rows.map(toJob);
  }

  counts(): Record<ReachStatus, number> {
    const out: Record<ReachStatus, number> = { queued: 0, running: 0, done: 0, failed: 0 };
    for (const r of this.db.prepare('SELECT status, COUNT(*) c FROM rc_jobs GROUP BY status').all() as { status: ReachStatus; c: number }[]) out[r.status] = r.c;
    return out;
  }

  /** The open job of a key, a `done` one newer than `doneSince`, or a failed one newer than `failedSince`, in that order. */
  find(key: string, doneSince: number, failedSince: number): ReachJob | undefined {
    const open = this.db.prepare("SELECT * FROM rc_jobs WHERE key = ? AND status IN ('queued','running')").get(key) as Row | undefined;
    if (open) return toJob(open);
    const done = this.db.prepare("SELECT * FROM rc_jobs WHERE key = ? AND status = 'done' AND finished_at >= ? ORDER BY id DESC LIMIT 1").get(key, doneSince) as Row | undefined;
    if (done) return toJob(done);
    const failed = this.db.prepare("SELECT * FROM rc_jobs WHERE key = ? AND status = 'failed' AND finished_at >= ? ORDER BY id DESC LIMIT 1").get(key, failedSince) as Row | undefined;
    return failed ? toJob(failed) : undefined;
  }

  /** The open job a task waits on (its own or as a waiter): a running one first, else the newest. */
  openForTask(taskId: number): ReachJob | undefined {
    const r = this.db
      .prepare("SELECT * FROM rc_jobs WHERE status IN ('queued','running') AND (task_id = ? OR EXISTS (SELECT 1 FROM json_each(rc_jobs.waiters) WHERE value = ?)) ORDER BY (status = 'running') DESC, id DESC LIMIT 1")
      .get(taskId, taskId) as Row | undefined;
    return r ? toJob(r) : undefined;
  }

  createdSince(ms: number): number {
    return (this.db.prepare('SELECT COUNT(*) c FROM rc_jobs WHERE created_at >= ?').get(ms) as { c: number }).c;
  }

  /** A new queued job; when another one with the same key is open meanwhile (the unique index), that one is returned. */
  create(channel: string, action: string, args: Record<string, string | number>, taskId: number | null, agentId: string | null): ReachJob {
    const t = this.now();
    const key = reachKey(channel, action, args);
    try {
      const r = this.db
        .prepare('INSERT INTO rc_jobs (key, channel, action, args, task_id, agent_id, created_at, ttl) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(key, channel, action, JSON.stringify(args), taskId, agentId, t, t + REACH_TTL_MS);
      return this.get(Number(r.lastInsertRowid))!;
    } catch (e) {
      const open = this.db.prepare("SELECT * FROM rc_jobs WHERE key = ? AND status IN ('queued','running')").get(key) as Row | undefined;
      if (open) return toJob(open);
      throw e;
    }
  }

  /**
   * The one entry of every asker (the tool, the owner's `POST /admin/reach`): the open job of the same key (a waiting task is remembered), a `done` one of the
   * last 24 h, a `failed` one of the last hour, else a new queued job unless 200 were made in 24 h.
   */
  request(channel: string, action: string, args: Record<string, string | number>, taskId: number | null, agentId: string | null):
    | { kind: 'cap' }
    | { kind: 'queued' | 'done' | 'failed'; job: ReachJob; created: boolean } {
    const now = this.now();
    const found = this.find(reachKey(channel, action, args), now - REACH_CACHE_MS, now - REACH_FAIL_MS);
    if (found) {
      if (found.status === 'done') return { kind: 'done', job: found, created: false };
      if (found.status === 'failed') return { kind: 'failed', job: found, created: false };
      if (taskId !== null) this.addWaiter(found.id, taskId);
      return { kind: 'queued', job: found, created: false };
    }
    if (this.createdSince(now - 86_400_000) >= REACH_DAILY_CAP) return { kind: 'cap' };
    return { kind: 'queued', job: this.create(channel, action, args, taskId, agentId), created: true };
  }

  /** Another task waits for the same open job: it is resumed with the first one. */
  addWaiter(id: number, taskId: number): void {
    const j = this.get(id);
    if (!j || j.taskId === taskId || j.waiters.includes(taskId)) return;
    if (j.taskId === null) this.db.prepare('UPDATE rc_jobs SET task_id = ? WHERE id = ?').run(taskId, id);
    else this.db.prepare('UPDATE rc_jobs SET waiters = ? WHERE id = ?').run(JSON.stringify([...j.waiters, taskId].slice(-20)), id);
  }

  /** queued -> running, once: the second caller gets false. */
  claim(id: number): boolean {
    return this.db.prepare("UPDATE rc_jobs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'").run(this.now(), id).changes === 1;
  }

  /**
   * The Mac's answer for a running job. `applied: false`, `job` set: it was already answered (the repeat is a no-op). `job` undefined: unknown id.
   * A job that is still `queued` (never claimed) is refused with `reason: 'not_claimed'`.
   */
  finish(id: number, res: { ok: true; result: ReachResult } | { ok: false; error: string; result?: ReachResult }): { applied: boolean; job?: ReachJob; reason?: string } {
    const j = this.get(id);
    if (!j) return { applied: false };
    if (j.status === 'done' || j.status === 'failed') return { applied: false, job: j };
    if (j.status === 'queued') return { applied: false, job: j, reason: 'not_claimed' };
    const t = this.now();
    // a CLI answer with ok:false (NOT_FOUND, NEED_LOGIN...) is a failed job that keeps what the CLI said
    const failed = !res.ok || !res.result.ok;
    const result = res.ok ? capResult(res.result) : res.result ? capResult(res.result) : null;
    const error = failed ? clip(res.ok ? [res.result.error?.code, res.result.error?.message].filter(Boolean).join(': ') || 'the CLI answered ok:false' : res.error, 300) : null;
    const n = this.db
      .prepare("UPDATE rc_jobs SET status = ?, result = ?, error = ?, finished_at = ? WHERE id = ? AND status = 'running'")
      .run(failed ? 'failed' : 'done', result ? JSON.stringify(result) : null, error, t, id).changes;
    return { applied: n === 1, job: this.get(id)! };
  }

  /** Jobs nobody answers: queued too long (the Mac is off) or running too long (the run died) become failed. Returns them. */
  expire(): ReachJob[] {
    const t = this.now();
    const rows = this.db
      .prepare("SELECT * FROM rc_jobs WHERE (status = 'queued' AND created_at < ?) OR (status = 'running' AND started_at < ?)")
      .all(t - REACH_QUEUE_EXPIRE_MS, t - REACH_RUN_EXPIRE_MS) as Row[];
    const out: ReachJob[] = [];
    for (const r of rows) {
      const why = r.status === 'queued' ? 'the Mac did not pick the job up in time (off or no tunnel)' : 'the Mac run did not answer in time';
      if (this.db.prepare("UPDATE rc_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status IN ('queued','running')").run(why, t, r.id).changes === 1) out.push(this.get(r.id)!);
    }
    return out;
  }

  /** Nightly: jobs past their TTL (7 days) are deleted. Returns how many. */
  purge(): number {
    return this.db.prepare('DELETE FROM rc_jobs WHERE ttl < ?').run(this.now()).changes;
  }
}

/** The Mac reports the channels it has set up in `settings.reach.channels` (a JSON array); only those get jobs that need a login (Instagram, X, LinkedIn). */
export const REACH_SETTING_CHANNELS = 'reach.channels';

/** The channels the Mac reported (empty when it never did or the setting is unreadable). */
export function reachChannels(db: Db): string[] {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(REACH_SETTING_CHANNELS) as { value: string } | undefined;
    const v = row ? (JSON.parse(row.value) as unknown) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export type ReachOutcome =
  | { state: 'queued'; jobId: number }
  | { state: 'done'; jobId: number; result: ReachResult; finishedAt: number };

type ReachFns = { [C in ReachChannel]: { [A in keyof (typeof REACH_ACTIONS)[C]]: (args: Record<string, unknown>) => Promise<ToolResult<ReachOutcome>> } };
export type Reach = ReachFns;

export function createReach(k: Kit): Reach {
  const db = k.deps.db;
  let store: ReachStore | undefined;
  const st = () => (store ??= new ReachStore(db!, k.now));
  const call = (channel: ReachChannel, action: string) => (args: Record<string, unknown>) =>
    k.call<ReachOutcome>(`reach.${channel}.${action}`, async () => {
      const spec = reachSpec(channel, action);
      if (!spec) return fail('invalid', 'unknown action');
      const clean = cleanArgs(spec, args);
      if (!clean.ok) return fail('invalid', clean.reason);
      const r = st().request(channel, action, clean.args, k.cx.taskId ?? null, k.cx.agentId);
      if (r.kind === 'cap') return fail('rate_limited', `reach cap of ${REACH_DAILY_CAP} jobs a day reached`, { retryable: false });
      const found = r.job;
      if (r.kind === 'failed') return fail(/NEED_LOGIN|NEED_SETUP|PLATFORM_BLOCKED|BAD_INPUT/.test(found.error ?? '') ? 'not_configured' : 'upstream', `reach job ${found.id}: ${found.error ?? 'failed'}`, { retryable: false });
      if (r.kind === 'done') return okv({ state: 'done' as const, jobId: found.id, result: found.result!, finishedAt: found.finishedAt ?? k.now() });
      return okv({ state: 'queued' as const, jobId: found.id });
    });
  const out: Record<string, Record<string, unknown>> = {};
  for (const [channel, actions] of Object.entries(REACH_ACTIONS)) {
    out[channel] = {};
    for (const action of Object.keys(actions)) out[channel]![action] = call(channel as ReachChannel, action);
  }
  return out as unknown as Reach;
}
