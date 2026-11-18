import { errMsg, log, type ApprovalQueue, type Messenger } from '@fir/core';
import type { Hq, Task } from '@fir/hq';
import type { Reporter } from './reporter.js';

/** Tag of every drill task; `/drill clear` deletes only what carries it (or hangs under it). */
export const DRILL_TAG = 'drill';
/** The one test client of the drill: tickets, invoices, onboarding and documents are filed under this name. */
export const DRILL_CLIENT = 'Тест учения';
const TITLE = 'Учения: ';
const AUTO_REPORT_MS = 10 * 60_000;
const TICK_MS = 30_000;
const STARTED = 'drill_started';
const REPORTED = 'drill_reported';

export interface DrillDeps {
  hq: Hq;
  queue: ApprovalQueue;
  messenger: Messenger;
  ownerId: number;
  reporter?: Reporter | undefined;
  /** Monitoring has no task action (its checks run on the head's cron): this runs all checks now and returns a short result. */
  monitor?: () => Promise<string>;
  /** Knowledge base search is a command, not a task action: runs `/kb <query>` and returns its text. */
  kb?: (query: string) => Promise<string>;
}

interface Scenario {
  dept: string;
  worker: string;
  /** Task title after «Учения: ». */
  title: string;
  /** `task`: a head picks it up on its heartbeat. `inline`: the drill runs the worker's command itself and records the task. */
  mode: 'task' | 'inline';
  meta?: Record<string, unknown>;
  body?: string;
  /** Created later, when the clip of the content-maker is approved (the Publisher works with approved material only). */
  after?: string;
}

const SCENARIOS: Scenario[] = [
  { dept: 'marketing', worker: 'trend-scout', title: 'тренды дня', mode: 'task', meta: { action: 'trends' } },
  { dept: 'marketing', worker: 'content-maker', title: 'клип «ИИ-приёмщик для барбершопа»', mode: 'task', meta: { action: 'topic', topic: 'ИИ-приёмщик для барбершопа' } },
  { dept: 'marketing', worker: 'publisher', title: 'пакет публикации клипа', mode: 'task', meta: { action: 'daily' }, after: 'content-maker' },
  { dept: 'marketing', worker: 'seo', title: 'проверка firtech.pro', mode: 'task', meta: { action: 'seo' } },
  { dept: 'marketing', worker: 'analyst', title: 'недельный отчёт', mode: 'task', meta: { action: 'report' } },
  {
    dept: 'sales', worker: 'lead-intake', title: 'тестовый лид «Тест: нужен сайт»', mode: 'task',
    meta: { action: 'lead', lead: { name: 'Тест: нужен сайт', contact: 'drill@example.invalid', service: 'website', message: 'Тест: нужен сайт для барбершопа (учения, клиенту не отвечать)', locale: 'ru', source: 'drill' } },
  },
  { dept: 'sales', worker: 'prospector', title: 'одна карточка разведчика', mode: 'task', meta: { action: 'batch', limit: 1 } },
  { dept: 'sales', worker: 'presales', title: 'КП «Тест: лендинг для салона»', mode: 'task', meta: { action: 'kp', text: 'Тест: лендинг для салона (учения)' } },
  { dept: 'sales', worker: 'referral', title: 'напоминания по рекомендациям', mode: 'task', meta: { action: 'referral_reminders' } },
  { dept: 'support', worker: 'customer-support', title: 'тикет «Тест: не открывается сайт»', mode: 'task', meta: { action: 'ticket', args: `${DRILL_CLIENT}: не открывается сайт` } },
  { dept: 'support', worker: 'monitoring', title: 'все проверки сейчас', mode: 'inline' },
  { dept: 'support', worker: 'billing', title: 'счёт «Тест» $100 за учения', mode: 'task', meta: { action: 'invoice', args: `${DRILL_CLIENT} 100 за учения` } },
  { dept: 'support', worker: 'onboarding', title: 'онбординг «Тест»', mode: 'task', meta: { action: 'onboard', args: DRILL_CLIENT } },
  { dept: 'support', worker: 'finance', title: 'отчёт по расходам за месяц', mode: 'task', meta: { action: 'weekly' } },
  { dept: 'production', worker: 'project-manager', title: 'проект «Тест: лендинг»', mode: 'task', meta: { action: 'project', client: DRILL_CLIENT, what: 'лендинг (учения)', source: 'drill' } },
  { dept: 'backoffice', worker: 'documents', title: 'черновик договора «Тест»', mode: 'task', meta: { action: 'doc', type: 'contract', client: DRILL_CLIENT } },
  { dept: 'backoffice', worker: 'knowledge', title: 'поиск «как мы делаем лендинги»', mode: 'inline' },
];
/** Workers that get no task of their own: they depend on the approved ТЗ and a builder's result. */
const DEPENDENT = [
  { dept: 'production', worker: 'reviewer', kind: 'review' },
  { dept: 'production', worker: 'deployer', kind: 'deploy' },
];
const DEPT_ORDER = ['marketing', 'sales', 'support', 'production', 'backoffice'];

