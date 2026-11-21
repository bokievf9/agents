import { errMsg, log, type Db } from '@fir/core';
import { ProspectStore, STATUSES as PROSPECT_STATUSES, TRANSITIONS as PROSPECT_TRANSITIONS, type Status as ProspectStatus } from '@fir/worker-prospector';
import { CsStore } from '@fir/worker-customer-support';
import { parseEnrichment } from '@fir/worker-lead-intake';
import { builderTotal } from '@fir/worker-presales';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { addCabMessage, ensureCabinetTables, MESSAGE_CAP, nextStepOf, stageMoveTitle, stageNextStep, timelineTitle } from './cabinet.js';
import { stageState, stageTitleRu } from '@fir/worker-project-manager';
import { ensureStageColumn, nextActionOf, StageContext, type Stage } from './lead-stage.js';
import { clientNextAction, docNextStep, docsOf, ensureDocTables, projectStateOf } from './cab-docs.js';
import type { CabinetApi } from './cabinet-api.js';

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
/** The breakdown block of the site reads these in full (the site trims them again to 2000 characters). */
const BREAKDOWN_CAP = 4000;
const BUILDER_URL = /https?:\/\/(?:www\.)?firtech\.pro\/[^\s<>"')\]]*builder[^\s<>"')\]]*[?&]b=[^\s<>"')\]]+/i;
/** The builder link of a lead: the one the receptionist stored in the enrichment, else the first firtech.pro builder link in the lead's text or estimate. */
export function builderUrlOf(enrichment: { builderLink?: string } | null, ...texts: (string | null | undefined)[]): string | null {
  if (enrichment?.builderLink) return enrichment.builderLink.slice(0, 2000);
  for (const t of texts) {
    const m = t ? BUILDER_URL.exec(t) : null;
    if (m) return m[0].replace(/[.,;:!?]+$/, '').slice(0, 2000);
  }
  return null;
}
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

/** Side effects of the cabinet endpoints that live outside the CRM views: the owner's line and the support flow. */
export interface CrmHooks {
  /** A short non-blocking line for the owner (inbox, Telegram digest when away). */
  notifyOwner?: (text: string) => void;
  /** A cabinet ticket was stored: the Support head drafts the answer (fire and forget). */
  cabinetTicket?: (t: { id: number; name: string; text: string; telegram: string; leadId?: number }) => void;
  /** A line for the Sales head's journal of a lead's task (a cabinet client wrote about the lead). */
  leadJournal?: (taskId: number, text: string) => void;
  /** The pay page link of an invoice (`BillingWorker.payUrl`); without it a stage carries no `payUrl`. */
  payUrl?: (inv: { number: string; payKey: string | null; locale: 'ru' | 'en' }) => string | null;
  /** The client accepts a stage (Production: `acceptStage`, which proposes the next invoice). */
  acceptStage?: (projectId: number, stageNo: number) => Promise<{ status: 'accepted' | 'already' | 'not_paid' | 'not_ready' | 'unknown'; text: string }>;
  /** Cabinet v3 (2026-11-22): documents, threads, uploads and the playground under `/admin/clients/:id/`. Without it those routes answer 404. */
  cabinet?: CabinetApi;
}

