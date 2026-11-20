import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { errMsg, log, parseStages, stagesFor, tryJson, type ApprovalQueue, type LlmClient, type Messenger } from '@fir/core';
import { meterLlm, type Agent, type Hq, type Task, type Worker, type WorkerCtx, type WorkerResult } from '@fir/hq';
import { billingStoreFor, type Invoice } from '@fir/worker-billing';
import { csStoreFor } from '@fir/worker-customer-support';
import { LeadIntakeWorker, leadStoreFor, TEMP_RU, type Delivery, type Lead } from '@fir/worker-lead-intake';
import { planStageDates, PmStore, type Product } from '@fir/worker-project-manager';
import {
  COPY_PREFIX, kindSpecs as prospectKinds, markReplied, onDecision as onProspectDecision, ProspectorWorker, PROSPECT_KINDS, statsText, storeFor as prospectStoreFor,
  STATUS_RU,
} from '@fir/worker-prospector';
import {
  DEFAULT_REWARD, kindSpecs as referralKinds, KIND_PAYOUT, markPaid, onDecision as onReferralDecision, parseReferralArg, payoutKindSpecs, payoutSummary, ReferralWorker,
  referrerFromSource, rewardSummary, statsText as referralStats, storeFor as referralStoreFor, KIND_REWARD, describe as describeReferral,
} from '@fir/worker-referral';
import {
  kindSpecs as presalesKinds, KIND_PACK, OFFERS, onDecision as onPresalesDecision, PresalesWorker, packMessages, storeFor as presalesStoreFor,
  isDirectionId, type DirectionId,
} from '@fir/worker-presales';
import { z } from 'zod';
import { recordManagerReply } from '../cabinet.js';
import { deliverOrHandOff, type ClientChannel } from '../client/channel.js';
import type { ApprovalEditor } from '../editor.js';
import type { LostLeads } from '../lost-leads.js';
import type { Reporter } from '../reporter.js';
import { toolsFor, type AppTools } from '../tools.js';

export const SALES = 'sales';
export const HEAD_ID = 'sales-head';
const PROSPECTOR_ID = 'prospector';
const LEADS_ID = 'lead-intake';
const PRESALES_ID = 'presales';
const REFERRAL_ID = 'referral';
export const CLIENT_BOT_ID = 'client-bot';
const AWAIT_KEY = 'sales_await_reply';

export interface SalesDeps {
  hq: Hq;
  /** Adapters and keys of the agents' toolbox (`docs/tools.md`, `src/tools.ts`); absent (tests): a toolbox without keys. */
  tools?: AppTools | undefined;
  llm: LlmClient;
  queue: ApprovalQueue;
  messenger: Messenger;
  ownerId: number;
  reporter: Reporter;
  /** Defaults: the real workers. Tests pass their own. */
  prospector?: Worker;
  leads?: Worker;
  presales?: Worker;
  referral?: Worker;
  /** Reward for a referral after the referred client pays (env REFERRAL_REWARD). */
  referralReward?: string;
  /** КП validity in days (env KP_VALID_DAYS). The payment split is by stages (`stagesFor`), no longer a prepayment share. */
  kpValidDays?: number;
  /** New Scout cards per daily batch. */
  batchSize?: number;
  slotHours?: [string, string];
  replyLevel?: 0 | 1;
  /** The public client bot: approved replies to leads that came from it go back into the client's chat. */
  client?: ClientChannel;
  /** A lead that fails before the owner sees it is written down here (kind `lost_lead`) and summed up in an hourly alert. */
  lost?: LostLeads;
}

type Action = 'lead' | 'batch' | 'followups' | 'reply' | 'stats' | 'kp' | 'referral_reminders' | 'none';
const ACTIONS: Action[] = ['lead', 'batch', 'followups', 'reply', 'stats', 'kp', 'referral_reminders'];
const splitSchema = z.object({ action: z.enum(['batch', 'followups', 'stats', 'none']) });
const reviewSchema = z.object({ ok: z.boolean(), issues: z.array(z.string()).max(10).default([]) });

interface Staged {
  kind: string;
  payload: Record<string, unknown>;
  summary: string;
}

/** Heuristics for the case without an LLM: only the obvious wordings. */
function guessAction(task: Task): Action {
  const text = `${task.title} ${task.body}`.toLowerCase();
  if (/дожим|напомн/.test(text)) return 'followups';
  if (/карточ|пакет|разведчик|новые бизнесы|batch/.test(text)) return 'batch';
  if (/воронк|статистик|статус разведчика|сколько отправлено/.test(text)) return 'stats';
  return 'none';
}

const oneLine = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n);

/** What a project of this direction is for the Production head (milestones and the ТЗ depend on it). */
const PRODUCT_OF_DIRECTION: Record<DirectionId, Product> = {
  admin: 'bot', receptionist: 'bot', automation: 'automation', content: 'automation', miniapp: 'app', agent: 'automation', implementation: 'automation', site: 'site',
};
export const productOfDirection = (direction: unknown): Product => (typeof direction === 'string' && isDirectionId(direction) ? PRODUCT_OF_DIRECTION[direction] : 'site');

