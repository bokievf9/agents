import { fail, okv, zonedParts, zonedToMs, type Db } from '@fir/core';
import { EXEC_TOOL_DEFS, priceList, type FiraTool, type ToolRegistry } from '@fir/fira';
import type { Hq } from '@fir/hq';
import { createCrm } from './admin-crm.js';
import { createChats } from './chats.js';
import { createDirectorHistory } from './director-history.js';
import { SHELL_SCREENS, type ShellLinks, type ShellScreen } from './links.js';
import { deptRu, lastReason, reasonRu } from './progress.js';
import { buildStatus } from './status.js';
import { kindRu } from './tg.js';

/**
 * The read-only tools of the owner's assistant (`packages/fira/role-packs/executive-assistant.md`), over the stores HQ already has. The definitions
 * are Fira's (`EXEC_TOOL_DEFS`, the same ones the eval set mocks); here is only `run`. Rules: nothing writes, no contacts and no texts of clients or
 * anonymous visitors in a result (names may be there), every result carries the `link` of its Shell screen.
 */

export interface AssistantToolDeps {
  hq: Hq;
  links: ShellLinks;
  /** What is waiting in the approval queue of the core (pending cards), next to the proposals of HQ. */
  pendingApprovals?: () => number;
  /** The company settings as `GET /admin/settings` answers them (`settings.ts` `view`); absent: the tool says so. Read only. */
  settingsView?: () => unknown;
}

type Period = 'today' | 'week' | 'month';
const DAY = 86_400_000;
const r2 = (n: number) => Math.round(n * 100) / 100;
const clip = (s: string, n = 80) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const str = (v: unknown, n = 80): string => (typeof v === 'string' ? clip(v, n) : '');
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : typeof v === 'string' && /^\d{1,9}$/.test(v) ? Number(v) : null);
const periodOf = (v: unknown, dflt: Period): Period => (v === 'today' || v === 'week' || v === 'month' ? v : dflt);
const PERIOD_RU: Record<Period, string> = { today: 'сегодня', week: '7 дней', month: 'с начала месяца' };

