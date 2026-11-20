/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { BillingStore } from '@fir/worker-billing';
import { DocStore } from '@fir/worker-documents';
import { LeadStore, leadCard } from '@fir/worker-lead-intake';
import { PmStore } from '@fir/worker-project-manager';
import { PresalesStore } from '@fir/worker-presales';
import { describe, expect, it } from 'vitest';
import { nextStepOf, registerCabinetLead } from '../src/cabinet.js';
import { STAGES } from '../src/lead-stage.js';
import { createWebhook } from '../src/webhook.js';
import { pultWorld } from './pult-helpers.js';

const HOUR = 3_600_000;

function setup() {
  const tickets: any[] = [];
  const p = pultWorld({ admin: { cabinetTicket: (x) => { tickets.push(x); return Promise.resolve(); } } });
  const db = p.w.hq.db;
  const reg = (over: Record<string, unknown> = {}) => p.call('POST', '/admin/clients', { email: 'alice@example.com', name: 'Алиса', supabaseId: 'abc', ...over });
  /** A lead of a cabinet client the way the webhook makes it (task + row + link). */
  const cabLead = (over: Partial<Parameters<typeof registerCabinetLead>[3]> = {}) => {
    const task = p.w.hq.createTask({ title: 'Лид', dept: 'sales', creator: 'routine', meta: { action: 'lead', lead: { name: 'Алиса' } } });
    const r = registerCabinetLead(db, () => p.w.clock.t, task.id, {
      clientEmail: 'alice@example.com', name: 'Алиса', contact: 'alice@example.com', service: 'site', budget: '', message: 'Нужен сайт для салона', estimate: 'Пакет Бизнес\nИтого: $1 200',
      locale: 'ru', source: 'site', hasDomain: true, hasHosting: false, ...over,
    });
    return { ...r, taskId: task.id };
  };
  return { p, db, tickets, reg, cabLead };
}

