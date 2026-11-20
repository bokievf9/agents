import { describe, expect, it, vi } from 'vitest';
import { OWNER, setup } from './helpers.js';

function kindSetup(level: 0 | 1 = 0) {
  const s = setup();
  const executed: string[] = [];
  s.hq.registerKind('post', { initialLevel: level, locked: level === 0, execute: async (p) => void executed.push(String(p.text)) });
  const task = (title = 'T', dept = 'marketing') => {
    const t = s.hq.createTask({ title, dept, creator: 'owner' });
    s.hq.claim(t.id, `${dept}-head`);
    return t;
  };
  return { ...s, executed, task };
}

describe('urgent kinds', () => {
  it('an urgent kind goes to the owner at once as a single card, not with the batch; other kinds still wait', async () => {
    const { hq, messenger, queue, task } = kindSetup();
    hq.registerKind('rush', { initialLevel: 0, locked: true, execute: async () => undefined }, { urgent: true });
    const a = task('A');
    const b = task('B');
    await hq.requestApproval(a.id, 'marketing-head', 'post', { text: 'later' }, 'normal');
    await hq.requestApproval(b.id, 'marketing-head', 'rush', { text: 'now' }, 'client waits');
    expect(messenger.sent).toHaveLength(1);
    expect(messenger.sent[0]!.text).toContain('Срочно, marketing, задача #' + b.id);
    expect(messenger.sent[0]!.buttons).toBeTruthy();
    expect(queue.pending()).toHaveLength(1);
    expect(hq.queuedApprovals().map((l) => l.kind)).toEqual(['post']);
    expect(await hq.releaseApprovals()).toBe(1);
  });
});

describe('approvals through the Director batch', () => {
  it('queues without messaging the owner; the batch sends one numbered series with buttons', async () => {
    const { hq, messenger, task } = kindSetup();
    const a = task('A');
    const b = task('B', 'sales');
    await hq.requestApproval(a.id, 'marketing-head', 'post', { text: 'one' }, 'first');
    await hq.requestApproval(b.id, 'sales-head', 'post', { text: 'two' }, 'second');
    expect(hq.task(a.id)!.status).toBe('approval');
    expect(messenger.sent).toHaveLength(0);
    expect(hq.queuedApprovals()).toHaveLength(2);
    expect(await hq.releaseApprovals()).toBe(2);
    expect(messenger.sent).toHaveLength(2);
    expect(messenger.sent[0]!.text).toContain('[1/2] marketing, задача #' + a.id);
    expect(messenger.sent[1]!.text).toContain('[2/2] sales');
    expect(messenger.sent.every((m) => m.buttons && m.chatId === OWNER)).toBe(true);
    expect(await hq.releaseApprovals()).toBe(0); // nothing queued any more
  });

  it('approve executes the kind and reconcile marks the task done', async () => {
    const { hq, queue, task, executed } = kindSetup();
    const t = task();
    await hq.requestApproval(t.id, 'marketing-head', 'post', { text: 'hello' }, 's');
    await hq.releaseApprovals();
    const link = hq.queuedApprovals();
    expect(link).toHaveLength(0);
    const approvalId = queue.pending()[0]!.id;
    await queue.handle('approve', approvalId, OWNER);
    expect(executed).toEqual(['hello']);
    expect(hq.reconcileApprovals()).toBe(1);
    expect(hq.task(t.id)!.status).toBe('done');
    expect(hq.approvalByCoreId(approvalId)!.state).toBe('executed');
  });

  it('reject makes the task rejected; with several proposals the task finishes when all are decided', async () => {
    const { hq, queue, task } = kindSetup();
    const t = task();
    await hq.requestApproval(t.id, 'marketing-head', 'post', { text: '1' }, 's');
    await hq.requestApproval(t.id, 'marketing-head', 'post', { text: '2' }, 's');
    await hq.releaseApprovals();
    const [first, second] = queue.pending();
    await queue.handle('reject', first!.id, OWNER);
    hq.reconcileApprovals();
    expect(hq.task(t.id)!.status).toBe('approval');
    await queue.handle('approve', second!.id, OWNER);
    hq.reconcileApprovals();
    expect(hq.task(t.id)!.status).toBe('done');
    const u = task('U');
    await hq.requestApproval(u.id, 'marketing-head', 'post', { text: '3' }, 's');
    await hq.releaseApprovals();
    await queue.handle('reject', queue.pending()[0]!.id, OWNER);
    hq.reconcileApprovals();
    expect(hq.task(u.id)!.status).toBe('rejected');
  });

  it('a failing execute blocks the task', async () => {
    const { hq, queue, task } = kindSetup();
    hq.registerKind('bad', { initialLevel: 0, execute: () => Promise.reject(new Error('boom')) });
    const t = task();
    await hq.requestApproval(t.id, 'marketing-head', 'bad', { text: 'x' }, 's');
    await hq.releaseApprovals();
    await queue.handle('approve', queue.pending()[0]!.id, OWNER);
    hq.reconcileApprovals();
    expect(hq.task(t.id)!.status).toBe('blocked');
  });

  it('level 1 kinds run at once, no batch, task done', async () => {
    const { hq, messenger, task, executed } = kindSetup(1);
    const t = task();
    await hq.requestApproval(t.id, 'marketing-head', 'post', { text: 'auto' }, 's');
    expect(executed).toEqual(['auto']);
    expect(hq.task(t.id)!.status).toBe('done');
    expect(messenger.sent).toHaveLength(0);
  });

  it('decision sinks hear about every decided proposal', async () => {
    const { hq, queue, task } = kindSetup();
    const seen: string[] = [];
    hq.onApprovalDecision((l, state) => void seen.push(`${l.kind}:${state}`));
    const t = task();
    await hq.requestApproval(t.id, 'marketing-head', 'post', { text: 'x' }, 's');
    await hq.releaseApprovals();
    await queue.handle('reject', queue.pending()[0]!.id, OWNER);
    hq.reconcileApprovals();
    hq.reconcileApprovals();
    expect(seen).toEqual(['post:rejected']);
  });
});