/**
 * A lead is qualified when it has a service (a catalogue product counts) AND a budget or an estimate from the website's builder:
 * then the КП is made without waiting for `/kp` (owner decision 2026-11-19). A lead without a money signal waits for the owner.
 */
export function isQualified(lead: Pick<Lead, 'service' | 'budget'>, raw: Record<string, unknown> = {}): boolean {
  const service = lead.service.trim().toLowerCase();
  const product = typeof raw.product === 'string' ? raw.product.trim() : '';
  const hasService = (service !== '' && service !== 'unknown' && service !== 'other') || product !== '';
  const estimate = typeof raw.estimate === 'string' ? raw.estimate.trim() : '';
  return hasService && (lead.budget.trim() !== '' || estimate !== '');
}

/** First start: the Sales org (head, two workers) and its two daily routines. Instructions come from the file once. */
export function seedSales(hq: Hq, cfg: { instructionsDir: string; salesBudgetUsd: number }): void {
  hq.ensureAgent({
    id: HEAD_ID, dept: SALES, role: 'head', title: 'Голова продаж', instructions: readFileSync(join(cfg.instructionsDir, 'sales-head.md'), 'utf8').trim(),
    bossId: 'director', bot: 'SALES_BOT_TOKEN', budgetUsdMonth: cfg.salesBudgetUsd,
  });
  hq.ensureAgent({ id: PROSPECTOR_ID, dept: SALES, role: 'worker', title: 'Разведчик', bossId: HEAD_ID });
  hq.ensureAgent({ id: LEADS_ID, dept: SALES, role: 'worker', title: 'Приёмщик лидов', bossId: HEAD_ID });
  hq.ensureAgent({ id: PRESALES_ID, dept: SALES, role: 'worker', title: 'Пресейл', bossId: HEAD_ID });
  hq.ensureAgent({ id: REFERRAL_ID, dept: SALES, role: 'worker', title: 'Рекомендации', bossId: HEAD_ID });
  // the public client bot and the website chat: their LLM calls are metered under this agent
  hq.ensureAgent({ id: CLIENT_BOT_ID, dept: SALES, role: 'worker', title: 'Клиентский бот', bossId: HEAD_ID });
  const routines = [
    // made on the owner's clock, early enough for his 09:00 batch
    { name: 'sales-daily-cards', cron: '30 7 * * *', tz: 'owner' as const, dept: SALES, title: 'Карточки Разведчика на сегодня', meta: { action: 'batch' } },
    { name: 'sales-followups', cron: '40 7 * * *', tz: 'owner' as const, dept: SALES, title: 'Дожимы Разведчика', meta: { action: 'followups' } },
    { name: 'sales-referral-reminders', cron: '20 7 * * *', tz: 'owner' as const, dept: SALES, title: 'Напоминания по рекомендациям и выплатам', meta: { action: 'referral_reminders' } },
  ];
  hq.syncRoutines('sales', routines);
}

/**
 * Head of the Sales department. One heartbeat cycle: take the department's tasks (a lead from the site webhook, the
 * daily Scout routines, the owner's `/reply`), run the right worker, check a lead reply against the checklist (LLM,
 * strict JSON, one rework), and put every draft into the approval queue. The Scout's cards become one task and one
 * approval each (buttons «Скопировать / Править / Пропустить / Отправлено»). Nothing is sent to anybody by the system:
 * the owner sends first messages himself; the approved lead reply is handed to the owner for sending.
 */
export class SalesHead implements ApprovalEditor {
  readonly prospector: Worker;
  readonly leads: Worker;
  readonly presales: Worker;
  readonly referral: Worker;

  constructor(private readonly d: SalesDeps) {
    this.prospector = d.prospector ?? new ProspectorWorker({ ...(d.batchSize !== undefined ? { batchSize: d.batchSize } : {}) });
    this.leads = d.leads ?? new LeadIntakeWorker({ ...(d.slotHours ? { slotHours: d.slotHours } : {}), ...(d.replyLevel !== undefined ? { replyLevel: d.replyLevel } : {}) });
    this.presales = d.presales ?? new PresalesWorker({
      ...(d.kpValidDays !== undefined ? { validDays: d.kpValidDays } : {}),
    });
    this.referral = d.referral ?? new ReferralWorker();
    const base = { db: d.hq.db, now: d.hq.now };
    referralStoreFor(base, d.referralReward ?? DEFAULT_REWARD); // fixes the reward text before any worker touches the table
    for (const [kind, spec] of Object.entries({ ...presalesKinds(base), ...referralKinds(base), ...payoutKindSpecs(base) })) d.hq.registerKind(kind, spec);
    for (const [kind, spec] of Object.entries(prospectKinds(base))) d.hq.registerKind(kind, spec);
    if (this.leads instanceof LeadIntakeWorker) {
      for (const [kind, spec] of Object.entries(this.leads.kindSpecs(base, (x) => this.deliver(x)))) d.hq.registerKind(kind, spec);
    }
    // The owner skipped a card or its execution failed: the prospect follows.
    d.hq.onApprovalDecision((link, state) => onProspectDecision(base, link, state));
    d.hq.onApprovalDecision((link, state) => onPresalesDecision(base, link, state));
    d.hq.onApprovalDecision((link, state) => onReferralDecision(base, link, state));
    // The chain after an approved КП: a project is only RESERVED (it starts on the first payment), the contract and the invoice are drafted at once.
    d.hq.onApprovalDecision((link, state) => {
      if (link.kind === KIND_PACK && state === 'executed') this.afterKpApproved(link.taskId, link.payload);
    });
  }

