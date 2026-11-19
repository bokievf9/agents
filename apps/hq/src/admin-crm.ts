import type { Db } from '@fir/core';
import { ProspectStore, STATUSES as PROSPECT_STATUSES, TRANSITIONS as PROSPECT_TRANSITIONS, type Status as ProspectStatus } from '@fir/worker-prospector';
import { z } from 'zod';

/**
 * Owner's CRM panels of the website («Пульт», `/admin/crm/*`): read-mostly views over the tables of the workers.
 * Contract: `docs/admin-crm-api.md`. A panel whose table does not exist answers `available: false` with an empty list.
 * Never returns tokens, keys or model prompts; visitor texts are capped at TEXT_CAP characters.
 */
export interface CrmReply {
  status: number;
  body: Record<string, unknown>;
}

const TEXT_CAP = 500;
const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 200;
export const TICKET_STATUSES = ['open', 'answered'] as const;

const iso = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());
const cap = (s: string | null | undefined) => (s ?? '').slice(0, TEXT_CAP);
const ok = (body: Record<string, unknown>): CrmReply => ({ status: 200, body: { ok: true, ...body } });
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): CrmReply => ({ status, body: { ok: false, error, ...extra } });
const likeEsc = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const prospectPost = z.object({ status: z.string().max(40).optional(), note: z.string().max(2000).optional() }).strict();
const ticketPost = z.object({ status: z.string().max(40).optional(), note: z.string().max(2000).optional(), reply: z.string().optional() }).strict();

interface Page {
  limit: number;
  cursor: number | null;
  q: string;
}

