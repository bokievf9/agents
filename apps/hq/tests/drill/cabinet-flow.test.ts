/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { PmStore } from '@fir/worker-project-manager';
import { afterEach, describe, expect, it } from 'vitest';
import { dataUrl, makePng } from '../png.js';
import { TOKENS, drillWorld, MEDIA_BASE, type DrillWorld } from './world.js';
import { useGuard } from './guard.js';

/**
 * Cabinet v3 (2026-11-22), the whole flow through the site: a lead gets NO contract; the approved КП goes to the client (cabinet and email), he accepts it, the
 * contract is drafted, approved and goes to him, he signs it with a drawn signature, the invoice of stage 1 is drafted, approved and goes to him with the pay link,
 * the payment makes the project run. Every step once, nothing sent to the client before the owner's approval.
 */
const g = useGuard();
let w: DrillWorld;
afterEach(async () => { await w?.close(); });

const EMAIL = 'anvar.flow@example.com';
const LEAD = { name: 'Anvar Flow', contact: '@anvar_flow', service: 'bots', budget: '$300-500', message: 'Нужно Mini App для салона', locale: 'ru', source: 'miniapp', clientEmail: EMAIL, cabinetId: 'sb-flow', clientName: 'Anvar' };

const review = async (kind: string) => ((await w.adm('GET', '/admin/review?status=pending&limit=200')).json.items as any[]).filter((i) => i.kind === kind);
async function approve(kind: string): Promise<any> {
  await w.director.sendApprovalBatch(false);
  const it = (await review(kind))[0];
  expect(it, `no ${kind} card waits`).toBeDefined();
  const r = await w.adm('POST', `/admin/review/${it.id}`, { action: 'approve' });
  expect(r.status, `${kind}: ${r.text.slice(0, 300)}`).toBe(200);
  expect(r.json.ok, r.text.slice(0, 300)).toBe(true);
  return { ...it, notes: (r.json.notes as string[]) ?? [] };
}
/** The owner's decision the way the Telegram button runs it (the messages the head sends him are not captured, they reach his inbox). */
async function approveByButton(kind: string): Promise<void> {
  await w.director.sendApprovalBatch(false);
  const row = w.queue.pending().find((r) => r.kind === kind);
  expect(row, `no ${kind} card waits`).toBeDefined();
  await w.decide('approve', row!.id);
  expect(w.queue.get(row!.id)!.status).toBe('executed');
}
/** What reached the owner's inbox (the messages the heads send him when a decision runs). */
const inbox = async () => JSON.stringify((await w.adm('GET', '/admin/inbox?limit=200')).json.items);
const docs = async (cid: number) => (await w.adm('GET', `/admin/clients/${cid}/documents`)).json.items as any[];
/** The path of a signed link, for the webhook (the base is a made-up host). */
const mediaPath = (url: string) => url.replace(MEDIA_BASE, '/media');

