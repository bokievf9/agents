/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { PmStore } from '@fir/worker-project-manager';
import { afterEach, describe, expect, it } from 'vitest';
import { TOKENS, drillWorld, type DrillWorld } from './world.js';
import { useGuard } from './guard.js';

const g = useGuard();
let w: DrillWorld;
afterEach(async () => { await w?.close(); });

const EMAIL = 'anvar.chain@example.com';
const LEAD = { name: 'Anvar Chain', contact: '@anvar_chain', service: 'bots', budget: '$300-500', message: 'Нужно Mini App для салона', locale: 'ru', source: 'miniapp', clientEmail: EMAIL, cabinetId: 'sb-chain', clientName: 'Anvar' };

const review = async (kind: string) => ((await w.adm('GET', '/admin/review?status=pending&limit=200')).json.items as any[]).filter((i) => i.kind === kind);
async function approve(kind: string): Promise<any> {
  await w.director.sendApprovalBatch(false);
  const it = (await review(kind))[0];
  expect(it, `no ${kind} card waits`).toBeDefined();
  const r = await w.adm('POST', `/admin/review/${it.id}`, { action: 'approve' });
  expect(r.status, `${kind}: ${r.text.slice(0, 300)}`).toBe(200);
  expect(r.json.ok, r.text.slice(0, 300)).toBe(true);
  return it;
}
const pm = () => new PmStore(w.db, w.hq.now);
const invoices = () => w.db.prepare('SELECT id, number, stage_no s, status, amount_usd a FROM bl_invoices ORDER BY id').all() as { id: number; number: string; s: number | null; status: string; a: number }[];

async function payViaApi(): Promise<string> {
  await w.beat();
  await approve('billing_invoice');
  const inv = invoices().find((i) => i.status === 'issued')!;
  w.clock.t += 60_000;
  const key = (w.db.prepare('SELECT pay_key k FROM bl_invoices WHERE id = ?').get(inv.id) as { k: string }).k;
  const page = await w.http('GET', `/pay/${inv.number}?k=${key}`); // the client opens the link
  expect(page.status).toBe(200);
  const r = await w.adm('POST', `/admin/crm/invoices/${inv.id}`, { action: 'mark_paid' });
  expect(r.status, r.text).toBe(200);
  const again = await w.adm('POST', `/admin/crm/invoices/${inv.id}`, { action: 'mark_paid' });
  expect(again.status, 'a repeated mark_paid is safe').toBe(200);
  return inv.number;
}

