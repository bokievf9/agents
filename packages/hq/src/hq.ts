import { MODEL_PRICES, errMsg, syncedTitle, log as coreLog, priceFor, usdFor, zonedParts, zonedToMs, type ApprovalQueue, type Db, type KindSpec, type Payload, type PriceTable } from '@fir/core';
import { SCHEMA } from './schema.js';
import type {
  Agent, ApprovalState, Creator, Heartbeat, NewRoutine, NewTask, Role, Routine, Task, TaskApproval, TaskEvent, TaskStatus,
} from './types.js';

export const TERMINAL: TaskStatus[] = ['done', 'rejected'];
const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  inbox: ['assigned', 'running', 'blocked', 'rejected', 'done'],
  assigned: ['inbox', 'running', 'blocked', 'rejected'],
  running: ['review', 'approval', 'done', 'blocked', 'rejected', 'assigned'],
  review: ['running', 'approval', 'done', 'blocked', 'rejected'],
  approval: ['done', 'rejected', 'blocked', 'running'],
  blocked: ['inbox', 'assigned', 'running', 'rejected'],
  done: [],
  rejected: [],
};

/**
 * Two clocks (owner decision 2026-11-19). `tz` is the company's: the market (Asia/Dushanbe), client bot hours, booking slots,
 * publishing times, deadlines. `owner_tz` is the owner's own (Asia/Kuala_Lumpur): the morning summary, the approval batch,
 * the weekly digest, alerts and quiet hours. `summary_time`, `approval_time`, `digest_time` and `quiet_hours` are read in `owner_tz`.
 * Quiet hours are empty here (so tests do not depend on the wall clock); `seedTiming` in the app writes 23:00-08:00 on first start.
 */
export const DEFAULT_SETTINGS: Record<string, string> = {
  tz: 'Asia/Dushanbe',
  owner_tz: 'Asia/Kuala_Lumpur',
  summary_time: '08:00',
  approval_time: '09:00',
  digest_time: '08:30',
  quiet_hours: '',
};
/** The quiet hours the app starts with (the owner's night, in `owner_tz`). */
export const DEFAULT_QUIET_HOURS = '23:00-08:00';

interface TaskRow {
  id: number; title: string; body: string; dept: string; assignee_id: string | null; creator: Creator; parent_id: number | null;
  status: TaskStatus; priority: number; due_at: number | null; result: string | null; cost_usd: number; meta: string; tags: string;
  routine_id: number | null; created_at: number; updated_at: number;
}
const toTask = (r: TaskRow): Task => ({
  id: r.id, title: r.title, body: r.body, dept: r.dept, assigneeId: r.assignee_id, creator: r.creator, parentId: r.parent_id,
  status: r.status, priority: r.priority, dueAt: r.due_at, result: r.result, costUsd: r.cost_usd,
  meta: JSON.parse(r.meta) as Record<string, unknown>, tags: r.tags ? r.tags.split(',') : [], routineId: r.routine_id,
  createdAt: r.created_at, updatedAt: r.updated_at,
});

interface AgentRow {
  id: string; dept: string; role: Role; title: string; instructions: string; boss_id: string | null; status: Agent['status'];
  trust_level: number; bot: string | null; budget_usd_month: number;
}
const toAgent = (r: AgentRow): Agent => ({
  id: r.id, dept: r.dept, role: r.role, title: syncedTitle(r.id, r.title), instructions: r.instructions, bossId: r.boss_id, status: r.status,
  trustLevel: r.trust_level, bot: r.bot, budgetUsdMonth: r.budget_usd_month,
});

interface RoutineRow {
  id: number; name: string; cron: string; dept: string; assignee_id: string | null; title: string; body: string; meta: string;
  priority: number; overlap: Routine['overlap']; enabled: number; tz: string | null; last_run_at: number | null; last_task_id: number | null;
}
const toRoutine = (r: RoutineRow): Routine => ({
  id: r.id, name: r.name, cron: r.cron, dept: r.dept, assigneeId: r.assignee_id, title: r.title, body: r.body,
  meta: JSON.parse(r.meta) as Record<string, unknown>, priority: r.priority, overlap: r.overlap, enabled: r.enabled === 1,
  tz: r.tz === 'owner' ? 'owner' : 'company', lastRunAt: r.last_run_at, lastTaskId: r.last_task_id,
});

interface LinkRow {
  id: number; task_id: number; approval_id: number | null; dept: string; kind: string; payload: string; summary: string;
  state: ApprovalState; held: number; created_at: number;
}
const toLink = (r: LinkRow): TaskApproval => ({
  id: r.id, taskId: r.task_id, approvalId: r.approval_id, dept: r.dept, kind: r.kind, payload: JSON.parse(r.payload) as Payload,
  summary: r.summary, state: r.state, held: r.held === 1, createdAt: r.created_at,
});

export interface CostInput {
  taskId?: number | null;
  agentId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Part of `inputTokens` read from the prompt cache (about 10% of the input price). */
  cacheReadTokens?: number;
  /** Explicit price; otherwise from the price table (`priceFor`). */
  usd?: number;
  /** A client is waiting on this call: the department's money limit alerts but does not block it. */
  urgent?: boolean;
}

export type { PriceTable } from '@fir/core';

/**
 * Prices written into the `prices` table once (never overwritten: the owner edits them with `setPrice`). The same numbers are
 * the built-in table of `@fir/core` (`MODEL_PRICES`); models neither know are counted at `UNKNOWN_MODEL_PRICE`, not at 0.
 */
export const DEFAULT_PRICES: PriceTable = MODEL_PRICES;

/** What kind of alert it is: the reminders the owner's Telegram gets (`docs/process-census.md`, «Один бот HQ»), or `other` (Пульт only). */
/** `human`: the lead manager's escalation (Fira, `escalation.ts`): a question the owner answers himself. */
export type AlertKind = 'lost_lead' | 'email_failed' | 'llm' | 'budget' | 'service' | 'human' | 'other';
export interface AlertOpts {
  kind?: AlertKind;
  /** One or two lines for Telegram, without contacts and client texts; absent: the first line of the text. */
  short?: string;
}

export interface TaskFilter {
  dept?: string;
  status?: TaskStatus | TaskStatus[];
  assigneeId?: string;
  parentId?: number;
  limit?: number;
  open?: boolean;
  /** Only tasks carrying this tag. */
  tag?: string;
}

/**
 * The company core: org, tasks, approvals, routines, heartbeats, costs, activity, settings on one SQLite.
 * Heads and workers use only this API; the Director bot is a thin client of it.
 */
export class Hq {
  private queue: ApprovalQueue | null = null;
  private readonly decisionSinks: ((link: TaskApproval, state: ApprovalState) => void)[] = [];
  private readonly alertSinks: ((text: string, o: AlertOpts) => Promise<void> | void)[] = [];
  readonly now: () => number;
  prices: PriceTable;

