import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installRejectionGuard, keepPolling } from '../src/process-guard.js';

afterEach(() => vi.restoreAllMocks());

const logs = () => {
  const lines: Record<string, unknown>[] = [];
  vi.spyOn(console, 'log').mockImplementation((s: unknown) => void lines.push(JSON.parse(String(s)) as Record<string, unknown>));
  vi.spyOn(console, 'error').mockImplementation((s: unknown) => void lines.push(JSON.parse(String(s)) as Record<string, unknown>));
  return lines;
};

describe('P-28: unhandled rejections', () => {
  it('logs an error line, alerts the owner once per window with the count, and never exits', async () => {
    const lines = logs();
    const proc = new EventEmitter();
    const alerts: string[] = [];
    const clock = { t: 1_000_000 };
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    installRejectionGuard(proc as never, (t) => void alerts.push(t), { now: () => clock.t, everyMs: 600_000 });
    proc.emit('unhandledRejection', new Error('boom 1'));
    proc.emit('unhandledRejection', new Error('boom 2'));
    proc.emit('unhandledRejection', 'plain reason');
    await Promise.resolve();
    expect(lines.filter((l) => l.level === 'error' && l.msg === 'unhandled rejection')).toHaveLength(3);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('(1 за последние 10 мин)');
    clock.t += 600_000;
    proc.emit('unhandledRejection', new Error('boom 4'));
    await Promise.resolve();
    expect(alerts).toHaveLength(2);
    // the two silenced ones and the new one are counted in the second alert
    expect(alerts[1]).toContain('(3 за последние 10 мин)');
    expect(exit).not.toHaveBeenCalled();
  });

  it('an alert sink that throws or rejects does not break the handler', async () => {
    logs();
    const proc = new EventEmitter();
    const h = installRejectionGuard(proc as never, () => { throw new Error('sink down'); }, { now: () => 0 });
    expect(() => h(new Error('x'))).not.toThrow();
    const proc2 = new EventEmitter();
    const h2 = installRejectionGuard(proc2 as never, () => Promise.reject(new Error('sink down')), { now: () => 0 });
    expect(() => h2(new Error('y'))).not.toThrow();
    await new Promise((r) => setImmediate(r));
  });
});

describe('P-05: the client bot polling restarts', () => {
  it('a crashed poll starts again after a growing pause, three times; the fourth failure gives up (the app exits for a container restart)', async () => {
    const sleeps: number[] = [];
    const restarts: number[] = [];
    let runs = 0;
    let gaveUp: unknown = null;
    await keepPolling(() => { runs++; return Promise.reject(new Error(`poll ${runs}`)); }, {
      attempts: 3, pauseMs: 1000, now: () => 0, sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
      onRestart: (n) => void restarts.push(n), onGiveUp: (e) => { gaveUp = e; },
    });
    expect(runs).toBe(4);
    expect(restarts).toEqual([1, 2, 3]);
    expect(sleeps).toEqual([1000, 2000, 3000]);
    expect((gaveUp as Error).message).toBe('poll 4');
  });

  it('a poll that recovers keeps running; a clean stop ends the loop without giving up', async () => {
    let runs = 0;
    let gaveUp = false;
    await keepPolling(() => (++runs < 3 ? Promise.reject(new Error('409')) : Promise.resolve()), {
      attempts: 3, pauseMs: 1, now: () => 0, sleep: () => Promise.resolve(), onGiveUp: () => { gaveUp = true; },
    });
    expect(runs).toBe(3);
    expect(gaveUp).toBe(false);
  });

  it('a long healthy run resets the counter: rare crashes never add up to a restart of HQ', async () => {
    const clock = { t: 0 };
    let runs = 0;
    let gaveUp = false;
    await keepPolling(() => {
      runs++;
      if (runs > 8) return Promise.resolve();
      clock.t += 11 * 60_000; // each run lived 11 minutes before it crashed
      return Promise.reject(new Error('network'));
    }, { attempts: 3, pauseMs: 1, now: () => clock.t, sleep: () => Promise.resolve(), onGiveUp: () => { gaveUp = true; } });
    expect(runs).toBe(9);
    expect(gaveUp).toBe(false);
  });
});
