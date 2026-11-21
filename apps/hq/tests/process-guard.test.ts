import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installRejectionGuard } from '../src/process-guard.js';

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
