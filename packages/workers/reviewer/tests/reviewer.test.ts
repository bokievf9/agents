import { MockLlm, openDb } from '@fir/core';
import type { Task, WorkerCtx } from '@fir/hq';
import { describe, expect, it } from 'vitest';
import { branchRef, CHECKLIST, ReviewerWorker, reviewRequest } from '../src/index.js';

const ctx = { llm: new MockLlm(() => ''), db: openDb(':memory:'), tz: 'UTC', now: () => 0, requestApproval: () => Promise.resolve(0), log: () => undefined } as WorkerCtx;
const task = (result?: string) => ({ id: 7, title: 'Бот: Прототип', meta: result ? { result } : {} }) as unknown as Task;

describe('reviewer', () => {
  it('finds a branch or PR link and ignores plain issue links', () => {
    expect(branchRef('Готово: https://github.com/bokievf9/agents/pull/12.')).toBe('https://github.com/bokievf9/agents/pull/12');
    expect(branchRef('ветка https://github.com/bokievf9/agents/tree/feat/x-1')).toBe('https://github.com/bokievf9/agents/tree/feat/x-1');
    expect(branchRef('https://github.com/bokievf9/agents/issues/5')).toBeNull();
    expect(branchRef('/opt/fir-agents/data/hq/artifacts/a.zip')).toBeNull();
  });

  it('builds the review text with the whole checklist; no link is an error, not a guess', async () => {
    const w = new ReviewerWorker();
    const ok = await w.run(task('https://github.com/bokievf9/agents/pull/12'), ctx);
    expect(ok.ok).toBe(true);
    for (const c of CHECKLIST) expect(ok.result).toContain(c);
    expect(ok.result).toContain('pull/12');
    expect((await w.run(task('просто готово'), ctx)).ok).toBe(false);
    expect(reviewRequest({ id: 7, title: 'Бот: Прототип' }, 'https://github.com/a/b/pull/1').title).toBe('Ревью: Бот: Прототип');
  });
});
