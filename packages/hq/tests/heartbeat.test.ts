import { describe, expect, it } from 'vitest';
import { HeartbeatWorker } from '../src/index.js';
import { setup } from './helpers.js';

const gate = () => {
  let release!: () => void;
  const p = new Promise<void>((r) => (release = r));
  return { p, release };
};

describe('heads run independently', () => {
  it('a slow head does not delay another head: the second wake-up is handled while the first still runs', async () => {
    const { hq } = setup();
    const slow = gate();
    const seen: string[] = [];
    const worker = new HeartbeatWorker(hq, async (agent) => {
      seen.push(agent.id);
      if (agent.id === 'marketing-head') await slow.p;
    });
    hq.wake('marketing-head', 'schedule');
    const first = worker.tick();
    await Promise.resolve();
    expect(worker.busy).toEqual(['marketing-head']);
    // marketing is still busy (a weekly pack); a lead wakes sales, and the NEXT tick (30 s later) handles it at once
    hq.wake('sales-head', 'task');
    expect(await worker.tick()).toBe(1);
    expect(seen).toEqual(['marketing-head', 'sales-head']);
    expect(worker.busy).toEqual(['marketing-head']);
    slow.release();
    await first;
    await worker.idle();
    expect(worker.busy).toEqual([]);
  });

  it('a busy head keeps its own wake-up pending and runs it after it finished', async () => {
    const { hq } = setup();
    const g = gate();
    let calls = 0;
    const worker = new HeartbeatWorker(hq, async () => {
      calls++;
      if (calls === 1) await g.p;
    });
    hq.wake('marketing-head', 'task');
    const first = worker.tick();
    await Promise.resolve();
    hq.wake('marketing-head', 'message');
    expect(await worker.tick()).toBe(0);
    expect(hq.pendingHeartbeats()).toBe(1);
    g.release();
    await first;
    expect(await worker.tick()).toBe(1);
    expect(calls).toBe(2);
  });

  it('at most three heads work at once; the rest wait for a free slot', async () => {
    const { hq } = setup();
    for (const id of ['h1', 'h2', 'h3', 'h4']) hq.upsertAgent({ id, dept: id, role: 'head', title: id, bossId: 'director' });
    const gates = new Map<string, ReturnType<typeof gate>>();
    const worker = new HeartbeatWorker(hq, (a) => {
      const g = gate();
      gates.set(a.id, g);
      return g.p;
    });
    for (const id of ['h1', 'h2', 'h3', 'h4']) hq.wake(id, 'task');
    const first = worker.tick();
    await Promise.resolve();
    expect(worker.busy.sort()).toEqual(['h1', 'h2', 'h3']);
    expect(hq.pendingHeartbeats()).toBe(1);
    expect(await worker.tick()).toBe(0);
    gates.get('h1')!.release();
    await new Promise((r) => setTimeout(r, 0));
    const second = worker.tick();
    await Promise.resolve();
    expect(worker.busy).toContain('h4');
    for (const g of gates.values()) g.release();
    expect(await second).toBe(1);
    await first;
    await worker.idle();
  });
});
