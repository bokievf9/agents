import type { Task, Worker, WorkerCtx, WorkerResult } from '@fir/hq';
import { DeployStore, type Target } from './store.js';

export const WORKER_ID = 'deployer';

export const DEPLOY_CHECKLIST = [
  'CI: проверки (typecheck, lint, tests, build) зелёные на ветке, образ собран',
  'Окружение: все переменные заданы на целевом сервере, секреты только там, в репозитории их нет',
  'DNS: домен указывает на нужный сервер',
  'TLS: сертификат выпущен, https открывается без предупреждений',
  'Health: адрес здоровья отвечает 200 и ok, главная страница и форма работают',
  'Откат: известен предыдущий образ или коммит, на который можно вернуться',
];

export const storeFor = (ctx: Pick<WorkerCtx, 'db' | 'now'>): DeployStore => new DeployStore(ctx.db, ctx.now);

export interface DeployPlan {
  title: string;
  body: string;
  /** The task for the Support head; with no known address the title carries the `<url>` placeholder. */
  monitoringTask: { title: string; body: string };
}

/** Where the project deploys, in words for the builder. The exact commands stay with the builder and the project's CLAUDE.md. */
function where(t: Target | undefined): string {
  if (!t) return 'Цель деплоя не задана (`/target <проект> ours|client <путь или хост> [url]`). Уточни у владельца до начала.';
  return t.kind === 'ours'
    ? `Наш сервер, путь/сервис: ${t.location}. Деплой по правилам проекта (CI, образ, compose).`
    : `Сервер клиента: ${t.location}. Доступы выдаёт владелец, в issue и логи их не писать. Деплой по инструкции клиенту.`;
}

export function deployPlan(project: { id: number; client: string }, target: Target | undefined): DeployPlan {
  const url = target?.url || '<url>';
  const body = [
    `Деплой проекта #${project.id} «${project.client}».`,
    '',
    '## Куда',
    where(target),
    '',
    '## Чек-лист',
    ...DEPLOY_CHECKLIST.map((c) => `- [ ] ${c}`),
    '',
    `После деплоя: адрес для мониторинга ${url}. Задача отделу сопровождения создаётся автоматически.`,
    'Последний комментарий перед закрытием issue: итоговый адрес и что проверено.',
  ].join('\n');
  return {
    title: `Деплой: ${project.client}`.slice(0, 200),
    body,
    monitoringTask: { title: `добавить ${url} в мониторинг`, body: `Проект #${project.id} «${project.client}» сдан. Нужна проверка health и срока TLS для ${url}.` },
  };
}

/** The deployer: `meta.projectId`; no network, no commands: it prepares the deploy task and the monitoring request. */
export class DeployerWorker implements Worker {
  readonly id = WORKER_ID;

  async run(task: Task, ctx: WorkerCtx): Promise<WorkerResult> {
    const id = Number(task.meta.projectId);
    const client = typeof task.meta.client === 'string' ? task.meta.client : `проект ${id}`;
    if (!Number.isInteger(id)) return { ok: false, result: '', error: 'нет projectId' };
    const plan = deployPlan({ id, client }, storeFor(ctx).get(id));
    ctx.log('deploy_prepared', String(id));
    return { ok: true, result: plan.body };
  }
}
