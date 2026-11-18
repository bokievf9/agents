import { createHash, randomBytes } from 'node:crypto';
import { Cron } from 'croner';
import { z } from 'zod';
import { zonedParts, zonedToMs } from '@fir/core';
import type { Agent, Hq, Task, TaskStatus } from '@fir/hq';

/** `GET /office`: the live picture of the company for firtech.pro/admin/office (contract: docs/office-api.md). No client data. */
const iso = z.string();
const taskStatus = z.enum(['inbox', 'assigned', 'running', 'review', 'approval', 'done', 'blocked', 'rejected']);
export const AGENT_STATUSES = ['working', 'waiting', 'blocked', 'idle', 'sleeping', 'paused', 'offline'] as const;
const agentStatus = z.enum(AGENT_STATUSES);
const currentTask = z.object({ id: z.number(), title: z.string(), since: iso }).nullable();
/** Additive, optional fields: older readers of the contract ignore them. */
const thinking = z.boolean().optional();

export const REACTION_KINDS = ['approved', 'rejected', 'published', 'blocked', 'issue_closed', 'lead', 'done'] as const;
export type ReactionKind = (typeof REACTION_KINDS)[number];

export const officeSchema = z.object({
  ok: z.literal(true),
  generatedAt: iso,
  /** No open task at all (nothing inbox/assigned/running/review/approval/blocked). */
  queueEmpty: z.boolean().optional(),
  /** The latest event of any agent (activity or task journal). */
  lastEventAt: iso.nullable().optional(),
  tz: z.string(),
  quietHours: z.boolean(),
  director: z.object({
    id: z.string(), title: z.string(), status: agentStatus, thinking,
    lastSummaryAt: iso.nullable(), nextSummaryAt: iso.nullable(), pendingApprovals: z.number(), openBuilderIssues: z.number(),
  }),
  departments: z.array(
    z.object({
      id: z.string(), title: z.string(),
      head: z.object({ id: z.string(), title: z.string(), status: agentStatus, currentTask, thinking, lastActiveAt: iso.nullable().optional() }).nullable(),
      workers: z.array(
        z.object({
          id: z.string(), title: z.string(), status: agentStatus, currentTask, thinking,
          lastActiveAt: iso.nullable(), tasksToday: z.number(), costTodayUsd: z.number(),
        }),
      ),
      tasks: z.object({ inbox: z.number(), running: z.number(), review: z.number(), approval: z.number(), blocked: z.number(), doneToday: z.number() }),
    }),
  ),
  tasks: z.object({
    counts: z.record(taskStatus, z.number()),
    recent: z.array(z.object({ id: z.number(), title: z.string(), dept: z.string(), status: taskStatus, updatedAt: iso })),
  }),
  activity: z.array(z.object({ at: iso, agent: z.string().nullable(), action: z.string(), object: z.string().nullable() })),
  costs: z.object({ todayUsd: z.number(), monthUsd: z.number(), byDept: z.record(z.string(), z.number()), tokensToday: z.number() }),
  routines: z.array(z.object({ name: z.string(), dept: z.string(), cron: z.string(), nextRunAt: iso.nullable(), lastRunAt: iso.nullable() })),
  health: z.object({
    firtech: z.object({ ok: z.boolean().nullable(), pct24h: z.number().nullable() }),
    omniroute: z.object({ ok: z.boolean().nullable() }),
    incidentsToday: z.number(),
  }),
  funnel: z.object({ leadsWeek: z.number(), prospects: z.record(z.string(), z.number()) }),
  products: z.array(z.object({ id: z.string(), title: z.string(), status: z.union([agentStatus, z.literal('unknown')]) })),
  /** Client chats active in the last 30 minutes (a count for the public page). */
  visitorsActive: z.number().optional(),
  scene: z
    .object({
      visitors: z.array(z.object({ id: z.string(), channel: z.enum(['web', 'telegram']), state: z.enum(['chat', 'intake', 'contact', 'done', 'human']), since: iso })),
      leadsToday: z.number(), publishedToday: z.number(), approvedToday: z.number(), rejectedToday: z.number(),
      builderIssuesByDept: z.record(z.string(), z.number()),
      approvalsByAgent: z.record(z.string(), z.number()),
      reactions: z.array(z.object({ agent: z.string(), kind: z.enum(REACTION_KINDS), at: iso })),
      notice: z.string(),
      uptimeDays: z.number(),
      visitorsTotalToday: z.number(),
    })
    .optional(),
});
export type OfficeData = z.infer<typeof officeSchema>;
export type AgentStatusName = (typeof AGENT_STATUSES)[number];

