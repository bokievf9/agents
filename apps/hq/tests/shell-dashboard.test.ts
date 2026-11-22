/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { describe, expect, it } from 'vitest';
import { PmStore } from '@fir/worker-project-manager';
import { storeFor } from '@fir/worker-content-maker';
import { shellWorld, serve, type ShellWorld } from './shell-helpers.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const BLOCKS = ['leads', 'approvals', 'money', 'projects', 'tickets', 'content', 'agents'] as const;

/** Makes every source table exist (as a running company has them) without any row. */
async function tables(p: ShellWorld) {
  await p.call('GET', '/admin/crm/invoices');
  new PmStore(p.w.hq.db, p.t);
  storeFor({ db: p.w.hq.db, now: p.t });
}

let seq = 0;
function invoice(p: ShellWorld, o: { amount: number; status: string; due: string; paidAt?: number | null; leadId?: number | null }) {
  seq++;
  p.w.hq.db.prepare('INSERT INTO bl_invoices (number, year, seq, client, amount_usd, due_date, status, created_at, issued_at, paid_at, lead_id) VALUES (?, 2026, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(`FT-2026-${seq}`, 900 + seq, 'Клиент', o.amount, o.due, o.status, p.t() - DAY, p.t() - DAY, o.paidAt ?? null, o.leadId ?? null);
}

async function seeded() {
  const p = shellWorld();
  await tables(p);
  const t = p.t();
  const db = p.w.hq.db;
  const l1 = p.lead('Анна', { at: t - HOUR });
  p.lead('Борис', { at: t - 2 * HOUR });
  const l3 = p.lead('Вера', { at: t - 3 * DAY });
  p.lead('Глеб', { at: t - 20 * DAY });
  db.prepare("UPDATE li_leads SET stage_override = 'lost' WHERE id = ?").run(l3.id);
  const today = new Date(t).toISOString().slice(0, 10);
  const tomorrow = new Date(t + DAY).toISOString().slice(0, 10);
  invoice(p, { amount: 100, status: 'paid', due: today, paidAt: t - HOUR, leadId: l1.id });
  invoice(p, { amount: 40, status: 'paid', due: today, paidAt: t - 10 * DAY });
  invoice(p, { amount: 50, status: 'issued', due: new Date(t + 5 * DAY).toISOString().slice(0, 10) });
  invoice(p, { amount: 30, status: 'issued', due: '2020-01-01' });
  invoice(p, { amount: 999, status: 'draft', due: tomorrow });
  const ins = db.prepare('INSERT INTO cs_tickets (client_name, contact, text, status, created_at, answered_at) VALUES (?, ?, ?, ?, ?, ?)');
  ins.run('А', '', 'старый', 'open', t - 5 * HOUR, null);
  ins.run('Б', '', 'новый', 'open', t - HOUR, null);
  ins.run('В', '', 'отвечен', 'answered', t - 90 * 60_000, t - 30 * 60_000);
  db.prepare("INSERT INTO pm_projects (client, what, product, status, created_at) VALUES ('К', 'ч', 'site', 'active', ?), ('К', 'ч', 'site', 'done', ?), ('К', 'ч', 'site', 'draft', ?)").run(t, t, t);
  db.prepare("INSERT INTO costs (agent_id, dept, model, usd, at) VALUES ('a', 'marketing', 'm', 1.5, ?), ('a', 'sales', 'm', 0.5, ?)").run(t - HOUR, t - 3 * DAY);
  const ci = db.prepare("INSERT INTO cm_items (type, topic_key, topic_text, status, planned_date, created_at) VALUES ('post', 'k', 'тема', ?, ?, ?)");
  ci.run('proposed', today, t);
  ci.run('ready', today, t);
  ci.run('rejected', today, t);
  const task = p.w.hq.createTask({ title: 'x', dept: 'marketing', creator: 'head' });
  await p.w.hq.requestApproval(task.id, 'marketing-head', 'content_item', { itemId: 1, text: 'x' }, 'Клип');
  const task2 = p.w.hq.createTask({ title: 'y', dept: 'sales', creator: 'head' });
  await p.w.hq.requestApproval(task2.id, 'sales-head', 'kp', { text: 'y' }, 'КП');
  return p;
}

describe('GET /admin/dashboard', () => {
  it('401 without the token, 404 for other paths and methods, 400 for a bad range', async () => {
    const p = shellWorld();
    const s = await serve(p);
    expect((await s.http('GET', '/admin/dashboard', undefined, {})).status).toBe(401);
    expect((await s.http('GET', '/admin/dashboard')).status).toBe(200);
    await s.close();
    expect((await p.call('GET', '/admin/dashboard/x')).status).toBe(404);
    expect((await p.call('POST', '/admin/dashboard', {})).status).toBe(404);
    const bad = await p.call('GET', '/admin/dashboard?range=year');
    expect(bad.status).toBe(400);
    expect(bad.json).toMatchObject({ ok: false, error: 'invalid', fields: ['range'] });
  });

  it('empty database: zeros and nulls, every block in the contract shape, no error', async () => {
    const p = shellWorld();
    await tables(p);
    const r = await p.call('GET', '/admin/dashboard');
    expect(r.status).toBe(200);
    expect(r.json.range).toBe('7d');
    expect(Object.keys(r.json).sort()).toEqual(['agents', 'approvals', 'content', 'from', 'funnel', 'generatedAt', 'leads', 'money', 'ok', 'projects', 'range', 'services', 'tickets', 'to', 'tz']);
    expect(r.json.leads).toMatchObject({ available: true, new: 0, inWork: 0, won: 0, lost: 0, conversion: null });
    expect(r.json.leads.perDay).toHaveLength(8);
    expect(r.json.approvals).toMatchObject({ available: true, waiting: 0, byKind: [], byDept: [] });
    expect(r.json.money).toMatchObject({ available: true, currency: 'USD', paid: 0, pending: 0, overdue: 0, invoices: { paid: 0, pending: 0, overdue: 0 } });
    expect(r.json.money.perWeek).toHaveLength(8);
    expect(r.json.projects).toMatchObject({ available: true, byStage: [], active: 0, closed: 0 });
    expect(r.json.tickets).toEqual({ available: true, open: 0, overdue: 0, answeredToday: 0, avgFirstResponseMin: null });
    expect(r.json.content.queue).toHaveLength(7);
    expect(r.json.content.waitingApproval).toBe(0);
    expect(r.json.agents).toMatchObject({ available: true, spendToday: 0, spendMonth: 0, tasksFailedToday: 0 });
    expect(Array.isArray(r.json.services)).toBe(true);
    expect(r.json.funnel).toEqual([
      { step: 'leads', n: 0 }, { step: 'qualified', n: 0 }, { step: 'proposals', n: 0 }, { step: 'contracts', n: 0 }, { step: 'paid', n: 0 }, { step: 'projects', n: 0 },
    ]);
  });

  it('a database without the tables: every block says available:false, the endpoint still answers', async () => {
    const p = shellWorld();
    const db = p.w.hq.db;
    for (const t of ['li_leads', 'bl_invoices', 'cs_tickets', 'pm_projects', 'cm_items']) db.exec(`DROP TABLE IF EXISTS ${t}`);
    const r = await p.call('GET', '/admin/dashboard?range=30d');
    expect(r.status).toBe(200);
    for (const b of ['leads', 'money', 'projects', 'tickets', 'content']) expect(r.json[b]).toEqual({ available: false });
    expect(r.json.funnel).toEqual({ available: false });
    expect(r.json.agents.available).toBe(true);
  });

  it('a seeded world in each range: shape and numbers', async () => {
    const p = await seeded();
    const t = p.t();
    const d7 = (await p.call('GET', '/admin/dashboard?range=7d')).json;
    expect(d7).toMatchObject({ ok: true, range: '7d', to: new Date(t).toISOString(), from: new Date(t - 7 * DAY).toISOString() });
    expect(d7.leads).toMatchObject({ available: true, new: 3, inWork: 0, won: 1, lost: 1 });
    expect(d7.leads.conversion).toBeCloseTo(1 / 3, 5);
    expect(d7.leads.perDay.reduce((s: number, x: any) => s + x.n, 0)).toBe(3);
    expect(d7.money).toMatchObject({ currency: 'USD', paid: 100, pending: 50, overdue: 30, invoices: { paid: 1, pending: 1, overdue: 1 } });
    expect(d7.money.perWeek.at(-1).week).toMatch(/^\d{4}-W\d{2}$/);
    expect(d7.money.perWeek.reduce((s: number, x: any) => s + x.paid, 0)).toBe(140);
    expect(d7.projects).toMatchObject({ active: 1, closed: 1 });
    expect(d7.projects.byStage).toEqual(expect.arrayContaining([{ stage: 'active', n: 1 }, { stage: 'done', n: 1 }, { stage: 'draft', n: 1 }]));
    expect(d7.tickets).toEqual({ available: true, open: 2, overdue: 1, answeredToday: 1, avgFirstResponseMin: 60 });
    expect(d7.content.waitingApproval).toBe(1);
    expect(d7.content.queue[0]).toMatchObject({ planned: 2, approved: 1, published: 0 });
    expect(d7.agents.spendMonth).toBeCloseTo(2, 5);
    expect(d7.agents.byDept.find((x: any) => x.dept === 'marketing')).toMatchObject({ spendMonth: 1.5 });
    expect(d7.funnel.find((x: any) => x.step === 'leads').n).toBe(3);

    const d30 = (await p.call('GET', '/admin/dashboard?range=30d')).json;
    expect(d30.leads.new).toBe(4);
    expect(d30.money).toMatchObject({ paid: 140, invoices: { paid: 2 } });
    expect(d30.leads.perDay.reduce((s: number, x: any) => s + x.n, 0)).toBe(4);

    const day = (await p.call('GET', '/admin/dashboard?range=today')).json;
    expect(day.range).toBe('today');
    expect(Date.parse(day.from)).toBeLessThanOrEqual(t);
    expect(t - Date.parse(day.from)).toBeLessThan(DAY);
    expect(day.leads.perDay).toHaveLength(1);
    expect(JSON.stringify(d7)).not.toMatch(/Анна|Борис|Клиент|старый/);
  });

  it('converges with the other endpoints: approvals with /admin/review, money with the invoices list', async () => {
    const p = await seeded();
    const dash = (await p.call('GET', '/admin/dashboard?range=30d')).json;
    const review = (await p.call('GET', '/admin/review')).json;
    const total = Object.values(review.counts as Record<string, number>).reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
    expect(dash.approvals.waiting).toBe(total);
    expect(dash.approvals.byKind.reduce((s: number, x: any) => s + x.n, 0)).toBe(total);
    for (const x of dash.approvals.byDept) expect(x.n).toBe(review.counts[x.dept]);
    const inv = async (status: string) => ((await p.call('GET', `/admin/crm/invoices?status=${status}`)).json.items as any[]);
    const today = new Date(p.t()).toISOString().slice(0, 10);
    const sum = (a: any[]) => a.reduce((s, i) => s + i.amountUsd, 0);
    const issued = await inv('issued');
    expect(dash.money.pending).toBe(sum(issued.filter((i) => i.dueDate >= today)));
    expect(dash.money.overdue).toBe(sum(issued.filter((i) => i.dueDate < today)));
    expect(dash.money.paid).toBe(sum((await inv('paid')).filter((i) => i.paidAt !== null && Date.parse(i.paidAt) >= Date.parse(dash.from))));
    const week = (await p.call('GET', '/admin/analytics')).json;
    expect(dash.funnel.find((x: any) => x.step === 'leads').n).toBeGreaterThanOrEqual(week.funnel.leads);
  });

  it('one broken source gives that block available:false and the rest stays', async () => {
    const p = await seeded();
    p.w.hq.db.exec('ALTER TABLE cs_tickets RENAME COLUMN answered_at TO gone');
    const r = await p.call('GET', '/admin/dashboard?range=7d');
    expect(r.status).toBe(200);
    expect(r.json.tickets).toEqual({ available: false });
    expect(r.json.money.paid).toBe(100);
    expect(r.json.leads.new).toBe(3);
    for (const b of BLOCKS.filter((x) => x !== 'tickets')) expect(r.json[b].available).toBe(true);
  });

  it('is cached 30 s per range and refreshes after', async () => {
    const p = await seeded();
    const first = (await p.call('GET', '/admin/dashboard?range=7d')).json;
    invoice(p, { amount: 7, status: 'issued', due: '2020-01-01' });
    p.w.clock.t += 20_000;
    const hit = (await p.call('GET', '/admin/dashboard?range=7d')).json;
    expect(hit.generatedAt).toBe(first.generatedAt);
    expect(hit.money.overdue).toBe(30);
    expect((await p.call('GET', '/admin/dashboard?range=30d')).json.money.overdue).toBe(37);
    p.w.clock.t += 20_000;
    const fresh = (await p.call('GET', '/admin/dashboard?range=7d')).json;
    expect(fresh.generatedAt).not.toBe(first.generatedAt);
    expect(fresh.money.overdue).toBe(37);
  });
});
