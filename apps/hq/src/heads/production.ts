import { errMsg, log, type ApprovalQueue, type LlmClient, type Messenger } from '@fir/core';
import { meterLlm, type Agent, type Hq, type Task, type Worker, type WorkerCtx } from '@fir/hq';
import { deployPlan, DeployerWorker, DeployStore, parseTarget } from '@fir/worker-deployer';
import {
  fmtDate, kindSpecs as pmKinds, MILESTONE_KINDS, PmStore, ProjectManagerWorker, type Milestone, type MilestoneKind, type Project,
} from '@fir/worker-project-manager';
import { branchRef, REVIEW_LABEL, ReviewerWorker, reviewRequest } from '@fir/worker-reviewer';
import type { Reporter } from '../reporter.js';

export const PRODUCTION = 'production';
export const PRODUCTION_HEAD_ID = 'production-head';
const PM_ID = 'project-manager';
const REVIEWER_ID = 'reviewer';
const DEPLOYER_ID = 'deployer';
/** Which milestones are code work for a builder; the brief and the payment are the owner's. */
const BUILD_KINDS: MilestoneKind[] = ['prototype', 'delivery'];

export interface ProductionSeedConfig {
  productionBudgetUsd: number;
}

/** First start: the Production org (head, three workers) and the daily overdue check. Instructions come from the file once. */
export function seedProduction(hq: Hq, cfg: ProductionSeedConfig, readInstructions: (file: string) => string): void {
  hq.ensureAgent({
    id: PRODUCTION_HEAD_ID, dept: PRODUCTION, role: 'head', title: 'Голова производства', instructions: readInstructions('production-head.md'),
    bossId: 'director', bot: 'PRODUCTION_BOT_TOKEN', budgetUsdMonth: cfg.productionBudgetUsd,
  });
  hq.ensureAgent({ id: PM_ID, dept: PRODUCTION, role: 'worker', title: 'Проектный менеджер', bossId: PRODUCTION_HEAD_ID });
  hq.ensureAgent({ id: REVIEWER_ID, dept: PRODUCTION, role: 'worker', title: 'Ревьюер', bossId: PRODUCTION_HEAD_ID });
  hq.ensureAgent({ id: DEPLOYER_ID, dept: PRODUCTION, role: 'worker', title: 'Деплойер', bossId: PRODUCTION_HEAD_ID });
  if (!hq.routineByName('production-overdue')) {
    hq.scheduleRoutine({ name: 'production-overdue', cron: '30 10 * * *', dept: PRODUCTION, title: 'Просроченные этапы проектов', meta: { action: 'overdue' } });
  }
}

export interface ProductionDeps {
  hq: Hq;
  llm: LlmClient;
  queue: ApprovalQueue;
  messenger: Messenger;
  ownerId: number;
  reporter: Reporter;
  /** Defaults: the real workers. Tests may pass their own project manager. */
  pm?: Worker;
}

interface Staged {
  kind: string;
  payload: Record<string, unknown>;
  summary: string;
}

const oneLine = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n);

/** `/project` arguments: "<client>: <what>". */
export function parseProject(arg: string): { client: string; what: string } | null {
  const m = /^([^:\n]{1,80}):\s*([\s\S]+)$/.exec(arg.trim());
  if (!m || !m[1]!.trim() || !m[2]!.trim()) return null;
  return { client: m[1]!.trim(), what: m[2]!.trim().slice(0, 1000) };
}

/**
 * Head of the Production department. A sale (`/project` or the Sales signal) becomes a project with milestones and a ТЗ
 * for the owner's approval; the approved ТЗ becomes builder tasks (blocked + tag `builder`, the bridge makes the issues).
 * A builder result with a branch/PR link gets a review task; a closed «Сдача» milestone gets the deploy task and a request
 * to Support for monitoring. Nothing runs and nothing is sent: the owner sends client texts, builders write the code.
 */
export class ProductionHead {
  readonly pm: Worker;
  readonly reviewer = new ReviewerWorker();
  readonly deployer = new DeployerWorker();

  constructor(private readonly d: ProductionDeps) {
    this.pm = d.pm ?? new ProjectManagerWorker();
    const base = { db: d.hq.db, now: d.hq.now };
    for (const [kind, spec] of Object.entries(
      pmKinds(base, {
        onSpecApproved: (id) => this.createBuilderTasks(id),
        deliverStatus: (id, text) => this.deliverStatus(id, text),
      }),
    )) d.hq.registerKind(kind, spec);
  }

  private get hq(): Hq {
    return this.d.hq;
  }

  private get store(): PmStore {
    return new PmStore(this.hq.db, this.hq.now);
  }

