import { HostQueue, createTools, openDb } from '@fir/core';
import { describe, expect, it } from 'vitest';
import {
  BOT_SILENCE_MS, DAY_MS, MonitoringWorker, checkServices, containerHealth, MonitorStore, checkBot, checkDisk, containerProblems, dailyLine, isHealthy, parseCertDays, parseMonitorUrls, step,
  type BotProbe, type CheckDeps, type MonitorConfig,
} from '../src/index.js';

const NOW = Date.UTC(2026, 10, 18, 7, 0);
const cfg: MonitorConfig = {
  urls: ['https://firtech.pro/api/health'], omnirouteUrl: 'http://omniroute:20128/healthz', dataDir: '/data', docker: false,
  dockerSocket: '/s', diskMaxPct: 85, certMinDays: 14, timeoutMs: 1000,
};

function world(over: Partial<CheckDeps> = {}) {
  const st = { t: NOW, healthy: true, omni: true, days: 60, used: 50, containers: [{ name: 'hq', state: 'running', status: 'Up' }], fetched: [] as { url: string; auth: unknown }[] };
  const deps: CheckDeps = {
    now: () => st.t,
    fetch: ((url: string, init?: { headers?: Record<string, string> }) => {
      st.fetched.push({ url: String(url), auth: init?.headers?.authorization });
      const ok = String(url).includes('omniroute') ? st.omni : st.healthy;
      return Promise.resolve(new Response(ok ? '{"ok":true}' : 'down', { status: ok ? 200 : 503 }));
    }) as unknown as typeof fetch,
    certValidTo: () => Promise.resolve(new Date(st.t + st.days * DAY_MS).toUTCString()),
    statfs: () => Promise.resolve({ blocks: 1000, bavail: 1000 - st.used * 10 }),
    listContainers: () => Promise.resolve(st.containers),
    ...over,
  };
  return { st, deps, db: openDb(':memory:') };
}

describe('hysteresis', () => {
  it('one failure is silent, two alert once, no repeats, one recovery', () => {
    let s = step(undefined, true, 0);
    expect(s.event).toBeNull();
    s = step(s.next, false, 1);
    expect(s.event).toBeNull();
    s = step(s.next, false, 2);
    expect(s.event).toBe('down');
    for (let i = 3; i < 8; i++) {
      s = step(s.next, false, i);
      expect(s.event).toBeNull();
    }
    s = step(s.next, true, 600_000);
    expect(s).toMatchObject({ event: 'recovered', downMs: 599_999 });
    expect(step(s.next, true, 700_000).event).toBeNull();
  });

  it('a pass between failures resets the streak', () => {
    let s = step(undefined, false, 1);
    s = step(s.next, true, 2);
    s = step(s.next, false, 3);
    expect(s.event).toBeNull();
    expect(step(s.next, false, 4).event).toBe('down');
  });
});

describe('check helpers', () => {
  it('parses certificate days from the TLS valid_to string', () => {
    const now = Date.UTC(2026, 10, 18, 12);
    expect(parseCertDays('Dec 18 12:00:00 2026 GMT', now)).toBe(30);
    expect(parseCertDays('Nov 17 12:00:00 2026 GMT', now)).toBe(-1);
    expect(parseCertDays('garbage', now)).toBeNull();
  });
  it('health body rules', () => {
    expect(isHealthy(200, '{"ok":true}')).toBe(true);
    expect(isHealthy(200, '{"status":"ok"}')).toBe(true);
    expect(isHealthy(200, '{"ok":false}')).toBe(false);
    expect(isHealthy(200, 'ok')).toBe(true);
    expect(isHealthy(500, '{"ok":true}')).toBe(false);
  });
  it('monitor urls: default, valid list, rejects garbage', () => {
    expect(parseMonitorUrls(undefined)).toEqual(['https://firtech.pro/api/health']);
    expect(parseMonitorUrls('["https://a.com/h"]')).toEqual(['https://a.com/h']);
    expect(() => parseMonitorUrls('["ftp://x"]')).toThrow();
    expect(() => parseMonitorUrls('nope')).toThrow();
  });
  it('container problems ignore clean exits and healthy ones', () => {
    expect(
      containerProblems([
        { name: 'a', state: 'running', status: 'Up 2 hours (healthy)' },
        { name: 'b', state: 'running', status: 'Up (unhealthy)' },
        { name: 'c', state: 'exited', status: 'Exited (0) 1 day ago' },
        { name: 'd', state: 'exited', status: 'Exited (1) 1 day ago' },
        { name: 'e', state: 'restarting', status: 'Restarting' },
      ]),
    ).toEqual(['b (running)', 'd (exited)', 'e (restarting)']);
  });
  it('disk over the threshold fails', async () => {
    const w = world();
    w.st.used = 90;
    expect(await checkDisk(w.deps, cfg)).toMatchObject({ ok: false, detail: 'занято 90%' });
    w.st.used = 85;
    expect((await checkDisk(w.deps, cfg)).ok).toBe(true);
  });
});

