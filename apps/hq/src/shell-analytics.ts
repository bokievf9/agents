import type { Db } from '@fir/core';
import type { AdminReply } from './admin.js';
import { StageContext, rankOf } from './lead-stage.js';
import { fail, ok } from './shell-crm.js';
import type { createMetrics } from './shell-events.js';
import { isoWeekOf, shiftWeek, todayIn, weekRange, weekWindow } from './shell-week.js';

/**
 * `GET /admin/analytics?week=YYYY-Www`: the HQ «Analytics» section. It builds on the weekly numbers of the marketing «Цифры» tab
 * (`createMetrics().numbers`: funnel lead > qualified > proposal > contract > paid, site events), the same week against the previous
 * one, and adds what that tab does not have: the average time of the first answer to a new lead and the sources of the leads.
 * Counters only, never a lead's name, contact or text. Contract: `docs/admin-crm-api.md`, «Analytics».
 */
type Numbers = ReturnType<ReturnType<typeof createMetrics>['numbers']>;

/** The first answer to a lead: the earliest report of the lead's own task (the Sales head handled it) or the owner's reply (`lead_reply` in the activity log). */
export interface FirstResponse {
  /** Leads of the week. */
  leads: number;
  /** Leads that have an answer already. */
  answered: number;
  /** Mean and median time to the first answer, minutes; null with no answered lead. */
  avgMinutes: number | null;
  medianMinutes: number | null;
  /** Answered within an hour, share 0..1 of the answered; null with none. */
  within1hShare: number | null;
}

export interface SourceRow {
  /** `site`, `bot`, `ref` (any referral slug), `direct` (no label) or the first word of the label. */
  source: string;
  leads: number;
  qualified: number;
  paid: number;
}

const word = (origin: string): string => {
  const o = origin.trim().toLowerCase();
  if (!o) return 'direct';
  const w = /^[a-z0-9_-]{1,24}/.exec(o)?.[0];
  return w || 'other';
};

export function createAnalytics(d: { db: Db; now: () => number; tz: () => string; numbers: (week: string) => Numbers }) {
  const { db } = d;
  const has = (t: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) !== undefined;

  function firstResponse(fromMs: number, toMs: number): FirstResponse {
    const empty: FirstResponse = { leads: 0, answered: 0, avgMinutes: null, medianMinutes: null, within1hShare: null };
    if (!has('li_leads')) return empty;
    const leads = db.prepare('SELECT id, task_id, created_at FROM li_leads WHERE created_at >= ? AND created_at < ?').all(fromMs, toMs) as { id: number; task_id: number; created_at: number }[];
    const answers: number[] = [];
    for (const l of leads) {
      const times: number[] = [];
      const rep = db.prepare("SELECT MIN(at) a FROM task_events WHERE task_id = ? AND kind = 'report' AND at >= ?").get(l.task_id, l.created_at) as { a: number | null } | undefined;
      if (rep?.a != null) times.push(rep.a);
      const own = db.prepare("SELECT MIN(at) a FROM activity WHERE action = 'lead_reply' AND object_type = 'lead' AND object_id = ? AND at >= ?").get(String(l.id), l.created_at) as { a: number | null } | undefined;
      if (own?.a != null) times.push(own.a);
      if (times.length) answers.push(Math.min(...times) - l.created_at);
    }
    if (!answers.length) return { ...empty, leads: leads.length };
    const sorted = [...answers].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    const median = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
    const min = (ms: number) => Math.round((ms / 60_000) * 10) / 10;
    return {
      leads: leads.length, answered: answers.length, avgMinutes: min(answers.reduce((a, b) => a + b, 0) / answers.length), medianMinutes: min(median),
      within1hShare: Math.round((answers.filter((a) => a <= 3_600_000).length / answers.length) * 100) / 100,
    };
  }

  function sources(fromMs: number, toMs: number): SourceRow[] {
    if (!has('li_leads')) return [];
    const rows = db.prepare('SELECT * FROM li_leads WHERE created_at >= ? AND created_at < ?').all(fromMs, toMs) as (Parameters<StageContext['derived']>[0] & { origin: string })[];
    const ctx = StageContext.load(db);
    const by = new Map<string, SourceRow>();
    for (const l of rows) {
      const k = word(l.origin ?? '');
      const row = by.get(k) ?? { source: k, leads: 0, qualified: 0, paid: 0 };
      const rank = rankOf(ctx.derived(l));
      row.leads++;
      if (rank >= rankOf('qualified')) row.qualified++;
      if (rank >= rankOf('paid')) row.paid++;
      by.set(k, row);
    }
    return [...by.values()].sort((a, b) => b.leads - a.leads || a.source.localeCompare(b.source)).slice(0, 12);
  }

  function get(query: URLSearchParams): AdminReply {
    const wk = query.get('week') || isoWeekOf(todayIn(d.now(), d.tz()));
    if (!weekRange(wk)) return fail(400, 'invalid', { hint: 'week=YYYY-Www' });
    const prevWeek = shiftWeek(wk, -1);
    const win = weekWindow(wk, d.tz())!;
    const prevWin = weekWindow(prevWeek, d.tz())!;
    const cur = d.numbers(wk);
    const prev = d.numbers(prevWeek);
    const range = weekRange(wk)!;
    return ok({
      week: wk, from: range.from, to: range.to, prevWeek, tz: d.tz(),
      funnel: cur.funnel, prevFunnel: prev.funnel,
      site: cur.site, prevSite: prev.site,
      firstResponse: firstResponse(win.fromMs, win.toMs), prevFirstResponse: firstResponse(prevWin.fromMs, prevWin.toMs),
      sources: sources(win.fromMs, win.toMs),
    });
  }

  return { get };
}
