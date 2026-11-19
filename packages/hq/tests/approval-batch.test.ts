import { describe, expect, it } from 'vitest';
import { ApprovalQueue, MemoryMessenger, openDb, type Messenger } from '@fir/core';
import { Hq } from '../src/index.js';

const OWNER = 100;

/** A messenger whose n-th sendMessage fails once (as Telegram does with 429). */
class Flaky extends MemoryMessenger {
  attempts = 0;
  constructor(private readonly failAt: number[]) {
    super();
  }
  override sendMessage(...a: Parameters<Messenger['sendMessage']>): Promise<number> {
    this.attempts++;
    if (this.failAt.includes(this.attempts)) return Promise.reject(Object.assign(new Error('Too Many Requests'), { error_code: 429, parameters: { retry_after: 5 } }));
    return super.sendMessage(...a);
  }
}

function world(failAt: number[]) {
  const db = openDb(':memory:');
  const messenger = new Flaky(failAt);
  const hq = new Hq(db);
  const queue = new ApprovalQueue(db, messenger, OWNER, 20);
  hq.attachQueue(queue);
  hq.upsertAgent({ id: 'director', dept: 'hq', role: 'director', title: 'D' });
  hq.upsertAgent({ id: 'marketing-head', dept: 'marketing', role: 'head', title: 'M', bossId: 'director' });
  hq.registerKind('post', { initialLevel: 0, execute: async () => undefined });
  return { db, messenger, hq, queue };
}

const queued = async (w: ReturnType<typeof world>, n: number) => {
  for (let i = 0; i < n; i++) {
    const t = w.hq.createTask({ title: `T${i}`, dept: 'marketing', creator: 'owner' });
    w.hq.claim(t.id, 'marketing-head');
    await w.hq.requestApproval(t.id, 'marketing-head', 'post', { text: `p${i}` }, `card ${i}`);
  }
};

describe('approval batch with a failing Telegram', () => {
  it('a card that fails does not stop the batch and leaves no orphan; the next batch resends the SAME card', async () => {
    const w = world([2]);
    await queued(w, 3);
    expect(await w.hq.releaseApprovals()).toBe(2);
    expect(w.messenger.sent).toHaveLength(2);
    // the failed card is still queued, linked to its row, and shows up once in the pending list
    const left = w.hq.queuedApprovals();
    expect(left).toHaveLength(1);
    expect(left[0]!.approvalId).not.toBeNull();
    expect(w.queue.pending()).toHaveLength(3);
    // no card recorded as sent for it
    expect(w.queue.cardMessage(left[0]!.approvalId!)).toBeUndefined();

    expect(await w.hq.releaseApprovals()).toBe(1);
    expect(w.messenger.sent).toHaveLength(3);
    expect(w.queue.pending()).toHaveLength(3); // no duplicate proposal for the same task
    expect(w.db.prepare('SELECT COUNT(*) c FROM approvals').get()).toEqual({ c: 3 });
    expect(w.hq.queuedApprovals()).toHaveLength(0);
    expect(w.queue.cardMessage(left[0]!.approvalId!)).toBeDefined();
    expect(await w.hq.releaseApprovals()).toBe(0);
  });

  it('an alert says how many went out', async () => {
    const w = world([1]);
    const alerts: string[] = [];
    w.hq.onAlert((t) => void alerts.push(t));
    await queued(w, 2);
    await w.hq.releaseApprovals();
    expect(alerts.join('\n')).toContain('1 из 2');
  });

  it('a card decided while it waited for the resend is not sent again', async () => {
    const w = world([1]);
    await queued(w, 1);
    await w.hq.releaseApprovals();
    const link = w.hq.queuedApprovals()[0]!;
    await w.queue.handle('reject', link.approvalId!, OWNER);
    expect(await w.hq.releaseApprovals()).toBe(1); // marked asked, then reconciled
    expect(w.messenger.sent).toHaveLength(0);
    expect(w.hq.approvalLink(link.id)!.state).toBe('rejected');
  });
});
