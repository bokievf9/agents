/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import type { Tools } from '@fir/core';
import { describe, expect, it } from 'vitest';
import { ensureDocTables } from '../src/cab-docs.js';
import { registerCabinetLead } from '../src/cabinet.js';
import { ClientMail } from '../src/client-mail.js';
import { addWorkdays, deriveJourney, JourneyNotifier, welcomeText, type JourneyInput, type DocLine, type StageIn } from '../src/journey.js';
import { shellWorld } from './shell-helpers.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 24, 8, 0); // Tuesday
const base: JourneyInput = {
  now: NOW, leadCreatedAt: NOW - 60_000, leadStage: 'new', managerRepliedAt: null, quote: null, contract: null, invoice: null, stages: [], projectStatus: null, paidAt: null, paymentsEnabled: false, telegram: false,
};
const doc = (state: string, o: Partial<DocLine> = {}): DocLine => ({ id: 7, state, deliveredAt: NOW - DAY, acceptedAt: null, signedAt: null, createdAt: NOW - DAY, ...o });
const stage = (no: number, state: StageIn['state'], o: Partial<StageIn> = {}): StageIn => ({ stageNo: no, state, title: `Часть ${no}`, dueAt: NOW + 5 * DAY, paidAt: state === 'awaiting_payment' ? null : NOW - 5 * DAY, acceptedAt: state === 'accepted' ? NOW - DAY : null, payUrl: null, ...o });
const j = (o: Partial<JourneyInput>) => deriveJourney({ ...base, ...o });

describe('deriveJourney: one stage for each moment', () => {
  it('received: a fresh lead, first reply in minutes', () => {
    const r = j({});
    expect(r).toMatchObject({ stage: 'received', answersWhere: ['cabinet', 'email'], clientAction: { kind: 'none' } });
    expect(r.etaText?.ru).toContain('5 минут');
    expect(r.since).toBe(new Date(NOW - 60_000).toISOString());
  });
  it('reviewing: the estimate is being checked, ETA one working day', () => {
    const r = j({ leadStage: 'qualified' });
    expect(r).toMatchObject({ stage: 'reviewing' });
    expect(r.etaText).toEqual({ ru: 'До 1 рабочего дня, обычно быстрее', en: 'Within 1 working day, usually faster' });
    expect(j({ managerRepliedAt: NOW - 1000 }).stage).toBe('reviewing');
  });
  it('quote: the client accepts the proposal; a declined one asks to write', () => {
    expect(j({ quote: doc('awaiting_client') }).clientAction).toMatchObject({ kind: 'accept_quote', href: '/cabinet?tab=documents&doc=7' });
    expect(j({ quote: doc('declined') })).toMatchObject({ stage: 'quote', clientAction: { kind: 'answer' } });
  });
  it('contract: accepted proposal, then sign, then waiting for the invoice', () => {
    expect(j({ quote: doc('accepted', { acceptedAt: NOW - 1 }) })).toMatchObject({ stage: 'contract', clientAction: { kind: 'none' } });
    expect(j({ quote: doc('accepted'), contract: doc('awaiting_signature') })).toMatchObject({ stage: 'contract', clientAction: { kind: 'sign' } });
    expect(j({ quote: doc('accepted'), contract: doc('signed', { signedAt: NOW - 5 }) }).nextWeWill.ru).toContain('счёт');
  });
  it('invoice with payments open: pay; with payments closed: the legal entity line, no pay button', () => {
    const inv = { quote: doc('accepted'), contract: doc('signed'), invoice: doc('issued', { id: 9 }) };
    expect(j({ ...inv, paymentsEnabled: true })).toMatchObject({ stage: 'invoice', clientAction: { kind: 'pay', href: '/cabinet?tab=documents&doc=9' } });
    const closed = j({ ...inv, paymentsEnabled: false });
    expect(closed).toMatchObject({ stage: 'invoice', clientAction: { kind: 'none' } });
    expect(closed.nextWeWill.ru).toBe('Счёт на этап 1 выставлен. Оплату откроем после регистрации юрлица, вас уведомим.');
    expect(closed.etaText?.en).toContain('legal entity');
  });
  it('paid, start (date), stages (k of N, accept in 7 days) and done', () => {
    const paidAt = NOW;
    expect(j({ stages: [stage(1, 'in_progress', { paidAt }), stage(2, 'awaiting_payment')], paidAt })).toMatchObject({ stage: 'paid' });
    const startAt = addWorkdays(paidAt, 3);
    const started = j({ stages: [stage(1, 'in_progress', { paidAt }), stage(2, 'awaiting_payment')], projectStatus: 'active', paidAt });
    expect(started).toMatchObject({ stage: 'start', eta: new Date(startAt).toISOString() });
    const later = j({ now: startAt + DAY, stages: [stage(1, 'in_progress', { paidAt }), stage(2, 'awaiting_payment')], projectStatus: 'active', paidAt });
    expect(later).toMatchObject({ stage: 'stages', stageOf: { no: 1, total: 2 } });
    const ready = j({ now: startAt + DAY, stages: [stage(1, 'awaiting_acceptance', { paidAt }), stage(2, 'awaiting_payment')], projectStatus: 'active' });
    expect(ready).toMatchObject({ stage: 'stages', clientAction: { kind: 'accept_stage' }, etaText: { ru: 'Приёмка 7 дней' } });
    const payNext = j({ now: startAt + DAY, stages: [stage(1, 'accepted'), stage(2, 'awaiting_payment', { payUrl: 'https://p/x' })], projectStatus: 'active', paymentsEnabled: true });
    expect(payNext).toMatchObject({ stage: 'stages', stageOf: { no: 2, total: 2 }, clientAction: { kind: 'pay', href: 'https://p/x' } });
    expect(j({ stages: [stage(1, 'accepted'), stage(2, 'accepted')], projectStatus: 'done' }).stage).toBe('done');
  });
  it('lost, and Telegram is an answer channel only when linked', () => {
    expect(j({ leadStage: 'lost' }).stage).toBe('lost');
    expect(j({ telegram: true }).answersWhere).toEqual(['cabinet', 'email', 'telegram']);
  });
  it('working days skip the weekend', () => {
    expect(new Date(addWorkdays(Date.UTC(2026, 10, 27, 10), 3)).toISOString()).toBe('2026-12-02T10:00:00.000Z'); // Fri + 3
  });
});

