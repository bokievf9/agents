import { errMsg, log, serviceName, zonedParts, zonedToMs } from '@fir/core';
import type { Hq } from '@fir/hq';
import type { AdminReply } from './admin.js';
import { StageContext, nextActionOf, rankOf, type Stage } from './lead-stage.js';
import { noContacts } from './notices.js';
import type { OwnerChannel } from './presence.js';
import { pendingApprovalRows, pendingApprovals, pendingApprovalsCount } from './review.js';
import { fail, ok } from './shell-crm.js';
import { funnelBetween } from './shell-events.js';
import { todayIn } from './shell-week.js';
import type { TeamPresence } from './team-presence.js';
import { buildStatus } from './status.js';

/**
 * `GET /admin/today?tz=` (2026-11-27, contract `docs/admin-crm-api.md`, «GET /admin/today»): the first screen of the Shell in one read-only object.
 * The blocks are built apart: a source table that is missing, or any error inside, gives `{ available: false }` for that block and never a 500.
 * A table that exists but holds nothing is NOT unavailable: it is a block with zeros and empty lists. Cached 10 s per `tz`.
 * `decide` is the review queue itself (`review.ts`: one definition, one count). The «night» line is written by code from the journal (leads,
 * payments, tickets, alerts, finished tasks): no model call, first names only.
 */
const TTL_MS = 10_000;
const DAY = 86_400_000;
const HOUR = 3_600_000;
const SLA_MS = 4 * HOUR;
const NIGHT_ITEMS = 4;
const DECIDE_ITEMS = 10;
const HOT_LEADS = 5;
const LEAD_WINDOW_MS = 30 * DAY;
const iso = (ms: number) => new Date(ms).toISOString();
const round2 = (n: number) => Math.round(n * 100) / 100;
const firstName = (s: string) => s.trim().split(/\s+/)[0] ?? '';
const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};
const usd = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
/** Russian plural: 1 лид, 2 лида, 5 лидов. */
const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10;
  const m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};
const ageText = (min: number) => (min >= 1440 ? `${Math.floor(min / 1440)} д` : min >= 60 ? `${Math.floor(min / 60)} ч` : `${Math.max(min, 1)} мин`);

type Json = Record<string, unknown>;
type DecideKind = 'document' | 'reply' | 'content' | 'money' | 'other';

const KIND_OF: Record<string, DecideKind> = {
  content_item: 'content', article: 'content', seo_proposal: 'content', content_pack: 'content',
  bo_document: 'document', presales_pack: 'document', pm_spec: 'document', onboarding_guide: 'document', audit: 'document', pm_client_status: 'document',
  support_answer: 'reply', lead_reply: 'reply', prospect_first: 'reply', prospect_followup: 'reply', prospect_reply: 'reply',
  billing_invoice: 'money', billing_reminder: 'money', support_money: 'money', lead_price: 'money', referral_reward: 'money', referral_payout: 'money',
};
export const decideKindOf = (kind: string): DecideKind => KIND_OF[kind] ?? 'other';
const KIND_LABEL: Record<DecideKind, string> = { document: 'Документ', reply: 'Ответ', content: 'Контент', money: 'Деньги', other: 'Другое' };
/** The batch prefix of a card summary («[2/9] marketing, задача #4») is not part of the title. */
const stripPrefix = (s: string) => s.replace(/^\[\d+\/\d+\][^\n]*\n/, '').replace(/^Срочно,[^\n]*\n/, '');

const STAGE_RU: Partial<Record<Stage, string>> = { new: 'Новый', qualified: 'Квалифицирован', proposal: 'КП', contract: 'Договор', paid: 'Оплачен' };
const CHANNEL: Record<string, string> = { site: 'site', form: 'site', web: 'site', lead: 'site', chat: 'site', telegram: 'telegram', bot: 'telegram', cabinet: 'cabinet', referral: 'referral', owner: 'manual' };
const TEAM_STATE: Record<string, string> = { working: 'working', waiting: 'waiting', idle: 'idle', off: 'blocked' };
const TEAM_RANK: Record<string, number> = { working: 0, waiting: 1, blocked: 2, idle: 3 };

export interface TodayDeps {
  hq: Hq;
  now: () => number;
  presence: TeamPresence;
  channel: OwnerChannel;
}

