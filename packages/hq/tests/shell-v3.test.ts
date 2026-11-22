import { describe, expect, it } from 'vitest';
import { OWNER, setup } from './helpers.js';

describe('openQueued: the workplace decides a proposal that never went out as a card', () => {
  it('makes the core row once, marks the link asked, and the owner decision follows', async () => {
    const { hq, queue } = setup();
    let ran = 0;
    hq.registerKind('thing', { initialLevel: 0, execute: () => Promise.resolve(void ran++) });
    const t = hq.createTask({ title: 'x', dept: 'marketing', creator: 'head' });
    hq.claim(t.id, 'marketing-head');
    const link = await hq.requestApproval(t.id, 'marketing-head', 'thing', { a: 1 }, 'сводка');
    expect(hq.approvalLink(link)).toMatchObject({ state: 'queued', approvalId: null });
    const id = hq.openQueued(link)!;
    expect(id).toEqual(expect.any(Number));
    expect(hq.approvalLink(link)).toMatchObject({ state: 'asked', approvalId: id, held: false });
    expect(hq.openQueued(link)).toBeNull(); // already asked: nothing to open
    await queue.handle('approve', id, OWNER);
    await queue.handle('approve', id, OWNER); // the queue claims an approval once
    expect(ran).toBe(1);
    hq.reconcileApprovals();
    expect(hq.approvalLink(link)!.state).toBe('executed');
    expect(hq.task(t.id)!.status).toBe('done');
  });

  it('a held proposal opens too; one whose card failed to send keeps its core row (no second proposal)', async () => {
    const { hq, db } = setup();
    hq.registerKind('thing', { initialLevel: 0, execute: () => Promise.resolve() });
    const t = hq.createTask({ title: 'x', dept: 'marketing', creator: 'head' });
    const a = await hq.requestApproval(t.id, 'marketing-head', 'thing', {}, 's');
    hq.holdApprovals([a]);
    const id = hq.openQueued(a)!;
    expect(id).toBeGreaterThan(0);
    const b = await hq.requestApproval(t.id, 'marketing-head', 'thing', {}, 's2');
    const existing = Number((db.prepare("INSERT INTO approvals (kind, payload, summary, status, created_at) VALUES ('thing', '{}', 's2', 'pending', 0)").run()).lastInsertRowid);
    db.prepare('UPDATE task_approvals SET approval_id = ? WHERE id = ?').run(existing, b);
    expect(hq.openQueued(b)).toBe(existing);
    expect(hq.approvalLink(b)!.state).toBe('asked');
    expect(hq.openQueued(999)).toBeNull();
  });
});

describe('setRoutineEnabled', () => {
  it('switches a routine, journals it; off also keeps the code sync from switching it back on', () => {
    const { hq } = setup();
    const def = { name: 'r1', cron: '0 9 * * *', dept: 'marketing', title: 'R1' };
    hq.syncRoutines('marketing', [def]);
    expect(hq.setRoutineEnabled('r1', false)!.enabled).toBe(false);
    hq.syncRoutines('marketing', [def]); // the next start
    expect(hq.routineByName('r1')!.enabled).toBe(false);
    expect(hq.runRoutine('r1')).toBeNull();
    expect(hq.setRoutineEnabled('r1', true)!.enabled).toBe(true);
    expect(hq.runRoutine('r1')).not.toBeNull();
    expect(hq.setRoutineEnabled('nope', true)).toBeUndefined();
    expect(hq.activity(5).map((a) => a.action)).toContain('routine_disabled');
  });
});