describe('Cabinet v3: lead -> КП to the client -> accept -> contract -> signature -> invoice -> payment', () => {
  it('the whole flow, each paper sent only after the owner approved it', async () => {
    w = await drillWorld({ flow: true });
    for (const k of w.queue.trustTable()) w.queue.setLevel(k.kind, 0);
    const lead = await w.http('POST', '/lead', LEAD, { 'x-lead-token': TOKENS.lead });
    const { leadId } = (await lead.json()) as any;
    await w.beat();
    await w.beat();
    const cab0 = (await w.adm('GET', `/admin/clients/by-email?email=${encodeURIComponent(EMAIL)}`)).json;
    const cid = cab0.client.id as number;

    // 1. a lead alone: no document of any kind reaches the client, no contract is drafted
    expect(await docs(cid)).toEqual([]);
    expect(w.emails).toEqual([]);
    expect(await review('bo_document')).toEqual([]);

    // 2. the owner approves the КП pack: it IS the sending. The quote waits for the client, the contract and the invoice are NOT drafted
    const pack = await approve('presales_pack');
    expect(pack.kind).toBe("presales_pack");
    expect(w.ownerSaw()).toContain('отправляет КП и смету клиенту в кабинет и на почту');
    await w.cabinet!.docs.idle();
    await w.beat();
    expect(await review('bo_document')).toEqual([]);
    expect(await review('billing_invoice')).toEqual([]);
    let list = await docs(cid);
    const quote = list.find((d) => d.kind === 'quote');
    expect(quote).toMatchObject({ state: 'awaiting_client', leadId, number: expect.stringMatching(/^КП-/), amountUsd: expect.any(Number) });
    expect(quote.deliveredAt).toBeTruthy();
    expect(quote.acceptedAt).toBeNull();
    expect(list.find((d) => d.kind === 'other')).toMatchObject({ title: 'Смета', state: 'issued' });
    expect(list.some((d) => d.kind === 'contract' || d.kind === 'invoice')).toBe(false);
    // the email: one, to the client, a link to the cabinet and no PDF in it
    expect(w.emails).toHaveLength(1);
    expect(w.emails[0]).toMatchObject({ to: EMAIL, subject: 'Ваше коммерческое предложение Fir Tech' });
    expect(w.emails[0]!.text).toContain('https://firtech.pro/ru/cabinet');
    expect(w.emails[0]!.text).not.toMatch(/pdf|media/i);
    // the pdf link: signed, 7 days, and it serves a real PDF
    expect(quote.pdfUrl).toMatch(/^https:\/\/hq\.test\/media\/[0-9a-f]{32}\/cabinet\/c\d+\/quote-\d+\.pdf\?e=\d+$/);
    const exp = Number(/e=(\d+)$/.exec(quote.pdfUrl)![1]);
    expect(exp * 1000 - w.clock.t).toBeGreaterThan(6.9 * 86_400_000);
    expect(exp * 1000 - w.clock.t).toBeLessThan(7.1 * 86_400_000);
    const pdf = await w.http('GET', mediaPath(quote.pdfUrl));
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
    // a link with the expiry moved or cut off is a plain 404
    expect((await w.http('GET', mediaPath(quote.pdfUrl).replace(/e=\d+$/, `e=${exp + 86_400}`))).status).toBe(404);
    expect((await w.http('GET', mediaPath(quote.pdfUrl).replace(/\?e=\d+$/, ''))).status).toBe(404);
    // what he sees: the project is being prepared, the next action is the quote, the lead says the same, the contract of the pack is NOT an event of his
    let cab = (await w.adm('GET', `/admin/clients/by-email?email=${encodeURIComponent(EMAIL)}`)).json;
    // no project before the client says yes (P-10): it is reserved by his acceptance
    expect(cab.projects).toEqual([]);
    expect(cab.leads[0].nextAction).toEqual({ kind: 'accept_quote', docId: quote.id });
    expect(cab.leads[0].stage).toBe('proposal');
    expect(cab.leads[0].timeline.map((e: any) => e.kind)).toContain('kp');
    expect(cab.leads[0].timeline.map((e: any) => e.kind)).not.toContain('contract');
    expect(cab.documents.some((d: any) => d.kind === 'contract')).toBe(false);
    expect(cab.leads[0].replies.some((r: any) => /КП|Коммерческое/.test(r.text))).toBe(true);
    // the lead thread carries it too
    const msgs = (await w.adm('GET', `/admin/clients/${cid}/threads/lead-${leadId}/messages`)).json.items as any[];
    expect(msgs.some((m) => m.from === 'firtech' && /Принять КП/.test(m.text))).toBe(true);

    // 3. the client accepts: once. HQ drafts the contract for the owner
    expect((await w.adm('POST', `/admin/clients/${cid}/documents/${quote.id}/sign`, { signaturePng: dataUrl(makePng({ stroke: true })), name: 'Anvar Karimov', consent: true })).status).toBe(409);
    const acc = await w.adm('POST', `/admin/clients/${cid}/documents/${quote.id}/accept`);
    expect(acc.status, acc.text).toBe(200);
    expect(acc.json).toMatchObject({ ok: true, next: 'contract' });
    expect((await w.adm('POST', `/admin/clients/${cid}/documents/${quote.id}/accept`)).status).toBe(409);
    expect((await w.adm('POST', `/admin/clients/9999/documents/${quote.id}/accept`)).status).toBe(404);
    expect((await w.adm('POST', `/admin/clients/${cid}/documents/99999/accept`)).status).toBe(404);
    expect(w.emails).toHaveLength(1); // nothing new goes to the client before the owner approves the contract
    await w.beat();
    expect(await review('billing_invoice')).toEqual([]);
    const contractCard = (await (async () => { await w.director.sendApprovalBatch(false); return review('bo_document'); })())[0];
    expect(contractCard.summary ?? contractCard.title ?? JSON.stringify(contractCard)).toContain('клиент принял');
    list = await docs(cid);
    expect(list.some((d) => d.kind === 'contract')).toBe(false);
    cab = (await w.adm('GET', `/admin/clients/by-email?email=${encodeURIComponent(EMAIL)}`)).json;
    expect(cab.leads[0].nextStep).toBe('КП принято, готовим договор');
    expect(cab.projects[0]).toMatchObject({ state: 'preparing', documents: expect.arrayContaining([quote.id]) });
    expect(cab.projects[0].nextAction).toEqual({ kind: 'wait' });

    // 4. the owner fills the term (the only blank of the contract) and approves it: it goes to the client, `awaiting_signature`
    const row = w.queue.pending().find((r) => r.kind === 'bo_document')!;
    expect(String(row.payload.text)).toContain('[срок]');
    expect(String(row.payload.text)).toContain('простой электронной подписью');
    expect(await w.queue.applyEdit(row.id, String(row.payload.text).replace('[срок]', '20 рабочих дней'))).toBeTruthy();
    await approveByButton('bo_document');
    expect(await inbox()).toContain('утверждён и отправлен клиенту в кабинет');
    list = await docs(cid);
    const contract = list.find((d) => d.kind === 'contract');
    expect(contract).toMatchObject({ state: 'awaiting_signature', signedAt: null });
    expect(w.emails).toHaveLength(2);
    expect(w.emails[1]!.subject).toContain('Договор');
    cab = (await w.adm('GET', `/admin/clients/by-email?email=${encodeURIComponent(EMAIL)}`)).json;
    expect(cab.projects[0].nextAction).toEqual({ kind: 'sign_contract', docId: contract.id });
    expect(cab.leads[0].timeline.map((e: any) => e.kind)).toEqual(expect.arrayContaining(['kp', 'kp_accepted', 'contract']));
    expect(await review('billing_invoice')).toEqual([]);

    // 5. the signature: bad ones are refused with their codes, a drawn one signs once
    const sign = (b: unknown) => w.adm('POST', `/admin/clients/${cid}/documents/${contract.id}/sign`, b);
    const good = { signaturePng: dataUrl(makePng({ stroke: true })), name: 'Anvar Karimov', consent: true, ip: '203.0.113.7', userAgent: 'Mozilla/5.0 test' };
    expect((await sign({ ...good, consent: false })).status).toBe(400);
    expect((await sign({ ...good, name: 'A' })).status).toBe(400);
    expect((await sign({ ...good, signaturePng: dataUrl(makePng()) })).json).toMatchObject({ ok: false, error: 'bad_signature', reason: 'blank' });
    expect((await sign({ ...good, signaturePng: dataUrl(makePng({ background: 'white' })) })).status).toBe(422);
    expect((await sign({ ...good, signaturePng: 'data:image/png;base64,AAAA' })).status).toBe(422);
    expect((await sign({ ...good, signaturePng: 'data:text/html;base64,PGI+' })).status).toBe(422);
    expect((await sign({ ...good, signaturePng: `data:image/png;base64,${'A'.repeat(210 * 1024)}` })).json.reason).toBe('too_large');
    expect(w.db.prepare('SELECT COUNT(*) n FROM bo_signatures').get()).toEqual({ n: 0 });
    expect((await docs(cid)).find((d) => d.id === contract.id).state).toBe('awaiting_signature');
    const signed = await sign(good);
    expect(signed.status, signed.text).toBe(200);
    expect(signed.json.pdfUrl).toMatch(/\/contract-\d+-signed\.pdf\?e=\d+$/);
    expect((await sign(good)).status).toBe(409);
    const sig = w.db.prepare('SELECT doc_id, name, ip, ua, sha256, length(signature_png) n FROM bo_signatures').get() as any;
    expect(sig).toMatchObject({ doc_id: contract.id, name: 'Anvar Karimov', ip: '203.0.113.7', ua: 'Mozilla/5.0 test' });
    expect(sig.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sig.n).toBeGreaterThan(100);
    const signedPdf = Buffer.from(await (await w.http('GET', mediaPath(signed.json.pdfUrl))).arrayBuffer());
    expect(signedPdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(signedPdf.toString('latin1')).toMatch(/\/Subtype \/Image/); // the drawn signature is in the file
    const unsignedPdf = Buffer.from(await (await w.http('GET', mediaPath(contract.pdfUrl))).arrayBuffer());
    expect(unsignedPdf.toString('latin1')).not.toMatch(/\/Subtype \/Image/);
    list = await docs(cid);
    expect(list.find((d) => d.id === contract.id)).toMatchObject({ state: 'signed', signedAt: expect.any(String) });
    expect((await w.adm('POST', `/admin/clients/${cid}/documents/${quote.id}/sign`, good)).status).toBe(409);

    // 6. the invoice of stage 1 is drafted only now; approved, it goes to the client with the pay link
    expect(w.emails).toHaveLength(2);
    await w.beat();
    await approveByButton('billing_invoice');
    expect(await inbox()).toContain('Счёт утверждён и отправлен клиенту');
    list = await docs(cid);
    const invoice = list.find((d) => d.kind === 'invoice');
    expect(invoice).toMatchObject({ state: 'issued', stageNo: 1, amountUsd: expect.any(Number), payUrl: expect.stringMatching(/^https:\/\/firtech\.pro\/ru\/pay\/FT-/) });
    expect(w.emails).toHaveLength(3);
    expect(w.emails[2]!.subject).toMatch(/^Счёт FT-/);
    cab = (await w.adm('GET', `/admin/clients/by-email?email=${encodeURIComponent(EMAIL)}`)).json;
    expect(cab.projects[0].nextAction).toEqual({ kind: 'pay_stage', stageNo: 1, payUrl: invoice.payUrl, docId: invoice.id });
    expect(cab.projects[0].state).toBe('preparing');
    expect(cab.leads[0].nextAction.kind).toBe('pay_stage');
    // the Пульт shows the same: the project with its state and next action, the invoice with its cabinet document
    const pultProject = (await w.adm('GET', `/admin/crm/projects/${cab.projects[0].id}`)).json.item;
    expect(pultProject).toMatchObject({ state: 'preparing', nextAction: { kind: 'pay_stage', stageNo: 1 }, documents: expect.arrayContaining([quote.id, contract.id, invoice.id]) });
    const pultInv = ((await w.adm('GET', '/admin/crm/invoices')).json.items as any[])[0];
    expect(pultInv.documentId).toBe(invoice.id);

    // 7. paid: the document is paid, the project runs, the stage chain stays intact (the next invoice comes after the acceptance)
    const invRow = w.db.prepare('SELECT id FROM bl_invoices').get() as { id: number };
    const paid = await w.adm('POST', `/admin/crm/invoices/${invRow.id}`, { action: 'mark_paid' });
    expect(paid.status, paid.text).toBe(200);
    expect((await w.adm('POST', `/admin/crm/invoices/${invRow.id}`, { action: 'mark_paid' })).status).toBe(200);
    expect((await docs(cid)).find((d) => d.kind === 'invoice')).toMatchObject({ state: 'paid' });
    cab = (await w.adm('GET', `/admin/clients/by-email?email=${encodeURIComponent(EMAIL)}`)).json;
    expect(cab.projects[0].state).toBe('in_progress');
    expect(cab.projects[0].nextAction).toEqual({ kind: 'wait' });
    expect(cab.leads[0].timeline.map((e: any) => e.kind)).toEqual(expect.arrayContaining(['contract_signed', 'invoice', 'paid']));
    const after = (await w.adm('GET', `/admin/clients/${cid}/threads/lead-${leadId}/messages`)).json.items as any[];
    expect(after.filter((m) => /Оплата по счёту/.test(m.text))).toHaveLength(1);
    await w.beat();
    await approve('pm_spec');
    expect(new PmStore(w.db, w.hq.now).stageMilestone(cab.projects[0].id, 1)?.paidAt).toBeTruthy();
    // P-13: the payment is confirmed by email too (once, a second «mark_paid» changes nothing)
    await w.cabinet!.docs.idle();
    expect(w.emails).toHaveLength(4);
    expect(w.emails[3]!.subject).toMatch(/^Оплата по счёту FT-\S+ получена$/);
    expect(g.rejections).toEqual([]);
    expect(g.errors()).toEqual([]);
    // no name, contact or text of the client in the logs
    expect(g.leaks(['Anvar', 'anvar.flow', '@anvar_flow', 'Karimov', '203.0.113.7'])).toEqual([]);
  }, 180_000);

  it('a lead without a cabinet keeps the older chain (contract and invoice at once, the owner sends them)', async () => {
    w = await drillWorld({ flow: true });
    for (const k of w.queue.trustTable()) w.queue.setLevel(k.kind, 0);
    const lead = await w.http('POST', '/lead', { ...LEAD, clientEmail: undefined, cabinetId: undefined, clientName: undefined, contact: '@plain_lead' }, { 'x-lead-token': TOKENS.lead });
    expect(lead.status).toBe(200);
    await w.beat();
    await w.beat();
    await approve('presales_pack');
    await w.beat();
    await w.director.sendApprovalBatch(false);
    expect((await review('bo_document')).length).toBe(1);
    expect((await review('billing_invoice')).length).toBe(1);
    expect(w.emails).toEqual([]);
  }, 60_000);

  it('the email is optional: without Resend the delivery is a journal line and the cabinet thread, the flow goes on', async () => {
    w = await drillWorld({ flow: true });
    w.emailFail.on = true;
    for (const k of w.queue.trustTable()) w.queue.setLevel(k.kind, 0);
    await w.http('POST', '/lead', LEAD, { 'x-lead-token': TOKENS.lead });
    await w.beat();
    await w.beat();
    await approve('presales_pack');
    await w.cabinet!.docs.idle();
    const cid = ((await w.adm('GET', `/admin/clients/by-email?email=${encodeURIComponent(EMAIL)}`)).json.client.id) as number;
    expect((await docs(cid)).find((d) => d.kind === 'quote')).toMatchObject({ state: 'awaiting_client' });
    expect(w.emails).toEqual([]);
    const j = w.db.prepare("SELECT detail FROM activity WHERE action = 'doc_delivered'").get() as { detail: string };
    expect(j.detail).toMatch(/email_failed/);
  }, 60_000);
});
