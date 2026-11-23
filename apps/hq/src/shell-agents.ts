import { loadRolePack } from '@fir/fira';
import { roleGloss, roleTitle, zonedParts, zonedToMs, type ApprovalQueue } from '@fir/core';
import type { Agent } from '@fir/hq';
import { z } from 'zod';
import type { AdminReply } from './admin.js';
import { fail, ok } from './shell-crm.js';
import { toolList, type ShellCompanyDeps } from './shell-company.js';

/**
 * The Agents section of HQ (2026-11-23): `GET /admin/agents`, `GET /admin/agents/:id` (the card), the instruction versions and the two
 * writes (`POST .../instructions`, `POST .../instructions/rollback`). Contract: `docs/admin-crm-api.md`, «Agents». Only ids, counters and
 * states come out; no client text (task titles and approval payloads stay inside).
 */
export interface ShellAgentsDeps extends Pick<ShellCompanyDeps, 'hq' | 'now' | 'tools'> {
  queue: ApprovalQueue;
}

/** Agents that run on a Fira role pack (`packages/fira/role-packs/<pack>.md`); the others are plain HQ workers. */
export const FIRA_PACKS: Readonly<Record<string, string>> = { 'client-bot': 'lead-manager', director: 'executive-assistant', 'marketing-head': 'marketing-head' };

export const MAX_INSTRUCTIONS = 20_000;
const writeBody = z.object({ text: z.string().min(1).max(MAX_INSTRUCTIONS), note: z.string().max(200).optional() }).strict();
const rollbackBody = z.object({ version: z.number().int().min(1), note: z.string().max(200).optional() }).strict();
const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const round = (n: number) => Math.round(n * 1e6) / 1e6;

