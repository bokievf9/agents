import { describe, expect, it } from 'vitest';
import { ApprovalQueue, MemoryMessenger, openDb } from '@fir/core';
import { Hq } from '@fir/hq';
import { LeadStore } from '@fir/worker-lead-intake';
import { BillingStore } from '@fir/worker-billing';
import { ensureCabinetTables } from '../src/cabinet.js';
import { ensureDocTables } from '../src/cab-docs.js';
import { shellLinks } from '../src/links.js';
import { GROUP_MS, OwnerNotices, noContacts } from '../src/notices.js';
import { OwnerChannel } from '../src/presence.js';
import { pendingApprovalsCount } from '../src/review.js';
import { seedTiming } from '../src/timing.js';
import { NOW, OWNER } from './helpers.js';

const MIN = 60_000;

/** HQ with the owner channel in the `notices` policy over a recording Telegram; the clock is 15:00 in Kuala Lumpur (quiet 23:00-08:00). */
function setup() {
  const clock = { t: NOW };
  const db = openDb(':memory:');
  const hq = new Hq(db, { now: () => clock.t });
  seedTiming(hq, { tz: 'Asia/Dushanbe', ownerTz: 'Asia/Kuala_Lumpur' });
  const tg = new MemoryMessenger();
  const channel = new OwnerChannel({ hq, inner: tg, ownerId: OWNER, telegram: 'notices' });
  const links = shellLinks('https://firtech.pro');
  const notices = new OwnerNotices({ hq, links, deliver: (html) => channel.notice(html) });
  ensureCabinetTables(db);
  ensureDocTables(db);
  const leads = new LeadStore(db, () => clock.t);
  new BillingStore(db, () => clock.t);
  new ApprovalQueue(db, tg, OWNER); // makes the core `approvals` table, as the running app does
  const sent = () => tg.to(OWNER);
  return { clock, db, hq, tg, channel, links, notices, leads, sent };
}

const lead = (s: ReturnType<typeof setup>, taskId: number, name: string, extra: Record<string, unknown> = {}) => {
  s.db.prepare("INSERT INTO tasks (id, title, dept, creator, status, created_at, updated_at, tags, meta) VALUES (?, 'lead', 'sales', 'head', 'done', ?, ?, '', '{}')").run(taskId, s.clock.t, s.clock.t);
  return s.leads.upsert(taskId, { name, contact: '+992 90 111 22 33', service: 'site', niche: 'салон', task: 'Секретный текст клиента', deadline: '', budget: '', origin: 'site', temperature: 'warm', lang: 'ru', slots: [], chosenSlot: null, priceAsked: false, ...extra } as never);
};

