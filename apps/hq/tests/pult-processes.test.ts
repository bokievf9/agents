/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { describe, expect, it } from 'vitest';
import { Drill } from '../src/drill.js';
import { CHAINS } from '../src/pult-processes.js';
import { OWNER } from './helpers.js';
import { pultWorld, serve } from './pult-helpers.js';

const HOUR = 3_600_000;
const stepOf = (json: any, chain: string, step: string) => json.chains.find((c: any) => c.id === chain).steps.find((s: any) => s.id === step);

describe('GET /admin/processes', () => {
  it('401 without the token, 404 for other paths and methods', async () => {
    const p = pultWorld();
    const s = await serve(p);
    expect((await s.http('GET', '/admin/processes', undefined, {})).status).toBe(401);
    expect((await s.http('GET', '/admin/processes')).status).toBe(200);
    await s.close();
    expect((await p.call('GET', '/admin/processes/nope')).status).toBe(404);
    expect((await p.call('PATCH', '/admin/processes', {})).status).toBe(404);
  });

  it('the chain map in the contract shape: every chain of the table, every step with health, last success, failures, stuck', async () => {
    const p = pultWorld();
    const r = await p.call('GET', '/admin/processes');
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.windowDays).toBe(7);
    expect(r.json.chains.map((c: any) => c.id)).toEqual(CHAINS.map((c) => c.id));
    for (const c of r.json.chains) {
      expect(['ok', 'warn', 'fail', 'idle']).toContain(c.health);
      for (const s of c.steps) expect(Object.keys(s).sort()).toEqual(['failures7d', 'health', 'hint', 'id', 'lastFailure', 'lastOkAt', 'stuck', 'title']);
    }
    // a fresh company has no history: every step is idle and nothing throws on tables that do not exist yet
    expect(r.json.counts.fail + r.json.counts.warn).toBe(0);
    expect(r.json.drill).toBeNull(); // no drill wired in this world
  });

  it('health from the data: last success, a failure after it, a stuck item; drill tasks are ignored', async () => {
    const p = pultWorld();
    const hq = p.w.hq;
    // lead step: a blocked intake task is a failure with its reason; a drill task of the same worker is not counted
    const t = hq.createTask({ title: 'Лид Анна', dept: 'sales', creator: 'routine', assigneeId: 'lead-intake' });
    hq.block(t.id, 'lead-intake', 'Сбой: шаблон [цена]');
    const d = hq.createTask({ title: 'Учения: лид', dept: 'sales', creator: 'owner', tags: ['drill'], assigneeId: 'lead-intake' });
    hq.block(d.id, 'lead-intake', 'drill failure');
    let r = await p.call('GET', '/admin/processes');
    const lead = stepOf(r.json, 'client', 'lead');
    expect(lead.health).toBe('fail');
    expect(lead.failures7d).toBe(1);
    expect(lead.lastFailure.text).toContain('шаблон');
    expect(r.json.chains[0].health).toBe('fail');

    // paid step: an issued invoice past its due date is stuck, a paid one is the last success
    p.w.hq.db.exec(`CREATE TABLE IF NOT EXISTS bl_invoices (id INTEGER PRIMARY KEY, number TEXT, client TEXT, status TEXT, due_date TEXT, created_at INTEGER, issued_at INTEGER, paid_at INTEGER)`);
    const now = p.t();
    p.w.hq.db.prepare("INSERT INTO bl_invoices (number, client, status, due_date, created_at, paid_at) VALUES ('FT-1', 'A', 'paid', '2020-01-01', ?, ?)").run(now - 5 * HOUR, now - HOUR);
    r = await p.call('GET', '/admin/processes');
    expect(stepOf(r.json, 'client', 'paid')).toMatchObject({ health: 'ok', stuck: 0 });
    p.w.hq.db.prepare("INSERT INTO bl_invoices (number, client, status, due_date, created_at) VALUES ('FT-2', 'B', 'issued', '2020-01-02', ?)").run(now - 5 * HOUR);
    r = await p.call('GET', '/admin/processes');
    expect(stepOf(r.json, 'client', 'paid')).toMatchObject({ health: 'warn', stuck: 1 });
    expect(r.json.counts.fail).toBeGreaterThanOrEqual(1);
  });

  it('a failure older than the last success is only a warning', async () => {
    const p = pultWorld();
    const hq = p.w.hq;
    const t = hq.createTask({ title: 'Тренды', dept: 'marketing', creator: 'routine', assigneeId: 'trend-scout' });
    hq.block(t.id, 'trend-scout', 'сеть');
    p.w.clock.t += HOUR;
    const ok = hq.createTask({ title: 'Тренды 2', dept: 'marketing', creator: 'routine', assigneeId: 'trend-scout' });
    hq.claim(ok.id, 'trend-scout');
    hq.complete(ok.id, 'trend-scout', 'готово');
    const r = await p.call('GET', '/admin/processes');
    expect(stepOf(r.json, 'content', 'trends')).toMatchObject({ health: 'warn', failures7d: 1 });
  });
});

describe('POST /admin/processes/drill', () => {
  const withDrill = () => {
    const ref: { drill?: Drill } = {};
    const p = pultWorld({ admin: { drill: (a) => ref.drill!.command(a), drillStatus: () => ref.drill!.status() } });
    ref.drill = new Drill({ hq: p.w.hq, queue: p.w.queue, messenger: p.w.channel!, ownerId: OWNER });
    return p;
  };

  it('503 without a drill, 400 for a bad body', async () => {
    expect((await pultWorld().call('POST', '/admin/processes/drill', { action: 'start' })).status).toBe(503);
    const p = withDrill();
    expect((await p.call('POST', '/admin/processes/drill', { action: 'boom' })).status).toBe(400);
    expect((await p.call('POST', '/admin/processes/drill', {})).status).toBe(400);
  });

  it('start runs the existing drill (tagged tasks), the table shows in the map, clear removes everything', async () => {
    const p = withDrill();
    const before = p.w.hq.tasks({ limit: 1000 }).length;
    const r = await p.call('POST', '/admin/processes/drill', { action: 'start' });
    expect(r.status).toBe(200);
    expect(r.json.text).toMatch(/Учения/);
    expect(r.json.drill.state).toBe('running');
    expect(r.json.drill.rows.length).toBeGreaterThan(5);
    const tagged = p.w.hq.tasks({ tag: 'drill', limit: 1000 });
    expect(tagged.length).toBeGreaterThan(0);
    const map = await p.call('GET', '/admin/processes');
    expect(map.json.drill.rows.length).toBe(r.json.drill.rows.length);
    // a second start while it runs does not duplicate
    const again = await p.call('POST', '/admin/processes/drill', { action: 'start' });
    expect(again.json.text).toMatch(/ещё идут/);
    expect(p.w.hq.tasks({ tag: 'drill', limit: 1000 }).length).toBe(tagged.length);
    // drill tasks never count as failures of the real chains
    expect(map.json.counts.fail).toBe(0);

    const c = await p.call('POST', '/admin/processes/drill', { action: 'clear' });
    expect(c.status).toBe(200);
    expect(c.json.text).toMatch(/очищены/);
    expect(c.json.drill.state).toBe('none');
    expect(p.w.hq.tasks({ tag: 'drill', limit: 1000 })).toHaveLength(0);
    expect(p.w.hq.tasks({ limit: 1000 }).length).toBe(before);
  });
});
