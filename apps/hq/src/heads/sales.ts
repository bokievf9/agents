import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { errMsg, log, tryJson, type ApprovalQueue, type LlmClient, type Messenger } from '@fir/core';
import { meterLlm, type Agent, type Hq, type Task, type Worker, type WorkerCtx, type WorkerResult } from '@fir/hq';
import { LeadIntakeWorker, leadStoreFor, TEMP_RU, type Delivery } from '@fir/worker-lead-intake';
import {
  COPY_PREFIX, kindSpecs as prospectKinds, markReplied, onDecision as onProspectDecision, ProspectorWorker, PROSPECT_KINDS, statsText, storeFor as prospectStoreFor,
  STATUS_RU,
} from '@fir/worker-prospector';
import {
  DEFAULT_REWARD, kindSpecs as referralKinds, markPaid, onDecision as onReferralDecision, parseReferralArg, ReferralWorker, referrerFromSource, rewardSummary,
  statsText as referralStats, storeFor as referralStoreFor, KIND_REWARD, describe as describeReferral,
} from '@fir/worker-referral';
import {
  kindSpecs as presalesKinds, KIND_PACK, onDecision as onPresalesDecision, PresalesWorker, packMessages,
} from '@fir/worker-presales';
import { z } from 'zod';
import { deliverOrHandOff, type ClientChannel } from '../client/channel.js';
import type { ApprovalEditor } from '../editor.js';
import type { Reporter } from '../reporter.js';

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
  /** КП: prepayment share in percent and validity in days (env PREPAYMENT_PERCENT, KP_VALID_DAYS). */
  prepaymentPercent?: number;
  kpValidDays?: number;
  /** New Scout cards per daily batch. */
  batchSize?: number;
  slotHours?: [string, string];
  replyLevel?: 0 | 1;
  /** The public client bot: approved replies to leads that came from it go back into the client's chat. */
  client?: ClientChannel;
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
    { name: 'sales-daily-cards', cron: '0 10 * * *', dept: SALES, title: 'Карточки Разведчика на сегодня', meta: { action: 'batch' } },
    { name: 'sales-followups', cron: '5 10 * * *', dept: SALES, title: 'Дожимы Разведчика', meta: { action: 'followups' } },
    { name: 'sales-referral-reminders', cron: '30 9 * * *', dept: SALES, title: 'Напоминания по рекомендациям', meta: { action: 'referral_reminders' } },
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
      ...(d.prepaymentPercent !== undefined ? { prepaymentPercent: d.prepaymentPercent } : {}), ...(d.kpValidDays !== undefined ? { validDays: d.kpValidDays } : {}),
    });
    this.referral = d.referral ?? new ReferralWorker();
    const base = { db: d.hq.db, now: d.hq.now };
    referralStoreFor(base, d.referralReward ?? DEFAULT_REWARD); // fixes the reward text before any worker touches the table
    for (const [kind, spec] of Object.entries({ ...presalesKinds(base), ...referralKinds(base) })) d.hq.registerKind(kind, spec);
    for (const [kind, spec] of Object.entries(prospectKinds(base))) d.hq.registerKind(kind, spec);
    if (this.leads instanceof LeadIntakeWorker) {
      for (const [kind, spec] of Object.entries(this.leads.kindSpecs(base, (x) => this.deliver(x)))) d.hq.registerKind(kind, spec);
    }
    // The owner skipped a card or its execution failed: the prospect follows.
    d.hq.onApprovalDecision((link, state) => onProspectDecision(base, link, state));
    d.hq.onApprovalDecision((link, state) => onPresalesDecision(base, link, state));
    d.hq.onApprovalDecision((link, state) => onReferralDecision(base, link, state));
    // Sales -> Production: an approved КП pack becomes a project task for the Production head.
    d.hq.onApprovalDecision((link, state) => {
      if (link.kind !== KIND_PACK || state !== 'executed') return;
      const leadId = Number(link.payload.leadId);
      const lead = Number.isInteger(leadId) && leadId > 0 ? leadStoreFor(base).get(leadId) : undefined;
      const client = lead?.name || (lead ? `лид #${lead.id}` : `КП #${String(link.payload.packId)}`);
      const what = (lead?.task || String(link.payload.direction ?? '')).trim() || 'по утверждённому КП';
      d.hq.createTask({ title: `Проект: ${client}`, body: what, dept: 'production', creator: 'head', priority: 1, meta: { action: 'project', client, what, source: 'sales' } });
      d.hq.wake('production-head', 'task');
    });
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

  private async crash(task: Task, e: unknown): Promise<void> {
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
      return;
    }
    this.hq.setMeta(task.id, { action });
    await this.runWorkerTask(task.id, action === 'lead' ? LEADS_ID : action === 'kp' ? PRESALES_ID : PROSPECTOR_ID, action);
  }

  // ---- worker run, review (leads), approvals ----
  private ctx(task: Task, staged: Staged[], actor: string): WorkerCtx {
    return {
      llm: this.llmFor(actor, task.id), db: this.hq.db, tz: this.hq.tz, now: this.hq.now,
      requestApproval: (kind, payload, summary) => Promise.resolve(staged.push({ kind, payload, summary }) - 1),
      log: (action, detail) => this.hq.log(actor, action, 'task', String(task.id), detail),
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
      return void (await this.report(taskId, `Разведчик: ${res.result} Карточки придут в пачке на одобрение (10:00 или /approve).`));
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
      if (created) await this.report(taskId, `Рекомендация ${describeReferral(referral)}, награда после оплаты: ${referral.reward}. Оплатит: /paid ${referral.id}.`);
    }
    if (lead.temperature === 'hot') await this.hq.alert(`Горячий лид #${lead.id} (${lead.niche || 'ниша не ясна'}). Карточка с контактом в пачке на одобрение, /approve.`);
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
