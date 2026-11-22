/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { BillingStore } from '@fir/worker-billing';
import { PmStore } from '@fir/worker-project-manager';
import { describe, expect, it } from 'vitest';
import { STAGES } from '../src/lead-stage.js';
import { shellWorld, serve } from './shell-helpers.js';

const MIN = 60_000;
const DAY = 86_400_000;

function tables(p: ReturnType<typeof shellWorld>) {
  const db = p.w.hq.db;
  const t = p.t;
  const billing = new BillingStore(db, t);
  const pm = new PmStore(db, t);
  // presales and back office tables exist only after their workers ran: the stage derivation must cope with both cases
  db.exec(`CREATE TABLE IF NOT EXISTS ps_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, pack_id INTEGER NOT NULL DEFAULT 1, lead_id INTEGER, kind TEXT NOT NULL, direction TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'draft', created_at INTEGER NOT NULL, decided_at INTEGER)`);
  db.exec(`CREATE TABLE IF NOT EXISTS bo_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, client TEXT NOT NULL, project_id INTEGER, version INTEGER NOT NULL DEFAULT 1, text TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', task_id INTEGER, created_at INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS lost_leads (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, source TEXT NOT NULL, reason TEXT NOT NULL, contact TEXT NOT NULL DEFAULT '', ref TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', alerted INTEGER NOT NULL DEFAULT 0)`);
  return { db, billing, pm };
}

describe('GET /admin/hub', () => {
  it('401 without the token, shape with it, every department present', async () => {
    const p = shellWorld();
    const s = await serve(p);
    expect((await s.http('GET', '/admin/hub', undefined, {})).status).toBe(401);
    expect((await s.http('GET', '/admin/hub', undefined, { 'x-admin-token': 'wrong' })).status).toBe(401);
    const r = await s.http('GET', '/admin/hub');
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.ok).toBe(true);
    expect(j.generatedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(Object.keys(j.departments).sort()).toEqual(['backoffice', 'director', 'marketing', 'production', 'sales', 'support']);
    expect(j.departments.sales).toEqual({ pending: 0, approvals: 0, alerts: 0, running: 0, lastActivityAt: null });
    expect(j.inbox).toEqual([]);
    await s.close();
  });

  it('counts tasks and approvals per department, lists the inbox newest first (50 at most) with panel links', async () => {
    const p = shellWorld();
    const { w } = p;
    tables(p);
    w.hq.createTask({ title: 'ждёт', dept: 'sales', creator: 'owner' });
    const b = w.hq.createTask({ title: 'идёт', dept: 'sales', creator: 'owner' });
    w.hq.claim(b.id, 'sales-head');
    const c = w.hq.createTask({ title: 'застрял', dept: 'support', creator: 'owner' });
    w.hq.block(c.id, 'support-head', 'нужен человек');
    // a lead, a paid invoice, an open ticket, an alert and a pending content approval
    p.lead('Алиса', { service: 'bot' });
    p.cs.addCabinetTicket({ clientName: 'Боб', contact: 'b@x.co', text: 'Не работает бот' });
    const inv = new BillingStore(w.hq.db, p.t).addInvoice({ client: 'Алиса', amountUsd: 100, what: 'Сайт', method: null, dueDate: '2026-12-01' }, 2026);
    new BillingStore(w.hq.db, p.t).markManualPaid(inv.id);
    await w.director.alertOwner('диск почти полон');
    const t = w.hq.createTask({ title: 'карточка', dept: 'marketing', creator: 'head' });
    await w.hq.requestApproval(t.id, 'marketing-head', 'content_item', { itemId: 77, text: 'x' }, 'Клип про бота');
    await w.hq.releaseApprovals();
    const r = await p.call('GET', '/admin/hub');
    const d = r.json.departments;
    expect(d.sales).toMatchObject({ pending: 2, running: 1, alerts: 0 }); // the lead's own task waits too
    expect(d.support).toMatchObject({ alerts: 1 });
    expect(d.marketing.approvals).toBe(1);
    expect(d.sales.lastActivityAt).toMatch(/^\d{4}-/);
    const kinds = r.json.inbox.map((i: any) => i.kind).sort();
    expect(kinds).toEqual(['alert', 'content', 'lead', 'payment', 'ticket']);
    const link = Object.fromEntries(r.json.inbox.map((i: any) => [i.kind, i.link]));
    expect(link.lead).toMatch(/^leads:\d+$/);
    expect(link.payment).toBe(`invoices:${inv.id}`);
    expect(link.ticket).toMatch(/^tickets:\d+$/);
    expect(link.content).toBe('content:item:77');
    for (const i of r.json.inbox) expect(Object.keys(i).sort()).toEqual(['at', 'dept', 'id', 'kind', 'link', 'title']);
    const ats = r.json.inbox.map((i: any) => i.at);
    expect([...ats].sort().reverse()).toEqual(ats);
  });

  it('is capped at 50 rows and cached for 5 seconds', async () => {
    const p = shellWorld();
    for (let i = 0; i < 60; i++) p.lead(`Лид ${i}`);
    for (let i = 0; i < 60; i++) await p.w.director.alertOwner(`алерт ${i}`);
    const first = await p.call('GET', '/admin/hub');
    expect(first.json.inbox.length).toBeLessThanOrEqual(50);
    p.lead('Новый');
    const cached = await p.call('GET', '/admin/hub');
    expect(cached.json.generatedAt).toBe(first.json.generatedAt);
    p.w.clock.t += 6_000;
    const fresh = await p.call('GET', '/admin/hub');
    expect(fresh.json.generatedAt).not.toBe(first.json.generatedAt);
    expect(fresh.json.inbox.some((i: any) => i.title.includes('Новый'))).toBe(true);
  });

  it('only GET', async () => {
    const p = shellWorld();
    expect((await p.call('POST', '/admin/hub', {})).status).toBe(404);
  });
});