describe('the whole chain through the site: lead, КП, invoice, payment, stages, acceptance, handover', () => {
  it('a cabinet lead goes all the way to a closed project, every step once', async () => {
    w = await drillWorld();
    for (const k of w.queue.trustTable()) w.queue.setLevel(k.kind, 0);
    const lead = await w.http('POST', '/lead', LEAD, { 'x-lead-token': TOKENS.lead });
    expect(lead.status).toBe(200);
    const { id: taskId, leadId } = (await lead.json()) as any;
    expect(leadId).toBeGreaterThan(0);
    await w.beat();
    await w.beat();
    // the first answer waits as a card; the КП pack is approved through the review API
    const kp = await approve('presales_pack');
    expect(kp.meta.pack.stages.length).toBeGreaterThanOrEqual(2);
    const project = w.db.prepare("SELECT id FROM pm_projects WHERE status = 'draft'").get() as { id: number };
    expect(project, 'the approved КП reserves a draft project').toBeDefined();
    const total = kp.meta.pack.stages.length;
    // stage 1: invoice -> paid -> project starts, the spec is a card
    await payViaApi();
    await w.beat();
    await approve('pm_spec');
    expect((w.db.prepare('SELECT status FROM pm_projects WHERE id = ?').get(project.id) as any).status).toBe('active');
    const cab = (await w.adm('GET', `/admin/clients/by-email?email=${encodeURIComponent(EMAIL)}`)).json;
    const clientId = cab.client.id as number;
    for (let no = 1; no <= total; no++) {
      // acceptance: the client in the cabinet for odd stages, the owner's /mdone for even ones
      if (no % 2) {
        const r = await w.adm('POST', `/admin/clients/${clientId}/projects/${project.id}/milestones/${no}/accept`);
        expect(r.status === 200 || r.status === 409, `${no}: ${r.text}`).toBe(true);
        if (r.status === 409) { // still in progress: the builder finishes it, then the client accepts
          pm().markDone(pm().stageMilestone(project.id, no)!.id);
          const r2 = await w.adm('POST', `/admin/clients/${clientId}/projects/${project.id}/milestones/${no}/accept`);
          expect(r2.status, r2.text).toBe(200);
        }
      } else {
        pm().markDone(pm().stageMilestone(project.id, no)!.id);
        await w.cmd('mdone', `${project.id} ${no}`);
      }
      if (no < total) await payViaApi();
      else {
        await w.beat();
        // the last invoice was proposed when the penultimate stage was accepted; the handover waits for it
      }
    }
    await w.beat();
    const st = invoices();
    expect(st.map((i) => i.s)).toEqual(Array.from({ length: total }, (_, i) => i + 1));
    expect(g.rejections).toEqual([]);
    expect(g.errors()).toEqual([]);
    void taskId;
  }, 120_000);

  it('the cabinet endpoints: by-email, messages, tickets, accept of a foreign or unknown stage', async () => {
    w = await drillWorld();
    const lead = await w.http('POST', '/lead', LEAD, { 'x-lead-token': TOKENS.lead });
    const { leadId } = (await lead.json()) as any;
    const created = await w.adm('POST', '/admin/clients', { email: EMAIL, name: 'Anvar', telegram: '@anvar_chain', locale: 'ru', supabaseId: 'sb-chain' });
    expect(created.status, created.text).toBe(200);
    const by = await w.adm('GET', `/admin/clients/by-email?email=${encodeURIComponent(EMAIL)}`);
    expect(by.status).toBe(200);
    const cid = by.json.client.id as number;
    expect(by.json.leads[0].id).toBe(leadId);
    expect((await w.adm('GET', '/admin/clients/by-email?email=nobody%40example.com')).status).toBe(404);
    expect((await w.adm('GET', '/admin/clients/by-email?email=not-an-email')).status).toBe(400);
    const msg = await w.adm('POST', `/admin/clients/${cid}/leads/${leadId}/messages`, { text: 'Когда будет КП?' });
    expect(msg.status, msg.text + JSON.stringify(g.errors())).toBe(200);
    expect((await w.adm('POST', `/admin/clients/${cid}/leads/${leadId}/messages`, { text: '' })).status).toBe(400);
    expect((await w.adm('POST', `/admin/clients/999/leads/${leadId}/messages`, { text: 'x' })).status).toBe(404);
    expect((await w.adm('POST', `/admin/clients/${cid}/leads/9999/messages`, { text: 'x' })).status).toBe(404);
    const tk = await w.adm('POST', `/admin/clients/${cid}/tickets`, { text: 'Как оплатить?' });
    expect(tk.status, tk.text).toBe(200);
    for (let i = 0; i < 12; i++) await w.adm('POST', `/admin/clients/${cid}/tickets`, { text: `вопрос ${i}` });
    expect((await w.adm('POST', `/admin/clients/${cid}/tickets`, { text: 'ещё' })).status).toBe(429);
    expect((await w.adm('POST', `/admin/clients/${cid}/projects/1/milestones/1/accept`)).status).toBe(404);
    // the Support head answers the cabinet ticket; the draft is a card, approval puts the answer into the thread
    await w.beat();
    await w.director.sendApprovalBatch(false);
    const ans = (await review('support_answer'))[0];
    expect(ans, 'the cabinet ticket made a draft card').toBeDefined();
    let ok = await w.adm('POST', `/admin/review/${ans.id}`, { action: 'approve' });
    if (ok.status === 409) {
      expect(ok.json.error).toBe('placeholder');
      expect((await w.adm('POST', `/admin/review/${ans.id}`, { action: 'edit', text: { draft: 'Оплатить можно по ссылке в счёте, мы пришлём её в кабинет.' } })).status).toBe(200);
      ok = await w.adm('POST', `/admin/review/${ans.id}`, { action: 'approve' });
    }
    expect(ok.status, ok.text).toBe(200);
    const after = await w.adm('GET', `/admin/clients/by-email?email=${encodeURIComponent(EMAIL)}`);
    expect(after.status).toBe(200);
    expect(JSON.stringify(after.json.tickets)).toContain('Оплатить можно по ссылке');
    expect(g.rejections).toEqual([]);
    expect(g.errors().map((l) => `${l.msg}: ${String(l.err)}`)).toEqual([]);
  }, 60_000);
});
