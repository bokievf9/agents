import { errMsg, log, zonedParts, zonedToMs } from '@fir/core';
import type { Hq } from '@fir/hq';
import type { AdminReply } from './admin.js';
import { StageContext, rankOf } from './lead-stage.js';
import { buildOffice } from './office.js';
import { pendingApprovals } from './review.js';
import { fail, ok } from './shell-crm.js';
import { funnelBetween } from './shell-events.js';
import { buildStatus } from './status.js';
import { kindRu } from './tg.js';
import { isoWeekOf, shiftWeek, todayIn, weekWindow } from './shell-week.js';

/**
 * `GET /admin/dashboard?range=today|7d|30d` (default 7d): one read-only object for the Shell Dashboard (tiles and three charts).
 * Every number is computed from HQ's own tables; each block is built apart, so a missing or broken table gives `{ available: false }`
 * for that block and never fails the endpoint. `today` is the company's calendar day, `7d` and `30d` are rolling windows ending now.
 * Counters only, never a name, contact or text. Cached 30 s per range. Contract: `docs/admin-crm-api.md`, «Dashboard».
 */
export const DASHBOARD_RANGES = ['today', '7d', '30d'] as const;
export type DashboardRange = (typeof DASHBOARD_RANGES)[number];
const DAY = 86_400_000;
const TTL_MS = 30_000;
/** Open tickets without an answer this long are past the SLA (`SUPPORT_SLA_HOURS`, 4). */
const SLA_MS = 4 * 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const round2 = (n: number) => Math.round(n * 100) / 100;
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

type Json = Record<string, unknown>;