const clientPost = z.object({
  email: z.string().trim().toLowerCase().max(254).email(),
  name: z.string().trim().max(120).default(''),
  telegram: z.string().trim().max(120).default(''),
  locale: z.enum(['ru', 'en']).default('ru'),
  supabaseId: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
  marketingConsent: z.boolean().default(false),
});
const ticketCreate = z.object({ text: z.string().trim().min(1).max(1000) });
/** `POST /admin/clients/:id`: only the fields that are sent change (a field sent empty clears it). */
const profilePatch = z.object({
  name: z.string().trim().max(120).optional(),
  telegram: z.string().trim().max(120).optional(),
  phone: z.string().trim().max(40).optional(),
  company: z.string().trim().max(120).optional(),
  locale: z.enum(['ru', 'en']).optional(),
});
const leadMessage = z.object({ text: z.string().trim().min(1).max(MESSAGE_CAP) });
const CAB_LEADS_CAP = 20;
const STAGE_SET = new Set<string>(['new', 'qualified', 'proposal', 'contract', 'paid', 'project', 'lost']);
const emailParam = z.string().trim().toLowerCase().max(254).email();
const CAB_LIST_CAP = 50;
const CAB_TICKETS_PER_HOUR = 10;
const CAB_DOC_KINDS = ['contract', 'kp', 'estimate', 'act', 'offer'];
/** A Telegram handle as compared everywhere: no `@`, no spaces, lower case. */
const handleKey = (s: string) => s.trim().replace(/^@/, '').replace(/^https?:\/\/t\.me\//i, '').trim().toLowerCase();

export function createCrm(db: Db, now: () => number = Date.now, hooks: CrmHooks = {}) {
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
    estimate?: string | null; stage_override?: string | null; client_id?: number | null; slots?: string; enrichment?: string | null;
  }
  const leadStatus = (taskId: number) => one<{ status: string }>('SELECT status FROM tasks WHERE id = ?', taskId)?.status ?? null;
  const leadView = (l: LeadRow, stages: StageContext) => {
    const stage = stages.stageOf(l);
    return {
      id: l.id, kind: 'lead', taskId: l.task_id, status: leadStatus(l.task_id), name: l.name, contact: l.contact, service: l.service, niche: l.niche,
      task: cap(l.task), message: (l.task ?? '').slice(0, BREAKDOWN_CAP), estimate: (l.estimate ?? '').slice(0, BREAKDOWN_CAP), builderUrl: builderUrlOf(parseEnrichment(l.enrichment ?? null), l.task, l.estimate), deadline: l.deadline, budget: l.budget, source: l.origin, temperature: l.temperature, lang: l.lang,
      priceAsked: l.price_asked === 1, priceApproved: l.price_approved === 1, createdAt: iso(l.created_at), callAt: iso(l.chosen_slot),
      cabinet: l.client_id != null, enrichment: parseEnrichment(l.enrichment ?? null), stage, nextAction: nextActionOf(stage), note: note('lead', l.id), lostReason: stage === 'lost' ? note('lead_lost', l.id) : '',
    };
  };
  function leads(query: URLSearchParams): CrmReply {
    if (!has('li_leads')) return unavailable();
    ensureStageColumn(db);
    const p = page(query);
    const r = idPage<LeadRow>('li_leads', p, ['name', 'contact', 'service', 'niche', 'origin']);
    const stages = StageContext.load(db);
    return ok({ available: true, items: r.items.map((l) => leadView(l, stages)), nextCursor: r.nextCursor });
  }

  // ---- clients: one row per distinct client name across leads, support, projects, invoices and documents ----
  interface Client {
    key: string; name: string; contact: string; sources: Set<string>; firstTouch: number; lastTouch: number; cabId?: number;
    counts: { leads: number; tickets: number; projects: number; invoices: number; documents: number };
  }
  function clients(query: URLSearchParams): CrmReply {
    const p = page(query);
    const map = new Map<string, Client>();
    const touch = (name: string, contact: string, source: string, at: number, count: keyof Client['counts'] | null, cabId?: number) => {
      const n = name.trim();
      if (!n) return;
      const key = n.toLowerCase();
      const c = map.get(key) ?? { key, name: n, contact: '', sources: new Set<string>(), firstTouch: at, lastTouch: at, counts: { leads: 0, tickets: 0, projects: 0, invoices: 0, documents: 0 } };
      if (!c.contact && contact) c.contact = contact;
      if (cabId !== undefined && c.cabId === undefined) c.cabId = cabId;
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
    if (has('cab_clients')) for (const c of all<{ id: number; email: string; name: string; created_at: number; last_seen_at: number | null }>('SELECT id, email, name, created_at, last_seen_at FROM cab_clients')) {
      touch(c.name || c.email, c.email, 'cabinet', c.created_at, null, c.id);
      touch(c.name || c.email, c.email, 'cabinet', c.last_seen_at ?? c.created_at, null, c.id);
    }
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
      items: slice.map((c) => ({ id: c.cabId !== undefined ? String(c.cabId) : `c:${c.key}`, name: c.name, contact: c.contact, sources: [...c.sources].sort(), firstTouchAt: iso(c.firstTouch), lastTouchAt: iso(c.lastTouch), counts: c.counts })),
      nextCursor: start + p.limit < list.length ? start + p.limit : null,
    });
  }

  // ---- tickets ----
  interface TicketRow { id: number; client_id: number | null; client_name: string; contact: string; text: string; status: string; money: number; alerted: number; created_at: number; answered_at: number | null; source?: string | null; answer?: string | null }
  /**
   * The id a ticket's client has in `/admin/clients`: the cabinet id when the contact is a cabinet client's email or handle (or the name is
   * the one a cabinet client carries there), else `c:<lowercased name>`.
   */
  function clientResolver() {
    const byEmail = new Map<string, number>();
    const byHandle = new Map<string, number>();
    const byName = new Map<string, number>();
    if (has('cab_clients')) {
      for (const c of all<{ id: number; email: string; name: string; telegram: string }>('SELECT id, email, name, telegram FROM cab_clients ORDER BY id')) {
        byEmail.set(c.email.trim().toLowerCase(), c.id);
        if (handleKey(c.telegram)) byHandle.set(handleKey(c.telegram), c.id);
        // like the clients list: the first cabinet client carrying a name owns it
        const key = (c.name || c.email).trim().toLowerCase();
        if (!byName.has(key)) byName.set(key, c.id);
      }
    }
    return (name: string, contact: string): string => {
      const id = byEmail.get(contact.trim().toLowerCase()) ?? (handleKey(contact) ? byHandle.get(handleKey(contact)) : undefined) ?? byName.get(name.trim().toLowerCase());
      return id !== undefined ? String(id) : `c:${name.trim().toLowerCase()}`;
    };
  }
  const ticketView = (t: TicketRow, resolve: (name: string, contact: string) => string = clientResolver()) => ({
    id: t.id, clientId: resolve(t.client_name, t.contact), clientName: t.client_name, contact: t.contact, text: cap(t.text), status: t.status, money: t.money === 1, slaAlerted: t.alerted === 1,
    answer: t.answer ? cap(t.answer) : null, note: note('ticket', t.id), createdAt: iso(t.created_at), answeredAt: iso(t.answered_at),
  });
  function tickets(method: string, id: number | null, query: URLSearchParams, body: unknown): CrmReply {
    const statuses = [...TICKET_STATUSES];
    if (!has('cs_tickets')) return method === 'GET' && id === null ? unavailable({ statuses }) : fail(404, 'not_found');
    if (method === 'GET' && id === null) {
      const p = page(query);
      const status = query.get('status');
      if (status && !statuses.includes(status as 'open')) return fail(400, 'invalid_status', { allowed: statuses });
      const resolve = clientResolver();
      const r = idPage<TicketRow>('cs_tickets', p, ['client_name', 'contact', 'text'], status ? [{ sql: 'status = ?', params: [status] }] : []);
      return ok({ available: true, statuses, items: r.items.map((x) => ticketView(x, resolve)), nextCursor: r.nextCursor });
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
    amountUsd: number | null; number: string | null; createdAt: number; link: null; leadId?: number; stageNo?: number | null;
  }
  const docView = (doc: Doc) => {
    const d: Partial<Doc> = { ...doc };
    delete d.leadId;
    return { ...d, createdAt: iso(doc.createdAt) };
  };
  function allDocs(): Doc[] {
    const docs: Doc[] = [];
    if (has('bo_documents')) {
      for (const d of all<{ id: number; type: string; client: string; version: number; text: string; status: string; created_at: number }>('SELECT * FROM bo_documents'))
        docs.push({ id: `bo:${d.id}`, source: 'back_office', kind: d.type, status: d.status, client: d.client, title: `${d.type} v${d.version}`, excerpt: cap(d.text), amountUsd: null, number: null, createdAt: d.created_at, link: null });
    }
    if (has('ps_documents')) {
      for (const d of all<{ id: number; lead_id: number | null; kind: string; title: string; body: string; status: string; created_at: number }>('SELECT * FROM ps_documents')) {
        const lead = d.lead_id !== null && has('li_leads') ? one<{ name: string }>('SELECT name FROM li_leads WHERE id = ?', d.lead_id)?.name ?? '' : '';
        docs.push({ id: `ps:${d.id}`, source: 'presales', kind: d.kind, status: d.status, client: lead, title: d.title, excerpt: cap(d.body), amountUsd: null, number: null, createdAt: d.created_at, link: null, ...(d.lead_id !== null ? { leadId: d.lead_id } : {}) } as Doc);
      }
    }
    if (has('bl_invoices')) {
      for (const d of all<{ id: number; number: string; client: string; amount_usd: number; what: string; status: string; created_at: number; stage_no?: number | null }>('SELECT * FROM bl_invoices'))
        docs.push({ id: `bl:${d.id}`, source: 'billing', kind: 'invoice', status: d.status, client: d.client, title: d.what || d.number, excerpt: cap(d.what), amountUsd: d.amount_usd, number: d.number, createdAt: d.created_at, link: null, stageNo: d.stage_no ?? null });
    }
    return docs;
  }
  function documents(query: URLSearchParams): CrmReply {
    const p = page(query);
    const docs = allDocs();
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
      items: list.slice(start, start + p.limit).map(docView),
      nextCursor: start + p.limit < list.length ? start + p.limit : null,
    });
  }

  // ---- payment by stages: the milestones of a project are its stages ----
  interface MsRow { id: number; project_id: number; kind: string; title: string; due_at: number; status: string; done_at: number | null; stage_no: number | null; amount_usd: number | null; invoice_number: string | null; paid_at: number | null; accepted_at: number | null; title_en: string | null }
  const hasCol = (t: string, col: string) => has(t) && all<{ name: string }>(`PRAGMA table_info(${t})`).some((x) => x.name === col);
  /** The stage fields of a milestone row (null for a milestone of the older plan); `payUrl` only while the invoice is issued and unpaid. */
  function stageFields(m: MsRow, lang: string | null | undefined = 'ru') {
    if (m.stage_no === null || m.stage_no === undefined) return { stageNo: null, title: null, amountUsd: null, invoiceNumber: null, payUrl: null, paidAt: null, acceptedAt: null, state: null };
    const inv = m.invoice_number && has('bl_invoices') ? one<{ status: string; pay_key: string | null; locale: string | null }>('SELECT status, pay_key, locale FROM bl_invoices WHERE number = ?', m.invoice_number) : undefined;
    const payUrl = inv?.status === 'issued' && hooks.payUrl ? hooks.payUrl({ number: m.invoice_number!, payKey: inv.pay_key, locale: inv.locale === 'en' ? 'en' : 'ru' }) : null;
    return {
      stageNo: m.stage_no, amountUsd: m.amount_usd, invoiceNumber: m.invoice_number, payUrl, paidAt: iso(m.paid_at), acceptedAt: iso(m.accepted_at),
      state: stageState({ paidAt: m.paid_at, acceptedAt: m.accepted_at, status: m.status }),
      title: lang === 'en' && m.title_en ? m.title_en : stageTitleRu(m.title),
    };
  }
  /** The stages of a project in order, as the cabinet and the Пульт show them. */
  function stageViews(projectId: number, lang: string | null | undefined = 'ru') {
    if (!hasCol('pm_milestones', 'stage_no')) return [];
    return all<MsRow>('SELECT * FROM pm_milestones WHERE project_id = ? AND stage_no IS NOT NULL ORDER BY stage_no', projectId).map((m) => ({ id: m.id, ...stageFields(m, lang), dueAt: iso(m.due_at) }));
  }

  // ---- projects ----
  interface ProjRow { id: number; client: string; what: string; product: string; status: string; source: string; task_id: number | null; created_at: number; lead_id?: number | null }
  function projects(query: URLSearchParams): CrmReply {
    if (!has('pm_projects')) return unavailable();
    const p = page(query);
    const status = query.get('status');
    const r = idPage<ProjRow>('pm_projects', p, ['client', 'what', 'product'], status ? [{ sql: 'status = ?', params: [status] }] : []);
    return ok({ available: true, items: r.items.map((x) => projectView(x)), nextCursor: r.nextCursor });
  }
  function projectView(pr: ProjRow, lang: string | null | undefined = 'ru') {
        const msTable = has('pm_milestones');
        const ms = msTable ? all<{ kind: string; title: string; due_at: number; status: string }>('SELECT kind, title, due_at, status FROM pm_milestones WHERE project_id = ? ORDER BY due_at, id', pr.id) : [];
        const open = ms.filter((m) => m.status !== 'done');
        const next = open[0];
        const last = ms.at(-1);
        // Cabinet v3: what the client sees of the project (the state, his documents, the one thing he does next)
        const stagesNow = stageViews(pr.id, lang);
        const docs = docsOf(db, { projectId: pr.id, leadId: pr.lead_id ?? null });
        return {
          id: pr.id, client: pr.client, what: cap(pr.what), product: pr.product, status: pr.status, source: pr.source, taskId: pr.task_id,
          state: projectStateOf(pr.status, stagesNow), documents: docs.map((d) => d.id), nextAction: clientNextAction(docs, stagesNow),
          stage: pr.status === 'draft' ? 'spec' : pr.status === 'done' ? 'done' : next?.kind ?? 'done',
          deadline: iso(next?.due_at ?? last?.due_at), nextMilestone: next ? { kind: next.kind, title: next.title, dueAt: iso(next.due_at) } : null,
          tasksTotal: ms.length, tasksDone: ms.length - open.length, createdAt: iso(pr.created_at),
          milestones: stagesNow,
        };
  }

  // ---- referrals ----
  interface RefRow { id: number; referrer: string; referred: string; lead_id: number | null; source: string; status: string; reward: string; reward_requested: number; created_at: number; paid_at: number | null; rewarded_at: number | null }
  function referrals(query: URLSearchParams): CrmReply {
    if (!has('rf_referrals')) return unavailable();
    const p = page(query);
    const status = query.get('status');
    const r = idPage<RefRow>('rf_referrals', p, ['referrer', 'referred'], status ? [{ sql: 'status = ?', params: [status] }] : []);
    return ok({ available: true, statuses: ['proposed', 'paid', 'rewarded'], items: r.items.map(refView), nextCursor: r.nextCursor });
  }
  const refView = (x: RefRow) => ({
    id: x.id, referrer: x.referrer, referred: x.referred, leadId: x.lead_id, source: x.source, status: x.status, reward: x.reward,
    rewardRequested: x.reward_requested === 1, createdAt: iso(x.created_at), paidAt: iso(x.paid_at), rewardedAt: iso(x.rewarded_at),
  });

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

  // ---- client cabinet (`/admin/clients/*`): accounts made on the site, scoped views of their own rows ----
  ensureCabinetTables(db);
  ensureDocTables(db);
  const ensureLeadClientId = () => {
    if (has('li_leads') && !all<{ name: string }>('PRAGMA table_info(li_leads)').some((c) => c.name === 'client_id')) db.exec('ALTER TABLE li_leads ADD COLUMN client_id INTEGER');
  };
  ensureLeadClientId();
  ensureStageColumn(db);
  interface CabRow { id: number; email: string; name: string; telegram: string; phone?: string; company?: string; locale: string; supabase_id: string; ref_slug: string | null; created_at: number }
  const cabById = (id: number) => one<CabRow>('SELECT * FROM cab_clients WHERE id = ?', id);

  /** Links the leads whose contact is the client's email or Telegram handle (case-insensitive, `@` optional); returns all leads linked to the client. */
  function linkLeads(c: CabRow): number {
    if (!has('li_leads')) return 0;
    ensureLeadClientId();
    const handle = handleKey(c.telegram);
    const mine = (contact: string) => {
      const k = contact.trim().toLowerCase();
      return k === c.email || (handle !== '' && handleKey(contact) === handle);
    };
    for (const l of all<{ id: number; contact: string; client_id: number | null }>('SELECT id, contact, client_id FROM li_leads WHERE client_id IS NULL')) {
      if (mine(l.contact)) db.prepare('UPDATE li_leads SET client_id = ? WHERE id = ?').run(c.id, l.id);
    }
    return one<{ n: number }>('SELECT COUNT(*) n FROM li_leads WHERE client_id = ?', c.id)?.n ?? 0;
  }

  /** Papers the owner sent by hand to a lead before he had an account (the Telegram bot, the old chain) join the account when it is linked. */
  function attachLegacyDocs(clientId: number): void {
    try {
      hooks.cabinet?.docs.attachLegacy(clientId);
    } catch (e) {
      log('warn', 'legacy documents not attached', { err: errMsg(e) });
    }
  }

  function clientCreate(body: unknown): CrmReply {
    const parsed = clientPost.safeParse(body ?? {});
    if (!parsed.success) return fail(400, 'invalid');
    const d = parsed.data;
    const t = now();
    const existed = one<{ id: number }>('SELECT id FROM cab_clients WHERE email = ?', d.email);
    db.prepare(
      `INSERT INTO cab_clients (email, name, telegram, locale, supabase_id, marketing_consent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET name = excluded.name, telegram = excluded.telegram, locale = excluded.locale, supabase_id = excluded.supabase_id,
         marketing_consent = excluded.marketing_consent, updated_at = excluded.updated_at`,
    ).run(d.email, d.name, d.telegram, d.locale, d.supabaseId, d.marketingConsent ? 1 : 0, t, t);
    const c = one<CabRow>('SELECT * FROM cab_clients WHERE email = ?', d.email)!;
    const linked = linkLeads(c);
    attachLegacyDocs(c.id);
    if (!existed) hooks.notifyOwner?.(`Новый аккаунт в кабинете: ${c.name || c.email}, лидов привязано ${linked}`);
    return ok({ client: { id: c.id, email: c.email, name: c.name, telegram: c.telegram, locale: c.locale, createdAt: iso(c.created_at) }, linkedLeads: linked });
  }

  const newest = <T extends { createdAt: string | null }>(list: T[]) => list.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')).slice(0, CAB_LIST_CAP);

  function clientByEmail(query: URLSearchParams): CrmReply {
    const em = emailParam.safeParse(query.get('email') ?? '');
    if (!em.success) return fail(400, 'invalid');
    const c = one<CabRow>('SELECT * FROM cab_clients WHERE email = ?', em.data);
    if (!c) return fail(404, 'not_found');
    const t = now();
    db.prepare('UPDATE cab_clients SET last_seen_at = ? WHERE id = ?').run(t, c.id);
    linkLeads(c);
    attachLegacyDocs(c.id);
    const handle = handleKey(c.telegram);
    const lead = has('li_leads') ? all<{ id: number; name: string }>('SELECT id, name FROM li_leads WHERE client_id = ?', c.id) : [];
    const leadIds = new Set(lead.map((l) => l.id));
    // Names come only from rows already tied to this account (its leads, support records with its email or handle):
    // the name typed at registration is never used to pull in rows, anybody could type any name
    const names = new Set(lead.map((l) => l.name.trim().toLowerCase()).filter(Boolean));
    const contactIs = (contact: string) => contact.trim().toLowerCase() === c.email || (handle !== '' && handleKey(contact) === handle);
    if (has('cs_clients')) for (const x of all<{ name: string; contact: string }>('SELECT name, contact FROM cs_clients')) if (contactIs(x.contact)) names.add(x.name.trim().toLowerCase());
    const mineName = (n: string) => names.has(n.trim().toLowerCase());

    const projectsOut = has('pm_projects')
      ? newest(all<ProjRow & { lead_id?: number | null }>('SELECT * FROM pm_projects ORDER BY id DESC').filter((p) => mineName(p.client) || (p.lead_id != null && leadIds.has(p.lead_id))).map((p) => projectView(p, c.locale)))
      : [];
    // the papers of a lead whose documents go through the cabinet (`GET /admin/clients/:id/documents`) are not repeated here, least of all the contract draft of the КП pack
    const flowLeadIds = new Set(all<{ lead_id: number }>('SELECT DISTINCT lead_id FROM cab_documents WHERE client_id = ? AND lead_id IS NOT NULL', c.id).map((r) => r.lead_id));
    const flowNames = new Set(lead.filter((l) => flowLeadIds.has(l.id)).map((l) => l.name.trim().toLowerCase()));
    const docs = allDocs().filter((d) => {
      const own = d.leadId !== undefined ? leadIds.has(d.leadId) : mineName(d.client);
      if (!own) return false;
      if (d.leadId !== undefined && flowLeadIds.has(d.leadId) && d.source !== 'billing') return false;
      if (d.source === 'back_office' && flowNames.has(d.client.trim().toLowerCase())) return false;
      // the client sees what the owner approved or issued: never drafts, rejected or voided papers
      if (d.source === 'billing') return d.status === 'issued' || d.status === 'paid';
      return CAB_DOC_KINDS.includes(d.kind) && d.status === 'approved';
    });
    const invoices = newest(docs.filter((d) => d.source === 'billing').map(docView));
    const documentsOut = newest(docs.filter((d) => d.source !== 'billing').map(docView));
    const ownResolve = clientResolver();
    const ticketsOut = has('cs_tickets')
      ? newest(all<TicketRow>('SELECT * FROM cs_tickets ORDER BY id DESC').filter((x) => contactIs(x.contact) || (x.source === 'cabinet' && x.contact.toLowerCase() === c.email) || (mineName(x.client_name) && x.contact === '')).map((x) => {
          const view: Omit<ReturnType<typeof ticketView>, 'note'> & { note?: string } = ticketView(x, ownResolve);
          delete view.note;
          return view;
        }))
      : [];
    const slug = c.ref_slug ?? issueSlug(c.id);
    const referralsOut = has('rf_referrals')
      ? newest(all<RefRow>('SELECT * FROM rf_referrals ORDER BY id DESC').filter((r) => { const k = r.referrer.trim().toLowerCase(); return k === slug || mineName(r.referrer); }).map(refView))
      : [];
    return ok({
      client: { id: c.id, name: c.name, email: c.email, telegram: c.telegram, phone: c.phone ?? '', company: c.company ?? '', locale: c.locale, createdAt: iso(c.created_at) },
      projects: projectsOut, invoices, documents: documentsOut, tickets: ticketsOut, referrals: referralsOut, referralSlug: slug,
      leads: cabinetLeads(c.id),
    });
  }

  /**
   * What the client sees of each of their leads: the stage in plain words, a timeline made of what already exists in the other tables
   * (no internal texts, no prompts) and the thread of messages. Newest lead first, at most CAB_LEADS_CAP.
   */
  function cabinetLeads(clientId: number) {
    if (!has('li_leads')) return [];
    const rows = all<LeadRow & { has_domain?: number | null; has_hosting?: number | null }>('SELECT * FROM li_leads WHERE client_id = ? ORDER BY id DESC LIMIT ?', clientId, CAB_LEADS_CAP);
    if (!rows.length) return [];
    const stages = StageContext.load(db);
    const moves = has('activity') ? all<{ object_id: string; detail: string; at: number }>("SELECT object_id, detail, at FROM activity WHERE action = 'lead_stage' AND object_type = 'lead' ORDER BY id") : [];
    return rows.map((l) => {
      const stage = stages.stageOf(l);
      const lang = l.lang;
      const events: { at: number; kind: string; title: string }[] = [{ at: l.created_at, kind: 'lead', title: timelineTitle('lead', lang) }];
      const replies = all<{ from: string; text: string; at: number }>('SELECT "from", text, at FROM cab_messages WHERE lead_id = ? AND client_id = ? ORDER BY at, id', l.id, clientId);
      const firstManager = replies.find((r) => r.from === 'manager');
      if (firstManager) events.push({ at: firstManager.at, kind: 'reply', title: timelineTitle('reply', lang) });
      // Cabinet v3: when the quote went to the client's cabinet, the timeline follows HIS papers (sent, accepted, contract sent, signed); the contract draft inside the
      // КП pack and the contract drafted for the owner are not events of his
      const flowDocs = docsOf(db, { leadId: l.id });
      const flowOn = flowDocs.some((d) => d.kind === 'quote');
      for (const d of flowDocs) {
        if (d.kind === 'quote') {
          events.push({ at: d.delivered_at ?? d.created_at, kind: 'kp', title: timelineTitle('kp', lang) });
          if (d.accepted_at !== null) events.push({ at: d.accepted_at, kind: 'kp_accepted', title: timelineTitle('kp_accepted', lang) });
        } else if (d.kind === 'contract') {
          events.push({ at: d.delivered_at ?? d.created_at, kind: 'contract', title: timelineTitle('contract', lang) });
          if (d.signed_at !== null) events.push({ at: d.signed_at, kind: 'contract_signed', title: timelineTitle('contract_signed', lang) });
        }
      }
      if (has('ps_documents') && !flowOn) {
        for (const d of all<{ kind: string; created_at: number; decided_at: number | null }>("SELECT kind, created_at, decided_at FROM ps_documents WHERE lead_id = ? AND status = 'approved' AND kind IN ('kp', 'contract') ORDER BY id", l.id)) {
          events.push({ at: d.decided_at ?? d.created_at, kind: d.kind, title: timelineTitle(d.kind === 'kp' ? 'kp' : 'contract', lang) });
        }
      }
      if (has('bo_documents') && !flowOn && !events.some((e) => e.kind === 'contract')) {
        // compared in JS: SQLite lower() does not fold Cyrillic
        const d = all<{ client: string; created_at: number }>("SELECT client, created_at FROM bo_documents WHERE type = 'contract' AND status != 'rejected' ORDER BY id").find((x) => x.client.trim().toLowerCase() === l.name.trim().toLowerCase());
        if (d) events.push({ at: d.created_at, kind: 'contract', title: timelineTitle('contract', lang) });
      }
      let invoiceTotal: number | null = null;
      if (hasCol('bl_invoices', 'lead_id')) {
        for (const i of all<{ status: string; created_at: number; paid_at: number | null; total_usd?: number | null; stage_no?: number | null }>("SELECT * FROM bl_invoices WHERE lead_id = ? AND status IN ('issued', 'paid') ORDER BY id", l.id)) {
          const sfx = i.stage_no ? `: ${lang === 'en' ? 'stage' : 'этап'} ${i.stage_no}` : '';
          events.push({ at: i.created_at, kind: 'invoice', title: `${timelineTitle('invoice', lang)}${sfx}` });
          if (i.status === 'paid') events.push({ at: i.paid_at ?? i.created_at, kind: 'paid', title: `${timelineTitle('paid', lang)}${sfx}` });
          if (invoiceTotal === null && i.total_usd) invoiceTotal = i.total_usd;
        }
      }
      if (hasCol('pm_projects', 'lead_id')) {
        const p = one<{ created_at: number }>("SELECT created_at FROM pm_projects WHERE lead_id = ? AND status != 'draft' ORDER BY id LIMIT 1", l.id);
        if (p) events.push({ at: p.created_at, kind: 'project', title: timelineTitle('project', lang) });
      }
      // the stages of the lead's project: the client's acceptance and the stage steps the track shows
      let stagesOfLead: ReturnType<typeof stageViews> = [];
      if (hasCol('pm_projects', 'lead_id') && hasCol('pm_milestones', 'stage_no')) {
        const proj = one<{ id: number }>('SELECT id FROM pm_projects WHERE lead_id = ? ORDER BY id DESC LIMIT 1', l.id);
        if (proj) {
          stagesOfLead = stageViews(proj.id, lang);
          for (const m of all<MsRow>('SELECT * FROM pm_milestones WHERE project_id = ? AND stage_no IS NOT NULL AND accepted_at IS NOT NULL ORDER BY stage_no', proj.id)) {
            events.push({ at: m.accepted_at!, kind: 'stage_accepted', title: `${lang === 'en' ? 'Stage' : 'Этап'} ${m.stage_no} ${lang === 'en' ? 'accepted' : 'принят'}` });
          }
        }
      }
      for (const m of moves) if (m.object_id === String(l.id) && STAGE_SET.has(m.detail)) events.push({ at: m.at, kind: 'stage', title: stageMoveTitle(m.detail as Stage, lang) });
      events.sort((a, b) => a.at - b.at);
      const nextAction = clientNextAction(flowDocs, stagesOfLead);
      return {
        id: l.id, createdAt: iso(l.created_at), service: l.service,
        summary: (l.task || (l.estimate ?? '').split('\n')[0] || '').trim().slice(0, 200),
        estimateUsd: invoiceTotal ?? builderTotal(l.estimate ?? ''),
        hasDomain: l.has_domain == null ? null : l.has_domain === 1, hasHosting: l.has_hosting == null ? null : l.has_hosting === 1,
        stage, nextAction, nextStep: docNextStep(flowDocs, nextAction, lang) ?? stageNextStep(stagesOfLead, lang) ?? nextStepOf(stage, lang),
        timeline: events.map((e) => ({ at: iso(e.at), kind: e.kind, title: e.title })),
        replies: replies.map((r) => ({ at: iso(r.at), text: r.text, from: r.from })),
      };
    });
  }

  /** The client's referral slug (`?start=ref_<slug>` in the bot, `ref:<slug>` on the form): lower-case letters and digits, unique, issued once. */
  function issueSlug(id: number): string {
    for (let i = 0; i < 5; i++) {
      const slug = `c${id.toString(36)}${randomBytes(3).toString('hex')}`;
      if (db.prepare('UPDATE cab_clients SET ref_slug = ? WHERE id = ? AND ref_slug IS NULL').run(slug, id).changes === 1) return slug;
      const have = one<{ ref_slug: string | null }>('SELECT ref_slug FROM cab_clients WHERE id = ?', id)?.ref_slug;
      if (have) return have;
    }
    return `c${id.toString(36)}`;
  }

  function clientTicketCreate(id: number, body: unknown): CrmReply {
    const c = cabById(id);
    if (!c) return fail(404, 'not_found');
    const parsed = ticketCreate.safeParse(body ?? {});
    if (!parsed.success) return fail(400, 'invalid');
    const store = new CsStore(db, now);
    const recent = one<{ n: number }>("SELECT COUNT(*) n FROM cs_tickets WHERE source = 'cabinet' AND lower(contact) = ? AND created_at > ?", c.email, now() - 3_600_000)?.n ?? 0;
    if (recent >= CAB_TICKETS_PER_HOUR) return fail(429, 'rate_limited');
    const tk = store.addCabinetTicket({ clientName: c.name || c.email, contact: c.email, text: parsed.data.text });
    hooks.cabinetTicket?.({ id: tk.id, name: tk.clientName, text: tk.text, telegram: c.telegram });
    return ok({ item: { id: tk.id, text: tk.text, status: tk.status, createdAt: iso(tk.createdAt), answeredAt: iso(tk.answeredAt), answer: tk.answer } });
  }

  /** `POST /admin/clients/:id/leads/:leadId/messages`: the client writes about their own lead; it becomes a Support ticket (draft through approvals). */
  function leadMessageCreate(id: number, leadId: number, body: unknown): CrmReply {
    const c = cabById(id);
    if (!c) return fail(404, 'not_found');
    const lead = has('li_leads') ? one<{ id: number; task_id: number; client_id: number | null }>('SELECT id, task_id, client_id FROM li_leads WHERE id = ?', leadId) : undefined;
    // someone else's lead looks exactly like a missing one
    if (!lead || lead.client_id !== c.id) return fail(404, 'not_found');
    const parsed = leadMessage.safeParse(body ?? {});
    if (!parsed.success) return fail(400, 'invalid');
    const since = now() - 3_600_000;
    const cs = new CsStore(db, now); // makes the support tables when nobody has used them yet (the counts below read cs_tickets)
    const sentMessages = one<{ n: number }>('SELECT COUNT(*) n FROM cab_messages WHERE client_id = ? AND "from" = \'client\' AND at > ?', c.id, since)?.n ?? 0;
    const sentTickets = one<{ n: number }>("SELECT COUNT(*) n FROM cs_tickets WHERE source = 'cabinet' AND lower(contact) = ? AND created_at > ?", c.email, since)?.n ?? 0;
    if (sentMessages >= CAB_TICKETS_PER_HOUR || sentTickets >= CAB_TICKETS_PER_HOUR) return fail(429, 'rate_limited');
    const text = parsed.data.text;
    const tk = cs.addCabinetTicket({ clientName: c.name || c.email, contact: c.email, text, leadId });
    addCabMessage(db, now(), { clientId: c.id, leadId, from: 'client', text, ticketId: tk.id });
    hooks.leadJournal?.(lead.task_id, `Сообщение клиента из кабинета по лиду #${leadId}: ${text.slice(0, 300)}`);
    hooks.notifyOwner?.(`Сообщение по заявке #${leadId} от ${c.name || c.email}`);
    hooks.cabinetTicket?.({ id: tk.id, name: tk.clientName, text: tk.text, telegram: c.telegram, leadId });
    return ok({ item: { at: iso(now()), text, from: 'client', leadId, ticketId: tk.id } });
  }

  /**
   * `POST /admin/clients/:id/projects/:pid/milestones/:no/accept`: the client accepts a finished stage of THEIR project (found through the lead
   * that belongs to the account; anyone else's project looks like a missing one). Idempotent. Accepting proposes the invoice of the next stage.
   */
  async function stageAccept(id: number, projectId: number, stageNo: number): Promise<CrmReply> {
    const c = cabById(id);
    if (!c) return fail(404, 'not_found');
    const proj = has('pm_projects') && hasCol('pm_projects', 'lead_id') ? one<{ id: number; lead_id: number | null; client: string }>('SELECT id, lead_id, client FROM pm_projects WHERE id = ?', projectId) : undefined;
    const lead = proj?.lead_id != null && has('li_leads') ? one<{ id: number; task_id: number; client_id: number | null }>('SELECT id, task_id, client_id FROM li_leads WHERE id = ?', proj.lead_id) : undefined;
    if (!proj || !lead || lead.client_id !== c.id || !hasCol('pm_milestones', 'stage_no')) return fail(404, 'not_found');
    if (!one<{ id: number }>('SELECT id FROM pm_milestones WHERE project_id = ? AND stage_no = ?', projectId, stageNo)) return fail(404, 'not_found');
    if (!hooks.acceptStage) return fail(503, 'unavailable');
    const r = await hooks.acceptStage(projectId, stageNo);
    if (r.status === 'unknown') return fail(404, 'not_found');
    if (r.status === 'not_paid' || r.status === 'not_ready') return fail(409, r.status);
    if (r.status === 'accepted') {
      hooks.leadJournal?.(lead.task_id, `Клиент принял этап ${stageNo} проекта #${projectId} в кабинете`);
      hooks.notifyOwner?.(`${c.name || c.email} принял этап ${stageNo} проекта #${projectId}`);
    }
    const m = stageViews(projectId, c.locale).find((x) => x.stageNo === stageNo)!;
    return ok({ already: r.status === 'already', milestone: m });
  }

  /**
   * `POST /admin/clients/:id` (also `PATCH`): the profile form of the cabinet. Only the fields sent change; the answer is the whole profile. A new Telegram handle
   * links the leads that were written with it, like the registration does.
   */
  function profilePatchRoute(id: number, body: unknown): CrmReply {
    const c = cabById(id);
    if (!c) return fail(404, 'not_found');
    const parsed = profilePatch.safeParse(body ?? {});
    if (!parsed.success) return fail(400, 'invalid');
    const p = parsed.data;
    const sets: string[] = [];
    const vals: (string | number)[] = [];
    for (const k of ['name', 'telegram', 'phone', 'company', 'locale'] as const) {
      if (p[k] !== undefined) {
        sets.push(`${k} = ?`);
        vals.push(p[k]!);
      }
    }
    if (sets.length) db.prepare(`UPDATE cab_clients SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...vals, now(), id);
    const fresh = cabById(id)!;
    if (p.telegram !== undefined) linkLeads(fresh);
    return ok({ client: { id: fresh.id, email: fresh.email, name: fresh.name, telegram: fresh.telegram, phone: fresh.phone ?? '', company: fresh.company ?? '', locale: fresh.locale } });
  }

  function clientsRoute(method: string, seg: string[], query: URLSearchParams, body: unknown): CrmReply | Promise<CrmReply> {
    if (method === 'POST' && seg.length === 0) return clientCreate(body);
    if (method === 'GET' && seg.length === 1 && seg[0] === 'by-email') return clientByEmail(query);
    if (method === 'POST' && seg.length === 4 && seg[1] === 'leads' && seg[3] === 'messages' && /^\d+$/.test(seg[0]!) && /^\d+$/.test(seg[2]!)) return leadMessageCreate(Number(seg[0]), Number(seg[2]), body);
    if (method === 'POST' && seg.length === 6 && seg[1] === 'projects' && seg[3] === 'milestones' && seg[5] === 'accept' && [seg[0], seg[2], seg[4]].every((x) => /^\d+$/.test(x!))) return stageAccept(Number(seg[0]), Number(seg[2]), Number(seg[4]));
    if (method === 'POST' && seg.length === 2 && seg[1] === 'tickets' && /^\d+$/.test(seg[0]!)) return clientTicketCreate(Number(seg[0]), body);
    if ((method === 'POST' || method === 'PATCH') && seg.length === 1 && /^\d+$/.test(seg[0]!)) return profilePatchRoute(Number(seg[0]), body);
    const v3 = hooks.cabinet?.route(method, seg, query, body);
    if (v3) return v3;
    return fail(404, 'not_found');
  }

  const whereRows = <R>(table: string, where: string, params: unknown[], order = 'id DESC', limit = 200) =>
    (has(table) ? all<R>(`SELECT * FROM ${table}${where ? ` WHERE ${where}` : ''} ORDER BY ${order} LIMIT ?`, ...params, limit) : []);
  /** Row views for the «Пульт v3» routes (`pult.ts`): the same shapes as the panels above, so the two never drift apart. */
  const views = {
    has, all, one, note, setNote,
    stages: (): StageContext => StageContext.load(db),
    lead: (id: number, stages: StageContext = StageContext.load(db)) => {
      const r = has('li_leads') ? one<LeadRow>('SELECT * FROM li_leads WHERE id = ?', id) : undefined;
      return r ? leadView(r, stages) : undefined;
    },
    leadsWhere: (where: string, params: unknown[] = []) => {
      const stages = StageContext.load(db);
      return whereRows<LeadRow>('li_leads', where, params).map((r) => leadView(r, stages));
    },
    project: (id: number) => {
      const r = has('pm_projects') ? one<ProjRow>('SELECT * FROM pm_projects WHERE id = ?', id) : undefined;
      return r ? projectView(r) : undefined;
    },
    projectsWhere: (where: string, params: unknown[] = []) => whereRows<ProjRow>('pm_projects', where, params).map((x) => projectView(x)),
    ticketsWhere: (where: string, params: unknown[] = []) => (() => { const resolve = clientResolver(); return whereRows<TicketRow>('cs_tickets', where, params).map((x) => ticketView(x, resolve)); })(),
    referralsWhere: (where: string, params: unknown[] = []) => whereRows<RefRow>('rf_referrals', where, params).map(refView),
    docs: () => allDocs(),
    docView,
    stageViews,
    stageFields,
    cabById,
    handleKey,
  };

  return {
    views,
    clients: clientsRoute,
    handle(method: string, seg: string[], query: URLSearchParams, body: unknown): CrmReply {
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