  /**
   * An approved КП (owner decisions 2026-11-19 and 2026-11-21, payment by stages): (1) a `draft` project is reserved in `pm_projects` with one
   * milestone per stage (nothing paid yet; the project starts when stage 1 is paid); (2) Documents drafts the contract and Billing drafts the
   * invoice of STAGE 1 only, both locked, in one go. The three cards name each other: «КП #12 → договор → счёт этапа 1». The next invoice is
   * proposed when the client accepts the previous stage (Production, `acceptStage`). A drill task never makes a real project or invoice.
   */
  private afterKpApproved(taskId: number, pack: Record<string, unknown>): void {
    const hq = this.hq;
    if (hq.task(taskId)?.tags.includes('drill')) return;
    const base = { db: hq.db, now: hq.now };
    const leadId = Number(pack.leadId);
    const lead = Number.isInteger(leadId) && leadId > 0 ? leadStoreFor(base).get(leadId) : undefined;
    const packId = Number(pack.packId);
    const direction = typeof pack.direction === 'string' && isDirectionId(pack.direction) ? pack.direction : 'site';
    const offer = OFFERS[direction];
    const client = lead?.name || (lead ? `лид #${lead.id}` : `КП #${packId}`);
    const what = (lead?.task || offer.title).trim() || 'по утверждённому КП';
    const totalUsd = Number(pack.totalUsd) || offer.fromUsd;
    const monthlyUsd = Number(pack.monthlyUsd) || 0;
    // the stage plan of the КП travels with the pack; an older pack without it gets the plan the price list would give now
    const stages = parseStages(pack.stages) ?? stagesFor(totalUsd, [direction]);
    const first = stages[0]!;
    // what the client already has travels with the chain: the contract and the invoice carry the same conditions line as the КП
    const infra = { ...(typeof pack.hasDomain === 'boolean' ? { hasDomain: pack.hasDomain } : {}), ...(typeof pack.hasHosting === 'boolean' ? { hasHosting: pack.hasHosting } : {}) };
    const product = productOfDirection(direction);
    const dueAts = planStageDates(product, stages.map((x) => x.share), hq.now(), hq.tz);
    const project = new PmStore(hq.db, hq.now).reserve({ client, what, product, leadId: lead?.id ?? null, packId, stages, dueAts });
    const line = (here: 'contract' | 'invoice') =>
      `Цепочка: КП #${packId} (утверждено) → договор${here === 'contract' ? ' (эта карточка)' : ''} → счёт этапа 1${here === 'invoice' ? ' (эта карточка)' : ''} → проект #${project.id} стартует после оплаты этапа 1`;
    hq.createTask({
      title: `Договор: ${client}`, dept: 'backoffice', creator: 'head', priority: 1,
      meta: { action: 'doc', type: 'contract', client, chain: line('contract'), packId, leadId: lead?.id ?? null, projectId: project.id, priceUsd: totalUsd, stages, ...(monthlyUsd > 0 ? { monthlyUsd } : {}), ...infra },
    });
    hq.wake('backoffice-head', 'task');
    hq.createTask({
      title: `Счёт этапа 1: ${client}`, dept: 'support', creator: 'head', priority: 1,
      meta: {
        action: 'kp_invoice', client, amountUsd: first.amountUsd, totalUsd, what: `Этап 1 из ${stages.length}: «${first.title.ru}», КП #${packId}: ${offer.title}`, packId, leadId: lead?.id ?? null,
        projectId: project.id, stageNo: 1, stageCount: stages.length, chain: line('invoice'), ...infra,
      },
    });
    hq.wake('support-head', 'task');
    hq.log(HEAD_ID, 'kp_chain', 'pack', String(packId), `project ${project.id}`);
    void this.d.reporter.post(SALES, `КП #${packId} утверждено (${client}): проект #${project.id} зарезервирован (этапов: ${stages.length}), договор и счёт этапа 1 ($${first.amountUsd}) готовятся и придут карточками. Проект стартует после оплаты этапа 1, следующие счета после приёмки этапов.`);
  }