  constructor(readonly db: Db, opts: { now?: () => number; prices?: PriceTable } = {}) {
    db.exec(SCHEMA);
    // added later: which code block owns a routine (see `syncRoutines`)
    const rcols = db.prepare('PRAGMA table_info(routines)').all() as { name: string }[];
    if (!rcols.some((c) => c.name === 'source')) db.exec('ALTER TABLE routines ADD COLUMN source TEXT');
    if (!rcols.some((c) => c.name === 'edited_by_owner')) db.exec('ALTER TABLE routines ADD COLUMN edited_by_owner INTEGER NOT NULL DEFAULT 0');
    // which clock a routine runs on (company or owner), see `Routine.tz`
    if (!rcols.some((c) => c.name === 'tz')) db.exec("ALTER TABLE routines ADD COLUMN tz TEXT NOT NULL DEFAULT 'company'");
    // a proposal that belongs to a weekly pack is held back from the batch (see `TaskApproval.held`)
    const acols = db.prepare('PRAGMA table_info(task_approvals)').all() as { name: string }[];
    if (!acols.some((c) => c.name === 'held')) db.exec('ALTER TABLE task_approvals ADD COLUMN held INTEGER NOT NULL DEFAULT 0');
    this.now = opts.now ?? Date.now;
    const seed = db.prepare('INSERT OR IGNORE INTO prices (prefix, in_usd, out_usd) VALUES (?, ?, ?)');
    for (const [prefix, p] of Object.entries(DEFAULT_PRICES)) seed.run(prefix, p.in, p.out);
    // an old seed priced the gateway alias `auto` at 0: a model nobody resolved is not free (the owner can set it back with setPrice)
    db.prepare("DELETE FROM prices WHERE prefix = 'auto' AND in_usd = 0 AND out_usd = 0").run();
    this.prices = opts.prices ?? this.loadPrices();
  }

  /** The price table from the `prices` table. */
  loadPrices(): PriceTable {
    const rows = this.db.prepare('SELECT prefix, in_usd, out_usd FROM prices').all() as { prefix: string; in_usd: number; out_usd: number }[];
    return Object.fromEntries(rows.map((r) => [r.prefix, { in: r.in_usd, out: r.out_usd }] as const));
  }

  /** Sets USD per 1M tokens for a model name prefix (saved in the `prices` table and applied at once). */
  setPrice(prefix: string, inUsd: number, outUsd: number): void {
    if (!prefix || !(inUsd >= 0) || !(outUsd >= 0)) throw new Error('Bad price');
    this.db
      .prepare('INSERT INTO prices (prefix, in_usd, out_usd) VALUES (?, ?, ?) ON CONFLICT(prefix) DO UPDATE SET in_usd = excluded.in_usd, out_usd = excluded.out_usd')
      .run(prefix, inUsd, outUsd);
    this.prices = this.loadPrices();
  }

  // ---- agents ----
  upsertAgent(a: Partial<Agent> & Pick<Agent, 'id' | 'dept' | 'role' | 'title'>): Agent {
    this.db
      .prepare(
        `INSERT INTO agents (id, dept, role, title, instructions, boss_id, status, trust_level, bot, budget_usd_month)
         VALUES (@id, @dept, @role, @title, @instructions, @boss_id, @status, @trust_level, @bot, @budget)
         ON CONFLICT(id) DO UPDATE SET dept=excluded.dept, role=excluded.role, title=excluded.title, instructions=excluded.instructions,
           boss_id=excluded.boss_id, status=excluded.status, trust_level=excluded.trust_level, bot=excluded.bot, budget_usd_month=excluded.budget_usd_month`,
      )
      .run({
        id: a.id, dept: a.dept, role: a.role, title: a.title, instructions: a.instructions ?? '', boss_id: a.bossId ?? null,
        status: a.status ?? 'active', trust_level: a.trustLevel ?? 0, bot: a.bot ?? null, budget: a.budgetUsdMonth ?? 0,
      });
    return this.agent(a.id)!;
  }

  /** Inserts only when the agent does not exist yet (first start: instructions from files never overwrite edits). */
  ensureAgent(a: Partial<Agent> & Pick<Agent, 'id' | 'dept' | 'role' | 'title'>): Agent {
    return this.agent(a.id) ?? this.upsertAgent(a);
  }

  /** Stored titles that are still an old Russian job title become the English one (owner 2026-11-23); an owner's own edit stays. Returns the count. */
  syncAgentTitles(): number {
    let n = 0;
    for (const r of this.db.prepare('SELECT id, title FROM agents').all() as { id: string; title: string }[]) {
      const t = syncedTitle(r.id, r.title);
      if (t !== r.title) { this.db.prepare('UPDATE agents SET title = ? WHERE id = ?').run(t, r.id); n += 1; }
    }
    return n;
  }

  agent(id: string): Agent | undefined {
    const r = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined;
    return r ? toAgent(r) : undefined;
  }

  agents(dept?: string): Agent[] {
    const rows = (dept
      ? this.db.prepare('SELECT * FROM agents WHERE dept = ? ORDER BY role, id').all(dept)
      : this.db.prepare("SELECT * FROM agents ORDER BY dept, CASE role WHEN 'director' THEN 0 WHEN 'head' THEN 1 ELSE 2 END, id").all()) as AgentRow[];
    return rows.map(toAgent);
  }

  departments(): string[] {
    return (this.db.prepare("SELECT DISTINCT dept FROM agents WHERE role != 'director' ORDER BY dept").all() as { dept: string }[]).map((r) => r.dept);
  }

  headOf(dept: string): Agent | undefined {
    const r = this.db.prepare("SELECT * FROM agents WHERE dept = ? AND role = 'head' ORDER BY id LIMIT 1").get(dept) as AgentRow | undefined;
    return r ? toAgent(r) : undefined;
  }

  /**
   * Replaces the instructions and keeps the history (`instruction_versions`): the first change also stores the text that was there
   * before as version 1, so a rollback to the original is always possible. No row when the text is the same.
   */
  setInstructions(agentId: string, instructions: string, actor = 'director', note = ''): void {
    const agent = this.agent(agentId);
    if (!agent) throw new Error(`Unknown agent ${agentId}`);
    if (agent.instructions === instructions) return;
    const at = this.now();
    const insert = this.db.prepare('INSERT INTO instruction_versions (agent_id, version, text, actor, note, at) VALUES (?, ?, ?, ?, ?, ?)');
    const last = this.db.prepare('SELECT MAX(version) v FROM instruction_versions WHERE agent_id = ?').get(agentId) as { v: number | null };
    let version = last.v ?? 0;
    if (version === 0 && agent.instructions) insert.run(agentId, ++version, agent.instructions, 'seed', '', at);
    insert.run(agentId, version + 1, instructions, actor, note, at);
    this.db.prepare('UPDATE agents SET instructions = ? WHERE id = ?').run(instructions, agentId);
    this.log(actor, 'instructions_changed', 'agent', agentId);
  }

  /** The saved versions of an agent's instructions, newest first (text included only on request). */
  instructionVersions(agentId: string): { version: number; actor: string; note: string; at: number; chars: number }[] {
    return (this.db.prepare('SELECT version, actor, note, at, LENGTH(text) chars FROM instruction_versions WHERE agent_id = ? ORDER BY version DESC').all(agentId) as {
      version: number; actor: string; note: string; at: number; chars: number;
    }[]);
  }