describe('a task blocked while its approvals are open (chaos drill 2026-11-21)', () => {
  it('a decision on a sibling approval of a blocked task does not throw "blocked -> done"; the task stays blocked for /retry', async () => {
    const { hq, queue, task } = kindSetup();
    const a = task('SEO');
    await hq.requestApproval(a.id, 'marketing-head', 'post', { text: 'one' }, 'first');
    await hq.requestApproval(a.id, 'marketing-head', 'post', { text: 'two' }, 'second');
    await hq.releaseApprovals();
    const [first, second] = queue.pending();
    // another of the task's approvals failed, or the owner sent it to the builders: it is blocked while a card is still open
    hq.block(a.id, 'owner', 'approval post failed to execute');
    await queue.handle('approve', first!.id, OWNER);
    expect(() => hq.reconcileApprovals()).not.toThrow();
    await queue.handle('approve', second!.id, OWNER);
    expect(() => hq.reconcileApprovals()).not.toThrow();
    expect(hq.task(a.id)!.status).toBe('blocked');
    expect(hq.approvalLink(1)!.state).toBe('executed');
    expect(hq.approvalLink(2)!.state).toBe('executed');
  });
  it('a sink that throws on one link does not stop the owner\'s decision or the links after it', async () => {
    const { hq, queue, task } = kindSetup();
    const a = task('A');
    const b = task('B');
    await hq.requestApproval(a.id, 'marketing-head', 'post', { text: 'one' }, 'first');
    await hq.requestApproval(b.id, 'marketing-head', 'post', { text: 'two' }, 'second');
    await hq.releaseApprovals();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    hq.onApprovalDecision((l) => { if (l.taskId === a.id) throw new Error('sink boom'); });
    for (const p of queue.pending()) await queue.handle('approve', p.id, OWNER);
    expect(() => hq.reconcileApprovals()).not.toThrow();
    expect(hq.task(b.id)!.status).toBe('done');
    expect(hq.task(a.id)!.status, 'the task whose sink threw still follows the decision').toBe('done');
    expect(hq.approvalLink(1)!.state).toBe('executed');
    vi.restoreAllMocks();
  });
});