  /**
   * An invoice of a lead's КП was paid (called by Support after `/paid` or the watcher): when the lead came with `ref:<slug>`, the payout of 10% of
   * THIS paid stage is asked of the owner, one locked approval per stage (idempotent: a repeated hook asks nothing). An invoice outside the stage
   * plan (older chain) keeps the old rule: the first paid invoice of the lead, 10% of the estimate total. Returns lines for the owner.
   */
  async onInvoicePaid(inv: Invoice): Promise<string[]> {
    if (inv.leadId === null) return [];
    const base = { db: this.hq.db, now: this.hq.now };
    if (inv.stageNo === null && billingStoreFor(base).paidCountForLead(inv.leadId) !== 1) return [];
    const lead = leadStoreFor(base).get(inv.leadId);
    const ref = lead ? referrerFromSource(lead.origin) : null;
    if (!lead || !ref || !(this.referral instanceof ReferralWorker)) return [];
    const { referral } = this.rstore().propose({ referrer: ref, referred: lead.name || `лид #${lead.id}`, leadId: lead.id, source: 'lead' });
    const contact = csStoreFor(base).clientByName(ref)?.contact ?? '';
    // the base of the payout: the paid stage (stage plan) or the estimate total (older chain)
    const payBase = inv.stageNo !== null ? inv.amountUsd : inv.totalUsd ?? inv.amountUsd;
    if (inv.stageNo !== null && inv.stageNo > 1) {
      const later = this.referral.requestStagePayout(base, { referralId: referral.id, stageNo: inv.stageNo, stageUsd: payBase, contact, invoiceNumber: inv.number });
      if (!later) return [];
      const t = this.hq.createTask({ title: `Выплата рекомендателю #${referral.id}, этап ${inv.stageNo}`, dept: SALES, assigneeId: REFERRAL_ID, creator: 'head', priority: 1, meta: { action: 'referral_payout', referralId: referral.id, invoice: inv.number, stageNo: inv.stageNo } });
      this.hq.claim(t.id, REFERRAL_ID);
      const r = this.rstore().get(referral.id)!;
      await this.hq.requestApproval(
        t.id, REFERRAL_ID, KIND_PAYOUT,
        { referralId: referral.id, amountUsd: later.usd, contact: contact || r.payoutContact, referrer: r.referrer, invoice: inv.number, stageNo: inv.stageNo },
        payoutSummary({ ...r, payoutContact: contact || r.payoutContact }, inv.number, { no: inv.stageNo, usd: later.usd }),
      );
      return [`Рекомендатель ${r.referrer}: выплата $${later.usd} (10% этапа ${inv.stageNo}, USDT) придёт карточкой в пачке, выплатить в течение 7 дней.`];
    }
    const asked = this.referral.requestPayout(base, { referralId: referral.id, totalUsd: payBase, contact });
    if (!asked) return [];
    const stage = inv.stageNo !== null ? { no: inv.stageNo, usd: asked.payoutUsd ?? 0 } : undefined;
    const t = this.hq.createTask({ title: `Выплата рекомендателю #${asked.id}`, dept: SALES, assigneeId: REFERRAL_ID, creator: 'head', priority: 1, meta: { action: 'referral_payout', referralId: asked.id, invoice: inv.number } });
    this.hq.claim(t.id, REFERRAL_ID);
    await this.hq.requestApproval(
      t.id, REFERRAL_ID, KIND_PAYOUT,
      { referralId: asked.id, amountUsd: asked.payoutUsd, contact: asked.payoutContact, referrer: asked.referrer, invoice: inv.number, ...(stage ? { stageNo: 1 } : {}) },
      payoutSummary(asked, inv.number, stage),
    );
    return [`Рекомендатель ${asked.referrer}: выплата $${asked.payoutUsd} (${stage ? '10% этапа 1' : '10% сметы'}, USDT) придёт карточкой в пачке, выплатить в течение 7 дней.`];
  }

  private get hq(): Hq {
    return this.d.hq;
  }

  private agent(): Agent {
    return this.hq.agent(HEAD_ID)!;
  }

  private llmFor(agentId: string, taskId: number | null): LlmClient {
    return meterLlm(this.d.llm, this.hq, { agentId, taskId });
  }

  private rstore() {
    return referralStoreFor({ db: this.hq.db, now: this.hq.now });
  }

  private pstore() {
    return prospectStoreFor({ db: this.hq.db, now: this.hq.now });
  }

  /** Report: always into the task journal (the morning summary reads it), plus the department topic when configured. */
  private async report(taskId: number, text: string): Promise<void> {
    this.hq.addEvent(taskId, 'report', HEAD_ID, text);
    await this.d.reporter.post(SALES, text);
  }

  /** The approved reply to a lead: into the client's bot chat when the lead came from there, else to the owner to send himself. */
  private async deliver(x: Delivery): Promise<void> {
    // a cabinet client reads the approved answer in the lead's thread as well (no-op for leads without a cabinet)
    if (Number.isInteger(x.leadId)) recordManagerReply(this.hq.db, this.hq.now(), x.leadId, x.text);
    await deliverOrHandOff({
      client: this.d.client, messenger: this.d.messenger, ownerId: this.d.ownerId, chatId: x.chatId, text: x.text, ref: `Лид #${x.leadId}`, contact: x.contact,
      ownerText: `Лид #${x.leadId}: ответ утверждён, отправьте клиенту ${x.contact}${x.name ? ` (${x.name})` : ''}:\n\n${x.text}`,
    });
  }

