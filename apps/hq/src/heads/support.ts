import { errMsg, log, schedule, zonedParts, type LlmClient, type Messenger, roleTitle } from '@fir/core';
import { meterLlm, type Agent, type Hq, type Task, type WorkerCtx } from '@fir/hq';
import { BillingWorker, parseInvoiceArgs, parseSubArgs, usdt, type Invoice, type PaymentWatcher } from '@fir/worker-billing';
import { leadStoreFor } from '@fir/worker-lead-intake';
import { PmStore } from '@fir/worker-project-manager';
import { CustomerSupportWorker, csStoreFor, parseClientArgs, parseTicketArgs, type TicketDelivery } from '@fir/worker-customer-support';
import { FinanceWorker } from '@fir/worker-finance';
import { MonitoringWorker, WORKER_ID as MONITORING_WORKER_ID, type MonEvent } from '@fir/worker-monitoring';
import { OnboardingWorker, obStoreFor, parseOnboardArgs } from '@fir/worker-onboarding';
import type { Cron } from 'croner';
import type { CabDocs } from '../cab-docs.js';
import { deliverOrHandOff, type ClientChannel } from '../client/channel.js';
import type { Reporter } from '../reporter.js';
import { toolsFor, type AppTools } from '../tools.js';

export const SUPPORT = 'support';
export const SUPPORT_HEAD_ID = 'support-head';
export const MONITOR_CRON = '*/5 * * * *';
/** Hourly SLA check of client tickets (the head's own cron, like monitoring: no task per run). */
export const SLA_CRON = '0 * * * *';
/**
 * On-chain payment check (`billing-payment-watch`): every 2 minutes, day and night (payments come any time). Like monitoring it is the
 * head's own cron, not a routine: a routine would create 720 tasks a day. A found payment gets its own «Оплата» task.
 */
export const PAYMENT_WATCH_CRON = '*/2 * * * *';
export const PAYMENT_WATCH_NAME = 'billing-payment-watch';
/** Owner commands the Director passes through to the Support head (`support_command`). */
export const SUPPORT_COMMANDS = ['ticket', 'tickets', 'client', 'clients', 'invoice', 'invoices', 'sub', 'paid', 'onboard'] as const;

export interface SupportSeedConfig {
  supportBudgetUsd: number;
}

/**
 * Support department: monitoring and finance workers and two routines. Called once at start, like `seedOrg`; instructions
 * come from `support-head.md` only when the agent does not exist yet, routines only when missing.
 * There is no routine for the 5-minute check: it would create 288 tasks a day. The head runs it from its own cron
 * (`SupportHead.start`) and keeps one "Дежурство" task per day instead.
 */
export function seedSupport(hq: Hq, cfg: SupportSeedConfig, readInstructions: (file: string) => string): void {
  hq.ensureAgent({
    id: SUPPORT_HEAD_ID, dept: SUPPORT, role: 'head', title: roleTitle('support-head'), instructions: readInstructions('support-head.md'),
    bossId: 'director', bot: 'SUPPORT_BOT_TOKEN', budgetUsdMonth: cfg.supportBudgetUsd,
  });
  hq.ensureAgent({ id: 'monitoring', dept: SUPPORT, role: 'worker', title: roleTitle('monitoring'), bossId: SUPPORT_HEAD_ID });
  hq.ensureAgent({ id: 'finance', dept: SUPPORT, role: 'worker', title: roleTitle('finance'), bossId: SUPPORT_HEAD_ID });
  hq.ensureAgent({ id: 'customer-support', dept: SUPPORT, role: 'worker', title: roleTitle('customer-support'), bossId: SUPPORT_HEAD_ID });
  hq.ensureAgent({ id: 'billing', dept: SUPPORT, role: 'worker', title: roleTitle('billing'), bossId: SUPPORT_HEAD_ID });
  hq.ensureAgent({ id: 'onboarding', dept: SUPPORT, role: 'worker', title: roleTitle('onboarding'), bossId: SUPPORT_HEAD_ID });
  const routines = [
    // all three land in the owner's morning (summary 08:00, batch 09:00 on his clock), so they run on his clock
    { name: 'support-daily', cron: '40 7 * * *', tz: 'owner' as const, dept: SUPPORT, title: 'Финансы и аптайм за сутки', meta: { action: 'daily' } },
    { name: 'support-weekly', cron: '0 20 * * 0', tz: 'owner' as const, dept: SUPPORT, title: 'Отчёт по расходам за месяц', meta: { action: 'weekly' } },
    { name: 'support-billing', cron: '30 7 * * *', tz: 'owner' as const, dept: SUPPORT, title: 'Счета, напоминания об оплате, онбординг', meta: { action: 'billing' } },
  ];
  hq.syncRoutines('support', routines);
}

