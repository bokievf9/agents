import { zonedParts, zonedToMs, type ApprovalQueue, type Db, type KindSpec, type Payload } from '@fir/core';
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

export const DEFAULT_SETTINGS: Record<string, string> = {
  tz: 'Asia/Tashkent',
  summary_time: '08:00',
  approval_time: '10:00',
  quiet_hours: '',
};

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
  id: r.id, dept: r.dept, role: r.role, title: r.title, instructions: r.instructions, bossId: r.boss_id, status: r.status,
  trustLevel: r.trust_level, bot: r.bot, budgetUsdMonth: r.budget_usd_month,
});

interface RoutineRow {
  id: number; name: string; cron: string; dept: string; assignee_id: string | null; title: string; body: string; meta: string;
  priority: number; overlap: Routine['overlap']; enabled: number; last_run_at: number | null; last_task_id: number | null;
}
const toRoutine = (r: RoutineRow): Routine => ({
  id: r.id, name: r.name, cron: r.cron, dept: r.dept, assigneeId: r.assignee_id, title: r.title, body: r.body,
  meta: JSON.parse(r.meta) as Record<string, unknown>, priority: r.priority, overlap: r.overlap, enabled: r.enabled === 1,
  lastRunAt: r.last_run_at, lastTaskId: r.last_task_id,
});

interface LinkRow {
  id: number; task_id: number; approval_id: number | null; dept: string; kind: string; payload: string; summary: string;
  state: ApprovalState; created_at: number;
}
const toLink = (r: LinkRow): TaskApproval => ({
  id: r.id, taskId: r.task_id, approvalId: r.approval_id, dept: r.dept, kind: r.kind, payload: JSON.parse(r.payload) as Payload,
  summary: r.summary, state: r.state, createdAt: r.created_at,
});

export interface CostInput {
  taskId?: number | null;
  agentId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Explicit price; otherwise from the price table (0 for free providers). */
  usd?: number;
}

/** USD per million tokens, by model name prefix (the longest matching prefix wins). Gateway aliases and free models cost 0. */
export type PriceTable = Record<string, { in: number; out: number }>;

/**
 * Known Anthropic list prices, USD per 1M tokens, written into the `prices` table once (never overwritten, the owner
 * edits them with `setPrice`). Check them against the current price list: a wrong row only skews the report.
 * Gateway aliases ("auto") and free provider models stay at 0.
 */
