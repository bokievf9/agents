/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import { MockLlm, openDb } from '@fir/core';
import { Hq } from '@fir/hq';
import { describe, expect, it } from 'vitest';
import { ensureCabinetTables } from '../src/cabinet.js';
import { WebChatEngine } from '../src/client/web.js';
import { DemoUsage, demoUsageOf, tapLlm } from '../src/demo-usage.js';
import { Playground } from '../src/playground.js';
import { NOW } from './helpers.js';

const DAY = 86_400_000;
const USAGE = { inputTokens: 1000, outputTokens: 200, model: 'claude-sonnet-5-5' };

function world(o: { limit?: number; require?: boolean } = {}) {
  const db = openDb(':memory:');
  const clock = { t: NOW };
  new Hq(db, { now: () => clock.t });
  ensureCabinetTables(db);
  const mock = new MockLlm(() => JSON.stringify({ reply: 'Здравствуйте!' }), USAGE);
  const llm = tapLlm(mock);
  const demoUsage = new DemoUsage({ db, now: () => clock.t, tz: () => 'Asia/Dushanbe', limit: () => o.limit ?? 3 });
  const gate = { llmAllowed: () => true, llmUsed: () => undefined };
  const web = new WebChatEngine({ db, now: () => clock.t, tz: () => 'Asia/Dushanbe', llm, instructions: 'x', gate, demoUsage, demoRequireClient: o.require ?? false });
  const pg = new Playground({ db, now: () => clock.t, tz: () => 'Asia/Dushanbe', llm, secret: 'unit-secret', demoUsage, demoRequireClient: o.require ?? false });
  const say = (extra: Record<string, unknown> = {}, sid = 'visitor-0001-abcd') =>
    web.handle({ sessionId: sid, locale: 'ru', message: 'Привет', persona: 'salon', ...extra } as any, '1.2.3.4');
  return { db, clock, web, pg, demoUsage, say, mock };
}
const ME = { clientEmail: 'Liza@Example.com', cabinetId: 'sb-liza-1', clientName: 'Лиза', demo: true };

describe('the site demo tab (/chat with persona) is booked to the signed-in client', () => {
  it('counts the message, the tokens and the money, and answers limit, remaining and usage', async () => {
    const { db, say } = world();
    const r = await say(ME);
    expect(r.kind).toBe('ok');
    const body = (r as any).body;
    expect(body).toMatchObject({ demo: true, limit: 3, remaining: 2, usage: { limit: 3, used: 1, remaining: 2 } });
    const row = db.prepare('SELECT * FROM demo_usage').get() as any;
    expect(row).toMatchObject({ source: 'persona:salon', calls: 1, tokens_in: 1000, tokens_out: 200 });
    expect(row.usd).toBeGreaterThan(0);
    // the account was made from the email (lower case) with the Supabase id
    expect(db.prepare('SELECT email, name, supabase_id FROM cab_clients').get()).toEqual({ email: 'liza@example.com', name: 'Лиза', supabase_id: 'sb-liza-1' });
  });

  it('the cap of the day: the 4th message is refused with 429 data, nothing more is counted, tomorrow it is free again', async () => {
    const { db, say, clock } = world();
    for (let i = 0; i < 3; i++) expect((await say(ME, `visitor-000${i}-abcd`)).kind).toBe('ok');
    const over = await say(ME, 'visitor-0009-abcd');
    expect(over).toMatchObject({ kind: 'limit', body: { ok: false, error: 'limit_reached', limit: 3, remaining: 0, usage: { used: 3 } } });
    expect((db.prepare('SELECT SUM(calls) n FROM demo_usage').get() as any).n).toBe(3);
    clock.t += DAY;
    expect((await say(ME, 'visitor-0010-abcd')).kind).toBe('ok');
  });

  it('an anonymous demo stays free by default; DEMO_REQUIRE_CLIENT refuses it with login_required, a client still passes', async () => {
    const a = world();
    const anon = await a.say({});
    expect(anon.kind).toBe('ok');
    expect('limit' in (anon as any).body).toBe(false);
    expect((a.db.prepare('SELECT COUNT(*) n FROM demo_usage').get() as any).n).toBe(0);
    const b = world({ require: true });
    expect((await b.say({})).kind).toBe('login_required');
    expect((await b.say(ME)).kind).toBe('ok');
  });

  it('a client may be named by the Supabase id (cabinetId or clientId) or the HQ id when it is already known', async () => {
    const { say, db } = world();
    await say(ME);
    const id = (db.prepare('SELECT id FROM cab_clients').get() as any).id as number;
    expect((await say({ clientId: 'sb-liza-1', demo: true }, 'visitor-0002-abcd') as any).body.usage.used).toBe(2);
    expect((await say({ clientId: String(id) }, 'visitor-0003-abcd') as any).body.usage.used).toBe(3);
    // an unknown id is anonymous, not a new client
    expect((await say({ clientId: 'nobody-here' }, 'visitor-0004-abcd') as any).body.usage).toBeUndefined();
  });
});