export interface SupportDeps {
  hq: Hq;
  /** Adapters and keys of the agents' toolbox (`docs/tools.md`, `src/tools.ts`); absent (tests): a toolbox without keys. */
  tools?: AppTools | undefined;
  llm: LlmClient;
  reporter: Reporter;
  monitor: MonitoringWorker;
  finance: FinanceWorker;
  /** Client support, billing and onboarding; defaults are built without options when omitted. */
  cs?: CustomerSupportWorker;
  billing?: BillingWorker;
  onboarding?: OnboardingWorker;
  /** Where approved client texts go: to the owner, who sends them himself. Without it they are only logged. */
  messenger?: Messenger;
  ownerId?: number;
  /** The public client bot: approved answers to tickets that came from it go back into the client's chat. */
  client?: ClientChannel;
  /** The on-chain USDT watcher; without it (or without USDT addresses) only `/paid` marks payments. */
  payWatch?: PaymentWatcher;
}

type Action = 'monitor_add' | 'daily' | 'weekly' | 'status' | 'none' | 'ticket' | 'billing' | 'invoice' | 'kp_invoice' | 'paid' | 'onboard' | 'sub' | 'client';
/** `kp_invoice` is made by the chain: the invoice of ONE stage of an approved КП (stage 1 by Sales, the next ones by Production when the client accepts a stage), linked to the lead, the pack, the project and the stage. */
const OWNER_ACTIONS: Action[] = ['ticket', 'billing', 'invoice', 'kp_invoice', 'paid', 'onboard', 'sub', 'client'];