describe('lead stage: derived, with a manual override', () => {
  it('walks new -> qualified -> proposal -> contract -> paid -> project from the data; lost from lost_leads', async () => {
    const p = shellWorld();
    const { db, billing, pm } = tables(p);
    const stage = async (id: number) => (await p.call('GET', '/admin/crm/leads')).json.items.find((i: any) => i.id === id);
    const l = p.lead('Алиса', { contact: '@alice' });
    expect(await stage(l.id)).toMatchObject({ stage: 'new', nextAction: expect.stringContaining('Ответить') });
    db.prepare("UPDATE li_leads SET service = 'bot', budget = '$300-500' WHERE id = ?").run(l.id);
    expect((await stage(l.id)).stage).toBe('qualified');
    db.prepare("INSERT INTO ps_documents (lead_id, kind, status, created_at) VALUES (?, 'kp', 'draft', ?)").run(l.id, p.t());
    expect((await stage(l.id)).stage).toBe('qualified'); // a draft КП is not an approved one
    db.prepare("UPDATE ps_documents SET status = 'approved'").run();
    expect((await stage(l.id)).stage).toBe('proposal');
    db.prepare("INSERT INTO bo_documents (type, client, status, created_at) VALUES ('contract', 'алиса', 'pending', ?)").run(p.t());
    expect((await stage(l.id)).stage).toBe('contract');
    const inv = billing.addInvoice({ client: 'Алиса', amountUsd: 150, what: 'Сайт', method: null, dueDate: '2026-12-01', leadId: l.id }, 2026);
    expect((await stage(l.id)).stage).toBe('contract'); // an open invoice is not a payment
    billing.markManualPaid(inv.id);
    const paid = await stage(l.id);
    expect(paid).toMatchObject({ stage: 'paid', nextAction: expect.stringContaining('проект') });
    const proj = pm.createProject({ client: 'Алиса', what: 'Сайт', product: 'site', source: 'sales', taskId: null, leadId: l.id });
    expect((await stage(l.id)).stage).toBe('paid'); // reserved (draft) project does not count as started
    pm.setStatus(proj.id, 'active');
    expect(await stage(l.id)).toMatchObject({ stage: 'project', nextAction: null });

    const lost = p.lead('Пропал', { contact: '+99890123' });
    db.prepare("INSERT INTO lost_leads (at, source, reason, contact) VALUES (?, 'chat', 'x', ?)").run(p.t(), '+99890123');
    expect((await stage(lost.id)).stage).toBe('lost');
  });

  it('works when none of the other worker tables exist', async () => {
    const p = shellWorld();
    const l = p.lead('Один');
    const r = await p.call('GET', '/admin/crm/leads');
    expect(r.json.items.find((i: any) => i.id === l.id)).toMatchObject({ stage: 'new' });
  });

  it('an override moves the lead; the derived stage wins only when it is further along', async () => {
    const p = shellWorld();
    const { db, billing } = tables(p);
    const l = p.lead('Алиса', { service: 'bot', budget: '$300' }); // derived: qualified
    let r = await p.call('POST', `/admin/crm/leads/${l.id}`, { stage: 'proposal' });
    expect(r.status).toBe(200);
    expect(r.json.item).toMatchObject({ id: l.id, stage: 'proposal' });
    // the override is behind the data: derived qualified < override proposal, override stays
    expect((await p.call('GET', '/admin/crm/leads')).json.items[0].stage).toBe('proposal');
    // the data overtakes the override: a paid invoice
    const inv = billing.addInvoice({ client: 'Алиса', amountUsd: 150, what: 'Сайт', method: null, dueDate: '2026-12-01', leadId: l.id }, 2026);
    billing.markManualPaid(inv.id);
    expect((await p.call('GET', '/admin/crm/leads')).json.items[0].stage).toBe('paid');
    // a lower manual stage does not pull a paid lead back; to «new» is refused
    r = await p.call('POST', `/admin/crm/leads/${l.id}`, { stage: 'new' });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ ok: false, error: 'illegal_transition', from: 'paid' });
    expect(r.json.allowed).not.toContain('new');
    r = await p.call('POST', `/admin/crm/leads/${l.id}`, { stage: 'contract' });
    expect(r.json.item.stage).toBe('paid');
    expect((db.prepare('SELECT stage_override FROM li_leads WHERE id = ?').get(l.id) as any).stage_override).toBe('contract');
    // lost is manual, with a reason and a note; it does not hide a lead that already paid
    const m = p.lead('Мимо');
    r = await p.call('POST', `/admin/crm/leads/${m.id}`, { stage: 'lost', lost_reason: 'не ответил', note: 'звонили дважды' });
    expect(r.json.item).toMatchObject({ stage: 'lost', lostReason: 'не ответил', note: 'звонили дважды', nextAction: null });
    r = await p.call('POST', `/admin/crm/leads/${l.id}`, { stage: 'lost' });
    expect(r.json.item.stage).toBe('paid');
    // moving a lost lead back to the line
    r = await p.call('POST', `/admin/crm/leads/${m.id}`, { stage: 'qualified' });
    expect(r.json.item.stage).toBe('qualified');
  });

  it('validates the body: unknown stage and fields are 400 with the allowed list, unknown lead 404', async () => {
    const p = shellWorld();
    const l = p.lead('Алиса');
    for (const bad of [{ stage: 'won' }, { stage: 5 }, { note: 'x'.repeat(2001) }, { extra: 1 }, { lost_reason: 'y'.repeat(501) }]) {
      const r = await p.call('POST', `/admin/crm/leads/${l.id}`, bad);
      expect(r.status).toBe(400);
      expect(r.json).toMatchObject({ ok: false, error: 'invalid', allowed: [...STAGES] });
    }
    expect((await p.call('POST', '/admin/crm/leads/999', { stage: 'new' })).status).toBe(404);
    expect((await p.call('POST', '/admin/crm/leads/abc', { stage: 'new' })).status).toBe(404);
    // an empty body changes nothing and still answers with the item
    expect((await p.call('POST', `/admin/crm/leads/${l.id}`, {})).json.item.stage).toBe('new');
  });
});