  // ---- heartbeat ----
  async onHeartbeat(): Promise<void> {
    if (this.agent().status !== 'active') return;
    for (const t of [...this.hq.tasks({ dept: SALES, status: 'inbox' }), ...this.hq.tasks({ dept: SALES, status: 'assigned', assigneeId: HEAD_ID })]) {
      await this.handle(t).catch((e) => this.crash(t, e));
    }
  }

  /** A lead the owner will not see through the normal path (the task crashed or its worker failed): the contact is kept for the hourly alert. */
  private lostLead(task: Task, reason: string): void {
    if (task.meta.action !== 'lead' || task.meta.lostMarked === true || !this.d.lost) return;
    const raw = (task.meta.lead ?? {}) as { contact?: unknown };
    this.d.lost.record('lead', reason, { ...(typeof raw.contact === 'string' ? { contact: raw.contact } : {}), ref: `задача #${task.id}` });
    this.hq.setMeta(task.id, { lostMarked: true });
  }

  private async crash(task: Task, e: unknown): Promise<void> {
    this.lostLead(task, `сбой обработки заявки: ${errMsg(e)}`);
    log('error', 'sales task crashed', { task: task.id, err: errMsg(e) });
    const cur = this.hq.task(task.id);
    if (cur && cur.status !== 'blocked' && cur.status !== 'done' && cur.status !== 'rejected') this.hq.block(task.id, HEAD_ID, `Сбой: ${errMsg(e)}`.slice(0, 300));
    await this.hq.alert(`Продажи: задача #${task.id} заблокирована (сбой), подробности в журнале задачи.`);
  }

  private async decide(task: Task): Promise<Action> {
    const m = task.meta.action;
    if (typeof m === 'string' && (ACTIONS as string[]).includes(m)) return m as Action;
    const res = await tryJson(
      this.llmFor(HEAD_ID, task.id),
      {
        tier: 'haiku', maxTokens: 200,
        system: `${this.agent().instructions}\n\nОпредели, какому исполнителю отдела продаж отдать задачу. Ответ: только JSON {"action": "batch"|"followups"|"stats"|"none"}. batch: новые карточки Разведчика; followups: дожимы; stats: воронка Разведчика; none: задача не для этого отдела.`,
        messages: [{ role: 'user', content: `Задача: ${task.title}\n${task.body}`.slice(0, 2000) }],
      },
      splitSchema,
    );
    return res?.action ?? guessAction(task);
  }

  private async handle(task: Task): Promise<void> {
    if (!this.hq.claim(task.id, HEAD_ID)) return;
    if (this.hq.overBudget(SALES)) return void this.hq.block(task.id, HEAD_ID, 'Лимит расходов отдела исчерпан');
    const action = await this.decide(task);
    if (action === 'none') {
      this.hq.block(task.id, HEAD_ID, 'Нет подходящего исполнителя в отделе продаж');
      return void (await this.report(task.id, `Задача #${task.id} «${oneLine(task.title, 80)}» не для продаж: нет исполнителя. Нужен строитель или другой отдел?`));
    }
    if (action === 'stats') {
      const text = statsText(this.pstore());
      this.hq.complete(task.id, HEAD_ID, text);
      return void (await this.report(task.id, text));
    }
    if (action === 'referral_reminders') {
      const res = await this.runOnce(task.id, this.referral, REFERRAL_ID, []);
      if (!res.ok) return void this.hq.block(task.id, HEAD_ID, res.error ?? 'сбой напоминаний');
      this.hq.complete(task.id, HEAD_ID, res.result || 'Напоминаний нет');
      if (res.result) await this.report(task.id, res.result);
      // a payout that waits 7 days is money owed to a person: the owner hears it at once, not only in the summary
      const waiting = res.result.split('\n').find((l) => l.startsWith('Выплаты рекомендателям'));
      if (waiting) await this.hq.alert(waiting);
      return;
    }
    this.hq.setMeta(task.id, { action });
    await this.runWorkerTask(task.id, action === 'lead' ? LEADS_ID : action === 'kp' ? PRESALES_ID : PROSPECTOR_ID, action);
  }

  // ---- worker run, review (leads), approvals ----
  private ctx(task: Task, staged: Staged[], actor: string): WorkerCtx {
    const llm = this.llmFor(actor, task.id);
    return {
      llm, db: this.hq.db, tz: this.hq.tz, now: this.hq.now,
      requestApproval: (kind, payload, summary) => Promise.resolve(staged.push({ kind, payload, summary }) - 1),
      log: (action, detail) => this.hq.log(actor, action, 'task', String(task.id), detail),
      tools: toolsFor(this.hq, this.d.tools, { agentId: actor, dept: SALES, taskId: task.id, llm, messenger: this.d.messenger, ownerId: this.d.ownerId }),
    };
  }

