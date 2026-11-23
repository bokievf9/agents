import type { Db, LlmClient, Payload, Tools } from '@fir/core';

export type Role = 'director' | 'head' | 'worker';
export type AgentStatus = 'active' | 'paused';
export type TaskStatus = 'inbox' | 'assigned' | 'running' | 'review' | 'approval' | 'done' | 'blocked' | 'rejected';
export type Creator = 'owner' | 'director' | 'head' | 'routine';

export interface Agent {
  id: string;
  dept: string;
  role: Role;
  title: string;
  instructions: string;
  bossId: string | null;
  status: AgentStatus;
  trustLevel: number;
  /** Name of the env var that holds the bot token (never the token itself). */
  bot: string | null;
  budgetUsdMonth: number;
}

export interface Task {
  id: number;
  title: string;
  body: string;
  dept: string;
  assigneeId: string | null;
  creator: Creator;
  parentId: number | null;
  status: TaskStatus;
  priority: number;
  dueAt: number | null;
  result: string | null;
  costUsd: number;
  /** Structured input for workers (action, ids). Never secrets or client personal data. */
  meta: Record<string, unknown>;
  tags: string[];
  routineId: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface NewTask {
  title: string;
  body?: string;
  dept: string;
  assigneeId?: string | null;
  creator: Creator;
  parentId?: number | null;
  priority?: number;
  dueAt?: number | null;
  meta?: Record<string, unknown>;
  tags?: string[];
  routineId?: number | null;
}

export interface TaskEvent {
  id: number;
  taskId: number;
  kind: string;
  actor: string | null;
  body: string;
  at: number;
}

export type ApprovalState = 'queued' | 'asked' | 'executed' | 'rejected' | 'failed';

export interface TaskApproval {
  id: number;
  taskId: number;
  approvalId: number | null;
  dept: string;
  kind: string;
  payload: Payload;
  summary: string;
  state: ApprovalState;
  /** A queued proposal that belongs to a weekly pack: it leaves with the pack's card (or when the owner opens the pack), not with the batch. */
  held: boolean;
  createdAt: number;
}

export interface Routine {
  id: number;
  name: string;
  cron: string;
  dept: string;
  assigneeId: string | null;
  title: string;
  body: string;
  meta: Record<string, unknown>;
  priority: number;
  /** skip: do not start while the previous task of this routine is still open. */
  overlap: 'skip' | 'allow';
  enabled: boolean;
  /** Which clock the cron runs on: the company's (market, clients, publishing) or the owner's (what lands in his morning). */
  tz: RoutineTz;
  lastRunAt: number | null;
  lastTaskId: number | null;
}

export type RoutineTz = 'company' | 'owner';

export type NewRoutine = Omit<Routine, 'id' | 'lastRunAt' | 'lastTaskId' | 'tz' | 'enabled' | 'overlap' | 'meta' | 'priority' | 'body' | 'assigneeId'> &
  Partial<Pick<Routine, 'overlap' | 'enabled' | 'meta' | 'priority' | 'body' | 'assigneeId' | 'tz'>>;

export interface Heartbeat {
  id: number;
  agentId: string;
  reason: string;
  dueAt: number;
  wakes: number;
}

/** What a department head gives a worker. Workers never talk to the outside world themselves. */
export interface WorkerCtx {
  /** Metered for the task: tokens and cost land in `costs`. */
  llm: LlmClient;
  /** The shared SQLite handle: a worker keeps its own tables in it (prefix them). */
  db: Db;
  tz: string;
  now(): number;
  /**
   * Proposes something for the owner. The head holds it until its own review passes, then it goes to the
   * Director's approval batch. Returns the position in this run's proposals.
   */
  requestApproval(kind: string, payload: Payload, summary: string): Promise<number>;
  /** Journal line (action + short detail, no client text). */
  log(action: string, detail?: string): void;
  /**
   * The agent's toolbox (`docs/tools.md`): web, files, media, data, channels, with the department's rights, the journal and limits.
   * Every head sets it; optional only so hand-built test contexts still compile (`toolsOf(ctx, dept)` gives a journal-less one).
   */
  tools?: Tools;
  /**
   * The brand choices of the department's rules (marketing, 2026-11-24): `firaVoice` on means captions speak as Fira and end with her signature.
   * Absent (other departments, hand-built tests): off. The rules text itself already sits in the system prompt of every `llm` call of a ruled worker.
   */
  brand?: { firaVoice: boolean };
}

export interface WorkerResult {
  ok: boolean;
  /** Markdown result for the task and the head's review. */
  result: string;
  error?: string;
  /**
   * The worker asked the owner's Mac (`ctx.tools.reach`, a job that is not answered yet) and cannot go on: the head parks the task (`blocked`, tag `reach-wait`, no
   * alert) and HQ puts it back in the inbox when the job is answered or expires; the worker then runs again and finds the answer cached.
   */
  waiting?: { jobId: number };
}

/** A piece of a task that a worker's `plan` carved out. */
export interface SubtaskSpec {
  title: string;
  body?: string;
  meta: Record<string, unknown>;
}

export interface Worker {
  id: string;
  /** Splits a task into subtasks (a weekly pack into items). null or absent: run the task as it is. */
  plan?(task: Task, ctx: WorkerCtx): Promise<SubtaskSpec[] | null>;
  run(task: Task, ctx: WorkerCtx): Promise<WorkerResult>;
}
