import { openDb } from '@fir/core';
import { describe, expect, it } from 'vitest';
import {
  DAY_MS, MonitoringWorker, MonitorStore, checkDisk, containerProblems, dailyLine, isHealthy, parseCertDays, parseMonitorUrls, step,
  type CheckDeps, type MonitorConfig,
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