describe('DEMO_REQUIRE_CLIENT default', () => {
  it('is on unless the env explicitly says off', async () => {
    const { loadConfig } = await import('../src/config.js');
    const base = { HQ_BOT_TOKEN: '1:abc', OWNER_TELEGRAM_ID: '1' };
    expect(loadConfig(base).demoRequireClient).toBe(true);
    expect(loadConfig({ ...base, DEMO_REQUIRE_CLIENT: '' }).demoRequireClient).toBe(true);
    expect(loadConfig({ ...base, DEMO_REQUIRE_CLIENT: 'on' }).demoRequireClient).toBe(true);
    for (const v of ['off', 'OFF', '0', 'false', 'no']) expect(loadConfig({ ...base, DEMO_REQUIRE_CLIENT: v }).demoRequireClient, v).toBe(false);
  });
});

describe('the agent routes', () => {
  it('POST /agent/demo-<niche>/chat books the client, answers the usage, and stops at the cap (429 limit_reached with the fields)', async () => {
    const { pg, db } = world({ limit: 2 });
    db.prepare("INSERT INTO cab_clients (email, name, supabase_id, created_at, updated_at) VALUES ('liza@example.com', 'Лиза', 'sb-liza-1', 1, 1)").run();
    const ask = (n: number, extra: Record<string, unknown> = ME) => pg.handlePublic('demo-salon', { token: '', origin: '', trusted: true, body: { sessionId: `session-${n}-abcdef`, text: 'Здравствуйте', ...extra } });
    const r1 = await ask(1);
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ ok: true, limit: 2, remaining: 1, usage: { used: 1 } });
    expect((await ask(2)).body).toMatchObject({ remaining: 0 });
    const over = await ask(3);
    expect(over.status).toBe(429);
    expect(over.body).toMatchObject({ ok: false, error: 'limit_reached', limit: 2, remaining: 0, usage: { limit: 2, used: 2, remaining: 0 } });
    expect(db.prepare('SELECT source, calls FROM demo_usage').all()).toEqual([{ source: 'agent:demo-salon', calls: 2 }]);
    // without an identity the preview is as before
    const anon = await ask(4, {});
    expect(anon.status).toBe(200);
    expect(anon.body.usage).toBeUndefined();
  });

  it('with demoRequireClient the preview answers 401 login_required to an anonymous call', async () => {
    const { pg } = world({ require: true });
    const r = await pg.handlePublic('demo-salon', { token: '', origin: '', body: { sessionId: 'session-1-abcdef', text: 'Здравствуйте' } });
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ ok: false, error: 'login_required' });
  });

  it('the lead\'s demo link (demoKey) is counted to the client too, with the usage in the answer; the cap shares the day with the other sources', async () => {
    const { pg, db } = world({ limit: 2 });
    db.prepare("INSERT INTO cab_clients (id, email, name, created_at, updated_at) VALUES (5, 'owner@example.com', 'Владелец', 1, 1)").run();
    const made = (pg as any).insertAgent(0, 7, null, { company: 'Салон', niche: 'салон красоты', goals: [], tone: '', languages: ['ru'] });
    const publicId = (db.prepare('SELECT public_id FROM pg_agents WHERE id = ?').get(made.id) as any).public_id as string;
    const key = pg.demoKey(publicId)!;
    const ask = (extra: Record<string, unknown>) => pg.handlePublic(publicId, { token: '', origin: '', trusted: true, body: { demoKey: key, text: 'Здравствуйте', conversationId: 'conv-0000001', ...extra } });
    const r1 = await ask({ clientId: '5', demo: true });
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ mode: 'demo', usage: { limit: 2, used: 1, remaining: 1 } });
    // the preview spends the same cap
    await pg.handlePublic('demo-clinic', { token: '', origin: '', trusted: true, body: { sessionId: 'session-1-abcdef', text: 'Привет', clientId: '5' } });
    const over = await ask({ clientId: '5' });
    expect(over.status).toBe(429);
    expect(over.body).toMatchObject({ error: 'limit_reached', remaining: 0 });
  });
});