  private async review(task: Task, result: string): Promise<{ ok: boolean; issues: string[]; skipped?: boolean }> {
    const res = await tryJson(
      this.llmFor(HEAD_ID, task.id),
      {
        tier: 'haiku', maxTokens: 600,
        system: `${this.agent().instructions}\n\nПроверь ответ клиенту по чек-листу выше. Ответ: только JSON {"ok": true|false, "issues": ["что исправить, коротко"]}. ok true, если нарушений нет. Не придумывай замечаний, которых нет.`,
        messages: [{ role: 'user', content: `Задача: ${task.title}\n\nКарточка лида и ответ:\n${result}`.slice(0, 8000) }],
      },
      reviewSchema,
    );
    if (res) return res;
    // LLM off or garbage: the check did NOT run. It is logged as skipped (never as passed); the owner's approval is the safety net.
    this.hq.comment(task.id, HEAD_ID, 'Ревью по чек-листу пропущено: модель не дала разборчивого ответа.');
    this.hq.log(HEAD_ID, 'review_skipped', 'task', String(task.id));
    return { ok: true, issues: [], skipped: true };
  }

  private async runOnce(taskId: number, worker: Worker, actor: string, staged: Staged[]): Promise<WorkerResult> {
    staged.length = 0;
    const t = this.hq.task(taskId)!;
    try {
      return await worker.run(t, this.ctx(t, staged, actor));
    } catch (e) {
      return { ok: false, result: '', error: errMsg(e) };
    }
  }

  private async runWorkerTask(taskId: number, actor: string, action: Action): Promise<void> {
    const worker = actor === LEADS_ID ? this.leads : actor === PRESALES_ID ? this.presales : this.prospector;
    const staged: Staged[] = [];
    const fail = async (error: string | undefined) => {
      this.lostLead(this.hq.task(taskId)!, `заявка не разобрана: ${error ?? 'исполнитель не вернул результат'}`);
      this.hq.block(taskId, actor, error ?? 'исполнитель не вернул результат');
      await this.hq.alert(`Продажи: задача #${taskId} не выполнена: ${(error ?? '').slice(0, 200)}`);
    };
    let res = await this.runOnce(taskId, worker, actor, staged);
    if (!res.ok) return fail(res.error);
    let warn = '';
    if (action === 'lead') {
      this.hq.setStatus(taskId, 'review', HEAD_ID, 'проверка по чек-листу');
      let verdict = await this.review(this.hq.task(taskId)!, res.result);
      if (!verdict.ok) {
        this.hq.comment(taskId, HEAD_ID, `Ревью, замечания: ${verdict.issues.join('; ')}`);
        this.hq.setStatus(taskId, 'running', HEAD_ID, 'доработка');
        this.hq.setMeta(taskId, { feedback: verdict.issues.join('; ') });
        res = await this.runOnce(taskId, worker, actor, staged);
        if (!res.ok) return fail(res.error);
        this.hq.setStatus(taskId, 'review', HEAD_ID, 'повторная проверка');
        verdict = await this.review(this.hq.task(taskId)!, res.result);
      }
      if (verdict.skipped) warn = '\nРевью по чек-листу пропущено (модель не ответила): проверьте текст сами.';
      else if (!verdict.ok) warn = `\nРевью отдела после доработки: ${verdict.issues.join('; ')}.`;
    }
    const task = this.hq.task(taskId)!;
    // The Scout's batch: one child task and one approval per card, so the daily routine is never held up by cards the owner has not decided yet.
    const fanOut = (action === 'batch' || action === 'followups') && staged.length > 0;
    if (fanOut) {
      this.hq.complete(taskId, actor, res.result);
      for (const s of staged) {
        const child = this.hq.createTask({
          title: oneLine(s.summary.split('\n')[0] ?? 'Карточка', 120), dept: SALES, assigneeId: PROSPECTOR_ID, creator: 'head', parentId: taskId, priority: task.priority,
          meta: { action: 'card', prospectId: s.payload.prospectId ?? null },
        });
        this.hq.claim(child.id, PROSPECTOR_ID);
        await this.hq.requestApproval(child.id, PROSPECTOR_ID, s.kind, s.payload, s.summary);
      }
      return void (await this.report(taskId, `Разведчик: ${res.result} Карточки придут в утренней пачке на одобрение (или /approve).`));
    }
    this.hq.complete(taskId, actor, res.result, staged.length > 0 ? 'review' : 'done');
    // Proposals that wait for the owner go first: one that runs at once (level 1) must not close the task while another is still open.
    staged.sort((a, b) => this.d.queue.level(a.kind) - this.d.queue.level(b.kind));
    for (const s of staged) await this.hq.requestApproval(taskId, actor, s.kind, s.payload, s.summary + warn);
    if (action === 'lead') await this.afterLead(taskId, staged.length);
    else await this.report(taskId, staged.length > 0 ? `Задача #${taskId}: ${res.result} Придёт в пачке на одобрение.` : `Задача #${taskId}: ${res.result}`);
  }