describe('welcome text', () => {
  it('carries the number, three steps, where the answer comes and the coupon only when there is one; never «основатель»', () => {
    const ru = welcomeText('ru', { number: 12, coupon: 'FIR10', email: 'a@b.c' });
    expect(ru).toContain('Заявка №12');
    expect(ru.match(/^\d\. /gm)).toHaveLength(3);
    expect(ru).toContain('на почту a@b.c');
    expect(ru).toContain('FIR10');
    expect(welcomeText('en', { number: 12 })).not.toContain('coupon');
    expect(ru + welcomeText('en', { number: 1 })).not.toMatch(/основател|founder/i);
  });
});

function setup() {
  const p = shellWorld();
  const db = p.w.hq.db;
  const sent: { to: string; subject: string; text: string }[] = [];
  const tools = { can: () => true, email: { send: (m: any) => { sent.push(m); return Promise.resolve({ ok: true, value: { id: 'x' } }); } } } as unknown as Tools;
  const mail = new ClientMail({ hq: p.w.hq, tools: () => tools, siteUrl: 'https://firtech.pro/' });
  const n = new JourneyNotifier({ hq: p.w.hq, mail, siteUrl: 'https://firtech.pro' });
  ensureDocTables(db);
  const lead = (over: Partial<Parameters<typeof registerCabinetLead>[3]> = {}) => {
    const task = p.w.hq.createTask({ title: 'Лид', dept: 'sales', creator: 'routine', meta: { action: 'lead', lead: { name: 'Алиса' } } });
    return registerCabinetLead(db, () => p.w.clock.t, task.id, { clientEmail: 'alice@example.com', name: 'Алиса', contact: 'alice@example.com', service: 'site', budget: '', message: 'Нужен сайт', estimate: '', locale: 'ru', source: 'site', ...over });
  };
  const addDoc = (leadId: number, clientId: number, kind: string, state: string, extra = '') => db.prepare(
    `INSERT INTO cab_documents (client_id, kind, title, lead_id, state, created_at, delivered_at ${extra ? ', ' + extra.split('=')[0] : ''}) VALUES (?, ?, ?, ?, ?, ?, ? ${extra ? ', ' + extra.split('=')[1] : ''})`,
  ).run(clientId, kind, kind, leadId, state, p.w.clock.t, p.w.clock.t);
  const thread = (leadId: number) => db.prepare('SELECT text FROM cab_messages WHERE lead_id = ? ORDER BY id').all(leadId) as { text: string }[];
  return { p, db, sent, n, lead, addDoc, thread };
}

