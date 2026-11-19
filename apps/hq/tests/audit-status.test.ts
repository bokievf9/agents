import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { MockLlm, openDb, type LlmRequest } from '@fir/core';
import { MonitorStore } from '@fir/worker-monitoring';
import { describe, expect, it } from 'vitest';
import { auditHost, AuditGate, AuditStore, auditInputSchema, submitAudit } from '../src/audit-shared.js';
import { ClientBlockedError } from '../src/client/channel.js';
import { aggregate, buildStatus, mapCheck } from '../src/status.js';
import { createWebhook } from '../src/webhook.js';
import { routedLlm, world } from './helpers.js';

const OK = { url: 'https://lime.example/', contact: '@dilnoza', locale: 'ru' as const };

describe('/audit validation', () => {
  it('accepts a public http(s) URL, a Telegram username or a phone', () => {
    expect(auditInputSchema.safeParse({ ...OK, name: 'Дильноза', ref: 'site_footer' }).success).toBe(true);
    expect(auditInputSchema.safeParse({ ...OK, contact: '+998 90 123 45 67', locale: 'en' }).success).toBe(true);
    expect(auditInputSchema.safeParse({ ...OK, url: 'http://lime.example' }).success).toBe(true);
  });

  it('rejects: no dot, IP literals, local names, other schemes, long URLs, bad contacts, bad locale', () => {
    for (const url of ['https://localhost/', 'https://intranet/', 'http://127.0.0.1/', 'http://169.254.169.254/latest', 'ftp://lime.example/', 'javascript:alert(1)', 'https://user:pw@lime.example/', 'https://printer.local/', `https://lime.example/${'a'.repeat(200)}`, 'lime.example', '']) {
      expect(auditInputSchema.safeParse({ ...OK, url }).success, url).toBe(false);
    }
    for (const contact of ['ab', 'dilnoza', '@a', 'hello world', '12345', 'x'.repeat(65)]) expect(auditInputSchema.safeParse({ ...OK, contact }).success, contact).toBe(false);
    expect(auditInputSchema.safeParse({ ...OK, locale: 'uz' }).success).toBe(false);
    expect(auditInputSchema.safeParse({ ...OK, ref: 'bad ref!' }).success).toBe(false);
    expect(auditHost('https://LIME.example/x?y=1')).toBe('lime.example');
  });
});

describe('/audit limits', () => {
  it('one per contact per 24 h (case and spacing ignored), 20 an hour in total', () => {
    const w = world();
    const store = new AuditStore(w.db, w.hq.now);
    const gate = new AuditGate(w.hq.now);
    const made: unknown[] = [];
    const d = { store, gate, create: (a: unknown) => made.push(a) };
    expect(submitAudit(d, { ...OK, contact: '@Dilnoza' })).toBe('ok');
    // `create` is the only writer: the row is added by the head in production, so mimic it
    store.add({ ...OK, contact: '@Dilnoza' });
    expect(submitAudit(d, OK)).toBe('duplicate');
    w.clock.t += 24 * 3_600_000 + 1;
    expect(submitAudit(d, OK)).toBe('ok');
    const gate2 = new AuditGate(w.hq.now);
    for (let i = 0; i < 20; i++) expect(gate2.take()).toBe(true);
    expect(gate2.take()).toBe(false);
    w.clock.t += 3_600_001;
    expect(gate2.take()).toBe(true);
    expect(made).toHaveLength(2);
  });
});

