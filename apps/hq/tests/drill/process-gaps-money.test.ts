/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { afterEach, describe, expect, it } from 'vitest';
import { EmailFailures } from '../../src/email-failures.js';
import { dataUrl, makePng } from '../png.js';
import { TOKENS, drillWorld, type DrillWorld } from './world.js';
import { useGuard } from './guard.js';

/**
 * The process gaps of the audit 2026-11-22, package «money and documents» (P-07 … P-15): each `describe` is one gap, driven through the same world as the other
 * drills (the site's routes, the review API, the owner's commands).
 */
const g = useGuard();
let w: DrillWorld;
afterEach(async () => {
  await w?.close();
  expect(g.errors()).toEqual([]);
});

const EMAIL = 'gaps.money@example.com';
const LEAD = { name: 'Gaps Money', contact: '@gaps_money', service: 'bots', budget: '$300-500', message: 'Нужно Mini App для салона', locale: 'ru', source: 'miniapp', clientEmail: EMAIL, cabinetId: 'sb-gaps', clientName: 'Gaps' };

const review = async (kind: string) => ((await w.adm('GET', '/admin/review?status=pending&limit=200')).json.items as any[]).filter((i) => i.kind === kind);
async function approve(kind: string): Promise<any> {
  await w.director.sendApprovalBatch(false);
  const it = (await review(kind))[0];
  expect(it, `no ${kind} card waits`).toBeDefined();
  const r = await w.adm('POST', `/admin/review/${it.id}`, { action: 'approve' });
  expect(r.status, `${kind}: ${r.text.slice(0, 300)}`).toBe(200);
  return it;
}
const docs = async (cid: number) => (await w.adm('GET', `/admin/clients/${cid}/documents`)).json.items as any[];
async function leadWithQuote(o: { emailFail?: boolean } = {}): Promise<{ cid: number; leadId: number }> {
  w = await drillWorld({ flow: true });
  w.emailFail.on = o.emailFail ?? false;
  for (const k of w.queue.trustTable()) w.queue.setLevel(k.kind, 0);
  const res = await w.http('POST', '/lead', LEAD, { 'x-lead-token': TOKENS.lead });
  const { leadId } = (await res.json()) as any;
  await w.beat();
  await w.beat();
  await approve('presales_pack');
  await w.cabinet!.docs.idle();
  const cid = (await w.adm('GET', `/admin/clients/by-email?email=${encodeURIComponent(EMAIL)}`)).json.client.id as number;
  return { cid, leadId };
}

/** The client accepts the quote, the owner fills the term and approves the contract: it waits for the signature. Returns the contract row. */
async function toContract(cid: number): Promise<any> {
  const quote = (await docs(cid)).find((d) => d.kind === 'quote');
  expect((await w.adm('POST', `/admin/clients/${cid}/documents/${quote.id}/accept`)).status).toBe(200);
  await w.beat();
  await w.director.sendApprovalBatch(false);
  const row = w.queue.pending().find((r) => r.kind === 'bo_document')!;
  await w.queue.applyEdit(row.id, String(row.payload.text).replace('[срок]', '20 рабочих дней'));
  await w.director.sendApprovalBatch(false);
  await w.decide('approve', w.queue.pending().find((r) => r.kind === 'bo_document')!.id);
  return (await docs(cid)).find((d) => d.kind === 'contract');
}
const SIGN = { signaturePng: dataUrl(makePng({ stroke: true })), name: 'Gaps Money', consent: true };

describe('P-07: an email to the client that did not go', () => {
  it('marks the document, alerts the owner once an hour, and «Отправить снова» sends it', async () => {
    const { cid } = await leadWithQuote({ emailFail: true });
    const quote = (await docs(cid)).find((d) => d.kind === 'quote');
    // the client still has the paper and the thread line, the Пульт shows the mark
    const problems = (await w.adm('GET', '/admin/crm/cabinet-docs?problem=1')).json.items as any[];
    const mark = problems.find((p) => p.id === quote.id);
    expect(mark).toMatchObject({ kind: 'quote', clientId: cid, mail: { state: 'failed', attempts: 1 }, actions: ['resend'] });
    expect(mark.problems).toContain('email_failed');
    // one alert for the hour, no text or address of the client in it
    const failures = new EmailFailures(w.hq);
    expect(await failures.flush()).toBe(1);
    const alert = w.alerts.find((a) => a.startsWith('Письма клиентам не ушли'));
    expect(alert).toContain('КП КП-');
    expect(alert).not.toContain(EMAIL);
    expect(await failures.flush()).toBe(0);
    // Resend is back: the owner sends it again, the mark is gone, no second line in the thread
    w.emailFail.on = false;
    const r = await w.adm('POST', `/admin/crm/cabinet-docs/${quote.id}`, { action: 'resend' });
    expect(r.status, r.text).toBe(200);
    expect(r.json.mail).toMatchObject({ state: 'sent', attempts: 2 });
    expect(w.emails).toHaveLength(1);
    expect(w.emails[0]).toMatchObject({ to: EMAIL, subject: 'Ваше коммерческое предложение Fir Tech' });
    expect(((await w.adm('GET', '/admin/crm/cabinet-docs?problem=1')).json.items as any[]).some((p) => p.id === quote.id && p.problems.includes('email_failed'))).toBe(false);
    // the estimate has no notice of its own; a bad body is refused
    const est = (await docs(cid)).find((d) => d.kind === 'other');
    expect((await w.adm('POST', `/admin/crm/cabinet-docs/${est.id}`, { action: 'resend' })).status).toBe(409);
    expect((await w.adm('POST', `/admin/crm/cabinet-docs/${quote.id}`, { action: 'nope' })).status).toBe(400);
    expect((await w.adm('POST', '/admin/crm/cabinet-docs/999999', { action: 'resend' })).status).toBe(404);
  }, 60_000);

  it('a failed resend answers 502 and stays marked', async () => {
    const { cid } = await leadWithQuote({ emailFail: true });
    const quote = (await docs(cid)).find((d) => d.kind === 'quote');
    const r = await w.adm('POST', `/admin/crm/cabinet-docs/${quote.id}`, { action: 'resend' });
    expect(r.status).toBe(502);
    expect(r.json.mail).toMatchObject({ state: 'failed', attempts: 2 });
    expect(new EmailFailures(w.hq).summaryLine()).toContain('Писем клиентам не ушло за сутки: 2');
  }, 60_000);
});

