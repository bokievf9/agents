import { EXCERPT_MAX, MockLlm, createTools, openDb, playbookExcerpt } from '@fir/core';
import type { Task, WorkerCtx } from '@fir/hq';
import { describe, expect, it } from 'vitest';
import { TrendScoutWorker } from '../src/worker.js';

const RSS = '<?xml version="1.0"?><rss xmlns:ht="https://trends.google.com/trending/rss"><channel><item><title>ChatGPT агент</title><ht:approx_traffic>1000+</ht:approx_traffic></item></channel></rss>';

describe('Trend scout: the playbook is in the prompt', () => {
  it('the daily selection prompt keeps its own text and gets the capped excerpt', async () => {
    const llm = new MockLlm(() => JSON.stringify({ items: [{ n: 1, hook: 'Хук номер 1', format: 'клип 30 с с субтитрами', why: 'быстро растёт охват', direction: null }] }));
    const tools = createTools({ agentId: 'trend-scout', dept: 'marketing', fetch: () => Promise.resolve(new Response(RSS)) });
    const ctx: WorkerCtx = { llm, db: openDb(':memory:'), tz: 'Asia/Tashkent', now: () => Date.UTC(2026, 10, 19, 3, 30), requestApproval: () => Promise.resolve(0), log: () => undefined, tools };
    const task = { id: 1, title: 't', body: '', dept: 'marketing', assigneeId: null, creator: 'routine', parentId: null, status: 'running', priority: 0, dueAt: null, result: null, costUsd: 0, meta: { action: 'trends' }, tags: [], routineId: null, createdAt: 0, updatedAt: 0 } as Task;
    const res = await new TrendScoutWorker({ regions: ['KZ'] }).run(task, ctx);
    expect(res.error ?? '').toBe('');
    expect(res.ok).toBe(true);
    const system = llm.calls[0]!.system;
    const excerpt = playbookExcerpt('trend-scout');
    expect(excerpt.length).toBeLessThanOrEqual(EXCERPT_MAX);
    expect(system).toContain('Ты трендвотчер студии Fir Tech');
    expect(system.endsWith(excerpt)).toBe(true);
  });
});
