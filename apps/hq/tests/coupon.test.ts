/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import type { Tools } from '@fir/core';
import { describe, expect, it } from 'vitest';
import { CabDocs } from '../src/cab-docs.js';
import { registerCabinetLead } from '../src/cabinet.js';
import { ClientMail } from '../src/client-mail.js';
import { couponPercent, Coupons } from '../src/coupon.js';
import { shellWorld } from './shell-helpers.js';

const DAY = 86_400_000;

function setup() {
  const p = shellWorld();
  const db = p.w.hq.db;
  const sent: { to: string; subject: string; text: string }[] = [];
  const tools = { can: () => true, email: { send: (m: any) => { sent.push(m); return Promise.resolve({ ok: true, value: { id: 'x' } }); } } } as unknown as Tools;
  const mail = new ClientMail({ hq: p.w.hq, tools: () => tools, siteUrl: 'https://firtech.pro' });
  const coupons = new Coupons(db, p.t, () => couponPercent(p.w.hq));
  const reg = async (email = 'alice@example.com', extra: Record<string, unknown> = {}) => (await p.call('POST', '/admin/clients', { email, name: 'Алиса', supabaseId: 'abc', ...extra })).json;
  const payload = async (email = 'alice@example.com') => (await p.call('GET', `/admin/clients/by-email?email=${email}`)).json;
  /** An account made `ageDays` ago straight in the table (no coupon issued: the lazy path and the old accounts). */
  const oldClient = (email: string, ageDays: number) => Number(db.prepare('INSERT INTO cab_clients (email, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(email, 'Боб', p.t() - ageDays * DAY, p.t() - ageDays * DAY).lastInsertRowid);
  return { p, db, sent, mail, coupons, reg, payload, oldClient };
}

describe('the coupon is issued with the account and expires 30 days after it', () => {
  it('registration issues cabinet10 with the default percent; the payload has the contract shape', async () => {
    const s = setup();
    const r = await s.reg();
    expect(r.coupon).toEqual({ code: 'cabinet10', percent: 10, expiresAt: new Date(s.p.t() + 30 * DAY).toISOString(), used: false });
    const v = await s.payload();
    expect(v.coupon).toEqual(r.coupon);
    expect(v.coupon).not.toHaveProperty('usedAt');
    // one coupon per account: a repeated registration changes nothing
    expect((await s.reg()).coupon).toEqual(r.coupon);
    expect(s.db.prepare('SELECT COUNT(*) n FROM client_coupons').get()).toEqual({ n: 1 });
  });

  it('the percent comes from settings.coupon.percent for accounts made after the change; a bad value falls back to 10', async () => {
    const s = setup();
    s.p.w.hq.setSetting('coupon.percent', '15');
    expect((await s.reg('a@example.com')).coupon.percent).toBe(15);
    s.p.w.hq.setSetting('coupon.percent', 'abc');
    expect((await s.reg('b@example.com')).coupon.percent).toBe(10);
    s.p.w.hq.setSetting('coupon.percent', '99');
    expect(couponPercent(s.p.w.hq)).toBe(10);
  });

  it('an account without a coupon gets one on the first read while it is younger than 30 days, with the term from its creation; an older account gets null', async () => {
    const s = setup();
    s.oldClient('young@example.com', 5);
    s.oldClient('old@example.com', 40);
    const young = await s.payload('young@example.com');
    expect(young.coupon).toMatchObject({ code: 'cabinet10', used: false, expiresAt: new Date(s.p.t() + 25 * DAY).toISOString() });
    expect((await s.payload('old@example.com')).coupon).toBeNull();
    expect(s.db.prepare('SELECT COUNT(*) n FROM client_coupons').get()).toEqual({ n: 1 });
  });

  it('after the term the coupon is still shown with its past expiresAt but cannot be claimed', async () => {
    const s = setup();
    const id = (await s.reg()).client.id as number;
    const task = s.p.w.hq.createTask({ title: 'Лид', dept: 'sales', creator: 'routine', meta: { action: 'lead', lead: {} } });
    const lead = registerCabinetLead(s.db, s.p.t, task.id, { clientEmail: 'alice@example.com', name: 'Алиса', contact: 'a@example.com', service: 'site', budget: '', message: 'x', estimate: '', locale: 'ru', source: 'site' });
    s.p.w.clock.t += 31 * DAY;
    const v = await s.payload();
    expect(v.coupon.used).toBe(false);
    expect(Date.parse(v.coupon.expiresAt)).toBeLessThan(s.p.t());
    expect(s.coupons.claim(id, lead.leadId)).toBe(false);
    expect(s.coupons.forLead(lead.leadId)).toBeNull();
  });

  it('a lead of a new cabinet client (registerCabinetLead) issues the coupon too', () => {
    const s = setup();
    const task = s.p.w.hq.createTask({ title: 'Лид', dept: 'sales', creator: 'routine', meta: { action: 'lead', lead: {} } });
    const r = registerCabinetLead(s.db, s.p.t, task.id, { clientEmail: 'new@example.com', name: 'Н', contact: 'n@example.com', service: 'site', budget: '', message: 'x', estimate: '', locale: 'ru', source: 'site', couponPercent: 12 });
    expect(s.coupons.view(r.clientId)).toMatchObject({ code: 'cabinet10', percent: 12, used: false });
  });
});

describe('claim, quote and acceptance', () => {
  function quoteWorld(withCoupon: boolean) {
    const s = setup();
    const docs = new CabDocs({ hq: s.p.w.hq, now: s.p.t, tools: () => ({ can: () => false }) as unknown as Tools, billing: s.p.billing, siteUrl: 'https://firtech.pro', notifyOwner: () => undefined, mail: s.mail });
    const task = s.p.w.hq.createTask({ title: 'Лид', dept: 'sales', creator: 'routine', meta: { action: 'lead', lead: {} } });
    const r = registerCabinetLead(s.db, s.p.t, task.id, { clientEmail: 'alice@example.com', name: 'Алиса', contact: 'alice@example.com', service: 'site', budget: '', message: 'x', estimate: '', locale: 'ru', source: 'site' });
    const claimed = s.coupons.claim(r.clientId, r.leadId);
    const q = docs.onQuoteApproved({
      clientId: r.clientId, leadId: r.leadId, projectId: null, packId: 7, client: 'Алиса', totalUsd: 135, kpText: '# КП', estimateText: '# Смета', contractMeta: {}, invoiceMeta: {},
      ...(withCoupon ? { coupon: true } : {}),
    });
    return { ...s, docs, ...r, claimed, q };
  }

  it('the lead claims a valid unused coupon; the quote of THAT lead sees it; another lead does not', () => {
    const w = quoteWorld(true);
    expect(w.claimed).toBe(true);
    expect(w.coupons.forLead(w.leadId)).toBe(10);
    expect(w.coupons.forLead(w.leadId + 1)).toBeNull();
  });

  it('accepting the quote that carried the coupon marks it used with the lead; the payload says used and usedAt; it is not offered again', async () => {
    const w = quoteWorld(true);
    expect(w.docs.accept(w.clientId, w.q.quoteId)).toMatchObject({ status: 200 });
    await w.docs.idle();
    const v = (await w.payload()).coupon;
    expect(v).toMatchObject({ used: true, usedAt: new Date(w.p.t()).toISOString() });
    expect(w.db.prepare('SELECT lead_id FROM client_coupons WHERE client_id = ?').get(w.clientId)).toEqual({ lead_id: w.leadId });
    expect(w.coupons.forLead(w.leadId)).toBeNull();
    expect(w.coupons.claim(w.clientId, w.leadId + 5)).toBe(false);
  });

  it('a quote without the coupon line (the bundle discount won) leaves the coupon unused on acceptance', async () => {
    const w = quoteWorld(false);
    w.docs.accept(w.clientId, w.q.quoteId);
    await w.docs.idle();
    expect((await w.payload()).coupon.used).toBe(false);
  });
});

describe('the reminder a day after sign-up', () => {
  it('goes once to a client with no lead, in the project-mail channel, with the builder link; not before a day, not twice', async () => {
    const s = setup();
    await s.reg();
    expect(await s.coupons.remindTick(s.mail, 'https://firtech.pro')).toBe(0);
    s.p.w.clock.t += DAY + 60_000;
    expect(await s.coupons.remindTick(s.mail, 'https://firtech.pro')).toBe(1);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]!.to).toBe('alice@example.com');
    expect(s.sent[0]!.subject).toBe('Ваш купон 10 % ждёт');
    expect(s.sent[0]!.text).toContain('https://firtech.pro/ru/builder');
    expect(s.sent[0]!.text).toContain('/ru/cabinet');
    expect(await s.coupons.remindTick(s.mail, 'https://firtech.pro')).toBe(0);
    s.p.w.clock.t += DAY;
    expect(await s.coupons.remindTick(s.mail, 'https://firtech.pro')).toBe(0);
    expect(s.sent).toHaveLength(1);
  });

  it('is skipped for a client who already sent a lead, and for accounts older than three days', async () => {
    const s = setup();
    const lead = await s.reg('lead@example.com');
    const task = s.p.w.hq.createTask({ title: 'Лид', dept: 'sales', creator: 'routine', meta: { action: 'lead', lead: {} } });
    registerCabinetLead(s.db, s.p.t, task.id, { clientEmail: 'lead@example.com', name: 'Л', contact: 'l@example.com', service: 'site', budget: '', message: 'x', estimate: '', locale: 'ru', source: 'site' });
    s.oldClient('older@example.com', 10);
    s.p.w.clock.t += DAY + 60_000;
    await s.coupons.remindTick(s.mail, 'https://firtech.pro');
    expect(lead.coupon).toBeTruthy();
    expect(s.sent.map((m) => m.to)).toEqual([]);
    expect(s.db.prepare('SELECT client_id FROM client_coupons WHERE reminded_at IS NOT NULL').all()).toEqual([]);
  });
});
