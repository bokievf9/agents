import { Cron } from 'croner';
import { isPlaybookRole, listPlaybooks, loadPlaybook, toolCatalog, zonedParts, zonedToMs, type ApprovalQueue } from '@fir/core';
import type { Hq, Routine } from '@fir/hq';
import { z } from 'zod';
import type { AdminReply } from './admin.js';
import type { Director } from './director.js';
import { buildOffice } from './office.js';
import { fail, ok } from './shell-crm.js';
import { todayIn } from './shell-week.js';
import type { AppTools } from './tools.js';

/** `GET /admin/company` and its three writes (routines on/off, run now, trust level). Contract: `docs/admin-crm-api.md` («Shell v3»). */
export interface ShellCompanyDeps {
  hq: Hq;
  queue: ApprovalQueue;
  director: Director;
  now: () => number;
  /** The routine list or a switch changed: the app restarts its cron jobs (`director.onTimingChange`). */
  onRoutinesChange?: (() => void) | undefined;
  /** The agents' toolbox adapters and keys: decides `configured` of each tool. */
  tools?: AppTools | undefined;
}

const DAY = 86_400_000;
const enabledBody = z.object({ enabled: z.boolean() }).strict();
const levelBody = z.object({ level: z.union([z.literal(0), z.literal(1)]) }).strict();
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export function createCompany(d: ShellCompanyDeps) {
  const { hq, queue, now } = d;
  const db = hq.db;

  function routineView(r: Routine) {
    const zone = hq.routineTz(r);
    const last = r.lastTaskId !== null ? hq.task(r.lastTaskId) : undefined;
    let next: number | null = null;
    if (r.enabled) {
      try {
        next = new Cron(r.cron, { timezone: zone, paused: true }).nextRun(new Date(now()))?.getTime() ?? null;
      } catch {
        next = null;
      }
    }
    return {
      name: r.name, dept: r.dept, title: r.title, cron: r.cron, tz: zone, enabled: r.enabled,
      lastRunAt: iso(r.lastRunAt), lastStatus: last?.status ?? null, nextRunAt: iso(next),
    };
  }

  const approvalsOf = (kind: string) => (db.prepare("SELECT COUNT(*) n FROM decisions WHERE kind = ? AND decision IN ('approve', 'auto', 'autopilot')").get(kind) as { n: number }).n;
  const trustView = (kind: string) => {
    const row = queue.trustTable().find((k) => k.kind === kind)!;
    return { kind: row.kind, level: row.level, locked: row.locked, approvals: approvalsOf(kind) };
  };

  function costs() {
    const t = now();
    const p = zonedParts(t, hq.tz);
    const todayStart = zonedToMs(p.y, p.mo, p.d, 0, 0, hq.tz);
    const depts = new Set([...hq.departments(), ...(db.prepare('SELECT DISTINCT dept FROM costs').all() as { dept: string }[]).map((r) => r.dept)]);
    const byDept: Record<string, { todayUsd: number; monthUsd: number; limitUsd: number }> = {};
    const today = new Map((db.prepare('SELECT dept, SUM(usd) s FROM costs WHERE at >= ? GROUP BY dept').all(todayStart) as { dept: string; s: number }[]).map((r) => [r.dept, r.s]));
    for (const dept of [...depts].sort()) {
      byDept[dept] = { todayUsd: round(today.get(dept) ?? 0), monthUsd: round(hq.monthSpend(dept)), limitUsd: hq.deptBudget(dept) };
    }
    // the last 30 days on the company's clock (a day starts at its local midnight; fixed-offset zones, the same way the Analyst cuts weeks)
    const offset = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - Math.floor(t / 60_000) * 60_000;
    const first = todayStart - 29 * DAY;
    const perDay = new Map((db.prepare('SELECT CAST((at + ?) / ? AS INTEGER) d, SUM(usd) s FROM costs WHERE at >= ? GROUP BY d').all(offset, DAY, first) as { d: number; s: number }[]).map((r) => [r.d, r.s]));
    const byDay = Array.from({ length: 30 }, (_, i) => {
      const dayStart = first + i * DAY;
      return { date: todayIn(dayStart + DAY / 2, hq.tz), usd: round(perDay.get(Math.floor((dayStart + offset) / DAY)) ?? 0) };
    });
    return { byDept, byDay };
  }

  function get(): AdminReply {
    const office = buildOffice(hq, now());
    return ok({
      routines: hq.routines().map(routineView),
      costs: costs(),
      trust: queue.trustTable().map((k) => trustView(k.kind)),
      // the craft playbooks (knowledge/playbooks/*.md): role, file mtime, line count and the skills they were condensed from
      playbooks: listPlaybooks(d.tools?.config.knowledgeDir),
      workers: office.departments.flatMap((dep) => dep.workers.map((w) => ({ id: w.id, dept: dep.id, title: w.title, state: w.status }))),
      // the agents' toolbox (docs/tools.md): rights by department, set up or not (never a key), today's calls and errors, limits
      tools: toolList(d).map((t) => ({ name: t.name, departments: t.departments, configured: t.configured, callsToday: t.callsToday, errorsToday: t.errorsToday, limits: t.limits, env: t.env })),
    });
  }

  /** `GET /admin/company/playbooks/:role`: the whole markdown, for the Company panel. */
  function playbook(role: string): AdminReply {
    if (!isPlaybookRole(role)) return fail(404, 'not_found');
    const text = loadPlaybook(role, d.tools?.config.knowledgeDir);
    return text ? ok({ role, text }) : fail(404, 'not_found');
  }

  function toggle(name: string, body: unknown): AdminReply {
    if (!hq.routineByName(name)) return fail(404, 'not_found');
    const parsed = enabledBody.safeParse(body ?? {});
    if (!parsed.success) return fail(400, 'invalid');
    const r = hq.setRoutineEnabled(name, parsed.data.enabled)!;
    d.onRoutinesChange?.();
    return ok({ item: routineView(r) });
  }

  function run(name: string): AdminReply {
    const r = hq.routineByName(name);
    if (!r) return fail(404, 'not_found');
    if (!r.enabled) return fail(409, 'not_started', { reason: 'disabled' });
    const t = hq.runRoutine(name);
    // the `skip` policy: the previous task of the routine is still moving
    if (!t) return fail(409, 'not_started', { reason: 'busy' });
    hq.log('owner', 'routine_run_now', 'routine', name, `task ${t.id}`);
    return ok({ taskId: t.id });
  }

  function trust(kind: string, body: unknown): AdminReply {
    if (!queue.trustTable().some((k) => k.kind === kind)) return fail(404, 'not_found');
    const parsed = levelBody.safeParse(body ?? {});
    if (!parsed.success) return fail(400, 'invalid', { allowed: [0, 1] });
    // the owner's own decision, the same code as `/level <kind> <0|1>` (a locked kind is unlocked this way too)
    d.director.levelCommand(`${kind} ${parsed.data.level}`);
    return ok({ item: trustView(kind) });
  }

  return { get, playbook, toggle, run, trust };
}

/** The tool catalogue with today's counters and the set-up state (never a key); shared by `/admin/company` and the agent card. */
export function toolList(d: Pick<ShellCompanyDeps, 'hq' | 'now' | 'tools'>) {
  return toolCatalog({
    journal: d.hq, db: d.hq.db, now: d.now, tz: d.hq.tz, config: d.tools?.config ?? {}, ...(d.tools?.renderPng ? { renderPng: d.tools.renderPng } : {}), ...(d.tools?.crm ? { crm: d.tools.crm } : {}), ...(d.tools?.llm ? { llm: d.tools.llm } : {}),
    // the heads always pass their bot to `telegram.*`; the listing says so through a stand-in
    messenger: { send: () => Promise.resolve(), sendMessage: () => Promise.resolve(0), edit: () => Promise.resolve(), editButtons: () => Promise.resolve(), sendDocument: () => Promise.resolve(), sendPhotos: () => Promise.resolve() },
    ownerId: 1,
  });
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;