  private agent(): Agent {
    return this.hq.agent(PRODUCTION_HEAD_ID)!;
  }

  private llmFor(actor: string, taskId: number | null): LlmClient {
    return meterLlm(this.d.llm, this.hq, { agentId: actor, taskId });
  }

  private async report(taskId: number, text: string): Promise<void> {
    this.hq.addEvent(taskId, 'report', PRODUCTION_HEAD_ID, text);
    await this.d.reporter.post(PRODUCTION, text);
  }

  // ---- entry points: the owner's commands and the Sales signal ----
  /** A sale was approved or paid: a project task for the head. Returns the task id. Sales may call this. */
  createProjectTask(p: { client: string; what: string; product?: string; source?: string }): number {
    const t = this.hq.createTask({
      title: `Проект: ${p.client}`, body: p.what, dept: PRODUCTION, creator: p.source === 'sales' ? 'head' : 'owner', priority: 1,
      meta: { action: 'project', client: p.client, what: p.what, ...(p.product ? { product: p.product } : {}), source: p.source ?? 'owner' },
    });
    this.hq.wake(PRODUCTION_HEAD_ID, 'task');
    return t.id;
  }

  /** `/project`, `/pstatus`, `/target`, `/mdone` through the Director. Returns the reply to the owner. */
  async command(name: string, arg: string): Promise<string> {
    switch (name) {
      case 'project': {
        const p = parseProject(arg);
        if (!p) return 'Формат: /project <клиент>: <что делаем>';
        const id = this.createProjectTask(p);
        return `Задача #${id}: проект «${p.client}». ТЗ с этапами придёт в пачке на одобрение (/approve), до 30 секунд на подготовку.`;
      }
      case 'pstatus': {
        const p = this.store.find(arg);
        if (!p) return 'Не нашёл проект. Формат: /pstatus <номер или клиент>';
        const t = this.hq.createTask({ title: `Статус клиенту: ${p.client}`, dept: PRODUCTION, creator: 'owner', meta: { action: 'client_status', projectId: p.id } });
        this.hq.wake(PRODUCTION_HEAD_ID, 'task');
        return `Задача #${t.id}: черновик статуса для «${p.client}». Текст придёт сюда, отправьте клиенту сами.`;
      }
      case 'target': {
        const t = parseTarget(arg);
        if (typeof t === 'string') return t;
        const p = this.store.find(t.ref);
        if (!p) return `Не нашёл проект «${t.ref}».`;
        new DeployStore(this.hq.db, this.hq.now).set({ projectId: p.id, kind: t.kind, location: t.location, url: t.url });
        return `Проект #${p.id} «${p.client}»: деплой на ${t.kind === 'ours' ? 'наш сервер' : 'сервер клиента'} (${t.location})${t.url ? `, адрес ${t.url}` : ''}.`;
      }
      case 'mdone': {
        const [ref = '', kind = ''] = arg.trim().split(/\s+/);
        const p = this.store.find(ref);
        const k = MILESTONE_KINDS.find((x) => x === kind.toLowerCase());
        if (!p || !k) return `Формат: /mdone <проект> ${MILESTONE_KINDS.join('|')}`;
        const m = this.store.milestoneOf(p.id, k);
        if (!m) return 'Такого этапа нет.';
        if (!this.store.markDone(m.id)) return `Этап «${m.title}» уже закрыт.`;
        return this.afterMilestone(p.id, m);
      }
      default:
        return 'Неизвестная команда производства.';
    }
  }

  /** The line the Director adds to the morning summary: open milestones past their date. Null when none. */
  overdueLine(): string | null {
    const rows = this.store.overdue();
    if (!rows.length) return null;
    return `Просрочены этапы проектов:\n${rows.map((m) => `- проект #${m.projectId} ${m.client}: ${m.title}, срок был ${fmtDate(m.dueAt, this.hq.tz)}`).join('\n')}`;
  }

  // ---- heartbeat ----
  async onHeartbeat(): Promise<void> {
    if (this.agent().status !== 'active') return;
    for (const t of [...this.hq.tasks({ dept: PRODUCTION, status: 'inbox' }), ...this.hq.tasks({ dept: PRODUCTION, status: 'assigned', assigneeId: PRODUCTION_HEAD_ID })]) {
      await this.handle(t).catch((e) => this.crash(t, e));
    }
    for (const t of this.hq.tasks({ dept: PRODUCTION, status: 'review' }).filter((x) => x.meta.builderClosed === true && x.meta.handled !== true)) {
      await this.handleBuilderResult(t).catch((e) => this.crash(t, e));
    }
  }

