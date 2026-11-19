/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { BillingStore } from '@fir/worker-billing';
import { CsStore } from '@fir/worker-customer-support';
import { DocStore } from '@fir/worker-documents';
import { PmStore } from '@fir/worker-project-manager';
import { PresalesStore } from '@fir/worker-presales';
import { ProspectStore } from '@fir/worker-prospector';
import { ReferralStore } from '@fir/worker-referral';
import { LeadStore } from '@fir/worker-lead-intake';
import { describe, expect, it } from 'vitest';
import { createAdmin } from '../src/admin.js';
import { OWNER, world } from './helpers.js';

function setup(seed = true) {
  const w = world({ presence: true });
  const db = w.hq.db;
  const t = () => w.clock.t;
  const admin = createAdmin({ hq: w.hq, queue: w.queue, director: w.director, channel: w.channel!, ownerId: OWNER, now: t, commandNames: [] });
  const call = async (method: string, path: string, body?: unknown) => {
    const [p, qs] = path.split('?');
    const r = await admin.handle({ method, path: p!, query: new URLSearchParams(qs ?? ''), body });
    return { status: r.status, json: r.body as Record<string, any> };
  };
  if (seed) {
    const ps = new ProspectStore(db, t);
    db.prepare("INSERT INTO pr_prospects (niche, city, name, name_key, telegram, noticed, created_at) VALUES ('barber', 'Dushanbe', 'Bro Barber', 'bro|d', '@bro', ?, ?)").run('x'.repeat(900), t());
    db.prepare("INSERT INTO pr_prospects (niche, city, name, name_key, created_at) VALUES ('dental', 'Tashkent', 'Smile', 's|t', ?)").run(t());
    void ps;
    new LeadStore(db, t);
    const task = w.hq.createTask({ title: 'Лид', dept: 'sales', creator: 'routine' });
    db.prepare("INSERT INTO li_leads (task_id, name, contact, origin, task, created_at) VALUES (?, 'Алиса', '@alice', 'site', ?, ?)").run(task.id, 'y'.repeat(900), t());
    const cs = new CsStore(db, t);
    cs.upsertClient({ name: 'Алиса', contact: '@alice' });
    cs.addTicket({ clientName: 'Алиса', text: 'не работает бот', money: false });
    cs.addTicket({ clientName: 'Боб', text: 'вопрос про счёт', money: true });
    new DocStore(db, t).add({ type: 'contract', client: 'Алиса', projectId: null, text: 'Договор...', taskId: null });
    new PresalesStore(db, t).createPack(1, 'site', [{ kind: 'kp', title: 'КП', body: 'b' }, { kind: 'estimate', title: 'Смета', body: 'b' }]);
    new BillingStore(db, t).addInvoice({ client: 'Алиса', amountUsd: 300, what: 'Сайт', method: null, dueDate: '2026-12-01' }, 2026);
    const pm = new PmStore(db, t);
    const pr = pm.createProject({ client: 'Алиса', what: 'Сайт', product: 'site', source: 'owner', taskId: null });
    db.prepare("UPDATE pm_projects SET status = 'active' WHERE id = ?").run(pr.id);
    pm.addMilestone({ projectId: pr.id, kind: 'brief', title: 'Бриф', dueAt: t() + 86_400_000 });
    new ReferralStore(db, '10%', t).propose({ referrer: 'Алиса', referred: 'Боб', source: 'owner' });
  }
  return { w, call };
}

describe('admin crm: access and shape', () => {
  it('unknown paths and methods are 404 json', async () => {
    const { call } = setup(false);
    expect((await call('GET', '/admin/crm/nope')).status).toBe(404);
    expect((await call('POST', '/admin/crm/summary', {})).status).toBe(404);
    expect((await call('GET', '/admin/crm/prospects/abc')).status).toBe(404);
  });

  it('empty database: every panel answers available false with an empty list', async () => {
    const { call } = setup(false);
    for (const p of ['prospects', 'leads', 'tickets', 'projects', 'referrals', 'reviews']) {
      const r = await call('GET', `/admin/crm/${p}`);
      expect(r.json).toMatchObject({ ok: true, available: false, items: [], nextCursor: null });
    }
    const s = (await call('GET', '/admin/crm/summary')).json;
    expect(s).toMatchObject({ prospects: { available: false, total: 0 }, tickets: { available: false, open: 0 }, reviews: { available: false } });
    expect((await call('GET', '/admin/crm/documents')).json).toMatchObject({ available: false, items: [] });
    expect((await call('GET', '/admin/crm/clients')).json.items).toEqual([]);
  });
});