describe('P-09: PDFs and notices made in the background survive a restart', () => {
  it('a missing PDF is built on the next read of the documents', async () => {
    const { cid } = await leadWithQuote();
    const quote = (await docs(cid)).find((d) => d.kind === 'quote');
    w.db.prepare('UPDATE cab_documents SET pdf_rel = NULL, pdf_sha256 = NULL WHERE id = ?').run(quote.id);
    const again = (await docs(cid)).find((d) => d.kind === 'quote');
    expect(again.pdfUrl).toMatch(/^https:\/\/hq\.test\/media\//);
    expect((w.db.prepare('SELECT pdf_rel FROM cab_documents WHERE id = ?').get(quote.id) as any).pdf_rel).toBeTruthy();
  }, 60_000);

  it('on start, an approved quote the client never heard of is delivered (PDF, line, email); a failed email is tried again, three emails at most', async () => {
    const { cid } = await leadWithQuote();
    const quote = (await docs(cid)).find((d) => d.kind === 'quote');
    // what a restart between the approval and the background work leaves: the row only
    w.db.prepare('UPDATE cab_documents SET delivered_at = NULL, pdf_rel = NULL, pdf_sha256 = NULL, mail_state = NULL, mail_attempts = 0 WHERE id = ?').run(quote.id);
    w.emails.length = 0;
    expect(await w.cabinet!.docs.recoverDeliveries()).toEqual({ delivered: 1, remailed: 0 });
    const row = w.db.prepare('SELECT delivered_at, pdf_rel, mail_state FROM cab_documents WHERE id = ?').get(quote.id) as any;
    expect(row.delivered_at).toBeTruthy();
    expect(row.pdf_rel).toBeTruthy();
    expect(row.mail_state).toBe('sent');
    expect(w.emails).toHaveLength(1);
    expect(await w.cabinet!.docs.recoverDeliveries()).toEqual({ delivered: 0, remailed: 0 });

    // a failing email: retried on each start until three emails were tried, then left to the owner («Отправить снова»)
    w.emailFail.on = true;
    w.db.prepare("UPDATE cab_documents SET mail_state = 'failed', mail_attempts = 1 WHERE id = ?").run(quote.id);
    expect((await w.cabinet!.docs.recoverDeliveries()).remailed).toBe(1);
    expect((await w.cabinet!.docs.recoverDeliveries()).remailed).toBe(1);
    expect((await w.cabinet!.docs.recoverDeliveries()).remailed).toBe(0);
    expect((w.db.prepare('SELECT mail_attempts FROM cab_documents WHERE id = ?').get(quote.id) as any).mail_attempts).toBe(3);
    w.emailFail.on = false;
    w.db.prepare('UPDATE cab_documents SET mail_attempts = 1 WHERE id = ?').run(quote.id);
    expect((await w.cabinet!.docs.recoverDeliveries()).remailed).toBe(1);
    expect((w.db.prepare('SELECT mail_state FROM cab_documents WHERE id = ?').get(quote.id) as any).mail_state).toBe('sent');
    // one line in the client's thread for the quote, not one per retry
    const lines = (w.db.prepare("SELECT COUNT(*) n FROM cab_messages WHERE text LIKE 'Коммерческое предложение готово%'").get() as any).n;
    expect(lines).toBe(2); // the first sending and the recovered one after the simulated cut (the thread line is what the cut lost)
  }, 60_000);
});

describe('P-12: the signed PDF that did not build', () => {
  it('the owner hears at once; the next read of the documents builds it from the stored signature', async () => {
    const { cid } = await leadWithQuote();
    const contract = await toContract(cid);
    expect(contract).toMatchObject({ state: 'awaiting_signature' });
    const docsApi = w.cabinet!.docs as any;
    const real = docsApi.render.bind(docsApi);
    docsApi.render = (row: any, sign?: unknown) => (sign ? Promise.resolve(null) : real(row, sign));
    const signed = await w.adm('POST', `/admin/clients/${cid}/documents/${contract.id}/sign`, SIGN);
    expect(signed.status, signed.text).toBe(200);
    expect(signed.json.pdfUrl).toBeNull();
    expect(w.alerts.some((a) => a.includes(`Договор ${contract.number} подписан клиентом, но подписанный PDF не собрался`))).toBe(true);
    expect(((await w.adm('GET', '/admin/crm/cabinet-docs?problem=1')).json.items as any[]).find((x) => x.id === contract.id)?.problems).toContain('no_signed_pdf');
    // fonts are back; a read within 10 minutes does not render again, a later one does
    docsApi.render = real;
    expect((await docs(cid)).find((d) => d.id === contract.id).pdfUrl).not.toMatch(/-signed\.pdf/);
    w.clock.t += 11 * 60_000;
    const after = (await docs(cid)).find((d) => d.id === contract.id);
    expect(after.pdfUrl).toMatch(/contract-\d+-signed\.pdf/);
    expect(w.db.prepare("SELECT 1 FROM activity WHERE action = 'signed_pdf_rebuilt'").get()).toBeTruthy();
  }, 60_000);
});