export function createToday(d: TodayDeps) {
  const { hq } = d;
  const db = hq.db;
  const has = (t: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) !== undefined;
  const all = <T>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as T[];
  const one = <T>(sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as T | undefined;
  const cache = new Map<string, { at: number; body: Json }>();

  function block(name: string, tables: string[], f: () => Json): Json {
    try {
      if (!tables.every(has)) return { available: false };
      return { available: true, ...f() };
    } catch (e) {
      log('warn', 'today block failed', { block: name, err: errMsg(e) });
      return { available: false };
    }
  }

  /** Where the night begins: the later of the owner's last time at the desk and 22:00 on his clock. At the desk now: 22:00 only (the desk session has no start mark). */
  function nightStart(now: number, ownerTz: string): number {
    const p = zonedParts(now, ownerTz);
    let ten = zonedToMs(p.y, p.mo, p.d, 22, 0, ownerTz);
    if (ten > now) ten = zonedToMs(p.y, p.mo, p.d - 1, 22, 0, ownerTz);
    const atDesk = d.channel.effective() === 'desk';
    const last = d.channel.lastPingAt;
    return !atDesk && last !== null && last <= now ? Math.max(last, ten) : ten;
  }

  /** The tickets nobody answered for more than the SLA, oldest first. */
  function slowTickets(now: number): { id: number; name: string; ageMs: number }[] {
    if (!has('cs_tickets')) return [];
    return all<{ id: number; client_name: string; created_at: number }>("SELECT id, client_name, created_at FROM cs_tickets WHERE status = 'open' AND created_at <= ? ORDER BY created_at LIMIT 20", now - SLA_MS)
      .map((r) => ({ id: r.id, name: firstName(r.client_name), ageMs: now - r.created_at }));
  }

  function build(tz: string): Json {
    const now = d.now();
    const p = zonedParts(now, tz);
    const todayStart = zonedToMs(p.y, p.mo, p.d, 0, 0, tz);
    const today = todayIn(now, tz);

    // ---- decide: the review queue ----
    const decide = block('decide', ['task_approvals', 'approvals'], () => {
      const total = pendingApprovalsCount(db);
      const byKind: Record<string, number> = {};
      for (const r of pendingApprovals(db)) {
        const k = decideKindOf(r.kind);
        byKind[k] = (byKind[k] ?? 0) + r.n;
      }
      const items = pendingApprovalRows(db, DECIDE_ITEMS).map((r) => {
        const kind = decideKindOf(r.kind);
        const id = `ap_${r.id}`;
        const href = `/admin/approvals?id=${id}`;
        const ageMinutes = Math.max(0, Math.round((now - r.createdAt) / 60_000));
        return {
          id, kind, title: clip(stripPrefix(r.summary).split('\n')[0] ?? '', 140) || KIND_LABEL[kind], meta: `${KIND_LABEL[kind]} · ${r.dept.charAt(0).toUpperCase()}${r.dept.slice(1)} · ${ageText(ageMinutes)}`, ageMinutes, href,
          actions: [
            { id: 'open', label: 'Открыть', kind: 'link', href },
            { id: 'approve', label: 'Одобрить', kind: 'post', url: `/admin/review/${id}`, body: { action: 'approve' }, primary: true },
          ],
        };
      });
      return { total, items, byKind };
    });

    // ---- hot leads ----
    const hotLeads = block('hotLeads', ['li_leads'], () => {
      const rows = all<{ id: number; task_id: number; name: string; contact: string; service: string; budget: string; origin: string; created_at: number; estimate?: string | null; stage_override?: string | null }>(
        'SELECT * FROM li_leads WHERE created_at >= ?', now - LEAD_WINDOW_MS,
      );
      const ctx = StageContext.load(db);
      const drill = has('tasks') ? new Set(all<{ id: number }>("SELECT id FROM tasks WHERE tags LIKE '%drill%'").map((r) => r.id)) : new Set<number>();
      const open = rows
        .filter((l) => !drill.has(l.task_id))
        .map((l) => ({ l, stage: ctx.stageOf(l) }))
        .filter((x) => x.stage !== 'lost' && x.stage !== 'project')
        .sort((a, b) => rankOf(a.stage) - rankOf(b.stage) || a.l.created_at - b.l.created_at || a.l.id - b.l.id)
        .slice(0, HOT_LEADS);
      return {
        items: open.map(({ l, stage }) => {
          const id = `l_${l.id}`;
          const amount = Number(/\d[\d\s.,]*/.exec(l.budget ?? '')?.[0]?.replace(/[\s,]/g, '')) || 0;
          const action = nextActionOf(stage);
          const next = stage === 'new'
            ? { label: 'Ответить', href: `/admin/chats?lead=${id}` }
            : stage === 'qualified' ? { label: 'Проверить КП', href: '/admin/approvals' }
            : { label: stage === 'proposal' ? 'Договор' : stage === 'contract' ? 'Счёт' : 'Запустить проект', href: `/admin/clients?focus=${id}` };
          return {
            id, name: firstName(l.name) || 'Без имени', what: l.service ? serviceName(l.service) : 'заявка', amount, stage, stageLabel: STAGE_RU[stage] ?? stage,
            ageMinutes: Math.max(0, Math.round((now - l.created_at) / 60_000)), channel: CHANNEL[(l.origin ?? '').toLowerCase()] ?? 'other',
            next: action ? next : null,
          };
        }),
      };
    });

    // ---- money: the last 7 days of payments and what is open ----
    const money = block('money', ['bl_invoices'], () => {
      const sum = (where: string, ...a: unknown[]) => one<{ s: number; n: number }>(`SELECT COALESCE(SUM(amount_usd), 0) s, COUNT(*) n FROM bl_invoices WHERE ${where}`, ...a) ?? { s: 0, n: 0 };
      const perDay: { day: string; paid: number }[] = [];
      for (let i = 6; i >= 0; i--) {
        const a = zonedToMs(p.y, p.mo, p.d - i, 0, 0, tz);
        const b = zonedToMs(p.y, p.mo, p.d - i + 1, 0, 0, tz);
        const day = todayIn(a + 1, tz);
        perDay.push({ day, paid: round2(sum("status = 'paid' AND paid_at >= ? AND paid_at < ?", a, b).s) });
      }
      const overdue = sum("status = 'issued' AND due_date < ?", today);
      return {
        paid7d: round2(perDay.reduce((s, x) => s + x.paid, 0)), pending: round2(sum("status = 'issued' AND due_date >= ?", today).s),
        overdue: round2(overdue.s), overdueCount: overdue.n, perDay,
      };
    });

    // ---- funnel: 30 days ----
    const funnel = block('funnel', ['li_leads'], () => {
      const f = funnelBetween(db, now - 30 * DAY, now + 1);
      return { days: 30, steps: [{ step: 'leads', label: 'Лиды', n: f.leads }, { step: 'quotes', label: 'КП', n: f.proposals }, { step: 'contracts', label: 'Договор', n: f.contracts }, { step: 'paid', label: 'Оплата', n: f.paid }] };
    });

    // ---- team ----
    const team = block('team', ['costs'], () => {
      const members = d.presence.members();
      const items = members
        .map((m) => ({ id: m.id, title: m.title, state: TEAM_STATE[m.presence] ?? 'idle', doing: m.now ?? '', href: `/admin/team/${m.id}` }))
        .sort((a, b) => (TEAM_RANK[a.state] ?? 9) - (TEAM_RANK[b.state] ?? 9));
      const spend = one<{ s: number }>('SELECT COALESCE(SUM(usd), 0) s FROM costs WHERE at >= ?', todayStart)?.s ?? 0;
      const depts = new Set(members.map((m) => m.dept));
      const month = [...depts].reduce((s, dept) => s + hq.deptBudget(dept), 0);
      const dim = new Date(Date.UTC(p.y, p.mo, 0)).getUTCDate();
      return { busy: items.filter((x) => x.state === 'working').length, total: items.length, items, spendToday: round2(spend), limitToday: month > 0 ? round2(month / dim) : null };
    });

    // ---- alerts: services down, tickets past the SLA, unread alerts of the inbox ----
    const alertItems = (): Json[] => {
      const out: Json[] = [];
      try {
        for (const s of buildStatus(db, now).services) {
          if (s.state === 'down' || s.state === 'degraded') out.push({ id: `a_svc_${s.id}`, level: s.state === 'down' ? 'bad' : 'warn', text: `Сервис «${s.title}»: ${s.state === 'down' ? 'не работает' : 'работает с перебоями'}`, href: '/admin/company' });
        }
      } catch (e) {
        log('warn', 'today alerts: services failed', { err: errMsg(e) });
      }
      for (const t of slowTickets(now).slice(0, 3)) {
        const h = Math.floor(t.ageMs / HOUR);
        out.push({ id: `a_ticket_${t.id}`, level: t.ageMs >= DAY ? 'bad' : 'warn', text: `Тикет${t.name ? ` ${t.name}` : ''} без ответа больше ${h} ч`, href: `/admin/chats?thread=t_${t.id}` });
      }
      if (has('owner_inbox')) {
        for (const r of all<{ id: number; text: string }>("SELECT id, text FROM owner_inbox WHERE kind = 'alert' AND read = 0 AND at >= ? ORDER BY id DESC LIMIT 3", now - 3 * DAY)) {
          out.push({ id: `a_inbox_${r.id}`, level: 'warn', text: clip(noContacts(r.text), 140), href: '/admin/inbox' });
        }
      }
      return out.slice(0, 6);
    };
    const alerts = block('alerts', [], () => ({ items: alertItems() }));

    // ---- night: the journal since the owner left, written by code ----
    const night = block('night', [], () => {
      const since = nightStart(now, hq.ownerTz);
      const items: { kind: string; text: string; href: string }[] = [];
      if (has('bl_invoices')) {
        const paid = all<{ number: string; amount_usd: number; lead_id?: number | null }>("SELECT * FROM bl_invoices WHERE status = 'paid' AND paid_at >= ? ORDER BY paid_at DESC", since);
        if (paid.length === 1) items.push({ kind: 'payment', text: `оплата ${usd(paid[0]!.amount_usd)} по ${paid[0]!.number}`, href: paid[0]!.lead_id ? `/admin/clients?focus=l_${paid[0]!.lead_id}` : '/admin/finance' });
        else if (paid.length > 1) items.push({ kind: 'payment', text: `${paid.length} ${plural(paid.length, 'оплата', 'оплаты', 'оплат')} на ${usd(paid.reduce((s, x) => s + x.amount_usd, 0))}`, href: '/admin/finance' });
      }
      if (has('li_leads')) {
        const drill = has('tasks') ? new Set(all<{ id: number }>("SELECT id FROM tasks WHERE tags LIKE '%drill%'").map((r) => r.id)) : new Set<number>();
        const leads = all<{ id: number; task_id: number; name: string }>('SELECT id, task_id, name FROM li_leads WHERE created_at >= ? ORDER BY id DESC', since).filter((l) => !drill.has(l.task_id));
        if (leads.length === 1) items.push({ kind: 'lead', text: `новый лид${firstName(leads[0]!.name) ? ` ${firstName(leads[0]!.name)}` : ''}`, href: `/admin/clients?focus=l_${leads[0]!.id}` });
        else if (leads.length > 1) items.push({ kind: 'lead', text: `${leads.length} ${plural(leads.length, 'новый лид', 'новых лида', 'новых лидов')}`, href: `/admin/clients?focus=l_${leads[0]!.id}` });
      }
      const slow = slowTickets(now)[0];
      if (slow) items.push({ kind: 'alert', text: `тикет${slow.name ? ` ${slow.name}` : ''} без ответа ${Math.floor(slow.ageMs / HOUR)} ч`, href: `/admin/chats?thread=t_${slow.id}` });
      else if (has('owner_inbox')) {
        const n = one<{ n: number }>("SELECT COUNT(*) n FROM owner_inbox WHERE kind = 'alert' AND at >= ?", since)?.n ?? 0;
        if (n > 0) items.push({ kind: 'alert', text: `${n} ${plural(n, 'алерт', 'алерта', 'алертов')}`, href: '/admin/inbox' });
      }
      if (has('tasks')) {
        const done = all<{ dept: string; n: number }>("SELECT dept, COUNT(*) n FROM tasks WHERE status = 'done' AND updated_at >= ? AND tags NOT LIKE '%drill%' GROUP BY dept", since);
        const mk = done.find((x) => x.dept === 'marketing')?.n ?? 0;
        const rest = done.filter((x) => x.dept !== 'marketing').reduce((s, x) => s + x.n, 0);
        if (mk > 0) items.push({ kind: 'content', text: `${mk} ${plural(mk, 'материал готов', 'материала готово', 'материалов готово')}`, href: '/admin/tasks' });
        if (rest > 0) items.push({ kind: 'task', text: `${rest} ${plural(rest, 'задача выполнена', 'задачи выполнены', 'задач выполнено')}`, href: '/admin/tasks' });
      }
      const shown = items.slice(0, NIGHT_ITEMS);
      return { text: shown.length ? shown.map((x) => x.text).join(', ') : 'Тихая ночь, ничего нового', items: shown };
    });

    return { generatedAt: iso(now), tz, date: today, night, decide, hotLeads, money, funnel, team, alerts };
  }

  function get(query: URLSearchParams): AdminReply {
    const tz = query.get('tz') || hq.ownerTz;
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
    } catch {
      return fail(400, 'invalid', { fields: ['tz'] });
    }
    const t = d.now();
    const hit = cache.get(tz);
    if (hit && t - hit.at < TTL_MS && t >= hit.at) return ok(hit.body);
    const body = build(tz);
    cache.set(tz, { at: t, body });
    if (cache.size > 8) cache.delete(cache.keys().next().value as string);
    return ok(body);
  }

  return { get };
}