  instructionVersion(agentId: string, version: number): { version: number; text: string; actor: string; note: string; at: number } | undefined {
    return this.db.prepare('SELECT version, text, actor, note, at FROM instruction_versions WHERE agent_id = ? AND version = ?').get(agentId, version) as
      | { version: number; text: string; actor: string; note: string; at: number }
      | undefined;
  }

  setDeptStatus(dept: string, status: Agent['status']): number {
    const n = this.db.prepare("UPDATE agents SET status = ? WHERE dept = ? AND role != 'director'").run(status, dept).changes;
    this.log('director', status === 'paused' ? 'dept_paused' : 'dept_resumed', 'dept', dept);
    return n;
  }

  // ---- tasks ----
  createTask(t: NewTask): Task {
    const now = this.now();
    const status: TaskStatus = t.assigneeId ? 'assigned' : 'inbox';
    const r = this.db
      .prepare(
        `INSERT INTO tasks (title, body, dept, assignee_id, creator, parent_id, status, priority, due_at, meta, tags, routine_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        t.title, t.body ?? '', t.dept, t.assigneeId ?? null, t.creator, t.parentId ?? null, status, t.priority ?? 0, t.dueAt ?? null,
        JSON.stringify(t.meta ?? {}), (t.tags ?? []).join(','), t.routineId ?? null, now, now,
      );
    const id = Number(r.lastInsertRowid);
    this.addEvent(id, 'status', t.creator, `created: ${status}`);
    this.log(t.creator, 'task_created', 'task', String(id));
    return this.task(id)!;
  }

  task(id: number): Task | undefined {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return r ? toTask(r) : undefined;
  }

  tasks(f: TaskFilter = {}): Task[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (f.dept) { where.push('dept = ?'); args.push(f.dept); }
    if (f.assigneeId) { where.push('assignee_id = ?'); args.push(f.assigneeId); }
    if (f.parentId !== undefined) { where.push('parent_id = ?'); args.push(f.parentId); }
    if (f.status) {
      const list = Array.isArray(f.status) ? f.status : [f.status];
      where.push(`status IN (${list.map(() => '?').join(',')})`);
      args.push(...list);
    }
    if (f.open) where.push("status NOT IN ('done','rejected')");
    if (f.tag) { where.push("(',' || tags || ',') LIKE ?"); args.push(`%,${f.tag},%`); }
    const sql = `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY priority DESC, id ASC LIMIT ?`;
    return (this.db.prepare(sql).all(...args, f.limit ?? 200) as TaskRow[]).map(toTask);
  }

  private move(id: number, to: TaskStatus, actor: string, note = ''): void {
    const t = this.task(id);
    if (!t) throw new Error(`Unknown task ${id}`);
    if (t.status === to) return;
    if (!TRANSITIONS[t.status].includes(to)) throw new Error(`Task ${id}: ${t.status} -> ${to} is not allowed`);
    this.db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run(to, this.now(), id);
    this.addEvent(id, 'status', actor, `${t.status} -> ${to}${note ? `: ${note}` : ''}`);
  }

  assign(taskId: number, agentId: string, actor = 'director'): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('UPDATE tasks SET assignee_id = ?, updated_at = ? WHERE id = ?').run(agentId, this.now(), taskId);
      if (this.task(taskId)?.status === 'inbox') this.move(taskId, 'assigned', actor);
      this.addEvent(taskId, 'assign', actor, agentId);
    });
    tx();
  }

  /**
   * Atomic take: only one agent wins a task in inbox/assigned (and not assigned to someone else).
   * Returns false when someone else got it or the task moved on.
   */
  claim(taskId: number, agentId: string): boolean {
    const won = this.db.transaction(() => {
      const r = this.db
        .prepare(
          `UPDATE tasks SET status = 'running', assignee_id = ?, updated_at = ?
           WHERE id = ? AND status IN ('inbox','assigned') AND (assignee_id IS NULL OR assignee_id = ?)`,
        )
        .run(agentId, this.now(), taskId, agentId);
      if (r.changes !== 1) return false;
      this.addEvent(taskId, 'status', agentId, 'claimed: running');
      return true;
    })();
    if (won) this.log(agentId, 'task_claimed', 'task', String(taskId));
    return won;
  }

  /**
   * Call once at process start: a task still `running` was cut off by a restart or a deploy (its worker died with the
   * process), so it goes back to `assigned` and its head takes it again. Returns the ids put back.
   */
  recoverInterrupted(actor = 'director'): number[] {
    const rows = this.db.prepare("SELECT id FROM tasks WHERE status = 'running'").all() as { id: number }[];
    for (const r of rows) {
      this.db.prepare("UPDATE tasks SET status = 'assigned', updated_at = ? WHERE id = ? AND status = 'running'").run(this.now(), r.id);
      this.addEvent(r.id, 'status', actor, 'running -> assigned: interrupted by a restart');
    }
    if (rows.length) this.log(actor, 'tasks_recovered', 'tasks', String(rows.length));
    return rows.map((r) => r.id);
  }

  comment(taskId: number, actor: string, body: string): void {
    this.addEvent(taskId, 'comment', actor, body);
  }

  setStatus(taskId: number, to: TaskStatus, actor: string, note = ''): void {
    this.move(taskId, to, actor, note);
  }

  /** Stores the result; `status` defaults to done. */
  complete(taskId: number, actor: string, result: string, status: 'done' | 'review' | 'approval' = 'done'): void {
    this.db.prepare('UPDATE tasks SET result = ?, updated_at = ? WHERE id = ?').run(result, this.now(), taskId);
    this.addEvent(taskId, 'result', actor, result.slice(0, 2000));
    this.move(taskId, status, actor);
    this.log(actor, status === 'done' ? 'task_done' : `task_${status}`, 'task', String(taskId));
  }

  /** Puts a task into blocked with the reason in its journal; optional tags (e.g. "builder") for the main window. */
  block(taskId: number, actor: string, reason: string, tags: string[] = []): void {
    const t = this.task(taskId);
    if (!t) throw new Error(`Unknown task ${taskId}`);
    if (tags.length) {
      const all = [...new Set([...t.tags, ...tags])];
      this.db.prepare('UPDATE tasks SET tags = ? WHERE id = ?').run(all.join(','), taskId);
    }
    this.addEvent(taskId, 'error', actor, reason);
    this.move(taskId, 'blocked', actor, reason.slice(0, 100));
    this.log(actor, 'task_blocked', 'task', String(taskId));
  }

  /** Adds tags to a task (keeps the ones it has, no duplicates). */
  addTags(taskId: number, tags: string[]): void {
    const t = this.task(taskId);
    if (!t) throw new Error(`Unknown task ${taskId}`);
    const all = [...new Set([...t.tags, ...tags])];
    this.db.prepare('UPDATE tasks SET tags = ? WHERE id = ?').run(all.join(','), taskId);
  }

  /** Removes a task with its journal and approval links (used by the drill cleanup; real tasks are never deleted). */
  deleteTask(taskId: number): void {
    this.db.transaction(() => {
      for (const table of ['task_events', 'task_approvals']) this.db.prepare(`DELETE FROM ${table} WHERE task_id = ?`).run(taskId);
      this.db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
    })();
  }

  setMeta(taskId: number, patch: Record<string, unknown>): void {
    const t = this.task(taskId);
    if (!t) throw new Error(`Unknown task ${taskId}`);
    this.db.prepare('UPDATE tasks SET meta = ?, updated_at = ? WHERE id = ?').run(JSON.stringify({ ...t.meta, ...patch }), this.now(), taskId);
  }

  addEvent(taskId: number, kind: string, actor: string | null, body: string): void {
    this.db.prepare('INSERT INTO task_events (task_id, kind, actor, body, at) VALUES (?, ?, ?, ?, ?)').run(taskId, kind, actor, body, this.now());
  }

  events(taskId: number): TaskEvent[] {
    return (this.db.prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY id').all(taskId) as {
      id: number; task_id: number; kind: string; actor: string | null; body: string; at: number;
    }[]).map((r) => ({ id: r.id, taskId: r.task_id, kind: r.kind, actor: r.actor, body: r.body, at: r.at }));
  }

  countByStatus(dept?: string): Record<TaskStatus, number> {
    const out: Record<TaskStatus, number> = { inbox: 0, assigned: 0, running: 0, review: 0, approval: 0, done: 0, blocked: 0, rejected: 0 };
    const rows = (dept
      ? this.db.prepare('SELECT status, COUNT(*) c FROM tasks WHERE dept = ? GROUP BY status').all(dept)
      : this.db.prepare('SELECT status, COUNT(*) c FROM tasks GROUP BY status').all()) as { status: TaskStatus; c: number }[];
    for (const r of rows) out[r.status] = r.c;
    return out;
  }

  /**
   * Owner's `/retry`: a blocked task goes back to its department's inbox without an assignee, so the head takes it again.
   * Returns false when the task is not blocked.
   */
  requeue(taskId: number, actor = 'owner'): boolean {
    const t = this.task(taskId);
    if (!t || t.status !== 'blocked') return false;
    this.db.prepare('UPDATE tasks SET assignee_id = NULL WHERE id = ?').run(taskId);
    this.move(taskId, 'inbox', actor, 'retry');
    this.addEvent(taskId, 'comment', actor, 'retry');
    this.log(actor, 'task_retried', 'task', String(taskId));
    return true;
  }

  /** Latest journal events across all tasks (newest first), without drill tasks. */
  recentEvents(limit = 30): (TaskEvent & { title: string; dept: string })[] {
    return (this.db
      .prepare(
        `SELECT e.*, t.title title, t.dept dept FROM task_events e JOIN tasks t ON t.id = e.task_id
         WHERE (',' || t.tags || ',') NOT LIKE '%,drill,%' ORDER BY e.id DESC LIMIT ?`,
      )
      .all(limit) as { id: number; task_id: number; kind: string; actor: string | null; body: string; at: number; title: string; dept: string }[]).map((r) => ({
      id: r.id, taskId: r.task_id, kind: r.kind, actor: r.actor, body: r.body, at: r.at, title: r.title, dept: r.dept,
    }));
  }

  // ---- LLM calls in flight (for the office's "thinking") ----
  private readonly llmInFlight = new Map<string, number>();

  /** Marks an LLM call of an agent as started; call the returned function when it ends. Logs `llm.call` to the activity. */
  beginLlm(agentId: string): () => void {
    this.llmInFlight.set(agentId, (this.llmInFlight.get(agentId) ?? 0) + 1);
    this.log(agentId, 'llm.call');
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const n = (this.llmInFlight.get(agentId) ?? 1) - 1;
      if (n <= 0) this.llmInFlight.delete(agentId);
      else this.llmInFlight.set(agentId, n);
    };
  }

  /** True while an LLM call of the agent is in flight. */
  thinking(agentId: string): boolean {
    return (this.llmInFlight.get(agentId) ?? 0) > 0;
  }

  // ---- approvals (core queue + link to the task) ----
  attachQueue(queue: ApprovalQueue): void {
    this.queue = queue;
  }

  private q(): ApprovalQueue {
    if (!this.queue) throw new Error('No ApprovalQueue attached (hq.attachQueue)');
    return this.queue;
  }

  private readonly urgentKinds = new Set<string>();

  /**
   * Registers an approval kind in the core queue (money and prices: `locked: true`, always level 0).
   * `urgent: true`: a client is waiting on it, so each proposal goes to the owner at once as its own card instead of
   * waiting for the next batch.
   */
  registerKind(kind: string, spec: KindSpec, opts: { urgent?: boolean } = {}): void {
    this.q().register(kind, spec);
    if (opts.urgent) this.urgentKinds.add(kind);
  }

  /**
   * The head asks for the owner's decision. At level 0 the proposal waits in the queue and reaches the owner in the
   * Director's batch (`releaseApprovals`), unless its kind is urgent (`registerKind` option); at level 1 the core runs it at once and reports. The task goes to `approval`.
   */
  async requestApproval(taskId: number, actor: string, kind: string, payload: Payload, summary: string): Promise<number> {
    const t = this.task(taskId);
    if (!t) throw new Error(`Unknown task ${taskId}`);
    const r = this.db
      .prepare('INSERT INTO task_approvals (task_id, dept, kind, payload, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(taskId, t.dept, kind, JSON.stringify(payload), summary, this.now());
    const linkId = Number(r.lastInsertRowid);
    if (t.status === 'running' || t.status === 'review') this.move(taskId, 'approval', actor);
    this.addEvent(taskId, 'approval', actor, `${kind}: queued`);
    this.log(actor, 'approval_requested', 'task', String(taskId));
    const urgent = this.urgentKinds.has(kind);
    if (urgent || this.q().level(kind) === 1) {
      if (!(await this.askOne(linkId, urgent ? `Срочно, ${t.dept}, задача #${taskId}\n` : ''))) void this.alert(`Одобрение «${kind}» (задача #${taskId}) не отправилось в Telegram, оно уйдёт со следующей пачкой.`);
      this.reconcileApprovals();
    }
    return linkId;
  }