async function server(w: ReturnType<typeof world>, gate = new AuditGate(w.hq.now)) {
  const s = createWebhook(
    () => Promise.resolve(1), 'secret', Date.now, undefined, undefined, undefined,
    {
      audit: { token: 'secret', handle: (a) => Promise.resolve(submitAudit({ store: new AuditStore(w.db, w.hq.now), gate, create: (x) => w.marketing.requestAudit(x) }, a)) },
      status: { get: () => buildStatus(w.db, w.hq.now()) },
    },
  );
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  return { s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}` };
}
const post = (url: string, token: string | null, b: unknown) =>
  fetch(`${url}/audit`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'x-lead-token': token } : {}) }, body: JSON.stringify(b) });

describe('POST /audit', () => {
  it('token, validation, task and row, duplicate answer', async () => {
    const w = world();
    const { s, url } = await server(w);
    try {
      expect((await post(url, null, OK)).status).toBe(401);
      expect((await post(url, 'wrong', OK)).status).toBe(401);
      expect((await post(url, 'secret', { ...OK, url: 'http://10.0.0.1/' })).status).toBe(400);
      const ok = await post(url, 'secret', { ...OK, name: 'Дильноза', ref: 'hero' });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ ok: true });
      const t = w.hq.tasks({ dept: 'marketing' }).find((x) => x.meta.action === 'audit')!;
      expect(t).toMatchObject({ title: 'Аудит: lime.example', status: 'inbox', meta: { action: 'audit', url: 'https://lime.example/' } });
      const row = new AuditStore(w.db, w.hq.now).get(Number(t.meta.auditId))!;
      expect(row).toMatchObject({ url: 'https://lime.example/', contact: '@dilnoza', name: 'Дильноза', locale: 'ru', ref: 'hero', status: 'queued' });
      const dup = await post(url, 'secret', OK);
      expect(await dup.json()).toEqual({ ok: true, duplicate: true });
      expect(w.hq.tasks({ dept: 'marketing' }).filter((x) => x.meta.action === 'audit')).toHaveLength(1);
    } finally {
      s.close();
    }
  });

  it('the 21st request within an hour answers 429', async () => {
    const w = world();
    const { s, url } = await server(w);
    try {
      for (let i = 0; i < 20; i++) expect((await post(url, 'secret', { ...OK, contact: `@user_number${i}` })).status).toBe(200);
      expect((await post(url, 'secret', { ...OK, contact: '@one_more_user' })).status).toBe(429);
    } finally {
      s.close();
    }
  });
});

const PAGE = '<html><head><title>Салон Лайм</title></head><body><h1>Салон</h1><a href="https://t.me/lime">tg</a></body></html>';
function auditLlm(): MockLlm {
  const base = routedLlm();
  return new MockLlm((req: LlmRequest) =>
    req.system.includes('free website audit')
      ? JSON.stringify({
          findings: Array.from({ length: 5 }, (_, i) => ({ problem: `Находка ${i + 1}: клиенты теряются`, fix: `Исправление ${i + 1}` })),
          closing: 'Наш «Бот-администратор» принимает заявки сам. Напишите в @firtech_bot.',
        })
      : base.complete(req) as unknown as string,
  );
}

describe('the audit through the Marketing head', () => {
  const cycle = (w: ReturnType<typeof world>) => w.marketing.onHeartbeat();

  it('task -> findings -> approval kind audit -> approved -> sent to a contact who wrote to the bot', async () => {
    const sent: { chatId: number; text: string }[] = [];
    const w = world({
      llm: auditLlm(), integrations: { fetch: () => Promise.resolve(new Response(PAGE)) },
      audit: { send: (chatId, text) => Promise.resolve(void sent.push({ chatId, text })), findChat: (u) => (u.toLowerCase() === '@dilnoza' ? 4242 : undefined) },
    });
    const { id, taskId } = w.marketing.requestAudit({ ...OK });
    await cycle(w);
    expect(w.hq.task(taskId)).toMatchObject({ status: 'approval' });
    expect(new AuditStore(w.db, w.hq.now).get(id)!.status).toBe('proposed');
    const q = w.hq.queuedApprovals();
    expect(q).toHaveLength(1);
    expect(q[0]!.kind).toBe('audit');
    expect(q[0]!.summary).toContain('Находка 1');
    expect(w.messenger.sent).toHaveLength(0); // the head never writes to the owner by itself
    await w.director.sendApprovalBatch(false);
    await w.decide('approve', w.queue.pending()[0]!.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.chatId).toBe(4242);
    expect(sent[0]!.text).toContain('lime.example');
    expect(sent[0]!.text).not.toMatch(/<|https?:\/\//);
    expect(new AuditStore(w.db, w.hq.now).get(id)).toMatchObject({ status: 'delivered' });
    expect(new AuditStore(w.db, w.hq.now).get(id)!.delivered).not.toBeNull();
  });

  it('a contact who never wrote to the bot: the owner gets the plain text to send by hand', async () => {
    const w = world({
      llm: auditLlm(), integrations: { fetch: () => Promise.resolve(new Response(PAGE)) },
      audit: { send: () => Promise.reject(new Error('should not be called')), findChat: () => undefined },
    });
    const { id } = w.marketing.requestAudit({ ...OK, contact: '+998901234567' });
    await cycle(w);
    await w.director.sendApprovalBatch(false);
    const before = w.messenger.sent.length;
    await w.decide('approve', w.queue.pending()[0]!.id);
    const note = w.messenger.sent.slice(before).find((m) => m.text.includes('отправьте вручную'))!;
    expect(note.text).toContain('lime.example');
    expect(note.text).toContain('+998901234567');
    expect(new AuditStore(w.db, w.hq.now).get(id)!.status).toBe('handed_off');
  });

  it('a blocked bot also falls back to the owner; a rejected audit is marked rejected', async () => {
    const w = world({
      llm: auditLlm(), integrations: { fetch: () => Promise.resolve(new Response(PAGE)) },
      audit: { send: (c) => Promise.reject(new ClientBlockedError(c)), findChat: () => 4242 },
    });
    const a = w.marketing.requestAudit(OK);
    const b = w.marketing.requestAudit({ ...OK, contact: '@other_person' });
    await cycle(w);
    await w.director.sendApprovalBatch(false);
    const [first, second] = w.queue.pending();
    await w.decide('approve', first!.id);
    await w.decide('reject', second!.id);
    const states = [new AuditStore(w.db, w.hq.now).get(a.id)!.status, new AuditStore(w.db, w.hq.now).get(b.id)!.status].sort();
    expect(states).toEqual(['handed_off', 'rejected']);
  });

  it('an unreachable URL still yields five findings and the Instagram request', async () => {
    const w = world({ llm: new MockLlm(() => 'не json'), integrations: { fetch: () => Promise.reject(new Error('ECONNREFUSED')) } });
    w.marketing.requestAudit({ ...OK, url: 'https://dead.example/' });
    await cycle(w);
    const q = w.hq.queuedApprovals()[0]!;
    expect(q.kind).toBe('audit');
    expect(String(q.payload.text)).toContain('Instagram');
    expect(String(q.payload.text).match(/^\d\. /gm)).toHaveLength(5);
  });
});

describe('/status aggregation from mon_* rows', () => {
  const NOW = Date.UTC(2026, 10, 19, 12, 0);
  const seed = () => {
    const db = openDb(':memory:');
    const m = new MonitorStore(db);
    const site = 'http:https://firtech.pro/api/health';
    m.saveState(site, { status: 'ok', fails: 0, failSince: 0 });
    m.saveState('tls:firtech.pro', { status: 'ok', fails: 0, failSince: 0 });
    m.saveState('omniroute', { status: 'down', fails: 3, failSince: NOW - 20 * 60_000 });
    m.saveState('disk', { status: 'ok', fails: 1, failSince: NOW - 60_000 });
    for (let i = 0; i < 10; i++) {
      m.sample(NOW - i * 3_600_000, site, true);
      m.sample(NOW - i * 3_600_000, 'omniroute', i >= 2);
      m.sample(NOW - i * 3_600_000, 'disk', true);
    }
    m.sample(NOW - 5 * 3_600_000, site, false); // one failed sample of 11
    m.openIncident('omniroute', NOW - 20 * 60_000, 'OmniRoute: http://omniroute:20128/healthz timed out');
    m.openIncident(site, NOW - 3 * 86_400_000, 'firtech.pro/api/health: HTTP 502');
    m.closeIncident(site, NOW - 3 * 86_400_000 + 600_000);
    m.openIncident('http:https://other.example/h', NOW - 86_400_000, 'other');
    m.openIncident(site, NOW - 40 * 86_400_000, 'too old');
    return db;
  };

  it('maps checks to public services and never to URLs', () => {
    expect(mapCheck('http:https://firtech.pro/api/health')).toEqual({ service: 'site', kind: 'http' });
    expect(mapCheck('http:https://www.firtech.pro/x')?.service).toBe('site');
    expect(mapCheck('http:https://evilfirtech.pro/x')).toBeNull();
    expect(mapCheck('http:https://other.example/h')).toBeNull();
    expect(mapCheck('omniroute')?.service).toBe('omniroute');
    expect(mapCheck('disk')?.service).toBe('hq');
    expect(mapCheck('docker')?.service).toBe('hq');
  });

  it('states, uptime and incidents', () => {
    const s = buildStatus(seed(), NOW);
    const by = Object.fromEntries(s.services.map((x) => [x.id, x]));
    expect(s.services.map((x) => x.id)).toEqual(['site', 'hq', 'bot', 'omniroute', 'polly', 'dono']);
    expect(by.site).toMatchObject({ state: 'up' });
    expect(by.omniroute).toMatchObject({ state: 'down', since: new Date(NOW - 20 * 60_000).toISOString(), note: 'The health check is failing' });
    expect(by.hq).toMatchObject({ state: 'degraded' }); // disk check failing intermittently
    for (const id of ['bot', 'polly', 'dono']) expect(by[id]).toMatchObject({ state: 'unknown' });
    expect(s.uptime30d.site).toBe(90.9);
    expect(s.uptime30d.omniroute).toBe(80);
    expect(s.uptime30d.bot).toBeUndefined();
    // the foreign URL and the 40-day-old incident are not public; newest first
    expect(s.incidents.map((i) => i.service)).toEqual(['omniroute', 'site']);
    expect(s.incidents[0]).toMatchObject({ title: 'AI gateway: health check failed' });
    expect(s.incidents[0]!.endedAt).toBeUndefined();
    expect(s.incidents[1]!.endedAt).toBeDefined();
  });

  it('HQ is up without any rows (it is answering); stalled checks degrade it; empty monitoring leaves the rest unknown', () => {
    const empty = aggregate({ states: [], perCheck: [], incidents: [], lastSampleAt: null }, NOW);
    expect(empty.services.map((x) => x.state)).toEqual(['unknown', 'up', 'unknown', 'unknown', 'unknown', 'unknown']);
    const stale = aggregate({ states: [], perCheck: [], incidents: [], lastSampleAt: NOW - 3_600_000 }, NOW);
    expect(stale.services.find((x) => x.id === 'hq')).toMatchObject({ state: 'degraded', note: 'Health checks are not running' });
  });

  it('caps incidents at 20', () => {
    const inc = Array.from({ length: 30 }, (_, i) => ({ checkId: 'omniroute', startedAt: NOW - i * 3_600_000, endedAt: NOW - i * 3_600_000 + 1000, detail: 'x' }));
    expect(aggregate({ states: [], perCheck: [], incidents: inc, lastSampleAt: null }, NOW).incidents).toHaveLength(20);
  });
});

describe('GET /status', () => {
  it('no token, cached headers, rate limited, and the body has no URLs, ports or tokens', async () => {
    const w = world();
    const m = new MonitorStore(w.db);
    m.saveState('http:https://firtech.pro/api/health', { status: 'down', fails: 2, failSince: w.hq.now() - 60_000 });
    m.saveState('omniroute', { status: 'ok', fails: 0, failSince: 0 });
    m.sample(w.hq.now(), 'omniroute', true);
    m.openIncident('http:https://firtech.pro/api/health', w.hq.now() - 60_000, 'firtech.pro/api/health: connect ECONNREFUSED 127.0.0.1:3000 token=abc');
    const { s, url } = await server(w);
    try {
      const r = await fetch(`${url}/status`);
      expect(r.status).toBe(200);
      expect(r.headers.get('cache-control')).toContain('max-age=60');
      const text = await r.text();
      expect(text).not.toMatch(/https?:|\/\/|:\d{4,5}\b|firtech\.pro|127\.0\.0|ECONNREFUSED|token|omniroute:/i);
      const body = JSON.parse(text) as { ok: boolean; services: { id: string; state: string }[]; incidents: unknown[]; uptime30d: Record<string, number> };
      expect(body.ok).toBe(true);
      expect(body.services.find((x) => x.id === 'site')!.state).toBe('down');
      expect(body.incidents).toHaveLength(1);
      let last = 200;
      for (let i = 0; i < 40; i++) last = (await fetch(`${url}/status`)).status;
      expect(last).toBe(429);
    } finally {
      s.close();
    }
  });
});