describe('POST /admin/crm/leads/:id/reply', () => {
  it('a Telegram lead is answered through the client bot, without an approval, and the lead journal records it', async () => {
    const p = shellWorld();
    const l = p.lead('Алиса', { meta: { chatId: 4242 } });
    const before = p.w.queue.pending().length;
    const r = await p.call('POST', `/admin/crm/leads/${l.id}/reply`, { text: '  Здравствуйте, Алиса!  ' });
    expect(r.json).toEqual({ ok: true, sent: true, via: 'telegram' });
    expect(p.toClient).toEqual([{ chatId: 4242, text: 'Здравствуйте, Алиса!' }]);
    expect(p.w.queue.pending().length).toBe(before);
    expect(p.w.hq.events(l.taskId).at(-1)).toMatchObject({ kind: 'comment', actor: 'owner' });
    expect(p.w.hq.events(l.taskId).at(-1)!.body).toContain('Здравствуйте, Алиса!');
    expect(p.w.hq.activity(5).some((a) => a.action === 'lead_reply' && a.objectId === String(l.id))).toBe(true);
  });

  it('a web lead is answered through the web chat session', async () => {
    const p = shellWorld();
    const l = p.lead('Веб', { meta: { sessionId: 'sess-123456' } });
    expect((await p.call('POST', `/admin/crm/leads/${l.id}/reply`, { text: 'Добрый день' })).json).toEqual({ ok: true, sent: true, via: 'web' });
    expect(p.toWeb).toEqual([{ sessionId: 'sess-123456', text: 'Добрый день' }]);
    // the session is gone: nothing was sent
    const g = p.lead('Ушёл', { meta: { sessionId: 'gone' } });
    expect((await p.call('POST', `/admin/crm/leads/${g.id}/reply`, { text: 'Привет' })).json).toEqual({ ok: true, sent: false, via: 'none' });
  });

  it('a lead without a channel: via none, sent false, still journaled; a failing bot is sent:false via telegram', async () => {
    const p = shellWorld();
    const l = p.lead('Форма', { contact: 'x@y.co' });
    expect((await p.call('POST', `/admin/crm/leads/${l.id}/reply`, { text: 'Привет' })).json).toEqual({ ok: true, sent: false, via: 'none' });
    expect(p.w.hq.events(l.taskId).at(-1)!.body).toContain('не доставлен');
    const failing = shellWorld({ admin: { client: { send: () => Promise.reject(new Error('403')) } } });
    const f = failing.lead('Бот', { meta: { chatId: 1 } });
    expect((await failing.call('POST', `/admin/crm/leads/${f.id}/reply`, { text: 'Привет' })).json).toEqual({ ok: true, sent: false, via: 'telegram' });
  });

  it('validates: text 1..2000, no extra fields, unknown lead 404', async () => {
    const p = shellWorld();
    const l = p.lead('Алиса', { meta: { chatId: 1 } });
    for (const bad of [{}, { text: '' }, { text: '   ' }, { text: 'x'.repeat(2001) }, { text: 'ok', extra: 1 }, { text: 5 }]) {
      expect((await p.call('POST', `/admin/crm/leads/${l.id}/reply`, bad)).json).toMatchObject({ ok: false, error: 'invalid' });
    }
    expect((await p.call('POST', `/admin/crm/leads/${l.id}/reply`, { text: 'x'.repeat(2000) })).json.ok).toBe(true);
    expect((await p.call('POST', '/admin/crm/leads/999/reply', { text: 'x' })).status).toBe(404);
    expect(p.toClient).toHaveLength(1);
  });
});

