import { fail, okv, type ToolResult } from '@fir/core';
import { TEAM_TOOL_DEFS, priceList, teamSpec, type FiraTool, type ToolRegistry } from '@fir/fira';
import type { Hq } from '@fir/hq';
import { assistantTools } from './assistant-tools.js';
import type { ShellLinks } from './links.js';
import { marketingTools, Turn, type MarketingToolDeps } from './marketing-chat-tools.js';
import { nowPhrase } from './team-presence.js';

/**
 * The tools of an agent in the team chat (`packages/fira/src/team.ts`, the agent's pack in `role-packs/team/<id>.md`). The registry holds ONLY the
 * tools of the agent's pack (Fira's `compile`/`runTool` check the same list again): Sales never sees `money`, Support never sees `propose_quote`.
 * Reads reuse the owner assistant's tools (leads, clients, projects, money...) and the marketing ones; writes are the existing actions of HQ:
 * a task of the department, an assignment to another agent, a Studio order, a ticket answer drafted by Support (Approvals), a КП by Presales
 * (Approvals, locked), a call booking, a note on a card. Every write is audited (`activity`, action `team_<tool>`, detail `chat`).
 */

export type TeamCardKind = 'task' | 'lead' | 'client' | 'project' | 'invoice' | 'document' | 'order' | 'plan' | 'rule' | 'metric' | 'item' | 'campaign';
export interface TeamCard { kind: TeamCardKind; id: string; title: string; href: string; meta?: Record<string, string | number> }
export type TeamActionType =
  | 'task_created' | 'task_assigned' | 'order_created' | 'reply_drafted' | 'quote_proposed' | 'call_scheduled' | 'note_added'
  | 'rule_updated' | 'plan_proposed' | 'plan_accepted' | 'schedule_changed' | 'none';
export interface TeamAction { type: TeamActionType; ref?: string }

/** Where a card leads in the Shell (relative paths of the site's `/admin`). */
export const TEAM_HREF = {
  task: (id: number) => `/admin/tasks?focus=${id}`,
  lead: (id: number) => `/admin/clients?tab=pipeline&focus=${id}`,
  client: (id: number) => `/admin/clients?tab=clients&focus=${id}`,
  project: (id: number) => `/admin/projects?focus=${id}`,
  invoice: (id: number) => `/admin/finance?tab=invoices&focus=${id}`,
  ticket: (id: number) => `/admin/chats?ticket=${id}`,
  prospect: (id: number) => `/admin/clients?tab=prospects&focus=${id}`,
  approvals: () => '/admin/approvals',
} as const;

/** What one turn produced (the marketing tools keep their own `Turn`, merged in `out`). */
export class TeamTurn {
  readonly cards: TeamCard[] = [];
  readonly actions: TeamAction[] = [];
  readonly mk = new Turn();
  card(c: TeamCard): void {
    const i = this.cards.findIndex((x) => x.kind === c.kind && x.id === c.id);
    if (i >= 0) this.cards[i] = c;
    else this.cards.push(c);
  }
  act(a: TeamAction): void {
    if (!this.actions.some((x) => x.type === a.type && x.ref === a.ref)) this.actions.push(a);
  }
  allActions(): TeamAction[] {
    const out = [...this.actions];
    for (const a of this.mk.actions) if (!out.some((x) => x.type === a.type && x.ref === a.ref)) out.push(a);
    return out;
  }
  out(max = 8): TeamCard[] {
    for (const c of this.mk.cards) this.card(c);
    const rank: Partial<Record<TeamCardKind, number>> = { task: 0, order: 1, document: 2, plan: 3, lead: 4, client: 5, project: 6, invoice: 7 };
    return [...this.cards].sort((a, b) => (rank[a.kind] ?? 9) - (rank[b.kind] ?? 9)).slice(0, max);
  }
}

export type AssignResult = { ok: true; task: { id: number; href: string } } | { ok: false; status: number; error: string };

