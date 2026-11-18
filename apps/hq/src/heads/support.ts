import { errMsg, log, schedule, zonedParts, type LlmClient } from '@fir/core';
import { meterLlm, type Agent, type Hq, type Task, type WorkerCtx } from '@fir/hq';
import { FinanceWorker } from '@fir/worker-finance';
import { MonitoringWorker, type MonEvent } from '@fir/worker-monitoring';
import type { Cron } from 'croner';
import type { Reporter } from '../reporter.js';

export const SUPPORT = 'support';
export const SUPPORT_HEAD_ID = 'support-head';
export const MONITOR_CRON = '*/5 * * * *';

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
  const routines = [
    { name: 'support-daily', cron: '50 7 * * *', dept: SUPPORT, title: 'Финансы и аптайм за сутки', meta: { action: 'daily' } },
    { name: 'support-weekly', cron: '0 20 * * 0', dept: SUPPORT, title: 'Отчёт по расходам за месяц', meta: { action: 'weekly' } },
  ];
  for (const r of routines) if (!hq.routineByName(r.name)) hq.scheduleRoutine(r);
}

export interface SupportDeps {
  hq: Hq;
  llm: LlmClient;
  reporter: Reporter;
  monitor: MonitoringWorker;
  finance: FinanceWorker;
}

type Action = 'daily' | 'weekly' | 'status' | 'none';

/** Owner's free text, without an LLM: only obvious wordings. */
export function guessAction(task: Task): Action {
  const m = task.meta.action;
  if (m === 'daily' || m === 'weekly' || m === 'status') return m;
  const text = `${task.title} ${task.body}`.toLowerCase();
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

  constructor(private readonly d: SupportDeps) {}

  private get hq(): Hq {
    return this.d.hq;
  }

  private agent(): Agent | undefined {
    return this.hq.agent(SUPPORT_HEAD_ID);
  }

  start(): void {
    this.stop();
    this.jobs = [schedule('support-monitor', MONITOR_CRON, this.hq.tz, async () => void (await this.monitorTick()))];
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
      requestApproval: () => Promise.reject(new Error('Сопровождение ничего не предлагает на одобрение')),
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
      this.hq.block(task.id, SUPPORT_HEAD_ID, 'Сопровождение умеет: расходы, аптайм и мониторинг, сводка за сутки');
      await this.report(task.id, `Задача #${task.id} «${task.title}» не для сопровождения: умею расходы, аптайм, сводку за сутки.`);
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