describe('POST /admin/crm/leads/:id/call', () => {
  it('stores the call slot and returns the lead', async () => {
    const p = shellWorld();
    const l = p.lead('Алиса');
    const at = new Date(p.t() + DAY).toISOString();
    const r = await p.call('POST', `/admin/crm/leads/${l.id}/call`, { at });
    expect(r.json).toMatchObject({ ok: true, item: { id: l.id, callAt: at } });
    expect((p.w.hq.db.prepare('SELECT chosen_slot c FROM li_leads WHERE id = ?').get(l.id) as any).c).toBe(Date.parse(at));
    for (const bad of [{}, { at: 'завтра' }, { at: at, x: 1 }, { at: 5 }]) expect((await p.call('POST', `/admin/crm/leads/${l.id}/call`, bad)).json.error).toBe('invalid');
    expect((await p.call('POST', '/admin/crm/leads/999/call', { at })).status).toBe(404);
  });
});

describe('GET /admin/crm/clients/:id (client 360)', () => {
  it('a cabinet client: leads by email, their projects, invoices, tickets, touches; ids in the clients list', async () => {
    const p = shellWorld();
    const { billing, pm } = tables(p);
    await p.call('POST', '/admin/clients', { email: 'alice@example.com', name: 'Алиса', telegram: '@alice', locale: 'ru', supabaseId: 'abc' });
    const l = p.lead('Алиса Иванова', { contact: 'alice@example.com', service: 'bot' });
    p.lead('Чужой', { contact: 'bob@example.com' });
    pm.createProject({ client: 'Алиса Иванова', what: 'Бот', product: 'bot', source: 'sales', taskId: null, leadId: l.id });
    const inv = billing.addInvoice({ client: 'Алиса Иванова', amountUsd: 200, what: 'Бот', method: null, dueDate: '2026-12-01', leadId: l.id }, 2026);
    billing.markManualPaid(inv.id);
    p.cs.addCabinetTicket({ clientName: 'Алиса', contact: 'alice@example.com', text: 'Вопрос по счёту' });
    await p.call('POST', `/admin/crm/leads/${l.id}/reply`, { text: 'Привет' });
    const list = await p.call('GET', '/admin/crm/clients');
    const row = list.json.items.find((i: any) => i.contact === 'alice@example.com');
    expect(row.id).toBe('1');
    const r = await p.call('GET', `/admin/crm/clients/${row.id}`);
    expect(r.status).toBe(200);
    expect(r.json.client).toMatchObject({ id: '1', name: 'Алиса', email: 'alice@example.com', telegram: '@alice', cabinet: true });
    expect(r.json.leads.map((x: any) => x.name)).toEqual(['Алиса Иванова']);
    expect(r.json.projects).toHaveLength(1);
    expect(r.json.invoices.map((x: any) => x.number)).toEqual([inv.number]);
    expect(r.json.invoices[0]).toMatchObject({ status: 'paid', payUrl: expect.stringContaining('/pay/') });
    expect(r.json.tickets).toHaveLength(1);
    for (const k of ['documents', 'referrals', 'touches']) expect(Array.isArray(r.json[k])).toBe(true);
    const kinds = r.json.touches.map((x: any) => x.kind);
    expect(kinds).toEqual(expect.arrayContaining(['lead', 'invoice', 'payment', 'ticket', 'message']));
    expect(r.json.touches.length).toBeLessThanOrEqual(30);
    expect(r.json.leads.some((x: any) => x.name === 'Чужой')).toBe(false);
    // «Демо только для вошедших»: the demo use of 30 days (zeros first, then what `demo_usage` holds for this client only)
    expect(r.json.demoUsage).toMatchObject({ days: 30, messages: 0, usd: 0, bySource: [] });
    const { DemoUsage } = await import('../src/demo-usage.js');
    const du = new DemoUsage({ db: p.w.hq.db, now: p.t, tz: () => 'Asia/Dushanbe' });
    await du.metered(1, 'persona:salon', async () => 'x');
    await du.metered(2, 'persona:shop', async () => 'x');
    const again = await p.call('GET', `/admin/crm/clients/${row.id}`);
    expect(again.json.demoUsage).toMatchObject({ messages: 1, today: 1, bySource: [{ source: 'persona:salon', messages: 1 }] });
  });

  it('a client without an account is c:<name>; unknown ids are 404', async () => {
    const p = shellWorld();
    p.lead('Боб Петров', { contact: '@bob' });
    const list = await p.call('GET', '/admin/crm/clients');
    expect(list.json.items[0].id).toBe('c:боб петров');
    const r = await p.call('GET', `/admin/crm/clients/${encodeURIComponent('c:боб петров')}`);
    expect(r.json.client).toMatchObject({ id: 'c:боб петров', name: 'боб петров', cabinet: false, telegram: '@bob' });
    expect(r.json.leads).toHaveLength(1);
    expect((await p.call('GET', '/admin/crm/clients/999')).status).toBe(404);
    expect((await p.call('GET', '/admin/crm/clients/zzz')).status).toBe(404);
    expect((await p.call('GET', '/admin/crm/clients/c:')).status).toBe(404);
  });
});