function has(db: Db, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function count(db: Db, sql: string, ...args: unknown[]): number {
  try {
    return Number((db.prepare(sql).get(...args) as { c: number | null } | undefined)?.c ?? 0);
  } catch {
    return 0; // a worker table that does not exist yet counts as empty
  }
}

export function assistantTools(d: AssistantToolDeps): ToolRegistry {
  const { hq, links } = d;
  const db = hq.db;
  const crm = () => createCrm(db, hq.now).views;
  const now = () => hq.now();
  /** Start of the owner's day, of the last 7 days, of his month. */
  const since = (p: Period): number => {
    if (p === 'month') return hq.monthStart();
    if (p === 'week') return now() - 7 * DAY;
    const z = zonedParts(now(), hq.ownerTz);
    return zonedToMs(z.y, z.mo, z.d, 0, 0, hq.ownerTz);
  };
  const tool = (name: string, run: FiraTool['run']): [string, FiraTool] => [name, { def: EXEC_TOOL_DEFS[name]!, run }];
  const dayMonth = (ms: number) => {
    const p = zonedParts(ms, hq.ownerTz);
    return `${String(p.d).padStart(2, '0')}.${String(p.mo).padStart(2, '0')}`;
  };
  const hm = (ms: number) => {
    const p = zonedParts(ms, hq.ownerTz);
    return `${dayMonth(ms)} ${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
  };
  const notDrill = "(',' || tags || ',') NOT LIKE '%,drill,%'";
  const waitingApprovals = () => hq.queuedApprovals().length + hq.heldApprovals().filter((l) => l.kind === 'content_pack').length + (d.pendingApprovals?.() ?? 0);

  const leadItem = (l: { id: number; name: string; source: string; niche: string; service: string; stage: string; createdAt: string | null; enrichment: { productFamily?: string } | null; callAt: string | null }) => ({
    id: l.id, name: clip(l.name || `заявка #${l.id}`, 60), source: l.source, niche: l.niche || null, product: l.enrichment?.productFamily || l.service || null, stage: l.stage,
    createdAt: l.createdAt ? dayMonth(Date.parse(l.createdAt)) : null, call: l.callAt ? hm(Date.parse(l.callAt)) : null, link: links.to('lead', l.id),
  });

  const entries: [string, FiraTool][] = [
    tool('hq_overview', () => {
      const day = since('today');
      const week = since('week');
      const usage = hq.llmUsage(day);
      return Promise.resolve(okv({
        today: {
          leads: has(db, 'li_leads') ? count(db, 'SELECT COUNT(*) c FROM li_leads WHERE created_at >= ?', day) : 0,
          newClients: has(db, 'cab_clients') ? count(db, 'SELECT COUNT(*) c FROM cab_clients WHERE created_at >= ?', day) : 0,
          paymentsUsd: r2(count(db, "SELECT COALESCE(SUM(amount_usd), 0) c FROM bl_invoices WHERE status = 'paid' AND paid_at >= ?", day)),
        },
        week: {
          leads: has(db, 'li_leads') ? count(db, 'SELECT COUNT(*) c FROM li_leads WHERE created_at >= ?', week) : 0,
          newClients: has(db, 'cab_clients') ? count(db, 'SELECT COUNT(*) c FROM cab_clients WHERE created_at >= ?', week) : 0,
          payments: count(db, "SELECT COUNT(*) c FROM bl_invoices WHERE status = 'paid' AND paid_at >= ?", week),
          paymentsUsd: r2(count(db, "SELECT COALESCE(SUM(amount_usd), 0) c FROM bl_invoices WHERE status = 'paid' AND paid_at >= ?", week)),
        },
        approvalsWaiting: waitingApprovals(),
        openTasks: count(db, `SELECT COUNT(*) c FROM tasks WHERE status NOT IN ('done','rejected') AND ${notDrill}`),
        blockedTasks: count(db, `SELECT COUNT(*) c FROM tasks WHERE status = 'blocked' AND ${notDrill}`),
        llmTodayCalls: usage.calls, llmTodayUsd: r2(usage.usd),
        link: links.to('home'),
      }));
    }),

    tool('leads', (input) => {
      if (!has(db, 'li_leads')) return Promise.resolve(okv({ count: 0, items: [], note: 'заявок ещё нет', link: links.to('leads') }));
      const v = crm();
      const id = int(input.id);
      if (id !== null) {
        const l = v.lead(id);
        return Promise.resolve(l ? okv({ lead: { ...leadItem(l), nextAction: l.nextAction, cabinet: l.cabinet, budget: l.budget || null }, link: links.to('lead', id) }) : okv({ lead: null, note: `заявки #${id} нет`, link: links.to('leads') }));
      }
      const period = periodOf(input.period, 'week');
      const q = str(input.query, 60).toLowerCase();
      const from = since(period);
      const rows = v.leadsWhere('created_at >= ?', [from]).filter((l) => !q || [l.name, l.niche, l.service, l.source, l.enrichment?.productFamily ?? ''].some((x) => x.toLowerCase().includes(q)));
      const byStage: Record<string, number> = {};
      for (const l of rows) byStage[l.stage] = (byStage[l.stage] ?? 0) + 1;
      return Promise.resolve(okv({ period: PERIOD_RU[period], query: q || null, count: rows.length, byStage, items: rows.slice(0, 8).map(leadItem), link: links.to('leads') }));
    }),

    tool('clients', (input) => {
      if (!has(db, 'cab_clients')) return Promise.resolve(okv({ total: 0, items: [], note: 'кабинетов клиентов ещё нет', link: links.to('clients') }));
      const q = str(input.query, 60).toLowerCase();
      const rows = db.prepare('SELECT id, name, created_at FROM cab_clients ORDER BY id DESC LIMIT 200').all() as { id: number; name: string; created_at: number }[];
      const found = rows.filter((r) => !q || r.name.toLowerCase().includes(q));
      const leadsOf = (id: number) => (has(db, 'li_leads') ? count(db, 'SELECT COUNT(*) c FROM li_leads WHERE client_id = ?', id) : 0);
      const projectsOf = (id: number) => (has(db, 'pm_projects') && has(db, 'li_leads') ? count(db, 'SELECT COUNT(*) c FROM pm_projects WHERE lead_id IN (SELECT id FROM li_leads WHERE client_id = ?)', id) : 0);
      return Promise.resolve(okv({
        total: count(db, 'SELECT COUNT(*) c FROM cab_clients'), newWeek: count(db, 'SELECT COUNT(*) c FROM cab_clients WHERE created_at >= ?', since('week')), query: q || null,
        items: found.slice(0, 8).map((r) => ({ id: r.id, name: clip(r.name || `клиент #${r.id}`, 60), since: dayMonth(r.created_at), leads: leadsOf(r.id), projects: projectsOf(r.id) })),
        link: links.to('clients'),
      }));
    }),

    tool('projects', (input) => {
      if (!has(db, 'pm_projects')) return Promise.resolve(okv({ items: [], note: 'проектов ещё нет', link: links.to('projects') }));
      const v = crm();
      const id = int(input.id);
      const q = str(input.query, 60).toLowerCase();
      const list = id !== null ? [v.project(id)].filter((x) => x !== undefined) : v.projectsWhere('', []).filter((p) => !q || [p.client, p.what, p.product].some((x) => String(x).toLowerCase().includes(q)));
      const items = list.slice(0, 5).map((p) => ({
        id: p.id, client: clip(p.client, 60), what: clip(p.what, 80), status: p.status, state: p.state, next: p.nextAction ?? null,
        stages: (p.milestones as { stageNo: number | null; amountUsd: number | null; state: string | null; title: string | null }[]).filter((m) => m.stageNo !== null)
          .map((m) => ({ no: m.stageNo, title: m.title, amountUsd: m.amountUsd, state: m.state })),
        link: links.to('project', p.id),
      }));
      return Promise.resolve(okv({ query: q || null, count: list.length, items, link: links.to('projects') }));
    }),

    tool('approvals_queue', () => {
      const rows = db.prepare("SELECT id, kind, payload, created_at, held FROM task_approvals WHERE state IN ('queued','asked') AND kind != 'content_item' ORDER BY id").all() as { id: number; kind: string; payload: string; created_at: number; held: number }[];
      const open = rows.filter((r) => r.held === 0 || r.kind === 'content_pack');
      const byKind: Record<string, number> = {};
      for (const r of open) byKind[kindRu(r.kind)] = (byKind[kindRu(r.kind)] ?? 0) + 1;
      const clientOf = (raw: string) => {
        try {
          const p = JSON.parse(raw) as Record<string, unknown>;
          return str(p.client, 40) || str(p.clientName, 40) || str(p.business, 40) || str(p.referred, 40) || null;
        } catch {
          return null;
        }
      };
      const hours = (at: number) => Math.max(0, Math.round((now() - at) / 3_600_000));
      return Promise.resolve(okv({
        waiting: open.length, byKind, oldestHours: open.length ? hours(Math.min(...open.map((r) => r.created_at))) : null,
        items: open.slice(0, 8).map((r) => ({ kind: kindRu(r.kind), client: clientOf(r.payload), hours: hours(r.created_at), link: links.to('review', r.id) })),
        link: links.to('review'),
      }));
    }),

    tool('chats', () => {
      const reply = createChats({ hq, now: hq.now }).list(new URLSearchParams('status=open&limit=50'));
      const items = ((reply.body.items ?? []) as { client: { name: string | null }; channels: string[]; unread: number; lastAt: string | null; textsStored: boolean }[]);
      const waiting = items.filter((t) => t.unread > 0);
      return Promise.resolve(okv({
        waiting: waiting.length,
        // names only: no preview, no contact, and an anonymous visitor is just «посетитель»
        items: waiting.slice(0, 8).map((t) => ({ client: t.client.name ? clip(t.client.name, 40) : 'посетитель', channels: t.channels, unread: t.unread, lastAt: t.lastAt ? hm(Date.parse(t.lastAt)) : null })),
        link: links.to('chats'),
      }));
    }),

    tool('money', (input) => {
      if (!has(db, 'bl_invoices')) return Promise.resolve(okv({ paid: 0, paidUsd: 0, open: [], note: 'счетов ещё нет', link: links.to('money') }));
      const period = periodOf(input.period, 'week');
      const from = since(period);
      const stage = (db.prepare('PRAGMA table_info(bl_invoices)').all() as { name: string }[]).some((c) => c.name === 'stage_no');
      const paid = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(amount_usd), 0) s FROM bl_invoices WHERE status = 'paid' AND paid_at >= ?").get(from) as { n: number; s: number };
      const open = db.prepare(`SELECT number, client, amount_usd, due_date${stage ? ', stage_no' : ''} FROM bl_invoices WHERE status = 'issued' ORDER BY id DESC LIMIT 10`).all() as { number: string; client: string; amount_usd: number; due_date: string; stage_no?: number | null }[];
      const today = new Date(now()).toISOString().slice(0, 10);
      return Promise.resolve(okv({
        period: PERIOD_RU[period], paid: paid.n, paidUsd: r2(paid.s),
        open: open.map((i) => ({ number: i.number, client: clip(i.client, 40), stage: i.stage_no ?? null, amountUsd: i.amount_usd, due: i.due_date, overdue: i.due_date < today })),
        link: links.to('money'),
      }));
    }),

    tool('llm_costs', (input) => {
      const period = periodOf(input.period, 'month');
      const from = since(period);
      const usage = hq.llmUsage(from);
      const month = hq.monthStart();
      const byDept = hq.costSummary(from).map((r) => {
        const limit = hq.deptBudget(r.dept);
        const spentMonth = hq.costSummary(month).find((x) => x.dept === r.dept)?.usd ?? 0;
        return { dept: deptRu(r.dept), usd: r2(r.usd), limitUsd: limit > 0 ? limit : null, limitPct: limit > 0 ? Math.round((spentMonth / limit) * 100) : null };
      });
      return Promise.resolve(okv({ period: PERIOD_RU[period], calls: usage.calls, usd: r2(usage.usd), byDept, link: links.to('company') }));
    }),

    tool('tasks', (input) => {
      const dept = str(input.dept, 20).toLowerCase();
      if (dept && !hq.departments().includes(dept)) return Promise.resolve(fail('invalid', `нет отдела ${dept}; есть: ${hq.departments().join(', ')}`));
      const open = hq.tasks({ ...(dept ? { dept } : {}), open: true, limit: 1000 }).filter((t) => !t.tags.includes('drill'));
      const byStatus: Record<string, number> = {};
      for (const t of open) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
      const blocked = open.filter((t) => t.status === 'blocked').slice(0, 8).map((t) => ({
        id: t.id, dept: deptRu(t.dept), title: clip(t.title, 70), why: t.tags.includes('builder') ? 'у строителей' : reasonRu(lastReason(hq, t)),
      }));
      return Promise.resolve(okv({ dept: dept ? deptRu(dept) : 'все отделы', open: open.length, byStatus, blocked, link: links.to('tasks') }));
    }),

    tool('director_history', (input) => {
      const limit = Math.min(Math.max(int(input.limit) ?? 10, 1), 20);
      const items = createDirectorHistory(db, hq.now).list(limit).map((h) => ({ at: hm(Date.parse(h.at)), role: h.role, text: clip(h.text, 200), taskId: h.taskId }));
      return Promise.resolve(okv({ items, link: links.to('tasks') }));
    }),

    tool('services_status', () => {
      const s = buildStatus(db, now());
      const TITLE_RU: Record<string, string> = { site: 'сайт', hq: 'Shell', bot: 'клиентский Telegram', omniroute: 'модели (Claude или шлюз)', renderer: 'рендер видео' };
      const down = s.services.filter((x) => x.state === 'down' || x.state === 'degraded').map((x) => ({ name: TITLE_RU[x.id] ?? x.title, state: x.state, since: x.since ? hm(Date.parse(x.since)) : null }));
      const up = s.services.filter((x) => x.state === 'up').map((x) => TITLE_RU[x.id] ?? x.title);
      const unknown = s.services.filter((x) => x.state === 'unknown').map((x) => TITLE_RU[x.id] ?? x.title);
      return Promise.resolve(okv({ ok: down.length === 0, down, up, unknown, link: links.to('company') }));
    }),

    tool('company_settings', () => {
      const v = d.settingsView?.() as { settings?: Record<string, unknown>; usage?: unknown; restartRequired?: boolean } | null | undefined;
      if (!v?.settings) return Promise.resolve(okv({ available: false, link: links.to('settings') }));
      const { trust, ...rest } = v.settings as { trust?: { defaultThreshold?: number; kinds?: { kind: string; level: number; threshold: number }[] } } & Record<string, unknown>;
      return Promise.resolve(okv({ ...rest, trust: { defaultThreshold: trust?.defaultThreshold, level1: (trust?.kinds ?? []).filter((k) => k.level === 1).map((k) => k.kind) }, usage: v.usage, restartRequired: v.restartRequired === true, link: links.to('settings') }));
    }),

    ['price_list', priceList],

    tool('shell_link', (input) => {
      const screen = (SHELL_SCREENS as readonly string[]).includes(String(input.screen)) ? (input.screen as ShellScreen) : 'home';
      return Promise.resolve(okv({ url: links.to(screen, int(input.id)) }));
    }),
  ];
  return Object.fromEntries(entries);
}
