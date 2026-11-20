/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { BillingStore } from '@fir/worker-billing';
import { CsStore } from '@fir/worker-customer-support';
import { DocStore } from '@fir/worker-documents';
import { LeadStore } from '@fir/worker-lead-intake';
import { PmStore } from '@fir/worker-project-manager';
import { ReferralStore } from '@fir/worker-referral';
import { describe, expect, it } from 'vitest';
import { createAdmin } from '../src/admin.js';
import { OWNER, world } from './helpers.js';

function setup() {
  const w = world({ presence: true });
  const db = w.hq.db;
  const t = () => w.clock.t;
  const tickets: any[] = [];
  const admin = createAdmin({
    hq: w.hq, queue: w.queue, director: w.director, channel: w.channel!, ownerId: OWNER, now: t, commandNames: [],
    cabinetTicket: (x) => { tickets.push(x); return Promise.resolve(); },
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const [p, qs] = path.split('?');
    const r = await admin.handle({ method, path: p!, query: new URLSearchParams(qs ?? ''), body });
    return { status: r.status, json: r.body as Record<string, any> };
  };
  new LeadStore(db, t);
  const lead = (name: string, contact: string) => {
    const task = w.hq.createTask({ title: 'Лид', dept: 'sales', creator: 'routine' });
    db.prepare("INSERT INTO li_leads (task_id, name, contact, origin, created_at) VALUES (?, ?, ?, 'site', ?)").run(task.id, name, contact, t());
    return (db.prepare('SELECT MAX(id) m FROM li_leads').get() as { m: number }).m;
  };
  const reg = (over: Record<string, unknown> = {}) =>
    call('POST', '/admin/clients', { email: 'Alice@Example.com ', name: 'Алиса', telegram: '@Alice', locale: 'ru', supabaseId: 'abc-123', marketingConsent: true, ...over });
  return { w, db, call, lead, reg, tickets, admin };
}

describe('cabinet: POST /admin/clients', () => {
  it('validates the body', async () => {
    const { call } = setup();
    for (const bad of [{}, { email: 'nope', supabaseId: 'x' }, { email: 'a@b.co' }, { email: 'a@b.co', supabaseId: 'x', locale: 'de' }, { email: 'a@b.co', supabaseId: 'x', name: 'n'.repeat(121) }, { email: 'a@b.co', supabaseId: 'x y' }, { email: `${'a'.repeat(250)}@b.co`, supabaseId: 'x' }]) {
      expect((await call('POST', '/admin/clients', bad)).json).toMatchObject({ ok: false, error: 'invalid' });
    }
    const r = await call('POST', '/admin/clients', { email: 'A@B.co', supabaseId: 'x' });
    expect(r.json.client).toMatchObject({ email: 'a@b.co', name: '', telegram: '', locale: 'ru' });
  });

  it('upserts by email: same id, fields updated, owner told once', async () => {
    const { reg, db, w } = setup();
    const a = await reg();
    expect(a.status).toBe(200);
    expect(a.json).toMatchObject({ ok: true, linkedLeads: 0, client: { id: 1, email: 'alice@example.com', name: 'Алиса', telegram: '@Alice', locale: 'ru' } });
    expect(a.json.client.createdAt).toMatch(/^\d{4}-/);
    const b = await reg({ name: 'Алиса К', locale: 'en' });
    expect(b.json.client).toMatchObject({ id: 1, name: 'Алиса К', locale: 'en' });
    expect((db.prepare('SELECT COUNT(*) n FROM cab_clients').get() as any).n).toBe(1);
    const lines = w.channel!.list({}).filter((i) => i.text.startsWith('Новый аккаунт в кабинете'));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).toBe('Новый аккаунт в кабинете: Алиса, лидов привязано 0');
  });

  it('links leads by email and by handle, with or without @, any case', async () => {
    const { reg, lead, db, call } = setup();
    lead('A1', 'ALICE@example.com');
    lead('A2', '@alice');
    lead('A3', 'alice');
    lead('A4', ' @ALICE ');
    lead('Other', 'bob@example.com');
    lead('Other2', '@bob');
    const r = await reg();
    expect(r.json.linkedLeads).toBe(4);
    expect(db.prepare('SELECT COUNT(*) n FROM li_leads WHERE client_id IS NULL').get()).toEqual({ n: 2 });
    expect((await reg()).json.linkedLeads).toBe(4);
    // a lead that arrives later is linked on the next registration call and on a by-email read
    lead('A5', 'alice@example.com');
    expect((await call('GET', '/admin/clients/by-email?email=alice%40example.com')).status).toBe(200);
    expect((await reg()).json.linkedLeads).toBe(5);
    // an empty handle never matches empty contacts
    lead('Empty', '');
    expect((await reg({ telegram: '' })).json.linkedLeads).toBe(5);
  });

  it('does not steal leads already linked to another account', async () => {
    const { reg, lead, db } = setup();
    lead('A1', 'alice@example.com');
    await reg();
    const r = await reg({ email: 'other@example.com', name: 'Other', telegram: '@alice' });
    expect(r.json.linkedLeads).toBe(0);
    expect(db.prepare('SELECT client_id FROM li_leads').get()).toEqual({ client_id: 1 });
  });

  it('the cabinet client shows in the Clients panel with source cabinet', async () => {
    const { reg, call } = setup();
    await reg();
    const r = await call('GET', '/admin/crm/clients');
    expect(r.json.items).toContainEqual(expect.objectContaining({ name: 'Алиса', contact: 'alice@example.com', sources: ['cabinet'] }));
  });

  it('needs the admin token path like the rest: unknown routes 404', async () => {
    const { call } = setup();
    expect((await call('GET', '/admin/clients')).status).toBe(404);
    expect((await call('POST', '/admin/clients/abc/tickets', { text: 'x' })).status).toBe(404);
    expect((await call('DELETE', '/admin/clients/by-email')).status).toBe(404);
  });
});

