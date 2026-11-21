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

/** Two windows of the site: Thursday 10:00 and Friday 14:00, Dushanbe (UTC+5). */
const SLOT_A = Date.UTC(2026, 10, 19, 5, 0);
const SLOT_B = Date.UTC(2026, 10, 20, 9, 0);
const chat = (sessionId: string, text: string, extra: Record<string, unknown> = {}) =>
  w.http('POST', '/chat', { sessionId, locale: 'ru', text, ...extra }, { 'x-chat-token': TOKENS.chat }).then((r) => r.json() as Promise<any>);

describe('P-03: the website chat never asks an anonymous visitor for a contact; the picked window is kept and travels into the lead', () => {
  it('anonymous: the call offer and the hand-off point to the sign-in; «1» keeps the window; signed in, «да» makes the lead with it', async () => {
    w = await drillWorld({ flow: true });
    w.site.slots = [SLOT_A, SLOT_B];
    const sid = 'anon-session-0001';
    const offer = await chat(sid, 'давайте созвонимся');
    expect(offer.cta).toContain('call');
    expect(offer.reply).toMatch(/ближайшие окна для созвона: четверг, 19 ноября[^;]*10:00; пятница, 20 ноября[^.]*14:00/);
    expect(offer.reply).toContain('Напишите номер окна (1 или 2)');
    expect(offer.reply).toContain('https://firtech.pro/ru/cabinet/login');
    expect(offer.reply).not.toMatch(/оставьте контакт|@username/i);
    // the visitor picks the first window: kept in the session, no lead (the site would not take it), the way to the sign-in
    const pick = await chat(sid, '1');
    expect(pick.reply).toMatch(/^Хорошо, четверг, 19 ноября[^.]*10:00\. Чтобы закрепить это время, войдите в кабинет: https:\/\/firtech\.pro\/ru\/cabinet\/login/);
    expect(pick.leadCreated).toBeUndefined();
    expect(w.db.prepare("SELECT COUNT(*) n FROM tasks WHERE json_extract(meta, '$.action') = 'lead'").get()).toEqual({ n: 0 });
    // a person asked for: no contact asked, the sign-in instead
    const person = await chat('anon-session-0002', 'позовите живого менеджера');
    expect(person.handoff).toBe(true);
    expect(person.reply).toContain('войдите в кабинет (https://firtech.pro/ru/cabinet/login)');
    expect(person.reply).not.toMatch(/оставьте контакт/i);
    // back signed in, the same session: «да» makes the lead with the window
    const yes = await chat(sid, 'да', { clientEmail: EMAIL, cabinetId: 'sb-gaps-c', clientName: 'Gaps' });
    expect(yes.leadCreated).toBe(true);
    expect(yes.reply).toMatch(/^Записал созвон: четверг, 19 ноября[^.]*10:00\./);
    const task = w.db.prepare("SELECT meta FROM tasks WHERE json_extract(meta, '$.action') = 'lead'").get() as { meta: string };
    expect(JSON.parse(task.meta).lead).toMatchObject({ slot: new Date(SLOT_A).toISOString(), clientEmail: EMAIL, sessionId: sid });
    await w.beat();
    expect(w.db.prepare('SELECT chosen_slot FROM li_leads').get()).toEqual({ chosen_slot: SLOT_A });
    // a second «да» makes nothing more
    await chat(sid, 'да', { clientEmail: EMAIL });
    expect(w.db.prepare("SELECT COUNT(*) n FROM tasks WHERE json_extract(meta, '$.action') = 'lead'").get()).toEqual({ n: 1 });
    expect(g.leaks([EMAIL])).toEqual([]);
  }, 60_000);

  it('a signed-in visitor picks a window by weekday and hour: the lead is made at once', async () => {
    w = await drillWorld({ flow: true });
    w.site.slots = [SLOT_A, SLOT_B];
    const sid = 'signed-session-01';
    const who = { clientEmail: EMAIL, cabinetId: 'sb-gaps-c', clientName: 'Gaps' };
    const offer = await chat(sid, 'давайте созвонимся', who);
    expect(offer.reply).toContain('Напишите номер окна (1 или 2), и я запишу.');
    expect(offer.reply).not.toContain('cabinet/login');
    const pick = await chat(sid, 'давайте в пятницу в 14', who);
    expect(pick.leadCreated).toBe(true);
    expect(pick.reply).toMatch(/^Записал созвон: пятница, 20 ноября[^.]*14:00\./);
    const task = w.db.prepare("SELECT meta FROM tasks WHERE json_extract(meta, '$.action') = 'lead'").get() as { meta: string };
    expect(JSON.parse(task.meta).lead.slot).toBe(new Date(SLOT_B).toISOString());
  }, 60_000);
});

