import { errMsg, log, type ApprovalQueue, type LlmClient, type Messenger, roleTitle } from '@fir/core';
import { meterLlm, type Agent, type Hq, type Task, type Worker, type WorkerCtx } from '@fir/hq';
import { deployPlan, DeployerWorker, DeployStore, parseTarget } from '@fir/worker-deployer';
import type { Invoice } from '@fir/worker-billing';
import { legalMeta, legalPartyOfLead } from '@fir/worker-lead-intake';
import {
  fmtDate, kindSpecs as pmKinds, MILESTONE_KINDS, PmStore, ProjectManagerWorker, stageDueAt, stageTitleRu, type Milestone, type MilestoneKind, type Project,
} from '@fir/worker-project-manager';
import { branchRef, REVIEW_LABEL, ReviewerWorker, reviewRequest } from '@fir/worker-reviewer';
import type { CabDocs } from '../cab-docs.js';
import type { Reporter } from '../reporter.js';
import { toolsFor, type AppTools } from '../tools.js';

export const PRODUCTION = 'production';
export const PRODUCTION_HEAD_ID = 'production-head';
const PM_ID = 'project-manager';
const REVIEWER_ID = 'reviewer';
const DEPLOYER_ID = 'deployer';
/** Which milestones are code work for a builder; the brief and the payment are the owner's. */
const BUILD_KINDS: MilestoneKind[] = ['prototype', 'delivery'];

/** What accepting a stage did: `accepted` (the next invoice is proposed), `already` (accepted before, nothing happens twice), `not_paid`, `not_ready` (client only: the stage is not finished yet), `unknown`. */
export interface AcceptResult {
  status: 'accepted' | 'already' | 'not_paid' | 'not_ready' | 'unknown';
  text: string;
}

const stageTitle = (m: Pick<Milestone, 'title'>): string => stageTitleRu(m.title);

export interface ProductionSeedConfig {
  productionBudgetUsd: number;
}

/** First start: the Production org (head, three workers) and the daily overdue check. Instructions come from the file once. */
export function seedProduction(hq: Hq, cfg: ProductionSeedConfig, readInstructions: (file: string) => string): void {
  hq.ensureAgent({
    id: PRODUCTION_HEAD_ID, dept: PRODUCTION, role: 'head', title: roleTitle('production-head'), instructions: readInstructions('production-head.md'),
    bossId: 'director', bot: 'PRODUCTION_BOT_TOKEN', budgetUsdMonth: cfg.productionBudgetUsd,
  });
  hq.ensureAgent({ id: PM_ID, dept: PRODUCTION, role: 'worker', title: roleTitle('project-manager'), bossId: PRODUCTION_HEAD_ID });
  hq.ensureAgent({ id: REVIEWER_ID, dept: PRODUCTION, role: 'worker', title: roleTitle('reviewer'), bossId: PRODUCTION_HEAD_ID });
  hq.ensureAgent({ id: DEPLOYER_ID, dept: PRODUCTION, role: 'worker', title: roleTitle('deployer'), bossId: PRODUCTION_HEAD_ID });
  hq.syncRoutines('production', [{ name: 'production-overdue', cron: '50 7 * * *', tz: 'owner', dept: PRODUCTION, title: 'Просроченные этапы проектов', meta: { action: 'overdue' } }]);
}

export interface ProductionDeps {
  hq: Hq;
  /** Adapters and keys of the agents' toolbox (`docs/tools.md`, `src/tools.ts`); absent (tests): a toolbox without keys. */
  tools?: AppTools | undefined;
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
  /** Set by the app: what the client of a cabinet project sees of the stages (a line in the project thread, an email, the act). Without it nothing goes to the client. */
  cabinet: CabDocs | null = null;

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
  createProjectTask(p: { client: string; what: string; product?: string; source?: string; projectId?: number }): number {
    const t = this.hq.createTask({
      title: `Проект: ${p.client}`, body: p.what, dept: PRODUCTION, creator: p.source === 'sales' ? 'head' : 'owner', priority: 1,
      meta: { action: 'project', client: p.client, what: p.what, ...(p.product ? { product: p.product } : {}), ...(p.projectId ? { projectId: p.projectId } : {}), source: p.source ?? 'owner' },
    });
    this.hq.wake(PRODUCTION_HEAD_ID, 'task');
    return t.id;
  }