describe('projects: detail and actions', () => {
  function project(p: ReturnType<typeof shellWorld>) {
    const { pm } = tables(p);
    const proj = pm.createProject({ client: 'Алиса', what: 'Сайт', product: 'site', source: 'sales', taskId: null });
    pm.setStatus(proj.id, 'active');
    const m1 = pm.addMilestone({ projectId: proj.id, kind: 'brief', title: 'Бриф', dueAt: p.t() + DAY });
    const m2 = pm.addMilestone({ projectId: proj.id, kind: 'prototype', title: 'Прототип', dueAt: p.t() + 3 * DAY });
    return { pm, proj, m1, m2 };
  }

  it('GET: item, milestones, tasks and issues; unknown 404', async () => {
    const p = shellWorld();
    const { pm, proj, m1 } = project(p);
    const task = p.w.hq.createTask({ title: 'Сделать бриф', dept: 'production', creator: 'head', meta: { issue: { number: 41, url: 'https://github.com/x/y/issues/41' } } });
    pm.setMilestoneTask(m1.id, task.id);
    const r = await p.call('GET', `/admin/crm/projects/${proj.id}`);
    expect(r.json.ok).toBe(true);
    expect(r.json.item).toMatchObject({ id: proj.id, client: 'Алиса', status: 'active', stage: 'brief' });
    expect(r.json.milestones).toMatchObject([
      { id: m1.id, kind: 'brief', title: 'Бриф', dueAt: new Date(p.t() + DAY).toISOString(), doneAt: null },
      expect.objectContaining({ kind: 'prototype' }),
    ]);
    expect(r.json.tasks).toEqual([{ id: task.id, title: 'Сделать бриф', status: 'inbox', assignee: expect.any(String) }]);
    expect(r.json.issues).toEqual([{ number: 41, title: 'Сделать бриф', state: 'open', url: 'https://github.com/x/y/issues/41' }]);
    expect((await p.call('GET', '/admin/crm/projects/999')).status).toBe(404);
  });

  it('complete_milestone goes through /mdone (once), set_deadline, set_status, note', async () => {
    const p = shellWorld();
    const { pm, proj, m1, m2 } = project(p);
    let r = await p.call('POST', `/admin/crm/projects/${proj.id}`, { action: 'complete_milestone', milestoneId: m1.id });
    expect(r.json.ok).toBe(true);
    expect(pm.milestone(m1.id)!.status).toBe('done');
    expect(r.json.item.tasksDone).toBe(1);
    r = await p.call('POST', `/admin/crm/projects/${proj.id}`, { action: 'complete_milestone', milestoneId: m1.id });
    expect(r.json.ok).toBe(true); // idempotent
    const doneAt = pm.milestone(m1.id)!.doneAt;
    expect(doneAt).not.toBeNull();
    // the last one closes the project (the same effect as the owner's /mdone)
    await p.call('POST', `/admin/crm/projects/${proj.id}`, { action: 'complete_milestone', milestoneId: m2.id });
    expect(pm.project(proj.id)!.status).toBe('done');
    // a milestone of another project is not found
    const other = project(p);
    expect((await p.call('POST', `/admin/crm/projects/${proj.id}`, { action: 'complete_milestone', milestoneId: other.m1.id })).status).toBe(404);

    const due = new Date(p.t() + 10 * DAY).toISOString();
    r = await p.call('POST', `/admin/crm/projects/${other.proj.id}`, { action: 'set_deadline', milestoneId: other.m1.id, dueAt: due });
    expect(r.json.ok).toBe(true);
    expect(pm.milestone(other.m1.id)!.dueAt).toBe(Date.parse(due));
    expect((await p.call('POST', `/admin/crm/projects/${other.proj.id}`, { action: 'set_deadline', milestoneId: other.m1.id, dueAt: 'потом' })).json.error).toBe('invalid');

    for (const status of ['draft', 'active', 'paused', 'done']) {
      expect((await p.call('POST', `/admin/crm/projects/${other.proj.id}`, { action: 'set_status', status })).json.item.status).toBe(status);
    }
    r = await p.call('POST', `/admin/crm/projects/${other.proj.id}`, { action: 'set_status', status: 'cancelled' });
    expect(r.status).toBe(400);
    expect(r.json).toMatchObject({ error: 'invalid', allowed: ['draft', 'active', 'done', 'paused'] });

    r = await p.call('POST', `/admin/crm/projects/${other.proj.id}`, { action: 'note', text: 'Клиент просил тёмную тему' });
    expect(r.json.ok).toBe(true);
    expect((await p.call('GET', `/admin/crm/projects/${other.proj.id}`)).json.item.note).toBe('Клиент просил тёмную тему');
    for (const bad of [{}, { action: 'delete' }, { action: 'note' }, { action: 'note', text: '' }, { action: 'complete_milestone' }, { action: 'set_status', status: 'done', x: 1 }]) {
      expect((await p.call('POST', `/admin/crm/projects/${other.proj.id}`, bad)).status).toBe(400);
    }
    expect((await p.call('POST', '/admin/crm/projects/999', { action: 'note', text: 'x' })).status).toBe(404);
  });
});

