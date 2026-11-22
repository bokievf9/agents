import { errMsg, log } from '@fir/core';
import type { Hq } from '@fir/hq';
import { BillingStore, type BillingWorker, type Invoice } from '@fir/worker-billing';
import { PmStore } from '@fir/worker-project-manager';
import { z } from 'zod';
import type { AdminReply } from './admin.js';
import type { CabDocs } from './cab-docs.js';
import type { Calls } from './calls.js';
import { demoUsageOf } from './demo-usage.js';
import type { createCrm } from './admin-crm.js';
import { recordManagerReply } from './cabinet.js';
import type { ClientChannel } from './client/channel.js';
import type { Director } from './director.js';
import { ensureStageColumn, isStage, rankOf, STAGES } from './lead-stage.js';
import type { OwnerChannel } from './presence.js';

/** «Shell v3»: lead writes, client 360, project detail and actions, invoices. Contract: `docs/admin-crm-api.md` («Shell v3»). */
export interface ShellCrmDeps {
  hq: Hq;
  director: Director;
  channel: OwnerChannel;
  now: () => number;
  crm: ReturnType<typeof createCrm>;
  billing?: BillingWorker | undefined;
  /** The public client bot: Telegram leads are answered through it. */
  client?: Pick<ClientChannel, 'send'> | undefined;
  /** The website chat: queues the owner's text for the visitor's session (true: the session exists and the text waits for the next reply). */
  webReply?: ((sessionId: string, text: string) => boolean) | undefined;
  /** The cabinet documents (P-07): the owner's list with the email outcome and «Отправить снова». */
  cabinet?: Partial<Pick<CabDocs, 'resend' | 'ownerList'>> | undefined;
  /** P-18/P-19: the call bookings (the site's window, the client's channel, the reminders). Absent: `call` only writes `chosen_slot`, as before. */
  calls?: Calls | undefined;
}

const iso = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());
export const ok = (body: Record<string, unknown> = {}): AdminReply => ({ status: 200, body: { ok: true, ...body } });
export const fail = (status: number, error: string, extra: Record<string, unknown> = {}): AdminReply => ({ status, body: { ok: false, error, ...extra } });

