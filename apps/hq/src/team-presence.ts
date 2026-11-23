import { roleTitle, type Db } from '@fir/core';
import type { Agent, Hq, Task } from '@fir/hq';
import { containsClientData } from './office.js';

/**
 * «Команда» (2026-11-24, contract `docs/admin-crm-api.md`, «Команда»): who is on the team, what each one is doing right now and how it did this week.
 * `presence` comes from the live state only: a running task of the agent, a model call in flight (`hq.thinking`), a chat turn still being answered,
 * a result waiting for the owner. `now` is a short phrase built by code from the task's KIND and its number, never from its title (titles of
 * client-facing work carry names), so no client data leaves here. Built at most once per 10 s.
 */

/** The team of the Shell, in the contract's order (ids of `agents`, titles from `role-titles.ts`). */
export const TEAM_IDS = [
  'director', 'marketing-head', 'content-maker', 'trend-scout', 'publisher', 'seo', 'analyst', 'sales-head', 'lead-intake', 'prospector', 'presales',
  'support-head', 'customer-support', 'monitoring', 'billing', 'production-head', 'project-manager', 'reviewer', 'deployer', 'backoffice-head', 'finance',
  'documents', 'knowledge',
] as const;
export type TeamId = (typeof TEAM_IDS)[number];
export const isTeamId = (id: string): id is TeamId => (TEAM_IDS as readonly string[]).includes(id);

/** The meta action of a task the team chat runs itself (an assignment): the heads leave these alone. */
export const TEAM_ASSIGN = 'team_assign';
export const isTeamTask = (t: Pick<Task, 'meta'>): boolean => t.meta.action === TEAM_ASSIGN;

export type Presence = 'working' | 'waiting' | 'idle' | 'off';
export interface Kpi { answers7d: number; approvals7d: number; rating7d: number | null }
export interface Member {
  id: string; title: string; dept: string; presence: Presence; now?: string; queue: number; lastResultAt?: string;
  budget: { usedUsd: number; limitUsd: number }; kpi: Kpi;
}

export const PRESENCE_TTL_MS = 10_000;
const WEEK = 7 * 86_400_000;
const round = (n: number, k = 4) => Math.round(n * 10 ** k) / 10 ** k;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);

type TaskLike = Pick<Task, 'id' | 'title' | 'meta' | 'routineId'>;

/** What the agent is doing, said by the kind of the task and a number (`#id`). Titles survive only for our own routines without client data. */
export function nowPhrase(t: TaskLike): string {
  const m = t.meta;
  const action = typeof m.action === 'string' ? m.action : '';
  const ref = (k: string) => `#${num(m[k]) ?? t.id}`;
  switch (action) {
    case TEAM_ASSIGN: return `выполняю поручение #${t.id}`;
    case 'lead': return `разбираю заявку ${ref('leadId')}`;
    case 'kp': return `пишу КП по заявке ${ref('leadId')}`;
    case 'ticket': return `отвечаю на тикет ${ref('ticketId')}`;
    case 'invoice': case 'kp_invoice': case 'billing': return `готовлю счёт #${t.id}`;
    case 'doc': return `готовлю документ #${t.id}`;
    case 'project': case 'client_status': case 'handover': return `веду проект ${ref('projectId')}`;
    case 'audit': return `проверяю сайт #${t.id}`;
    case 'reply': return `готовлю ответ бизнесу #${t.id}`;
    case 'onboard': return `ввожу клиента в проект #${t.id}`;
    default:
      if (m.studio !== undefined) return `делаю материал #${t.id}`;
      if (t.routineId !== null && !containsClientData(t.title)) {
        const one = t.title.replace(/\s+/g, ' ').trim();
        return one.length > 60 ? `${one.slice(0, 59)}…` : one;
      }
      return `работаю над задачей #${t.id}`;
  }
}

export interface PresenceFacts {
  paused: boolean;
  /** The agent's running task (newest), if any. */
  running: TaskLike | null;
  /** A model call of the agent is in flight. */
  thinking: boolean;
  /** A chat turn of the agent is still being answered. */
  chatPending: boolean;
  /** The agent's newest open task waits for the owner (review, approval, an asked approval). */
  waitingTaskId: number | null;
}

/** off (paused) > working (a running task, a model call, a chat turn) > waiting (the owner decides) > idle. */
export function derivePresence(f: PresenceFacts): { presence: Presence; now?: string } {
  if (f.paused) return { presence: 'off' };
  if (f.running) return { presence: 'working', now: nowPhrase(f.running) };
  if (f.chatPending) return { presence: 'working', now: 'отвечаю владельцу в чате' };
  if (f.thinking) return { presence: 'working', now: 'думаю над ответом' };
  if (f.waitingTaskId !== null) return { presence: 'waiting', now: `жду одобрения по задаче #${f.waitingTaskId}` };
  return { presence: 'idle' };
}

export interface TeamPresenceDeps {
  hq: Hq;
  now: () => number;
  /** Agent ids with a chat turn still running (the team chat and the marketing chat). */
  chatPending?: () => ReadonlySet<string>;
}

