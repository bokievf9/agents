import { describe, expect, it } from 'vitest';
import { catchUpRoutines, HeartbeatWorker, startRoutines } from '../src/index.js';
import { setup } from './helpers.js';

describe('routines', () => {
  const def = { name: 'weekly-pack', cron: '0 9 * * 1', dept: 'marketing', title: 'Пакет недели', meta: { action: 'pack' } };

  it('creates a task with routine meta, wakes the head, upserts by name', () => {
    const { hq } = setup();
    hq.scheduleRoutine(def);
    hq.scheduleRoutine({ ...def, cron: '0 10 * * 1' });
    expect(hq.routines()).toHaveLength(1);
    expect(hq.routines()[0]!.cron).toBe('0 10 * * 1');
    const t = hq.runRoutine('weekly-pack')!;
    expect(t).toMatchObject({ creator: 'routine', dept: 'marketing', status: 'inbox', meta: { action: 'pack', routine: 'weekly-pack' } });
    expect(hq.pendingHeartbeats()).toBe(1);
  });

  it('no-overlap: skipped while the previous task is open, runs after it finished', () => {
    const { hq } = setup();
    hq.scheduleRoutine(def);
    const first = hq.runRoutine('weekly-pack')!;
    expect(hq.runRoutine('weekly-pack')).toBeNull();
    expect(hq.tasks({ dept: 'marketing' })).toHaveLength(1);
    hq.claim(first.id, 'marketing-head');
    expect(hq.runRoutine('weekly-pack')).toBeNull();
    hq.complete(first.id, 'marketing-head', 'ok');
    expect(hq.runRoutine('weekly-pack')).not.toBeNull();
  });

  it('overlap allow always creates; disabled routines do not run', () => {
    const { hq } = setup();
    hq.scheduleRoutine({ ...def, name: 'a', overlap: 'allow' });
    hq.runRoutine('a');
    expect(hq.runRoutine('a')).not.toBeNull();
    hq.scheduleRoutine({ ...def, name: 'b', enabled: false });
    expect(hq.runRoutine('b')).toBeNull();
    expect(hq.runRoutine('missing')).toBeNull();
  });

  it('startRoutines schedules only enabled ones', () => {
    const { hq } = setup();
    hq.scheduleRoutine(def);
    hq.scheduleRoutine({ ...def, name: 'off', enabled: false });
    const jobs = startRoutines(hq);
    expect(jobs).toHaveLength(1);
    jobs.forEach((j) => j.stop());
  });
});

describe('heartbeats', () => {
  it('coalesces wake-ups per agent: earliest time wins, reasons merge', () => {
    const { hq, clock } = setup();
    const a = hq.wake('marketing-head', 'task', clock.t + 60_000);
    const b = hq.wake('marketing-head', 'message', clock.t + 10_000);
    const c = hq.wake('marketing-head', 'task');
    expect(new Set([a, b, c]).size).toBe(1);
    expect(hq.pendingHeartbeats()).toBe(1);
    hq.wake('sales-head', 'schedule');
    expect(hq.pendingHeartbeats()).toBe(2);
    const due = hq.claimDueHeartbeats();
    const mh = due.find((d) => d.agentId === 'marketing-head')!;
    expect(mh.reason.split(',').sort()).toEqual(['message', 'task']);
    expect(mh.wakes).toBe(3);
    expect(hq.pendingHeartbeats()).toBe(0);
  });

  it('future wake-ups wait; paused departments are not woken; busy agents are skipped', () => {
    const { hq, clock } = setup();
    hq.wake('marketing-head', 'schedule', clock.t + 60_000);
    expect(hq.claimDueHeartbeats()).toHaveLength(0);
    clock.t += 61_000;
    hq.setDeptStatus('marketing', 'paused');
    expect(hq.claimDueHeartbeats()).toHaveLength(0);
    hq.setDeptStatus('marketing', 'active');
    expect(hq.claimDueHeartbeats(new Set(['marketing-head']))).toHaveLength(0);
    expect(hq.claimDueHeartbeats()).toHaveLength(1);
  });

  it('the worker hands each due agent to the handler once and survives a failing handler', async () => {
    const { hq } = setup();
    const seen: string[] = [];
    const worker = new HeartbeatWorker(hq, async (agent) => {
      seen.push(agent.id);
      if (agent.id === 'sales-head') throw new Error('x');
    });
    hq.wake('marketing-head', 'task');
    hq.wake('marketing-head', 'message');
    hq.wake('sales-head', 'schedule');
    expect(await worker.tick()).toBe(2);
    expect(seen.sort()).toEqual(['marketing-head', 'sales-head']);
    expect(await worker.tick()).toBe(0);
    expect(hq.activity().some((a) => a.action === 'heartbeat_failed')).toBe(true);
  });

  it('an agent that is still running is not woken again until it finishes', async () => {
    const { hq } = setup();
    let release!: () => void;
    let calls = 0;
    const worker = new HeartbeatWorker(hq, () => {
      calls++;
      return new Promise<void>((r) => (release = r));
    });
    hq.wake('marketing-head', 'task');
    const first = worker.tick();
    await Promise.resolve();
    hq.wake('marketing-head', 'message');
    expect(await worker.tick()).toBe(0); // a tick in progress
    release();
    await first;
    expect(calls).toBe(1);
    expect(hq.pendingHeartbeats()).toBe(1);
    const second = worker.tick();
    await Promise.resolve();
    release();
    await second;
    expect(calls).toBe(2);
  });
});

describe('P-26: routines missed while HQ was down are caught up once', () => {
  it('fires a routine whose time passed since its last run; not one that ran after it, never ran, is off or is older than the window', () => {
    const { hq, clock } = setup();
    // NOW = Wed 2026-11-18 12:00 Tashkent
    const def = { dept: 'marketing', title: 'Рутина', meta: {} };
    hq.scheduleRoutine({ ...def, name: 'daily-0330', cron: '30 3 * * *' }); // missed at 03:30 today
    hq.scheduleRoutine({ ...def, name: 'fresh', cron: '30 3 * * *' }); // ran after 03:30 today
    hq.scheduleRoutine({ ...def, name: 'never', cron: '30 3 * * *' }); // never ran: not caught up
    hq.scheduleRoutine({ ...def, name: 'off', cron: '30 3 * * *', enabled: false });
    hq.scheduleRoutine({ ...def, name: 'monthly', cron: '0 9 1 * *' }); // last due 2026-11-01, outside the window
    const set = (name: string, at: number) => hq.db.prepare('UPDATE routines SET last_run_at = ? WHERE name = ?').run(at, name);
    set('daily-0330', clock.t - 30 * 3_600_000);
    set('fresh', clock.t - 3_600_000);
    set('off', clock.t - 30 * 3_600_000);
    set('monthly', clock.t - 20 * 86_400_000);
    expect(catchUpRoutines(hq)).toEqual(['daily-0330']);
    expect(hq.tasks({ dept: 'marketing' })).toHaveLength(1);
    // the catch-up counts as a run: a second start does nothing more
    expect(catchUpRoutines(hq)).toEqual([]);
  });
});