const leadPost = z.object({ stage: z.string().max(20).optional(), note: z.string().max(2000).optional(), lost_reason: z.string().max(500).optional() }).strict();
const replyBody = z.object({ text: z.string().trim().min(1).max(2000) }).strict();
/** `at` alone books (or moves) the call; `action` confirms, moves (with `at`) or cancels it (P-18, P-19). */
const CALL_ACTIONS = ['book', 'confirm', 'reschedule', 'cancel'] as const;
const callBody = z.object({ at: z.string().max(40).optional(), action: z.enum(CALL_ACTIONS).optional() }).strict();
const PROJECT_STATUSES = ['draft', 'active', 'done', 'paused'] as const;
const projectBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('complete_milestone'), milestoneId: z.number().int().positive() }).strict(),
  z.object({ action: z.literal('ready_milestone'), milestoneId: z.number().int().positive() }).strict(),
  z.object({ action: z.literal('set_deadline'), milestoneId: z.number().int().positive(), dueAt: z.string().max(40) }).strict(),
  z.object({ action: z.literal('set_status'), status: z.string().max(20) }).strict(),
  z.object({ action: z.literal('note'), text: z.string().trim().min(1).max(2000) }).strict(),
]);
const INVOICE_ACTIONS = ['remind', 'mark_paid', 'void'] as const;
const cabDocBody = z.object({ action: z.literal('resend') }).strict();
const invoiceBody = z.object({ action: z.string().max(20) }).strict();
const INVOICE_STATUSES = ['draft', 'issued', 'paid', 'void'] as const;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export function createShellCrm(d: ShellCrmDeps) {
  const { hq, crm, now } = d;
  const db = hq.db;
  const { views } = crm;
  const has = views.has;
  const all = views.all;
  const one = views.one;
  const billingStore = () => new BillingStore(db, now);

  // ---- leads ----
  const leadRow = (id: number) => (has('li_leads') ? one<{ id: number; task_id: number; name: string; contact: string; chosen_slot: number | null; stage_override?: string | null; service: string; budget: string }>('SELECT * FROM li_leads WHERE id = ?', id) : undefined);

  function leadPostRoute(id: number, body: unknown): AdminReply {
    const row = leadRow(id);
    if (!row) return fail(404, 'not_found');
    const parsed = leadPost.safeParse(body ?? {});
    if (!parsed.success) return fail(400, 'invalid', { allowed: STAGES });
    const { stage, note, lost_reason: lostReason } = parsed.data;
    if (stage !== undefined) {
      if (!isStage(stage)) return fail(400, 'invalid', { allowed: STAGES });
      ensureStageColumn(db);
      const cur = views.lead(id)!;
      // a lead that already paid does not go back to «new»
      if (stage === 'new' && rankOf(cur.stage as (typeof STAGES)[number]) >= rankOf('paid')) {
        return fail(409, 'illegal_transition', { from: cur.stage, allowed: STAGES.filter((s) => s !== 'new') });
      }
      db.prepare('UPDATE li_leads SET stage_override = ? WHERE id = ?').run(stage, id);
      hq.log('owner', 'lead_stage', 'lead', String(id), stage);
    }
    if (note !== undefined) views.setNote('lead', id, note);
    if (lostReason !== undefined) views.setNote('lead_lost', id, lostReason);
    return ok({ item: views.lead(id) });
  }

  /** Where the lead can be reached from here: its Telegram chat (client bot) or its website chat session. */
  function leadChannel(taskId: number): { chatId?: number; sessionId?: string } {
    const t = hq.task(taskId);
    const lead = (t?.meta.lead ?? {}) as { chatId?: unknown; sessionId?: unknown };
    return {
      ...(typeof lead.chatId === 'number' ? { chatId: lead.chatId } : {}),
      ...(typeof lead.sessionId === 'string' ? { sessionId: lead.sessionId } : {}),
    };
  }

  async function leadReply(id: number, body: unknown): Promise<AdminReply> {
    const row = leadRow(id);
    if (!row) return fail(404, 'not_found');
    const parsed = replyBody.safeParse(body ?? {});
    if (!parsed.success) return fail(400, 'invalid');
    const { text } = parsed.data;
    const ch = leadChannel(row.task_id);
    let via: 'telegram' | 'web' | 'none' = 'none';
    let sent = false;
    // the owner wrote it himself: no approval, straight through the lead's own channel
    if (ch.chatId !== undefined && d.client) {
      via = 'telegram';
      try {
        await d.client.send(ch.chatId, text);
        sent = true;
      } catch (e) {
        log('warn', 'owner reply to lead not delivered', { lead: id, err: errMsg(e) });
      }
    } else if (ch.sessionId !== undefined && d.webReply) {
      if (d.webReply(ch.sessionId, text)) {
        via = 'web';
        sent = true;
      }
    }
    // the lead's journal: its task and the activity log (ids and the channel, the text only in the task journal the owner reads)
    if (hq.task(row.task_id)) hq.comment(row.task_id, 'owner', `Ответ владельца (${via}${sent ? '' : ', не доставлен'}): ${text.slice(0, 2000)}`);
    hq.log('owner', 'lead_reply', 'lead', String(id), `${via}:${sent ? 'sent' : 'not_sent'}`);
    // a cabinet client reads the reply in the lead's thread: the cabinet itself is a channel, so it is kept even when no chat took it
    recordManagerReply(db, now(), id, text, 'owner');
    return ok({ sent, via });
  }

  async function leadCall(id: number, body: unknown): Promise<AdminReply> {
    const row = leadRow(id);
    if (!row) return fail(404, 'not_found');
    const parsed = callBody.safeParse(body ?? {});
    if (!parsed.success) return fail(400, 'invalid', { allowed: CALL_ACTIONS });
    const action = parsed.data.action ?? 'book';
    const at = parsed.data.at !== undefined ? Date.parse(parsed.data.at) : NaN;
    if ((action === 'book' || action === 'reschedule') && !Number.isFinite(at)) return fail(400, 'invalid', { allowed: CALL_ACTIONS });
    const bookingView = () => {
      const b = d.calls?.of(id);
      return b ? { id: b.id, at: iso(b.at), state: b.state, site: b.site || null } : null;
    };
    if (!d.calls) {
      if (action !== 'book') return fail(503, 'unavailable');
      db.prepare('UPDATE li_leads SET chosen_slot = ? WHERE id = ?').run(at, id);
      hq.log('owner', 'lead_call', 'lead', String(id), iso(at) ?? '');
      return ok({ item: { ...views.lead(id)!, callAt: iso(at) } });
    }
    // P-18: the owner's call goes to the site (the window stops being offered) and the client hears the time by his channel; P-19: a confirmation or a move too
    let told: string[];
    if (action === 'book') {
      const r = await d.calls.book(id, at, 'pult', { tell: true });
      if (!r) return fail(404, 'not_found');
      told = r.told;
    } else if (action === 'reschedule') {
      const r = d.calls.of(id) ? await d.calls.reschedule(id, at) : await d.calls.book(id, at, 'pult', { tell: true });
      if (!r) return fail(404, 'not_found');
      told = r.told;
    } else {
      if (!d.calls.of(id)) return fail(409, 'no_call', { allowed: ['book'] });
      const r = action === 'confirm' ? await d.calls.confirm(id) : await d.calls.cancel(id);
      told = r?.told ?? [];
    }
    hq.log('owner', 'lead_call', 'lead', String(id), action);
    const b = d.calls.of(id);
    return ok({ item: { ...views.lead(id)!, callAt: b ? iso(b.at) : null }, booking: bookingView(), told });
  }

  // ---- invoices ----
  /** `{ no, of, title }` of the stage an invoice pays (payment by stages); null for an invoice outside the stage plan. */
  function stageOfInvoice(inv: Pick<Invoice, 'projectId' | 'stageNo'>): { no: number; of: number; title: string } | null {
    if (inv.stageNo === null || inv.projectId === null) return null;
    const stages = views.stageViews(inv.projectId);
    const m = stages.find((x) => x.stageNo === inv.stageNo);
    return m ? { no: inv.stageNo, of: stages.length, title: m.title ?? '' } : null;
  }
  const invoiceView = (inv: Invoice) => ({
    id: inv.id, number: inv.number, client: inv.client, title: inv.what, amountUsd: inv.amountUsd, payAmountUsd: inv.payAmountUsd, status: inv.status,
    dueDate: inv.dueDate, issuedAt: iso(inv.issuedAt), paidAt: iso(inv.paidAt), paidVia: inv.paidVia, txId: inv.txId,
    payUrl: d.billing ? d.billing.payUrl(inv) : null, remindedAt: iso(inv.remindedAt), leadId: inv.leadId, projectId: inv.projectId,
    stageNo: inv.stageNo, stage: stageOfInvoice(inv),
    // Cabinet v3: the client's copy of this invoice (his documents list), null when it was not sent through the cabinet
    documentId: (db.prepare("SELECT id FROM cab_documents WHERE src = 'bl' AND src_id = ?").get(inv.id) as { id: number } | undefined)?.id ?? null,
  });

  function invoicesList(query: URLSearchParams): AdminReply {
    const status = query.get('status');
    if (status && !(INVOICE_STATUSES as readonly string[]).includes(status)) return fail(400, 'invalid_status', { allowed: INVOICE_STATUSES });
    const limit = Math.min(Math.max(Number(query.get('limit')) || 50, 1), 200);
    const items = billingStore().invoices(status ? [status as (typeof INVOICE_STATUSES)[number]] : undefined, limit);
    return ok({ available: true, statuses: INVOICE_STATUSES, items: items.map(invoiceView), nextCursor: null });
  }

  async function invoicePost(id: number, body: unknown): Promise<AdminReply> {
    const store = billingStore();
    const inv = store.invoice(id);
    if (!inv) return fail(404, 'not_found');
    const parsed = invoiceBody.safeParse(body ?? {});
    const action = parsed.success ? parsed.data.action : '';
    if (!(INVOICE_ACTIONS as readonly string[]).includes(action)) return fail(400, 'invalid', { allowed: INVOICE_ACTIONS });
    if (action === 'mark_paid') {
      if (inv.status === 'void') return fail(409, 'illegal_transition', { from: inv.status, allowed: [] });
      if (inv.status !== 'paid') {
        // the same path as the owner's `/paid <number>`: the Support head marks it, starts the project, asks the referral payout
        await d.channel.capture(() => d.director.onCommand('paid', inv.number));
      }
      return ok({ item: invoiceView(store.invoice(id)!) });
    }
    if (action === 'void') {
      if (inv.status === 'paid') return fail(409, 'illegal_transition', { from: inv.status, allowed: ['paid'] });
      if (inv.status !== 'void') {
        store.setStatus(id, 'void');
        hq.log('owner', 'invoice_void', 'invoice', inv.number);
      }
      return ok({ item: invoiceView(store.invoice(id)!) });
    }
    // remind: Billing's own reminder text, through the lead's channel; without one the text goes to the owner to send by hand
    if (inv.status !== 'issued') return fail(409, 'illegal_transition', { from: inv.status, allowed: ['issued'] });
    if (!d.billing) return fail(503, 'unavailable');
    const today = new Date(now()).toISOString().slice(0, 10);
    const text = d.billing.reminderText(inv, Math.max(0, dayDiff(today, inv.dueDate)));
    const taskId = inv.leadId !== null ? (one<{ task_id: number }>('SELECT task_id FROM li_leads WHERE id = ?', inv.leadId)?.task_id ?? null) : null;
    const ch = taskId !== null ? leadChannel(taskId) : {};
    let via: 'telegram' | 'owner' = 'owner';
    if (ch.chatId !== undefined && d.client) {
      try {
        await d.client.send(ch.chatId, text);
        via = 'telegram';
      } catch (e) {
        log('warn', 'invoice reminder not delivered', { invoice: inv.number, err: errMsg(e) });
      }
    }
    if (via === 'owner') await d.channel.notify('message', `Напоминание по счёту ${inv.number}, отправьте клиенту ${inv.client}:\n\n${text}`).catch(() => undefined);
    store.markReminded(id);
    hq.log('owner', 'invoice_remind', 'invoice', inv.number, via);
    return ok({ item: { ...invoiceView(store.invoice(id)!), remindedVia: via } });
  }

  // ---- projects ----
  function projectDetail(id: number): AdminReply {
    const item = views.project(id);
    if (!item) return fail(404, 'not_found');
    const pm = new PmStore(db, now);
    const proj = pm.project(id)!;
    const stageById = new Map(views.stageViews(id).map((x) => [x.id, x]));
    const milestones = pm.milestones(id).map((m) => {
      const st = stageById.get(m.id);
      return {
        id: m.id, kind: m.kind, title: m.title, dueAt: iso(m.dueAt), doneAt: iso(m.doneAt),
        stageNo: st?.stageNo ?? null, amountUsd: st?.amountUsd ?? null, invoiceNumber: st?.invoiceNumber ?? null, payUrl: st?.payUrl ?? null, paidAt: st?.paidAt ?? null, acceptedAt: st?.acceptedAt ?? null, state: st?.state ?? null,
      };
    });
    const ids = new Set<number>();
    if (proj.taskId !== null) ids.add(proj.taskId);
    for (const m of pm.milestones(id)) if (m.taskId !== null) ids.add(m.taskId);
    for (const t of [...ids]) for (const c of hq.tasks({ parentId: t, limit: 100 })) ids.add(c.id);
    const tasks = [...ids].map((tid) => hq.task(tid)).filter((t): t is NonNullable<typeof t> => t !== undefined);
    const issues = tasks.flatMap((t) => {
      const i = t.meta.issue as { number?: unknown; url?: unknown } | undefined;
      return i && typeof i.number === 'number' && typeof i.url === 'string'
        ? [{ number: i.number, title: t.title.slice(0, 200), state: t.meta.builderClosed === true || t.status === 'done' ? 'closed' : 'open', url: i.url }]
        : [];
    });
    return ok({
      item: { ...item, note: views.note('project', id) }, milestones,
      tasks: tasks.map((t) => ({ id: t.id, title: t.title.slice(0, 200), status: t.status, assignee: t.assigneeId ?? hq.headOf(t.dept)?.id ?? null })),
      issues,
    });
  }

  async function projectPost(id: number, body: unknown): Promise<AdminReply> {
    if (!views.project(id)) return fail(404, 'not_found');
    const parsed = projectBody.safeParse(body ?? {});
    if (!parsed.success) return fail(400, 'invalid', { allowed: ['complete_milestone', 'ready_milestone', 'set_deadline', 'set_status', 'note'] });
    const b = parsed.data;
    const pm = new PmStore(db, now);
    if (b.action === 'complete_milestone' || b.action === 'set_deadline' || b.action === 'ready_milestone') {
      const m = pm.milestone(b.milestoneId);
      if (!m || m.projectId !== id) return fail(404, 'not_found');
      if (b.action === 'ready_milestone') {
        // P-14: the stage is finished without the builder chain: the same `markDone` + `afterMilestone` (the client gets «Принять этап»), once
        if (m.stageNo === null) {
          if (m.status !== 'done') await d.channel.capture(() => d.director.onCommand('mdone', `${id} ${m.kind}`));
        } else {
          if (m.paidAt === null) return fail(409, 'not_paid', { hint: 'Этап не оплачен: работа и приёмка начинаются после оплаты.' });
          if (m.status !== 'done') await d.channel.capture(() => d.director.onCommand('mready', `${id} ${m.stageNo}`));
        }
      } else if (b.action === 'complete_milestone') {
        // P-15: a stage of the payment plan is accepted for the client only when it waits for his acceptance (paid and done)
        if (m.stageNo !== null && m.acceptedAt === null) {
          if (m.paidAt === null) return fail(409, 'not_paid', { hint: 'Этап не оплачен: принять его нельзя.' });
          if (m.status !== 'done') return fail(409, 'not_ready', { hint: 'Этап ещё в работе: сначала «Этап готов» (ready_milestone), клиент получит «Принять этап».' });
        }
        // the same path as `/mdone`: a «Сдача» starts the deploy, the last milestone closes the project (idempotent: a closed one says so);
        // a stage of the payment plan is ACCEPTED (the next invoice is proposed), done or not
        if (m.stageNo !== null ? m.acceptedAt === null : m.status !== 'done') await d.channel.capture(() => d.director.onCommand('mdone', `${id} ${m.stageNo ?? m.kind}`));
      } else {
        const at = Date.parse(b.dueAt);
        if (!Number.isFinite(at)) return fail(400, 'invalid');
        pm.setDue(m.id, at);
        hq.log('owner', 'milestone_deadline', 'project', String(id), `${m.kind} ${iso(at)}`);
      }
    } else if (b.action === 'set_status') {
      if (!(PROJECT_STATUSES as readonly string[]).includes(b.status)) return fail(400, 'invalid', { allowed: PROJECT_STATUSES });
      // P-15: a project of the payment plan closes through the acceptance of its last stage (the act, the last invoice paid), never by a status flip
      if (b.status === 'done') {
        const open = pm.stageMilestones(id).filter((x) => x.acceptedAt === null);
        if (open.length) {
          return fail(409, 'stages_open', {
            stages: open.map((x) => x.stageNo),
            hint: 'Проект закрывается приёмкой последнего этапа: этап готов (ready_milestone), клиент принимает (или complete_milestone), акт уходит сам. Последний этап должен быть оплачен.',
          });
        }
      }
      pm.setStatus(id, b.status as (typeof PROJECT_STATUSES)[number]);
      hq.log('owner', 'project_status', 'project', String(id), b.status);
    } else {
      views.setNote('project', id, b.text);
      const taskId = pm.project(id)!.taskId;
      if (taskId !== null && hq.task(taskId)) hq.comment(taskId, 'owner', `Заметка владельца: ${b.text}`);
    }
    return ok({ item: views.project(id) });
  }

  // ---- client 360 ----
  function clientDetail(rawId: string): AdminReply {
    let name: string;
    let email = '';
    let telegram = '';
    let createdAt: number | null = null;
    let cabId: number | null = null;
    const cab = /^\d+$/.test(rawId) ? views.cabById(Number(rawId)) : undefined;
    if (/^\d+$/.test(rawId)) {
      if (!cab) return fail(404, 'not_found');
      cabId = cab.id;
      name = cab.name || cab.email;
      email = cab.email;
      telegram = cab.telegram;
      createdAt = cab.created_at;
    } else if (rawId.startsWith('c:') && rawId.length > 2) {
      name = rawId.slice(2);
    } else return fail(404, 'not_found');

    const names = new Set<string>([name.trim().toLowerCase()]);
    const handle = views.handleKey(telegram);
    const leadRows = has('li_leads')
      ? all<{ id: number; name: string; contact: string; created_at: number; task_id: number; client_id?: number | null }>('SELECT * FROM li_leads ORDER BY id DESC')
      : [];
    const mine = leadRows.filter((l) => (cabId !== null && l.client_id === cabId) || names.has(l.name.trim().toLowerCase())
      || (email !== '' && l.contact.trim().toLowerCase() === email) || (handle !== '' && views.handleKey(l.contact) === handle));
    for (const l of mine) names.add(l.name.trim().toLowerCase());
    const leadIds = new Set(mine.map((l) => l.id));
    const stages = views.stages();
    const leadsOut = mine.slice(0, 50).map((l) => views.lead(l.id, stages)!);
    if (!email) email = mine.map((l) => l.contact.trim()).find((c) => EMAIL.test(c)) ?? '';
    if (!telegram) telegram = mine.map((l) => l.contact.trim()).find((c) => c.startsWith('@')) ?? '';
    const isMine = (n: string) => names.has(n.trim().toLowerCase());

    const projectsOut = has('pm_projects')
      ? views.projectsWhere('1 = 1', []).filter((p) => isMine(p.client))
      : [];
    const docs = views.docs().filter((x) => (x.leadId !== undefined ? leadIds.has(x.leadId) : isMine(x.client)));
    const invoiceRows = has('bl_invoices') ? billingStore().invoices(undefined, 500).filter((i) => (i.leadId !== null && leadIds.has(i.leadId)) || isMine(i.client)) : [];
    const ticketsOut = has('cs_tickets') ? views.ticketsWhere('1 = 1', []).filter((t) => isMine(t.clientName) || (email !== '' && t.contact.toLowerCase() === email) || (handle !== '' && views.handleKey(t.contact) === handle)) : [];
    const referralsOut = has('rf_referrals') ? views.referralsWhere('1 = 1', []).filter((r) => isMine(r.referrer) || isMine(r.referred)) : [];

    const touches: { at: string; kind: string; title: string; link: string }[] = [];
    const add = (at: number | null, kind: string, title: string, link: string) => at !== null && touches.push({ at: new Date(at).toISOString(), kind, title: title.slice(0, 160), link });
    for (const l of mine) {
      add(l.created_at, 'lead', `Заявка #${l.id}`, `leads:${l.id}`);
      const t = hq.task(l.task_id);
      if (t) for (const e of hq.events(t.id)) if (e.kind === 'comment' && e.actor === 'owner') add(e.at, 'message', `Ответ владельца: ${e.body.slice(0, 100)}`, `leads:${l.id}`);
    }
    for (const x of docs.filter((x) => x.source !== 'billing')) add(x.createdAt, 'document', `${x.kind}: ${x.title}`, 'documents');
    for (const i of invoiceRows) {
      add(i.createdAt, 'invoice', `Счёт ${i.number}`, `invoices:${i.id}`);
      if (i.paidAt !== null) add(i.paidAt, 'payment', `Оплачен ${i.number}`, `invoices:${i.id}`);
    }
    for (const t of ticketsOut) add(t.createdAt ? Date.parse(t.createdAt) : null, 'ticket', `Обращение #${t.id}`, `tickets:${t.id}`);
    touches.sort((a, b) => b.at.localeCompare(a.at));
    if (createdAt === null) createdAt = touches.length ? Date.parse(touches[touches.length - 1]!.at) : null;

    return ok({
      client: { id: rawId, name, email, telegram, cabinet: cabId !== null, createdAt: iso(createdAt) },
      leads: leadsOut, projects: projectsOut.slice(0, 50), invoices: invoiceRows.slice(0, 50).map(invoiceView),
      documents: docs.filter((x) => x.source !== 'billing').slice(0, 50).map(views.docView), tickets: ticketsOut.slice(0, 50), referrals: referralsOut.slice(0, 50),
      touches: touches.slice(0, 30),
      // «Демо только для вошедших»: the client's demo use of 30 days (counts and money only); zeros for a name-only client
      demoUsage: cabId !== null ? demoUsageOf(hq.db, cabId, now(), hq.tz) : demoUsageOf(hq.db, -1, now(), hq.tz),
    });
  }

  const num = (v: string | undefined) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : null);

  /** `seg` is the path after `/admin/crm/`. null: not a «Shell v3» route (the older CRM handler answers). */
  async function handle(method: string, seg: string[], query: URLSearchParams, body: unknown): Promise<AdminReply | null> {
    const [panel, idRaw, sub] = seg;
    if (panel === 'leads' && idRaw !== undefined && method === 'POST') {
      const id = num(idRaw);
      if (id === null) return fail(404, 'not_found');
      if (seg.length === 2) return leadPostRoute(id, body);
      if (seg.length === 3 && sub === 'reply') return leadReply(id, body);
      if (seg.length === 3 && sub === 'call') return leadCall(id, body);
      return fail(404, 'not_found');
    }
    if (panel === 'clients' && idRaw !== undefined && method === 'GET' && seg.length === 2) {
      try {
        return clientDetail(decodeURIComponent(idRaw));
      } catch {
        return fail(404, 'not_found');
      }
    }
    if (panel === 'projects' && idRaw !== undefined && seg.length === 2) {
      const id = num(idRaw);
      if (id === null) return fail(404, 'not_found');
      if (method === 'GET') return projectDetail(id);
      if (method === 'POST') return projectPost(id, body);
    }
    // P-07: the cabinet documents as the owner sees them (the email outcome, a missing PDF) and «Отправить снова»
    if (panel === 'cabinet-docs') {
      const docs = d.cabinet;
      if (!docs?.ownerList || !docs.resend) return fail(404, 'not_found');
      if (idRaw === undefined && method === 'GET') {
        const cid = query.get('clientId');
        const limit = Number(query.get('limit') ?? '100');
        return ok({ items: docs.ownerList({ problem: query.get('problem') === '1', clientId: cid && /^\d+$/.test(cid) ? Number(cid) : null, limit: Number.isFinite(limit) ? limit : 100 }) });
      }
      const id = num(idRaw);
      if (id !== null && seg.length === 2 && method === 'POST') {
        const b = cabDocBody.safeParse(body ?? {});
        if (!b.success) return fail(400, 'invalid', { allowed: ['resend'] });
        return docs.resend(id);
      }
      return fail(404, 'not_found');
    }
    if (panel === 'invoices') {
      if (idRaw === undefined && method === 'GET') return invoicesList(query);
      const id = num(idRaw);
      if (id !== null && seg.length === 2 && method === 'POST') return invoicePost(id, body);
      return fail(404, 'not_found');
    }
    return null;
  }

  return { handle, invoiceView, leadChannel };
}