export interface TeamToolDeps {
  hq: Hq;
  links: ShellLinks;
  /** The marketing stores (content feed, orders, calendar, analytics): the marketing workers read them, Content Maker orders. */
  marketing?: MarketingToolDeps | undefined;
  /** The call bookings (`calls.ts`). */
  calls?: { book(leadId: number, at: number, source: 'pult', o?: { tell?: boolean }): Promise<{ booking: { id: number; at: number; state: string } } | null> } | undefined;
  /** An assignment to another agent (the team chat's `assign`). */
  assign: (from: string, to: string, text: string) => AssignResult;
  pendingApprovals?: () => number;
  settingsView?: () => unknown;
}

const str = (v: unknown, n: number): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : typeof v === 'string' && /^\d{1,9}$/.test(v) ? Number(v) : null);
const clip = (s: string, n = 80) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** The names of the agent's tools (its pack's `tools:`); empty for an agent without a team pack. */
export function teamToolNames(agentId: string): string[] {
  try {
    return [...teamSpec(agentId).role.tools];
  } catch {
    return [];
  }
}

/** The registry of one turn of `agentId` (`text`: the owner's message). Only the agent's own tools are in it. */
export function teamTools(agentId: string, d: TeamToolDeps, ctx: { text: string; turn: TeamTurn }): ToolRegistry {
  const { hq } = d;
  const db = hq.db;
  const { turn } = ctx;
  const allowed = new Set(teamToolNames(agentId));
  const agent = hq.agent(agentId);
  const has = (t: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) !== undefined;
  const audit = (tool: string, objectType: string, objectId: string | number) => hq.log(agentId, `team_${tool}`, objectType, String(objectId), 'chat');
  const tool = (name: string, run: FiraTool['run']): [string, FiraTool] => [name, { def: TEAM_TOOL_DEFS[name]!, run }];
  const done = (v: unknown): Promise<ToolResult<unknown>> => Promise.resolve(okv(v));
  const bad = (code: 'invalid' | 'not_found' | 'not_configured' | 'blocked', msg: string): Promise<ToolResult<unknown>> => Promise.resolve(fail(code, msg));

  const own: [string, FiraTool][] = [
    tool('my_queue', () => {
      const open = hq.tasks({ assigneeId: agentId, open: true, limit: 50 }).filter((t) => !t.tags.includes('drill'));
      const asked = new Set((db.prepare("SELECT task_id FROM task_approvals WHERE state IN ('queued', 'asked')").all() as { task_id: number }[]).map((r) => r.task_id));
      const results = db.prepare("SELECT task_id, at FROM task_events WHERE kind = 'result' AND actor = ? ORDER BY id DESC LIMIT 5").all(agentId) as { task_id: number; at: number }[];
      const items = open.slice(0, 15).map((t) => ({ id: t.id, status: t.status, what: nowPhrase(t), title: clip(t.title, 80), waitsOwner: asked.has(t.id), since: new Date(t.updatedAt).toISOString() }));
      for (const t of items.slice(0, 3)) turn.card({ kind: 'task', id: String(t.id), title: t.title, href: TEAM_HREF.task(t.id), meta: { status: t.status } });
      return done({ open: open.length, items, waitingOwner: items.filter((t) => t.waitsOwner).length, recentResults: results.map((r) => ({ taskId: r.task_id, at: new Date(r.at).toISOString() })) });
    }),
    tool('tickets', (input) => {
      if (!has('cs_tickets')) return done({ total: 0, items: [] });
      const id = int(input.id);
      const status = ['open', 'answered', 'closed'].includes(String(input.status)) ? String(input.status) : null;
      const rows = (id
        ? db.prepare('SELECT id, client_name, status, text, created_at FROM cs_tickets WHERE id = ?').all(id)
        : status
          ? db.prepare('SELECT id, client_name, status, text, created_at FROM cs_tickets WHERE status = ? ORDER BY id DESC LIMIT 10').all(status)
          : db.prepare('SELECT id, client_name, status, text, created_at FROM cs_tickets ORDER BY id DESC LIMIT 10').all()) as { id: number; client_name: string; status: string; text: string; created_at: number }[];
      if (id && !rows.length) return bad('not_found', `no ticket ${id}`);
      const items = rows.map((r) => ({ id: r.id, client: clip(r.client_name, 60), status: r.status, at: new Date(r.created_at).toISOString(), text: clip(r.text, 200) }));
      for (const r of items.slice(0, 3)) turn.card({ kind: 'item', id: `ticket:${r.id}`, title: `Тикет #${r.id}: ${r.client}`, href: TEAM_HREF.ticket(r.id), meta: { type: 'ticket', status: r.status } });
      const open = Number((db.prepare("SELECT COUNT(*) n FROM cs_tickets WHERE status = 'open'").get() as { n: number }).n);
      return done({ open, items });
    }),
    tool('quotes', (input) => {
      if (!has('ps_documents')) return done({ items: [] });
      const lead = int(input.leadId);
      const rows = (lead
        ? db.prepare('SELECT id, lead_id, kind, title, status, created_at FROM ps_documents WHERE lead_id = ? ORDER BY id DESC LIMIT 10').all(lead)
        : db.prepare('SELECT id, lead_id, kind, title, status, created_at FROM ps_documents ORDER BY id DESC LIMIT 10').all()) as { id: number; lead_id: number | null; kind: string; title: string; status: string; created_at: number }[];
      const items = rows.map((r) => ({ id: r.id, leadId: r.lead_id, kind: r.kind, title: clip(r.title, 80), status: r.status, at: new Date(r.created_at).toISOString() }));
      for (const r of items.slice(0, 3)) turn.card({ kind: 'document', id: String(r.id), title: r.title, href: r.leadId ? TEAM_HREF.lead(r.leadId) : TEAM_HREF.approvals(), meta: { kind: r.kind, status: r.status } });
      return done({ items });
    }),
    tool('create_task', (input) => {
      const title = str(input.title, 120);
      if (title.length < 3) return bad('invalid', 'title is required: ask the owner what to do');
      if (!agent) return bad('not_configured', 'no agent');
      const t = hq.createTask({ title, body: typeof input.body === 'string' ? input.body.trim().slice(0, 4000) : '', dept: agent.dept, creator: 'head', tags: ['team-chat'], meta: { via: 'team-chat', from: agentId } });
      const head = hq.headOf(agent.dept);
      if (head) hq.wake(head.id, 'task');
      audit('create_task', 'task', t.id);
      turn.card({ kind: 'task', id: String(t.id), title: clip(t.title, 120), href: TEAM_HREF.task(t.id), meta: { status: t.status, dept: t.dept } });
      turn.act({ type: 'task_created', ref: String(t.id) });
      return done({ taskId: t.id, dept: t.dept, status: t.status });
    }),
    tool('assign_agent', (input) => {
      const to = str(input.agent, 64);
      const text = str(input.text, 2000);
      if (!to || text.length < 3) return bad('invalid', 'agent and text are required');
      if (to === agentId) return bad('invalid', 'that is you: do it yourself or create_task');
      const r = d.assign(agentId, to, text);
      if (!r.ok) return bad(r.status === 404 ? 'not_found' : 'invalid', r.error);
      turn.card({ kind: 'task', id: String(r.task.id), title: clip(`Поручение для ${to}: ${text}`, 120), href: r.task.href, meta: { agent: to } });
      turn.act({ type: 'task_assigned', ref: String(r.task.id) });
      return done({ taskId: r.task.id, agent: to, note: 'Агент ответит в своём чате.' });
    }),
    tool('draft_reply', (input) => {
      const id = int(input.ticketId);
      if (!id) return bad('invalid', 'ticketId is required');
      if (!has('cs_tickets')) return bad('not_found', `no ticket ${id}`);
      const tk = db.prepare('SELECT id, client_name, text, status FROM cs_tickets WHERE id = ?').get(id) as { id: number; client_name: string; text: string; status: string } | undefined;
      if (!tk) return bad('not_found', `no ticket ${id}`);
      if (tk.status !== 'open') return bad('blocked', `ticket ${id} is ${tk.status}: nothing to answer`);
      const exists = hq.tasks({ dept: 'support', open: true, limit: 500 }).find((t) => t.meta.action === 'ticket' && t.meta.ticketId === id);
      let taskId = exists?.id;
      if (!taskId) {
        const note = str(input.note, 300);
        const name = tk.client_name.replace(/:/g, ' ').trim().slice(0, 80) || 'клиент';
        // the same task as a cabinet ticket (`SupportHead.cabinetTicket`): Customer Support drafts, the draft waits in Approvals
        const t = hq.createTask({
          title: `Ответ на тикет #${id}`, dept: 'support', creator: 'head', tags: ['team-chat'],
          meta: { action: 'ticket', args: `${name}: ${tk.text}${note ? `\n[Пожелание владельца к ответу: ${note}]` : ''}`, ticketId: id, via: 'team-chat' },
        });
        taskId = t.id;
        const head = hq.headOf('support');
        if (head) hq.wake(head.id, 'task');
        audit('draft_reply', 'ticket', id);
      }
      turn.card({ kind: 'task', id: String(taskId), title: `Ответ на тикет #${id}`, href: TEAM_HREF.task(taskId), meta: { ticket: id } });
      turn.act({ type: 'reply_drafted', ref: String(taskId) });
      return done({ taskId, ticketId: id, already: Boolean(exists), note: 'Черновик подготовит Customer Support, он придёт в Одобрения.' });
    }),
    tool('propose_quote', (input) => {
      const lead = int(input.leadId);
      if (!lead) return bad('invalid', 'leadId is required');
      if (!has('li_leads') || !db.prepare('SELECT 1 FROM li_leads WHERE id = ?').get(lead)) return bad('not_found', `no lead ${lead}`);
      const draft = has('ps_documents') ? db.prepare("SELECT id FROM ps_documents WHERE lead_id = ? AND status IN ('draft', 'approved') LIMIT 1").get(lead) as { id: number } | undefined : undefined;
      if (draft) return bad('blocked', `lead ${lead} already has a КП (document ${draft.id}): see quotes`);
      const exists = hq.tasks({ dept: 'sales', open: true, limit: 500 }).find((t) => t.meta.action === 'kp' && t.meta.leadId === lead);
      let taskId = exists?.id;
      if (!taskId) {
        const note = str(input.note, 300);
        // the same task the Sales head makes for a qualified lead (`startKpFor`): Presales writes, everything waits in Approvals (locked)
        const t = hq.createTask({ title: `КП для лида #${lead}`, dept: 'sales', creator: 'head', priority: 1, tags: ['team-chat'], meta: { action: 'kp', leadId: lead, via: 'team-chat', ...(note ? { note } : {}) } });
        taskId = t.id;
        const head = hq.headOf('sales');
        if (head) hq.wake(head.id, 'task');
        audit('propose_quote', 'lead', lead);
      }
      turn.card({ kind: 'task', id: String(taskId), title: `КП для лида #${lead}`, href: TEAM_HREF.task(taskId), meta: { lead } });
      turn.card({ kind: 'lead', id: String(lead), title: `Заявка #${lead}`, href: TEAM_HREF.lead(lead) });
      turn.act({ type: 'quote_proposed', ref: String(taskId) });
      return done({ taskId, leadId: lead, already: Boolean(exists), note: 'КП, смету и черновик договора готовит Presales, всё придёт в Одобрения.' });
    }),
    tool('schedule_call', async (input) => {
      if (!d.calls) return fail('not_configured', 'no call bookings');
      const lead = int(input.leadId);
      const at = typeof input.at === 'string' ? Date.parse(input.at) : NaN;
      if (!lead) return fail('invalid', 'leadId is required');
      if (!Number.isFinite(at) || at <= hq.now()) return fail('invalid', 'at must be a future time in ISO 8601 with the time zone');
      const r = await d.calls.book(lead, at, 'pult', { tell: true });
      if (!r) return fail('not_found', `no lead ${lead}`);
      audit('schedule_call', 'lead', lead);
      turn.card({ kind: 'lead', id: String(lead), title: `Созвон по заявке #${lead}`, href: TEAM_HREF.lead(lead), meta: { at: new Date(r.booking.at).toISOString(), state: r.booking.state } });
      turn.act({ type: 'call_scheduled', ref: String(lead) });
      return okv({ leadId: lead, at: new Date(r.booking.at).toISOString(), state: r.booking.state });
    }),
    tool('client_note', (input) => {
      const kind = input.kind === 'lead' || input.kind === 'ticket' || input.kind === 'prospect' ? input.kind : null;
      const id = int(input.id);
      const text = str(input.text, 500);
      if (!kind || !id || text.length < 2) return bad('invalid', 'kind, id and text are required');
      const table = { lead: 'li_leads', ticket: 'cs_tickets', prospect: 'pr_prospects' }[kind];
      if (!has(table) || !db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id)) return bad('not_found', `no ${kind} ${id}`);
      db.exec('CREATE TABLE IF NOT EXISTS crm_notes (kind TEXT NOT NULL, ref_id INTEGER NOT NULL, note TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (kind, ref_id))');
      const cur = (db.prepare('SELECT note FROM crm_notes WHERE kind = ? AND ref_id = ?').get(kind, id) as { note: string } | undefined)?.note ?? '';
      const day = new Date(hq.now()).toISOString().slice(0, 10);
      const next = `${cur ? `${cur}\n` : ''}[${day} ${agentId}] ${text}`.slice(-4000);
      db.prepare('INSERT INTO crm_notes (kind, ref_id, note, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(kind, ref_id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at').run(kind, id, next, hq.now());
      audit('client_note', kind, id);
      const href = kind === 'lead' ? TEAM_HREF.lead(id) : kind === 'ticket' ? TEAM_HREF.ticket(id) : TEAM_HREF.prospect(id);
      turn.card(kind === 'lead' ? { kind: 'lead', id: String(id), title: `Заявка #${id}: заметка`, href } : { kind: 'item', id: `${kind}:${id}`, title: `${kind === 'ticket' ? 'Тикет' : 'Бизнес'} #${id}: заметка`, href, meta: { type: kind } });
      turn.act({ type: 'note_added', ref: `${kind}:${id}` });
      return done({ kind, id, saved: true });
    }),
  ];

  const exec = assistantTools({ hq, links: d.links, ...(d.pendingApprovals ? { pendingApprovals: d.pendingApprovals } : {}), ...(d.settingsView ? { settingsView: d.settingsView } : {}) });
  const mk = d.marketing ? marketingTools(d.marketing, { text: ctx.text, turn: turn.mk }) : {};
  const audited = (name: string, t: FiraTool): FiraTool => ({
    def: t.def,
    run: async (input, c) => {
      const r = await t.run(input, c);
      if (r.ok && name === 'create_order') {
        const ref = turn.mk.actions.find((a) => a.type === 'order_created')?.ref;
        if (ref) audit('create_order', 'task', ref);
      }
      return r;
    },
  });
  const all: ToolRegistry = { ...exec, ...Object.fromEntries(Object.entries(mk).map(([n, t]) => [n, audited(n, t)])), ...Object.fromEntries(own), price_list: priceList };
  // only the agent's own tools (the built-in knowledge tools come from Fira's runtime and are filtered by the same pack list)
  return Object.fromEntries(Object.entries(all).filter(([name]) => allowed.has(name)));
}
