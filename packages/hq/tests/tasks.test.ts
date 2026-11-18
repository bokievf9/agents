import { describe, expect, it } from 'vitest';
import { setup } from './helpers.js';

describe('tasks', () => {
  it('creates in inbox, or assigned when an assignee is given, and journals it', () => {
    const { hq } = setup();
    const a = hq.createTask({ title: 'A', dept: 'marketing', creator: 'owner' });
    const b = hq.createTask({ title: 'B', dept: 'marketing', creator: 'director', assigneeId: 'content-maker', meta: { x: 1 }, tags: ['t'] });
    expect(a.status).toBe('inbox');
    expect(b.status).toBe('assigned');
    expect(b.meta).toEqual({ x: 1 });
    expect(b.tags).toEqual(['t']);
    expect(hq.events(a.id)[0]!.kind).toBe('status');
    expect(hq.activity().some((x) => x.action === 'task_created')).toBe(true);
  });

  it('claim is atomic: the second claimant loses; a task assigned to someone else cannot be taken', () => {
    const { hq } = setup();
    const t = hq.createTask({ title: 'A', dept: 'marketing', creator: 'owner' });
    expect(hq.claim(t.id, 'marketing-head')).toBe(true);
    expect(hq.claim(t.id, 'content-maker')).toBe(false);
    expect(hq.task(t.id)).toMatchObject({ status: 'running', assigneeId: 'marketing-head' });
    const u = hq.createTask({ title: 'U', dept: 'marketing', creator: 'owner', assigneeId: 'content-maker' });
    expect(hq.claim(u.id, 'marketing-head')).toBe(false);
    expect(hq.claim(u.id, 'content-maker')).toBe(true);
    expect(hq.claim(99, 'content-maker')).toBe(false);
  });

  it('enforces the status machine and keeps a journal', () => {
    const { hq } = setup();
    const t = hq.createTask({ title: 'A', dept: 'marketing', creator: 'owner' });
    expect(() => hq.setStatus(t.id, 'approval', 'x')).toThrow(/not allowed/);
    hq.claim(t.id, 'marketing-head');
    hq.comment(t.id, 'marketing-head', 'working');
    hq.complete(t.id, 'marketing-head', '# Result', 'review');
    expect(hq.task(t.id)).toMatchObject({ status: 'review', result: '# Result' });
    hq.setStatus(t.id, 'running', 'marketing-head', 'rework');
    hq.complete(t.id, 'marketing-head', 'final');
    expect(hq.task(t.id)!.status).toBe('done');
    expect(() => hq.setStatus(t.id, 'running', 'x')).toThrow();
    const kinds = hq.events(t.id).map((e) => e.kind);
    expect(kinds).toEqual(['status', 'status', 'comment', 'result', 'status', 'status', 'result', 'status']);
  });

  it('block records the reason and tags (builder) and can be reopened', () => {
    const { hq } = setup();
    const t = hq.createTask({ title: 'Нужен бот', dept: 'marketing', creator: 'director' });
    hq.block(t.id, 'director', 'нужен строитель', ['builder']);
    expect(hq.task(t.id)).toMatchObject({ status: 'blocked', tags: ['builder'] });
    expect(hq.events(t.id).some((e) => e.kind === 'error' && e.body === 'нужен строитель')).toBe(true);
    hq.setStatus(t.id, 'inbox', 'director');
    expect(hq.task(t.id)!.status).toBe('inbox');
  });

  it('filters, orders by priority, and counts', () => {
    const { hq } = setup();
    hq.createTask({ title: 'low', dept: 'marketing', creator: 'owner' });
    hq.createTask({ title: 'high', dept: 'marketing', creator: 'owner', priority: 2 });
    hq.createTask({ title: 'sales', dept: 'sales', creator: 'owner' });
    expect(hq.tasks({ dept: 'marketing' }).map((t) => t.title)).toEqual(['high', 'low']);
    expect(hq.tasks({ status: 'inbox', open: true })).toHaveLength(3);
    expect(hq.countByStatus('marketing').inbox).toBe(2);
    expect(hq.countByStatus().inbox).toBe(3);
  });

  it('assign moves inbox to assigned; setMeta merges', () => {
    const { hq } = setup();
    const t = hq.createTask({ title: 'A', dept: 'marketing', creator: 'owner', meta: { a: 1 } });
    hq.assign(t.id, 'content-maker');
    hq.setMeta(t.id, { b: 2 });
    expect(hq.task(t.id)).toMatchObject({ status: 'assigned', assigneeId: 'content-maker', meta: { a: 1, b: 2 } });
  });
});

describe('agents and settings', () => {
  it('ensureAgent does not overwrite edited instructions; pause/resume a department', () => {
    const { hq } = setup();
    hq.setInstructions('marketing-head', 'edited');
    hq.ensureAgent({ id: 'marketing-head', dept: 'marketing', role: 'head', title: 'x', instructions: 'from file' });
    expect(hq.agent('marketing-head')!.instructions).toBe('edited');
    expect(hq.setDeptStatus('marketing', 'paused')).toBe(2);
    expect(hq.agent('marketing-head')!.status).toBe('paused');
    expect(hq.agent('director')!.status).toBe('active');
    hq.setDeptStatus('marketing', 'active');
    expect(hq.headOf('marketing')!.id).toBe('marketing-head');
    expect(hq.departments()).toEqual(['marketing', 'sales']);
  });

  it('settings have defaults; quiet hours wrap midnight in the HQ timezone', () => {
    const { hq, clock } = setup();
    expect(hq.setting('summary_time')).toBe('08:00');
    expect(hq.tz).toBe('Asia/Tashkent');
    expect(hq.isQuiet()).toBe(false);
    hq.setSetting('quiet_hours', '23:00-07:00');
    expect(hq.isQuiet()).toBe(false); // 12:00 Tashkent
    clock.t = Date.UTC(2026, 10, 18, 20, 0); // 01:00 Tashkent
    expect(hq.isQuiet()).toBe(true);
  });
});
