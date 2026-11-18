import { MockLlm, openDb } from '@fir/core';
import type { Task, WorkerCtx } from '@fir/hq';
import { describe, expect, it } from 'vitest';
import { exportPlan, KbStore, KnowledgeWorker, parseLesson, renderLessons, searchKb } from '../src/index.js';

const T0 = Date.UTC(2026, 10, 18, 7, 0);
const mk = () => {
  const db = openDb(':memory:');
  const ctx = { llm: new MockLlm(() => ''), db, tz: 'Asia/Tashkent', now: () => T0, requestApproval: () => Promise.resolve(0), log: () => undefined } as WorkerCtx;
  return { db, ctx, store: new KbStore(db, () => T0) };
};

describe('knowledge', () => {
  it('parses /lesson and refuses a missing project or text', () => {
    expect(parseLesson('Роза: бриф письменно')).toEqual({ project: 'Роза', text: 'бриф письменно' });
    expect(parseLesson('без двоеточия')).toBeNull();
    expect(parseLesson(': текст')).toBeNull();
  });

  it('the worker captures a lesson from a task and the weekly plan lists only unexported ones', async () => {
    const { ctx, store } = mk();
    const w = new KnowledgeWorker();
    const r = await w.run({ meta: { action: 'lesson', project: 'Роза', text: 'просить доступы в первый день' } } as unknown as Task, ctx);
    expect(r.ok).toBe(true);
    expect(store.all()).toHaveLength(1);
    expect((await w.run({ meta: { action: 'lesson', project: '', text: '' } } as unknown as Task, ctx)).ok).toBe(false);
    const plan = exportPlan(store, ctx)!;
    expect(plan.lessonIds).toEqual([1]);
    expect(plan.body).toContain('knowledge/lessons/2026-11.md');
    store.markExported(plan.lessonIds, 9);
    expect(exportPlan(store, ctx)).toBeNull();
  });

  it('search needs every word, works by stem, and covers playbook titles', () => {
    const { store } = mk();
    store.add('Роза', 'Предоплату просить до начала прототипа');
    store.add('Ош', 'Домен клиента оформлять на клиента');
    const titles = [{ file: 'deploy.md', title: 'Деплой на сервер клиента' }];
    expect(searchKb('предоплата прототип', store.all(), titles).lessons).toHaveLength(1);
    expect(searchKb('деплоя', store.all(), titles).playbooks).toHaveLength(1);
    expect(searchKb('домен прототип', store.all(), titles).lessons).toHaveLength(0);
    expect(renderLessons(store.all(), 'Asia/Tashkent', T0)).toContain('## Роза\n- 2026-11-18: Предоплату');
  });
});