type State = 'ok' | 'wait' | 'fail' | 'run';
const ICON: Record<State, string> = { ok: '✅', wait: '⚠️', fail: '❌', run: '⏳' };

interface Row { worker: string; title: string; state: State; ms: number; text: string; missing?: boolean }

const oneLine = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const elapsed = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}с` : `${Math.floor(s / 60)}м${String(s % 60).padStart(2, '0')}с`;
};

/**
 * «Учения»: one safe test task for every worker, created through the same paths real work uses (head, worker, LLM,
 * approval queue). Nothing reaches a client: texts for clients wait in the approval queue and the owner sends them
 * himself anyway. Tasks carry the tag `drill` and `meta.drill = { worker, startedAt }`.
 */
export class Drill {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly d: DrillDeps) {}

  private get hq(): Hq {
    return this.d.hq;
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => void this.tick().catch((e) => log('error', 'drill tick failed', { err: errMsg(e) })), TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** `/drill [dept|report|clear]`. Returns the reply for the owner. */
  async command(arg: string): Promise<string> {
    const a = arg.trim().toLowerCase();
    if (a === 'report') return this.reportText();
    if (a === 'clear') return this.clear();
    if (a === '' || a === 'all') return this.begin(DEPT_ORDER);
    if (DEPT_ORDER.includes(a)) return this.begin([a]);
    return `Формат: /drill [${DEPT_ORDER.join('|')}|report|clear]`;
  }

  // ---- creating the tasks ----
  private drillTasks(): Task[] {
    return this.hq.tasks({ tag: DRILL_TAG, limit: 1000 });
  }

  private latest(worker: string): Task | undefined {
    return this.drillTasks().filter((t) => (t.meta.drill as { worker?: string } | undefined)?.worker === worker).at(-1);
  }

  private create(s: Scenario, startedAt: number): Task {
    return this.hq.createTask({
      title: `${TITLE}${s.title}`, body: s.body ?? '', dept: s.dept, creator: 'owner', tags: [DRILL_TAG],
      meta: { ...s.meta, drill: { worker: s.worker, startedAt } },
    });
  }

  private async begin(depts: string[]): Promise<string> {
    const running = SCENARIOS.filter((s) => depts.includes(s.dept)).map((s) => this.latest(s.worker)).filter((t): t is Task => !!t && ['inbox', 'assigned', 'running'].includes(t.status));
    if (running.length) return `Учения ещё идут (задач в работе: ${running.length}). Таблица: /drill report.`;
    const startedAt = this.hq.now();
    const made: string[] = [];
    const missing: string[] = [];
    const heads = new Set<string>();
    for (const s of SCENARIOS) {
      if (!depts.includes(s.dept) || s.after) continue;
      const head = this.hq.headOf(s.dept);
      if (!head) {
        if (!missing.includes(s.dept)) missing.push(s.dept);
        continue;
      }
      const t = this.create(s, startedAt);
      made.push(s.worker);
      if (s.mode === 'inline') await this.runInline(t, s);
      else heads.add(head.id);
    }
    for (const id of heads) this.hq.wake(id, 'task');
    this.hq.setSetting(STARTED, String(startedAt));
    this.hq.setSetting(REPORTED, '');
    const parts = [`Учения начались: задач ${made.length}, до 30 секунд на первые результаты. Таблица придёт сама, когда всё отработает или через 10 минут; сейчас: /drill report.`];
    if (missing.length) parts.push(`Нет головы отдела: ${missing.join(', ')}.`);
    return parts.join('\n');
  }

  /** Monitoring and knowledge have commands instead of task actions: the drill runs them and files the task like a head would. */
  private async runInline(task: Task, s: Scenario): Promise<void> {
    const hq = this.hq;
    hq.assign(task.id, s.worker, 'director');
    if (!hq.claim(task.id, s.worker)) return;
    try {
      const run = s.worker === 'monitoring' ? this.d.monitor : this.d.kb ? () => this.d.kb!('как мы делаем лендинги') : undefined;
      if (!run) throw new Error('исполнитель не подключён');
      const text = await run();
      hq.complete(task.id, s.worker, text || 'готово');
    } catch (e) {
      hq.block(task.id, s.worker, `Сбой: ${errMsg(e)}`.slice(0, 300));
    }
  }

  /** The Publisher works with approved material: its task appears once the drill clip is approved. */
  private advance(): void {
    for (const s of SCENARIOS) {
      if (!s.after || this.latest(s.worker)) continue;
      const parent = this.latest(s.after);
      const head = this.hq.headOf(s.dept);
      if (!parent || parent.status !== 'done' || !head) continue;
      this.create(s, this.hq.now());
      this.hq.wake(head.id, 'task');
    }
  }

  // ---- the table ----
  private family(tasks: Task[]): Task[] {
    const seen = new Map<number, Task>();
    for (const t of tasks) {
      seen.set(t.id, t);
      for (const c of this.hq.tasks({ parentId: t.id, limit: 200 })) seen.set(c.id, c);
    }
    return [...seen.values()];
  }

  private openApprovals(ids: number[]): number {
    if (!ids.length) return 0;
    const q = ids.map(() => '?').join(',');
    return (this.hq.db.prepare(`SELECT COUNT(*) c FROM task_approvals WHERE task_id IN (${q}) AND state IN ('queued','asked')`).get(...ids) as { c: number }).c;
  }

  private lastReason(t: Task): string {
    const ev = this.hq.events(t.id).filter((e) => e.kind === 'error').at(-1);
    return ev?.body ?? t.result ?? '';
  }

  private rowOf(worker: string, title: string, t: Task): Row {
    const hq = this.hq;
    const started = (t.meta.drill as { startedAt?: number } | undefined)?.startedAt ?? t.createdAt;
    const kids = this.family([t]);
    const open = this.openApprovals(kids.map((k) => k.id));
    const done = ['done', 'rejected'].includes(t.status);
    const end = ['inbox', 'assigned', 'running'].includes(t.status) ? hq.now() : t.updatedAt;
    const base = { worker, title, ms: end - started };
    const result = oneLine(t.result ?? '', 80);
    if (t.status === 'rejected') return { ...base, state: 'ok', text: 'одобрение отклонено владельцем' };
    if (t.status === 'blocked') {
      const reason = oneLine(this.lastReason(t), 80);
      return t.tags.includes('builder') ? { ...base, state: 'wait', text: reason || 'ждёт строителя' } : { ...base, state: 'fail', text: reason || 'заблокирована' };
    }
    if (t.status === 'review' || t.status === 'approval' || (done && open > 0)) {
      const first = this.all<{ summary: string }>(`SELECT summary FROM task_approvals WHERE task_id IN (${kids.map(() => '?').join(',')}) AND state IN ('queued','asked') ORDER BY id LIMIT 1`, ...kids.map((k) => k.id))[0]?.summary;
      return { ...base, state: 'wait', text: `ждёт вас: ${oneLine(first ?? result, 70)}` };
    }
    if (t.status === 'done') {
      const decided = this.all<{ summary: string }>(`SELECT summary FROM task_approvals WHERE task_id IN (${kids.map(() => '?').join(',')}) ORDER BY id LIMIT 1`, ...kids.map((k) => k.id))[0]?.summary;
      return { ...base, state: 'ok', text: result || (decided ? `выполнено сразу: ${oneLine(decided, 60)}` : 'готово') };
    }
    return { ...base, state: 'run', text: t.status === 'running' ? 'работает' : 'ещё не начато' };
  }

  private projectTasks(kind: string): Task[] {
    const p = this.all<{ id: number }>('SELECT id FROM pm_projects WHERE client = ? ORDER BY id DESC LIMIT 1', DRILL_CLIENT)[0];
    if (!p) return [];
    return this.hq.tasks({ dept: 'production', limit: 500 }).filter((t) => t.meta.projectId === p.id && t.meta.kind === kind);
  }

  /** One row per scenario (and per dependent worker), always in order: a task that does not exist shows as «задача не создана». */
  private rows(): Row[] {
    const names = (id: string) => this.hq.agent(id)?.title ?? id;
    const started = Number(this.hq.setting(STARTED) || 0);
    const notCreated = (worker: string): Row => ({ worker, title: names(worker), state: 'run', ms: -1, text: 'задача не создана', missing: true });
    const rows: Row[] = [];
    for (const s of SCENARIOS) {
      const t = this.latest(s.worker);
      if (t) rows.push(this.rowOf(s.worker, names(s.worker), t));
      else if (s.after && this.latest(s.after)) rows.push({ worker: s.worker, title: names(s.worker), state: 'wait', ms: -1, text: 'ждёт одобрения клипа' });
      else {
        // an unexpected hole after a drill started is worth a log line (ids only)
        if (started && !s.after) log('warn', 'drill task not found', { worker: s.worker, dept: s.dept, startedAt: started });
        rows.push(notCreated(s.worker));
      }
      if (s.worker === 'project-manager') {
        for (const dep of DEPENDENT) {
          const bt = t ? this.projectTasks(dep.kind).at(-1) : undefined;
          rows.push(bt ? this.rowOf(dep.worker, names(dep.worker), bt) : t ? { worker: dep.worker, title: names(dep.worker), state: 'wait', ms: -1, text: 'ждёт одобрения ТЗ / строителя' } : notCreated(dep.worker));
        }
      }
    }
    return rows;
  }

  reportText(): string {
    this.advance();
    const rows = this.rows();
    if (!this.drillTasks().length && !Number(this.hq.setting(STARTED) || 0)) return 'Учений ещё не было: /drill.';
    const started = Number(this.hq.setting(STARTED) || 0);
    const count = (s: State) => rows.filter((r) => r.state === s).length;
    const ids = this.family(this.drillTasks()).map((t) => t.id);
    const open = this.openApprovals(ids);
    const lines = [
      `Учения${started ? `, идут ${elapsed(this.hq.now() - started)}` : ''}`,
      ...rows.map((r) => `${ICON[r.state]} ${r.title}${r.ms >= 0 ? `, ${elapsed(r.ms)}` : ''}: ${r.text}`),
      `Итого: ✅ ${count('ok')}, ⚠️ ${count('wait')}, ❌ ${count('fail')}, ⏳ ${count('run')}.`,
    ];
    if (open > 0) lines.push(`Тестовых одобрений ждёт: ${open}. Отклоните их в /approve, потом /drill clear.`);
    else lines.push('Когда посмотрите, уберите тестовые данные: /drill clear.');
    return lines.join('\n');
  }

  /** The scheduled check: sends the table once, when every task left the work stages or 10 minutes passed. Returns true when it sent. */
  async tick(): Promise<boolean> {
    const started = Number(this.hq.setting(STARTED) || 0);
    if (!started || this.hq.setting(REPORTED)) return false;
    this.advance();
    const settled = this.rows().every((r) => r.state !== 'run' || r.missing);
    if (!settled && this.hq.now() - started < AUTO_REPORT_MS) return false;
    this.hq.setSetting(REPORTED, '1');
    const text = this.reportText();
    await this.d.messenger.send(this.d.ownerId, text);
    await this.d.reporter?.post('general', text);
    return true;
  }

  // ---- cleanup ----
  private exec(sql: string, ...args: unknown[]): number {
    try {
      return this.hq.db.prepare(sql).run(...args).changes;
    } catch (e) {
      if (/no such table/i.test(errMsg(e))) return 0;
      throw e;
    }
  }

  private all<T>(sql: string, ...args: unknown[]): T[] {
    try {
      return this.hq.db.prepare(sql).all(...args) as T[];
    } catch (e) {
      if (/no such table/i.test(errMsg(e))) return [];
      throw e;
    }
  }

  /** Deletes drill tasks and the test data the drill itself created (found through the tag, the tasks' approvals and the test client). */
  async clear(): Promise<string> {
    const hq = this.hq;
    // The onboarding checklist task is created by the head, not by the drill: adopt it through the test onboarding.
    for (const o of this.all<{ id: number }>('SELECT id FROM ob_onboardings WHERE client = ?', DRILL_CLIENT)) {
      for (const t of hq.tasks({ dept: 'support', limit: 500 })) if (t.meta.onboarding === o.id) hq.addTags(t.id, [DRILL_TAG]);
    }
    const tasks = this.family(this.drillTasks());
    const ids = tasks.map((t) => t.id);
    const links = ids.length
      ? this.all<{ id: number; approval_id: number | null; state: string; payload: string }>(`SELECT id, approval_id, state, payload FROM task_approvals WHERE task_id IN (${ids.map(() => '?').join(',')})`, ...ids)
      : [];
    let rejected = 0;
    for (const l of links) {
      const core = l.approval_id ? this.d.queue.get(l.approval_id) : undefined;
      if (core && (core.status === 'pending' || core.status === 'editing')) {
        await this.d.queue.handle('reject', core.id, this.d.ownerId);
        rejected++;
      } else if (l.state === 'queued') rejected++;
    }
    for (const l of links) {
      let p: Record<string, unknown> = {};
      try { p = JSON.parse(l.payload) as Record<string, unknown>; } catch { /* keep empty */ }
      const num = (k: string) => (Number.isInteger(Number(p[k])) && Number(p[k]) > 0 ? Number(p[k]) : null);
      const prospect = num('prospectId');
      if (prospect) this.exec("UPDATE pr_prospects SET status = 'new', proposed_at = NULL, draft = NULL, draft_kind = NULL WHERE id = ? AND status IN ('proposed','skipped')", prospect);
      const pack = num('packId');
      if (pack && p.leadId == null) this.exec('DELETE FROM ps_documents WHERE pack_id = ?', pack);
      const doc = num('docId');
      if (doc) this.exec('DELETE FROM bo_documents WHERE id = ? AND client = ?', doc, DRILL_CLIENT);
      const item = num('itemId');
      if (item) {
        this.exec('DELETE FROM cm_ready WHERE item_id = ?', item);
        this.exec('DELETE FROM cm_items WHERE id = ?', item);
      }
    }
    this.exec('DELETE FROM cs_tickets WHERE client_name = ?', DRILL_CLIENT);
    this.exec('DELETE FROM cs_clients WHERE name = ?', DRILL_CLIENT);
    this.exec('DELETE FROM bl_invoices WHERE client = ?', DRILL_CLIENT);
    this.exec('DELETE FROM ob_items WHERE onboarding_id IN (SELECT id FROM ob_onboardings WHERE client = ?)', DRILL_CLIENT);
    this.exec('DELETE FROM ob_onboardings WHERE client = ?', DRILL_CLIENT);
    this.exec('DELETE FROM bo_documents WHERE client = ?', DRILL_CLIENT);
    this.exec("DELETE FROM pm_milestones WHERE project_id IN (SELECT id FROM pm_projects WHERE client = ? AND source = 'drill')", DRILL_CLIENT);
    this.exec("DELETE FROM pm_projects WHERE client = ? AND source = 'drill'", DRILL_CLIENT);
    for (const id of ids) this.exec('DELETE FROM li_leads WHERE task_id = ?', id);
    for (const id of ids) hq.deleteTask(id);
    hq.reconcileApprovals();
    hq.setSetting(STARTED, '');
    hq.setSetting(REPORTED, '');
    return `Учения очищены: задач ${ids.length}, неотвеченных одобрений отклонено ${rejected}. Данные, помеченные «${DRILL_CLIENT}», удалены.`;
  }
}
