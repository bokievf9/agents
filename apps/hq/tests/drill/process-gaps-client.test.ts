/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { afterEach, describe, expect, it } from 'vitest';
import { PmStore } from '@fir/worker-project-manager';
import { dataUrl, makePng } from '../png.js';
import { TOKENS, drillWorld, type DrillWorld } from './world.js';
import { useGuard } from './guard.js';

/**
 * The process gaps of the audit 2026-11-22, package «the client will notice» (P-02 … P-21 and «демо на ваших данных»): each `describe` is one gap, driven
 * through the same world as the other drills (the site's routes, the review API, the Shell, the due ticker).
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

describe('P-06: the first reply offers the two nearest free windows of the site', () => {
  it('free windows of the site (minus the held ones) go into the first reply; without them the own hours stay', async () => {
    w = await drillWorld({ flow: true });
    w.site.slots = [SLOT_A, Date.UTC(2026, 10, 19, 9, 0), SLOT_B];
    // one window is held by another lead already
    await w.http('POST', '/lead', { ...LEAD, clientEmail: 'other.lead@example.com', cabinetId: 'sb-other', slot: new Date(SLOT_A).toISOString() }, { 'x-lead-token': TOKENS.lead });
    await w.http('POST', '/lead', LEAD, { 'x-lead-token': TOKENS.lead });
    await w.beat();
    await w.beat();
    const lead = w.db.prepare('SELECT id, slots FROM li_leads WHERE chosen_slot IS NULL').get() as { id: number; slots: string };
    expect(JSON.parse(lead.slots)).toEqual([Date.UTC(2026, 10, 19, 9, 0), SLOT_B]);
    const reply = w.db.prepare("SELECT payload FROM approvals WHERE kind = 'lead_reply' AND json_extract(payload, '$.leadId') = ?").get(lead.id) as { payload: string };
    const text = JSON.parse(reply.payload).text as string;
    expect(text).toMatch(/четверг, 19 ноября[^\n]*14:00/);
    expect(text).toMatch(/пятница, 20 ноября[^\n]*14:00/);
    expect(text).not.toMatch(/10:00/);
  }, 60_000);

  it('the site gives fewer than two windows: the own hours of the next working days', async () => {
    w = await drillWorld({ flow: true });
    w.site.slots = [SLOT_B];
    await w.http('POST', '/lead', LEAD, { 'x-lead-token': TOKENS.lead });
    await w.beat();
    const lead = w.db.prepare('SELECT slots FROM li_leads').get() as { slots: string };
    expect(JSON.parse(lead.slots)).toEqual([Date.UTC(2026, 10, 19, 5, 0), Date.UTC(2026, 10, 20, 9, 0)]);
  }, 60_000);
});

describe('P-18: a call set from the Shell books the window on the site and tells the client', () => {
  it('cabinet lead: the site gets the window, the lead thread has the time, an email goes; the same time again changes nothing', async () => {
    const { cid, leadId } = await cabinetLead();
    w.emails.length = 0;
    const r = await w.adm('POST', `/admin/crm/leads/${leadId}/call`, { at: new Date(SLOT_A).toISOString() });
    expect(r.status, r.text).toBe(200);
    expect(r.json).toMatchObject({ item: { callAt: new Date(SLOT_A).toISOString() }, booking: { at: new Date(SLOT_A).toISOString(), state: 'pending', site: 'booked' }, told: ['cabinet', 'email'] });
    expect(w.site.bookings).toEqual([expect.objectContaining({ at: SLOT_A, leadId, source: 'pult', contact: EMAIL })]);
    expect((await leadThread(cid, leadId)).some((t) => /^Созвон назначен: четверг, 19 ноября[^.]*10:00\./.test(t))).toBe(true);
    expect(mails('Созвон с Fir Tech назначен')).toHaveLength(1);
    const again = await w.adm('POST', `/admin/crm/leads/${leadId}/call`, { at: new Date(SLOT_A).toISOString() });
    expect(again.json.told).toEqual([]);
    expect(w.site.bookings).toHaveLength(1);
    // a bad body
    expect((await w.adm('POST', `/admin/crm/leads/${leadId}/call`, { at: 'когда-нибудь' })).status).toBe(400);
    expect((await w.adm('POST', `/admin/crm/leads/${leadId}/call`, { action: 'confirm', extra: 1 })).status).toBe(400);
    expect((await w.adm('POST', '/admin/crm/leads/99999/call', { at: new Date(SLOT_A).toISOString() })).status).toBe(404);
  }, 60_000);

  it('a Telegram lead hears the time in the client bot', async () => {
    w = await drillWorld({ flow: true });
    const taskId = w.sales.createLeadTask({ name: 'Bot Lead', contact: '@bot_lead', service: 'bots', budget: '', message: 'Нужен бот для кафе', estimate: '', locale: 'ru', slot: '', source: 'telegram', chatId: 4242 }, 'bots');
    await w.beat();
    const leadId = (w.db.prepare('SELECT id FROM li_leads WHERE task_id = ?').get(taskId) as { id: number }).id;
    const r = await w.adm('POST', `/admin/crm/leads/${leadId}/call`, { at: new Date(SLOT_B).toISOString() });
    expect(r.json.told).toEqual(['telegram']);
    expect(w.toClient.at(-1)).toMatchObject({ chatId: 4242, text: expect.stringMatching(/^Созвон назначен: пятница, 20 ноября/) });
  }, 60_000);
});

describe('P-19: confirming or moving a call reaches the client by email and the cabinet thread', () => {
  it('confirm, reschedule, cancel: each one line in the thread and one email; without a call 409', async () => {
    const { cid, leadId } = await cabinetLead();
    expect((await w.adm('POST', `/admin/crm/leads/${leadId}/call`, { action: 'confirm' })).status).toBe(409);
    await w.adm('POST', `/admin/crm/leads/${leadId}/call`, { at: new Date(SLOT_A).toISOString() });
    w.emails.length = 0;
    const ok = await w.adm('POST', `/admin/crm/leads/${leadId}/call`, { action: 'confirm' });
    expect(ok.json).toMatchObject({ booking: { state: 'confirmed' }, told: ['cabinet', 'email'] });
    expect(mails('Созвон с Fir Tech подтверждён')).toHaveLength(1);
    expect((await w.adm('POST', `/admin/crm/leads/${leadId}/call`, { action: 'confirm' })).json.told).toEqual([]);
    const moved = await w.adm('POST', `/admin/crm/leads/${leadId}/call`, { action: 'reschedule', at: new Date(SLOT_B).toISOString() });
    expect(moved.json).toMatchObject({ booking: { at: new Date(SLOT_B).toISOString(), state: 'pending', site: 'booked' }, told: ['cabinet', 'email'] });
    expect(mails('Созвон с Fir Tech перенесён')).toHaveLength(1);
    expect(mails('Созвон с Fir Tech перенесён')[0]!.text).toMatch(/пятница, 20 ноября[^)]*\(было четверг, 19 ноября/);
    const thread = await leadThread(cid, leadId);
    expect(thread.filter((t) => /^Созвон (подтверждён|перенесён)/.test(t))).toHaveLength(2);
    expect(leadOf().chosen_slot).toBe(SLOT_B);
    const off = await w.adm('POST', `/admin/crm/leads/${leadId}/call`, { action: 'cancel' });
    expect(off.json).toMatchObject({ booking: null, told: ['cabinet', 'email'] });
    expect(mails('Созвон с Fir Tech отменён')).toHaveLength(1);
  }, 60_000);
});

describe('P-20: reminders a day and an hour before, client and owner, once each', () => {
  it('24 h and 1 h before: thread line, email and an owner inbox line; nothing twice; a call booked within a day gets only the hour one', async () => {
    const { cid, leadId } = await cabinetLead();
    await w.adm('POST', `/admin/crm/leads/${leadId}/call`, { at: new Date(SLOT_B).toISOString() });
    w.emails.length = 0;
    const calls = w.callBook;
    expect(await calls.tick()).toBe(0);
    w.clock.t = SLOT_B - 24 * HOUR + 60_000;
    expect(await calls.tick()).toBe(1);
    expect(await calls.tick()).toBe(0);
    expect(mails('Завтра созвон с Fir Tech')).toHaveLength(1);
    expect((await leadThread(cid, leadId)).some((t) => /^Напоминаем: завтра созвон с Fir Tech, пятница, 20 ноября[^.]*14:00\.$/.test(t))).toBe(true);
    const inbox = () => (w.db.prepare("SELECT text FROM owner_inbox WHERE text LIKE '%созвон: лид%'").all() as { text: string }[]).map((r) => r.text);
    expect(inbox().some((t) => t.startsWith(`Завтра созвон: лид #${leadId}`) && t.includes('время ещё не подтверждено'))).toBe(true);
    w.clock.t = SLOT_B - HOUR + 60_000;
    expect(await calls.tick()).toBe(1);
    expect(await calls.tick()).toBe(0);
    expect(mails('Через час созвон с Fir Tech')).toHaveLength(1);
    expect(inbox().some((t) => t.startsWith(`Через час созвон: лид #${leadId}`))).toBe(true);
    // a call set 3 hours ahead: no day reminder, the hour one only
    w.clock.t = SLOT_B + 2 * HOUR;
    const soon = SLOT_B + 5 * HOUR;
    await w.adm('POST', `/admin/crm/leads/${leadId}/call`, { action: 'reschedule', at: new Date(soon).toISOString() });
    w.emails.length = 0;
    expect(await calls.tick()).toBe(0);
    w.clock.t = soon - HOUR + 1000;
    expect(await calls.tick()).toBe(1);
    expect(w.emails.map((e) => e.subject)).toEqual(['Через час созвон с Fir Tech']);
    expect(g.leaks([EMAIL])).toEqual([]);
  }, 60_000);
});

describe('P-02: HQ is the one channel for a site lead; the site\'s booked window moves into HQ through `slot`', () => {
  it('the webhook answers notified: true; a form lead with a slot is HQ\'s booking (not booked on the site twice), the lead is marked notified', async () => {
    w = await drillWorld({ flow: true });
    const res = await w.http('POST', '/lead', { ...LEAD, slot: new Date(SLOT_A).toISOString() }, { 'x-lead-token': TOKENS.lead });
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ ok: true, id: expect.any(Number), leadId: expect.any(Number), notified: true });
    await w.beat();
    expect(bookingOf(body.leadId)).toMatchObject({ at: SLOT_A, source: 'form', site_state: 'site', state: 'pending' });
    expect(w.site.bookings).toEqual([]);
    expect(w.hq.task(body.id)!.meta.notifiedAt).toEqual(expect.any(Number));
    // the call is HQ's from now on: reminders and the Пульт work on it
    expect((await w.adm('POST', `/admin/crm/leads/${body.leadId}/call`, { action: 'confirm' })).json.booking).toMatchObject({ state: 'confirmed' });
    // a lead without a cabinet answers the same
    const plain = await w.http('POST', '/lead', { name: 'Form', contact: '@form_lead', service: 'site', locale: 'ru' }, { 'x-lead-token': TOKENS.lead });
    expect(await plain.json()).toMatchObject({ ok: true, notified: true });
  }, 60_000);
});

describe('P-21: the handoff of a client\'s agent reaches the agent\'s owner, not Fir Tech\'s support', () => {
  it('a visitor on the client\'s site asks for a person: the agent thread gets his words and contact, the client an email; no ticket, no auto-answer', async () => {
    const { cid, leadId } = await cabinetLead();
    const created = await w.adm('POST', `/admin/clients/${cid}/agents`, { leadId, company: 'Салон Gaps', niche: 'салон' });
    expect(created.status, created.text).toBe(200);
    const agent = created.json.item;
    await w.adm('PATCH', `/admin/clients/${cid}/agents/${agent.id}`, { state: 'live', channels: { siteWidget: 'https://gaps.example' } });
    const conv = 'w-visitor-conv-0001';
    // the visitor left his contact earlier in this conversation (capture_lead)
    w.db.prepare('INSERT INTO pg_leads (agent_id, conv_id, name, contact, note, at) VALUES (?, ?, ?, ?, ?, ?)').run(agent.id, conv, 'Мадина', '+992 93 000 11 22', '', w.hq.now());
    const tickets = () => (w.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'cs_tickets'").get() ? (w.db.prepare('SELECT COUNT(*) n FROM cs_tickets').get() as { n: number }).n : 0);
    const before = tickets();
    w.emails.length = 0;
    // the model is down: no FAQ hit, the agent hands the visitor over
    w.state.down = true;
    const r = await w.http('POST', `/agent/${agent.publicId}/chat`, { conversationId: conv, text: 'Можно поговорить с администратором?' }, { 'x-agent-token': created.json.token, origin: 'https://gaps.example' });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).usedTools).toEqual(['handoff_human']);
    w.state.down = false;
    const line = w.db.prepare("SELECT text, notify FROM cab_tmsgs WHERE thread = ? AND \"from\" = 'agent' ORDER BY id DESC LIMIT 1").get(`agent-${agent.id}`) as { text: string; notify: number };
    expect(line.text).toContain('Посетитель просит человека (нет ответа в базе знаний)');
    expect(line.text).toContain('Его сообщение: «Можно поговорить с администратором?»');
    expect(line.text).toContain('Контакт: Мадина, +992 93 000 11 22.');
    expect(line.notify).toBe(1);
    // nothing in Fir Tech's support: no ticket, no Support task, no line in the support thread
    expect(tickets()).toBe(before);
    expect(w.db.prepare("SELECT COUNT(*) n FROM cab_tmsgs WHERE thread = 'support'").get()).toEqual({ n: 0 });
    await w.beat();
    expect(w.queue.pending().some((p) => p.kind === 'support_answer')).toBe(false);
    // the journal counts it; the owner of Fir Tech gets the fact only; the client gets the email «от вашего агента»
    expect((w.db.prepare("SELECT n FROM pg_journal WHERE agent_id = ? AND kind = 'handoff'").get(agent.id) as { n: number }).n).toBe(1);
    expect(await w.cabinet!.mail!.messageTick()).toBe(1);
    expect(mails('Новое сообщение в кабинете Fir Tech')[0]!.text).toContain('от вашего агента');
    expect(mails('Новое сообщение в кабинете Fir Tech')[0]!.text).not.toContain('Мадина');
    expect(g.leaks(['Мадина', '+992 93 000 11 22', 'Можно поговорить'])).toEqual([]);
  }, 60_000);
});

describe('P-16: after the last stage, a review request and the referral link, once; the owner hears in a week without a review', () => {
  async function closed() {
    const { cid, leadId } = await cabinetLead();
    const project = new PmStore(w.db, w.hq.now).createProject({ client: 'Gaps Client', what: 'Mini App для салона', product: 'app', source: 'sales', taskId: null, leadId, packId: null });
    w.emails.length = 0;
    const last = { stageNo: 2, title: 'Запуск' };
    w.cabinet!.docs.onStageAccepted({ id: project.id, leadId, client: 'Gaps Client', what: 'Mini App', packId: null }, last, null, [{ stageNo: 1, title: 'Старт', amountUsd: 150 }, { stageNo: 2, title: 'Запуск', amountUsd: 150 }]);
    await w.cabinet!.docs.idle();
    return { cid, leadId, pid: project.id, last };
  }
  const projectThread = (cid: number, pid: number) => w.adm('GET', `/admin/clients/${cid}/threads/project-${pid}/messages`).then((r) => (r.json.items as any[]).map((m) => m.text as string));

  it('one line and one email with the form and the ?ref= link; a second acceptance asks nothing; the cabinet form stores one review', async () => {
    const { cid, leadId, pid, last } = await closed();
    const asks = (await projectThread(cid, pid)).filter((t) => t.startsWith('Как вам работа с Fir Tech?'));
    expect(asks).toHaveLength(1);
    expect(asks[0]).toContain(`https://firtech.pro/ru/cabinet?review=${pid}`);
    expect(asks[0]).toMatch(/https:\/\/firtech\.pro\/ru\/\?ref=c[0-9a-z]+/);
    expect(asks[0]).toContain('10% каждого оплаченного им этапа');
    expect(mails('Как вам работа с Fir Tech?')).toHaveLength(1);
    // the slug is the one the cabinet shows
    const slug = (await w.adm('GET', `/admin/clients/by-email?email=${encodeURIComponent(EMAIL)}`)).json.referralSlug;
    expect(asks[0]).toContain(`?ref=${slug}`);
    w.cabinet!.docs.onStageAccepted({ id: pid, leadId, client: 'Gaps Client', what: 'Mini App', packId: null }, last, null, []);
    await w.cabinet!.docs.idle();
    expect(mails('Как вам работа с Fir Tech?')).toHaveLength(1);
    // the review form
    const r = await w.adm('POST', `/admin/clients/${cid}/reviews`, { projectId: pid, rating: 5, text: 'Всё отлично' });
    expect(r.status, r.text).toBe(200);
    expect(r.json.item).toMatchObject({ projectId: pid, rating: 5, text: 'Всё отлично' });
    expect((await w.adm('POST', `/admin/clients/${cid}/reviews`, { projectId: pid, rating: 4 })).status).toBe(409);
    expect((await w.adm('POST', `/admin/clients/${cid}/reviews`, { projectId: pid, rating: 9 })).status).toBe(400);
    expect((await w.adm('POST', `/admin/clients/${cid}/reviews`, { projectId: 999, rating: 5 })).status).toBe(404);
    const list = await w.adm('GET', '/admin/crm/reviews');
    expect(list.json).toMatchObject({ ok: true, available: true, items: [{ projectId: pid, rating: 5, client: 'Gaps' }] });
    // a review given: no nudge a week later
    w.clock.t += 8 * 24 * HOUR;
    expect(w.cabinet!.docs.reviewTick()).toBe(0);
  }, 60_000);

  it('no review in a week: one inbox line for the owner, not twice', async () => {
    await closed();
    w.clock.t += 6 * 24 * HOUR;
    expect(w.cabinet!.docs.reviewTick()).toBe(0);
    w.clock.t += 2 * 24 * HOUR;
    expect(w.cabinet!.docs.reviewTick()).toBe(1);
    expect(w.cabinet!.docs.reviewTick()).toBe(0);
    await w.settle();
    expect((w.db.prepare("SELECT text FROM owner_inbox WHERE text LIKE 'Отзыва по проекту%'").all() as any[])).toHaveLength(1);
  }, 60_000);
});

describe('«демо на ваших данных за 24 часа»: a new lead with a niche gets its draft agent and the demo link at once', () => {
  it('the first reply carries the link; the demo chat answers with the key and without the token; one agent per lead, reused when the КП is accepted', async () => {
    const { cid, leadId } = await cabinetLead();
    const agents = w.db.prepare('SELECT id, client_id, state, public_id FROM pg_agents WHERE lead_id = ?').all(leadId) as any[];
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ client_id: cid, state: 'draft' });
    await w.director.sendApprovalBatch(false);
    const reply = JSON.parse((w.db.prepare("SELECT payload FROM approvals WHERE kind = 'lead_reply'").get() as { payload: string }).payload).text as string;
    const link = new RegExp(`https://firtech\\.pro/ru/demo/${agents[0].public_id}\\?k=([A-Za-z0-9_-]+)`).exec(reply);
    expect(link, reply).not.toBeNull();
    expect(reply).toContain('попробуйте демо агента, собранное по вашей заявке');
    // the cabinet shows it in «Ваш агент» (demo mode)
    expect(((await w.adm('GET', `/admin/clients/${cid}/agents`)).json.items as any[]).map((a) => [a.id, a.mode])).toEqual([[agents[0].id, 'demo']]);
    // the demo chat: the key opens the draft, no token; a wrong key or no key is refused
    const demo = await w.http('POST', `/agent/${agents[0].public_id}/chat`, { demoKey: link![1], text: 'Здравствуйте, вы кто?' });
    expect(demo.status).toBe(200);
    expect(await demo.json()).toMatchObject({ ok: true, mode: 'demo', reply: expect.any(String) });
    expect((await w.http('POST', `/agent/${agents[0].public_id}/chat`, { demoKey: 'x'.repeat(32), text: 'Привет' })).status).toBe(401);
    expect((await w.http('POST', `/agent/${agents[0].public_id}/chat`, { text: 'Привет' })).status).toBe(401);
    // the КП accepted (the sale lists the playground): the same agent, not a new one
    expect(w.cabinet!.playground.autoCreateForLead(cid, leadId)).toEqual({ id: agents[0].id, created: false });
    // the owner's second run of the lead (a rework) gives the same link
    expect(w.cabinet!.playground.draftForLead(leadId)?.url).toBe(link![0]);
    expect(w.db.prepare('SELECT COUNT(*) n FROM pg_agents').get()).toEqual({ n: 1 });
  }, 60_000);

  it('a Telegram lead without a cabinet keeps its demo agent unowned until the account is linked; a lead without a niche gets none', async () => {
    w = await drillWorld({ flow: true });
    const taskId = w.sales.createLeadTask({ name: 'Bot Lead', contact: '@bot_lead', service: 'bots', budget: '', message: 'У меня кафе, нужен бот для заказов', estimate: '', locale: 'ru', slot: '', source: 'telegram', chatId: 4343 }, 'bots');
    await w.beat();
    const lead = w.db.prepare('SELECT id, niche FROM li_leads WHERE task_id = ?').get(taskId) as { id: number; niche: string };
    expect(lead.niche).not.toBe('');
    expect(w.db.prepare('SELECT client_id, state FROM pg_agents WHERE lead_id = ?').get(lead.id)).toEqual({ client_id: 0, state: 'draft' });
    // linked later: the agent goes to the account when the КП is accepted
    const cab = await w.adm('POST', '/admin/clients', { email: 'bot.lead@example.com', name: 'Bot Lead', telegram: '', locale: 'ru', supabaseId: 'sb-bot' });
    const cid = cab.json.client.id as number;
    w.db.prepare('UPDATE li_leads SET client_id = ? WHERE id = ?').run(cid, lead.id);
    expect(w.cabinet!.playground.autoCreateForLead(cid, lead.id)?.created).toBe(false);
    expect(w.db.prepare('SELECT client_id FROM pg_agents WHERE lead_id = ?').get(lead.id)).toEqual({ client_id: cid });
    // no niche: no agent
    const t2 = w.sales.createLeadTask({ name: 'X', contact: '@x_lead_x', service: 'other', budget: '', message: 'хочу узнать', estimate: '', locale: 'ru', slot: '', source: 'telegram', chatId: 4444 }, 'other');
    await w.beat();
    const l2 = w.db.prepare('SELECT id, niche FROM li_leads WHERE task_id = ?').get(t2) as { id: number; niche: string };
    if (!l2.niche) expect(w.db.prepare('SELECT COUNT(*) n FROM pg_agents WHERE lead_id = ?').get(l2.id)).toEqual({ n: 0 });
  }, 60_000);
});
