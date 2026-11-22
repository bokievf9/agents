import { migrate, type Db } from '@fir/core';
import { aggregate, weekVideoIds } from '@fir/worker-analyst';
import { z } from 'zod';
import type { AdminReply } from './admin.js';
import { StageContext, rankOf } from './lead-stage.js';
import { fail, ok } from './shell-crm.js';
import { isoWeekOf, shiftWeek, todayIn, weekRange, weekWindow } from './shell-week.js';

/**
 * Site events (`POST /events`, public with the site token) and the weekly numbers (`GET /admin/metrics/week`).
 * The table keeps counters per day, name, page, referral slug and language: no visitor id, no IP, no text. Contract: `docs/admin-crm-api.md` («Shell v3»).
 */
export const EVENT_NAMES = ['chat_open', 'builder_done', 'estimate_pdf', 'lead_sent', 'audit_sent', 'ref_click', 'cabinet_signup', 'cabinet_offer_click', 'pay_view', 'blog_view'] as const;
export type EventName = (typeof EVENT_NAMES)[number];

export const eventSchema = z.object({
  name: z.enum(EVENT_NAMES),
  path: z.string().max(300).optional(),
  ref: z.string().max(80).optional(),
  locale: z.string().max(10).optional(),
});
export type SiteEvent = z.output<typeof eventSchema>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS site_events (
  day TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT NOT NULL DEFAULT '',
  ref TEXT NOT NULL DEFAULT '',
  locale TEXT NOT NULL DEFAULT '',
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, name, path, ref, locale)
);
`;
const KEEP_DAYS = 400;

/** A page path without the query, the hash, a host or anything that could identify a person (invoice numbers, long ids). */
export function cleanPath(raw: string | undefined): string {
  if (!raw) return '';
  let p = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) {
    try {
      p = new URL(p).pathname;
    } catch {
      return '';
    }
  }
  p = (p.split('#')[0] ?? '').split('?')[0] ?? '';
  if (!p.startsWith('/')) return '';
  const segs = p.split('/').filter(Boolean).slice(0, 6).map((s, i, all) => {
    if (/^(ru|en)$/.test(s)) return s;
    if (i > 0 && /^(pay|cabinet)$/i.test(all[i - 1]!)) return ':id'; // /pay/<invoice number>, /cabinet/<anything>
    if (/^[a-z0-9-]{1,40}$/i.test(s) && !/^(?=.*\d)[a-z0-9]{24,}$/i.test(s)) return s.toLowerCase();
    return ':id';
  });
  return `/${segs.join('/')}`.slice(0, 120);
}

const cleanRef = (r: string | undefined) => (r && /^[a-z0-9_-]{1,32}$/.test(r) ? r : '');
const cleanLocale = (l: string | undefined) => (l === 'ru' || l === 'en' ? l : '');

export class SiteEvents {
  private pruned = '';
  constructor(private readonly db: Db, private readonly now: () => number, private readonly tz: () => string) {
    migrate(db, SCHEMA);
  }

  record(e: SiteEvent): void {
    const day = todayIn(this.now(), this.tz());
    this.db
      .prepare('INSERT INTO site_events (day, name, path, ref, locale, count) VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT(day, name, path, ref, locale) DO UPDATE SET count = count + 1')
      .run(day, e.name, cleanPath(e.path), cleanRef(e.ref), cleanLocale(e.locale));
    if (this.pruned !== day) {
      this.pruned = day;
      const cutoff = new Date(Date.parse(`${day}T00:00:00Z`) - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
      this.db.prepare('DELETE FROM site_events WHERE day < ?').run(cutoff);
    }
  }

  /** Event counts per name for the days `from`..`to` (`YYYY-MM-DD`, inclusive); every name present. */
  totals(from: string, to: string): Record<EventName, number> {
    const out = Object.fromEntries(EVENT_NAMES.map((n) => [n, 0])) as Record<EventName, number>;
    for (const r of this.db.prepare('SELECT name, SUM(count) n FROM site_events WHERE day >= ? AND day <= ? GROUP BY name').all(from, to) as { name: string; n: number }[]) {
      if (r.name in out) out[r.name as EventName] = r.n;
    }
    return out;
  }

  /** Event counts per day (`YYYY-MM-DD`) and name for the days `from`..`to`; only days that have rows. */
  byDay(from: string, to: string): Map<string, Record<EventName, number>> {
    const out = new Map<string, Record<EventName, number>>();
    for (const r of this.db.prepare('SELECT day, name, SUM(count) n FROM site_events WHERE day >= ? AND day <= ? GROUP BY day, name').all(from, to) as { day: string; name: string; n: number }[]) {
      if (!EVENT_NAMES.includes(r.name as EventName)) continue;
      const row = out.get(r.day) ?? (Object.fromEntries(EVENT_NAMES.map((n) => [n, 0])) as Record<EventName, number>);
      row[r.name as EventName] = r.n;
      out.set(r.day, row);
    }
    return out;
  }
}

/** The body of `POST /events`: `'ok'` stored, `'invalid'` not on the whitelist (the webhook answers 400). */
export function eventsApi(db: Db, now: () => number, tz: () => string) {
  const store = new SiteEvents(db, now, tz);
  return { handle: (data: unknown): 'ok' | 'invalid' => {
    const parsed = eventSchema.safeParse(data);
    if (!parsed.success) return 'invalid';
    store.record(parsed.data);
    return 'ok';
  }, store };
}

// ---- weekly numbers ----
/** The funnel of a window [fromMs, toMs): leads and qualified by the cohort, proposals, contracts, payments and projects by what happened in it. Shared by the weekly numbers and the dashboard. */
export function funnelBetween(db: Db, fromMs: number, toMs: number) {
  const has = (t: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) !== undefined;
  const num = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number | null } | undefined)?.n ?? 0;
    let leads = 0;
    let qualified = 0;
    if (has('li_leads')) {
      const rows = db.prepare('SELECT * FROM li_leads WHERE created_at >= ? AND created_at < ?').all(fromMs, toMs) as Parameters<StageContext['derived']>[0][];
      const ctx = StageContext.load(db);
      leads = rows.length;
      qualified = rows.filter((l) => rankOf(ctx.derived(l)) >= rankOf('qualified')).length;
    }
    const proposals = has('ps_documents') ? num("SELECT COUNT(*) n FROM ps_documents WHERE kind = 'kp' AND status = 'approved' AND COALESCE(decided_at, created_at) >= ? AND COALESCE(decided_at, created_at) < ?", fromMs, toMs) : 0;
    const contracts = has('bo_documents') ? num("SELECT COUNT(*) n FROM bo_documents WHERE type = 'contract' AND status != 'rejected' AND created_at >= ? AND created_at < ?", fromMs, toMs) : 0;
    const paid = has('bl_invoices') ? num("SELECT COUNT(*) n FROM bl_invoices WHERE status = 'paid' AND paid_at >= ? AND paid_at < ?", fromMs, toMs) : 0;
    const projects = has('pm_projects') ? num("SELECT COUNT(*) n FROM pm_projects WHERE status != 'draft' AND created_at >= ? AND created_at < ?", fromMs, toMs) : 0;
  return { leads, qualified, proposals, contracts, paid, projects };
}

export function createMetrics(db: Db, now: () => number, tz: () => string, events: SiteEvents) {
  const has = (t: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) !== undefined;
  const hasCol = (t: string, c: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).some((x) => x.name === c);
  const num = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number | null } | undefined)?.n ?? 0;

  function numbers(week: string) {
    const r = weekRange(week)!;
    const w = weekWindow(week, tz())!;
    const { fromMs, toMs } = w;
    // blog hits and published articles: the Analyst's own aggregation (cm_kv `blog_hits:<date>`, approved articles of the week)
    const base = aggregate(db, r.from, r.to, now(), tz(), null, null);
    const shorts = weekVideoIds(db, fromMs, toMs).length;
    let subscribers = 0;
    let delta = 0;
    let views = 0;
    if (has('an_snapshots')) {
      const snap = db.prepare('SELECT yt_subscribers s, yt_views v FROM an_snapshots WHERE week_end >= ? AND week_end <= ? ORDER BY week_end DESC LIMIT 1').get(r.from, r.to) as { s: number | null; v: number | null } | undefined;
      const prev = db.prepare('SELECT yt_subscribers s, yt_views v FROM an_snapshots WHERE week_end < ? ORDER BY week_end DESC LIMIT 1').get(r.from) as { s: number | null; v: number | null } | undefined;
      subscribers = snap?.s ?? 0;
      delta = snap?.s != null && prev?.s != null ? snap.s - prev.s : 0;
      views = snap?.v != null && prev?.v != null ? Math.max(0, snap.v - prev.v) : 0;
    }

    const { leads, qualified, proposals, contracts, paid, projects } = funnelBetween(db, fromMs, toMs);
    const issuedAt = has('bl_invoices') && hasCol('bl_invoices', 'issued_at') ? 'COALESCE(issued_at, created_at)' : 'created_at';
    const invoicedUsd = has('bl_invoices') ? num(`SELECT COALESCE(SUM(amount_usd), 0) n FROM bl_invoices WHERE status IN ('issued', 'paid') AND ${issuedAt} >= ? AND ${issuedAt} < ?`, fromMs, toMs) : 0;
    const paidUsd = has('bl_invoices') ? num("SELECT COALESCE(SUM(amount_usd), 0) n FROM bl_invoices WHERE status = 'paid' AND paid_at >= ? AND paid_at < ?", fromMs, toMs) : 0;
    // the seven days of the week: site events, blog hits (cm_kv) and leads, zeros when empty
    const hasKv = has('cm_kv');
    const siteDays = events.byDay(r.from, r.to);
    const emptySite = Object.fromEntries(EVENT_NAMES.map((n) => [n, 0])) as Record<EventName, number>;
    const days = Array.from({ length: 7 }, (_, i) => {
      const date = new Date(Date.parse(`${r.from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
      const hits = hasKv ? Number((db.prepare('SELECT value FROM cm_kv WHERE key = ?').get(`blog_hits:${date}`) as { value: string } | undefined)?.value ?? 0) || 0 : 0;
      const dayLeads = has('li_leads') ? num('SELECT COUNT(*) n FROM li_leads WHERE created_at >= ? AND created_at < ?', fromMs + i * 86_400_000, fromMs + (i + 1) * 86_400_000) : 0;
      return { date, site: siteDays.get(date) ?? { ...emptySite }, blog: { hits }, leads: dayLeads };
    });
    return {
      week,
      days,
      site: events.totals(r.from, r.to),
      blog: { hits: base.articles?.hits ?? 0, published: base.articles?.published ?? 0 },
      youtube: { shorts, views, subscribers, delta },
      funnel: { leads, qualified, proposals, contracts, paid, projects },
      money: { invoicedUsd: Math.round(invoicedUsd * 100) / 100, paidUsd: Math.round(paidUsd * 100) / 100 },
    };
  }

  function week(query: URLSearchParams): AdminReply {
    const wk = query.get('week') || isoWeekOf(todayIn(now(), tz()));
    if (!weekRange(wk)) return fail(400, 'invalid', { hint: 'week=YYYY-Www' });
    const cur = numbers(wk);
    const { week: prevWeek, ...prev } = numbers(shiftWeek(wk, -1));
    return ok({ ...cur, prevWeek: { week: prevWeek, ...prev } });
  }
  return { week, numbers };
}