describe('invoices', () => {
  function invoices(p: ReturnType<typeof shellWorld>) {
    const { billing } = tables(p);
    const l = p.lead('Алиса', { meta: { chatId: 777 } });
    const issued = billing.addInvoice({ client: 'Алиса', amountUsd: 150, what: 'Сайт', method: null, dueDate: '2026-11-20', leadId: l.id }, 2026);
    billing.setStatus(issued.id, 'issued');
    const draft = billing.addInvoice({ client: 'Боб', amountUsd: 80, what: 'Бот', method: null, dueDate: '2026-12-20' }, 2026);
    return { billing, l, issued, draft };
  }

  it('GET lists the contract fields, filters by status, 400 on an unknown status', async () => {
    const p = shellWorld();
    const { issued } = invoices(p);
    const r = await p.call('GET', '/admin/crm/invoices');
    expect(r.json.items).toHaveLength(2);
    const row = r.json.items.find((i: any) => i.id === issued.id);
    expect(row).toMatchObject({
      number: issued.number, client: 'Алиса', title: 'Сайт', amountUsd: 150, payAmountUsd: 150, status: 'issued', dueDate: '2026-11-20', paidAt: null, paidVia: null, txId: null,
      remindedAt: null, payUrl: expect.stringMatching(/^https:\/\/firtech\.pro\/ru\/pay\/FT-2026-001\?k=/),
    });
    expect(row.issuedAt).toMatch(/^\d{4}-/);
    expect((await p.call('GET', '/admin/crm/invoices?status=issued')).json.items).toHaveLength(1);
    const bad = await p.call('GET', '/admin/crm/invoices?status=weird');
    expect(bad.status).toBe(400);
    expect(bad.json).toMatchObject({ error: 'invalid_status', allowed: ['draft', 'issued', 'paid', 'void'] });
  });

  it('mark_paid is the /paid path: paid once, idempotent, void ones refused', async () => {
    const p = shellWorld();
    const { issued, draft } = invoices(p);
    let r = await p.call('POST', `/admin/crm/invoices/${issued.id}`, { action: 'mark_paid' });
    expect(r.json.item).toMatchObject({ status: 'paid', paidVia: 'manual' });
    expect(r.json.item.paidAt).toMatch(/^\d{4}-/);
    const first = r.json.item.paidAt;
    p.w.clock.t += 5 * MIN;
    r = await p.call('POST', `/admin/crm/invoices/${issued.id}`, { action: 'mark_paid' });
    expect(r.json.item.paidAt).toBe(first);
    // the Support head ran: a task of /paid exists in its department
    expect(p.w.hq.tasks({ dept: 'support' }).some((t) => t.meta.action === 'paid')).toBe(true);
    await p.call('POST', `/admin/crm/invoices/${draft.id}`, { action: 'void' });
    expect((await p.call('POST', `/admin/crm/invoices/${draft.id}`, { action: 'mark_paid' })).status).toBe(409);
  });

  it('remind sends Billing\'s reminder text through the lead\'s Telegram chat, else hands the text to the owner', async () => {
    const p = shellWorld();
    const { issued, draft, billing } = invoices(p);
    let r = await p.call('POST', `/admin/crm/invoices/${issued.id}`, { action: 'remind' });
    expect(r.json.ok).toBe(true);
    expect(r.json.item).toMatchObject({ remindedVia: 'telegram', remindedAt: expect.stringMatching(/^\d{4}-/) });
    expect(p.toClient).toHaveLength(1);
    expect(p.toClient[0]).toMatchObject({ chatId: 777 });
    expect(p.toClient[0]!.text).toContain(`счёт ${issued.number}`);
    expect(p.toClient[0]!.text).toContain('Как оплатить');
    // an invoice without a reachable lead: the text goes to the owner's inbox
    const loose = billing.addInvoice({ client: 'Вася', amountUsd: 20, what: 'Правка', method: null, dueDate: '2026-11-21' }, 2026);
    billing.setStatus(loose.id, 'issued');
    r = await p.call('POST', `/admin/crm/invoices/${loose.id}`, { action: 'remind' });
    expect(r.json.item.remindedVia).toBe('owner');
    expect(p.toClient).toHaveLength(1);
    expect(p.w.channel!.list({}).some((i) => i.text.includes(`Напоминание по счёту ${loose.number}`) && i.text.includes('Вася'))).toBe(true);
    // only issued invoices are reminded
    expect((await p.call('POST', `/admin/crm/invoices/${draft.id}`, { action: 'remind' })).status).toBe(409);
  });

  it('void: idempotent, a paid invoice cannot be voided; validation and 404', async () => {
    const p = shellWorld();
    const { issued, draft } = invoices(p);
    expect((await p.call('POST', `/admin/crm/invoices/${draft.id}`, { action: 'void' })).json.item.status).toBe('void');
    expect((await p.call('POST', `/admin/crm/invoices/${draft.id}`, { action: 'void' })).json.item.status).toBe('void');
    await p.call('POST', `/admin/crm/invoices/${issued.id}`, { action: 'mark_paid' });
    const r = await p.call('POST', `/admin/crm/invoices/${issued.id}`, { action: 'void' });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('illegal_transition');
    for (const bad of [{}, { action: 'refund' }, { action: 'void', x: 1 }]) {
      const b = await p.call('POST', `/admin/crm/invoices/${draft.id}`, bad);
      expect(b.status).toBe(400);
      expect(b.json).toMatchObject({ error: 'invalid', allowed: ['remind', 'mark_paid', 'void'] });
    }
    expect((await p.call('POST', '/admin/crm/invoices/999', { action: 'void' })).status).toBe(404);
  });
});
