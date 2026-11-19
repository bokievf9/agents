import { EXCERPT_MAX, MockLlm, openDb, playbookExcerpt } from '@fir/core';
import { Hq, type Task, type WorkerCtx } from '@fir/hq';
import { describe, expect, it } from 'vitest';
import { AnalystWorker } from '../src/index.js';

describe('Analyst: the playbook is in the prompt', () => {
  it('the recommendations prompt keeps its own text and gets the capped excerpt', async () => {
    const llm = new MockLlm(() => JSON.stringify({ recommendations: ['Первая', 'Вторая', 'Третья'] }));
    const db = openDb(':memory:');
    new Hq(db, { now: () => Date.UTC(2026, 10, 23, 3, 0) });
    db.exec('CREATE TABLE cm_ready (id INTEGER PRIMARY KEY, item_id INTEGER, platform TEXT, type TEXT, text TEXT, planned_date TEXT, status TEXT); CREATE TABLE pb_posts (ready_id INTEGER PRIMARY KEY, item_id INTEGER, platform TEXT, sent_on TEXT, published_at INTEGER);');
    const ctx: WorkerCtx = { llm, db, tz: 'Asia/Tashkent', now: () => Date.UTC(2026, 10, 23, 3, 0), requestApproval: () => Promise.resolve(0), log: () => undefined };
    const task = { id: 1, title: 't', body: '', dept: 'marketing', assigneeId: null, creator: 'routine', parentId: null, status: 'running', priority: 0, dueAt: null, result: null, costUsd: 0, meta: { action: 'report' }, tags: [], routineId: null, createdAt: 0, updatedAt: 0 } as Task;
    const res = await new AnalystWorker({}).run(task, ctx);
    expect(res.ok).toBe(true);
    const system = llm.calls[0]!.system;
    const excerpt = playbookExcerpt('analyst');
    expect(excerpt.length).toBeLessThanOrEqual(EXCERPT_MAX);
    expect(system).toContain('Ты аналитик отдела маркетинга');
    expect(system.endsWith(excerpt)).toBe(true);
  });
});