describe('cabinet: GET /admin/clients/by-email', () => {
  it('400 on a bad email, 404 for an unknown one', async () => {
    const { call } = setup();
    expect((await call('GET', '/admin/clients/by-email')).json).toMatchObject({ ok: false, error: 'invalid' });
    expect((await call('GET', '/admin/clients/by-email?email=zzz')).status).toBe(400);
    const r = await call('GET', '/admin/clients/by-email?email=nobody%40example.com');
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ ok: false, error: 'not_found' });
  });

  it('returns only this client\'s rows and never anybody else\'s data or owner notes', async () => {
    const { w, db, call, lead, reg } = setup();
    const t = () => w.clock.t;
    const aliceLead = lead('Алиса', '@alice');
    const bobLead = lead('Боб', 'bob@example.com');
    void bobLead;
    const pm = new PmStore(db, t);
    const mine = pm.createProject({ client: 'Алиса', what: 'Сайт', product: 'site', source: 'owner', taskId: null });
    pm.createProject({ client: 'Боб', what: 'Бот', product: 'bot', source: 'owner', taskId: null });
    const billing = new BillingStore(db, t);
    const inv = billing.addInvoice({ client: 'Алиса', amountUsd: 300, what: 'Сайт', method: null, dueDate: '2026-12-01' }, 2026);
    billing.addInvoice({ client: 'Боб', amountUsd: 999, what: 'Бот', method: null, dueDate: '2026-12-01' }, 2026);
    const docs = new DocStore(db, t);
    const c1 = docs.add({ type: 'contract', client: 'Алиса', projectId: null, text: 'Договор Алисы', taskId: null });
    docs.add({ type: 'contract', client: 'Боб', projectId: null, text: 'Договор Боба', taskId: null });
    const pol = docs.add({ type: 'privacy', client: 'Алиса', projectId: null, text: 'Политика', taskId: null });
    const draft = docs.add({ type: 'act', client: 'Алиса', projectId: null, text: 'Акт-черновик', taskId: null });
    db.prepare("UPDATE bo_documents SET status = 'approved' WHERE id IN (?, ?)").run(c1.id, pol.id);
    db.prepare("UPDATE bl_invoices SET status = 'issued' WHERE id = ?").run(inv.id);
    void draft;
    const cs = new CsStore(db, t);
    cs.addTicket({ clientName: 'Алиса', text: 'вопрос Алисы', money: false });
    cs.addTicket({ clientName: 'Боб', text: 'секрет Боба', money: false });
    db.prepare("UPDATE cs_tickets SET contact = '@alice' WHERE client_name = 'Алиса'").run();
    db.prepare("UPDATE cs_tickets SET contact = 'bob@example.com' WHERE client_name = 'Боб'").run();
    db.prepare("INSERT INTO crm_notes (kind, ref_id, note, updated_at) VALUES ('ticket', 1, 'OWNER SECRET', 0)").run();
    const rf = new ReferralStore(db, '10%', t);
    rf.propose({ referrer: 'Алиса', referred: 'Карим', source: 'owner' });
    rf.propose({ referrer: 'Боб', referred: 'Дина', source: 'owner' });
    void mine; void aliceLead;
    await reg();
    // a stranger who registers under Alice's name gets none of her records
    await call('POST', '/admin/clients', { email: 'fake@example.com', name: 'Алиса', telegram: '', supabaseId: 'z' });
    const fake = await call('GET', '/admin/clients/by-email?email=fake%40example.com');
    expect(fake.json).toMatchObject({ projects: [], invoices: [], documents: [], tickets: [], referrals: [] });

    const r = await call('GET', '/admin/clients/by-email?email=ALICE%40example.com');
    expect(r.status).toBe(200);
    expect(r.json.client).toMatchObject({ name: 'Алиса', email: 'alice@example.com', telegram: '@Alice' });
    expect(r.json.projects.map((p: any) => p.client)).toEqual(['Алиса']);
    expect(r.json.projects[0]).toMatchObject({ what: 'Сайт', stage: 'spec' });
    expect(r.json.invoices.map((d: any) => [d.source, d.client, d.amountUsd])).toEqual([['billing', 'Алиса', 300]]);
    expect(r.json.documents.map((d: any) => [d.kind, d.client])).toEqual([['contract', 'Алиса']]);
    expect(r.json.tickets).toHaveLength(1);
    expect(r.json.tickets[0]).toMatchObject({ text: 'вопрос Алисы', answer: null });
    expect(r.json.tickets[0]).not.toHaveProperty('note');
    // the ticket carries the client's id of /admin/clients (cabinet id by the handle in its contact)
    const list = (await call('GET', '/admin/crm/clients')).json.items as any[];
    expect(r.json.tickets[0].clientId).toBe(list.find((c) => c.name === 'Алиса').id);
    expect((await call('GET', '/admin/crm/tickets')).json.items.map((x: any) => [x.clientName, x.clientId])).toEqual([['Боб', 'c:боб'], ['Алиса', r.json.tickets[0].clientId]]);
    expect(r.json.referrals.map((x: any) => x.referred)).toEqual(['Карим']);
    expect(r.json.referralSlug).toMatch(/^c[a-z0-9]{1,30}$/);
    const text = JSON.stringify(r.json);
    for (const leak of ['Боб', 'bob@', 'OWNER SECRET', 'Политика', 'Дина', 'x-admin', 'prompt']) expect(text).not.toContain(leak);
    // the slug is stable, and a referral made with it is listed for the client
    const again = await call('GET', '/admin/clients/by-email?email=alice%40example.com');
    expect(again.json.referralSlug).toBe(r.json.referralSlug);
    rf.propose({ referrer: r.json.referralSlug, referred: 'Эмин', source: 'lead' });
    expect((await call('GET', '/admin/clients/by-email?email=alice%40example.com')).json.referrals).toHaveLength(2);
  });

  it('updates last_seen_at and caps lists at 50 newest', async () => {
    const { w, db, call, lead, reg } = setup();
    lead('Алиса', 'alice@example.com');
    const cs = new CsStore(db, () => w.clock.t);
    await reg();
    for (let i = 0; i < 55; i++) { w.clock.t += 1000; cs.addCabinetTicket({ clientName: 'Алиса', contact: 'alice@example.com', text: `q${i}` }); }
    const r = await call('GET', '/admin/clients/by-email?email=alice%40example.com');
    expect(r.json.tickets).toHaveLength(50);
    expect(r.json.tickets[0].text).toBe('q54');
    expect((db.prepare('SELECT last_seen_at l FROM cab_clients').get() as any).l).toBe(w.clock.t);
  });
});

