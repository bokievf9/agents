/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { afterEach, describe, expect, it } from 'vitest';
import { PmStore } from '@fir/worker-project-manager';
import { EmailFailures } from '../../src/email-failures.js';
import { longestProduct, productDirections } from '../../src/heads/sales.js';
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
/** The whole way to a running project: contract signed, invoice of stage 1 approved and paid, the ТЗ approved. Returns the project id. */
async function toRunningProject(cid: number): Promise<number> {
  const contract = await toContract(cid);
  expect((await w.adm('POST', `/admin/clients/${cid}/documents/${contract.id}/sign`, SIGN)).status).toBe(200);
  await w.beat();
  await w.director.sendApprovalBatch(false);
  await w.decide('approve', w.queue.pending().find((r) => r.kind === 'billing_invoice')!.id);
  const inv = w.db.prepare('SELECT id FROM bl_invoices ORDER BY id DESC LIMIT 1').get() as { id: number };
  expect((await w.adm('POST', `/admin/crm/invoices/${inv.id}`, { action: 'mark_paid' })).status).toBe(200);
  await w.beat();
  await approve('pm_spec');
  return (w.db.prepare('SELECT id FROM pm_projects ORDER BY id DESC LIMIT 1').get() as { id: number }).id;
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

describe('P-14: the owner marks a stage ready', () => {
  it('/mready and the Пульт `ready_milestone` give the client «Принять этап» like a builder result; unpaid or repeated changes nothing', async () => {
    const { cid } = await leadWithQuote();
    const pid = await toRunningProject(cid);
    const pm = new PmStore(w.db, w.hq.now);
    const stage2 = pm.stageMilestone(pid, 2)!;
    // an unpaid stage cannot be ready
    const unpaid = await w.adm('POST', `/admin/crm/projects/${pid}`, { action: 'ready_milestone', milestoneId: stage2.id });
    expect(unpaid.status).toBe(409);
    expect(unpaid.json.error).toBe('not_paid');
    expect(await w.production.command('mready', `${pid} 2`)).toContain('не оплачен');
    // stage 1 is paid and running: the owner says it is ready
    w.emails.length = 0;
    expect(await w.production.command('mready', `${pid} 1`)).toContain('ждёт приёмки');
    await w.cabinet!.docs.idle();
    expect(pm.stageMilestone(pid, 1)!.status).toBe('done');
    expect(w.emails.map((e) => e.subject)).toEqual(['Этап 1 готов к приёмке']);
    const cab = (await w.adm('GET', `/admin/clients/by-email?email=${encodeURIComponent(EMAIL)}`)).json;
    expect(cab.projects[0].nextAction).toEqual({ kind: 'accept_stage', stageNo: 1 });
    const thread = (await w.adm('GET', `/admin/clients/${cid}/threads/project-${pid}/messages`)).json.items as any[];
    expect(thread.filter((m) => /готов к приёмке/.test(m.text))).toHaveLength(1);
    // a repeat (command or Пульт) sends nothing twice
    expect(await w.production.command('mready', `${pid} 1`)).toContain('уже');
    expect((await w.adm('POST', `/admin/crm/projects/${pid}`, { action: 'ready_milestone', milestoneId: pm.stageMilestone(pid, 1)!.id })).status).toBe(200);
    await w.cabinet!.docs.idle();
    expect(w.emails).toHaveLength(1);
    // the client accepts it: the invoice of stage 2 is proposed
    const acc = await w.adm('POST', `/admin/clients/${cid}/projects/${pid}/milestones/1/accept`);
    expect(acc.status, acc.text).toBe(200);
    expect(pm.stageMilestone(pid, 1)!.acceptedAt).toBeTruthy();
    expect(await w.production.command('mready', 'x')).toContain('Формат: /mready');
  }, 120_000);
});

describe('P-11: the client declines or does not answer the КП', () => {
  it('«Отклонить / обсудить» with a reason: declined, his words in the thread, a Sales task and a line for the owner, no contract', async () => {
    const { cid, leadId } = await leadWithQuote();
    const quote = (await docs(cid)).find((d) => d.kind === 'quote');
    const rej = (b: unknown) => w.adm('POST', `/admin/clients/${cid}/documents/${quote.id}/reject`, b);
    expect((await rej({})).status).toBe(400);
    expect((await rej({ reason: 'x', mode: 'later' })).status).toBe(400);
    expect((await w.adm('POST', `/admin/clients/9999/documents/${quote.id}/reject`, { reason: 'x' })).status).toBe(404);
    const r = await rej({ reason: 'Дорого, хочу без сайта', mode: 'discuss' });
    expect(r.status, r.text).toBe(200);
    expect(r.json).toMatchObject({ ok: true, state: 'declined' });
    expect((await rej({ reason: 'ещё раз' })).status).toBe(409);
    expect((await w.adm('POST', `/admin/clients/${cid}/documents/${quote.id}/accept`)).status).toBe(409);
    expect((await docs(cid)).find((d) => d.id === quote.id).state).toBe('declined');
    const msgs = (await w.adm('GET', `/admin/clients/${cid}/threads/lead-${leadId}/messages`)).json.items as any[];
    expect(msgs.some((m) => m.from === 'client' && /Хочу обсудить КП.*Дорого, хочу без сайта/.test(m.text))).toBe(true);
    const cab = (await w.adm('GET', `/admin/clients/by-email?email=${encodeURIComponent(EMAIL)}`)).json;
    expect(cab.leads[0].nextStep).toBe('Ваш ответ по КП у менеджера: он ответит в сообщениях');
    await w.beat();
    const task = w.hq.tasks({ dept: 'sales', limit: 200 }).find((t) => t.meta.action === 'kp_declined')!;
    expect(task.status).toBe('done');
    expect(w.ownerSaw()).toContain('хочет обсудить КП');
    expect(w.ownerSaw()).toContain(`/kp ${leadId}`);
    await w.director.sendApprovalBatch(false);
    expect(await review('bo_document')).toEqual([]);
    // the client's words never reach the log
    expect(g.leaks(['Дорого, хочу без сайта'])).toEqual([]);
  }, 60_000);

  it('a КП without an answer: the owner hears a day before, then it expires (one line to the client, one alert); a revision revives it', async () => {
    const { cid } = await leadWithQuote();
    const quote = (await docs(cid)).find((d) => d.kind === 'quote');
    const tick = () => w.cabinet!.docs.expiryTick();
    expect(await tick()).toBe(0);
    expect(w.alerts.filter((a) => a.includes('истекает завтра'))).toEqual([]);
    w.clock.t += 13 * 86_400_000 + 3_600_000;
    expect(await tick()).toBe(0);
    expect(await tick()).toBe(0);
    expect(w.alerts.filter((a) => a.includes(`КП ${quote.number}`) && a.includes('истекает завтра'))).toHaveLength(1);
    w.clock.t += 86_400_000;
    expect(await tick()).toBe(1);
    expect(await tick()).toBe(0);
    expect(w.alerts.filter((a) => a.includes(`КП ${quote.number}`) && a.includes('истекло'))).toHaveLength(1);
    expect((await docs(cid)).find((d) => d.id === quote.id).state).toBe('expired');
    expect((await w.adm('POST', `/admin/clients/${cid}/documents/${quote.id}/accept`)).status).toBe(409);
    const cab = (await w.adm('GET', `/admin/clients/by-email?email=${encodeURIComponent(EMAIL)}`)).json;
    expect(cab.leads[0].nextStep).toBe('Срок КП истёк: напишите в сообщениях, обновим предложение');
    // the owner revises it: it stands again for the full term
    const docsApi = w.cabinet!.docs;
    const pack = w.db.prepare("SELECT src_id FROM cab_documents WHERE id = ?").get(quote.id) as { src_id: number };
    expect(docsApi.revisable('ps_quote', pack.src_id)).toBe(true);
    expect(await docsApi.reviseDelivered('ps_quote', pack.src_id, 'Обновлённое КП')).toBe('revised');
    expect((await docs(cid)).find((d) => d.id === quote.id).state).toBe('awaiting_client');
    expect(await tick()).toBe(0);
  }, 60_000);
});

describe('P-10: the project of a cabinet lead is reserved when the client accepts the КП', () => {
  it('approved КП: no project yet; accepted: a draft project with its stages, the contract card names it; a declined КП never makes one', async () => {
    const { cid } = await leadWithQuote();
    const projects = () => new PmStore(w.db, w.hq.now).projects() as any[];
    expect(projects()).toEqual([]);
    expect(((await w.adm('GET', '/admin/crm/projects')).json.items as any[])).toEqual([]);
    const quote = (await docs(cid)).find((d) => d.kind === 'quote');
    expect(quote.projectId).toBeNull();
    expect((await w.adm('POST', `/admin/clients/${cid}/documents/${quote.id}/accept`)).status).toBe(200);
    const [p] = projects();
    expect(p).toMatchObject({ status: 'draft' });
    const pm = new PmStore(w.db, w.hq.now);
    expect(pm.stageMilestones(p.id).length).toBeGreaterThan(1);
    // the stage dates count from the acceptance
    expect(Math.min(...pm.stageMilestones(p.id).map((m) => m.dueAt))).toBeGreaterThan(w.clock.t);
    expect((await docs(cid)).filter((d) => d.kind === 'quote' || d.kind === 'other').every((d) => d.projectId === p.id)).toBe(true);
    const contractTask = w.hq.tasks({ dept: 'backoffice', limit: 50 }).find((t) => t.meta.action === 'doc')!;
    expect(contractTask.meta.projectId).toBe(p.id);
    expect(String(contractTask.meta.chain)).toContain(`проект #${p.id} стартует`);
    expect(String(contractTask.meta.chain)).not.toContain('{project}');
    // the invoice of stage 1 (proposed after the signature) carries the same project
    const quoteMeta = JSON.parse((w.db.prepare('SELECT meta FROM cab_documents WHERE id = ?').get(quote.id) as any).meta);
    expect(quoteMeta.invoice.projectId).toBe(p.id);
    expect(quoteMeta.invoice.chain).toContain(`проект #${p.id}`);
  }, 60_000);

  it('a declined КП leaves no project behind', async () => {
    const { cid } = await leadWithQuote();
    const quote = (await docs(cid)).find((d) => d.kind === 'quote');
    expect((await w.adm('POST', `/admin/clients/${cid}/documents/${quote.id}/reject`, { reason: 'не сейчас' })).status).toBe(200);
    expect(new PmStore(w.db, w.hq.now).projects()).toEqual([]);
  }, 60_000);
});

describe('P-08: a КП of several products', () => {
  const CODE = 'websites.company.telegram-cms-language~bots.booking.payments-broadcasts~x.support-seo~p.site-adminbot-content~k.clinic';
  it('the title of the estimate and every product go to the contract, the invoice and the project; the stage dates follow the longest product', async () => {
    w = await drillWorld({ flow: true });
    for (const k of w.queue.trustTable()) w.queue.setLevel(k.kind, 0);
    const lead = { ...LEAD, clientEmail: undefined, cabinetId: undefined, clientName: undefined, contact: '@bundle_lead', estimate: `Сборка: https://firtech.pro/ru/builder?b=${CODE}` };
    expect((await w.http('POST', '/lead', lead, { 'x-lead-token': TOKENS.lead })).status).toBe(200);
    await w.beat();
    await w.beat();
    const pack = await approve('presales_pack');
    expect(pack).toBeDefined();
    const contract = w.hq.tasks({ dept: 'backoffice', limit: 50 }).find((t) => t.meta.action === 'doc')!;
    const invoice = w.hq.tasks({ dept: 'support', limit: 50 }).find((t) => t.meta.action === 'kp_invoice')!;
    expect(contract.meta.products).toEqual(['Сайт', 'ИИ-администратор']);
    expect(String(contract.meta.what)).toMatch(/^Сайт \+ ИИ-администратор/);
    expect(String(invoice.meta.what)).toMatch(/КП #\d+: Сайт \+ ИИ-администратор$/);
    expect(invoice.meta.products).toEqual(['Сайт', 'ИИ-администратор']);
    const p = new PmStore(w.db, w.hq.now).projects()[0]!;
    expect(p.what).toMatch(/^Сайт \+ ИИ-администратор/);
    // the contract text names the package, not one product
    await w.beat();
    await w.director.sendApprovalBatch(false);
    const card = w.queue.pending().find((r) => r.kind === 'bo_document')!;
    expect(String(card.payload.text)).toContain('Сайт + ИИ-администратор');
  }, 60_000);

  it('longestProduct: an app inside a package sets the term; productDirections keeps an older pack as one direction', () => {
    expect(longestProduct(['bot', 'app', 'site'])).toBe('app');
    expect(longestProduct(['automation', 'bot'])).toBe('bot');
    expect(longestProduct([])).toBe('site');
    expect(productDirections(undefined, 'admin')).toEqual(['admin']);
    expect(productDirections(['site', 'nope', 'site', 'admin'], 'site')).toEqual(['site', 'admin']);
  });
});
