/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { stagesFor } from '@fir/core';
import { BillingStore } from '@fir/worker-billing';
import { PmStore } from '@fir/worker-project-manager';
import { describe, expect, it } from 'vitest';
import { shellWorld } from './shell-helpers.js';

/** Cabinet and Shell views of a project paid by stages, and the client's «Принять этап». */
function setup() {
  let accept: (p: number, n: number) => Promise<any> = () => Promise.resolve({ status: 'unknown', text: '' });
  const p = shellWorld({ admin: { acceptStage: (a, b) => accept(a, b) } });
  accept = (a, b) => Promise.resolve(p.production.acceptStage(a, b, 'client'));
  const db = p.w.hq.db;
  const pm = new PmStore(db, p.t);
  const bs = new BillingStore(db, p.t);
  const stages = stagesFor(1000, ['site']);
  const lead = p.lead('Алиса', { service: 'websites' });
  const project = pm.reserve({ client: 'Алиса', what: 'сайт', product: 'site', leadId: lead.id, packId: 3, stages });
  const reg = async (email: string) => (await p.call('POST', '/admin/clients', { email, name: 'Алиса', supabaseId: 'abc' })).json.client.id as number;
  const invoice = (stageNo: number, status: 'draft' | 'issued' | 'paid') => {
    const inv = bs.addInvoice({ client: 'Алиса', amountUsd: stages[stageNo - 1]!.amountUsd, what: `Этап ${stageNo}`, method: null, dueDate: '2026-12-01', leadId: lead.id, projectId: project.id, stageNo, totalUsd: 1000 }, 2026);
    bs.setStatus(inv.id, status);
    pm.setStageInvoice(pm.stageMilestone(project.id, stageNo)!.id, inv.number);
    if (status === 'paid') pm.markStagePaid(pm.stageMilestone(project.id, stageNo)!.id, inv.number);
    return inv;
  };
  const view = async (email = 'alice@example.com') => (await p.call('GET', `/admin/clients/by-email?email=${email}`)).json;
  return { p, db, pm, bs, lead, project, stages, reg, invoice, view };
}

describe('cabinet: stages of a project', () => {
  it('projects carry milestones[] with stageNo, title, amount, invoice, payUrl (only while issued), paidAt, acceptedAt and state; the lead says what to do next', async () => {
    const s = setup();
    const cid = await s.reg('alice@example.com');
    s.db.prepare('UPDATE li_leads SET client_id = ? WHERE id = ?').run(cid, s.lead.id);
    let v = await s.view();
    expect(v.projects[0].milestones.map((m: any) => [m.stageNo, m.state, m.amountUsd, m.invoiceNumber, m.payUrl])).toEqual([[1, 'awaiting_payment', 300, null, null], [2, 'awaiting_payment', 400, null, null], [3, 'awaiting_payment', 300, null, null]]);
    expect(v.projects[0].milestones[0].title).toBe('Структура и первый экран');
    // a draft invoice shows no link; the issued one does
    const i1 = s.invoice(1, 'draft');
    v = await s.view();
    expect(v.projects[0].milestones[0]).toMatchObject({ invoiceNumber: i1.number, payUrl: null });
    s.bs.setStatus(i1.id, 'issued');
    v = await s.view();
    expect(v.projects[0].milestones[0].payUrl).toMatch(/^https:\/\/firtech\.pro\/ru\/pay\/FT-2026-001\?k=/);
    expect(v.leads[0].nextStep).toBe('Оплатите этап 1 «Структура и первый экран»: $300');
    // paid: running, no link, the stage is in progress
    s.bs.setStatus(i1.id, 'paid');
    s.pm.markStagePaid(s.pm.stageMilestone(s.project.id, 1)!.id, i1.number);
    v = await s.view();
    expect(v.projects[0].milestones[0]).toMatchObject({ state: 'in_progress', payUrl: null, acceptedAt: null });
    expect(v.projects[0].milestones[0].paidAt).toMatch(/^\d{4}-/);
    expect(v.leads[0].nextStep).not.toMatch(/Оплатите|Примите/);
    // finished: accept it
    s.pm.markDone(s.pm.stageMilestone(s.project.id, 1)!.id);
    v = await s.view();
    expect(v.projects[0].milestones[0].state).toBe('awaiting_acceptance');
    expect(v.leads[0].nextStep).toBe('Примите этап 1 «Структура и первый экран»');
    expect(v.invoices[0]).toMatchObject({ stageNo: 1 });
  });

  it('English client: titles and next step in English', async () => {
    const s = setup();
    const cid = await s.reg('alice@example.com');
    await s.p.call('POST', '/admin/clients', { email: 'alice@example.com', supabaseId: 'abc', locale: 'en' });
    s.db.prepare("UPDATE li_leads SET client_id = ?, lang = 'en' WHERE id = ?").run(cid, s.lead.id);
    s.bs.setStatus(s.invoice(1, 'draft').id, 'issued');
    const v = await s.view();
    expect(v.projects[0].milestones[0].title).toBe('Structure and first screen');
    expect(v.leads[0].nextStep).toBe('Pay stage 1 «Structure and first screen»: $300');
  });
});