export const DEFAULT_PRICES: PriceTable = {
  'claude-haiku': { in: 1, out: 5 },
  'claude-sonnet': { in: 3, out: 15 },
  'claude-opus': { in: 5, out: 25 },
  auto: { in: 0, out: 0 },
};

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
  private readonly alertSinks: ((text: string) => Promise<void> | void)[] = [];
  readonly now: () => number;
  prices: PriceTable;

  constructor(readonly db: Db, opts: { now?: () => number; prices?: PriceTable } = {}) {
    db.exec(SCHEMA);
    this.now = opts.now ?? Date.now;
    const seed = db.prepare('INSERT OR IGNORE INTO prices (prefix, in_usd, out_usd) VALUES (?, ?, ?)');
    for (const [prefix, p] of Object.entries(DEFAULT_PRICES)) seed.run(prefix, p.in, p.out);
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

  setInstructions(agentId: string, instructions: string, actor = 'director'): void {
    if (!this.agent(agentId)) throw new Error(`Unknown agent ${agentId}`);
    this.db.prepare('UPDATE agents SET instructions = ? WHERE id = ?').run(instructions, agentId);
    this.log(actor, 'instructions_changed', 'agent', agentId);
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

  /** Registers an approval kind in the core queue (money and prices: `locked: true`, always level 0). */
  registerKind(kind: string, spec: KindSpec): void {
    this.q().register(kind, spec);
  }

  /**
   * The head asks for the owner's decision. At level 0 the proposal waits in the queue and reaches the owner in the
   * Director's batch (`releaseApprovals`); at level 1 the core runs it at once and reports. The task goes to `approval`.
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
    if (this.q().level(kind) === 1) {
      await this.askOne(linkId, '');
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

  queuedApprovals(): TaskApproval[] {
    return (this.db.prepare("SELECT * FROM task_approvals WHERE state = 'queued' ORDER BY dept, id").all() as LinkRow[]).map(toLink);
  }

  private async askOne(linkId: number, prefix: string): Promise<void> {
    const l = this.approvalLink(linkId)!;
    const { id } = await this.q().propose(l.kind, l.payload, `${prefix}${l.summary}`);
    this.db.prepare("UPDATE task_approvals SET approval_id = ?, state = 'asked' WHERE id = ?").run(id, linkId);
  }

  /**
   * The owner's batch: every queued proposal of every department goes out as one numbered series
   * (the core sends each with its buttons). Returns how many were sent.
   */
  async releaseApprovals(): Promise<number> {
    const queued = this.queuedApprovals();
    for (const [i, l] of queued.entries()) {
      await this.askOne(l.id, `[${i + 1}/${queued.length}] ${l.dept}, задача #${l.taskId}\n`);
      this.addEvent(l.taskId, 'approval', 'director', `${l.kind}: sent to the owner`);
    }
    this.reconcileApprovals();
    return queued.length;
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
      this.db.prepare('UPDATE task_approvals SET state = ? WHERE id = ?').run(next, row.id);
      this.log('owner', 'approval_decided', 'task', String(row.task_id), next);
      changed++;
      for (const sink of this.decisionSinks) sink(this.approvalLink(row.id)!, next);
      const open = this.db.prepare("SELECT COUNT(*) c FROM task_approvals WHERE task_id = ? AND state IN ('queued','asked')").get(row.task_id) as { c: number };
      const t = this.task(row.task_id);
      if (!t || TERMINAL.includes(t.status)) continue;
      this.addEvent(row.task_id, 'approval', 'owner', `${row.kind}: ${next}`);
      if (next === 'failed') this.block(row.task_id, 'owner', `approval ${row.kind} failed to execute`);
      else if (open.c === 0) {
        const all = this.db.prepare('SELECT state FROM task_approvals WHERE task_id = ?').all(row.task_id) as { state: ApprovalState }[];
        const anyOk = all.some((a) => a.state === 'executed');
        this.move(row.task_id, anyOk ? 'done' : 'rejected', 'owner');
        this.log('owner', anyOk ? 'approved' : 'rejected', 'task', String(row.task_id));
      }
    }
    return changed;
  }

  // ---- routines ----
  scheduleRoutine(r: NewRoutine): Routine {
    this.db
      .prepare(
        `INSERT INTO routines (name, cron, dept, assignee_id, title, body, meta, priority, overlap, enabled)
         VALUES (@name, @cron, @dept, @assignee, @title, @body, @meta, @priority, @overlap, @enabled)
         ON CONFLICT(name) DO UPDATE SET cron=excluded.cron, dept=excluded.dept, assignee_id=excluded.assignee_id, title=excluded.title,
           body=excluded.body, meta=excluded.meta, priority=excluded.priority, overlap=excluded.overlap, enabled=excluded.enabled`,
      )
      .run({
        name: r.name, cron: r.cron, dept: r.dept, assignee: r.assigneeId ?? null, title: r.title, body: r.body ?? '',
        meta: JSON.stringify(r.meta ?? {}), priority: r.priority ?? 0, overlap: r.overlap ?? 'skip', enabled: r.enabled === false ? 0 : 1,
      });
    return this.routineByName(r.name)!;
  }

  routineByName(name: string): Routine | undefined {
    const r = this.db.prepare('SELECT * FROM routines WHERE name = ?').get(name) as RoutineRow | undefined;
    return r ? toRoutine(r) : undefined;
  }

  routines(): Routine[] {
    return (this.db.prepare('SELECT * FROM routines ORDER BY id').all() as RoutineRow[]).map(toRoutine);
  }

  /**
   * Fires a routine: creates its task (creator `routine`) and wakes the department head. With the `skip` policy
   * nothing is created while the previous task of the routine is still open. Returns the task or null when skipped.
   */
  runRoutine(name: string): Task | null {
    const r = this.routineByName(name);
    if (!r || !r.enabled) return null;
    if (r.overlap === 'skip' && r.lastTaskId !== null) {
      const prev = this.task(r.lastTaskId);
      if (prev && !TERMINAL.includes(prev.status)) {
        this.log('routine', 'routine_skipped', 'routine', name);
        return null;
      }
    }
    const t = this.createTask({
      title: r.title, body: r.body, dept: r.dept, assigneeId: r.assigneeId, creator: 'routine', priority: r.priority, meta: { ...r.meta, routine: name },
      routineId: r.id,
    });
    this.db.prepare('UPDATE routines SET last_run_at = ?, last_task_id = ? WHERE id = ?').run(this.now(), t.id, r.id);
    this.log('routine', 'routine_fired', 'routine', name);
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

  /** Due wake-ups, one per agent (not paused, not in `busy`); they are marked delivered. */
  claimDueHeartbeats(busy: ReadonlySet<string> = new Set()): Heartbeat[] {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT h.* FROM heartbeats h JOIN agents a ON a.id = h.agent_id
           WHERE h.status = 'pending' AND h.due_at <= ? AND a.status = 'active' ORDER BY h.id`,
        )
        .all(this.now()) as { id: number; agent_id: string; reason: string; due_at: number; wakes: number }[];
      const out: Heartbeat[] = [];
      for (const r of rows) {
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

  get tz(): string {
    return this.setting('tz');
  }

  /** True inside the "quiet hours" window (setting `quiet_hours`, "23:00-07:00" in the HQ timezone). */
  isQuiet(at = this.now()): boolean {
    const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(this.setting('quiet_hours'));
    if (!m) return false;
    const p = zonedParts(at, this.tz);
    const cur = p.h * 60 + p.mi;
    const from = Number(m[1]) * 60 + Number(m[2]);
    const to = Number(m[3]) * 60 + Number(m[4]);
    return from <= to ? cur >= from && cur < to : cur >= from || cur < to;
  }

  // ---- costs ----
  /** Department budget: the monthly limit of its head (0 = no limit). */
  deptBudget(dept: string): number {
    return this.headOf(dept)?.budgetUsdMonth ?? 0;
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

  /**
   * Records token usage. When the department's month spend reaches its limit, the task is put into `blocked`
   * and the owner gets one alert per department and month.
   */
  recordCost(c: CostInput): { usd: number; blocked: boolean } {
    const agent = this.agent(c.agentId);
    if (!agent) throw new Error(`Unknown agent ${c.agentId}`);
    const price = Object.entries(this.prices)
      .filter(([prefix]) => c.model.startsWith(prefix))
      .sort((a, b) => b[0].length - a[0].length)[0]?.[1];
    const usd = c.usd ?? (price ? (c.inputTokens * price.in + c.outputTokens * price.out) / 1_000_000 : 0);
    this.db
      .prepare('INSERT INTO costs (task_id, agent_id, dept, model, input_tokens, output_tokens, usd, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(c.taskId ?? null, c.agentId, agent.dept, c.model, c.inputTokens, c.outputTokens, usd, this.now());
    if (c.taskId) this.db.prepare('UPDATE tasks SET cost_usd = cost_usd + ? WHERE id = ?').run(usd, c.taskId);
    if (!this.overBudget(agent.dept)) return { usd, blocked: false };
    let blocked = false;
    const t = c.taskId ? this.task(c.taskId) : undefined;
    if (t && !TERMINAL.includes(t.status) && t.status !== 'blocked' && TRANSITIONS[t.status].includes('blocked')) {
      this.block(t.id, 'hq', `Лимит расходов отдела ${agent.dept} исчерпан`);
      blocked = true;
    }
    const p = zonedParts(this.now(), this.tz);
    const key = `budget_alert:${agent.dept}:${p.y}-${p.mo}`;
    if (!this.db.prepare('SELECT 1 FROM settings WHERE key = ?').get(key)) {
      this.setSetting(key, '1');
      void this.alert(`Отдел ${agent.dept}: лимит расходов на месяц ($${this.deptBudget(agent.dept)}) исчерпан, новые задачи отдела блокируются.`);
    }
    return { usd, blocked };
  }

  costSummary(sinceMs: number): { dept: string; usd: number; inputTokens: number; outputTokens: number }[] {
    return (this.db
      .prepare('SELECT dept, SUM(usd) usd, SUM(input_tokens) i, SUM(output_tokens) o FROM costs WHERE at >= ? GROUP BY dept ORDER BY dept')
      .all(sinceMs) as { dept: string; usd: number; i: number; o: number }[]).map((r) => ({ dept: r.dept, usd: r.usd, inputTokens: r.i, outputTokens: r.o }));
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
  onAlert(sink: (text: string) => Promise<void> | void): void {
    this.alertSinks.push(sink);
  }

  async alert(text: string): Promise<void> {
    this.log('hq', 'alert');
    for (const s of this.alertSinks) await Promise.resolve(s(text)).catch(() => undefined);
  }
}
