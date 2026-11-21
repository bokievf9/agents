/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { afterEach, describe, expect, it } from 'vitest';
import { dataUrl, makePng } from '../png.js';
import { TOKENS, drillWorld, type DrillWorld } from './world.js';
import { useGuard } from './guard.js';

/**
 * The process gaps of the audit 2026-11-22, package «the client will notice» (P-02 … P-21 and «демо на ваших данных»): each `describe` is one gap, driven
 * through the same world as the other drills (the site's routes, the review API, the Пульт, the due ticker).
 */
const g = useGuard();
let w: DrillWorld;
afterEach(async () => {
  await w?.close();
  expect(g.errors()).toEqual([]);
});

const HOUR = 3_600_000;
const EMAIL = 'gaps.client@example.com';
const LEAD = { name: 'Gaps Client', contact: '@gaps_client', service: 'bots', budget: '$300-500', message: 'Нужно Mini App для салона', locale: 'ru', source: 'miniapp', clientEmail: EMAIL, cabinetId: 'sb-gaps-c', clientName: 'Gaps' };
const SIGN = { signaturePng: dataUrl(makePng({ stroke: true })), name: 'Gaps Client', consent: true };

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
const clientId = async () => (await w.adm('GET', `/admin/clients/by-email?email=${encodeURIComponent(EMAIL)}`)).json.client.id as number;
const mails = (subject: string) => w.emails.filter((e) => e.subject === subject);

/** A cabinet lead whose first reply is out (levels 0: every card waits for the owner). */
async function cabinetLead(): Promise<{ cid: number; leadId: number }> {
  w = await drillWorld({ flow: true });
  for (const k of w.queue.trustTable()) w.queue.setLevel(k.kind, 0);
  const res = await w.http('POST', '/lead', LEAD, { 'x-lead-token': TOKENS.lead });
  const { leadId } = (await res.json()) as any;
  await w.beat();
  await w.beat();
  return { cid: await clientId(), leadId };
}

/** The whole way to a paid stage 1: КП approved and accepted, contract approved and signed, invoice approved and paid. */
async function paidStageOne(cid: number): Promise<void> {
  await approve('presales_pack');
  await w.cabinet!.docs.idle();
  const quote = (await docs(cid)).find((d) => d.kind === 'quote');
  expect((await w.adm('POST', `/admin/clients/${cid}/documents/${quote.id}/accept`)).status).toBe(200);
  await w.beat();
  await w.director.sendApprovalBatch(false);
  const row = w.queue.pending().find((r) => r.kind === 'bo_document')!;
  await w.queue.applyEdit(row.id, String(row.payload.text).replace('[срок]', '20 рабочих дней'));
  await w.director.sendApprovalBatch(false);
  await w.decide('approve', w.queue.pending().find((r) => r.kind === 'bo_document')!.id);
  const contract = (await docs(cid)).find((d) => d.kind === 'contract');
  expect((await w.adm('POST', `/admin/clients/${cid}/documents/${contract.id}/sign`, SIGN)).status).toBe(200);
  await w.beat();
  await w.director.sendApprovalBatch(false);
  await w.decide('approve', w.queue.pending().find((r) => r.kind === 'billing_invoice')!.id);
  const inv = w.db.prepare('SELECT id FROM bl_invoices ORDER BY id DESC LIMIT 1').get() as { id: number };
  expect((await w.adm('POST', `/admin/crm/invoices/${inv.id}`, { action: 'mark_paid' })).status).toBe(200);
  await w.cabinet!.docs.idle();
}

describe('P-13: the client hears about a new message and a payment by email', () => {
  it('one email «новое сообщение» per thread an hour, none when the thread was read, never the text itself', async () => {
    const { cid, leadId } = await cabinetLead();
    const SUBJECT = 'Новое сообщение в кабинете Fir Tech';
    const mail = w.cabinet!.mail!;
    w.emails.length = 0;
    expect((await w.adm('POST', `/admin/crm/leads/${leadId}/reply`, { text: 'Секретный ответ про ваш салон' })).status).toBe(200);
    expect(await mail.messageTick()).toBe(1);
    expect(mails(SUBJECT)).toHaveLength(1);
    expect(mails(SUBJECT)[0]).toMatchObject({ to: EMAIL });
    expect(mails(SUBJECT)[0]!.text).toContain(`/ru/cabinet?thread=lead-${leadId}`);
    expect(mails(SUBJECT)[0]!.text).not.toContain('Секретный ответ');
    // a second answer within the hour waits; after the hour it gets its email
    await w.adm('POST', `/admin/crm/leads/${leadId}/reply`, { text: 'Ещё одно уточнение' });
    expect(await mail.messageTick()).toBe(0);
    w.clock.t += HOUR + 1000;
    expect(await mail.messageTick()).toBe(1);
    expect(mails(SUBJECT)).toHaveLength(2);
    // the client read the thread before the tick: no email
    w.clock.t += HOUR + 1000;
    await w.adm('POST', `/admin/crm/leads/${leadId}/reply`, { text: 'Третий ответ' });
    expect((await w.adm('POST', `/admin/clients/${cid}/threads/lead-${leadId}/read`)).status).toBe(200);
    expect(await mail.messageTick()).toBe(0);
    expect(mails(SUBJECT)).toHaveLength(2);
    // nothing is left to send
    w.clock.t += HOUR + 1000;
    expect(await mail.messageTick()).toBe(0);
  }, 60_000);

  it('an approved Support answer in the support thread is mailed; a failed email is in the owner\'s hourly alert', async () => {
    const { cid } = await cabinetLead();
    w.emails.length = 0;
    expect((await w.adm('POST', `/admin/clients/${cid}/threads/support/messages`, { text: 'Как поменять логотип в боте?' })).status).toBe(200);
    await w.settle();
    await w.beat();
    await w.director.sendApprovalBatch(false);
    const row = w.queue.pending().find((r) => r.kind === 'support_answer')!;
    await w.queue.applyEdit(row.id, 'Здравствуйте! Логотип меняется в настройках, пришлём инструкцию.');
    await w.director.sendApprovalBatch(false);
    await w.decide('approve', w.queue.pending().find((r) => r.kind === 'support_answer')!.id);
    expect(w.db.prepare("SELECT notify FROM cab_tmsgs WHERE thread = 'support' AND \"from\" = 'manager'").get()).toEqual({ notify: 1 });
    w.emailFail.on = true;
    expect(await w.cabinet!.mail!.messageTick()).toBe(0);
    expect(w.db.prepare("SELECT COUNT(*) n FROM email_failures WHERE kind = 'message'").get()).toEqual({ n: 1 });
    // the failed one is not tried on every tick
    w.emailFail.on = false;
    w.clock.t += HOUR + 1000;
    expect(await w.cabinet!.mail!.messageTick()).toBe(0);
  }, 60_000);

  it('a payment is confirmed by email at once', async () => {
    const { cid } = await cabinetLead();
    await paidStageOne(cid);
    const inv = w.db.prepare('SELECT number FROM bl_invoices ORDER BY id DESC LIMIT 1').get() as { number: string };
    expect(mails(`Оплата по счёту ${inv.number} получена`)).toHaveLength(1);
    expect(mails(`Оплата по счёту ${inv.number} получена`)[0]).toMatchObject({ to: EMAIL });
  }, 60_000);
});
