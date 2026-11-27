/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { describe, expect, it } from 'vitest';
import { shellWorld, serve, type ShellWorld } from './shell-helpers.js';
import { pendingApprovalsCount } from '../src/review.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const BLOCKS = ['night', 'decide', 'hotLeads', 'money', 'funnel', 'team', 'alerts'] as const;

let seq = 0;
function invoice(p: ShellWorld, o: { amount: number; status: string; due: string; paidAt?: number | null; leadId?: number | null; number?: string }) {
  seq++;
  p.w.hq.db.prepare('INSERT INTO bl_invoices (number, year, seq, client, amount_usd, due_date, status, created_at, issued_at, paid_at, lead_id) VALUES (?, 2026, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(o.number ?? `FT-2026-${seq}`, 900 + seq, 'Клиент', o.amount, o.due, o.status, p.t() - DAY, p.t() - DAY, o.paidAt ?? null, o.leadId ?? null);
}

async function seeded() {
  const p = shellWorld();
  await p.call('GET', '/admin/crm/invoices');
  const t = p.t();
  const db = p.w.hq.db;
  p.lead('Нигина Рахимова', { at: t - 25 * 60_000, service: 'bot', budget: '$350' });
  p.lead('Борис', { at: t - 2 * HOUR });
  const anvar = p.lead('Анвар', { at: t - 5 * DAY });
  const old = p.lead('Вера', { at: t - 3 * DAY });
  db.prepare("UPDATE li_leads SET stage_override = 'lost' WHERE id = ?").run(old.id);
  const today = new Date(t).toISOString().slice(0, 10);
  invoice(p, { amount: 300, status: 'paid', due: today, paidAt: t - HOUR, leadId: anvar.id, number: 'FT-2026-005' });
  invoice(p, { amount: 600, status: 'issued', due: new Date(t + 5 * DAY).toISOString().slice(0, 10) });
  invoice(p, { amount: 450, status: 'issued', due: '2020-01-01' });
  db.prepare('INSERT INTO cs_tickets (client_name, contact, text, status, created_at) VALUES (?, ?, ?, ?, ?)').run('Алиса Иванова', '', 'вопрос', 'open', t - 5 * HOUR);
  db.prepare("INSERT INTO costs (agent_id, dept, model, usd, at) VALUES ('a', 'marketing', 'm', 3.8, ?)").run(t - HOUR);
  // two cards waiting (one content, one document), one decided
  const task = p.w.hq.createTask({ title: 'x', dept: 'marketing', creator: 'head' });
  await p.w.hq.requestApproval(task.id, 'marketing-head', 'content_item', { itemId: 1, text: 'x' }, 'Клип про бота');
  const task2 = p.w.hq.createTask({ title: 'y', dept: 'sales', creator: 'head' });
  await p.w.hq.requestApproval(task2.id, 'sales-head', 'presales_pack', { text: 'y' }, 'КП: Боб, Telegram-бот для записи');
  return p;
}

describe('GET /admin/today', () => {
  it('401 without the token, 404 for other paths and methods, 400 for a bad tz', async () => {
    const p = shellWorld();
    const s = await serve(p);
    expect((await s.http('GET', '/admin/today', undefined, {})).status).toBe(401);
    expect((await s.http('GET', '/admin/today')).status).toBe(200);
    await s.close();
    expect((await p.call('GET', '/admin/today/x')).status).toBe(404);
    expect((await p.call('POST', '/admin/today', {})).status).toBe(404);
    const bad = await p.call('GET', '/admin/today?tz=Mars/Base');
    expect(bad.status).toBe(400);
    expect(bad.json).toMatchObject({ ok: false, error: 'invalid', fields: ['tz'] });
  });

  it('empty database: every block answers with zeros and empty lists, the night is quiet', async () => {
    const p = shellWorld();
    await p.call('GET', '/admin/crm/invoices');
    const r = await p.call('GET', '/admin/today?tz=Asia/Kuala_Lumpur');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ tz: 'Asia/Kuala_Lumpur', generatedAt: new Date(p.t()).toISOString() });
    expect(r.json.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.json.night).toEqual({ available: true, text: 'Тихая ночь, ничего нового', items: [] });
    expect(r.json.decide).toEqual({ available: true, total: 0, items: [], byKind: {} });
    expect(r.json.hotLeads).toEqual({ available: true, items: [] });
    expect(r.json.money).toMatchObject({ available: true, paid7d: 0, pending: 0, overdue: 0, overdueCount: 0 });
    expect(r.json.money.perDay).toHaveLength(7);
    expect(r.json.funnel.steps.map((x: any) => [x.step, x.n])).toEqual([['leads', 0], ['quotes', 0], ['contracts', 0], ['paid', 0]]);
    expect(r.json.team).toMatchObject({ available: true, busy: 0, spendToday: 0 });
    expect(r.json.team.total).toBeGreaterThan(0);
    expect(r.json.alerts.available).toBe(true);
    for (const b of BLOCKS) expect(r.json[b].available).toBe(true);
  });

  it('one failing block: its table is gone, the others still answer', async () => {
    const p = await seeded();
    p.w.hq.db.exec('DROP TABLE bl_invoices');
    const r = await p.call('GET', '/admin/today');
    expect(r.status).toBe(200);
    expect(r.json.money).toEqual({ available: false });
    expect(r.json.decide.available).toBe(true);
    expect(r.json.hotLeads.available).toBe(true);
    expect(r.json.team.available).toBe(true);
    // the night also reads invoices: without them it still speaks about the leads
    expect(r.json.night.available).toBe(true);
  });

  it('a block that throws inside is unavailable, not a 500', async () => {
    const p = await seeded();
    p.w.hq.db.exec('DROP TABLE costs');
    const r = await p.call('GET', '/admin/today');
    expect(r.status).toBe(200);
    expect(r.json.team).toEqual({ available: false });
    expect(r.json.decide.available).toBe(true);
  });

  it('a seeded world: the night, the queue, hot leads, money, team and alerts', async () => {
    const p = await seeded();
    const r = (await p.call('GET', '/admin/today')).json;
    // night: payment, lead count, the slow ticket (first names only)
    expect(r.night.available).toBe(true);
    expect(r.night.items.map((x: any) => x.kind)).toEqual(['payment', 'lead', 'alert']);
    expect(r.night.text).toBe('оплата $300 по FT-2026-005, 2 новых лида, тикет Алиса без ответа 5 ч');
    expect(r.night.text).not.toContain('Иванова');
    expect(r.night.items[1].href).toMatch(/^\/admin\/clients\?focus=l_\d+$/);

    expect(r.decide.total).toBe(2);
    expect(r.decide.byKind).toEqual({ content: 1, document: 1 });
    expect(r.decide.items).toHaveLength(2);
    const doc = r.decide.items.find((x: any) => x.kind === 'document');
    expect(doc).toMatchObject({ title: 'КП: Боб, Telegram-бот для записи', meta: expect.stringMatching(/^Документ · Sales · \d+ (мин|ч|д)$/), href: expect.stringMatching(/^\/admin\/approvals\?id=ap_\d+$/) });
    expect(doc.actions).toEqual([
      { id: 'open', label: 'Открыть', kind: 'link', href: doc.href },
      { id: 'approve', label: 'Одобрить', kind: 'post', url: `/admin/review/${doc.id}`, body: { action: 'approve' }, primary: true },
    ]);

    expect(r.hotLeads.items.map((x: any) => x.name)).toEqual(['Борис', 'Нигина', 'Анвар']); // the lost one is out; by stage, new first
    expect(r.hotLeads.items[2]).toMatchObject({ stage: 'paid', next: { label: 'Запустить проект' } });
    expect(r.hotLeads.items[1]).toMatchObject({ what: expect.any(String), amount: 350, stage: 'qualified', stageLabel: 'Квалифицирован', ageMinutes: 25, channel: 'site', next: { label: 'Проверить КП', href: '/admin/approvals' } });
    expect(r.hotLeads.items[0]).toMatchObject({ stage: 'new', stageLabel: 'Новый', amount: 0, next: { label: 'Ответить', href: expect.stringMatching(/^\/admin\/chats\?lead=l_\d+$/) } });

    expect(r.money).toMatchObject({ paid7d: 300, pending: 600, overdue: 450, overdueCount: 1 });
    expect(r.money.perDay).toHaveLength(7);
    expect(r.money.perDay.at(-1).paid).toBe(300);
    expect(r.funnel.steps.find((x: any) => x.step === 'leads').n).toBe(4);
    expect(r.funnel.steps.find((x: any) => x.step === 'paid').n).toBe(1);
    expect(r.team.spendToday).toBe(3.8);
    expect(r.team.items[0]).toMatchObject({ id: expect.any(String), href: expect.stringMatching(/^\/admin\/team\//) });
    expect(r.alerts.items).toEqual([{ id: expect.stringMatching(/^a_ticket_\d+$/), level: 'warn', text: 'Тикет Алиса без ответа больше 5 ч', href: expect.stringMatching(/^\/admin\/chats\?thread=t_\d+$/) }]);
  });

  it('caches for 10 s per tz', async () => {
    const p = await seeded();
    const a = (await p.call('GET', '/admin/today')).json;
    p.w.hq.db.prepare("INSERT INTO costs (agent_id, dept, model, usd, at) VALUES ('a', 'sales', 'm', 1, ?)").run(p.t());
    expect((await p.call('GET', '/admin/today')).json.team.spendToday).toBe(a.team.spendToday);
    expect((await p.call('GET', '/admin/today?tz=Europe/Moscow')).json.team.spendToday).toBe(a.team.spendToday + 1);
    p.w.clock.t += 11_000;
    expect((await p.call('GET', '/admin/today')).json.team.spendToday).toBe(a.team.spendToday + 1);
  });

  it('one number: today.decide.total = review pending counts = hub approvals = pendingApprovalsCount', async () => {
    const p = await seeded();
    const db = p.w.hq.db;
    // one card is decided: it leaves every count at once
    const review = (await p.call('GET', '/admin/review?status=pending')).json;
    const first = review.items.find((x: any) => x.kind === 'content_item');
    expect((await p.call('POST', `/admin/review/${first.id}`, { action: 'reject' })).status).toBe(200);
    const today = (await p.call('GET', '/admin/today')).json;
    const after = (await p.call('GET', '/admin/review?status=pending')).json;
    const reviewTotal = Object.values(after.counts as Record<string, number>).reduce((s, n) => s + n, 0);
    const listed = after.items.length;
    const hub = (await p.call('GET', '/admin/hub')).json;
    const hubTotal = Object.values(hub.departments as Record<string, { approvals: number }>).reduce((s, x) => s + x.approvals, 0);
    expect(today.decide.total).toBe(1);
    expect(reviewTotal).toBe(today.decide.total);
    expect(listed).toBe(today.decide.total);
    expect(hub.approvalsPending).toBe(today.decide.total);
    expect(hubTotal).toBe(today.decide.total);
    expect(pendingApprovalsCount(db)).toBe(today.decide.total);
    expect(today.decide.items.map((x: any) => x.id).sort()).toEqual(after.items.map((x: any) => x.id).sort());
  });
});