  approvalLink(id: number): TaskApproval | undefined {
    const r = this.db.prepare('SELECT * FROM task_approvals WHERE id = ?').get(id) as LinkRow | undefined;
    return r ? toLink(r) : undefined;
  }

  approvalByCoreId(approvalId: number): TaskApproval | undefined {
    const r = this.db.prepare('SELECT * FROM task_approvals WHERE approval_id = ?').get(approvalId) as LinkRow | undefined;
    return r ? toLink(r) : undefined;
  }

  /** Proposals that wait for the next batch (the ones held back for a weekly pack's card are not here, see `heldApprovals`). */
  queuedApprovals(): TaskApproval[] {
    return (this.db.prepare("SELECT * FROM task_approvals WHERE state = 'queued' AND held = 0 ORDER BY dept, id").all() as LinkRow[]).map(toLink);
  }

  /** Queued proposals held back for a pack's card, of the given tasks (all of them when none is given). */
  heldApprovals(taskIds?: number[]): TaskApproval[] {
    const rows = this.db.prepare("SELECT * FROM task_approvals WHERE state = 'queued' AND held = 1 ORDER BY id").all() as LinkRow[];
    return rows.map(toLink).filter((l) => !taskIds || taskIds.includes(l.taskId));
  }

  /** Holds queued proposals back from the batch: a pack's card stands for them (nothing is sent to the owner for them). */
  holdApprovals(linkIds: number[]): number {
    let n = 0;
    for (const id of linkIds) n += this.db.prepare("UPDATE task_approvals SET held = 1 WHERE id = ? AND state = 'queued'").run(id).changes;
    return n;
  }