describe('cabinet: POST /admin/clients/:id/projects/:pid/milestones/:no/accept', () => {
  const url = (cid: number, pid: number, no: number) => `/admin/clients/${cid}/projects/${pid}/milestones/${no}/accept`;

  it('accepts a finished stage once, writes it to the timeline and proposes the next invoice; repeats say already', async () => {
    const s = setup();
    const cid = await s.reg('alice@example.com');
    s.db.prepare('UPDATE li_leads SET client_id = ? WHERE id = ?').run(cid, s.lead.id);
    s.invoice(1, 'paid');
    // still running: 409
    expect((await s.p.call('POST', url(cid, s.project.id, 1))).json).toMatchObject({ ok: false, error: 'not_ready' });
    s.pm.markDone(s.pm.stageMilestone(s.project.id, 1)!.id);
    const r = await s.p.call('POST', url(cid, s.project.id, 1));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, already: false, milestone: { stageNo: 1, state: 'accepted' } });
    expect(r.json.milestone.acceptedAt).toMatch(/^\d{4}-/);
    // the next invoice is proposed (a Support task), once
    const tasks = () => s.p.w.hq.tasks({ dept: 'support', limit: 100 }).filter((t) => t.meta.action === 'kp_invoice' && t.meta.stageNo === 2);
    expect(tasks()).toHaveLength(1);
    expect(tasks()[0]!.meta).toMatchObject({ amountUsd: 400, projectId: s.project.id, stageCount: 3 });
    const again = await s.p.call('POST', url(cid, s.project.id, 1));
    expect(again.json).toMatchObject({ ok: true, already: true });
    expect(tasks()).toHaveLength(1);
    // the timeline of the lead shows the stage steps
    const v = await s.view();
    const titles = v.leads[0].timeline.map((e: any) => e.title);
    expect(titles).toContain('Этап 1 принят');
    expect(titles).toContain('Оплата получена: этап 1');
    // the owner is told
    expect(s.p.w.channel!.list({}).some((i: any) => i.text.includes('принял этап 1'))).toBe(true);
  });

  it('someone else\'s project, an unknown stage or project and an unpaid stage are refused; a bad path is 404', async () => {
    const s = setup();
    const cid = await s.reg('alice@example.com');
    const other = await s.reg('bob@example.com');
    s.db.prepare('UPDATE li_leads SET client_id = ? WHERE id = ?').run(cid, s.lead.id);
    expect((await s.p.call('POST', url(other, s.project.id, 1))).status).toBe(404);
    expect((await s.p.call('POST', url(cid, 999, 1))).status).toBe(404);
    expect((await s.p.call('POST', url(cid, s.project.id, 9))).status).toBe(404);
    expect((await s.p.call('POST', url(999, s.project.id, 1))).status).toBe(404);
    expect((await s.p.call('POST', url(cid, s.project.id, 1))).json).toMatchObject({ ok: false, error: 'not_paid' });
    expect((await s.p.call('GET', url(cid, s.project.id, 1))).status).toBe(404);
  });
});

describe('Shell: invoices and projects expose the stage', () => {
  it('invoice items carry stageNo and stage {no, of, title}; the project detail milestones carry the stage fields', async () => {
    const s = setup();
    s.invoice(2, 'issued');
    const list = (await s.p.call('GET', '/admin/crm/invoices')).json;
    expect(list.items[0]).toMatchObject({ stageNo: 2, stage: { no: 2, of: 3, title: 'Все страницы и наполнение' } });
    const d = (await s.p.call('GET', `/admin/crm/projects/${s.project.id}`)).json;
    expect(d.milestones.map((m: any) => [m.stageNo, m.state, m.amountUsd])).toEqual([[1, 'awaiting_payment', 300], [2, 'awaiting_payment', 400], [3, 'awaiting_payment', 300]]);
    expect(d.milestones[1].payUrl).toMatch(/\/pay\/FT-2026-001\?k=/);
  });
});
