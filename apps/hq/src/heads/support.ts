import { errMsg, log, schedule, zonedParts, type LlmClient, type Messenger } from '@fir/core';
import { meterLlm, type Agent, type Hq, type Task, type WorkerCtx } from '@fir/hq';
import { BillingWorker, parseInvoiceArgs, parseSubArgs } from '@fir/worker-billing';
import { CustomerSupportWorker, csStoreFor, parseClientArgs, parseTicketArgs, type TicketDelivery } from '@fir/worker-customer-support';
import { FinanceWorker } from '@fir/worker-finance';
import { MonitoringWorker, type MonEvent } from '@fir/worker-monitoring';
import { OnboardingWorker, obStoreFor, parseOnboardArgs } from '@fir/worker-onboarding';
import type { Cron } from 'croner';
import { deliverOrHandOff, type ClientChannel } from '../client/channel.js';
import type { Reporter } from '../reporter.js';

export const SUPPORT = 'support';
export const SUPPORT_HEAD_ID = 'support-head';
export const MONITOR_CRON = '*/5 * * * *';
/** Hourly SLA check of client tickets (the head's own cron, like monitoring: no task per run). */
export const SLA_CRON = '0 * * * *';
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
    id: SUPPORT_HEAD_ID, dept: SUPPORT, role: 'head', title: 'Голова сопровождения', instructions: readInstructions('support-head.md'),
    bossId: 'director', bot: 'SUPPORT_BOT_TOKEN', budgetUsdMonth: cfg.supportBudgetUsd,
  });
  hq.ensureAgent({ id: 'monitoring', dept: SUPPORT, role: 'worker', title: 'Мониторинг', bossId: SUPPORT_HEAD_ID });
  hq.ensureAgent({ id: 'finance', dept: SUPPORT, role: 'worker', title: 'Финансист', bossId: SUPPORT_HEAD_ID });
  hq.ensureAgent({ id: 'customer-support', dept: SUPPORT, role: 'worker', title: 'Поддержка клиентов', bossId: SUPPORT_HEAD_ID });
  hq.ensureAgent({ id: 'billing', dept: SUPPORT, role: 'worker', title: 'Биллинг', bossId: SUPPORT_HEAD_ID });
  hq.ensureAgent({ id: 'onboarding', dept: SUPPORT, role: 'worker', title: 'Онбординг', bossId: SUPPORT_HEAD_ID });
  const routines = [
    { name: 'support-daily', cron: '50 7 * * *', dept: SUPPORT, title: 'Финансы и аптайм за сутки', meta: { action: 'daily' } },
    { name: 'support-weekly', cron: '0 20 * * 0', dept: SUPPORT, title: 'Отчёт по расходам за месяц', meta: { action: 'weekly' } },
    { name: 'support-billing', cron: '30 9 * * *', dept: SUPPORT, title: 'Счета, напоминания об оплате, онбординг', meta: { action: 'billing' } },
  ];
  for (const r of routines) if (!hq.routineByName(r.name)) hq.scheduleRoutine(r);
}

export interface SupportDeps {
  hq: Hq;
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
}

type Action = 'monitor_add' | 'daily' | 'weekly' | 'status' | 'none' | 'ticket' | 'billing' | 'invoice' | 'paid' | 'onboard' | 'sub' | 'client';
const OWNER_ACTIONS: Action[] = ['ticket', 'billing', 'invoice', 'paid', 'onboard', 'sub', 'client'];

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
    for (const [k, spec] of Object.entries(this.billing.kindSpecs(base, (x) => toOwner(`${x.kind === 'billing_invoice' ? 'Счёт утверждён' : 'Напоминание утверждено'}, отправьте клиенту ${x.name}:\n\n${x.text}`)))) d.hq.registerKind(k, spec);
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
    return {
      llm: meterLlm(this.d.llm, this.hq, { agentId: SUPPORT_HEAD_ID, taskId: task.id }), db: this.hq.db, tz: this.hq.tz, now: this.hq.now,
      requestApproval: (kind, payload, summary) => this.hq.requestApproval(task.id, SUPPORT_HEAD_ID, kind, payload, summary),
      log: (action, detail) => this.hq.log(SUPPORT_HEAD_ID, action, 'task', String(task.id), detail),
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
      const { events } = await this.d.monitor.tick(this.hq.db);
      this.closeOldDuty();
      if (events.length === 0) return events;
      const duty = this.duty();
      for (const e of events) {
        this.hq.addEvent(duty.id, 'incident', SUPPORT_HEAD_ID, e.text);
        this.hq.log(SUPPORT_HEAD_ID, e.kind === 'down' ? 'incident' : 'incident_recovered', 'check', e.checkId);
        await this.d.reporter.post(SUPPORT, e.text);
        await this.hq.alert(e.text);
      }
      return events;
    } finally {
      this.checking = false;
    }
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
        if (!parseInvoiceArgs(a)) return 'Формат: /invoice <клиент> <сумма USD> <за что> [due=ГГГГ-ММ-ДД] [method=payme] [new]. «new» значит новый проект: после оплаты начнётся онбординг.';
        return this.runCommand('invoice', `Счёт: ${a.slice(0, 60)}`, a);
      case 'sub':
        if (!parseSubArgs(a)) return 'Формат: /sub <клиент> <сумма USD> <month|year> <kaspi|payme|click|card|usdt> <ГГГГ-ММ-ДД следующей оплаты> [тариф]';
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
  async clientTicket(client: string, text: string, chatId: number): Promise<number> {
    const name = client.replace(/:/g, ' ').trim().slice(0, 80) || 'клиент';
    const t = this.hq.createTask({ title: `Тикет из бота: ${name.slice(0, 60)}`, dept: SUPPORT, assigneeId: SUPPORT_HEAD_ID, creator: 'routine', meta: { action: 'ticket', args: `${name}: ${text}`, chatId } });
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
        const r = await this.cs.handleTicket(ctx, { ...p, ...(chatId !== undefined ? { chatId } : {}) });
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
      case 'sub': {
        const s = parseSubArgs(args)!;
        const sub = this.billing.store(ctx).addSubscription({ client: s.client, plan: s.plan, amountUsd: s.amountUsd, period: s.period, nextDue: s.nextDue, method: s.method });
        return `Подписка сохранена: ${sub.client}, $${sub.amountUsd} за ${sub.period === 'year' ? 'год' : 'месяц'}, следующая оплата ${sub.nextDue}. Счёт появится за 7 дней до срока.`;
      }
      case 'paid': {
        const r = this.billing.markPaid(ctx, args);
        if (!r) return `Не нашёл счёт «${args}». Список: /invoices.`;
        const { invoice: inv } = r;
        if (r.already) return `Счёт ${inv.number} уже отмечен оплаченным.`;
        let text = `Счёт ${inv.number} (${inv.client}, $${inv.amountUsd}) оплачен. Выручка попадёт в отчёты Финансиста.`;
        if (r.nextDue) text += ` Следующая оплата по подписке: ${r.nextDue}.`;
        if (inv.newProject) text += `\n\n${await this.startOnboarding(ctx, inv.client, inv.what, inv.number)}`;
        return text;
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