  private async crash(task: Task, e: unknown): Promise<void> {
    log('error', 'production task crashed', { task: task.id, err: errMsg(e) });
    const cur = this.hq.task(task.id);
    if (cur && cur.status !== 'blocked' && cur.status !== 'done' && cur.status !== 'rejected') this.hq.block(task.id, PRODUCTION_HEAD_ID, `Сбой: ${errMsg(e)}`.slice(0, 300));
    await this.hq.alert(`Производство: задача #${task.id} заблокирована (сбой), подробности в журнале задачи.`);
  }

  private ctx(task: Task, staged: Staged[], actor: string): WorkerCtx {
    return {
      llm: this.llmFor(actor, task.id), db: this.hq.db, tz: this.hq.tz, now: this.hq.now,
      requestApproval: (kind, payload, summary) => Promise.resolve(staged.push({ kind, payload, summary }) - 1),
      log: (action, detail) => this.hq.log(actor, action, 'task', String(task.id), detail),
    };
  }

  private async handle(task: Task): Promise<void> {
    if (!this.hq.claim(task.id, PRODUCTION_HEAD_ID)) return;
    if (this.hq.overBudget(PRODUCTION)) return void this.hq.block(task.id, PRODUCTION_HEAD_ID, 'Лимит расходов отдела исчерпан');
    const action = task.meta.action;
    if (action === 'overdue') {
      const text = this.overdueLine() ?? 'Просроченных этапов нет.';
      this.hq.complete(task.id, PRODUCTION_HEAD_ID, text);
      return void (await this.report(task.id, text));
    }
    if (action === 'project' || action === 'client_status') {
      const staged: Staged[] = [];
      let res;
      try {
        res = await this.pm.run(this.hq.task(task.id)!, this.ctx(task, staged, PM_ID));
      } catch (e) {
        res = { ok: false, result: '', error: errMsg(e) };
      }
      if (!res.ok) {
        this.hq.block(task.id, PM_ID, res.error ?? 'исполнитель не вернул результат');
        return void (await this.hq.alert(`Производство: задача #${task.id} не выполнена: ${(res.error ?? '').slice(0, 200)}`));
      }
      this.hq.complete(task.id, PM_ID, res.result, staged.length > 0 ? 'review' : 'done');
      staged.sort((a, b) => this.d.queue.level(a.kind) - this.d.queue.level(b.kind));
      for (const s of staged) await this.hq.requestApproval(task.id, PM_ID, s.kind, s.payload, s.summary);
      return void (await this.report(task.id, `${res.result}${staged.some((s) => this.d.queue.level(s.kind) === 0) ? ' Придёт в пачке на одобрение.' : ''}`));
    }
    this.hq.block(task.id, PRODUCTION_HEAD_ID, 'Производство умеет: проект из КП (/project), статус клиенту (/pstatus), просрочки');
    await this.report(task.id, `Задача #${task.id} «${oneLine(task.title, 80)}» не для производства: используйте /project <клиент>: <что делаем>.`);
  }

  // ---- the approved ТЗ becomes builder tasks ----
  private builderTask(p: { title: string; body: string; meta: Record<string, unknown> }): Task {
    const t = this.hq.createTask({ title: p.title, body: p.body, dept: PRODUCTION, creator: 'head', assigneeId: null, tags: ['builder'], meta: p.meta });
    this.hq.block(t.id, PRODUCTION_HEAD_ID, 'Нужен строитель: задача для Claude Code', ['builder']);
    return t;
  }

  private createBuilderTasks(projectId: number): void {
    const store = this.store;
    const p = store.project(projectId);
    if (!p) return;
    for (const m of store.milestones(projectId)) {
      if (!BUILD_KINDS.includes(m.kind) || m.taskId) continue;
      const t = this.builderTask({
        title: `${p.client}: ${m.title}`,
        body: `Проект #${p.id} «${p.client}», этап «${m.title}», целевая дата ${fmtDate(m.dueAt, this.hq.tz)}.\n\nТЗ:\n${p.spec}`,
        meta: { kind: 'work', projectId: p.id, milestoneId: m.id, milestone: m.kind, target: p.spec },
      });
      store.setMilestoneTask(m.id, t.id);
    }
    this.hq.log(PRODUCTION_HEAD_ID, 'project_activated', 'project', String(projectId));
    void this.hq.alert(`Производство: ТЗ проекта #${p.id} «${p.client}» одобрено, builder-задачи созданы (/builders).`);
  }

  private async deliverStatus(projectId: number, text: string): Promise<void> {
    const p = this.store.project(projectId);
    await this.d.messenger.send(this.d.ownerId, `Статус для клиента${p ? ` «${p.client}»` : ''}, отправьте сами:\n\n${text}`);
  }

