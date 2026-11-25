import { openDb } from '@fir/core';
import { Hq } from '@fir/hq';
import { describe, expect, it } from 'vitest';
import { ensureCabinetTables } from '../src/cabinet.js';
import { ClientReports, lastWeeklyReport, recentDowntime, renderReport, reportSettings } from '../src/client-report.js';
import { Playground } from '../src/playground.js';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** Mon 2026-11-23 10:00 Dushanbe (05:00 UTC): owner clock and company clock are both Asia/Dushanbe in tests. */
const MONDAY = Date.UTC(2026, 10, 23, 5, 0);

function setup(start = MONDAY) {
  const db = openDb(':memory:');
  const clock = { t: start };
  const hq = new Hq(db, { now: () => clock.t });
  hq.setSetting('tz', 'Asia/Dushanbe');
  hq.setSetting('owner_tz', 'Asia/Dushanbe');
  ensureCabinetTables(db);
  db.prepare("INSERT INTO cab_clients (id, email, name, created_at, updated_at) VALUES (1, 'liza@example.com', 'Лиза', 1, 1), (2, 'bob@example.com', 'Боб', 1, 1)").run();
  new Playground({ db, now: () => clock.t, tz: () => hq.tz, llm: { enabled: false } as never, secret: 's' });
  const agent = (id: number, client: number, state = 'live') => db.prepare("INSERT INTO pg_agents (id, public_id, token_hash, client_id, name, persona, state, created_at, updated_at) VALUES (?, ?, 'h', ?, ?, 'p', ?, 1, 1)").run(id, `a${id}`, client, `Агент ${id}`, state);
  const conv = (agentId: number, id: string, channel = 'widget') => db.prepare('INSERT INTO pg_conversations (agent_id, id, channel, started_at, last_at) VALUES (?, ?, ?, 1, 1)').run(agentId, id, channel);
  const msg = (agentId: number, c: string, role: 'user' | 'assistant', at: number) => db.prepare('INSERT INTO pg_messages (agent_id, conv_id, role, text, at) VALUES (?, ?, ?, ?, ?)').run(agentId, c, role, 'x', at);
  const group: string[] = [];
  const tg: { chatId: number; text: string }[] = [];
  const reports = new ClientReports({ hq, postGroup: (t) => { group.push(t); return Promise.resolve(true); }, sendTelegram: (chatId, text) => { tg.push({ chatId, text }); return Promise.resolve(); } });
  return { db, clock, hq, agent, conv, msg, reports, group, tg };
}

describe('weekly report counts', () => {
  it('counts requests, replies within a minute, handoffs, leads and bookings of the last 7 days; test chats and old messages do not count', () => {
    const s = setup();
    s.agent(1, 1);
    s.agent(2, 2);
    s.conv(1, 'w1'); s.conv(1, 'w2', 'telegram'); s.conv(1, 'c1', 'cabinet'); s.conv(1, 'old');
    const now = s.clock.t;
    // fast answer (30 s), slow answer (5 min), no answer
    s.msg(1, 'w1', 'user', now - 2 * HOUR); s.msg(1, 'w1', 'assistant', now - 2 * HOUR + 30_000);
    s.msg(1, 'w2', 'user', now - DAY); s.msg(1, 'w2', 'assistant', now - DAY + 5 * MIN);
    s.msg(1, 'w2', 'user', now - HOUR);
    // the cabinet test chat and a message of 10 days ago are not a client's visitors
    s.msg(1, 'c1', 'user', now - HOUR); s.msg(1, 'c1', 'assistant', now - HOUR + 1000);
    s.msg(1, 'old', 'user', now - 10 * DAY); s.msg(1, 'old', 'assistant', now - 10 * DAY + 1000);
    // another client's agent
    s.conv(2, 'x'); s.msg(2, 'x', 'user', now - HOUR); s.msg(2, 'x', 'assistant', now - HOUR + 1000);
    s.db.prepare("INSERT INTO pg_journal (agent_id, day, kind, n) VALUES (1, '2026-11-22', 'handoff', 2), (1, '2026-11-10', 'handoff', 9), (2, '2026-11-22', 'handoff', 5)").run();
    s.db.prepare("INSERT INTO pg_leads (agent_id, conv_id, contact, at) VALUES (1, 'w1', '+1', ?), (1, 'old', '+2', ?)").run(now - HOUR, now - 10 * DAY);
    s.db.prepare("INSERT INTO pg_bookings (agent_id, conv_id, slot, at) VALUES (1, 'w1', 'Вт 10:00', ?)").run(now - HOUR);
    const st = s.reports.weekStats(1);
    expect(st).toMatchObject({ received: 3, answeredFast: 1, handedOver: 2, leads: 1, bookings: 1, from: '2026-11-17', to: '2026-11-23' });
    const text = renderReport(st, ['Агент 1']);
    expect(text).toContain('Обращений: 3.');
    expect(text).toContain('Ответ за минуту: 1 (33 %).');
    expect(text).toContain('Передано человеку: 2.');
    expect(s.reports.activeClients()).toEqual([1, 2]);
  });

  it('settings: defaults and bad values fall back', () => {
    const s = setup();
    expect(reportSettings(s.hq)).toEqual({ weeklyEnabled: true, weeklyHour: 9, downtimeMinutes: 30 });
    s.hq.setSetting('report.weekly.hour', '25'); s.hq.setSetting('alerts.downtimeMinutes', '2'); s.hq.setSetting('report.weekly.enabled', '0');
    expect(reportSettings(s.hq)).toEqual({ weeklyEnabled: false, weeklyHour: 9, downtimeMinutes: 30 });
  });
});