  /**
   * The project starts on PAYMENT, not on the КП's approval (owner decision 2026-11-19), and by stages (2026-11-21): an approved КП only reserved a
   * `draft` project whose milestones are the stages. Stage 1 paid (`/paid`, the on-chain watcher) creates the Production task: the ТЗ comes for the
   * owner's approval. A later stage paid starts that stage's builder task (when the ТЗ is approved); the last one also releases the handover task.
   * An invoice outside the stage plan (an older chain) starts a reserved project of the old plan as before. Idempotent: a stage is started once.
   * Returns lines for the owner; nothing when no project is waiting.
   */
  onInvoicePaid(inv: Pick<Invoice, 'client' | 'projectId'> & { stageNo?: number | null; number?: string }): string[] {
    const store = this.store;
    if (inv.stageNo != null && inv.projectId) return this.onStagePaid(inv.projectId, inv.stageNo, inv.number ?? '');
    const p = (inv.projectId ? store.project(inv.projectId) : undefined) ?? store.reservedFor(inv.client);
    if (!p || p.status !== 'draft' || p.packId === null || p.taskId !== null || store.milestones(p.id).length > 0) return [];
    const id = this.createProjectTask({ client: p.client, what: p.what, product: p.product, source: 'sales', projectId: p.id });
    this.hq.log(PRODUCTION_HEAD_ID, 'project_started_on_payment', 'project', String(p.id));
    return [`Проект #${p.id} «${p.client}» стартует по оплате (задача #${id}): этапы по КП, ТЗ придёт карточкой на одобрение.`];
  }

  private onStagePaid(projectId: number, stageNo: number, invoiceNumber: string): string[] {
    const store = this.store;
    const p = store.project(projectId);
    const m = p ? store.stageMilestone(p.id, stageNo) : undefined;
    if (!p || !m) return [];
    const all = store.stageMilestones(p.id);
    const total = all.reduce((a, x) => a + (x.amountUsd ?? 0), 0) || 1;
    // the stage's target date counts from its payment; stage 1 keeps the dates the ТЗ plans from the project start
    const due = stageNo > 1 ? stageDueAt(p.product, ((m.amountUsd ?? 0) / total) * 100, this.hq.now(), this.hq.tz) : undefined;
    if (!store.markStagePaid(m.id, invoiceNumber, due)) return [];
    this.hq.log(PRODUCTION_HEAD_ID, 'stage_paid', 'project', String(p.id), `stage ${stageNo} ${invoiceNumber}`);
    const lines: string[] = [];
    if (stageNo === 1) {
      if (p.status === 'draft' && p.taskId === null) {
        const id = this.createProjectTask({ client: p.client, what: p.what, product: p.product, source: 'sales', projectId: p.id });
        this.hq.log(PRODUCTION_HEAD_ID, 'project_started_on_payment', 'project', String(p.id));
        lines.push(`Проект #${p.id} «${p.client}» стартует по оплате этапа 1 (задача #${id}): ТЗ придёт карточкой на одобрение.`);
      }
    } else if (p.status === 'active') {
      this.createStageBuilderTask(p, store.stageMilestone(p.id, stageNo)!);
      lines.push(`Проект #${p.id} «${p.client}»: этап ${stageNo} оплачен, начался (builder-задача создана).`);
    } else {
      lines.push(`Проект #${p.id} «${p.client}»: этап ${stageNo} оплачен, начнётся после одобрения ТЗ.`);
    }
    if (all.length > 1 && stageNo === all.length) lines.push(this.releaseHandover(p));
    return lines;
  }