  /** The owner opens a pack: its held proposals go out one by one, each as its own card, at once. Returns how many reached Telegram. */
  async releaseHeld(linkIds: number[]): Promise<number> {
    let sent = 0;
    for (const id of linkIds) {
      this.db.prepare("UPDATE task_approvals SET held = 0 WHERE id = ? AND state = 'queued'").run(id);
      if (await this.askOne(id, '')) sent++;
    }
    this.reconcileApprovals();
    return sent;
  }

  /**
   * The owner decides a held proposal through its pack. Makes its core approval row without sending a card and returns the id
   * (the caller runs `queue.handle('approve', id)`); the link becomes `asked`, so `reconcileApprovals` follows the outcome.
   */
  openHeld(linkId: number): number | null {
    const l = this.approvalLink(linkId);
    if (!l || l.state !== 'queued' || !l.held) return null;
    const id = this.q().open(l.kind, l.payload, l.summary);
    this.db.prepare("UPDATE task_approvals SET approval_id = ?, state = 'asked', held = 0 WHERE id = ?").run(id, linkId);
    return id;
  }

  /**
   * The owner decides a proposal that was never sent as a card (queued for the batch, or held for a pack) from the workplace.
   * Makes its core approval row without a card and returns the id (the caller runs `queue.handle`); the link becomes `asked`.
   */
  openQueued(linkId: number): number | null {
    const l = this.approvalLink(linkId);
    if (!l || l.state !== 'queued') return null;
    // a card that failed to send earlier already has its core row: the same one is decided (never a second proposal)
    const id = l.approvalId ?? this.q().open(l.kind, l.payload, l.summary);
    this.db.prepare("UPDATE task_approvals SET approval_id = ?, state = 'asked', held = 0 WHERE id = ?").run(id, linkId);
    return id;
  }

  /** The owner rejects a held proposal through its pack: the link is closed as rejected and the task follows. */
  rejectHeld(linkId: number): boolean {
    const l = this.approvalLink(linkId);
    if (!l || l.state !== 'queued' || !l.held) return false;
    this.db.prepare("UPDATE task_approvals SET state = 'rejected', held = 0 WHERE id = ?").run(linkId);
    this.settleLink(this.db.prepare('SELECT * FROM task_approvals WHERE id = ?').get(linkId) as LinkRow, 'rejected', false);
    return true;
  }

  /**
   * Sends one proposal to the owner. The link records the core approval id as soon as the row exists, but is marked `asked`
   * only after Telegram confirmed the card. When the send failed earlier, the same card is shown again (no second proposal
   * for the same task). Returns false when the card could not be sent now (it stays `queued` and goes with the next batch).
   */
  private async askOne(linkId: number, prefix: string): Promise<boolean> {
    const l = this.approvalLink(linkId)!;
    if (l.state !== 'queued') return true;
    try {
      if (l.approvalId !== null) {
        const row = this.q().get(l.approvalId);
        // decided meanwhile (e.g. through /approve): reconcile picks it up; otherwise send the existing card again
        if (row && (row.status === 'pending' || row.status === 'editing')) await this.q().showCard(l.approvalId);
      } else {
        const { id } = await this.q().propose(l.kind, l.payload, `${prefix}${l.summary}`, {
          onCreated: (cid) => void this.db.prepare('UPDATE task_approvals SET approval_id = ? WHERE id = ?').run(cid, linkId),
        });
        this.db.prepare('UPDATE task_approvals SET approval_id = ? WHERE id = ?').run(id, linkId);
      }
    } catch (e) {
      this.log('hq', 'approval_send_failed', 'task', String(l.taskId), `${l.kind}: ${errMsg(e).slice(0, 120)}`);
      return false;
    }
    this.db.prepare("UPDATE task_approvals SET state = 'asked' WHERE id = ? AND state = 'queued'").run(linkId);
    return true;
  }

  /**
   * The owner's batch: every queued proposal of every department goes out as one numbered series (the core sends each with
   * its buttons, one by one through the Telegram queue). A card that fails (after the retries) does not stop the rest and
   * leaves no orphan: it stays queued with its row and is sent again next time without a duplicate. Returns how many were sent.
   */
  async releaseApprovals(): Promise<number> {
    const queued = this.queuedApprovals();
    let sent = 0;
    for (const [i, l] of queued.entries()) {
      if (!(await this.askOne(l.id, `[${i + 1}/${queued.length}] ${l.dept}, задача #${l.taskId}\n`))) continue;
      sent++;
      this.addEvent(l.taskId, 'approval', 'director', `${l.kind}: sent to the owner`);
    }
    this.reconcileApprovals();
    if (sent < queued.length) void this.alert(`Одобрения: отправлено ${sent} из ${queued.length}, остальные уйдут со следующей пачкой (или /approve).`);
    return sent;
  }

  /** Called for every proposal the owner decided (executed, rejected or failed), e.g. to update a worker's own tables. */
  onApprovalDecision(sink: (link: TaskApproval, state: ApprovalState) => void): void {
    this.decisionSinks.push(sink);
  }

  /** Brings tasks in line with the core queue's decisions (approved: done, rejected: rejected, failed: blocked). */
  reconcileApprovals(): number {
    const asked = this.db.prepare("SELECT * FROM task_approvals WHERE state = 'asked' AND approval_id IS NOT NULL").all() as LinkRow[];
    let changed = 0;
    for (const row of asked) {
      const status = this.q().get(row.approval_id!)?.status;
      const next: ApprovalState | null = status === 'executed' ? 'executed' : status === 'rejected' ? 'rejected' : status === 'failed' ? 'failed' : null;
      if (!next) continue;
      try {
        this.settleLink(row, next, true);
      } catch (e) {
        // one broken link (a sink that throws) must not stop the owner's decision or the links after it
        coreLog('error', 'approval reconcile failed', { link: row.id, err: errMsg(e) });
        this.db.prepare('UPDATE task_approvals SET state = ? WHERE id = ?').run(next, row.id);
      }
      changed++;
    }
    return changed;
  }