describe('weekly report delivery', () => {
  it('goes once per week to the cabinet thread, the client Telegram and one group line; not before the hour, not on Tuesday, not when off', async () => {
    const s = setup(Date.UTC(2026, 10, 23, 3, 0)); // 08:00 Dushanbe: before the hour
    s.agent(1, 1);
    expect(await s.reports.weeklyTick()).toBe(0);
    s.clock.t = MONDAY;
    const task = s.hq.createTask({ title: 'Лид', dept: 'sales', creator: 'routine', meta: { action: 'lead', lead: { chatId: 777 } } });
    s.db.exec('CREATE TABLE IF NOT EXISTS li_leads (id INTEGER PRIMARY KEY, task_id INTEGER, client_id INTEGER)');
    s.db.prepare('INSERT INTO li_leads (task_id, client_id) VALUES (?, 1)').run(task.id);
    expect(await s.reports.weeklyTick()).toBe(1);
    expect(await s.reports.weeklyTick()).toBe(0);
    s.clock.t = MONDAY + 3 * HOUR;
    expect(await s.reports.weeklyTick()).toBe(0);
    expect((s.db.prepare("SELECT COUNT(*) n FROM cab_tmsgs WHERE client_id = 1 AND thread = 'support'").get() as { n: number }).n).toBe(1);
    expect(s.tg).toHaveLength(1);
    expect(s.tg[0]!.chatId).toBe(777);
    expect(s.group).toHaveLength(1);
    expect(s.group[0]).toContain('Лиза');
    expect(lastWeeklyReport(s.db, 1)?.stats.received).toBe(0);
    expect(lastWeeklyReport(s.db, 2)).toBeNull();
    // next Monday it goes again; a Tuesday and a disabled setting do not
    s.clock.t = MONDAY + 7 * DAY;
    expect(await s.reports.weeklyTick()).toBe(1);
    s.clock.t = MONDAY + 15 * DAY; // Tuesday
    expect(await s.reports.weeklyTick()).toBe(0);
    s.hq.setSetting('report.weekly.enabled', '0');
    s.clock.t = MONDAY + 14 * DAY;
    expect(await s.reports.weeklyTick()).toBe(0);
  });
});

describe('downtime alert', () => {
  it('finds a visitor message without reply for longer than the threshold in work hours, once per client per hour', async () => {
    const s = setup();
    s.agent(1, 1);
    s.conv(1, 'w1'); s.conv(1, 'w2'); s.conv(1, 'w3'); s.conv(1, 'cab', 'cabinet');
    const now = s.clock.t; // 10:00 Dushanbe
    s.msg(1, 'w1', 'user', now - 20 * MIN); // too fresh
    s.msg(1, 'w2', 'user', now - 45 * MIN); // silent
    s.msg(1, 'w3', 'user', now - 50 * MIN); s.msg(1, 'w3', 'assistant', now - 49 * MIN); // answered
    s.msg(1, 'cab', 'user', now - 60 * MIN); // test chat
    const found = s.reports.silent();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ clientId: 1, agentId: 1, minutes: 45 });
    expect(await s.reports.downtimeTick()).toBe(1);
    expect(await s.reports.downtimeTick()).toBe(0); // same hour: deduped
    expect(s.group).toHaveLength(1);
    expect(s.group[0]).toContain('45 мин');
    expect(recentDowntime(s.db, 1)).toHaveLength(1);
    expect(s.hq.activity(10).some((a) => a.action === 'client_downtime')).toBe(true);
    // the next hour the incident is still open: one more alert
    s.clock.t = now + HOUR;
    expect(await s.reports.downtimeTick()).toBe(1);
    // a raised threshold hides the 45-minute silence
    s.hq.setSetting('alerts.downtimeMinutes', '240');
    s.clock.t = now + 2 * HOUR;
    expect(await s.reports.downtimeTick()).toBe(0);
  });

  it('a silence at night (outside work hours) is not an incident', () => {
    const s = setup(Date.UTC(2026, 10, 23, 22, 0)); // 03:00 Dushanbe
    s.agent(1, 1);
    s.conv(1, 'w1');
    s.msg(1, 'w1', 'user', s.clock.t - 2 * HOUR);
    expect(s.reports.silent()).toEqual([]);
  });
});