describe('admin crm: panels', () => {
  it('summary counts every panel', async () => {
    const { call } = setup();
    const s = (await call('GET', '/admin/crm/summary')).json;
    expect(s.prospects).toMatchObject({ available: true, total: 2, byStatus: { new: 2, sent: 0 } });
    expect(s.leads).toMatchObject({ total: 1, byStatus: { inbox: 1 } });
    expect(s.tickets).toMatchObject({ open: 2 });
    expect(s.documents.byKind).toMatchObject({ contract: { pending: 1 }, kp: { draft: 1 }, estimate: { draft: 1 }, invoice: { draft: 1 } });
    expect(s.projects.active).toBe(1);
    expect(s.referrals.byStatus.proposed).toBe(1);
    expect(s.reviews).toEqual({ available: false, pending: 0 });
  });

  it('prospects: list, search, pagination, caps, status flow and notes', async () => {
    const { call } = setup();
    const l = (await call('GET', '/admin/crm/prospects')).json;
    expect(l.statuses).toEqual(['new', 'proposed', 'sent', 'replied', 'no_reply', 'skipped']);
    expect(l.items.map((i: any) => i.name)).toEqual(['Smile', 'Bro Barber']);
    expect(l.items[1].noticed).toHaveLength(500);
    expect((await call('GET', '/admin/crm/prospects?q=bro')).json.items).toHaveLength(1);
    const p1 = (await call('GET', '/admin/crm/prospects?limit=1')).json;
    expect(p1.items).toHaveLength(1);
    const p2 = (await call('GET', `/admin/crm/prospects?limit=1&cursor=${p1.nextCursor}`)).json;
    expect(p2.items[0].name).toBe('Bro Barber');
    expect(p2.nextCursor).toBeNull();
    expect((await call('GET', '/admin/crm/prospects?status=bad')).status).toBe(400);
    const id = l.items[1].id;
    const upd = await call('POST', `/admin/crm/prospects/${id}`, { status: 'skipped', note: 'не интересно' });
    expect(upd.json.item).toMatchObject({ status: 'skipped', note: 'не интересно', nextStatuses: [] });
    expect((await call('GET', '/admin/crm/prospects?status=skipped')).json.items).toHaveLength(1);
  });

  it('prospects POST: 404, invalid status 400 with the list, illegal transition 409', async () => {
    const { call } = setup();
    expect((await call('POST', '/admin/crm/prospects/999', { status: 'sent' })).status).toBe(404);
    const bad = await call('POST', '/admin/crm/prospects/1', { status: 'won' });
    expect(bad.status).toBe(400);
    expect(bad.json).toMatchObject({ ok: false, error: 'invalid_status', allowed: expect.arrayContaining(['new', 'sent']) });
    const ill = await call('POST', '/admin/crm/prospects/1', { status: 'replied' });
    expect(ill.status).toBe(409);
    expect(ill.json).toMatchObject({ error: 'illegal_transition', from: 'new', allowed: ['proposed', 'skipped'] });
    expect((await call('POST', '/admin/crm/prospects/1', { junk: 1 })).status).toBe(400);
  });

  it('leads with the status of their task, capped text', async () => {
    const { call } = setup();
    const r = (await call('GET', '/admin/crm/leads')).json;
    expect(r.items[0]).toMatchObject({ kind: 'lead', name: 'Алиса', contact: '@alice', source: 'site', status: 'inbox' });
    expect(r.items[0].task).toHaveLength(500);
    expect((await call('GET', '/admin/crm/leads?q=zzz')).json.items).toEqual([]);
  });

  it('clients: one row per client across sources', async () => {
    const { call } = setup();
    const r = (await call('GET', '/admin/crm/clients')).json;
    const alice = r.items.find((c: any) => c.name === 'Алиса');
    expect(alice).toMatchObject({ contact: '@alice', counts: { leads: 1, tickets: 1, projects: 1, invoices: 1, documents: 1 } });
    expect(alice.sources).toEqual(expect.arrayContaining(['site', 'support', 'project', 'billing', 'documents']));
    expect(r.items.filter((c: any) => c.name.toLowerCase() === 'алиса')).toHaveLength(1);
    expect(r.items.map((c: any) => c.name)).toContain('Боб');
    expect(r.chats).toEqual({ web: 0, telegram: 0 });
    expect((await call('GET', '/admin/crm/clients?q=%40alice')).json.items).toHaveLength(1);
    const pg = (await call('GET', '/admin/crm/clients?limit=1')).json;
    expect(pg.items).toHaveLength(1);
    expect((await call('GET', `/admin/crm/clients?limit=1&cursor=${pg.nextCursor}`)).json.items).toHaveLength(1);
  });

  it('tickets: list, status filter, status change, note, reply is refused', async () => {
    const { call } = setup();
    const r = (await call('GET', '/admin/crm/tickets?status=open')).json;
    expect(r.items).toHaveLength(2);
    expect(r.statuses).toEqual(['open', 'answered']);
    const id = r.items[0].id;
    expect((await call('POST', `/admin/crm/tickets/${id}`, { reply: 'hi' })).json.error).toBe('reply_not_supported');
    expect((await call('POST', `/admin/crm/tickets/${id}`, { status: 'closed' })).json).toMatchObject({ error: 'invalid_status', allowed: ['open', 'answered'] });
    expect((await call('POST', '/admin/crm/tickets/999', { status: 'answered' })).status).toBe(404);
    const upd = await call('POST', `/admin/crm/tickets/${id}`, { status: 'answered', note: 'позвонил' });
    expect(upd.json.item).toMatchObject({ status: 'answered', note: 'позвонил' });
    expect(upd.json.item.answeredAt).not.toBeNull();
    expect((await call('GET', '/admin/crm/tickets?status=open')).json.items).toHaveLength(1);
    expect((await call('GET', '/admin/crm/tickets?q=счёт')).json.items).toHaveLength(1);
  });

  it('documents: contracts, presales kits and invoices in one list', async () => {
    const { call } = setup();
    const r = (await call('GET', '/admin/crm/documents')).json;
    expect(r.kinds).toEqual(['contract', 'estimate', 'invoice', 'kp']);
    const inv = r.items.find((d: any) => d.kind === 'invoice');
    expect(inv).toMatchObject({ source: 'billing', amountUsd: 300, client: 'Алиса', status: 'draft', link: null });
    expect(inv.number).toMatch(/^FT-2026-/);
    expect((await call('GET', '/admin/crm/documents?kind=kp')).json.items).toHaveLength(1);
    expect((await call('GET', '/admin/crm/documents?status=pending')).json.items).toHaveLength(1);
    expect((await call('GET', '/admin/crm/documents?q=Алиса')).json.items).toHaveLength(4);
    const pg = (await call('GET', '/admin/crm/documents?limit=2')).json;
    expect(pg.nextCursor).toBe(2);
  });

  it('projects with stage, deadline and milestone counts', async () => {
    const { call } = setup();
    const r = (await call('GET', '/admin/crm/projects')).json;
    expect(r.items[0]).toMatchObject({ client: 'Алиса', status: 'active', stage: 'brief', tasksTotal: 1, tasksDone: 0, nextMilestone: { kind: 'brief' } });
    expect(r.items[0].deadline).not.toBeNull();
    expect((await call('GET', '/admin/crm/projects?status=done')).json.items).toEqual([]);
  });

  it('referrals and reviews', async () => {
    const { call } = setup();
    const r = (await call('GET', '/admin/crm/referrals')).json;
    expect(r.items[0]).toMatchObject({ referrer: 'Алиса', referred: 'Боб', status: 'proposed', reward: '10%' });
    expect((await call('GET', '/admin/crm/referrals?status=paid')).json.items).toEqual([]);
    expect((await call('GET', '/admin/crm/reviews')).json).toMatchObject({ available: false, items: [] });
  });
});