  /** One link reached its outcome: sinks hear it, the task follows (done when something was approved and nothing is open, rejected, or blocked on failure). */
  private settleLink(row: LinkRow, next: ApprovalState, write: boolean): void {
    if (write) this.db.prepare('UPDATE task_approvals SET state = ? WHERE id = ?').run(next, row.id);
    this.log('owner', 'approval_decided', 'task', String(row.task_id), next);
    for (const sink of this.decisionSinks) {
      try {
        sink(this.approvalLink(row.id)!, next);
      } catch (e) {
        coreLog('error', 'approval decision sink failed', { link: row.id, err: errMsg(e) }); // the task still follows the owner's decision
      }
    }
    const open = this.db.prepare("SELECT COUNT(*) c FROM task_approvals WHERE task_id = ? AND state IN ('queued','asked')").get(row.task_id) as { c: number };
    const t = this.task(row.task_id);
    if (!t || TERMINAL.includes(t.status)) return;
    this.addEvent(row.task_id, 'approval', 'owner', `${row.kind}: ${next}`);
    if (next === 'failed') this.block(row.task_id, 'owner', `approval ${row.kind} failed to execute`);
    else if (open.c === 0) {
      const all = this.db.prepare('SELECT state FROM task_approvals WHERE task_id = ?').all(row.task_id) as { state: ApprovalState }[];
      const anyOk = all.some((a) => a.state === 'executed');
      // a task blocked meanwhile (another of its approvals failed, /builder, a spending limit) cannot go to done: it stays blocked for /retry
      if (anyOk && t.status === 'blocked') return;
      this.move(row.task_id, anyOk ? 'done' : 'rejected', 'owner');
      this.log('owner', anyOk ? 'approved' : 'rejected', 'task', String(row.task_id));
    }
  }

  // ---- routines ----
  /**
   * Creates or replaces a routine by hand (the owner's org import, an edit): it is then marked `edited_by_owner`, and
   * `syncRoutines` keeps its cron and title from then on.
   */
  scheduleRoutine(r: NewRoutine): Routine {
    const out = this.upsertRoutine(r);
    this.db.prepare('UPDATE routines SET edited_by_owner = 1 WHERE name = ?').run(r.name);
    return out;
  }

  private upsertRoutine(r: NewRoutine): Routine {
    this.db
      .prepare(
        `INSERT INTO routines (name, cron, dept, assignee_id, title, body, meta, priority, overlap, enabled, tz)
         VALUES (@name, @cron, @dept, @assignee, @title, @body, @meta, @priority, @overlap, @enabled, @tz)
         ON CONFLICT(name) DO UPDATE SET cron=excluded.cron, dept=excluded.dept, assignee_id=excluded.assignee_id, title=excluded.title,
           body=excluded.body, meta=excluded.meta, priority=excluded.priority, overlap=excluded.overlap, enabled=excluded.enabled, tz=excluded.tz`,
      )
      .run({
        name: r.name, cron: r.cron, dept: r.dept, assignee: r.assigneeId ?? null, title: r.title, body: r.body ?? '',
        meta: JSON.stringify(r.meta ?? {}), priority: r.priority ?? 0, overlap: r.overlap ?? 'skip', enabled: r.enabled === false ? 0 : 1,
        tz: r.tz === 'owner' ? 'owner' : 'company',
      });
    return this.routineByName(r.name)!;
  }

  /**
   * The owner switches a routine on or off from the workplace. Switching it off also marks it as edited by the owner, so the next start
   * (`syncRoutines`) does not turn it back on; switching it on leaves that mark (the owner has taken the routine into his hands).
   * Returns the routine, or undefined for an unknown name.
   */
  setRoutineEnabled(name: string, enabled: boolean): Routine | undefined {
    if (!this.routineByName(name)) return undefined;
    this.db.prepare(`UPDATE routines SET enabled = ?${enabled ? '' : ', edited_by_owner = 1'} WHERE name = ?`).run(enabled ? 1 : 0, name);
    this.log('owner', enabled ? 'routine_enabled' : 'routine_disabled', 'routine', name);
    return this.routineByName(name);
  }

  routineByName(name: string): Routine | undefined {
    const r = this.db.prepare('SELECT * FROM routines WHERE name = ?').get(name) as RoutineRow | undefined;
    return r ? toRoutine(r) : undefined;
  }

  routines(): Routine[] {
    return (this.db.prepare('SELECT * FROM routines ORDER BY id').all() as RoutineRow[]).map(toRoutine);
  }

  /**
   * Makes the routines a block of code defines (`source`: "marketing", "sales"...) the routines of the database: new ones are
   * created, a changed cron/title/body/meta/priority/overlap is updated, and ones the code no longer defines are disabled
   * (never deleted: their history stays). Routines of other sources are left alone, and so are routines the owner edited by
   * hand (`scheduleRoutine`, e.g. an org import: flag `edited_by_owner`). Returns what changed.
   */
  syncRoutines(source: string, defs: NewRoutine[]): { created: string[]; updated: string[]; disabled: string[] } {
    const out = { created: [] as string[], updated: [] as string[], disabled: [] as string[] };
    this.db.transaction(() => {
      for (const d of defs) {
        const cur = this.routineByName(d.name);
        const edited = cur ? (this.db.prepare('SELECT edited_by_owner e FROM routines WHERE name = ?').get(d.name) as { e: number }).e === 1 : false;
        const next = { cron: d.cron, dept: d.dept, title: d.title, body: d.body ?? '', meta: d.meta ?? {}, priority: d.priority ?? 0, overlap: d.overlap ?? 'skip', enabled: d.enabled !== false, assigneeId: d.assigneeId ?? null, tz: d.tz === 'owner' ? 'owner' : 'company' };
        if (!cur) {
          this.upsertRoutine(d);
          out.created.push(d.name);
        } else if (!edited) {
          const same = cur.cron === next.cron && cur.dept === next.dept && cur.title === next.title && cur.body === next.body
            && JSON.stringify(cur.meta) === JSON.stringify(next.meta) && cur.priority === next.priority && cur.overlap === next.overlap
            && cur.enabled === next.enabled && cur.assigneeId === next.assigneeId && cur.tz === next.tz;
          if (!same) {
            this.upsertRoutine(d);
            out.updated.push(d.name);
          }
        }
        this.db.prepare('UPDATE routines SET source = ? WHERE name = ?').run(source, d.name);
      }
      const names = new Set(defs.map((d) => d.name));
      const mine = this.db.prepare('SELECT name FROM routines WHERE source = ? AND enabled = 1 AND edited_by_owner = 0').all(source) as { name: string }[];
      for (const r of mine) {
        if (names.has(r.name)) continue;
        this.db.prepare('UPDATE routines SET enabled = 0 WHERE name = ?').run(r.name);
        out.disabled.push(r.name);
      }
    })();
    if (out.created.length || out.updated.length || out.disabled.length) {
      this.log('hq', 'routines_synced', 'source', source, `+${out.created.length} ~${out.updated.length} -${out.disabled.length}`);
    }
    return out;
  }