  /** The handover task waits (blocked) for the payment of the last stage; its payment releases it. */
  private holdHandover(p: Project, invoiceNumber: string | null): void {
    const exists = this.hq.tasks({ dept: PRODUCTION, limit: 500 }).some((t) => t.meta.action === 'handover' && t.meta.projectId === p.id);
    if (exists) return;
    const t = this.hq.createTask({
      title: `Передача доступов: ${p.client}`, body: `Проект #${p.id} «${p.client}»: передать доступы, исходники и инструкцию. Последний этап оплачивается до передачи.`, dept: PRODUCTION, creator: 'head', priority: 1,
      meta: { action: 'handover', projectId: p.id },
    });
    this.hq.block(t.id, PRODUCTION_HEAD_ID, `Ждёт оплаты последнего этапа${invoiceNumber ? ` (счёт ${invoiceNumber})` : ''}: доступы не передаём до оплаты`);
  }

  private releaseHandover(p: Project): string {
    const t = this.hq.tasks({ dept: PRODUCTION, status: 'blocked', limit: 500 }).find((x) => x.meta.action === 'handover' && x.meta.projectId === p.id);
    if (!t) return `Проект #${p.id}: последний этап оплачен, передача доступов разрешена.`;
    this.hq.setStatus(t.id, 'inbox', PRODUCTION_HEAD_ID, 'последний этап оплачен');
    this.hq.wake(PRODUCTION_HEAD_ID, 'task');
    return `Проект #${p.id}: последний этап оплачен, задача «Передача доступов» #${t.id} разблокирована.`;
  }

  /**
   * A stage is accepted: by the owner (`/mdone <project> <stage>`) or by the client in the cabinet. Once only. The stage must be paid and finished
   * (`done`, the client's «awaiting acceptance»), for the owner too (P-15). Accepting proposes the invoice of the NEXT stage
   * (Support, a locked card with the pay link); the invoice of the last stage also puts the handover task on hold until it is paid;
   * accepting the last stage closes the project.
   */
  acceptStage(projectId: number, stageNo: number, by: 'owner' | 'client'): AcceptResult {
    const store = this.store;
    const p = store.project(projectId);
    const m = p ? store.stageMilestone(p.id, stageNo) : undefined;
    if (!p || !m) return { status: 'unknown', text: 'Такого этапа нет.' };
    if (m.acceptedAt !== null) return { status: 'already', text: `Этап ${stageNo} уже принят.` };
    if (m.paidAt === null) return { status: 'not_paid', text: `Этап ${stageNo} ещё не оплачен: принять его нельзя.` };
    // P-15: nobody accepts a stage that is still running, the owner included: the client would read «Этап принят» for work he never saw.
    // The owner first marks it ready (`/mready`, Пульт `ready_milestone`): the client gets «Принять этап»; then either of them accepts.
    if (m.status !== 'done') {
      return {
        status: 'not_ready',
        text: by === 'client'
          ? `Этап ${stageNo} ещё в работе: принять его можно, когда он будет готов.`
          : `Этап ${stageNo} ещё в работе (не ждёт приёмки): сначала отметьте его готовым командой /mready ${p.id} ${stageNo}, клиент получит «Принять этап».`,
      };
    }
    if (!store.acceptStage(m.id)) return { status: 'already', text: `Этап ${stageNo} уже принят.` };
    this.hq.log(by, 'stage_accepted', 'project', String(p.id), `stage ${stageNo}`);
    const all = store.stageMilestones(p.id);
    const next = all.find((x) => x.stageNo === stageNo + 1);
    const lines = [`Проект #${p.id} «${p.client}»: этап ${stageNo} «${stageTitle(m)}» принят${by === 'client' ? ' клиентом' : ''}.`];
    const cabinetClient = this.cabinet?.clientOfLead(p.leadId) != null;
    if (next) {
      lines.push(this.proposeStageInvoice(p, next, all));
      if (next.stageNo === all.length && all.length > 1) this.holdHandover(p, store.stageMilestone(p.id, next.stageNo!)!.invoiceNumber);
    } else {
      store.setStatus(p.id, 'done');
      lines.push(`Проект закрыт. Запишите урок: /lesson ${p.client}: <что узнали>. ${cabinetClient ? 'Акт сдачи уже ушёл клиенту в кабинет.' : `Акт сдачи: /doc акт ${p.client}.`}`);
    }
    // the client sees the step in his cabinet (the project thread, an email, the act of the last stage)
    this.cabinet?.onStageAccepted(
      p, { stageNo, title: stageTitle(m), titleEn: m.titleEn }, next ? { stageNo: next.stageNo!, title: stageTitle(next), titleEn: next.titleEn } : null,
      all.filter((x) => x.stageNo !== null).map((x) => ({ stageNo: x.stageNo!, title: stageTitle(x), amountUsd: x.amountUsd })),
    );
    return { status: 'accepted', text: lines.join(' ') };
  }