const DEPT_TITLES: Record<string, string> = {
  marketing: 'Marketing', sales: 'Sales', support: 'Support', production: 'Production', backoffice: 'Back Office',
};
const OFFLINE_MS = 10 * 60_000;
/** An agent keeps the `working` status this long after its last event, so the page shows motion between model runs. */
export const STICKY_WORKING_MS = 60_000;
const ACTIVITY_LIMIT = 50;
const SENSITIVE_DEPTS = new Set(['sales', 'support', 'production', 'backoffice']);

/**
 * Title shown on the page. Tasks of the client-facing departments carry client or business names in titles
 * ("Проект: <client>", "Ответ бизнесу #3 <name>"), so there only routine titles survive; a website lead is «Лид #id».
 */
export function publicTitle(t: Pick<Task, 'id' | 'title' | 'dept' | 'routineId' | 'meta'>, leadId?: number): string {
  if (t.meta.action === 'lead') return `Лид #${leadId ?? t.id}`;
  if (!SENSITIVE_DEPTS.has(t.dept) || t.routineId !== null) return t.title;
  return `${DEPT_TITLES[t.dept] ?? t.dept}: задача #${t.id}`;
}

/** Activity values stay machine-like: a code, an id. Anything else (contacts, free text) is dropped. */
const SAFE_ACTION = /^[a-z][a-z0-9_.:-]{0,40}$/;
const SAFE_OBJ = /^[A-Za-z0-9_.:#-]{1,40}$/;
const looksLikeContact = (s: string) => /@|https?:|www\.|\+?\d[\d\s()-]{6,}/.test(s);
export function publicActivity(r: { objectType: string | null; objectId: string | null; action: string }): { action: string; object: string | null } {
  const action = SAFE_ACTION.test(r.action) ? r.action : 'event';
  const raw = [r.objectType, r.objectId].filter(Boolean).join(':');
  const object = raw && SAFE_OBJ.test(raw) && !looksLikeContact(raw) ? raw : null;
  return { action, object };
}

export interface AgentFacts {
  paused: boolean;
  sleeping: boolean;
  /** Tasks assigned to the agent, newest update first. */
  tasks: { status: TaskStatus; updatedAt: number }[];
  /** Latest sign of life (heartbeat, activity or task update), epoch ms. */
  lastSeenAt: number | null;
  /** The agent's latest own event (activity row or task journal entry), epoch ms. */
  lastEventAt?: number | null;
  now: number;
}

/**
 * paused (department) > offline (has work in flight but silent for 10 min) > working (a running task, or any own event
 * in the last 60 s) > waiting (latest task in review/approval) > blocked (latest task blocked) > sleeping (quiet hours or night) > idle.
 */
export function deriveStatus(f: AgentFacts): AgentStatusName {
  if (f.paused) return 'paused';
  const inFlight = f.tasks.some((t) => t.status === 'running' || t.status === 'assigned');
  if (inFlight && (f.lastSeenAt === null || f.now - f.lastSeenAt > OFFLINE_MS)) return 'offline';
  if (f.tasks.some((t) => t.status === 'running')) return 'working';
  if (f.lastEventAt != null && f.now - f.lastEventAt >= 0 && f.now - f.lastEventAt < STICKY_WORKING_MS) return 'working';
  const latest = f.tasks.find((t) => t.status !== 'done' && t.status !== 'rejected');
  if (latest && (latest.status === 'review' || latest.status === 'approval')) return 'waiting';
  if (latest && latest.status === 'blocked') return 'blocked';
  return f.sleeping ? 'sleeping' : 'idle';
}

interface Row { [k: string]: unknown }

const VISITOR_WINDOW_MS = 30 * 60_000;
const VISITOR_CAP = 20;
const REACTION_WINDOW_MS = 10 * 60_000;
const REACTION_CAP = 30;
const NOTICE_MAX = 80;
/** Per-process salt: visitor ids are stable while HQ runs but cannot be brute-forced from a numeric chat id. */
const VISITOR_SALT = randomBytes(8).toString('hex');
export const visitorId = (channel: 'web' | 'telegram', realId: string | number): string =>
  `v-${createHash('sha256').update(`${VISITOR_SALT}:${channel}:${realId}`).digest('hex').slice(0, 6)}`;

/** First line of the Director's summary, markup stripped, at most 80 characters. */
export function noticeFrom(text: string | undefined): string {
  const line = (text ?? '').split('\n').map((l) => l.replace(/<[^>]*>/g, '').trim()).find(Boolean) ?? '';
  return line.length > NOTICE_MAX ? `${line.slice(0, NOTICE_MAX - 1)}…` : line;
}

/** Reads everything the page needs from the HQ database. Worker tables (mon_*, li_*, pr_*) may not exist yet: they count as empty. */
export function buildOffice(hq: Hq, now: number = hq.now(), uptimeSec: number = process.uptime()): OfficeData {
  const db = hq.db;
  const tz = hq.tz;
  const q = <T = Row>(sql: string, ...args: unknown[]): T[] => {
    try {
      return db.prepare(sql).all(...args) as T[];
    } catch {
      return [];
    }
  };
  const p = zonedParts(now, tz);
  const dayStart = zonedToMs(p.y, p.mo, p.d, 0, 0, tz);
  const monthStart = hq.monthStart(now);
  const iso = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());
  const quiet = hq.isQuiet(now);
  const night = p.h >= 23 || p.h < 7;
  const sleeping = quiet || night;

  // tasks
  const taskRows = q<{
    id: number; title: string; dept: string; assignee_id: string | null; status: TaskStatus; routine_id: number | null; meta: string; tags: string; updated_at: number; created_at: number;
  }>('SELECT id, title, dept, assignee_id, status, routine_id, meta, tags, updated_at, created_at FROM tasks ORDER BY updated_at DESC, id DESC');
  const parseMeta = (s: string): Record<string, unknown> => {
    try {
      return JSON.parse(s) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  const leadIds = new Map(q<{ task_id: number; id: number }>('SELECT task_id, id FROM li_leads').map((r) => [r.task_id, r.id] as const));
  const titleOf = (r: (typeof taskRows)[number]) =>
    publicTitle({ id: r.id, title: r.title, dept: r.dept, routineId: r.routine_id, meta: parseMeta(r.meta) }, leadIds.get(r.id));

  const counts: Record<string, number> = { inbox: 0, assigned: 0, running: 0, review: 0, approval: 0, blocked: 0, done: 0, rejected: 0 };
  for (const t of taskRows) counts[t.status] = (counts[t.status] ?? 0) + 1;

  // last sign of life per agent
  const lastSeen = new Map<string, number>();
  const bump = (id: string | null, at: number) => {
    if (id && at > (lastSeen.get(id) ?? 0)) lastSeen.set(id, at);
  };
  for (const r of q<{ a: string; m: number }>('SELECT agent_id a, MAX(created_at) m FROM heartbeats GROUP BY agent_id')) bump(r.a, r.m);
  for (const r of q<{ a: string; m: number }>('SELECT agent_id a, MAX(at) m FROM activity WHERE agent_id IS NOT NULL GROUP BY agent_id')) bump(r.a, r.m);
  for (const t of taskRows) bump(t.assignee_id, t.updated_at);
  // every event an agent produces: journal entries (claims, results, reports, errors) count too
  const lastEvent = new Map<string, number>();
  const bumpEvent = (id: string | null, at: number) => {
    if (id && at > (lastEvent.get(id) ?? 0)) lastEvent.set(id, at);
    bump(id, at);
  };
  for (const r of q<{ a: string; m: number }>('SELECT agent_id a, MAX(at) m FROM activity WHERE agent_id IS NOT NULL GROUP BY agent_id')) bumpEvent(r.a, r.m);
  for (const r of q<{ a: string; m: number }>('SELECT actor a, MAX(at) m FROM task_events WHERE actor IS NOT NULL GROUP BY actor')) bumpEvent(r.a, r.m);
  const lastEventAt = Math.max(0, ...lastEvent.values(), ...q<{ m: number | null }>('SELECT MAX(at) m FROM activity').map((r) => r.m ?? 0));

  const costToday = new Map(q<{ a: string; u: number }>('SELECT agent_id a, SUM(usd) u FROM costs WHERE at >= ? GROUP BY agent_id', dayStart).map((r) => [r.a, r.u] as const));
  const round = (n: number) => Math.round(n * 10_000) / 10_000;

  const view = (a: Agent) => {
    const mine = taskRows.filter((t) => t.assignee_id === a.id);
    const running = mine.find((t) => t.status === 'running');
    const status = deriveStatus({
      paused: a.status === 'paused', sleeping, now, lastSeenAt: lastSeen.get(a.id) ?? null, lastEventAt: lastEvent.get(a.id) ?? null,
      tasks: mine.map((t) => ({ status: t.status, updatedAt: t.updated_at })),
    });
    return {
      status,
      currentTask: running ? { id: running.id, title: titleOf(running), since: new Date(running.updated_at).toISOString() } : null,
      thinking: hq.thinking(a.id),
      lastActiveAt: iso(lastSeen.get(a.id)),
      tasksToday: mine.filter((t) => t.updated_at >= dayStart).length,
      costTodayUsd: round(costToday.get(a.id) ?? 0),
    };
  };

  // approvals and builder issues
  const coreApprovals = q<{ c: number }>("SELECT COUNT(*) c FROM approvals WHERE status IN ('pending','editing')")[0]?.c ?? 0;
  const pendingApprovals = coreApprovals + hq.queuedApprovals().length;
  const openBuilderIssues = taskRows.filter((t) => {
    if (t.status !== 'blocked' || !t.tags.split(',').includes('builder')) return false;
    return parseMeta(t.meta).issue !== undefined;
  }).length;

  const agents = hq.agents();
  // ---- scene (office v2): counts and codes only, never client texts, names or contacts ----
  const headOf = (dept: string) => agents.find((a) => a.dept === dept && a.role === 'head')?.id ?? null;
  const taskById = new Map(taskRows.map((t) => [t.id, t] as const));
  const agentOfTask = (taskId: number): string | null => {
    const t = taskById.get(taskId);
    return t ? t.assignee_id ?? headOf(t.dept) : null;
  };
  const visitors: { id: string; channel: 'web' | 'telegram'; state: 'chat' | 'intake' | 'contact' | 'done' | 'human'; since: string; at: number }[] = [];
  const activeFrom = now - VISITOR_WINDOW_MS;
  for (const r of q<{ id: string; state: string; summary: string; created_at: number; updated_at: number }>(
    'SELECT id, state, summary, created_at, updated_at FROM web_chat_sessions WHERE updated_at >= ?', activeFrom,
  )) {
    const state = r.state === 'contact' ? 'contact' : r.state === 'idle' ? (r.summary ? 'done' : 'chat') : r.state === 'ask' ? 'chat' : 'intake';
    visitors.push({ id: visitorId('web', r.id), channel: 'web', state, since: new Date(r.created_at).toISOString(), at: r.updated_at });
  }
  for (const r of q<{ chat_id: number; state: string; muted: number; lead_task: number | null; created_at: number; last_at: number }>(
    'SELECT chat_id, state, muted, lead_task, created_at, last_at FROM cb_chats WHERE last_at >= ? AND blocked = 0', activeFrom,
  )) {
    const state = r.muted ? 'human' : r.state === 'idle' ? (r.lead_task !== null ? 'done' : 'chat') : 'intake';
    visitors.push({ id: visitorId('telegram', r.chat_id), channel: 'telegram', state, since: new Date(Math.max(r.created_at, r.last_at - VISITOR_WINDOW_MS)).toISOString(), at: r.last_at });
  }
  visitors.sort((a, b) => b.at - a.at);
  const visitorsTotalToday =
    (q<{ c: number }>('SELECT COUNT(*) c FROM web_chat_sessions WHERE updated_at >= ?', dayStart)[0]?.c ?? 0) +
    (q<{ c: number }>('SELECT COUNT(*) c FROM cb_chats WHERE last_at >= ?', dayStart)[0]?.c ?? 0);

  const leadsToday = taskRows.filter((t) => t.dept === 'sales' && t.created_at >= dayStart && parseMeta(t.meta).action === 'lead' && !t.tags.split(',').includes('drill')).length;
  const countSince = (sql: string) => q<{ c: number }>(sql, dayStart)[0]?.c ?? 0;
  const publishedToday = countSince("SELECT COUNT(*) c FROM activity WHERE action = 'published' AND at >= ?");
  const approvedToday = countSince("SELECT COUNT(*) c FROM decisions WHERE decision = 'approve' AND at >= ?");
  const rejectedToday = countSince("SELECT COUNT(*) c FROM decisions WHERE decision = 'reject' AND at >= ?");

  const builderIssuesByDept: Record<string, number> = {};
  for (const t of taskRows) {
    if (t.status === 'blocked' && t.tags.split(',').includes('builder')) builderIssuesByDept[t.dept] = (builderIssuesByDept[t.dept] ?? 0) + 1;
  }
  const approvalsByAgent: Record<string, number> = {};
  for (const r of q<{ task_id: number }>("SELECT task_id FROM task_approvals WHERE state IN ('queued','asked')")) {
    const a = agentOfTask(r.task_id);
    if (a) approvalsByAgent[a] = (approvalsByAgent[a] ?? 0) + 1;
  }

  const reactions: { agent: string; kind: ReactionKind; at: number }[] = [];
  const taskOf = (objectType: string | null, objectId: string | null) => (objectType === 'task' && objectId ? agentOfTask(Number(objectId)) : null);
  for (const r of q<{ agent_id: string | null; action: string; object_type: string | null; object_id: string | null; at: number }>(
    "SELECT agent_id, action, object_type, object_id, at FROM activity WHERE at >= ? AND action IN ('approved','rejected','published','task_blocked','builder_issue_closed','task_done','task_created') ORDER BY at, id", now - REACTION_WINDOW_MS,
  )) {
    if (r.at > now) continue;
    let kind: ReactionKind | null = null;
    let agent = r.agent_id;
    if (r.action === 'approved' || r.action === 'rejected') [kind, agent] = [r.action, taskOf(r.object_type, r.object_id)];
    else if (r.action === 'published') [kind, agent] = ['published', 'publisher'];
    else if (r.action === 'task_blocked') kind = 'blocked';
    else if (r.action === 'builder_issue_closed') [kind, agent] = ['issue_closed', taskOf(r.object_type, r.object_id) ?? agent];
    else if (r.action === 'task_done') kind = 'done';
    else if (r.action === 'task_created') {
      const t = r.object_type === 'task' && r.object_id ? taskById.get(Number(r.object_id)) : undefined;
      if (t && t.dept === 'sales' && parseMeta(t.meta).action === 'lead' && !t.tags.split(',').includes('drill')) [kind, agent] = ['lead', t.assignee_id ?? headOf('sales')];
    }
    if (kind && agent) reactions.push({ agent, kind, at: r.at });
  }

  const summaryRow = q<{ text: string }>("SELECT text FROM owner_inbox WHERE kind = 'summary' ORDER BY id DESC LIMIT 1")[0];

  // routines (summary times belong to the Director)
  const nextOf = (pattern: string, after = now): number | null => {
    try {
      return new Cron(pattern, { timezone: tz, paused: true }).nextRun(new Date(after))?.getTime() ?? null;
    } catch {
      return null;
    }
  };
  const summaryPattern = (() => {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(hq.setting('summary_time'));
    return m ? `${Number(m[2])} ${Number(m[1])} * * *` : null;
  })();
  let lastSummary: number | null = null;
  if (summaryPattern) {
    let t = nextOf(summaryPattern, now - 26 * 3_600_000);
    while (t !== null && t <= now) {
      lastSummary = t;
      t = nextOf(summaryPattern, t);
    }
  }
  const director = hq.agent('director');
  const directorView = director ? view(director) : null;

  const departments = hq.departments().map((dept) => {
    const inDept = taskRows.filter((t) => t.dept === dept);
    const head = agents.find((a) => a.dept === dept && a.role === 'head');
    return {
      id: dept,
      title: DEPT_TITLES[dept] ?? dept,
      head: head ? (() => { const v = view(head); return { id: head.id, title: head.title, status: v.status, currentTask: v.currentTask, thinking: v.thinking, lastActiveAt: v.lastActiveAt }; })() : null,
      workers: agents.filter((a) => a.dept === dept && a.role === 'worker').map((a) => {
        const v = view(a);
        return { id: a.id, title: a.title, ...v };
      }),
      tasks: {
        inbox: inDept.filter((t) => t.status === 'inbox').length,
        running: inDept.filter((t) => t.status === 'running').length,
        review: inDept.filter((t) => t.status === 'review').length,
        approval: inDept.filter((t) => t.status === 'approval').length,
        blocked: inDept.filter((t) => t.status === 'blocked').length,
        doneToday: inDept.filter((t) => t.status === 'done' && t.updated_at >= dayStart).length,
      },
    };
  });

  // costs
  const byDept: Record<string, number> = {};
  for (const r of q<{ d: string; u: number }>('SELECT dept d, SUM(usd) u FROM costs WHERE at >= ? GROUP BY dept', dayStart)) byDept[r.d] = round(r.u);
  const sum = (sql: string, since: number) => q<{ s: number | null }>(sql, since)[0]?.s ?? 0;

  // health
  const since24 = now - 24 * 3_600_000;
  const firtechState = q<{ status: string }>("SELECT status FROM mon_state WHERE check_id LIKE 'http:%firtech%'");
  const firtechSamples = q<{ n: number; ok: number | null }>("SELECT COUNT(*) n, SUM(ok) ok FROM mon_samples WHERE check_id LIKE 'http:%firtech%' AND at >= ?", since24)[0];
  const omni = q<{ status: string }>("SELECT status FROM mon_state WHERE check_id = 'omniroute'")[0];

  // funnel
  const prospects: Record<string, number> = {};
  for (const r of q<{ s: string; c: number }>('SELECT status s, COUNT(*) c FROM pr_prospects GROUP BY status')) prospects[r.s] = r.c;

  return {
    ok: true,
    generatedAt: new Date(now).toISOString(),
    queueEmpty: !taskRows.some((t) => t.status !== 'done' && t.status !== 'rejected'),
    lastEventAt: iso(lastEventAt || null),
    tz,
    quietHours: quiet,
    director: {
      id: 'director',
      title: director?.title ?? 'Director',
      status: directorView ? (directorView.status === 'idle' && pendingApprovals > 0 ? 'waiting' : directorView.status) : sleeping ? 'sleeping' : 'idle',
      lastSummaryAt: iso(lastSummary),
      nextSummaryAt: summaryPattern ? iso(nextOf(summaryPattern)) : null,
      thinking: hq.thinking('director'),
      pendingApprovals,
      openBuilderIssues,
    },
    departments,
    tasks: {
      counts,
      recent: taskRows.slice(0, 20).map((t) => ({ id: t.id, title: titleOf(t), dept: t.dept, status: t.status, updatedAt: new Date(t.updated_at).toISOString() })),
    },
    activity: hq.activity(ACTIVITY_LIMIT).map((r) => ({ at: new Date(r.at).toISOString(), agent: r.agentId, ...publicActivity(r) })),
    costs: {
      todayUsd: round(sum('SELECT SUM(usd) s FROM costs WHERE at >= ?', dayStart)),
      monthUsd: round(sum('SELECT SUM(usd) s FROM costs WHERE at >= ?', monthStart)),
      byDept,
      tokensToday: sum('SELECT SUM(input_tokens + output_tokens) s FROM costs WHERE at >= ?', dayStart),
    },
    routines: hq.routines().filter((r) => r.enabled).map((r) => ({
      name: r.name, dept: r.dept, cron: r.cron, nextRunAt: iso(nextOf(r.cron)), lastRunAt: iso(r.lastRunAt),
    })),
    health: {
      firtech: {
        ok: firtechState.length ? firtechState.every((s) => s.status === 'ok') : null,
        pct24h: firtechSamples && firtechSamples.n ? Math.round(((firtechSamples.ok ?? 0) / firtechSamples.n) * 1000) / 10 : null,
      },
      omniroute: { ok: omni ? omni.status === 'ok' : null },
      incidentsToday: q<{ c: number }>('SELECT COUNT(*) c FROM mon_incidents WHERE started_at >= ?', dayStart)[0]?.c ?? 0,
    },
    funnel: {
      leadsWeek: q<{ c: number }>('SELECT COUNT(*) c FROM li_leads WHERE created_at >= ?', now - 7 * 86_400_000)[0]?.c ?? 0,
      prospects,
    },
    // No cheap signal for the products yet (Dono and Polly run outside HQ).
    products: [{ id: 'dono', title: 'Dono', status: 'unknown' }, { id: 'polly', title: 'Polly', status: 'unknown' }],
    visitorsActive: visitors.length,
    scene: {
      visitors: visitors.slice(0, VISITOR_CAP).map((v) => ({ id: v.id, channel: v.channel, state: v.state, since: v.since })),
      leadsToday, publishedToday, approvedToday, rejectedToday,
      builderIssuesByDept, approvalsByAgent,
      reactions: reactions.slice(-REACTION_CAP).map((r) => ({ agent: r.agent, kind: r.kind, at: new Date(r.at).toISOString() })),
      notice: noticeFrom(summaryRow?.text),
      uptimeDays: Math.round((uptimeSec / 86_400) * 10) / 10,
      visitorsTotalToday,
    },
  };
}

/** Computes at most once per `ttlMs` (5 s): the page polls every 10 s, several tabs must not multiply the queries. */
export function cachedOffice(hq: Hq, ttlMs = 5000, clock: () => number = Date.now): () => OfficeData {
  let at = 0;
  let value: OfficeData | null = null;
  return () => {
    const t = clock();
    if (!value || t - at >= ttlMs) {
      value = buildOffice(hq, hq.now());
      at = t;
    }
    return value;
  };
}
