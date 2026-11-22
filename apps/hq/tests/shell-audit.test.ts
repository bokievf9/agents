/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { describe, expect, it } from 'vitest';
import { shellWorld, serve } from './shell-helpers.js';

const SCHEMA = `CREATE TABLE IF NOT EXISTS settings_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, key TEXT NOT NULL, old TEXT NOT NULL, new TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'owner')`;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

describe('GET /admin/audit', () => {
  it('401 without the token, 404 for other paths and methods, 400 for bad filters', async () => {
    const p = shellWorld();
    const s = await serve(p);
    expect((await s.http('GET', '/admin/audit', undefined, {})).status).toBe(401);
    expect((await s.http('GET', '/admin/audit')).status).toBe(200);
    await s.close();
    expect((await p.call('GET', '/admin/audit/x')).status).toBe(404);
    expect((await p.call('POST', '/admin/audit', {})).status).toBe(404);
    expect((await p.call('GET', '/admin/audit?kind=nope')).status).toBe(400);
    expect((await p.call('GET', '/admin/audit?from=yesterday')).status).toBe(400);
    expect((await p.call('GET', '/admin/audit?from=2026-11-09&to=2026-11-01')).status).toBe(400);
    expect((await p.call('GET', '/admin/audit?limit=abc')).status).toBe(400);
    expect((await p.call('GET', '/admin/audit?cursor=zz')).status).toBe(400);
  });

  it('merges decisions, settings, instructions, trust and owner actions without any text or value', async () => {
    const p = shellWorld();
    const db = p.w.hq.db;
    db.exec(SCHEMA);
    const t = p.t();
    db.prepare("INSERT INTO decisions (approval_id, kind, decision, at) VALUES (7, 'lead_reply', 'approve', ?), (8, 'content_item', 'auto', ?)").run(t - 5000, t - 4000);
    db.prepare("INSERT INTO settings_log (at, key, old, new, source) VALUES (?, 'quiet_hours', 'SECRET-OLD', 'SECRET-NEW', 'owner'), (?, 'trust.levels.lead_reply', '0', '1', 'owner')").run(t - 3000, t - 2000);
    p.w.hq.log('owner', 'level_set', 'kind', 'lead_reply', '1');
    p.w.hq.log('owner', 'chat_reply', 'chat', 'c1', 'web:sent');
    p.w.hq.log('director', 'task_created', 'task', '1');
    const marketing = p.w.hq.agent('marketing-head')!;
    p.w.hq.setInstructions(marketing.id, 'ТЕКСТ ИНСТРУКЦИИ НЕ ДОЛЖЕН УЙТИ', 'owner');
    const r = await p.call('GET', '/admin/audit');
    expect(r.status).toBe(200);
    expect(r.json.kinds).toEqual(['decision', 'setting', 'instruction', 'trust', 'owner']);
    expect(r.json.counts).toMatchObject({ decision: 2, setting: 1, trust: 2, owner: 1 });
    const text = JSON.stringify(r.json);
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('ИНСТРУКЦИИ');
    const kinds = r.json.entries.map((e: any) => e.kind);
    expect(new Set(kinds)).toEqual(new Set(['decision', 'setting', 'instruction', 'trust', 'owner']));
    for (const e of r.json.entries) expect(Object.keys(e).sort()).toEqual(['action', 'actor', 'at', 'detail', 'id', 'kind', 'objectId', 'objectType']);
    const ats = r.json.entries.map((e: any) => e.at);
    expect([...ats].sort().reverse()).toEqual(ats);
    expect(r.json.entries.find((e: any) => e.kind === 'instruction' && e.actor === 'owner')).toMatchObject({ objectId: marketing.id, action: 'instructions_changed' });
    expect(r.json.counts.instruction).toBeGreaterThanOrEqual(1);
    expect(r.json.entries.find((e: any) => e.id === 'dec:2')).toMatchObject({ actor: 'system', detail: 'content_item auto' });
    expect(r.json.actors).toContain('owner');
    expect(r.json.actors).toContain('system');
  });

  it('filters by kind, actor and date; the cursor pages without gaps or repeats', async () => {
    const p = shellWorld();
    const db = p.w.hq.db;
    const t = p.t();
    for (let i = 0; i < 7; i++) db.prepare("INSERT INTO decisions (approval_id, kind, decision, at) VALUES (?, 'k', ?, ?)").run(i, i % 2 ? 'reject' : 'approve', t - i * 1000);
    db.prepare("INSERT INTO decisions (approval_id, kind, decision, at) VALUES (99, 'k', 'auto', ?)").run(t - 100 * 86_400_000);
    p.w.hq.log('owner', 'chat_reply', 'chat', 'c1', 'web:sent');
    expect((await p.call('GET', '/admin/audit?kind=owner')).json.entries).toHaveLength(1);
    const sys = await p.call('GET', '/admin/audit?actor=system');
    expect(sys.json.entries).toHaveLength(1);
    const recent = await p.call('GET', `/admin/audit?kind=decision&from=${day(t - 3 * 86_400_000)}&to=${day(t + 86_400_000)}`);
    expect(recent.json.counts.decision).toBe(7);
    const seen: string[] = [];
    let cursor = '';
    for (let i = 0; i < 10; i++) {
      const r = await p.call('GET', `/admin/audit?limit=3${cursor ? `&cursor=${cursor}` : ''}`);
      expect(r.status).toBe(200);
      seen.push(...r.json.entries.map((e: any) => e.id));
      if (!r.json.nextCursor) break;
      cursor = r.json.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(9);
  });
});