  private async afterLead(taskId: number, approvals: number): Promise<void> {
    const lead = leadStoreFor({ db: this.hq.db, now: this.hq.now }).byTask(taskId);
    if (!lead) return;
    await this.report(
      taskId,
      `Лид #${lead.id}: ${TEMP_RU[lead.temperature]}, ниша ${lead.niche || '?'}, задача ${oneLine(lead.task, 80) || '?'}. ${approvals} на одобрение, контакт в карточке.`,
    );
    const ref = referrerFromSource(lead.origin);
    if (ref) {
      const { referral, created } = this.rstore().propose({ referrer: ref, referred: lead.name || `лид #${lead.id}`, leadId: lead.id, source: 'lead' });
      if (created) await this.report(taskId, `Рекомендация ${describeReferral(referral)}, выплата после первой оплаты клиента (10% сметы, USDT). Счёт отмечается: /paid <номер счёта>.`);
    }
    if (lead.temperature === 'hot') await this.hq.alert(`Горячий лид #${lead.id} (${lead.niche || 'ниша не ясна'}). Карточка с контактом в пачке на одобрение, /approve.`);
    await this.startKpFor(taskId, lead);
  }

  /** A qualified lead (service and budget or estimate) gets its КП by itself, once; `/kp` stays for the rest and for a redo. */
  private async startKpFor(taskId: number, lead: Lead): Promise<void> {
    const task = this.hq.task(taskId);
    if (!task || task.tags.includes('drill')) return;
    const raw = (task.meta.lead ?? {}) as Record<string, unknown>;
    if (!isQualified(lead, raw)) return;
    const base = { db: this.hq.db, now: this.hq.now };
    if (presalesStoreFor(base).byLead(lead.id).some((x) => x.status === 'draft' || x.status === 'approved')) return;
    if (this.hq.tasks({ dept: SALES, open: true, limit: 500 }).some((t) => t.meta.action === 'kp' && t.meta.leadId === lead.id)) return;
    const kp = this.hq.createTask({ title: `КП для лида #${lead.id} ${oneLine(lead.name, 60)}`, dept: SALES, creator: 'head', priority: 1, meta: { action: 'kp', leadId: lead.id, auto: true } });
    this.hq.wake(HEAD_ID, 'task');
    await this.report(taskId, `Лид #${lead.id} квалифицирован (услуга и бюджет или смета): КП, смета и черновик договора готовятся сами (задача #${kp.id}), карточка придёт в пачке.`);
  }

  // ---- the webhook creates a task per lead ----
  /** `POST /lead` and the client bot call this: a Sales task with the lead fields in `meta.lead`, the head wakes. Returns the task id. */
  createLeadTask(lead: Record<string, unknown>, service: string): number {
    const where = lead.source === 'telegram' || typeof lead.chatId === 'number' ? 'Лид из Telegram' : lead.source === 'web' ? 'Лид из веб-чата' : 'Лид с сайта';
    const t = this.hq.createTask({ title: `${where} (${service || 'форма'})`, dept: SALES, creator: 'routine', priority: 1, meta: { action: 'lead', lead } });
    this.hq.wake(HEAD_ID, 'task');
    return t.id;
  }

  // ---- /reply <id> (the Director's intent `sales_reply`) ----
  /** The business answered. Moves the prospect to replied; with the answer text makes a task, otherwise waits for the text. */
  async startReply(id: number, text?: string): Promise<string> {
    const r = markReplied(this.pstore(), id);
    if (!r.ok) {
      return r.reason === 'unknown'
        ? 'Не нашёл такого бизнеса. Формат: /reply <id>, номер из карточки (#12).'
        : `#${id} ${r.prospect!.name}: статус «${STATUS_RU[r.prospect!.status]}», ответить можно только после «Отправлено».`;
    }
    if (text?.trim()) return this.queueReply(r.prospect.id, r.prospect.name, text.trim());
    this.hq.setSetting(AWAIT_KEY, String(r.prospect.id));
    return `#${r.prospect.id} ${r.prospect.name}: ответ отмечен. Перешлите текст ответа одним сообщением, подготовлю черновик. Цены утверждаете вы.`;
  }

  private queueReply(prospectId: number, name: string, replyText: string): string {
    this.hq.createTask({ title: `Ответ бизнесу #${prospectId} ${name}`, dept: SALES, creator: 'owner', priority: 1, meta: { action: 'reply', prospectId, replyText: replyText.slice(0, 2000) } });
    this.hq.wake(HEAD_ID, 'task');
    return `Готовлю черновик ответа для #${prospectId} ${name}. Карточка придёт в пачке на одобрение (10:00 или /approve).`;
  }