  /**
   * Fires a routine: creates its task (creator `routine`) and wakes the department head. With the `skip` policy nothing is
   * created while the previous task of the routine is still moving (inbox, assigned, running, review, approval). A previous
   * task that ended `blocked` is a failure, not a reason to stop: the routine fires again, the outcome is logged, and after
   * three skips in a row the owner gets an alert. Returns the task or null when skipped.
   */
  runRoutine(name: string): Task | null {
    const r = this.routineByName(name);
    if (!r || !r.enabled) return null;
    const skipKey = `routine_skips:${name}`;
    let prevOutcome = '';
    if (r.overlap === 'skip' && r.lastTaskId !== null) {
      const prev = this.task(r.lastTaskId);
      if (prev && !TERMINAL.includes(prev.status)) {
        if (prev.status !== 'blocked') {
          const n = Number(this.setting(skipKey) || '0') + 1;
          this.setSetting(skipKey, String(n));
          this.log('routine', 'routine_skipped', 'routine', name, `previous #${prev.id} is ${prev.status}`);
          if (n === 3) void this.alert(`Рутина «${name}» пропущена 3 раза подряд: прошлая задача #${prev.id} всё ещё ${prev.status}.`);
          return null;
        }
        prevOutcome = `previous #${prev.id} ended blocked`;
      } else if (prev) prevOutcome = `previous #${prev.id} ${prev.status}`;
    }
    this.setSetting(skipKey, '0');
    const t = this.createTask({
      title: r.title, body: r.body, dept: r.dept, assigneeId: r.assigneeId, creator: 'routine', priority: r.priority, meta: { ...r.meta, routine: name },
      routineId: r.id,
    });
    this.db.prepare('UPDATE routines SET last_run_at = ?, last_task_id = ? WHERE id = ?').run(this.now(), t.id, r.id);
    this.log('routine', 'routine_fired', 'routine', name, prevOutcome || undefined);
    const target = r.assigneeId ?? this.headOf(r.dept)?.id;
    if (target) this.wake(target, 'schedule');
    return t;
  }

  // ---- heartbeats ----
  /** Queues a wake-up. A pending one for the same agent is reused (earliest time wins, reasons are merged). */
  wake(agentId: string, reason: 'task' | 'message' | 'schedule', dueAt = this.now()): number {
    const cur = this.db.prepare("SELECT * FROM heartbeats WHERE agent_id = ? AND status = 'pending' ORDER BY id LIMIT 1").get(agentId) as
      | { id: number; reason: string; due_at: number; wakes: number }
      | undefined;
    if (cur) {
      const reasons = [...new Set([...cur.reason.split(','), reason])].join(',');
      this.db.prepare('UPDATE heartbeats SET reason = ?, due_at = ?, wakes = ? WHERE id = ?').run(reasons, Math.min(cur.due_at, dueAt), cur.wakes + 1, cur.id);
      return cur.id;
    }
    return Number(this.db.prepare('INSERT INTO heartbeats (agent_id, reason, due_at, created_at) VALUES (?, ?, ?, ?)').run(agentId, reason, dueAt, this.now()).lastInsertRowid);
  }