const MONITOR_URL_RE = /https?:\/\/[^\s<>"')]+/i;

/** Owner's free text, without an LLM: only obvious wordings. */
export function guessAction(task: Task): Action {
  const m = task.meta.action;
  if (m === 'daily' || m === 'weekly' || m === 'status') return m;
  if (typeof m === 'string' && (OWNER_ACTIONS as string[]).includes(m)) return m as Action;
  if (m === 'monitor_add' || (/мониторинг/i.test(`${task.title} ${task.body}`) && MONITOR_URL_RE.test(`${task.title} ${task.body}`))) return 'monitor_add';
  const text = `${task.title} ${task.body}`.toLowerCase();
  if (/тикет|вопрос клиента|клиент спрашивает|клиент написал/.test(text)) return 'ticket';
  if (/онбординг|выставить счёт|выставь счёт/.test(text)) return 'none'; // needs exact args: /onboard, /invoice
  if (/расход|финанс|деньг|бюджет|токен|траты|месяц/.test(text)) return 'weekly';
  if (/аптайм|мониторинг|статус|упал|доступн|сертификат|диск/.test(text)) return 'status';
  if (/сводк|за сутки|вчера/.test(text)) return 'daily';
  return 'none';
}

/**
 * Head of the Support department. Monitoring runs on its own 5-minute cron and writes only into the day's one
 * "Дежурство" task (events) and the activity log; incidents and recoveries go out as Director alerts (quiet hours
 * respected there) and into the department topic. Routine tasks (07:50 daily line, Sunday 20:00 month report) are
 * handled on the heartbeat like any department's tasks. Reports reach the morning summary through task events.
 */
export class SupportHead {
  private jobs: Cron[] = [];
  private checking = false;
  private watching = false;
  /**
   * Set by the app: an invoice was marked paid (`/paid`, later the on-chain check). Production starts the reserved project and Sales asks the
   * referral payout; the returned lines are added to the owner's answer. Only a FIRST payment of a new project starts anything.
   */
  onPaid: ((invoice: Invoice) => Promise<string[]>) | null = null;
  /** Cabinet v3: set by the app. An approved invoice of a cabinet lead goes to the client's cabinet and email with the pay button (no «send it yourself»). */
  cabinet: CabDocs | null = null;
  private readonly cs: CustomerSupportWorker;
  private readonly billing: BillingWorker;
  private readonly onboarding: OnboardingWorker;

  constructor(private readonly d: SupportDeps) {
    this.cs = d.cs ?? new CustomerSupportWorker();
    this.billing = d.billing ?? new BillingWorker();
    this.onboarding = d.onboarding ?? new OnboardingWorker();
    const base = { db: d.hq.db, now: d.hq.now };
    const toOwner = (text: string) => (d.messenger && d.ownerId !== undefined ? d.messenger.send(d.ownerId, text) : Promise.resolve());
    const ticketDelivery = (x: TicketDelivery) => deliverOrHandOff({
      client: d.client, messenger: d.messenger, ownerId: d.ownerId, chatId: x.chatId, text: x.text, ref: `Тикет #${x.ticketId}`, contact: x.contact || x.name,
      ownerText: `Тикет #${x.ticketId}: ответ утверждён, отправьте клиенту ${x.contact || x.name}${x.contact ? ` (${x.name})` : ''}:\n\n${x.text}`,
    });
    for (const [k, spec] of Object.entries(this.cs.kindSpecs(base, ticketDelivery))) d.hq.registerKind(k, spec);
    const billingDelivery = async (x: { kind: string; invoiceId: number; name: string; text: string }): Promise<void> => {
      if (x.kind === 'billing_invoice' && this.cabinet) {
        const sent = await this.cabinet.onInvoiceApproved(x.invoiceId, x.text).catch((e) => { log('warn', 'cabinet invoice delivery failed', { invoice: x.invoiceId, err: errMsg(e) }); return false; });
        if (sent) return void (await toOwner(`Счёт утверждён и отправлен клиенту ${x.name} в кабинет и на почту (кнопка оплаты там). Отправлять самому не нужно.`));
      }
      const leadId = x.kind === 'billing_invoice' ? (d.hq.db.prepare('SELECT lead_id FROM bl_invoices WHERE id = ?').get(x.invoiceId) as { lead_id: number | null } | undefined)?.lead_id ?? null : null;
      const invite = this.cabinet?.inviteLine(leadId) ?? '';
      await toOwner(`${x.kind === 'billing_invoice' ? 'Счёт утверждён' : 'Напоминание утверждено'}, отправьте клиенту ${x.name}:\n\n${x.text}${invite ? `\n\n${invite}` : ''}`);
    };
    for (const [k, spec] of Object.entries(this.billing.kindSpecs(base, billingDelivery))) d.hq.registerKind(k, spec);
    for (const [k, spec] of Object.entries(this.onboarding.kindSpecs((x) => toOwner(`Инструкция для ${x.name} утверждена, отправьте клиенту:\n\n${x.text}`)))) d.hq.registerKind(k, spec);
  }

  private get hq(): Hq {
    return this.d.hq;
  }

  private agent(): Agent | undefined {
    return this.hq.agent(SUPPORT_HEAD_ID);
  }

  start(): void {
    this.stop();
    this.jobs = [
      schedule('support-monitor', MONITOR_CRON, this.hq.tz, async () => void (await this.monitorTick())),
      schedule('support-sla', SLA_CRON, this.hq.tz, async () => void (await this.slaTick())),
      ...(this.d.payWatch?.enabled ? [schedule(PAYMENT_WATCH_NAME, PAYMENT_WATCH_CRON, this.hq.tz, async () => void (await this.paymentTick()))] : []),
    ];
  }

  stop(): void {
    for (const j of this.jobs) j.stop();
    this.jobs = [];
  }

  private today(): string {
    const p = zonedParts(this.hq.now(), this.hq.tz);
    return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  }

  private ctx(task: Task): WorkerCtx {
    const llm = meterLlm(this.d.llm, this.hq, { agentId: SUPPORT_HEAD_ID, taskId: task.id });
    return {
      llm, db: this.hq.db, tz: this.hq.tz, now: this.hq.now,
      requestApproval: (kind, payload, summary) => this.hq.requestApproval(task.id, SUPPORT_HEAD_ID, kind, payload, summary),
      log: (action, detail) => this.hq.log(SUPPORT_HEAD_ID, action, 'task', String(task.id), detail),
      tools: toolsFor(this.hq, this.d.tools, { agentId: SUPPORT_HEAD_ID, dept: SUPPORT, taskId: task.id, llm, messenger: this.d.messenger, ownerId: this.d.ownerId }),
    };
  }

  /** Report: the task journal (the morning summary reads it) plus the department topic when configured. */
  private async report(taskId: number, text: string): Promise<void> {
    this.hq.addEvent(taskId, 'report', SUPPORT_HEAD_ID, text);
    await this.d.reporter.post(SUPPORT, text);
  }

  // ---- monitoring: every 5 minutes, no task per run ----
  /** Closes duty tasks of earlier days with their uptime line (every tick, so none lingers open). */
  private closeOldDuty(): void {
    const today = this.today();
    for (const t of this.hq.tasks({ dept: SUPPORT, status: 'running', assigneeId: SUPPORT_HEAD_ID })) {
      if (typeof t.meta.duty === 'string' && t.meta.duty !== today) this.hq.complete(t.id, SUPPORT_HEAD_ID, this.d.monitor.dailyLine(this.hq.db));
    }
  }

  /** Today's duty task, created on the first event of the day. */
  private duty(): Task {
    const today = this.today();
    const cur = this.hq.tasks({ dept: SUPPORT, status: 'running', assigneeId: SUPPORT_HEAD_ID }).find((t) => t.meta.duty === today);
    if (cur) return cur;
    const [, m, d] = today.split('-');
    const t = this.hq.createTask({ title: `Дежурство ${d}.${m}`, dept: SUPPORT, assigneeId: SUPPORT_HEAD_ID, creator: 'routine', meta: { duty: today } });
    this.hq.claim(t.id, SUPPORT_HEAD_ID);
    return this.hq.task(t.id)!;
  }

  async monitorTick(): Promise<MonEvent[]> {
    if (this.checking || this.agent()?.status !== 'active') return [];
    this.checking = true;
    try {
      // the probes go through the Support toolbox (`web.getText`, internal hosts by the policy flag); no task, so no taskId on its journal lines
      const web = this.d.tools ? toolsFor(this.hq, this.d.tools, { agentId: MONITORING_WORKER_ID, dept: SUPPORT }).web : undefined;
      const { events } = await this.d.monitor.tick(this.hq.db, web);
      this.closeOldDuty();
      if (events.length === 0) return events;
      const duty = this.duty();
      for (const e of events) {
        this.hq.addEvent(duty.id, 'incident', SUPPORT_HEAD_ID, e.text);
        this.hq.log(SUPPORT_HEAD_ID, e.kind === 'down' ? 'incident' : 'incident_recovered', 'check', e.checkId);
        await this.d.reporter.post(SUPPORT, e.text);
        // a service down or back (site, models, the client bot, disk, containers): a reminder for the owner's Telegram
        await this.hq.alert(e.text, { kind: 'service' });
      }
      return events;
    } finally {
      this.checking = false;
    }
  }

  // ---- on-chain payments: every 2 minutes, no task per run ----
  /**
   * One watcher cycle: alerts (unmatched transfers, a provider down for 30 minutes) go to the owner; every matched payment runs the same
   * steps as `/paid` in its own task and the owner gets the «оплачено» text with the tx id. Returns the texts sent (tests).
   */
  async paymentTick(): Promise<string[]> {
    const w = this.d.payWatch;
    if (!w?.enabled || this.watching) return [];
    this.watching = true;
    const sent: string[] = [];
    try {
      const store = this.billing.store({ db: this.hq.db, now: this.hq.now });
      const r = await w.cycle(store, this.hq.now());
      for (const a of r.alerts) {
        this.hq.log(SUPPORT_HEAD_ID, 'payment_watch_alert');
        await this.d.reporter.post(SUPPORT, a);
        await this.hq.alert(a);
      }
      for (const m of r.matched) {
        const inv = m.invoice;
        this.hq.log(SUPPORT_HEAD_ID, 'payment_found', 'invoice', inv.number, m.transfer.method);
        const t = this.hq.createTask({ title: `Оплата: ${inv.number} (${m.transfer.method === 'usdt_trc20' ? 'USDT TRC20' : 'USDT TON'})`, dept: SUPPORT, assigneeId: SUPPORT_HEAD_ID, creator: 'routine', priority: 1, meta: { action: 'chain_paid', invoice: inv.number, txId: m.transfer.txId } });
        let text: string;
        if (this.hq.claim(t.id, SUPPORT_HEAD_ID)) {
          try {
            const after = this.billing.afterPaid(store, inv.id);
            text = await this.paidSteps(this.ctx(this.hq.task(t.id)!), after.invoice, after.nextDue);
            await this.finish(t.id, text, false);
          } catch (e) {
            await this.crash(t, e);
            text = `Счёт ${inv.number} оплачен (USDT, tx ${m.transfer.txId}), но следующие шаги не запустились: задача #${t.id} заблокирована, подробности в журнале.`;
          }
        } else text = `Счёт ${inv.number} оплачен (USDT, tx ${m.transfer.txId}).`;
        await this.d.reporter.post(SUPPORT, text);
        if (this.d.messenger && this.d.ownerId !== undefined) await this.d.messenger.send(this.d.ownerId, text);
        sent.push(text);
      }
      return sent;
    } catch (e) {
      log('error', 'payment watch failed', { err: errMsg(e) });
      return sent;
    } finally {
      this.watching = false;
    }
  }

  /**
   * What follows a payment, for `/paid` and the watcher alike: the «оплачено» line (with the tx for an on-chain payment), Production starts
   * the reserved project, Sales asks the referral payout, a new project starts onboarding. A failing hook never undoes the payment.
   */
  private async paidSteps(ctx: WorkerCtx, inv: Invoice, nextDue?: string): Promise<string> {
    const chain = inv.paidVia === 'usdt_trc20' || inv.paidVia === 'usdt_ton';
    let text = chain
      ? `Оплачено: счёт ${inv.number} (${inv.client}, $${inv.amountUsd}), пришло ${usdt(inv.payAmountUsd)} USDT в сети ${inv.paidVia === 'usdt_trc20' ? 'TRC20' : 'TON'}, tx ${inv.txId}. Выручка попадёт в отчёты Finance.`
      : `Счёт ${inv.number} (${inv.client}, $${inv.amountUsd}) оплачен. Выручка попадёт в отчёты Finance.`;
    if (nextDue) text += ` Следующая оплата по подписке: ${nextDue}.`;
    if (this.onPaid) {
      try {
        const started = await this.onPaid(inv);
        if (started.length) text += `\n${started.join('\n')}`;
      } catch (e) {
        log('error', 'paid hook failed', { invoice: inv.number, err: errMsg(e) });
        text += '\nОплата отмечена, но следующие шаги (проект, выплата) не запустились: подробности в журнале, повторите /project вручную.';
      }
    }
    if (inv.newProject) text += `\n\n${await this.startOnboarding(ctx, inv.client, inv.what, inv.number)}`;
    return text;
  }

  // ---- client tickets: hourly SLA check ----
  /** Tickets without an approved answer for SUPPORT_SLA_HOURS become one alert each (never repeated). */
  async slaTick(): Promise<string[]> {
    if (this.agent()?.status !== 'active') return [];
    const alerts = this.cs.slaAlerts({ db: this.hq.db, now: this.hq.now });
    for (const a of alerts) {
      this.hq.log(SUPPORT_HEAD_ID, 'ticket_sla_alert');
      await this.d.reporter.post(SUPPORT, a);
      await this.hq.alert(a);
    }
    return alerts;
  }

  // ---- owner commands passed through by the Director (`support_command`) ----
  /** Returns the text for the owner. Reads answer at once; writes run as a Support task so approvals have a task. */
  async onCommand(name: string, args: string): Promise<string> {
    const a = args.trim();
    const ctx = { db: this.hq.db, now: this.hq.now, tz: this.hq.tz };
    switch (name) {
      case 'tickets':
        return this.cs.ticketsText(ctx);
      case 'clients':
        return this.cs.clientsText(ctx);
      case 'invoices':
        return this.billing.invoicesText(ctx);
      case 'ticket':
        if (!parseTicketArgs(a)) return 'Формат: /ticket <клиент>: <вопрос клиента>';
        return this.runCommand('ticket', `Тикет: ${a.slice(0, 60)}`, a);
      case 'client':
        if (!parseClientArgs(a)) return 'Формат: /client Имя | контакт | продукт | тариф | с какой даты (после имени всё необязательно)';
        return this.runCommand('client', `Клиент: ${a.slice(0, 60)}`, a);
      case 'invoice':
        if (!parseInvoiceArgs(a)) return 'Формат: /invoice <клиент> <сумма USD> <за что> [due=ГГГГ-ММ-ДД] [method=usdt_trc20|usdt_ton|wallet] [new]. «new» значит новый проект: после оплаты начнётся онбординг.';
        return this.runCommand('invoice', `Счёт: ${a.slice(0, 60)}`, a);
      case 'sub':
        if (!parseSubArgs(a)) return 'Формат: /sub <клиент> <сумма USD> <month|year> <usdt_trc20|usdt_ton|wallet> <ГГГГ-ММ-ДД следующей оплаты> [тариф]';
        return this.runCommand('sub', `Подписка: ${a.slice(0, 60)}`, a);
      case 'paid':
        if (!a) return 'Формат: /paid <номер счёта>, например /paid FT-2026-001 или /paid 1';
        return this.runCommand('paid', `Оплата: ${a.slice(0, 40)}`, a);
      case 'onboard':
        if (!parseOnboardArgs(a)) return 'Формат: /onboard <клиент> [: продукт], например /onboard Dilnoza: бот записи';
        return this.runCommand('onboard', `Онбординг: ${a.slice(0, 60)}`, a);
      default:
        return 'Неизвестная команда сопровождения.';
    }
  }

  /**
   * A known client wrote to the public bot: a ticket task with the chat id, so the approved answer goes back to the chat.
   * Returns the task id. The owner is not asked anything here; the answer follows the usual levels and the SLA alert.
   */
  async clientTicket(client: string, text: string, chatId?: number): Promise<number> {
    const name = client.replace(/:/g, ' ').trim().slice(0, 80) || 'клиент';
    const t = this.hq.createTask({ title: `Тикет из бота: ${name.slice(0, 60)}`, dept: SUPPORT, assigneeId: SUPPORT_HEAD_ID, creator: 'routine', meta: { action: 'ticket', args: `${name}: ${text}`, ...(chatId !== undefined ? { chatId } : {}) } });
    if (!this.hq.claim(t.id, SUPPORT_HEAD_ID)) return t.id;
    try {
      await this.finish(t.id, await this.ownerAction(this.hq.task(t.id)!, 'ticket'), false);
    } catch (e) {
      await this.crash(t, e);
    }
    return t.id;
  }

  private async runCommand(action: Action, title: string, args: string): Promise<string> {
    const t = this.hq.createTask({ title, dept: SUPPORT, assigneeId: SUPPORT_HEAD_ID, creator: 'owner', meta: { action, args } });
    if (!this.hq.claim(t.id, SUPPORT_HEAD_ID)) return 'Не удалось взять задачу, попробуйте ещё раз.';
    try {
      const text = await this.ownerAction(this.hq.task(t.id)!, action);
      return this.finish(t.id, text, false);
    } catch (e) {
      await this.crash(t, e);
      return `Сбой: ${errMsg(e)}`.slice(0, 300);
    }
  }

  /** Completes the task unless approvals already moved it on; routine runs also report to the department. */
  private async finish(taskId: number, text: string, report: boolean): Promise<string> {
    if (this.hq.task(taskId)?.status === 'running') this.hq.complete(taskId, SUPPORT_HEAD_ID, text);
    if (report) await this.report(taskId, text);
    return text;
  }

  private async raise(alerts: string[]): Promise<void> {
    for (const a of alerts) {
      await this.d.reporter.post(SUPPORT, a);
      await this.hq.alert(a);
    }
  }

  /** The checklist for the owner: an HQ task waiting for him (blocked: it shows in the morning summary). */
  private openChecklistTask(onboardingId: number, client: string, checklist: string): void {
    const store = obStoreFor({ db: this.hq.db, now: this.hq.now });
    const t = this.hq.createTask({ title: `Онбординг: ${client}`, body: checklist, dept: SUPPORT, assigneeId: SUPPORT_HEAD_ID, creator: 'routine', meta: { onboarding: onboardingId } });
    this.hq.block(t.id, SUPPORT_HEAD_ID, 'Ждёт владельца: чеклист онбординга (доступы, инструкция, первая неделя)');
    store.setTask(onboardingId, t.id);
  }

  private async startOnboarding(ctx: WorkerCtx, client: string, product: string, invoiceNumber?: string): Promise<string> {
    const known = csStoreFor(ctx).upsertClient({ name: client, product, since: this.today() });
    const r = await this.onboarding.start(ctx, { client: known.name, product, ...(invoiceNumber ? { invoiceNumber } : {}) });
    if (r.existing) return `Онбординг ${known.name} уже идёт.\n\n${r.checklist}`;
    this.openChecklistTask(r.onboarding.id, known.name, r.checklist);
    return `${r.checklist}\n\nЧеклист лежит задачей для вас, черновик инструкции ждёт одобрения.`;
  }

  /**
   * A ticket written in the client cabinet on the site (the row already exists in cs_tickets, source `cabinet`): a support task so
   * the usual draft and approval follow. A Telegram chat is looked up by the client's handle, otherwise the stored answer is the channel.
   */
  async cabinetTicket(ticketId: number, client: string, text: string, telegram = '', leadId?: number): Promise<number> {
    const name = client.replace(/:/g, ' ').trim().slice(0, 80) || 'клиент';
    const handle = telegram.trim().replace(/^@/, '').toLowerCase();
    let chatId: number | undefined;
    if (handle) {
      try {
        chatId = (this.hq.db.prepare('SELECT chat_id FROM cb_chats WHERE lower(username) = ? AND blocked = 0').get(handle) as { chat_id: number } | undefined)?.chat_id;
      } catch { /* no bot table: the stored answer is the only channel */ }
    }
    const t = this.hq.createTask({ title: `Тикет из кабинета: ${name.slice(0, 60)}`, dept: SUPPORT, assigneeId: SUPPORT_HEAD_ID, creator: 'routine', meta: { action: 'ticket', args: `${name}: ${leadId !== undefined ? `[по заявке #${leadId}] ` : ''}${text}`, ticketId, ...(leadId !== undefined ? { leadId } : {}), ...(chatId !== undefined ? { chatId } : {}) } });
    if (!this.hq.claim(t.id, SUPPORT_HEAD_ID)) return t.id;
    try {
      await this.finish(t.id, await this.ownerAction(this.hq.task(t.id)!, 'ticket'), false);
    } catch (e) {
      await this.crash(t, e);
    }
    return t.id;
  }

  /** Owner commands and the billing routine. Returns the text for the owner (or the routine's report). */
  private async ownerAction(task: Task, action: Action): Promise<string> {
    const ctx = this.ctx(task);
    const args = typeof task.meta.args === 'string' ? task.meta.args : `${task.title}\n${task.body}`.trim();
    switch (action) {
      case 'ticket': {
        const p = (typeof task.meta.args === 'string' ? parseTicketArgs(task.meta.args) : null) ?? parseTicketArgs(task.body) ?? parseTicketArgs(task.title.replace(/^тикет\s*/i, ''));
        if (!p) {
          this.hq.block(task.id, SUPPORT_HEAD_ID, 'Нужен формат «клиент: вопрос»');
          return 'Для тикета нужен формат «клиент: вопрос клиента» (или /ticket).';
        }
        const chatId = typeof task.meta.chatId === 'number' ? task.meta.chatId : undefined;
        const ticketId = typeof task.meta.ticketId === 'number' ? task.meta.ticketId : undefined;
        const r = await this.cs.handleTicket(ctx, { ...p, ...(chatId !== undefined ? { chatId } : {}), ...(ticketId !== undefined ? { ticketId } : {}) });
        if (ticketId !== undefined) return `${r.line}\n\nОбращение из кабинета на сайте: одобренный ответ появится у клиента в кабинете${chatId !== undefined ? ' и уйдёт ему в Telegram' : ''}.`;
        if (chatId !== undefined) return `${r.line}\n\nКлиент написал в клиентский бот: одобренный ответ бот отправит ему сам.`;
        return `${r.line}\n\nЧерновик:\n${r.text}\n\nОдобрите его (/approve или в пачке): после этого я пришлю текст для отправки клиенту.`;
      }
      case 'client': {
        const c = parseClientArgs(args)!;
        const saved = csStoreFor(ctx).upsertClient({ ...c, since: c.since || this.today() });
        return `Клиент сохранён: ${saved.name}, ${saved.product || 'продукт не указан'}, тариф ${saved.plan || '-'}, контакт ${saved.contact || '-'}.`;
      }
      case 'invoice': {
        const i = parseInvoiceArgs(args)!;
        const inv = await this.billing.createInvoice(ctx, { client: i.client, amountUsd: i.amountUsd, what: i.what, dueDate: i.dueDate, method: i.method, newProject: i.newProject });
        return `Счёт ${inv.number} для ${inv.client}, $${inv.amountUsd}, до ${inv.dueDate}: текст на утверждении (уровень 0, деньги). Одобрите в /approve, я пришлю текст для отправки клиенту.`;
      }
      case 'kp_invoice': {
        const m = task.meta;
        const amountUsd = Number(m.amountUsd);
        if (!(amountUsd > 0) || typeof m.client !== 'string' || !m.client) {
          this.hq.block(task.id, SUPPORT_HEAD_ID, 'В задаче нет клиента или суммы этапа');
          return 'Счёт по КП не создан: нет клиента или суммы.';
        }
        const stageNo = Number(m.stageNo) || null;
        const projectId = Number(m.projectId) || null;
        const base = { db: this.hq.db, now: this.hq.now };
        const bstore = this.billing.store(base);
        // one live invoice per stage: a repeated task (or a second proposal) never makes a second invoice
        const dup = projectId !== null && stageNo !== null ? bstore.forStage(projectId, stageNo) : undefined;
        if (dup) return `Счёт этапа ${stageNo} уже есть: ${dup.number} (${dup.status}).`;
        const link = {
          leadId: Number(m.leadId) || null, packId: Number(m.packId) || null, projectId, totalUsd: Number(m.totalUsd) || null,
          ...(stageNo !== null ? { stageNo, stageCount: Number(m.stageCount) || null } : {}),
          ...(typeof m.chain === 'string' ? { chain: m.chain } : {}),
        };
        // what the client already has: from the chain, else from the lead (the invoices of later stages are made without the pack in hand)
        const lead = link.leadId !== null ? leadStoreFor(base).get(link.leadId) : undefined;
        const infra = {
          hasDomain: typeof m.hasDomain === 'boolean' ? m.hasDomain : lead?.hasDomain ?? null,
          hasHosting: typeof m.hasHosting === 'boolean' ? m.hasHosting : lead?.hasHosting ?? null,
        };
        const inv = await this.billing.createInvoice(ctx, { client: m.client, amountUsd, what: typeof m.what === 'string' ? m.what : 'Оплата этапа по КП', newProject: stageNo === null || stageNo === 1, link, infra, ...(typeof m.legalLabel === 'string' && m.legalLabel ? { legal: m.legalLabel } : {}) });
        if (projectId !== null && stageNo !== null) {
          const ms = new PmStore(this.hq.db, this.hq.now).stageMilestone(projectId, stageNo);
          if (ms) new PmStore(this.hq.db, this.hq.now).setStageInvoice(ms.id, inv.number);
        }
        return `Счёт ${inv.number} для ${inv.client}, $${inv.amountUsd}, ${stageNo !== null ? `этап ${stageNo} ` : ''}по утверждённому КП: текст на утверждении (деньги, одна карточка).`;
      }
      case 'sub': {
        const s = parseSubArgs(args)!;
        const sub = this.billing.store(ctx).addSubscription({ client: s.client, plan: s.plan, amountUsd: s.amountUsd, period: s.period, nextDue: s.nextDue, method: s.method });
        return `Подписка сохранена: ${sub.client}, $${sub.amountUsd} за ${sub.period === 'year' ? 'год' : 'месяц'}, следующая оплата ${sub.nextDue}. Счёт появится за 7 дней до срока.`;
      }
      case 'paid': {
        const r = this.billing.markPaid(ctx, args);
        if (!r) return `Не нашёл счёт «${args}». Список: /invoices.`;
        const { invoice: inv } = r;
        if (r.already) return `Счёт ${inv.number} уже отмечен оплаченным${inv.paidVia && inv.paidVia !== 'manual' ? ` (USDT, tx ${inv.txId})` : ''}.`;
        // the first payment of a КП: Production starts the reserved project, Sales asks the referral payout (a failure here never undoes the payment)
        return this.paidSteps(ctx, inv, r.nextDue);
      }
      case 'onboard': {
        const o = parseOnboardArgs(args)!;
        return this.startOnboarding(ctx, o.client, o.product);
      }
      case 'billing': {
        const b = await this.billing.daily(ctx);
        const c = this.onboarding.checkins(ctx);
        for (const f of c.finished) this.closeChecklistTask(f.taskId);
        await this.raise([...b.alerts, ...c.lines]);
        const lines = [...b.lines, ...c.lines, ...b.alerts];
        return lines.length ? lines.join('\n') : 'Счетов, напоминаний и проверок онбординга на сегодня нет.';
      }
      default:
        return 'Неизвестное действие.';
    }
  }

  private closeChecklistTask(taskId: number | null): void {
    const t = taskId ? this.hq.task(taskId) : undefined;
    if (!t || t.status !== 'blocked') return;
    this.hq.setStatus(t.id, 'running', SUPPORT_HEAD_ID, 'неделя онбординга прошла');
    this.hq.complete(t.id, SUPPORT_HEAD_ID, 'Первая неделя прошла, все проверки отправлены.');
  }

  // ---- heartbeat: routine and owner tasks ----
  async onHeartbeat(): Promise<void> {
    if (this.agent()?.status !== 'active') return;
    for (const t of [...this.hq.tasks({ dept: SUPPORT, status: 'inbox' }), ...this.hq.tasks({ dept: SUPPORT, status: 'assigned', assigneeId: SUPPORT_HEAD_ID })]) {
      await this.handle(t).catch((e) => this.crash(t, e));
    }
  }

  private async crash(task: Task, e: unknown): Promise<void> {
    log('error', 'support task crashed', { task: task.id, err: errMsg(e) });
    const cur = this.hq.task(task.id);
    if (cur && cur.status !== 'blocked' && cur.status !== 'done' && cur.status !== 'rejected') this.hq.block(task.id, SUPPORT_HEAD_ID, `Сбой: ${errMsg(e)}`.slice(0, 300));
    await this.hq.alert(`Сопровождение: задача #${task.id} заблокирована (сбой), подробности в журнале задачи.`);
  }

  private async handle(task: Task): Promise<void> {
    if (!this.hq.claim(task.id, SUPPORT_HEAD_ID)) return;
    const action = guessAction(task);
    if (action === 'none') {
      this.hq.block(task.id, SUPPORT_HEAD_ID, 'Сопровождение умеет: расходы, аптайм и мониторинг, сводка за сутки, тикеты клиентов, счета и онбординг (команды /ticket, /invoice, /paid, /onboard)');
      await this.report(task.id, `Задача #${task.id} «${task.title}» не для сопровождения: умею расходы, аптайм, сводку за сутки.`);
      return;
    }
    if ((OWNER_ACTIONS as string[]).includes(action)) {
      const out = await this.ownerAction(task, action);
      const quiet = action === 'billing' && out.startsWith('Счетов, напоминаний');
      await this.finish(task.id, out, task.creator === 'routine' && !quiet);
      return;
    }
    if (action === 'monitor_add') {
      const url = MONITOR_URL_RE.exec(`${task.title} ${task.body}`)?.[0]?.replace(/[.,;]+$/, '');
      const text = !url ? 'В задаче нет адреса (https://...) для мониторинга.'
        : this.d.monitor.addUrl(this.hq.db, url) ? `Адрес ${url} добавлен в мониторинг, проверка со следующего цикла (5 мин).` : `Адрес ${url} уже в мониторинге.`;
      this.hq.complete(task.id, SUPPORT_HEAD_ID, text);
      await this.report(task.id, text);
      return;
    }
    const ctx = this.ctx(task);
    let text: string;
    if (action === 'daily') {
      const fin = await this.d.finance.run({ ...task, meta: { ...task.meta, action: 'daily' } }, ctx);
      text = `${this.d.monitor.dailyLine(this.hq.db)}\n${fin.result}`;
    } else if (action === 'weekly') {
      text = (await this.d.finance.run({ ...task, meta: { ...task.meta, action: 'weekly' } }, ctx)).result;
    } else {
      text = this.d.monitor.dailyLine(this.hq.db);
    }
    this.hq.complete(task.id, SUPPORT_HEAD_ID, text);
    await this.report(task.id, text);
  }
}
