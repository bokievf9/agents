import type { Task, Worker, WorkerCtx, WorkerResult } from '@fir/hq';

export const WORKER_ID = 'reviewer';
/** Label hint for the builder bridge issue: an Opus review, not a build. */
export const REVIEW_LABEL = 'review';

export const CHECKLIST = [
  'Безопасность: нет секретов и токенов в коде и истории, ввод проверяется, нет SQL и shell-инъекций, права доступа и RLS на месте',
  'Тесты: новое поведение покрыто, тесты зелёные, ничего не отключено ради зелёного',
  'Проверки: typecheck, lint, build проходят',
  'Секреты: `.env*` не закоммичены, ключи только из окружения, в логах нет персональных данных клиентов',
  'Миграции: обратимы или безопасны на живых данных, нет потери данных, порядок применения понятен',
  'Качество: соответствует ТЗ и критериям приёмки, нет мёртвого кода и лишних зависимостей',
];

/** A branch or pull request link in a builder's result (github.com/<owner>/<repo>/pull/<n> or /tree/<branch>). */
export function branchRef(result: string): string | null {
  const m = /https?:\/\/(?:www\.)?(?:github|gitlab)\.com\/[^\s/]+\/[^\s/]+\/(?:pull|merge_requests|tree|compare)\/[^\s)\]>"'`]+/.exec(result);
  return m ? m[0].replace(/[.,;:]+$/, '') : null;
}

export interface ReviewRequest {
  title: string;
  body: string;
  checklist: string[];
  ref: string;
}

/** The review task for a builder result: its text carries the diff link and the checklist. */
export function reviewRequest(task: Pick<Task, 'id' | 'title'>, ref: string, projectLabel?: string): ReviewRequest {
  const body = [
    `Ревью результата задачи HQ #${task.id}${projectLabel ? ` (${projectLabel})` : ''}.`,
    `Ветка или PR: ${ref}`,
    '',
    'Прочитай diff. Код не запускай с чужими данными и не публикуй ничего наружу. Модель: Opus.',
    '',
    '## Чек-лист',
    ...CHECKLIST.map((c) => `- [ ] ${c}`),
    '',
    'Итог: список замечаний по важности (блокирующие, желательные) или «замечаний нет». Последним комментарием перед закрытием issue.',
  ].join('\n');
  return { title: `Ревью: ${task.title}`.slice(0, 200), body, checklist: CHECKLIST, ref };
}

/**
 * The reviewer: turns a builder task that reached `review` into the text of a review task. No code is executed and the
 * model is not called: the review itself is done by a builder session (Opus) through the issue the head creates.
 * `run` gets the builder task, returns the review text, or `ok: false` when its result has no branch/PR link.
 */
export class ReviewerWorker implements Worker {
  readonly id = WORKER_ID;

  async run(task: Task, ctx: WorkerCtx): Promise<WorkerResult> {
    const result = typeof task.meta.result === 'string' ? task.meta.result : '';
    const ref = branchRef(result);
    if (!ref) return { ok: false, result: '', error: 'в результате нет ссылки на ветку или PR' };
    ctx.log('review_prepared', String(task.id));
    return { ok: true, result: reviewRequest(task, ref).body };
  }
}