export function createCrm(db: Db, now: () => number = Date.now): { handle(method: string, seg: string[], query: URLSearchParams, body: unknown): CrmReply } {
  const has = (t: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) !== undefined;
  const all = <T>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as T[];
  const one = <T>(sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as T | undefined;

  db.exec('CREATE TABLE IF NOT EXISTS crm_notes (kind TEXT NOT NULL, ref_id INTEGER NOT NULL, note TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (kind, ref_id))');
  const note = (kind: string, id: number) => one<{ note: string }>('SELECT note FROM crm_notes WHERE kind = ? AND ref_id = ?', kind, id)?.note ?? '';
  const setNote = (kind: string, id: number, text: string) =>
    db.prepare('INSERT INTO crm_notes (kind, ref_id, note, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(kind, ref_id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at').run(kind, id, text, now());

  const intParam = (v: string | null) => (v !== null && /^\d+$/.test(v) ? Number(v) : null);
  const page = (query: URLSearchParams): Page => ({
    limit: Math.min(Math.max(intParam(query.get('limit')) ?? LIMIT_DEFAULT, 1), LIMIT_MAX),
    cursor: intParam(query.get('cursor')),
    q: (query.get('q') ?? '').trim().slice(0, 100),
  });
  const unavailable = (extra: Record<string, unknown> = {}) => ok({ available: false, items: [], nextCursor: null, ...extra });

  /** id-descending pages of one table: `where` (without cursor) and `cols` for the text search. */
  function idPage<R extends { id: number }>(table: string, p: Page, cols: string[], filters: { sql: string; params: unknown[] }[] = []) {
    const where: string[] = [];
    const params: unknown[] = [];
    for (const f of filters) { where.push(f.sql); params.push(...f.params); }
    if (p.q) { where.push(`(${cols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`); params.push(...cols.map(() => likeEsc(p.q))); }
    if (p.cursor !== null) { where.push('id < ?'); params.push(p.cursor); }
    const rows = all<R>(`SELECT * FROM ${table}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`, ...params, p.limit + 1);
    const more = rows.length > p.limit;
    const items = rows.slice(0, p.limit);
    return { items, nextCursor: more ? items[items.length - 1]!.id : null };
  }

  const countBy = (table: string, col: string, where = ''): Record<string, number> =>
    Object.fromEntries(all<{ k: string; n: number }>(`SELECT ${col} k, COUNT(*) n FROM ${table} ${where} GROUP BY ${col}`).map((r) => [r.k, r.n]));

  // ---- prospects ----
  interface PrRow {
    id: number; ext_id: string; niche: string; city: string; name: string; website: string; instagram: string; telegram: string; phone: string;
    noticed: string; offer: string; hook: string; source: string; status: string; draft: string | null; draft_kind: string | null; followups: number;
    created_at: number; proposed_at: number | null; sent_at: number | null; replied_at: number | null; sent_text: string | null;
  }
  const prospectView = (r: PrRow) => ({
    id: r.id, name: r.name, niche: r.niche, city: r.city, website: r.website, instagram: r.instagram, telegram: r.telegram, phone: r.phone,
    noticed: cap(r.noticed), offer: cap(r.offer), hook: cap(r.hook), source: r.source, status: r.status,
    nextStatuses: PROSPECT_TRANSITIONS[r.status as ProspectStatus] ?? [], followups: r.followups,
    draft: r.draft ? cap(r.draft) : null, draftKind: r.draft_kind, sentText: r.sent_text ? cap(r.sent_text) : null, note: note('prospect', r.id),
    createdAt: iso(r.created_at), proposedAt: iso(r.proposed_at), sentAt: iso(r.sent_at), repliedAt: iso(r.replied_at),
  });

  function prospects(method: string, id: number | null, query: URLSearchParams, body: unknown): CrmReply {
    if (!has('pr_prospects')) return method === 'GET' && id === null ? unavailable({ statuses: PROSPECT_STATUSES }) : fail(404, 'not_found');
    if (method === 'GET' && id === null) {
      const p = page(query);
      const status = query.get('status');
      const niche = query.get('niche');
      const filters = [
        ...(status ? [{ sql: 'status = ?', params: [status] }] : []),
        ...(niche ? [{ sql: 'niche = ?', params: [niche] }] : []),
      ];
      if (status && !PROSPECT_STATUSES.includes(status as ProspectStatus)) return fail(400, 'invalid_status', { allowed: PROSPECT_STATUSES });
      const r = idPage<PrRow>('pr_prospects', p, ['name', 'city', 'niche', 'phone', 'telegram', 'instagram', 'website'], filters);
      return ok({ available: true, statuses: PROSPECT_STATUSES, items: r.items.map(prospectView), nextCursor: r.nextCursor });
    }
    if (method === 'POST' && id !== null) {
      const row = one<PrRow>('SELECT * FROM pr_prospects WHERE id = ?', id);
      if (!row) return fail(404, 'not_found');
      const parsed = prospectPost.safeParse(body ?? {});
      if (!parsed.success) return fail(400, 'invalid', { allowed: PROSPECT_STATUSES });
      const { status, note: text } = parsed.data;
      if (status !== undefined) {
        if (!PROSPECT_STATUSES.includes(status as ProspectStatus)) return fail(400, 'invalid_status', { allowed: PROSPECT_STATUSES });
        if (status !== row.status) {
          const next = PROSPECT_TRANSITIONS[row.status as ProspectStatus];
          if (!next.includes(status as ProspectStatus)) return fail(409, 'illegal_transition', { from: row.status, allowed: next });
          new ProspectStore(db, now).transition(id, status as ProspectStatus);
        }
      }
      if (text !== undefined) setNote('prospect', id, text);
      return ok({ available: true, statuses: PROSPECT_STATUSES, item: prospectView(one<PrRow>('SELECT * FROM pr_prospects WHERE id = ?', id)!) });
    }
    return fail(404, 'not_found');
  }

  // ---- leads (Lead Intake) ----
  interface LeadRow {
    id: number; task_id: number; name: string; contact: string; service: string; niche: string; task: string; deadline: string; budget: string;
    origin: string; temperature: string; lang: string; chosen_slot: number | null; price_asked: number; price_approved: number; created_at: number;
  }
  const leadStatus = (taskId: number) => one<{ status: string }>('SELECT status FROM tasks WHERE id = ?', taskId)?.status ?? null;
  function leads(query: URLSearchParams): CrmReply {
    if (!has('li_leads')) return unavailable();
    const p = page(query);
    const r = idPage<LeadRow>('li_leads', p, ['name', 'contact', 'service', 'niche', 'origin']);
    return ok({
      available: true,
      items: r.items.map((l) => ({
        id: l.id, kind: 'lead', taskId: l.task_id, status: leadStatus(l.task_id), name: l.name, contact: l.contact, service: l.service, niche: l.niche,
        task: cap(l.task), deadline: l.deadline, budget: l.budget, source: l.origin, temperature: l.temperature, lang: l.lang,
        priceAsked: l.price_asked === 1, priceApproved: l.price_approved === 1, createdAt: iso(l.created_at),
      })),
      nextCursor: r.nextCursor,
    });
  }

  // ---- clients: one row per distinct client name across leads, support, projects, invoices and documents ----
  interface Client {
    key: string; name: string; contact: string; sources: Set<string>; firstTouch: number; lastTouch: number;
    counts: { leads: number; tickets: number; projects: number; invoices: number; documents: number };
  }
  function clients(query: URLSearchParams): CrmReply {
    const p = page(query);
    const map = new Map<string, Client>();
    const touch = (name: string, contact: string, source: string, at: number, count: keyof Client['counts'] | null) => {
      const n = name.trim();
      if (!n) return;
      const key = n.toLowerCase();
      const c = map.get(key) ?? { key, name: n, contact: '', sources: new Set<string>(), firstTouch: at, lastTouch: at, counts: { leads: 0, tickets: 0, projects: 0, invoices: 0, documents: 0 } };
      if (!c.contact && contact) c.contact = contact;
      c.sources.add(source);
      c.firstTouch = Math.min(c.firstTouch, at);
      c.lastTouch = Math.max(c.lastTouch, at);
      if (count) c.counts[count]++;
      map.set(key, c);
    };
    if (has('li_leads')) for (const l of all<{ name: string; contact: string; origin: string; created_at: number }>('SELECT name, contact, origin, created_at FROM li_leads')) touch(l.name, l.contact, l.origin || 'lead', l.created_at, 'leads');
    if (has('cs_clients')) for (const c of all<{ name: string; contact: string; created_at: number }>('SELECT name, contact, created_at FROM cs_clients')) touch(c.name, c.contact, 'support', c.created_at, null);
    if (has('cs_tickets')) for (const t of all<{ client_name: string; contact: string; created_at: number }>('SELECT client_name, contact, created_at FROM cs_tickets')) touch(t.client_name, t.contact, 'support', t.created_at, 'tickets');
    if (has('pm_projects')) for (const r of all<{ client: string; created_at: number }>('SELECT client, created_at FROM pm_projects')) touch(r.client, '', 'project', r.created_at, 'projects');
    if (has('bl_invoices')) for (const r of all<{ client: string; created_at: number }>('SELECT client, created_at FROM bl_invoices')) touch(r.client, '', 'billing', r.created_at, 'invoices');
    if (has('bo_documents')) for (const r of all<{ client: string; created_at: number }>('SELECT client, created_at FROM bo_documents')) touch(r.client, '', 'documents', r.created_at, 'documents');
    let list = [...map.values()];
    if (p.q) {
      const q = p.q.toLowerCase();
      list = list.filter((c) => c.name.toLowerCase().includes(q) || c.contact.toLowerCase().includes(q));
    }
    list.sort((a, b) => b.lastTouch - a.lastTouch || a.key.localeCompare(b.key));
    const start = p.cursor ?? 0;
    const slice = list.slice(start, start + p.limit);
    const chats = {
      web: has('web_chat_sessions') ? (one<{ n: number }>('SELECT COUNT(*) n FROM web_chat_sessions')?.n ?? 0) : 0,
      telegram: has('cb_chats') ? (one<{ n: number }>('SELECT COUNT(*) n FROM cb_chats')?.n ?? 0) : 0,
    };
    return ok({
      available: map.size > 0 || has('li_leads') || has('cs_clients'),
      // anonymous chat sessions carry no name or contact, so they cannot be attributed to a client: only their totals are given
      chats,
      items: slice.map((c) => ({ name: c.name, contact: c.contact, sources: [...c.sources].sort(), firstTouchAt: iso(c.firstTouch), lastTouchAt: iso(c.lastTouch), counts: c.counts })),
      nextCursor: start + p.limit < list.length ? start + p.limit : null,
    });
  }

  // ---- tickets ----
  interface TicketRow { id: number; client_id: number | null; client_name: string; contact: string; text: string; status: string; money: number; alerted: number; created_at: number; answered_at: number | null }
  const ticketView = (t: TicketRow) => ({
    id: t.id, clientName: t.client_name, contact: t.contact, text: cap(t.text), status: t.status, money: t.money === 1, slaAlerted: t.alerted === 1,
    note: note('ticket', t.id), createdAt: iso(t.created_at), answeredAt: iso(t.answered_at),
  });
  function tickets(method: string, id: number | null, query: URLSearchParams, body: unknown): CrmReply {
    const statuses = [...TICKET_STATUSES];
    if (!has('cs_tickets')) return method === 'GET' && id === null ? unavailable({ statuses }) : fail(404, 'not_found');
    if (method === 'GET' && id === null) {
      const p = page(query);
      const status = query.get('status');
      if (status && !statuses.includes(status as 'open')) return fail(400, 'invalid_status', { allowed: statuses });
      const r = idPage<TicketRow>('cs_tickets', p, ['client_name', 'contact', 'text'], status ? [{ sql: 'status = ?', params: [status] }] : []);
      return ok({ available: true, statuses, items: r.items.map(ticketView), nextCursor: r.nextCursor });
    }
    if (method === 'POST' && id !== null) {
      const row = one<TicketRow>('SELECT * FROM cs_tickets WHERE id = ?', id);
      if (!row) return fail(404, 'not_found');
      const parsed = ticketPost.safeParse(body ?? {});
      if (!parsed.success) return fail(400, 'invalid', { allowed: statuses });
      const { status, note: text, reply } = parsed.data;
      // a reply to a client is an outgoing message: it goes through the Support head and the approval queue, never straight from here
      if (reply !== undefined) return fail(400, 'reply_not_supported', { hint: 'answer through POST /admin/say or /admin/command (ticket), the draft goes to approvals' });
      if (status !== undefined) {
        if (!statuses.includes(status as 'open')) return fail(400, 'invalid_status', { allowed: statuses });
        if (status === 'answered') db.prepare("UPDATE cs_tickets SET status = 'answered', answered_at = COALESCE(answered_at, ?) WHERE id = ?").run(now(), id);
        else db.prepare("UPDATE cs_tickets SET status = 'open', answered_at = NULL WHERE id = ?").run(id);
      }
      if (text !== undefined) setNote('ticket', id, text);
      return ok({ available: true, statuses, item: ticketView(one<TicketRow>('SELECT * FROM cs_tickets WHERE id = ?', id)!) });
    }
    return fail(404, 'not_found');
  }

  // ---- documents: bo_documents (contract, offer, privacy, act), ps_documents (kp, estimate, contract draft), bl_invoices ----
  interface Doc {
    id: string; source: 'back_office' | 'presales' | 'billing'; kind: string; status: string; client: string; title: string; excerpt: string;
    amountUsd: number | null; number: string | null; createdAt: number; link: null;
  }
  function documents(query: URLSearchParams): CrmReply {
    const p = page(query);
    const docs: Doc[] = [];
    if (has('bo_documents')) {
      for (const d of all<{ id: number; type: string; client: string; version: number; text: string; status: string; created_at: number }>('SELECT * FROM bo_documents'))
        docs.push({ id: `bo:${d.id}`, source: 'back_office', kind: d.type, status: d.status, client: d.client, title: `${d.type} v${d.version}`, excerpt: cap(d.text), amountUsd: null, number: null, createdAt: d.created_at, link: null });
    }
    if (has('ps_documents')) {
      for (const d of all<{ id: number; lead_id: number | null; kind: string; title: string; body: string; status: string; created_at: number }>('SELECT * FROM ps_documents')) {
        const lead = d.lead_id !== null && has('li_leads') ? one<{ name: string }>('SELECT name FROM li_leads WHERE id = ?', d.lead_id)?.name ?? '' : '';
        docs.push({ id: `ps:${d.id}`, source: 'presales', kind: d.kind, status: d.status, client: lead, title: d.title, excerpt: cap(d.body), amountUsd: null, number: null, createdAt: d.created_at, link: null });
      }
    }
    if (has('bl_invoices')) {
      for (const d of all<{ id: number; number: string; client: string; amount_usd: number; what: string; status: string; created_at: number }>('SELECT * FROM bl_invoices'))
        docs.push({ id: `bl:${d.id}`, source: 'billing', kind: 'invoice', status: d.status, client: d.client, title: d.what || d.number, excerpt: cap(d.what), amountUsd: d.amount_usd, number: d.number, createdAt: d.created_at, link: null });
    }
    const kind = query.get('kind');
    const status = query.get('status');
    const q = p.q.toLowerCase();
    const list = docs
      .filter((d) => (!kind || d.kind === kind) && (!status || d.status === status) && (!q || `${d.client} ${d.title} ${d.number ?? ''}`.toLowerCase().includes(q)))
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    const start = p.cursor ?? 0;
    const kinds = [...new Set(docs.map((d) => d.kind))].sort();
    return ok({
      available: has('bo_documents') || has('ps_documents') || has('bl_invoices'),
      kinds,
      items: list.slice(start, start + p.limit).map((d) => ({ ...d, createdAt: iso(d.createdAt) })),
      nextCursor: start + p.limit < list.length ? start + p.limit : null,
    });
  }

  // ---- projects ----
  interface ProjRow { id: number; client: string; what: string; product: string; status: string; source: string; task_id: number | null; created_at: number }
  function projects(query: URLSearchParams): CrmReply {
    if (!has('pm_projects')) return unavailable();
    const p = page(query);
    const status = query.get('status');
    const r = idPage<ProjRow>('pm_projects', p, ['client', 'what', 'product'], status ? [{ sql: 'status = ?', params: [status] }] : []);
    const msTable = has('pm_milestones');
    return ok({
      available: true,
      items: r.items.map((pr) => {
        const ms = msTable ? all<{ kind: string; title: string; due_at: number; status: string }>('SELECT kind, title, due_at, status FROM pm_milestones WHERE project_id = ? ORDER BY due_at, id', pr.id) : [];
        const open = ms.filter((m) => m.status !== 'done');
        const next = open[0];
        const last = ms.at(-1);
        return {
          id: pr.id, client: pr.client, what: cap(pr.what), product: pr.product, status: pr.status, source: pr.source, taskId: pr.task_id,
          stage: pr.status === 'draft' ? 'spec' : pr.status === 'done' ? 'done' : next?.kind ?? 'done',
          deadline: iso(next?.due_at ?? last?.due_at), nextMilestone: next ? { kind: next.kind, title: next.title, dueAt: iso(next.due_at) } : null,
          tasksTotal: ms.length, tasksDone: ms.length - open.length, createdAt: iso(pr.created_at),
        };
      }),
      nextCursor: r.nextCursor,
    });
  }

  // ---- referrals ----
  interface RefRow { id: number; referrer: string; referred: string; lead_id: number | null; source: string; status: string; reward: string; reward_requested: number; created_at: number; paid_at: number | null; rewarded_at: number | null }
  function referrals(query: URLSearchParams): CrmReply {
    if (!has('rf_referrals')) return unavailable();
    const p = page(query);
    const status = query.get('status');
    const r = idPage<RefRow>('rf_referrals', p, ['referrer', 'referred'], status ? [{ sql: 'status = ?', params: [status] }] : []);
    return ok({
      available: true,
      statuses: ['proposed', 'paid', 'rewarded'],
      items: r.items.map((x) => ({
        id: x.id, referrer: x.referrer, referred: x.referred, leadId: x.lead_id, source: x.source, status: x.status, reward: x.reward,
        rewardRequested: x.reward_requested === 1, createdAt: iso(x.created_at), paidAt: iso(x.paid_at), rewardedAt: iso(x.rewarded_at),
      })),
      nextCursor: r.nextCursor,
    });
  }

  // ---- summary ----
  function summary(): CrmReply {
    const prospectCounts = has('pr_prospects') ? { ...Object.fromEntries(PROSPECT_STATUSES.map((s) => [s, 0])), ...countBy('pr_prospects', 'status') } : {};
    const leadCounts = has('li_leads')
      ? Object.fromEntries(all<{ k: string; n: number }>('SELECT COALESCE(t.status, \'unknown\') k, COUNT(*) n FROM li_leads l LEFT JOIN tasks t ON t.id = l.task_id GROUP BY k').map((r) => [r.k, r.n]))
      : {};
    const tickets = has('cs_tickets') ? { open: 0, answered: 0, ...countBy('cs_tickets', 'status') } : {};
    const docs: Record<string, Record<string, number>> = {};
    const addDocs = (kind: string, status: string, n: number) => { (docs[kind] ??= {})[status] = ((docs[kind] ??= {})[status] ?? 0) + n; };
    if (has('bo_documents')) for (const r of all<{ k: string; s: string; n: number }>('SELECT type k, status s, COUNT(*) n FROM bo_documents GROUP BY type, status')) addDocs(r.k, r.s, r.n);
    if (has('ps_documents')) for (const r of all<{ k: string; s: string; n: number }>('SELECT kind k, status s, COUNT(*) n FROM ps_documents GROUP BY kind, status')) addDocs(r.k, r.s, r.n);
    if (has('bl_invoices')) for (const r of all<{ s: string; n: number }>('SELECT status s, COUNT(*) n FROM bl_invoices GROUP BY status')) addDocs('invoice', r.s, r.n);
    const projectCounts = has('pm_projects') ? { draft: 0, active: 0, done: 0, ...countBy('pm_projects', 'status') } : {};
    const referralCounts = has('rf_referrals') ? { proposed: 0, paid: 0, rewarded: 0, ...countBy('rf_referrals', 'status') } : {};
    const chats = {
      web: has('web_chat_sessions') ? (one<{ n: number }>('SELECT COUNT(*) n FROM web_chat_sessions')?.n ?? 0) : 0,
      telegram: has('cb_chats') ? (one<{ n: number }>('SELECT COUNT(*) n FROM cb_chats')?.n ?? 0) : 0,
    };
    const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
    return ok({
      generatedAt: iso(now()),
      prospects: { available: has('pr_prospects'), total: sum(prospectCounts), byStatus: prospectCounts },
      leads: { available: has('li_leads'), total: sum(leadCounts), byStatus: leadCounts },
      tickets: { available: has('cs_tickets'), open: (tickets as Record<string, number>).open ?? 0, byStatus: tickets },
      documents: { available: has('bo_documents') || has('ps_documents') || has('bl_invoices'), pending: Object.values(docs).reduce((a, s) => a + (s.pending ?? 0) + (s.draft ?? 0) + (s.issued ?? 0), 0), byKind: docs },
      projects: { available: has('pm_projects'), active: (projectCounts as Record<string, number>).active ?? 0, byStatus: projectCounts },
      referrals: { available: has('rf_referrals'), total: sum(referralCounts), byStatus: referralCounts },
      reviews: { available: false, pending: 0 },
      chats: { available: has('web_chat_sessions') || has('cb_chats'), ...chats },
    });
  }

  return {
    handle(method, seg, query, body) {
      const [panel, idRaw] = seg;
      const id = idRaw !== undefined ? intParam(idRaw) : null;
      if (idRaw !== undefined && id === null) return fail(404, 'not_found');
      if (seg.length > 2) return fail(404, 'not_found');
      const get = method === 'GET' && id === null;
      switch (panel) {
        case 'summary': return get ? summary() : fail(404, 'not_found');
        case 'prospects': return prospects(method, id, query, body);
        case 'tickets': return tickets(method, id, query, body);
        case 'leads': return get ? leads(query) : fail(404, 'not_found');
        case 'clients': return get ? clients(query) : fail(404, 'not_found');
        case 'documents': return get ? documents(query) : fail(404, 'not_found');
        case 'projects': return get ? projects(query) : fail(404, 'not_found');
        case 'referrals': return get ? referrals(query) : fail(404, 'not_found');
        case 'reviews': return get ? unavailable() : fail(404, 'not_found');
        default: return fail(404, 'not_found');
      }
    },
  };
}
