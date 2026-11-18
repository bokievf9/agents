import type { SubtaskSpec, Task, Worker, WorkerCtx, WorkerResult } from '@fir/hq';
import { KbStore } from './store.js';
import { parseLesson, renderLessons } from './kb.js';

export const WORKER_ID = 'knowledge';

export const storeFor = (ctx: Pick<WorkerCtx, 'db' | 'now'>): KbStore => new KbStore(ctx.db, ctx.now);

export interface ExportPlan {
  title: string;
  body: string;
  lessonIds: number[];
}

/**
 * The knowledge keeper. `meta.action`: `lesson` (project, text: stores a lesson) or `lessons_export` (renders lessons not
 * yet in the repo into a builder task text). No LLM and no files written: the repo `knowledge/` is changed only by a
 * builder session through the issue the head creates.
 */
export class KnowledgeWorker implements Worker {
  readonly id = WORKER_ID;

  async plan(): Promise<SubtaskSpec[] | null> {
    return null;
  }

  async run(task: Task, ctx: WorkerCtx): Promise<WorkerResult> {
    const store = storeFor(ctx);
    if (task.meta.action === 'lessons_export') {
      const plan = exportPlan(store, ctx);
      return plan ? { ok: true, result: plan.body } : { ok: true, result: 'Новых уроков нет, обновлять нечего.' };
    }
    const l = parseLesson(`${String(task.meta.project ?? '')}: ${String(task.meta.text ?? '')}`);
    if (!l) return { ok: false, result: '', error: 'формат: /lesson <проект>: <урок>' };
    const row = store.add(l.project, l.text);
    ctx.log('lesson_added', String(row.id));
    return { ok: true, result: `Урок #${row.id} записан (проект «${l.project}»). В репозиторий уйдёт в воскресной выгрузке.` };
  }
}

/** The weekly builder task text, or null when every lesson is already exported. */
export function exportPlan(store: KbStore, ctx: Pick<WorkerCtx, 'tz' | 'now'>): ExportPlan | null {
  const lessons = store.unexported();
  if (!lessons.length) return null;
  const body = [
    'Обнови базу знаний компании: добавь новые уроки из проектов в `knowledge/lessons/`.',
    '',
    renderLessons(lessons, ctx.tz, ctx.now()),
    '',
    'Только эти записи, в формате маркированных строк под заголовком проекта. Если урок тянет на плейбук, предложи его в комментарии, не создавай сам. Закоммить в ветку и дай ссылку на ветку или PR последним комментарием.',
  ].join('\n');
  return { title: 'Обновить knowledge/lessons', body, lessonIds: lessons.map((l) => l.id) };
}