export function createDashboard(d: { hq: Hq; now: () => number }) {
  const { hq } = d;
  const db = hq.db;
  const has = (t: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) !== undefined;
  const all = <T>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as T[];
  const one = <T>(sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as T | undefined;
  const num = (sql: string, ...p: unknown[]) => one<{ n: number | null }>(sql, ...p)?.n ?? 0;
  const cache = new Map<DashboardRange, { at: number; body: Json }>();

  /** One block: a source table that is missing, or any error inside, gives `{ available: false }`. */
  function block(name: string, tables: string[], f: () => Json): Json {
    try {
      if (!tables.every(has)) return { available: false };
      return { available: true, ...f() };
    } catch (e) {
      log('warn', 'dashboard block failed', { block: name, err: errMsg(e) });
      return { available: false };
    }
  }

  function build(range: DashboardRange): Json {
    const tz = hq.tz;
    const now = d.now();
    const p = zonedParts(now, tz);
    const todayStart = zonedToMs(p.y, p.mo, p.d, 0, 0, tz);
    const fromMs = range === 'today' ? todayStart : now - (range === '7d' ? 7 : 30) * DAY;
    const today = todayIn(now, tz);
    // the calendar days the window touches, each with its [start, end) on the company's clock
    const days: { day: string; a: number; b: number }[] = [];
    for (let s = fromMs, guard = 0; s <= now && guard < 40; guard++) {
      const dayLabel = todayIn(s + 1, tz);
      const [y, m, dd] = dayLabel.split('-').map(Number) as [number, number, number];
      const a = zonedToMs(y, m, dd, 0, 0, tz);
      const b = zonedToMs(y, m, dd + 1, 0, 0, tz);
      days.push({ day: dayLabel, a: Math.max(a, fromMs), b: Math.min(b, now + 1) });
      s = b;
    }

    const leads = block('leads', ['li_leads'], () => {
      const rows = all<Parameters<StageContext['derived']>[0] & { created_at: number }>('SELECT * FROM li_leads WHERE created_at >= ? AND created_at <= ?', fromMs, now);
      const ctx = StageContext.load(db);
      let inWork = 0;
      let won = 0;
      let lost = 0;
      const per = new Map<string, number>();
      for (const l of rows) {
        const st = ctx.stageOf(l);
        if (st === 'lost') lost++;
        else if (rankOf(st) >= rankOf('paid')) won++;
        else if (rankOf(st) >= rankOf('qualified')) inWork++;
        const day = days.find((x) => l.created_at >= x.a && l.created_at < x.b)?.day;
        if (day) per.set(day, (per.get(day) ?? 0) + 1);
      }
      return {
        new: rows.length, inWork, won, lost, conversion: rows.length ? round6(won / rows.length) : null,
        perDay: days.map((x) => ({ day: x.day, n: per.get(x.day) ?? 0 })),
      };
    });

    const approvals = block('approvals', ['task_approvals', 'approvals'], () => {
      const rows = pendingApprovals(db);
      const kinds = new Map<string, number>();
      const depts = new Map<string, number>();
      for (const r of rows) {
        kinds.set(r.kind, (kinds.get(r.kind) ?? 0) + r.n);
        depts.set(r.dept, (depts.get(r.dept) ?? 0) + r.n);
      }
      const sorted = <T extends { n: number }>(a: T[], key: (x: T) => string) => a.sort((x, y) => y.n - x.n || key(x).localeCompare(key(y)));
      return {
        waiting: rows.reduce((s, r) => s + r.n, 0),
        byKind: sorted([...kinds].map(([kind, n]) => ({ kind, label: kindRu(kind), n })), (x) => x.kind),
        byDept: sorted([...depts].map(([dept, n]) => ({ dept, n })), (x) => x.dept),
      };
    });

    const money = block('money', ['bl_invoices'], () => {
      const sum = (where: string, ...a: unknown[]) => one<{ s: number; n: number }>(`SELECT COALESCE(SUM(amount_usd), 0) s, COUNT(*) n FROM bl_invoices WHERE ${where}`, ...a) ?? { s: 0, n: 0 };
      const paid = sum("status = 'paid' AND paid_at >= ? AND paid_at <= ?", fromMs, now);
      const pending = sum("status = 'issued' AND due_date >= ?", today);
      const overdue = sum("status = 'issued' AND due_date < ?", today);
      const perWeek: { week: string; paid: number }[] = [];
      const thisWeek = isoWeekOf(today);
      for (let i = 7; i >= 0; i--) {
        const wk = shiftWeek(thisWeek, -i);
        const w = weekWindow(wk, tz)!;
        perWeek.push({ week: wk, paid: round2(num("SELECT COALESCE(SUM(amount_usd), 0) n FROM bl_invoices WHERE status = 'paid' AND paid_at >= ? AND paid_at < ?", w.fromMs, w.toMs)) });
      }
      return {
        currency: 'USD', paid: round2(paid.s), pending: round2(pending.s), overdue: round2(overdue.s),
        invoices: { paid: paid.n, pending: pending.n, overdue: overdue.n }, perWeek,
      };
    });

    const projects = block('projects', ['pm_projects'], () => {
      const byStage = all<{ stage: string; n: number }>('SELECT status stage, COUNT(*) n FROM pm_projects GROUP BY status ORDER BY n DESC, status');
      const n = (s: string) => byStage.find((x) => x.stage === s)?.n ?? 0;
      return { byStage, active: n('active'), closed: n('done') };
    });

    const tickets = block('tickets', ['cs_tickets'], () => {
      const answered = one<{ n: number; avg: number | null }>("SELECT COUNT(*) n, AVG(answered_at - created_at) avg FROM cs_tickets WHERE answered_at IS NOT NULL AND answered_at >= ? AND answered_at <= ?", fromMs, now);
      return {
        open: num("SELECT COUNT(*) n FROM cs_tickets WHERE status = 'open'"),
        overdue: num("SELECT COUNT(*) n FROM cs_tickets WHERE status = 'open' AND created_at <= ?", now - SLA_MS),
        answeredToday: num('SELECT COUNT(*) n FROM cs_tickets WHERE answered_at >= ? AND answered_at <= ?', todayStart, now),
        avgFirstResponseMin: answered && answered.n > 0 && answered.avg !== null ? Math.round((answered.avg / 60_000) * 10) / 10 : null,
      };
    });

    const content = block('content', ['cm_items'], () => {
      const hasReady = has('cm_ready');
      const queue = Array.from({ length: 7 }, (_, i) => {
        const [y, m, dd] = today.split('-').map(Number) as [number, number, number];
        const day = todayIn(zonedToMs(y, m, dd + i, 12, 0, tz), tz);
        const items = all<{ id: number; status: string }>("SELECT id, status FROM cm_items WHERE planned_date = ? AND status != 'rejected'", day);
        let approved = 0;
        let published = 0;
        for (const it of items) {
          const rows = hasReady ? all<{ status: string }>('SELECT status FROM cm_ready WHERE item_id = ?', it.id) : [];
          if (rows.length > 0 && rows.every((r) => r.status === 'published')) published++;
          else if (it.status === 'ready' || rows.length > 0) approved++;
        }
        return { day, planned: items.length, approved, published };
      });
      return { queue, waitingApproval: num("SELECT COUNT(*) n FROM cm_items WHERE status = 'proposed'") };
    });

    const agents = block('agents', ['costs', 'tasks'], () => {
      const spendSince = (t: number) => num('SELECT COALESCE(SUM(usd), 0) n FROM costs WHERE at >= ?', t);
      const depts = new Set([...hq.departments(), ...all<{ dept: string }>('SELECT DISTINCT dept FROM costs').map((r) => r.dept)]);
      const byDept = [...depts].sort().map((dept) => ({ dept, spendMonth: round6(hq.monthSpend(dept, now)), limit: hq.deptBudget(dept) }));
      const limits = byDept.filter((x) => x.limit > 0);
      const office = buildOffice(hq, now);
      return {
        activeNow: office.departments.reduce((s, dep) => s + dep.workers.filter((w) => w.status === 'working').length, 0),
        tasksToday: num("SELECT COUNT(*) n FROM tasks WHERE created_at >= ? AND tags NOT LIKE '%drill%'", todayStart),
        tasksFailedToday: num("SELECT COUNT(*) n FROM tasks WHERE status IN ('blocked', 'rejected') AND updated_at >= ? AND tags NOT LIKE '%drill%'", todayStart),
        spendToday: round6(spendSince(todayStart)),
        spendMonth: round6(byDept.reduce((s, x) => s + x.spendMonth, 0)),
        budgetMonth: limits.length ? round6(limits.reduce((s, x) => s + x.limit, 0)) : null,
        byDept,
      };
    });

    const services = block('services', [], () => ({
      items: buildStatus(db, now).services.map((s) => ({ id: s.id, title: s.title, state: s.state === 'up' ? 'ok' : s.state })),
    }));
    // `services` is a list in the contract: unwrap the block's items
    const servicesOut: unknown = services.available === true ? services.items : { available: false };

    const funnel = block('funnel', ['li_leads'], () => {
      const f = funnelBetween(db, fromMs, now + 1);
      return { steps: Object.entries(f).map(([step, n]) => ({ step, n })) };
    });
    const funnelOut: unknown = funnel.available === true ? funnel.steps : { available: false };

    return {
      ok: true, range, from: iso(fromMs), to: iso(now), tz, generatedAt: iso(now),
      leads, approvals, money, projects, tickets, content, agents, services: servicesOut, funnel: funnelOut,
    };
  }

  function get(query: URLSearchParams): AdminReply {
    const raw = query.get('range') ?? '7d';
    if (!(DASHBOARD_RANGES as readonly string[]).includes(raw)) return fail(400, 'invalid', { fields: ['range'], allowed: DASHBOARD_RANGES });
    const range = raw as DashboardRange;
    const t = d.now();
    const hit = cache.get(range);
    if (hit && t - hit.at < TTL_MS && t >= hit.at) return ok(hit.body);
    const body = build(range);
    cache.set(range, { at: t, body });
    return ok(body);
  }

  return { get };
}