describe('cabinet: POST /admin/clients/:id/tickets', () => {
  it('404 for an unknown client, 400 for a bad text', async () => {
    const { call, reg } = setup();
    expect((await call('POST', '/admin/clients/9/tickets', { text: 'hi' })).json).toEqual({ ok: false, error: 'not_found' });
    await reg();
    for (const text of ['', '   ', 'x'.repeat(1001), 5]) expect((await call('POST', '/admin/clients/1/tickets', { text })).json).toMatchObject({ ok: false, error: 'invalid' });
    expect((await call('POST', '/admin/clients/1/tickets', {})).status).toBe(400);
  });

  it('creates a cs ticket (source cabinet, contact = email) and hands it to the support flow', async () => {
    const { call, reg, db, tickets } = setup();
    await reg();
    const r = await call('POST', '/admin/clients/1/tickets', { text: ' Как оплатить? ' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, item: { id: 1, text: 'Как оплатить?', status: 'open', answeredAt: null, answer: null } });
    expect(db.prepare('SELECT client_name, contact, source, status FROM cs_tickets').get()).toEqual({ client_name: 'Алиса', contact: 'alice@example.com', source: 'cabinet', status: 'open' });
    expect(tickets).toEqual([{ id: 1, name: 'Алиса', text: 'Как оплатить?', telegram: '@Alice' }]);
    // no name: the email is the client name
    await call('POST', '/admin/clients', { email: 'noname@example.com', supabaseId: 'q' });
    await call('POST', '/admin/clients/2/tickets', { text: 'hi' });
    expect((db.prepare('SELECT client_name FROM cs_tickets WHERE id = 2').get() as any).client_name).toBe('noname@example.com');
    // the answer shows on the CRM ticket list too
    db.prepare("UPDATE cs_tickets SET answer = 'Вот так', status = 'answered' WHERE id = 1").run();
    const list = await call('GET', '/admin/crm/tickets');
    expect(list.json.items.find((x: any) => x.id === 1)).toMatchObject({ answer: 'Вот так', status: 'answered' });
    expect(list.json.items.find((x: any) => x.id === 2).answer).toBeNull();
  });

  it('limits a flood of tickets per client', async () => {
    const { call, reg } = setup();
    await reg();
    for (let i = 0; i < 10; i++) expect((await call('POST', '/admin/clients/1/tickets', { text: `t${i}` })).status).toBe(200);
    expect((await call('POST', '/admin/clients/1/tickets', { text: 'one more' })).status).toBe(429);
  });
});

describe('cabinet: rate limit is the shared admin one', () => {
  it('6000 requests per 10 minutes also count cabinet calls', async () => {
    const { admin } = setup();
    const req = { method: 'GET', path: '/admin/clients/by-email', query: new URLSearchParams('email=a%40b.co'), body: null };
    for (let i = 0; i < 6000; i++) expect((await admin.handle(req)).status).toBe(404);
    expect((await admin.handle(req)).status).toBe(429);
  });
});

describe('cabinet: a lead message on a database where the support tables do not exist yet', () => {
  it('is stored, not a 500 "no such table: cs_tickets" (drill 2026-11-21: the rate-limit count ran before the support store was made)', async () => {
    const { call, lead, reg, db } = setup();
    const c = (await reg()).json.client;
    const leadId = lead('Алиса', 'alice@example.com');
    db.prepare('UPDATE li_leads SET client_id = ? WHERE id = ?').run(c.id, leadId);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'cs_tickets'").get()).toBeUndefined();
    const r = await call('POST', `/admin/clients/${c.id}/leads/${leadId}/messages`, { text: 'Когда будет КП?' });
    expect(r.status).toBe(200);
    expect(r.json.item).toMatchObject({ from: 'client', leadId, ticketId: 1 });
  });
});
