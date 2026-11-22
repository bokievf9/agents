/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { describe, expect, it } from 'vitest';
import { Calls } from '../src/calls.js';
import { shellWorld, serve } from './shell-helpers.js';

const DAY = 86_400_000;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

describe('GET /admin/calendar', () => {
  it('401 without the token, 404 for other paths and methods, 400 for a bad or too long range', async () => {
    const p = shellWorld();
    const s = await serve(p);
    expect((await s.http('GET', '/admin/calendar?from=2026-11-01&to=2026-11-07', undefined, {})).status).toBe(401);
    expect((await s.http('GET', '/admin/calendar?from=2026-11-01&to=2026-11-07')).status).toBe(200);
    await s.close();
    expect((await p.call('GET', '/admin/calendar/nope')).status).toBe(404);
    expect((await p.call('POST', '/admin/calendar', {})).status).toBe(404);
    expect((await p.call('GET', '/admin/calendar')).status).toBe(400);
    expect((await p.call('GET', '/admin/calendar?from=2026-11-09&to=2026-11-01')).status).toBe(400);
    const long = await p.call('GET', '/admin/calendar?from=2026-01-01&to=2026-06-01');
    expect(long.status).toBe(400);
    expect(long.json.error).toBe('range_too_long');
  });

  it('routines of the range, sorted, in the contract shape; a disabled routine has no runs', async () => {
    const p = shellWorld();
    const from = dayOf(p.t());
    const to = dayOf(p.t() + 6 * DAY);
    const r = await p.call('GET', `/admin/calendar?from=${from}&to=${to}`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, from, to });
    expect(r.json.counts.routine).toBeGreaterThan(0);
    for (const e of r.json.events) expect(Object.keys(e).sort()).toEqual(['allDay', 'at', 'dept', 'detail', 'id', 'kind', 'link', 'status', 'title']);
    const ats = r.json.events.map((e: any) => e.at);
    expect([...ats].sort()).toEqual(ats);
    const daily = r.json.events.filter((e: any) => e.link === 'routines:marketing-daily-today');
    expect(daily.length).toBeGreaterThanOrEqual(6);
    await p.call('POST', '/admin/company/routines/marketing-daily-today', { enabled: false });
    const again = await p.call('GET', `/admin/calendar?from=${from}&to=${to}`);
    expect(again.json.events.filter((e: any) => e.link === 'routines:marketing-daily-today')).toHaveLength(0);
  });

  it('calls, milestones and content in the range; cancelled calls, drafts and other days stay out', async () => {
    const p = shellWorld();
    const db = p.w.hq.db;
    const lead = p.lead('Анна', { service: 'bot' });
    void new Calls({ hq: p.w.hq }); // creates call_bookings
    const at = p.t() + 2 * DAY;
    db.prepare("INSERT INTO call_bookings (lead_id, at, state, source, created_at, updated_at) VALUES (?, ?, 'confirmed', 'pult', ?, ?)").run(lead.id, at, p.t(), p.t());
    const gone = p.lead('Борис');
    db.prepare("INSERT INTO call_bookings (lead_id, at, state, source, created_at, updated_at) VALUES (?, ?, 'cancelled', 'pult', ?, ?)").run(gone.id, at, p.t(), p.t());
    db.exec(`CREATE TABLE IF NOT EXISTS pm_projects (id INTEGER PRIMARY KEY, client TEXT, what TEXT, product TEXT, status TEXT);
             CREATE TABLE IF NOT EXISTS pm_milestones (id INTEGER PRIMARY KEY, project_id INTEGER, kind TEXT, title TEXT, due_at INTEGER, status TEXT)`);
    db.prepare("INSERT INTO pm_projects (id, client, what, product, status) VALUES (1, 'Салон', 'сайт', 'site', 'active'), (2, 'Черновик', 'бот', 'bot', 'draft')").run();
    db.prepare("INSERT INTO pm_milestones (project_id, kind, title, due_at, status) VALUES (1, 'prototype', 'Прототип', ?, 'open'), (1, 'delivery', 'Сдача', ?, 'open'), (2, 'brief', 'Бриф', ?, 'open')").run(at, at + 30 * DAY, at);
    db.exec(`CREATE TABLE IF NOT EXISTS cm_items (id INTEGER PRIMARY KEY, type TEXT, title TEXT, status TEXT, planned_date TEXT)`);
    db.prepare("INSERT INTO cm_items (type, title, status, planned_date) VALUES ('clip', 'Рилс про бота', 'approved', ?), ('post', 'Отклонён', 'rejected', ?)").run(dayOf(at), dayOf(at));
    const r = await p.call('GET', `/admin/calendar?from=${dayOf(p.t())}&to=${dayOf(p.t() + 6 * DAY)}`);
    const byKind = (k: string) => r.json.events.filter((e: any) => e.kind === k);
    expect(byKind('call')).toHaveLength(1);
    expect(byKind('call')[0]).toMatchObject({ title: 'Анна', status: 'confirmed', link: `calls:${lead.id}`, dept: 'sales' });
    expect(byKind('milestone').map((e: any) => e.title)).toEqual(['Прототип']);
    expect(byKind('milestone')[0]).toMatchObject({ link: 'projects:1', detail: 'Салон' });
    expect(byKind('content')).toHaveLength(1);
    expect(byKind('content')[0]).toMatchObject({ title: 'Рилс про бота', allDay: true, link: expect.stringMatching(/^content:item:\d+$/) });
  });
});