describe('MonitoringWorker tick', () => {
  it('alerts once after two failing ticks, then recovery once; uptime and incidents in the daily line', async () => {
    const w = world();
    const worker = new MonitoringWorker(cfg, w.deps);
    const events: string[] = [];
    const tick = async () => {
      w.st.t += 5 * 60_000;
      events.push(...(await worker.tick(w.db)).events.map((e) => e.kind));
    };
    await tick();
    w.st.healthy = false;
    await tick();
    expect(events).toEqual([]);
    await tick();
    expect(events).toEqual(['down']);
    await tick();
    await tick();
    expect(events).toEqual(['down']);
    w.st.healthy = true;
    await tick();
    expect(events).toEqual(['down', 'recovered']);
    const line = worker.dailyLine(w.db);
    expect(line).toContain('инцидентов 1');
    expect(line).toMatch(/аптайм за 24 ч 83\.3%/);
    expect(line).toContain('firtech.pro/api/health 20 мин');
  });

  it('cert under 14 days and OmniRoute down raise their own incidents; the key goes only to /v1/models', async () => {
    const w = world();
    w.st.days = 10;
    w.st.omni = false;
    const worker = new MonitoringWorker({ ...cfg, omnirouteUrl: 'http://omniroute:20128/v1/models', llmApiKey: 'k' }, w.deps);
    await worker.tick(w.db);
    const r = await worker.tick(w.db);
    expect(r.events.map((e) => e.checkId).sort()).toEqual(['omniroute', 'tls:firtech.pro']);
    expect(r.events.find((e) => e.checkId === 'tls:firtech.pro')!.text).toContain('осталось 10 дн.');
    expect(w.st.fetched.find((f) => f.url.includes('omniroute'))!.auth).toBe('Bearer k');
    expect(w.st.fetched.find((f) => f.url.includes('firtech'))!.auth).toBeUndefined();
  });

  it('through the Support toolbox: internal http host by the policy flag, status and detail as before, the key only to /v1/models', async () => {
    const w = world({ fetch: (() => Promise.reject(new Error('must not be used'))) as unknown as typeof fetch });
    const seen: { url: string; auth: string | null; pin: unknown }[] = [];
    const net = (healthy: boolean) => (url: string, init: RequestInit, pin?: unknown) => {
      seen.push({ url, auth: new Headers(init.headers).get('authorization'), pin });
      const ok = url.includes('omniroute') ? true : healthy;
      return Promise.resolve(new Response(ok ? '{"ok":true}' : 'down', { status: ok ? 200 : 503, headers: { 'content-type': 'application/json' } }));
    };
    const web = (dept: string, healthy: boolean) => createTools({ agentId: 'monitoring', dept, fetch: net(healthy), lookup: () => Promise.resolve(['104.16.1.1']), queue: new HostQueue(() => 0, () => Promise.resolve()) }).web;
    const worker = new MonitoringWorker({ ...cfg, omnirouteUrl: 'http://omniroute:20128/v1/models', llmApiKey: 'k' }, w.deps);
    const good = await worker.tick(w.db, web('support', true));
    expect(good.results.find((r) => r.id === 'omniroute')).toMatchObject({ ok: true, detail: 'HTTP 200' });
    expect(good.results.find((r) => r.id.startsWith('http:'))).toMatchObject({ ok: true, detail: 'HTTP 200' });
    expect(seen.find((f) => f.url.includes('omniroute'))).toMatchObject({ auth: 'Bearer k', pin: undefined });
    expect(seen.find((f) => f.url.includes('firtech'))).toMatchObject({ auth: null, pin: { address: '104.16.1.1' } });
    const bad = await worker.tick(w.db, web('support', false));
    expect(bad.results.find((r) => r.id.startsWith('http:'))).toMatchObject({ ok: false, detail: 'HTTP 503' });
    // another department's toolbox cannot reach the internal host: the check fails with the reason, nothing leaks
    const denied = await worker.tick(w.db, web('marketing', true));
    expect(denied.results.find((r) => r.id === 'omniroute')).toMatchObject({ ok: false });
  });

  it('docker check only with the flag', async () => {
    const w = world();
    w.st.containers = [{ name: 'hq', state: 'exited', status: 'Exited (1)' }];
    const off = await new MonitoringWorker(cfg, w.deps).tick(w.db);
    expect(off.results.some((r) => r.id === 'docker')).toBe(false);
    const on = await new MonitoringWorker({ ...cfg, docker: true }, w.deps).tick(w.db);
    expect(on.results.find((r) => r.id === 'docker')).toMatchObject({ ok: false, detail: 'hq (exited)' });
  });

  it('a throwing check counts as a failure, not a crash', async () => {
    const w = world({ fetch: (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch });
    const r = await new MonitoringWorker(cfg, w.deps).tick(w.db);
    expect(r.results.find((x) => x.id.startsWith('http:'))).toMatchObject({ ok: false, detail: 'ECONNREFUSED' });
  });

  it('no samples: honest line', () => {
    expect(dailyLine(new MonitorStore(openDb(':memory:')), NOW)).toContain('нет данных');
  });
});

describe('the client bot (@firtech_bot)', () => {
  function bot(over: Partial<{ last: number | null; started: number | null; err: string | null; getMe: () => Promise<unknown> }> = {}): BotProbe & { calls: number } {
    const o = { last: NOW - 60_000, started: NOW - 3_600_000, err: null as string | null, getMe: () => Promise.resolve({ username: 'firtech_bot' }), ...over };
    const p = { calls: 0, lastUpdateAt: () => o.last, startedAt: () => o.started, getMe: () => (p.calls++, o.getMe()), pollingError: () => o.err };
    return p;
  }

  it('is fine while updates flow and getMe answers; getMe is called through the bot API', async () => {
    const w = world();
    const p = bot();
    const r = await checkBot(w.deps, cfg, p);
    expect(r).toMatchObject([{ id: 'bot', ok: true }, { id: 'bot:silence', ok: true, soft: true }]);
    expect(p.calls).toBe(1);
  });

  it('10 minutes of silence with no polling error is degraded (soft): no uptime sample, incident or alert', async () => {
    const w = world();
    const m = new MonitoringWorker(cfg, w.deps);
    const p = bot({ last: NOW - BOT_SILENCE_MS - 60_000 });
    m.watchBot(p);
    const t1 = await m.tick(w.db);
    expect(t1.results.find((x) => x.id === 'bot:silence')).toMatchObject({ ok: false, soft: true });
    expect(t1.results.find((x) => x.id === 'bot')!.ok).toBe(true);
    w.st.t += 300_000;
    const t2 = await m.tick(w.db);
    expect(t2.events.filter((e) => e.checkId.startsWith('bot'))).toEqual([]);
    const store = m.store(w.db);
    expect(store.state('bot:silence')).toMatchObject({ status: 'down', fails: 2 });
    expect(store.incidents(0).some((i) => i.checkId.startsWith('bot'))).toBe(false);
    expect(store.uptime(0).perCheck.some((c) => c.checkId === 'bot:silence')).toBe(false);
  });

  it('a polling failure or a getMe failure is down: two ticks alert once, recovery says so', async () => {
    const w = world();
    const m = new MonitoringWorker(cfg, w.deps);
    let err: string | null = 'GrammyError: 409 conflict';
    m.watchBot({ lastUpdateAt: () => NOW, startedAt: () => NOW - 1000, getMe: () => Promise.resolve({}), pollingError: () => err });
    expect((await m.tick(w.db)).events).toEqual([]);
    w.st.t += 300_000;
    const down = await m.tick(w.db);
    expect(down.events).toHaveLength(1);
    expect(down.events[0]).toMatchObject({ kind: 'down', checkId: 'bot' });
    expect(down.events[0]!.text).toContain('Telegram-бот');
    expect(down.events[0]!.text).toContain('поллинг остановлен');
    w.st.t += 300_000;
    expect((await m.tick(w.db)).events).toEqual([]);
    err = null;
    w.st.t += 300_000;
    expect((await m.tick(w.db)).events.map((e) => e.kind)).toEqual(['recovered']);
    const r = await checkBot(w.deps, cfg, bot({ getMe: () => Promise.reject(new Error('ETIMEDOUT')) }));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ id: 'bot', ok: false });
    expect(r[0]!.detail).toContain('getMe');
  });

  it('is not checked before polling starts, and without a probe the bot checks do not exist', async () => {
    const w = world();
    expect(await checkBot(w.deps, cfg, bot({ started: null, last: null }))).toMatchObject([{ id: 'bot', ok: true, detail: 'ещё не запущен' }]);
    const m = new MonitoringWorker(cfg, w.deps);
    expect((await m.tick(w.db)).results.some((x) => x.id.startsWith('bot'))).toBe(false);
  });
});