  /**
   * P-14: the owner says a paid stage is finished (`/mready <project> <stage>`, Пульт `ready_milestone`) when the work was not done through the builder chain: the
   * same steps as a builder's accepted result (`markDone` + `afterMilestone`), so the client gets «Принять этап» in the cabinet and by email. Once only;
   * an unpaid stage cannot be ready. An older milestone (no stage number) is simply closed, as `/mdone` does.
   */
  readyStage(projectId: number, stageNo: number): { status: 'ready' | 'already' | 'not_paid' | 'unknown'; text: string } {
    const store = this.store;
    const p = store.project(projectId);
    const m = p ? store.stageMilestone(p.id, stageNo) : undefined;
    if (!p || !m) return { status: 'unknown', text: 'Такого этапа нет.' };
    if (m.paidAt === null) return { status: 'not_paid', text: `Этап ${stageNo} ещё не оплачен: отметить его готовым нельзя (работа начинается после оплаты).` };
    if (m.status === 'done' || m.acceptedAt !== null) return { status: 'already', text: `Этап ${stageNo} уже ${m.acceptedAt !== null ? 'принят' : 'готов и ждёт приёмки клиента'}.` };
    if (!store.markDone(m.id)) return { status: 'already', text: `Этап ${stageNo} уже готов и ждёт приёмки клиента.` };
    this.hq.log('owner', 'stage_ready', 'project', String(p.id), `stage ${stageNo}`);
    // the builder task of the stage keeps its state (a builder result arriving later finds the stage done and changes nothing); its journal says why
    if (m.taskId && this.hq.task(m.taskId)) this.hq.comment(m.taskId, 'owner', `Этап ${stageNo} отмечен готовым владельцем (/mready), клиент получил «Принять этап».`);
    return { status: 'ready', text: this.afterMilestone(p.id, store.milestone(m.id)!) };
  }