export function createTeamPresence(d: TeamPresenceDeps) {
  const { hq } = d;
  const db: Db = hq.db;
  const has = (t: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) !== undefined;
  const q = <T>(sql: string, ...args: unknown[]): T[] => {
    try {
      return db.prepare(sql).all(...args) as T[];
    } catch {
      return []; // a worker table that does not exist yet counts as empty
    }
  };
  let cache: { at: number; members: Member[] } | null = null;

  function kpiOf(a: Agent, since: number): Kpi {
    const results = q<{ n: number }>("SELECT COUNT(*) n FROM task_events WHERE kind = 'result' AND actor = ? AND at >= ?", a.id, since)[0]?.n ?? 0;
    const chat = has('team_chat') ? q<{ n: number }>("SELECT COUNT(*) n FROM team_chat WHERE agent_id = ? AND role = 'agent' AND state = 'done' AND at >= ?", a.id, since)[0]?.n ?? 0 : 0;
    const mk = a.id === 'marketing-head' && has('mk_chat') ? q<{ n: number }>("SELECT COUNT(*) n FROM mk_chat WHERE role = 'fira' AND state = 'done' AND at >= ?", since)[0]?.n ?? 0 : 0;
    const approvals = q<{ n: number }>(
      "SELECT COUNT(*) n FROM task_approvals t JOIN tasks k ON k.id = t.task_id WHERE t.state = 'executed' AND t.created_at >= ? AND k.assignee_id = ?", since, a.id,
    )[0]?.n ?? 0;
    // ratings on a 5-point scale: the clients' reviews of delivered projects (production), the owner's ±1 on the answers to visitors (sales intake)
    let rating: number | null = null;
    if ((a.id === 'production-head' || a.id === 'project-manager') && has('crm_reviews')) {
      const r = q<{ v: number | null }>('SELECT AVG(rating) v FROM crm_reviews WHERE at >= ?', since)[0]?.v ?? null;
      rating = r === null ? null : round(r, 2);
    } else if ((a.id === 'lead-intake' || a.id === 'sales-head') && has('fira_ratings')) {
      const r = q<{ v: number | null }>('SELECT AVG(CASE WHEN value > 0 THEN 5 ELSE 1 END) v FROM fira_ratings WHERE created_at >= ?', since)[0]?.v ?? null;
      rating = r === null ? null : round(r, 2);
    }
    return { answers7d: results + chat + mk, approvals7d: approvals, rating7d: rating };
  }

  function build(): Member[] {
    const t = d.now();
    const since = t - WEEK;
    const pending = d.chatPending?.() ?? new Set<string>();
    const monthStart = hq.monthStart(t);
    const open = hq.tasks({ open: true, limit: 5000 }).filter((x) => !x.tags.includes('drill'));
    const asked = new Set(q<{ task_id: number }>("SELECT task_id FROM task_approvals WHERE state IN ('queued', 'asked')").map((r) => r.task_id));
    const out: Member[] = [];
    for (const id of TEAM_IDS) {
      const a = hq.agent(id);
      if (!a) continue;
      const mine = open.filter((x) => x.assigneeId === id).sort((x, y) => y.updatedAt - x.updatedAt || y.id - x.id);
      const running = mine.find((x) => x.status === 'running') ?? null;
      const waiting = mine.find((x) => x.status === 'review' || x.status === 'approval' || asked.has(x.id)) ?? null;
      const p = derivePresence({
        paused: a.status === 'paused' || hq.headOf(a.dept)?.status === 'paused', running, thinking: hq.thinking(id), chatPending: pending.has(id), waitingTaskId: waiting?.id ?? null,
      });
      const queue = mine.filter((x) => x.status === 'inbox' || x.status === 'assigned').length + (a.role === 'head' ? open.filter((x) => x.dept === a.dept && x.status === 'inbox' && !x.assigneeId).length : 0);
      const lastResult = Math.max(
        q<{ m: number | null }>("SELECT MAX(at) m FROM task_events WHERE kind = 'result' AND actor = ?", id)[0]?.m ?? 0,
        has('team_chat') ? q<{ m: number | null }>("SELECT MAX(at) m FROM team_chat WHERE agent_id = ? AND role = 'agent' AND state = 'done'", id)[0]?.m ?? 0 : 0,
      );
      const used = q<{ s: number }>('SELECT COALESCE(SUM(usd), 0) s FROM costs WHERE agent_id = ? AND at >= ?', id, monthStart)[0]?.s ?? 0;
      out.push({
        id, title: roleTitle(id, a.title), dept: a.dept, presence: p.presence, ...(p.now ? { now: p.now } : {}), queue,
        ...(lastResult ? { lastResultAt: new Date(lastResult).toISOString() } : {}),
        budget: { usedUsd: round(used), limitUsd: hq.deptBudget(a.dept) }, kpi: kpiOf(a, since),
      });
    }
    return out;
  }

  return {
    /** The members, cached 10 s (`fresh` rebuilds now: after a write of the Shell). */
    members(fresh = false): Member[] {
      const t = d.now();
      if (!fresh && cache && t - cache.at < PRESENCE_TTL_MS && t >= cache.at) return cache.members;
      const members = build();
      cache = { at: t, members };
      return members;
    },
    member(id: string, fresh = false): Member | undefined {
      return this.members(fresh).find((m) => m.id === id);
    },
    /** `{ [agentId]: { presence, now? } }` for the office and the hub (a hover line per agent). */
    map(): Record<string, { presence: Presence; now?: string }> {
      return Object.fromEntries(this.members().map((m) => [m.id, { presence: m.presence, ...(m.now ? { now: m.now } : {}) }]));
    },
    invalidate(): void {
      cache = null;
    },
  };
}

export type TeamPresence = ReturnType<typeof createTeamPresence>;