describe('POST /lead with a signed-in cabinet client', () => {
  async function start() {
    const s = setup();
    const server = createWebhook((lead) => {
      const id = s.p.w.hq.createTask({ title: 'Лид', dept: 'sales', creator: 'routine', meta: { action: 'lead', lead: { name: lead.name } } }).id;
      if (!lead.clientEmail) return Promise.resolve(id);
      const r = registerCabinetLead(s.db, () => s.p.w.clock.t, id, { ...lead, clientEmail: lead.clientEmail });
      return Promise.resolve({ id, leadId: r.leadId });
    }, 'tok');
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = async (b: unknown) => {
      const r = await fetch(`${url}/lead`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lead-token': 'tok' }, body: JSON.stringify(b) });
      return { status: r.status, json: (await r.json()) as any };
    };
    return { ...s, server, post };
  }
  const form = { name: 'Алиса', contact: '@alice', service: 'site', message: 'Нужен сайт', locale: 'ru', hasDomain: true };

  it('upserts the account by email, links the lead at once and answers with leadId', async () => {
    const s = await start();
    try {
      const a = await s.post({ ...form, clientEmail: 'Alice@Example.com ', cabinetId: 'sb-1', clientName: 'Алиса К' });
      expect(a.status).toBe(200);
      expect(a.json).toMatchObject({ ok: true, leadId: expect.any(Number) });
      const c = s.db.prepare('SELECT * FROM cab_clients').all() as any[];
      expect(c).toHaveLength(1);
      expect(c[0]).toMatchObject({ email: 'alice@example.com', name: 'Алиса К', supabase_id: 'sb-1' });
      const row = s.db.prepare('SELECT * FROM li_leads WHERE id = ?').get(a.json.leadId) as any;
      expect(row).toMatchObject({ client_id: c[0].id, task_id: a.json.id, contact: '@alice', has_domain: 1 });
      // idempotent for the account: a second lead links to the same client, the account is not duplicated and keeps its data
      const b = await s.post({ ...form, clientEmail: 'alice@example.com' });
      expect(b.json.leadId).not.toBe(a.json.leadId);
      expect((s.db.prepare('SELECT COUNT(*) n FROM cab_clients').get() as any).n).toBe(1);
      expect(s.db.prepare('SELECT name, supabase_id FROM cab_clients').get()).toMatchObject({ name: 'Алиса К', supabase_id: 'sb-1' });
      expect(s.db.prepare('SELECT COUNT(*) n FROM li_leads WHERE client_id = ?').get(c[0].id)).toMatchObject({ n: 2 });
      // the owner's card says so
      expect(leadCard(new LeadStore(s.db).get(a.json.leadId)!, 'Asia/Dushanbe', 'site', '-')).toContain('Кабинет: да');
    } finally {
      s.server.close();
    }
  });

  it('uses the email as the contact when the form had none; without both the lead is invalid; a broken email is ignored', async () => {
    const s = await start();
    try {
      const noContact = await s.post({ name: 'Алиса', service: 'site', clientEmail: 'alice@example.com' });
      expect(noContact.status).toBe(200);
      expect(s.db.prepare('SELECT contact FROM li_leads WHERE id = ?').get(noContact.json.leadId)).toMatchObject({ contact: 'alice@example.com' });
      expect((await s.post({ name: 'Алиса', service: 'site' })).status).toBe(400);
      const broken = await s.post({ ...form, clientEmail: 'not-an-email' });
      expect(broken.status).toBe(200);
      expect(broken.json.leadId).toBeUndefined();
      expect((s.db.prepare('SELECT COUNT(*) n FROM cab_clients').get() as any).n).toBe(1);
    } finally {
      s.server.close();
    }
  });
});

describe('GET /admin/clients/by-email: leads', () => {
  it('has no leads for a client without any', async () => {
    const { p, reg } = setup();
    await reg();
    expect((await p.call('GET', '/admin/clients/by-email?email=alice@example.com')).json.leads).toEqual([]);
  });

  it('gives the lead with its stage, next step and a timeline built from the other tables', async () => {
    const { p, db, reg, cabLead } = setup();
    await reg();
    const t0 = p.w.clock.t;
    const l = cabLead();
    const at = (h: number) => new Date(t0 + h * HOUR).toISOString();
    // a manager reply, the approved КП, a contract, an invoice and its payment, a started project, an owner move
    db.prepare('INSERT INTO cab_messages (client_id, lead_id, "from", text, at) VALUES (?, ?, ?, ?, ?)').run(l.clientId, l.leadId, 'manager', 'Здравствуйте, Алиса!', t0 + HOUR);
    const ps = new PresalesStore(db, () => t0);
    db.prepare("INSERT INTO ps_documents (pack_id, lead_id, kind, direction, title, body, status, created_at, decided_at) VALUES (1, ?, 'kp', 'out', 'КП', 'секрет внутренний текст', 'approved', ?, ?)").run(l.leadId, t0, t0 + 2 * HOUR);
    void ps;
    new DocStore(db, () => t0);
    db.prepare("INSERT INTO bo_documents (type, client, version, text, status, created_at) VALUES ('contract', 'Алиса', 1, 'x', 'approved', ?)").run(t0 + 3 * HOUR);
    new BillingStore(db, () => t0);
    db.prepare("INSERT INTO bl_invoices (number, year, seq, client, amount_usd, what, due_date, status, created_at, paid_at, lead_id, total_usd) VALUES ('FT-1', 2026, 1, 'Алиса', 600, 'x', '2026-12-01', 'paid', ?, ?, ?, 1200)").run(t0 + 4 * HOUR, t0 + 5 * HOUR, l.leadId);
    new PmStore(db, () => t0);
    db.prepare("INSERT INTO pm_projects (client, what, product, status, created_at, lead_id) VALUES ('Алиса', 'Сайт', 'site', 'active', ?, ?)").run(t0 + 6 * HOUR, l.leadId);
    p.w.clock.t = t0 + 7 * HOUR;
    db.prepare("INSERT INTO activity (agent_id, action, object_type, object_id, detail, at) VALUES ('owner', 'lead_stage', 'lead', ?, 'qualified', ?)").run(String(l.leadId), t0 + 30_000);

    const r = await p.call('GET', '/admin/clients/by-email?email=alice@example.com');
    expect(r.status).toBe(200);
    expect(r.json.leads).toHaveLength(1);
    expect(r.json.leads[0]).toEqual({
      id: l.leadId, createdAt: at(0), service: 'site', summary: 'Нужен сайт для салона', estimateUsd: 1200, hasDomain: true, hasHosting: false,
      stage: 'project', nextStep: 'Проект в работе, этапы ниже',
      timeline: [
        { at: at(0), kind: 'lead', title: 'Заявка получена' },
        { at: new Date(t0 + 30_000).toISOString(), kind: 'stage', title: 'Заявка квалифицирована' },
        { at: at(1), kind: 'reply', title: 'Менеджер ответил' },
        { at: at(2), kind: 'kp', title: 'Коммерческое предложение утверждено' },
        { at: at(3), kind: 'contract', title: 'Договор подготовлен' },
        { at: at(4), kind: 'invoice', title: 'Счёт выставлен' },
        { at: at(5), kind: 'paid', title: 'Оплата получена' },
        { at: at(6), kind: 'project', title: 'Проект запущен' },
      ],
      replies: [{ at: at(1), text: 'Здравствуйте, Алиса!', from: 'manager' }],
    });
    // no internal texts anywhere in the answer
    expect(JSON.stringify(r.json.leads)).not.toContain('внутренний');
  });

  it('newest first, at most 20, only the client\'s own leads; the lead language picks the sentence', async () => {
    const { p, reg, cabLead } = setup();
    await reg();
    await reg({ email: 'bob@example.com', name: 'Боб', supabaseId: 'bob' });
    const ids: number[] = [];
    for (let i = 0; i < 22; i++) ids.push(cabLead({ locale: i === 21 ? 'en' : 'ru' }).leadId);
    cabLead({ clientEmail: 'bob@example.com', contact: 'bob@example.com' });
    const r = await p.call('GET', '/admin/clients/by-email?email=alice@example.com');
    expect(r.json.leads).toHaveLength(20);
    expect(r.json.leads.map((x: any) => x.id)).toEqual(ids.slice(2).reverse());
    expect(r.json.leads[0]).toMatchObject({ stage: 'qualified', nextStep: 'We are preparing the commercial proposal' });
    expect(r.json.leads[1]).toMatchObject({ stage: 'qualified', nextStep: 'Готовим коммерческое предложение' });
  });

  it('maps every stage to a sentence, in both languages; the owner\'s move shows in the lead', async () => {
    for (const s of STAGES) {
      expect(nextStepOf(s, 'ru').length).toBeGreaterThan(10);
      expect(nextStepOf(s, 'en')).not.toBe(nextStepOf(s, 'ru'));
    }
    expect(nextStepOf('new', 'ru')).toBe('Первый ответ за 5 минут, круглосуточно; цены и сроки подтверждает основатель');
    expect(nextStepOf('lost', undefined)).toBe('Заявка закрыта');
    const { p, reg, cabLead } = setup();
    await reg();
    const l = cabLead({ message: 'ok', estimate: '', service: '' });
    expect((await p.call('GET', '/admin/clients/by-email?email=alice@example.com')).json.leads[0]).toMatchObject({ stage: 'new', estimateUsd: null, nextStep: 'Первый ответ за 5 минут, круглосуточно; цены и сроки подтверждает основатель' });
    await p.call('POST', `/admin/crm/leads/${l.leadId}`, { stage: 'lost' });
    const lost = (await p.call('GET', '/admin/clients/by-email?email=alice@example.com')).json.leads[0];
    expect(lost).toMatchObject({ stage: 'lost', nextStep: 'Заявка закрыта' });
    expect(lost.timeline.at(-1)).toMatchObject({ kind: 'stage', title: 'Заявка закрыта' });
  });
});

describe('replies: both directions', () => {
  it('the owner\'s /reply lands in the lead\'s thread (cabinet leads only)', async () => {
    const { p, db, reg, cabLead } = setup();
    await reg();
    const l = cabLead();
    const plain = p.lead('Без кабинета');
    expect((await p.call('POST', `/admin/crm/leads/${l.leadId}/reply`, { text: ' Добрый день ' })).json).toMatchObject({ ok: true, sent: false });
    await p.call('POST', `/admin/crm/leads/${plain.id}/reply`, { text: 'Привет' });
    expect(db.prepare('SELECT lead_id, "from", text FROM cab_messages').all()).toEqual([{ lead_id: l.leadId, from: 'manager', text: 'Добрый день' }]);
  });

  it('the client\'s messages and the approved ticket answer join the same thread, in order', async () => {
    const { p, db, tickets, reg, cabLead } = setup();
    await reg();
    const l = cabLead();
    await p.call('POST', `/admin/crm/leads/${l.leadId}/reply`, { text: 'Здравствуйте' });
    p.w.clock.t += 60_000;
    const m = await p.call('POST', `/admin/clients/1/leads/${l.leadId}/messages`, { text: '  Когда будет КП?  ' });
    expect(m.json).toMatchObject({ ok: true, item: { text: 'Когда будет КП?', from: 'client', leadId: l.leadId } });
    expect(tickets).toHaveLength(1);
    p.w.clock.t += 60_000;
    p.cs.markAnswered(tickets[0].id, 'Завтра пришлём');
    p.cs.markAnswered(tickets[0].id, 'Завтра пришлём'); // approving twice records once
    const r = await p.call('GET', '/admin/clients/by-email?email=alice@example.com');
    expect(r.json.leads[0].replies.map((x: any) => [x.from, x.text])).toEqual([['manager', 'Здравствуйте'], ['client', 'Когда будет КП?'], ['manager', 'Завтра пришлём']]);
    expect(db.prepare('SELECT COUNT(*) n FROM cab_messages').get()).toMatchObject({ n: 3 });
  });

  it('the Sales head\'s approved answer is recorded for a cabinet lead', async () => {
    const { p, db, reg, cabLead } = setup();
    await reg();
    const l = cabLead();
    const { recordManagerReply } = await import('../src/cabinet.js');
    recordManagerReply(db, p.w.clock.t, l.leadId, 'Предлагаем созвон завтра в 11:00');
    recordManagerReply(db, p.w.clock.t, 99999, 'нет такого лида');
    expect(db.prepare('SELECT text, "from" FROM cab_messages').all()).toEqual([{ text: 'Предлагаем созвон завтра в 11:00', from: 'manager' }]);
  });
});

describe('POST /admin/clients/:id/leads/:leadId/messages', () => {
  it('checks the owner of the lead (404), the body (400) and the account (404)', async () => {
    const { p, tickets, reg, cabLead } = setup();
    await reg();
    await reg({ email: 'bob@example.com', name: 'Боб', supabaseId: 'bob' });
    const mine = cabLead();
    const bobs = cabLead({ clientEmail: 'bob@example.com', contact: 'bob@example.com' });
    const post = (id: number | string, lead: number | string, body: unknown) => p.call('POST', `/admin/clients/${id}/leads/${lead}/messages`, body);
    expect((await post(1, bobs.leadId, { text: 'чужая' })).json).toEqual({ ok: false, error: 'not_found' });
    expect((await post(1, 9999, { text: 'нет' })).status).toBe(404);
    expect((await post(77, mine.leadId, { text: 'нет' })).status).toBe(404);
    for (const bad of [{}, { text: '   ' }, { text: 'x'.repeat(2001) }, { text: 5 }]) expect((await post(1, mine.leadId, bad)).json).toMatchObject({ ok: false, error: 'invalid' });
    expect(tickets).toHaveLength(0);
    expect((await post(1, mine.leadId, { text: 'x'.repeat(2000) })).status).toBe(200);
  });

  it('makes a Support ticket with the lead id, a journal line for Sales and an inbox line for the owner', async () => {
    const { p, db, tickets, reg, cabLead } = setup();
    await reg();
    const l = cabLead();
    const r = await p.call('POST', `/admin/clients/1/leads/${l.leadId}/messages`, { text: 'Можно добавить блог?' });
    expect(r.status).toBe(200);
    const ticket = db.prepare('SELECT * FROM cs_tickets').get() as any;
    expect(ticket).toMatchObject({ source: 'cabinet', contact: 'alice@example.com', text: 'Можно добавить блог?', lead_id: l.leadId });
    expect(tickets).toEqual([{ id: ticket.id, name: 'Алиса', text: 'Можно добавить блог?', telegram: '', leadId: l.leadId }]);
    expect(p.w.hq.events(l.taskId).at(-1)).toMatchObject({ kind: 'comment', actor: 'sales-head' });
    expect(p.w.channel!.list({}).map((i) => i.text)).toContain(`Сообщение по заявке #${l.leadId} от Алиса`);
  });

  it('allows 10 an hour per client, then 429; the window moves on', async () => {
    const { p, db, reg, cabLead } = setup();
    await reg();
    const l = cabLead();
    const send = () => p.call('POST', `/admin/clients/1/leads/${l.leadId}/messages`, { text: 'ещё' });
    for (let i = 0; i < 10; i++) expect((await send()).status).toBe(200);
    expect((await send()).json).toEqual({ ok: false, error: 'rate_limited' });
    expect(db.prepare('SELECT COUNT(*) n FROM cab_messages WHERE "from" = \'client\'').get()).toMatchObject({ n: 10 });
    p.w.clock.t += HOUR + 1000;
    expect((await send()).status).toBe(200);
  });
});