  // ---- the owner's commands /kp, /referral, /referrals, /paid (the Director passes them through as they are) ----
  /** Returns what to tell the owner. */
  async salesCommand(name: string, arg: string): Promise<string> {
    const a = arg.trim();
    if (name === 'kp') return this.startKp(a);
    if (name === 'referrals') return referralStats(this.rstore());
    if (name === 'referral') {
      const p = parseReferralArg(a);
      if (!p) return 'Формат: /referral <клиент> -> <новый лид>, например /referral Cambridge -> Blanche.';
      const asLead = /^#?\d+$/.test(p.referred) ? leadStoreFor({ db: this.hq.db, now: this.hq.now }).get(Number(p.referred.replace('#', ''))) : undefined;
      const { referral, created } = this.rstore().propose({ referrer: p.referrer, referred: asLead ? asLead.name || p.referred : p.referred, leadId: asLead?.id ?? null, source: 'owner' });
      return created
        ? `Записал: ${describeReferral(referral)}. Награда после оплаты: ${referral.reward}. Когда клиент оплатит: /paid ${referral.id}.`
        : `Уже записано: ${describeReferral(referral)}, статус «${referral.status}».`;
    }
    if (name === 'paid') return this.paid(Number(a.replace(/^#/, '')));
    return 'Неизвестная команда продаж.';
  }

  private startKp(arg: string): string {
    if (!arg) return 'Формат: /kp <номер лида> или /kp <описание клиента и задачи>.';
    const m = /^#?(\d+)$/.exec(arg);
    const meta: Record<string, unknown> = { action: 'kp' };
    let title = 'КП по запросу владельца';
    if (m) {
      const lead = leadStoreFor({ db: this.hq.db, now: this.hq.now }).get(Number(m[1]));
      if (!lead) return `Лид ${m[1]} не найден. Номер в карточке лида (#12).`;
      meta.leadId = lead.id;
      title = `КП для лида #${lead.id} ${oneLine(lead.name, 60)}`;
    } else meta.text = arg.slice(0, 2000);
    this.hq.createTask({ title, dept: SALES, creator: 'owner', priority: 1, meta });
    this.hq.wake(HEAD_ID, 'task');
    return `Готовлю КП, смету и черновик договора. Придут одним предложением в пачке на одобрение (10:00 или /approve).`;
  }

  private async paid(id: number): Promise<string> {
    const r = markPaid(this.rstore(), id);
    if (!r.ok) return r.reason === 'unknown' ? 'Не нашёл такой рекомендации. Формат: /paid <id>, список: /referrals.' : `${describeReferral(r.referral!)}: награда уже применена.`;
    if (r.already && r.referral.rewardRequested) return `${describeReferral(r.referral)}: награда уже ждёт вашего решения (/approve).`;
    const t = this.hq.createTask({ title: `Награда за рекомендацию #${r.referral.id}`, dept: SALES, assigneeId: REFERRAL_ID, creator: 'owner', priority: 1, meta: { action: 'referral_reward', referralId: r.referral.id } });
    this.hq.claim(t.id, REFERRAL_ID);
    this.rstore().setRewardRequested(r.referral.id, true);
    await this.hq.requestApproval(t.id, REFERRAL_ID, KIND_REWARD, { referralId: r.referral.id }, rewardSummary(r.referral));
    return `${describeReferral(r.referral)}: оплата отмечена. Награда (${r.referral.reward}) придёт на одобрение в пачке (10:00 или /approve).`;
  }

  // ---- the owner's free text after /reply (ApprovalEditor contract; no per-kind part editing here) ----
  async press(): Promise<string> {
    return 'Уже обработано';
  }

  async pick(): Promise<string> {
    return 'Нет такой части';
  }

  async consume(text: string): Promise<boolean> {
    const awaited = this.hq.setting(AWAIT_KEY);
    if (!awaited) return false;
    this.hq.setSetting(AWAIT_KEY, '');
    const p = this.pstore().get(Number(awaited));
    if (!p) return true;
    await this.d.messenger.send(this.d.ownerId, this.queueReply(p.id, p.name, text.trim()));
    return true;
  }

  cancel(): void {
    this.hq.setSetting(AWAIT_KEY, '');
  }

  // ---- «Скопировать» ----
  /** Button `pc:<approvalId>:c`: sends the plain draft as a separate message. Returns the callback toast. */
  async onCopy(approvalId: number): Promise<string> {
    const row = this.d.queue.get(approvalId);
    if (row?.kind === KIND_PACK && (row.status === 'pending' || row.status === 'editing')) {
      for (const m of packMessages(row.payload)) await this.d.messenger.send(this.d.ownerId, m);
      return 'Документы ниже';
    }
    if (!row || !(PROSPECT_KINDS as readonly string[]).includes(row.kind) || (row.status !== 'pending' && row.status !== 'editing') || typeof row.payload.text !== 'string') return 'Уже обработано';
    await this.d.messenger.send(this.d.ownerId, row.payload.text);
    return 'Текст ниже';
  }
}

/** Callback data of the «Скопировать» button, `pc:<approvalId>:c`. */
export const parseCopy = (data: string): number | null => {
  const m = new RegExp(`^${COPY_PREFIX}:(\\d+):c$`).exec(data);
  return m ? Number(m[1]) : null;
};