describe('reading the usage: the 30 days of a client and the morning line', () => {
  it('block(): messages, tokens, money, today and per source over 30 days; older days drop out', async () => {
    const { demoUsage, clock, say, db } = world({ limit: 50 });
    await say(ME);
    await say(ME, 'visitor-0002-abcd');
    const id = (db.prepare('SELECT id FROM cab_clients').get() as any).id as number;
    clock.t += 10 * DAY;
    await say(ME, 'visitor-0003-abcd');
    const b = demoUsageOf(db, id, clock.t, 'Asia/Dushanbe');
    expect(b).toMatchObject({ days: 30, messages: 3, tokensIn: 3000, tokensOut: 600, today: 1, bySource: [{ source: 'persona:salon', messages: 3 }] });
    expect(b.usd).toBeGreaterThan(0);
    expect(demoUsage.block(id)).toEqual(b);
    clock.t += 25 * DAY;
    expect(demoUsageOf(db, id, clock.t, 'Asia/Dushanbe').messages).toBe(1);
    expect(demoUsageOf(db, 999, clock.t, 'Asia/Dushanbe')).toMatchObject({ messages: 0, usd: 0, bySource: [] });
  });

  it('summaryLine(): «Демо на сайте за сутки: N клиентов, M сообщений, $X», null when nobody tried', async () => {
    const { demoUsage, say, clock } = world({ limit: 50 });
    expect(demoUsage.summaryLine()).toBeNull();
    await say(ME);
    await say({ ...ME, clientEmail: 'two@example.com', cabinetId: 'sb-two' }, 'visitor-0002-abcd');
    await say({ ...ME, clientEmail: 'two@example.com', cabinetId: 'sb-two' }, 'visitor-0003-abcd');
    expect(demoUsage.summaryLine()).toMatch(/^Демо на сайте за сутки: 2 клиента, 3 сообщения, \$0\.\d\d\.$/);
    clock.t += 3 * DAY;
    expect(demoUsage.summaryLine()).toBeNull();
  });
});

describe('M1: the identity of a public demo request counts only with the site token', () => {
  it('without it the body names nobody: no usage fields, no cab_clients row, nothing counted; with it the client is metered but still never created', async () => {
    const { pg, db } = world({ limit: 2, require: true });
    const body = { sessionId: 'session-9-abcdef', text: 'Здравствуйте', clientEmail: 'victim@example.com', cabinetId: 'sb-fake-1', demo: true };
    const anon = await pg.handlePublic('demo-salon', { token: '', origin: '', body });
    expect(anon.status).toBe(401);
    expect(anon.body).toMatchObject({ error: 'login_required' });
    expect((db.prepare('SELECT COUNT(*) n FROM cab_clients').get() as any).n).toBe(0);
    // the site's server: an email HQ has not met is not created by the demo, so nobody is identified
    const unknown = await pg.handlePublic('demo-salon', { token: '', origin: '', trusted: true, body });
    expect(unknown.status).toBe(401);
    expect((db.prepare('SELECT COUNT(*) n FROM cab_clients').get() as any).n).toBe(0);
    // a client the cabinet already created is metered when the site names him
    db.prepare("INSERT INTO cab_clients (id, email, name, created_at, updated_at) VALUES (7, 'victim@example.com', 'V', 1, 1)").run();
    const ok = await pg.handlePublic('demo-salon', { token: '', origin: '', trusted: true, body });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ usage: { used: 1 } });
    // an untrusted browser cannot burn his limit
    const burn = await pg.handlePublic('demo-salon', { token: '', origin: '', body });
    expect(burn.status).toBe(401);
  });
});