describe('service keys never reach the owner', () => {
  it('a lead of service websites / bots / apps / automation reads in plain Russian', async () => {
    const s = setup();
    lead(s, 1, 'Старая');
    await s.notices.scan();
    lead(s, 2, 'Аудит Тест', { service: 'websites', niche: '', origin: '' });
    await s.notices.scan();
    expect(s.sent().join('\n')).toMatch(/Новая заявка #2 «Аудит Тест»: сайт\./);
    const t = setup();
    lead(t, 1, 'Старая');
    await t.notices.scan();
    lead(t, 3, 'Direct Test', { service: 'bots', niche: '', origin: '' });
    await t.notices.scan();
    expect(t.sent().join('\n')).toMatch(/Новая заявка #2 «Direct Test»: ИИ-агент в Telegram\./);
    expect(`${s.sent().join()}${t.sent().join()}`).not.toMatch(/websites|\bbots\b/);
  });
});

describe('the reminders of the one HQ bot (owner 2026-11-22)', () => {
  it('the first scan only marks what exists; a new lead is one short line with a link, no contact and no text of the client', async () => {
    const s = setup();
    lead(s, 1, 'Старая заявка');
    expect(await s.notices.scan()).toBe(0);
    expect(s.sent()).toEqual([]);
    lead(s, 2, 'Салон Лола');
    expect(await s.notices.scan()).toBe(1);
    const [msg] = s.sent();
    expect(msg).toMatch(/^Новая заявка #2 «Салон Лола»: сайт, салон, /);
    expect(msg).toContain('https://firtech.pro/admin/clients?tab=pipeline&amp;focus=2');
    expect(msg).not.toMatch(/\+992|Секретный/);
    expect(msg!.split('\n').length).toBeLessThanOrEqual(2);
    // a second scan repeats nothing (the ref is kept)
    await s.notices.scan();
    expect(s.sent()).toHaveLength(1);
    expect(s.channel.list()).toEqual([]); // a reminder is a ping, not an inbox item
  });

  it('one message in 5 minutes per type: the next leads wait and go as one group line; a payment goes at once', async () => {
    const s = setup();
    await s.notices.scan();
    lead(s, 1, 'Первая');
    await s.notices.scan();
    lead(s, 2, 'Вторая');
    lead(s, 3, 'Третья');
    s.clock.t += 2 * MIN;
    await s.notices.scan();
    expect(s.sent()).toHaveLength(1);
    s.db.prepare("INSERT INTO bl_invoices (number, year, seq, client, amount_usd, due_date, status, created_at, paid_at) VALUES ('FT-2026-007', 2026, 7, 'Салон Лола', 87, '2026-11-30', 'paid', ?, ?)").run(s.clock.t, s.clock.t);
    await s.notices.scan();
    expect(s.sent().at(-1)).toMatch(/^Оплата пришла: Салон Лола, \$87 \(счёт FT-2026-007\)\./);
    s.clock.t += GROUP_MS;
    await s.notices.scan();
    expect(s.sent().at(-1)).toMatch(/^Новые заявки: 2 \(#2 «Вторая»; #3 «Третья»\)\./);
    expect(s.sent()).toHaveLength(3);
  });

  it('quiet hours: nothing goes at night, the night becomes one line of the morning summary; a summary itself is never held', async () => {
    const s = setup();
    await s.notices.scan();
    s.clock.t = Date.UTC(2026, 10, 18, 17, 0); // 01:00 Kuala Lumpur
    expect(s.hq.isQuiet()).toBe(true);
    lead(s, 1, 'Ночная');
    await s.notices.scan();
    await s.notices.alert('Модель не отвечает', { kind: 'llm', short: 'Claude не отвечает' });
    expect(s.sent()).toEqual([]);
    await s.notices.push('summary', 'Сводка в тихие часы', '');
    expect(s.sent()).toEqual(['Сводка в тихие часы']);
    s.clock.t = Date.UTC(2026, 10, 19, 0, 0); // 08:00
    await s.notices.flush();
    expect(s.sent()).toHaveLength(1); // the night notices wait for the summary
    expect(s.notices.takeNight()).toBe('За ночь: заявок 1, алертов 1. Алерты: Claude не отвечает.');
    expect(s.notices.takeNight()).toBeNull();
    await s.notices.flush();
    expect(s.sent()).toHaveLength(1);
  });

  it('a night notice nobody summarised goes as a day one after 12 hours', async () => {
    const s = setup();
    await s.notices.scan();
    s.clock.t = Date.UTC(2026, 10, 18, 17, 0); // 01:00
    lead(s, 1, 'Ночная');
    await s.notices.scan();
    s.clock.t = Date.UTC(2026, 10, 19, 5, 30); // 13:30, 12.5 hours later, no summary ran
    await s.notices.flush();
    expect(s.sent()[0]).toMatch(/^Новая заявка #1/);
  });

  it('at the desk (the site open) a reminder is skipped, not queued for later; inside a website command it is dropped', async () => {
    const s = setup();
    await s.notices.scan();
    await s.channel.setMode('desk');
    lead(s, 1, 'За столом');
    await s.notices.scan();
    expect(s.sent()).toEqual([]);
    expect(s.notices.queued()).toEqual([]);
    expect(await s.channel.capture(() => s.channel.notice('x'))).toMatchObject({ result: 'capture' });
  });

  it('alerts: only the reminder kinds reach Telegram, as their short line; the other kinds stay in the Shell', async () => {
    const s = setup();
    expect(await s.notices.alert('Продажи: задача #4 заблокирована (сбой)')).toBe(false);
    expect(await s.notices.alert('Длинный текст про потерянные заявки, связаться: +992 90 765 43 21, a@b.co', { kind: 'lost_lead', short: 'Потеряно заявок: 2 (шлюз недоступен). Контакты в Shell.' })).toBe(true);
    expect(await s.notices.alert('Отдел marketing: потрачено 81% лимита', { kind: 'budget' })).toBe(true);
    expect(s.sent()).toEqual([
      'Потеряно заявок: 2 (шлюз недоступен). Контакты в Shell.\nhttps://firtech.pro/admin/clients?tab=pipeline',
      'Отдел marketing: потрачено 81% лимита\nhttps://firtech.pro/admin/agents',
    ]);
  });

  it('Telegram failing: the notice stays queued and is retried, after 5 failures it is given up', async () => {
    const s = setup();
    let fail = true;
    const real = s.tg.sendMessage.bind(s.tg);
    s.tg.sendMessage = (...a: Parameters<typeof real>) => (fail ? Promise.reject(new Error('502 Bad Gateway')) : real(...a));
    await s.notices.push('payment', 'Оплата пришла: X, $10.', '');
    expect(s.notices.queued()).toHaveLength(1);
    fail = false;
    await s.notices.flush();
    expect(s.sent()).toEqual(['Оплата пришла: X, $10.']);
    fail = true;
    await s.notices.push('payment', 'Оплата пришла: Y, $20.', '');
    for (let i = 0; i < 6; i++) await s.notices.flush();
    expect(s.notices.queued()).toEqual([]);
    expect(s.sent()).toHaveLength(1);
  });

  it('every event of the list: client, approval, stage ready and accepted, signature, call; drill tasks are left out', async () => {
    const s = setup();
    await s.notices.scan();
    const t = s.clock.t;
    s.db.prepare("INSERT INTO cab_clients (email, name, created_at, updated_at) VALUES ('anvar@example.com', 'Анвар', ?, ?)").run(t, t);
    s.db.prepare("INSERT INTO tasks (id, title, dept, creator, status, created_at, updated_at, tags, meta) VALUES (50, 'КП', 'sales', 'head', 'approval', ?, ?, '', '{}'), (51, 'drill', 'sales', 'head', 'approval', ?, ?, 'drill', '{}')").run(t, t, t, t);
    s.db.prepare("INSERT INTO task_approvals (task_id, dept, kind, payload, summary, state, created_at) VALUES (50, 'sales', 'presales_pack', '{\"client\":\"Клиника Шифо\"}', 's', 'queued', ?), (51, 'sales', 'lead_reply', '{}', 's', 'queued', ?)").run(t, t);
    s.db.exec("CREATE TABLE IF NOT EXISTS pm_projects (id INTEGER PRIMARY KEY, client TEXT, what TEXT, product TEXT, status TEXT, created_at INTEGER); CREATE TABLE IF NOT EXISTS pm_milestones (id INTEGER PRIMARY KEY, project_id INTEGER, kind TEXT, title TEXT, due_at INTEGER, status TEXT, done_at INTEGER, stage_no INTEGER, accepted_at INTEGER)");
    s.db.prepare("INSERT INTO pm_projects (id, client, what, product, status, created_at) VALUES (7, 'Салон Лола', 'x', 'admin', 'active', ?)").run(t);
    s.db.prepare("INSERT INTO pm_milestones (project_id, kind, title, due_at, status, done_at, stage_no, accepted_at) VALUES (7, 'stage', 'Этап 1', ?, 'done', ?, 1, NULL), (7, 'stage', 'Этап 2', ?, 'done', ?, 2, ?)").run(t, t, t, t, t);
    s.db.prepare("INSERT INTO cab_documents (client_id, kind, title, number, project_id, state, created_at) VALUES (1, 'contract', 'Договор', 'D-7', 7, 'signed', ?)").run(t);
    s.db.prepare("INSERT INTO bo_signatures (doc_id, signature_png, name, at, sha256) VALUES (1, x'00', 'Анвар', ?, 'h')").run(t);
    lead(s, 60, 'Созвон', { chosenSlot: t + 86_400_000 });
    await s.notices.scan();
    // one per type (the first of each type goes at once), in the order of the list
    expect(s.sent().map((m) => m.split('\n')[0])).toEqual([
      'Новый клиент в кабинете: Анвар.',
      'Новая заявка #1 «Созвон»: сайт, салон, ' + s.sent()[1]!.split('\n')[0]!.split(', ').at(-1),
      'На одобрение: Пресейл-пакет, Клиника Шифо. Всего ждёт вашего решения: 2.',
      'Этап 1 готов к приёмке: Салон Лола (проект #7).',
      'Этап 2 принят: Салон Лола (проект #7).',
      'Договор подписан: Анвар (D-7).',
      'Созвон забронирован: Созвон, 19.11 15:00 (ваше время).',
    ]);
    expect(s.sent()[2]).toContain('https://firtech.pro/admin/approvals?id=ap_1');
    // the notice also carries the one number of cards waiting in all (the drill card counts too: the queue does not know drills)
    expect(s.sent()[2]).toContain(`Всего ждёт вашего решения: ${pendingApprovalsCount(s.db)}.`);
    expect(pendingApprovalsCount(s.db)).toBe(2);
  });

  it('noContacts: phones, emails, handles and t.me links never reach Telegram; a stage number or a sum stays', () => {
    expect(noContacts('Связаться: +992 90 765 43 21, zulfiya.k@example.com, @zulfiya_k, t.me/zulfiya. Этап 2, $290, счёт FT-2026-014.'))
      .toBe('Связаться: [контакт], [контакт], [контакт], [контакт]. Этап 2, $290, счёт FT-2026-014.');
  });
});

describe('the owner channel in the `notices` policy', () => {
  const card = [[{ text: '✅ Одобрить', data: 'ap:7:a' }]];
  it('a card, a Director message and pictures stay in the inbox; an answer in the bot chat and a notice go to Telegram', async () => {
    const s = setup();
    await s.channel.send(OWNER, 'Карточка', card);
    await s.channel.send(OWNER, 'Пачка на одобрение: 3');
    await s.channel.sendPhotos(OWNER, ['/a.png', '/b.png'], 'Превью пакета недели');
    expect(s.sent()).toEqual([]);
    expect(s.channel.list().map((m) => [m.kind, m.text])).toEqual([['approval', 'Карточка'], ['message', 'Пачка на одобрение: 3'], ['message', 'Превью пакета недели (2 шт., файлы в ревью-центре)']]);
    await s.channel.asReply(() => s.channel.send(OWNER, 'Ответ на вопрос'));
    await s.channel.asReply(() => s.channel.send(OWNER, 'Карточка в ответе', card));
    expect(await s.channel.notice('Новая заявка #1')).toBe('sent');
    expect(s.sent()).toEqual(['Ответ на вопрос', 'Новая заявка #1']);
    expect(await s.channel.resendUndelivered()).toBe(0); // the cards never come to Telegram later either
    // another chat (a client) passes straight through
    await s.channel.send(555, 'клиенту');
    expect(s.tg.to(555)).toEqual(['клиенту']);
  });
  it('TG_APPROVAL_CARDS=on: the cards go to Telegram again (while away), other messages still do not', async () => {
    const s = setup();
    const channel = new OwnerChannel({ hq: s.hq, inner: s.tg, ownerId: OWNER, telegram: 'notices', cards: true });
    await channel.send(OWNER, 'Карточка', card);
    await channel.send(OWNER, 'Сообщение Директора');
    expect(s.sent()).toEqual(['Карточка']);
  });
});
