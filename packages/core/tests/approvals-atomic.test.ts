import { describe, expect, it } from 'vitest';
import { ApprovalQueue, MemoryMessenger, openDb, type Payload } from '../src/index.js';

const OWNER = 1;

function setup(fail = false) {
  const messenger = new MemoryMessenger();
  const db = openDb(':memory:');
  const queue = new ApprovalQueue(db, messenger, OWNER, 3);
  const executed: Payload[] = [];
  const slow = () => new Promise<void>((r) => setTimeout(r, 5));
  queue.register('reply', { initialLevel: 0, execute: async (p) => { await slow(); executed.push(p); } });
  queue.register('auto', { initialLevel: 1, execute: async () => { if (fail) throw new Error('boom'); } });
  return { messenger, queue, executed, db };
}

describe('idempotent approvals', () => {
  it('two concurrent approvals execute once; the second caller gets «Уже обработано»', async () => {
    const { queue, executed } = setup();
    const { id } = await queue.propose('reply', { text: 'hi' }, 's');
    const answers = await Promise.all([queue.handle('approve', id, OWNER), queue.handle('approve', id, OWNER)]);
    expect(answers.sort()).toEqual(['Одобрено', 'Уже обработано']);
    expect(executed).toHaveLength(1);
    expect(queue.get(id)!.status).toBe('executed');
  });

  it('approve and reject racing: only one wins', async () => {
    const { queue, executed } = setup();
    const { id } = await queue.propose('reply', { text: 'hi' }, 's');
    const answers = await Promise.all([queue.handle('approve', id, OWNER), queue.handle('reject', id, OWNER)]);
    expect(answers).toContain('Уже обработано');
    expect(executed.length + (queue.get(id)!.status === 'rejected' ? 1 : 0)).toBe(1);
  });

  it('«Одобрить все» running twice at once approves each proposal once', async () => {
    const { queue, executed } = setup();
    for (let i = 0; i < 4; i++) await queue.propose('reply', { text: `t${i}` }, 's');
    const [a, b] = await Promise.all([queue.approveAll(OWNER), queue.approveAll(OWNER)]);
    expect(executed).toHaveLength(4);
    expect(a.approved + b.approved).toBe(4);
    expect(a.failed + b.failed).toBe(0);
  });

  it('a proposal left «running» by a crash is failed at start, not executed twice', async () => {
    const { queue, db, executed } = setup();
    const { id } = await queue.propose('reply', { text: 'hi' }, 's');
    db.prepare("UPDATE approvals SET status = 'running' WHERE id = ?").run(id);
    expect(await queue.handle('approve', id, OWNER)).toBe('Уже обработано');
    expect(queue.recoverInterrupted()).toEqual([id]);
    expect(queue.get(id)!.status).toBe('failed');
    expect(executed).toHaveLength(0);
  });
});

describe('level 1 failure is never silent', () => {
  it('tells the owner how to go back to manual approval and journals auto_failed', async () => {
    const { queue, messenger } = setup(true);
    const r = await queue.propose('auto', { text: 'x' }, 's');
    expect(r).toMatchObject({ auto: true, ok: false });
    expect(queue.get(r.id)!.status).toBe('failed');
    expect(messenger.last()!.text).toContain('/level auto 0');
    expect(queue.journalRows()[0]!.decision).toBe('auto_failed');
  });

  it('a level 1 success journals auto and sends nothing', async () => {
    const { queue, messenger } = setup(false);
    const r = await queue.propose('auto', { text: 'x' }, 's');
    expect(r.ok).toBe(true);
    expect(messenger.sent).toHaveLength(0);
    expect(queue.journalRows()[0]!.decision).toBe('auto');
  });
});