  // ---- a builder result came back ----
  private async handleBuilderResult(task: Task): Promise<void> {
    const kind = task.meta.kind;
    const result = typeof task.meta.result === 'string' ? task.meta.result : '';
    if (kind === 'work') {
      const ref = branchRef(result);
      if (ref) return void (await this.requestReview(task, ref));
      this.hq.setMeta(task.id, { handled: true });
      await this.finishWork(task, 'Ревью не запрошено: в результате нет ссылки на ветку или PR.');
      return;
    }
    this.hq.setMeta(task.id, { handled: true });
    const comment = this.hq.events(task.id).filter((e) => e.kind === 'result').at(-1)?.body ?? result;
    this.hq.complete(task.id, PRODUCTION_HEAD_ID, oneLine(comment, 1500) || 'готово');
    if (kind === 'review') {
      await this.report(task.id, `Ревью готово (задача #${task.id}): ${oneLine(comment, 600)}`);
      const parent = typeof task.meta.parentTaskId === 'number' ? this.hq.task(task.meta.parentTaskId) : undefined;
      if (parent && parent.status === 'review') await this.finishWork(parent, 'Ревью выполнено, замечания в задаче ревью.');
    } else {
      await this.report(task.id, `Деплой готов (задача #${task.id}): ${oneLine(comment, 600)}`);
    }
  }

  private async requestReview(task: Task, ref: string): Promise<void> {
    const proj = typeof task.meta.projectId === 'number' ? this.store.project(task.meta.projectId) : undefined;
    const res = await this.reviewer.run(task, this.ctx(task, [], REVIEWER_ID));
    if (!res.ok) return;
    const rq = reviewRequest(task, ref, proj ? `проект #${proj.id} ${proj.client}` : undefined);
    const rt = this.builderTask({
      title: rq.title, body: res.result,
      meta: { kind: 'review', parentTaskId: task.id, projectId: task.meta.projectId ?? null, ref, checklist: rq.checklist, labelHint: REVIEW_LABEL, model: 'opus' },
    });
    this.hq.setMeta(task.id, { handled: true, reviewTask: rt.id });
    this.hq.addEvent(task.id, 'comment', REVIEWER_ID, `Ревью заказано: задача #${rt.id}`);
    await this.report(task.id, `Результат задачи #${task.id} получен (${ref}). Создана задача на ревью #${rt.id} (Opus, чек-лист: безопасность, тесты, секреты, миграции).`);
  }

  /** Work task accepted: done, its milestone closed. */
  private async finishWork(task: Task, note: string): Promise<void> {
    this.hq.complete(task.id, PRODUCTION_HEAD_ID, note);
    const store = this.store;
    const m = typeof task.meta.milestoneId === 'number' ? store.milestone(task.meta.milestoneId) : undefined;
    if (m && store.markDone(m.id)) await this.report(task.id, await this.afterMilestone(m.projectId, m));
  }

  /** After a milestone closed: «Сдача» starts the deploy task, the last milestone closes the project. Returns the text for the owner. */
  private afterMilestone(projectId: number, m: Milestone): string {
    const store = this.store;
    const p = store.project(projectId)!;
    const lines = [`Проект #${p.id} «${p.client}»: этап «${m.title}» закрыт.`];
    if (m.kind === 'delivery') lines.push(this.createDeploy(p));
    if (store.milestones(p.id).every((x) => x.status === 'done')) {
      store.setStatus(p.id, 'done');
      lines.push(`Проект закрыт. Запишите урок: /lesson ${p.client}: <что узнали>. Акт сдачи: /doc акт ${p.client}.`);
    }
    return lines.join(' ');
  }

  private createDeploy(p: Project): string {
    const target = new DeployStore(this.hq.db, this.hq.now).get(p.id);
    const plan = deployPlan({ id: p.id, client: p.client }, target);
    const t = this.builderTask({ title: plan.title, body: plan.body, meta: { kind: 'deploy', projectId: p.id, client: p.client } });
    const head = this.hq.headOf('support');
    const mon = this.hq.createTask({ title: plan.monitoringTask.title, body: plan.monitoringTask.body, dept: 'support', creator: 'head', meta: { requestedBy: PRODUCTION_HEAD_ID, projectId: p.id } });
    if (head) this.hq.wake(head.id, 'task');
    this.hq.log(PRODUCTION_HEAD_ID, 'deploy_requested', 'project', String(p.id), `task ${t.id}, monitoring ${mon.id}`);
    return `Создана задача на деплой #${t.id} и запрос отделу сопровождения #${mon.id}: ${plan.monitoringTask.title}.`;
  }
}