describe('hq and renderer as services', () => {
  const base = { dataDir: '/data', docker: false, renderer: true, heartbeatStaleMs: 180_000 };

  it('reads the heartbeat files: fresh is fine, stale or missing is a failure', async () => {
    const w = world();
    const files: Record<string, number | null> = { '/data/hq.heartbeat': NOW - 20_000, '/data/renderer.heartbeat': NOW - 600_000 };
    const deps: CheckDeps = { ...w.deps, fileMtime: (p) => Promise.resolve(files[p] ?? null) };
    expect((await checkServices(deps, base)).map((r) => [r.id, r.ok])).toEqual([['hq', true], ['renderer', false]]);
    files['/data/renderer.heartbeat'] = NOW - 5_000;
    expect((await checkServices(deps, base)).every((r) => r.ok)).toBe(true);
    delete files['/data/hq.heartbeat'];
    expect((await checkServices(deps, base))[0]).toMatchObject({ ok: false, detail: 'файла сигнала нет' });
  });

  it('with Docker access the container health decides; a container without a healthcheck falls back to the file', async () => {
    const w = world();
    const containers = [
      { name: 'fir-agents-hq-1', state: 'running', status: 'Up 2 hours (healthy)' },
      { name: 'fir-agents-renderer-1', state: 'running', status: 'Up 2 hours (unhealthy)' },
    ];
    const deps: CheckDeps = { ...w.deps, listContainers: () => Promise.resolve(containers), fileMtime: () => Promise.resolve(NOW - 1000) };
    expect((await checkServices(deps, { ...base, docker: true })).map((r) => [r.id, r.ok])).toEqual([['hq', true], ['renderer', false]]);
    containers[1] = { name: 'fir-agents-renderer-1', state: 'running', status: 'Up 2 hours' };
    expect((await checkServices(deps, { ...base, docker: true }))[1]).toMatchObject({ ok: true, detail: 'сигнал свежий' });
    expect(containerHealth(containers, 'hq')).toBe('healthy');
    expect(containerHealth([], 'hq')).toBe('missing');
    expect(containerHealth([{ name: 'fir-agents-renderer-1', state: 'exited', status: 'Exited (1)' }], 'renderer')).toBe('stopped');
  });

  it('a service that cannot be judged is skipped, never passed: no state, no sample, a note in the task result', async () => {
    const w = world();
    const deps: CheckDeps = { ...w.deps };
    delete (deps as { fileMtime?: unknown }).fileMtime;
    expect((await checkServices(deps, base)).every((r) => r.skipped === true)).toBe(true);
    const worker = new MonitoringWorker({ ...cfg, renderer: true }, deps);
    const { results } = await worker.tick(w.db);
    expect(results.filter((r) => r.skipped).map((r) => r.id)).toEqual(['hq', 'renderer']);
    const store = new MonitorStore(w.db);
    expect(store.state('hq')).toBeUndefined();
  });
});