export function createAgents(d: ShellAgentsDeps) {
  const { hq, queue, now } = d;
  const db = hq.db;
  const monthStart = () => hq.monthStart(now());
  const dayStart = () => {
    const p = zonedParts(now(), hq.tz);
    return zonedToMs(p.y, p.mo, p.d, 0, 0, hq.tz);
  };
  const spend = (agentId: string, since: number) => (db.prepare('SELECT COALESCE(SUM(usd), 0) s, COUNT(*) n FROM costs WHERE agent_id = ? AND at >= ?').get(agentId, since) as { s: number; n: number });
  const costDept = (dept: string) => (dept === 'director' ? 'hq' : dept);

  function row(a: Agent) {
    const m = spend(a.id, monthStart());
    const open = (db.prepare("SELECT COUNT(*) n FROM tasks WHERE assignee_id = ? AND status NOT IN ('done','rejected')").get(a.id) as { n: number }).n;
    return {
      id: a.id, title: roleTitle(a.id, a.title), gloss: roleGloss(a.id), dept: a.dept, role: a.role, bossId: a.bossId, status: a.status, trustLevel: a.trustLevel,
      monthUsd: round(m.s), openTasks: open, instructionVersion: hq.instructionVersions(a.id)[0]?.version ?? 0, hasFira: a.id in FIRA_PACKS,
    };
  }

  function list(): AdminReply {
    const agents = hq.agents();
    const depts = [...new Set(agents.map((a) => a.dept))];
    return ok({
      departments: depts.map((dept) => {
        const budgetOwner = hq.budgetAgent(dept);
        return { id: dept, budgetUsd: budgetOwner?.budgetUsdMonth ?? 0, monthUsd: round(hq.monthSpend(costDept(dept))) };
      }),
      agents: agents.map(row),
    });
  }

  function fira(id: string) {
    const pack = FIRA_PACKS[id];
    if (!pack) return null;
    try {
      const p = loadRolePack(pack);
      return { pack: p.id, title: p.title, goal: p.goal, tier: p.tier, tools: p.tools, duties: p.duties.length, boundaries: p.boundaries.length, handoff: p.handoff.length };
    } catch (e) {
      // a missing or broken pack file must not take the whole card down; the card says there is no pack
      return { pack, title: null, goal: null, tier: null, tools: [], duties: 0, boundaries: 0, handoff: 0, error: e instanceof Error ? e.message.slice(0, 120) : 'unreadable' };
    }
  }

  function card(id: string): AdminReply {
    if (!AGENT_ID.test(id)) return fail(404, 'not_found');
    const a = hq.agent(id);
    if (!a) return fail(404, 'not_found');
    const m = spend(a.id, monthStart());
    const t = spend(a.id, dayStart());
    const budgetOwner = hq.budgetAgent(a.dept);
    const deptBudget = budgetOwner?.budgetUsdMonth ?? 0;
    const deptSpend = hq.monthSpend(costDept(a.dept));
    const tools = toolList(d)
      .filter((x) => x.departments.includes((a.dept === 'hq' ? 'director' : a.dept) as never))
      .map((x) => ({ name: x.name, summary: x.summary, configured: x.configured, callsToday: x.callsToday, errorsToday: x.errorsToday }));
    // approval kinds of the agent's department (the kinds its tasks proposed): the trust table rows for them
    const kinds = (db.prepare('SELECT DISTINCT kind FROM task_approvals WHERE dept = ? ORDER BY kind').all(a.dept) as { kind: string }[]).map((r) => r.kind);
    const trustRows = queue.trustTable().filter((k) => kinds.includes(k.kind));
    const byDecision: Record<string, number> = {};
    for (const r of kinds.length
      ? (db.prepare(`SELECT decision, COUNT(*) n FROM decisions WHERE kind IN (${kinds.map(() => '?').join(',')}) GROUP BY decision`).all(...kinds) as { decision: string; n: number }[])
      : []) byDecision[r.decision] = r.n;
    const byStatus: Record<string, number> = {};
    for (const r of db.prepare('SELECT status, COUNT(*) n FROM tasks WHERE assignee_id = ? GROUP BY status').all(a.id) as { status: string; n: number }[]) byStatus[r.status] = r.n;
    const recentTasks = (db.prepare('SELECT id, status, updated_at at FROM tasks WHERE assignee_id = ? ORDER BY id DESC LIMIT 20').all(a.id) as { id: number; status: string; at: number }[]).map((r) => ({ id: r.id, status: r.status, at: iso(r.at) }));
    const recentDecisions = (kinds.length
      ? (db.prepare(`SELECT approval_id, kind, decision, at FROM decisions WHERE kind IN (${kinds.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 20`).all(...kinds) as { approval_id: number | null; kind: string; decision: string; at: number }[])
      : []
    ).map((r) => ({ approvalId: r.approval_id, kind: r.kind, decision: r.decision, at: iso(r.at) }));
    const versions = hq.instructionVersions(a.id);
    return ok({
      agent: {
        id: a.id, title: roleTitle(a.id, a.title), gloss: roleGloss(a.id), dept: a.dept, role: a.role, bossId: a.bossId, status: a.status, bot: a.bot,
      },
      instructions: {
        text: a.instructions, version: versions[0]?.version ?? 0, chars: a.instructions.length, maxChars: MAX_INSTRUCTIONS,
        versions: versions.map((v) => ({ version: v.version, actor: v.actor, note: v.note, at: iso(v.at), chars: v.chars })),
      },
      trust: { level: a.trustLevel, kinds: trustRows.map((k) => ({ kind: k.kind, level: k.level, locked: k.locked, streak: k.streak, threshold: k.threshold })) },
      tools,
      budget: {
        dept: a.dept, deptLimitUsd: deptBudget, deptMonthUsd: round(deptSpend), limitOwnerId: budgetOwner?.id ?? null,
        agentMonthUsd: round(m.s), agentTodayUsd: round(t.s), agentMonthCalls: m.n,
      },
      fira: fira(a.id),
      history: { tasksByStatus: byStatus, decisionsByKind: byDecision, recentTasks, recentDecisions },
    });
  }

  function version(id: string, v: string): AdminReply {
    if (!AGENT_ID.test(id) || !hq.agent(id)) return fail(404, 'not_found');
    const n = Number(v);
    if (!Number.isInteger(n)) return fail(404, 'not_found');
    const row = hq.instructionVersion(id, n);
    return row ? ok({ version: row.version, text: row.text, actor: row.actor, note: row.note, at: iso(row.at) }) : fail(404, 'not_found');
  }

  function write(id: string, body: unknown): AdminReply {
    if (!AGENT_ID.test(id) || !hq.agent(id)) return fail(404, 'not_found');
    const p = writeBody.safeParse(body ?? {});
    if (!p.success) return fail(400, 'invalid', { maxChars: MAX_INSTRUCTIONS });
    const text = p.data.text.replace(/\r\n/g, '\n').trim();
    if (!text) return fail(400, 'invalid', { maxChars: MAX_INSTRUCTIONS });
    if (text === hq.agent(id)!.instructions) return fail(409, 'unchanged');
    hq.setInstructions(id, text, 'owner', p.data.note ?? '');
    return card(id);
  }

  function rollback(id: string, body: unknown): AdminReply {
    if (!AGENT_ID.test(id) || !hq.agent(id)) return fail(404, 'not_found');
    const p = rollbackBody.safeParse(body ?? {});
    if (!p.success) return fail(400, 'invalid');
    const target = hq.instructionVersion(id, p.data.version);
    if (!target) return fail(404, 'unknown_version');
    if (target.text === hq.agent(id)!.instructions) return fail(409, 'unchanged');
    // history stays: the rollback is a new version carrying the old text
    hq.setInstructions(id, target.text, 'owner', p.data.note ?? `rollback to v${target.version}`);
    return card(id);
  }

  /** `seg`: the path after `/admin/agents`. */
  function handle(method: string, seg: string[], body: unknown): AdminReply {
    let id: string | null;
    try {
      id = seg[0] ? decodeURIComponent(seg[0]) : null;
    } catch {
      return fail(404, 'not_found');
    }
    if (!id) return method === 'GET' ? list() : fail(405, 'method_not_allowed');
    if (seg.length === 1) return method === 'GET' ? card(id) : fail(405, 'method_not_allowed');
    if (seg[1] === 'instructions') {
      if (seg.length === 2 && method === 'POST') return write(id, body);
      if (seg.length === 3 && seg[2] === 'rollback' && method === 'POST') return rollback(id, body);
      if (seg.length === 3 && method === 'GET') return version(id, seg[2]!);
    }
    return fail(404, 'not_found');
  }

  return { list, card, handle };
}
