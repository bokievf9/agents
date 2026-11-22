/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { describe, expect, it } from 'vitest';
import { shellWorld, serve } from './shell-helpers.js';

describe('GET /admin/analytics', () => {
  it('401 without the token, 404 for other paths and methods, 400 for a bad week', async () => {
    const p = shellWorld();
    const s = await serve(p);
    expect((await s.http('GET', '/admin/analytics', undefined, {})).status).toBe(401);
    expect((await s.http('GET', '/admin/analytics')).status).toBe(200);
    await s.close();
    expect((await p.call('GET', '/admin/analytics/x')).status).toBe(404);
    expect((await p.call('POST', '/admin/analytics', {})).status).toBe(404);
    expect((await p.call('GET', '/admin/analytics?week=2026-11')).status).toBe(400);
  });

  it('empty company: zeros and nulls in the contract shape', async () => {
    const p = shellWorld();
    const r = await p.call('GET', '/admin/analytics');
    expect(r.status).toBe(200);
    expect(Object.keys(r.json).sort()).toEqual(['firstResponse', 'from', 'funnel', 'ok', 'prevFirstResponse', 'prevFunnel', 'prevSite', 'prevWeek', 'site', 'sources', 'to', 'tz', 'week']);
    expect(r.json.funnel).toEqual({ leads: 0, qualified: 0, proposals: 0, contracts: 0, paid: 0, projects: 0 });
    expect(r.json.firstResponse).toEqual({ leads: 0, answered: 0, avgMinutes: null, medianMinutes: null, within1hShare: null });
    expect(r.json.sources).toEqual([]);
  });

  it('first answer time, sources and the funnel of the week agree with the weekly numbers', async () => {
    const p = shellWorld();
    const a = p.lead('Анна', { contact: '@anna' });
    const b = p.lead('Борис', { contact: '@boris' });
    p.lead('Вера');
    const db = p.w.hq.db;
    db.prepare("UPDATE li_leads SET origin = 'ref:partner' WHERE id = ?").run(b.id);
    db.prepare("INSERT INTO task_events (task_id, kind, actor, body, at) VALUES (?, 'report', 'sales-head', 'ТЕКСТ КЛИЕНТА', ?)").run(a.taskId, p.t() + 10 * 60_000);
    p.w.hq.log('owner', 'lead_reply', 'lead', String(b.id), 'web:sent');
    db.prepare("UPDATE activity SET at = ? WHERE action = 'lead_reply'").run(p.t() + 50 * 60_000);
    const r = await p.call('GET', '/admin/analytics');
    expect(r.json.funnel.leads).toBe(3);
    const w = await p.call('GET', '/admin/metrics/week');
    expect(r.json.funnel).toEqual(w.json.funnel);
    expect(r.json.firstResponse).toMatchObject({ leads: 3, answered: 2, avgMinutes: 30, medianMinutes: 30, within1hShare: 1 });
    expect(r.json.sources.find((s: any) => s.source === 'site')).toMatchObject({ leads: 2 });
    expect(r.json.sources.find((s: any) => s.source === 'ref')).toMatchObject({ leads: 1 });
    expect(JSON.stringify(r.json)).not.toMatch(/Анна|@anna|КЛИЕНТА/);
  });
});