  /** The invoice of the next stage, proposed as a Support task (`kp_invoice`, once: the accept above is atomic). */
  private proposeStageInvoice(p: Project, next: Milestone, all: Milestone[]): string {
    const totalUsd = all.reduce((a, x) => a + (x.amountUsd ?? 0), 0);
    const no = next.stageNo!;
    const last = no === all.length;
    this.hq.createTask({
      title: `Счёт этапа ${no}: ${p.client}`, dept: 'support', creator: 'head', priority: 1,
      meta: {
        action: 'kp_invoice', client: p.client, amountUsd: next.amountUsd, totalUsd, what: `Этап ${no} из ${all.length}: «${stageTitle(next)}», КП #${p.packId ?? '-'}`, packId: p.packId, leadId: p.leadId,
        projectId: p.id, stageNo: no, stageCount: all.length, ...(p.leadId !== null ? legalMeta(legalPartyOfLead(this.hq.db, p.leadId)) : {}),
        chain: `Цепочка: проект #${p.id}: этап ${no - 1} принят → счёт этапа ${no} (эта карточка) → этап ${no} стартует после оплаты${last ? ', доступы передаём после оплаты' : ''}`,
      },
    });
    const head = this.hq.headOf('support');
    if (head) this.hq.wake(head.id, 'task');
    return `Счёт этапа ${no} ($${next.amountUsd}) придёт карточкой на одобрение${last ? '; передача доступов ждёт его оплаты' : ''}.`;
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
      case 'mready': {
        const [ref = '', no = ''] = arg.trim().split(/\s+/);
        const p = this.store.find(ref);
        if (!p || !/^\d+$/.test(no)) return 'Формат: /mready <проект> <номер этапа>, например /mready 3 2';
        return this.readyStage(p.id, Number(no)).text;
      }
      case 'mdone': {
        const [ref = '', kind = ''] = arg.trim().split(/\s+/);
        const p = this.store.find(ref);
        // a project of the stage plan: the number of the stage (accepts it); an older project: the kind of the milestone
        if (p && /^\d+$/.test(kind)) return this.acceptStage(p.id, Number(kind), 'owner').text;
        const k = MILESTONE_KINDS.find((x) => x === kind.toLowerCase());
        if (!p || !k) return `Формат: /mdone <проект> ${MILESTONE_KINDS.join('|')} (у проекта с этапами оплаты: номер этапа, например /mdone 3 2)`;
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
    const llm = this.llmFor(actor, task.id);
    return {
      llm, db: this.hq.db, tz: this.hq.tz, now: this.hq.now,
      requestApproval: (kind, payload, summary) => Promise.resolve(staged.push({ kind, payload, summary }) - 1),
      log: (action, detail) => this.hq.log(actor, action, 'task', String(task.id), detail),
      tools: toolsFor(this.hq, this.d.tools, { agentId: actor, dept: PRODUCTION, taskId: task.id, llm, messenger: this.d.messenger, ownerId: this.d.ownerId }),
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
    if (action === 'handover') {
      const p = this.store.project(Number(task.meta.projectId));
      const text = `Последний этап проекта${p ? ` #${p.id} «${p.client}»` : ''} оплачен: можно передавать доступы, исходники и инструкцию клиенту.`;
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
    // Anything else from the Director (a bug on prod, a code change, an investigation) is work for a builder:
    // the task is blocked with the `builder` tag and the bridge turns it into a GitHub issue.
    this.hq.setMeta(task.id, { kind: 'adhoc' });
    this.hq.block(task.id, PRODUCTION_HEAD_ID, 'Нужен строитель: задача для Claude Code', ['builder']);
    await this.report(task.id, `Задача #${task.id} «${oneLine(task.title, 80)}» передана строителям: issue появится в течение 10 минут (/builders). Проекты клиентов: /project <клиент>: <что делаем>.`);
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
      // a stage starts when it is paid; the ones paid before the ТЗ was approved start now
      if (m.stageNo !== null && m.paidAt !== null && !m.taskId) {
        this.createStageBuilderTask(p, m);
        continue;
      }
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

  /** The work of one paid stage for a builder (blocked + tag `builder`: the bridge makes the issue). */
  private createStageBuilderTask(p: Project, m: Milestone): void {
    if (m.taskId) return;
    const t = this.builderTask({
      title: `${p.client}: ${m.title}`,
      body: `Проект #${p.id} «${p.client}», ${m.title}, целевая дата ${fmtDate(m.dueAt, this.hq.tz)}. Этап оплачен, работаем только в его объёме.\n\nТЗ:\n${p.spec}`,
      meta: { kind: 'work', projectId: p.id, milestoneId: m.id, milestone: 'stage', stageNo: m.stageNo, target: p.spec },
    });
    this.store.setMilestoneTask(m.id, t.id);
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
    } else if (kind === 'deploy') {
      await this.report(task.id, `Деплой готов (задача #${task.id}): ${oneLine(comment, 600)}`);
    } else {
      await this.report(task.id, `Строитель закончил задачу #${task.id} «${oneLine(task.title, 80)}»: ${oneLine(comment, 600)}`);
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
    if (m.stageNo !== null) {
      // payment by stages: finished work waits for the client's acceptance (cabinet) or the owner's /mdone; only that proposes the next invoice
      this.cabinet?.onStageReady(p, { stageNo: m.stageNo, title: stageTitle(m), titleEn: m.titleEn });
      return `Проект #${p.id} «${p.client}»: ${m.title} готов, ждёт приёмки: клиент принимает в кабинете или вы командой /mdone ${p.id} ${m.stageNo}.`;
    }
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