describe('JourneyNotifier.welcome', () => {
  it('posts Fira once into lead-<id> and emails once; a second call changes nothing', async () => {
    const s = setup();
    const { leadId } = s.lead();
    const a = await s.n.welcome(leadId, { coupon: 'FIR10' });
    expect(a).toEqual({ thread: true, email: 'email' });
    expect(s.thread(leadId)).toHaveLength(1);
    expect(s.thread(leadId)[0]!.text).toContain('FIR10');
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.subject).toBe(`Заявка №${leadId} получена`);
    expect(s.sent[0]!.text).toContain('/ru/cabinet?thread=lead-');
    expect(await s.n.welcome(leadId)).toEqual({ thread: false, email: null });
    expect(s.thread(leadId)).toHaveLength(1);
    expect(s.sent).toHaveLength(1);
  });
  it('English lead gets English text; a lead with no cabinet gets nothing', async () => {
    const s = setup();
    const { leadId } = s.lead({ locale: 'en' });
    await s.n.welcome(leadId);
    expect(s.thread(leadId)[0]!.text).toContain('Request #');
    const task = s.p.w.hq.createTask({ title: 'x', dept: 'sales', creator: 'routine', meta: {} });
    s.db.prepare('INSERT INTO li_leads (task_id, name, contact, service, budget, origin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(task.id, 'Боб', '@bob', '', '', 'site', s.p.w.clock.t);
    const id = (s.db.prepare('SELECT MAX(id) m FROM li_leads').get() as any).m;
    expect(await s.n.welcome(id)).toEqual({ thread: false, email: null });
  });
});

describe('JourneyNotifier.tick: notices once per transition', () => {
  it('the first sight is a silent baseline; moves announced by documents are recorded, not doubled', async () => {
    const s = setup();
    const { leadId, clientId } = s.lead();
    expect(await s.n.tick()).toBe(0);
    s.addDoc(leadId, clientId, 'quote', 'awaiting_client');
    expect(await s.n.tick()).toBe(0);
    expect(s.thread(leadId)).toHaveLength(0);
    expect(s.sent).toHaveLength(0);
    expect(s.db.prepare('SELECT stage, email FROM journey_state WHERE lead_id = ?').get(leadId)).toMatchObject({ stage: 'quote', email: 'document' });
  });
  it('invoice while payments are closed: one thread line and one email, not repeated; opening the switch tells once more', async () => {
    const s = setup();
    const { leadId, clientId } = s.lead();
    await s.n.tick();
    s.addDoc(leadId, clientId, 'quote', 'accepted');
    s.addDoc(leadId, clientId, 'contract', 'signed');
    s.addDoc(leadId, clientId, 'invoice', 'issued');
    expect(await s.n.tick()).toBe(1);
    expect(await s.n.tick()).toBe(0);
    expect(s.thread(leadId).map((m) => m.text).join('\n')).toContain('Оплату откроем после регистрации юрлица');
    expect(s.sent).toHaveLength(1);
    s.p.w.hq.setSetting('payments.enabled', '1');
    expect(await s.n.tick()).toBe(1);
    expect(await s.n.tick()).toBe(0);
    expect(s.sent).toHaveLength(2);
    expect(s.sent[1]!.subject).toBe('Оплата открыта');
  });
});

describe('cabinet payload shape', () => {
  it('lead and project carry journey next to nextStep; the Shell client card adds notified', async () => {
    const s = setup();
    const { leadId } = s.lead();
    const r = (await s.p.call('GET', '/admin/clients/by-email?email=alice@example.com')).json;
    expect(r.leads[0]).toMatchObject({ nextStep: expect.any(String), journey: { stage: 'received', since: expect.any(String), answersWhere: ['cabinet', 'email'], nextWeWill: { ru: expect.any(String), en: expect.any(String) }, clientAction: { kind: 'none' } } });
    const id = (s.db.prepare('SELECT id FROM cab_clients').get() as any).id;
    const card = (await s.p.call('GET', `/admin/crm/clients/${id}`)).json;
    expect(card.leads.find((l: any) => l.id === leadId)).toMatchObject({ journey: { stage: 'received' }, notified: { thread: false, email: null } });
  });
});