const leadOf = () => w.db.prepare('SELECT id, chosen_slot FROM li_leads ORDER BY id DESC LIMIT 1').get() as { id: number; chosen_slot: number | null };
const bookingOf = (leadId: number) => w.db.prepare("SELECT * FROM call_bookings WHERE lead_id = ? AND state != 'cancelled'").get(leadId) as any;
const leadThread = async (cid: number, leadId: number) => ((await w.adm('GET', `/admin/clients/${cid}/threads/lead-${leadId}/messages`)).json.items as any[]).map((m) => m.text as string);

describe('P-04: a lead from the website chat with a picked window books it on the site', () => {
  async function chatLead(answer: 'booked' | 'not_accepted' | 'taken' | 'failed') {
    w = await drillWorld({ flow: true });
    w.site.slots = [SLOT_A, SLOT_B];
    w.site.answer = answer;
    const who = { clientEmail: EMAIL, cabinetId: 'sb-gaps-c', clientName: 'Gaps' };
    await chat('book-session-0001', 'давайте созвонимся', who);
    expect((await chat('book-session-0001', '2', who)).leadCreated).toBe(true);
    await w.beat();
    await w.beat();
    return leadOf();
  }

  it('the site takes it: one booking, chosen_slot filled, the window is not offered again', async () => {
    const lead = await chatLead('booked');
    expect(lead.chosen_slot).toBe(SLOT_B);
    expect(w.site.bookings).toEqual([{ at: SLOT_B, leadId: lead.id, name: 'Gaps', contact: EMAIL, locale: 'ru', source: 'chat' }]);
    expect(bookingOf(lead.id)).toMatchObject({ at: SLOT_B, state: 'pending', source: 'chat', site_state: 'booked' });
    expect(w.hq.tasks({ dept: 'sales', limit: 100 }).some((t) => t.meta.action === 'call_confirm')).toBe(false);
    // the next visitor is not offered the held window
    const other = await chat('book-session-0002', 'давайте созвонимся');
    expect(other.reply).toMatch(/ближайшие окна для созвона: четверг, 19 ноября[^.]*10:00\./);
    expect(other.reply).not.toContain('20 ноября');
    // a heartbeat more books nothing twice
    await w.beat();
    expect(w.site.bookings).toHaveLength(1);
  }, 60_000);

  it('the site does not take it: the window still rides in the lead and the owner gets «подтвердить созвон»', async () => {
    const lead = await chatLead('not_accepted');
    expect(lead.chosen_slot).toBe(SLOT_B);
    expect(bookingOf(lead.id)).toMatchObject({ site_state: 'not_accepted' });
    await w.beat();
    const task = w.hq.tasks({ dept: 'sales', limit: 100 }).find((t) => t.meta.action === 'call_confirm')!;
    expect(task).toBeDefined();
    expect(task.status).toBe('done');
    expect(w.ownerSaw()).toMatch(new RegExp(`Созвон с лидом #${lead.id}: пятница, 20 ноября[^.]*14:00 \\(Asia/Dushanbe\\), сайт не принял бронь\\. Подтвердите время клиенту`));
  }, 60_000);
});

