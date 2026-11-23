import { Cron } from 'croner';
import { errMsg, log, zonedParts, zonedToMs, type Db } from '@fir/core';
import type { Hq } from '@fir/hq';
import type { AdminReply } from './admin.js';
import type { MarketingPlans } from './marketing-plans.js';
import { fail, ok } from './shell-crm.js';

/**
 * `GET /admin/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD`: one read-only list of what is on the calendar, for the HQ «Calendar» grid: call bookings,
 * project milestones, routine runs and planned content. Days are the company's days (`TZ`), the range is inclusive and at most 62 days.
 * Read from HQ's own tables (`call_bookings` + `li_leads`, `pm_milestones` + `pm_projects`, `routines`, `cm_items`); a table that does not exist
 * yet is an empty source. Contract: `docs/admin-crm-api.md`, «Calendar».
 */
export const CALENDAR_MAX_DAYS = 62;
const DAY = 86_400_000;
const ROUTINE_CAP = 300;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export type CalendarKind = 'call' | 'milestone' | 'routine' | 'content';
export interface CalendarEvent {
  id: string;
  kind: CalendarKind;
  /** ISO time; for `allDay` events the start of the company's day. */
  at: string;
  allDay: boolean;
  title: string;
  /** Second line: the client, the project or the routine's cron. */
  detail: string;
  dept: string;
  /** Kind-specific state: call `pending|confirmed`, milestone `open|ready|done...`, routine `scheduled`, content status (`planned`: a slot of an accepted plan). */
  status: string;
  /** Where the owner goes: `calls:<leadId>`, `projects:<id>`, `content:item:<id>`, `content:plan:<id>`, `routines:<name>`. */
  link: string;
}

const clip = (s: string, n = 120) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

export function createCalendar(d: { hq: Hq; db: Db; now: () => number; plans?: MarketingPlans }) {
  const { hq, db } = d;

  function rows<T>(sql: string, ...args: unknown[]): T[] {
    try {
      return db.prepare(sql).all(...args) as T[];
    } catch (e) {
      if (!/no such (table|column)/i.test(errMsg(e))) log('warn', 'calendar source failed', { err: errMsg(e) });
      return [];
    }
  }

  function get(query: URLSearchParams): AdminReply {
    const from = query.get('from');
    const to = query.get('to');
    if (!from || !to || !DATE.test(from) || !DATE.test(to)) return fail(400, 'invalid', { hint: 'from=YYYY-MM-DD&to=YYYY-MM-DD' });
    const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number];
    const [ty, tm, td] = to.split('-').map(Number) as [number, number, number];
    const start = zonedToMs(fy, fm, fd, 0, 0, hq.tz);
    const end = zonedToMs(ty, tm, td, 0, 0, hq.tz) + DAY; // exclusive
    if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return fail(400, 'invalid', { hint: 'to is before from' });
    if (end - start > CALENDAR_MAX_DAYS * DAY + 2 * 3_600_000) return fail(400, 'range_too_long', { maxDays: CALENDAR_MAX_DAYS });
    const iso = (ms: number) => new Date(ms).toISOString();
    const events: CalendarEvent[] = [];

    for (const r of rows<{ id: number; lead_id: number; at: number; state: string; name: string | null; service: string | null }>(
      `SELECT b.id, b.lead_id, b.at, b.state, l.name, l.service FROM call_bookings b LEFT JOIN li_leads l ON l.id = b.lead_id
       WHERE b.state != 'cancelled' AND b.at >= ? AND b.at < ? ORDER BY b.at LIMIT 300`, start, end)) {
      events.push({
        id: `call:${r.id}`, kind: 'call', at: iso(r.at), allDay: false, title: clip(r.name || `Заявка #${r.lead_id}`), detail: clip(r.service ?? ''),
        dept: 'sales', status: r.state, link: `calls:${r.lead_id}`,
      });
    }

    for (const r of rows<{ id: number; project_id: number; title: string; due_at: number; status: string; client: string | null; what: string | null }>(
      `SELECT m.id, m.project_id, m.title, m.due_at, m.status, p.client, p.what FROM pm_milestones m LEFT JOIN pm_projects p ON p.id = m.project_id
       WHERE m.due_at >= ? AND m.due_at < ? AND COALESCE(p.status, 'active') != 'draft' ORDER BY m.due_at LIMIT 300`, start, end)) {
      events.push({
        id: `milestone:${r.id}`, kind: 'milestone', at: iso(r.due_at), allDay: false, title: clip(r.title), detail: clip(r.client || r.what || ''),
        dept: 'production', status: r.status, link: `projects:${r.project_id}`,
      });
    }

    for (const r of rows<{ id: number; title: string; type: string; status: string; planned_date: string }>(
      `SELECT id, title, type, status, planned_date FROM cm_items WHERE planned_date >= ? AND planned_date <= ? AND status != 'rejected' ORDER BY planned_date, id LIMIT 300`, from, to)) {
      const [y, m, dd] = r.planned_date.split('-').map(Number) as [number, number, number];
      events.push({
        id: `content:${r.id}`, kind: 'content', at: iso(zonedToMs(y, m, dd, 0, 0, hq.tz)), allDay: true, title: clip(r.title || r.type), detail: r.type,
        dept: 'marketing', status: r.status, link: `content:item:${r.id}`,
      });
    }

    // slots of accepted marketing plans (marketing chat) until their item exists: kind `content`, status `planned`
    for (const sl of d.plans?.calendarSlots(from, to) ?? []) {
      const [y, m, dd] = sl.day.split('-').map(Number) as [number, number, number];
      events.push({
        id: `plan:${sl.planId}:${sl.n}`, kind: 'content', at: iso(zonedToMs(y, m, dd, 0, 0, hq.tz)), allDay: true, title: clip(sl.topic), detail: `${sl.type} · ${sl.platform}`,
        dept: 'marketing', status: 'planned', link: `content:plan:${sl.planId}`,
      });
    }

    let budget = ROUTINE_CAP;
    for (const r of hq.routines()) {
      if (!r.enabled || budget <= 0) continue;
      try {
        const cron = new Cron(r.cron, { timezone: hq.routineTz(r), paused: true });
        let cursor = new Date(start - 1);
        for (;;) {
          const next = cron.nextRun(cursor);
          if (!next || next.getTime() >= end || budget <= 0) break;
          events.push({
            id: `routine:${r.name}:${next.getTime()}`, kind: 'routine', at: next.toISOString(), allDay: false, title: clip(r.title || r.name), detail: r.cron,
            dept: r.dept, status: 'scheduled', link: `routines:${r.name}`,
          });
          budget--;
          cursor = next;
        }
      } catch (e) {
        log('warn', 'calendar routine skipped', { routine: r.name, err: errMsg(e) });
      }
    }

    events.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
    const p = zonedParts(d.now(), hq.tz);
    const today = `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
    const counts: Record<CalendarKind, number> = { call: 0, milestone: 0, routine: 0, content: 0 };
    for (const e of events) counts[e.kind]++;
    return ok({ from, to, tz: hq.tz, today, counts, events });
  }

  return { get };
}