  /** Due wake-ups, one per agent (not paused, not in `busy`), at most `limit`; they are marked delivered. */
  claimDueHeartbeats(busy: ReadonlySet<string> = new Set(), limit = Infinity): Heartbeat[] {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT h.* FROM heartbeats h JOIN agents a ON a.id = h.agent_id
           WHERE h.status = 'pending' AND h.due_at <= ? AND a.status = 'active' ORDER BY h.id`,
        )
        .all(this.now()) as { id: number; agent_id: string; reason: string; due_at: number; wakes: number }[];
      const out: Heartbeat[] = [];
      for (const r of rows) {
        if (out.length >= limit) break;
        if (busy.has(r.agent_id) || out.some((o) => o.agentId === r.agent_id)) continue;
        this.db.prepare("UPDATE heartbeats SET status = 'delivered' WHERE id = ?").run(r.id);
        out.push({ id: r.id, agentId: r.agent_id, reason: r.reason, dueAt: r.due_at, wakes: r.wakes });
      }
      return out;
    })();
  }

  pendingHeartbeats(): number {
    return (this.db.prepare("SELECT COUNT(*) c FROM heartbeats WHERE status = 'pending'").get() as { c: number }).c;
  }

  // ---- settings ----
  setting(key: string): string {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value ?? DEFAULT_SETTINGS[key] ?? '';
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  allSettings(): Record<string, string> {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    return { ...DEFAULT_SETTINGS, ...Object.fromEntries(rows.map((r) => [r.key, r.value] as const)) };
  }

  /** The company's timezone: the market, the clients, publishing times. */
  get tz(): string {
    return this.setting('tz');
  }

  /** The owner's timezone: what is addressed to him (summary, batch, digest, alerts, quiet hours) is read on this clock. */
  get ownerTz(): string {
    return this.setting('owner_tz') || DEFAULT_SETTINGS.owner_tz!;
  }

  /** The timezone a routine's cron runs in. */
  routineTz(r: Pick<Routine, 'tz'>): string {
    return r.tz === 'owner' ? this.ownerTz : this.tz;
  }

  /** True inside the "quiet hours" window (setting `quiet_hours`, "23:00-08:00" in the owner's timezone). */
  isQuiet(at = this.now()): boolean {
    const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(this.setting('quiet_hours'));
    if (!m) return false;
    const p = zonedParts(at, this.ownerTz);
    const cur = p.h * 60 + p.mi;
    const from = Number(m[1]) * 60 + Number(m[2]);
    const to = Number(m[3]) * 60 + Number(m[4]);
    return from <= to ? cur >= from && cur < to : cur >= from || cur < to;
  }

  // ---- costs ----
  /** Department budget: the monthly limit of its head (0 = no limit). */
  deptBudget(dept: string): number {
    return this.budgetAgent(dept)?.budgetUsdMonth ?? 0;
  }

  /** The agent that carries a department's limit: its head; the Director's own work (`hq`, `director`) is limited on the Director. */
  budgetAgent(dept: string): Agent | undefined {
    return dept === 'hq' || dept === 'director' ? this.agent('director') : this.headOf(dept);
  }

  /** Sets the monthly limit (USD, 0 = none) of a department at once: `overBudget` and the 80% / 100% alerts read it on the next cost. False for an unknown department. */
  setDeptBudget(dept: string, usd: number): boolean {
    const a = this.budgetAgent(dept);
    if (!a) return false;
    this.db.prepare('UPDATE agents SET budget_usd_month = ? WHERE id = ?').run(usd, a.id);
    return true;
  }

  monthStart(at = this.now()): number {
    const p = zonedParts(at, this.tz);
    return zonedToMs(p.y, p.mo, 1, 0, 0, this.tz);
  }

  monthSpend(dept: string, at = this.now()): number {
    const r = this.db.prepare('SELECT COALESCE(SUM(usd), 0) s FROM costs WHERE dept = ? AND at >= ?').get(dept, this.monthStart(at)) as { s: number };
    return r.s;
  }

  overBudget(dept: string): boolean {
    const limit = this.deptBudget(dept);
    return limit > 0 && this.monthSpend(dept) >= limit;
  }

  /** A task or call the owner cannot wait on: a client is waiting, or priority 2. Such work is never stopped by a money limit (it only alerts). */
  isUrgent(taskId?: number | null, urgent?: boolean): boolean {
    if (urgent) return true;
    const t = taskId ? this.task(taskId) : undefined;
    return (t?.priority ?? 0) >= 2;
  }

  /**
   * Records token usage, priced by the model that really answered (`priceFor`: the owner's rows, the built-in table, `:free`
   * models, else the unknown-model estimate). The owner gets one alert per department and month at 80% of the limit and one
   * at 100%; at 100% a non-urgent task is put into `blocked` (and `meterLlm` refuses its next calls), urgent work goes on.
   */
  recordCost(c: CostInput): { usd: number; blocked: boolean } {
    const agent = this.agent(c.agentId);
    if (!agent) throw new Error(`Unknown agent ${c.agentId}`);
    const priced = priceFor(c.model, this.prices);
    if (priced.source === 'unknown' && c.usd === undefined) {
      const key = `unknown_model:${c.model.slice(0, 80)}`;
      if (!this.db.prepare('SELECT 1 FROM settings WHERE key = ?').get(key)) {
        this.setSetting(key, '1');
        this.log('hq', 'cost_unknown_model', 'model', c.model.slice(0, 80), 'priced at the unknown-model estimate; setPrice to fix');
      }
    }
    const usd = c.usd ?? usdFor(priced.price, c.inputTokens, c.outputTokens, c.cacheReadTokens);
    this.db
      .prepare('INSERT INTO costs (task_id, agent_id, dept, model, input_tokens, output_tokens, usd, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(c.taskId ?? null, c.agentId, agent.dept, c.model, c.inputTokens, c.outputTokens, usd, this.now());
    if (c.taskId) this.db.prepare('UPDATE tasks SET cost_usd = cost_usd + ? WHERE id = ?').run(usd, c.taskId);
    const limit = this.deptBudget(agent.dept);
    if (!(limit > 0)) return { usd, blocked: false };
    const spent = this.monthSpend(agent.dept);
    const p = zonedParts(this.now(), this.tz);
    if (spent < limit) {
      if (spent >= limit * 0.8) {
        const warn = `budget_warn:${agent.dept}:${p.y}-${p.mo}`;
        if (!this.db.prepare('SELECT 1 FROM settings WHERE key = ?').get(warn)) {
          this.setSetting(warn, '1');
          void this.alert(`Отдел ${agent.dept}: потрачено ${Math.round((spent / limit) * 100)}% лимита на месяц ($${spent.toFixed(2)} из $${limit}). На 100% обычные задачи отдела остановятся, срочные пойдут.`, { kind: 'budget', short: `Расходы отдела ${agent.dept}: ${Math.round((spent / limit) * 100)}% лимита ($${spent.toFixed(2)} из $${limit}).` });
        }
      }
      return { usd, blocked: false };
    }
    let blocked = false;
    const t = c.taskId ? this.task(c.taskId) : undefined;
    if (t && !this.isUrgent(t.id, c.urgent) && !TERMINAL.includes(t.status) && t.status !== 'blocked' && TRANSITIONS[t.status].includes('blocked')) {
      this.block(t.id, 'hq', `Лимит расходов отдела ${agent.dept} исчерпан`);
      blocked = true;
    }
    const key = `budget_alert:${agent.dept}:${p.y}-${p.mo}`;
    if (!this.db.prepare('SELECT 1 FROM settings WHERE key = ?').get(key)) {
      this.setSetting(key, '1');
      void this.alert(`Отдел ${agent.dept}: лимит расходов на месяц ($${limit}) исчерпан, обычные задачи отдела останавливаются, срочные (клиент ждёт, приоритет 2) продолжаются.`, { kind: 'budget', short: `Расходы отдела ${agent.dept}: лимит $${limit} исчерпан (100%), обычные задачи стоят.` });
    }
    return { usd, blocked };
  }

  costSummary(sinceMs: number): { dept: string; usd: number; inputTokens: number; outputTokens: number }[] {
    return (this.db
      .prepare('SELECT dept, SUM(usd) usd, SUM(input_tokens) i, SUM(output_tokens) o FROM costs WHERE at >= ? GROUP BY dept ORDER BY dept')
      .all(sinceMs) as { dept: string; usd: number; i: number; o: number }[]).map((r) => ({ dept: r.dept, usd: r.usd, inputTokens: r.i, outputTokens: r.o }));
  }

  /** Model calls and their cost since a time (counts and money only, never texts). */
  llmUsage(sinceMs: number): { calls: number; usd: number } {
    const r = this.db.prepare('SELECT COUNT(*) n, COALESCE(SUM(usd), 0) usd FROM costs WHERE at >= ?').get(sinceMs) as { n: number; usd: number };
    return { calls: r.n, usd: r.usd };
  }

  /** Head reports (task events of kind "report") since a time, oldest first. */
  reports(sinceMs: number): { dept: string; taskId: number; body: string; at: number }[] {
    return (this.db
      .prepare("SELECT t.dept dept, e.task_id task_id, e.body body, e.at at FROM task_events e JOIN tasks t ON t.id = e.task_id WHERE e.kind = 'report' AND e.at >= ? AND (',' || t.tags || ',') NOT LIKE '%,drill,%' ORDER BY e.id")
      .all(sinceMs) as { dept: string; task_id: number; body: string; at: number }[]).map((r) => ({ dept: r.dept, taskId: r.task_id, body: r.body, at: r.at }));
  }

  // ---- activity and alerts ----
  /** Audit line. `detail` is a short note: ids and counts, never client text. */
  log(agentId: string | null, action: string, objectType?: string, objectId?: string, detail?: string): void {
    this.db
      .prepare('INSERT INTO activity (agent_id, action, object_type, object_id, detail, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(agentId, action, objectType ?? null, objectId ?? null, detail ?? null, this.now());
  }

  activity(limit = 50): { agentId: string | null; action: string; objectType: string | null; objectId: string | null; detail: string | null; at: number }[] {
    return (this.db.prepare('SELECT * FROM activity ORDER BY id DESC LIMIT ?').all(limit) as {
      agent_id: string | null; action: string; object_type: string | null; object_id: string | null; detail: string | null; at: number;
    }[]).map((r) => ({ agentId: r.agent_id, action: r.action, objectType: r.object_type, objectId: r.object_id, detail: r.detail, at: r.at }));
  }

  /** Alerts go to the owner at once (through the Director). */
  onAlert(sink: (text: string, o: AlertOpts) => Promise<void> | void): void {
    this.alertSinks.push(sink);
  }

  /**
   * An alert for the owner. `kind` tells the one Telegram bot whether it is a reminder worth a ping (lost lead, failed email, the models down, the money
   * limit, a service down) or a detail that stays in the Пульт («other», the default); `short` is the one line Telegram gets (no contacts, no client texts).
   */
  async alert(text: string, o: AlertOpts = {}): Promise<void> {
    this.log('hq', 'alert', undefined, undefined, o.kind ?? 'other');
    for (const s of this.alertSinks) await Promise.resolve(s(text, o)).catch(() => undefined);
  }
}
