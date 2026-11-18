import { Cron } from 'croner';
import { errMsg, log, schedule, tryJson, zonedParts, zonedToMs, type ApprovalQueue, type LlmClient, type Messenger } from '@fir/core';
import { meterLlm, type Hq, type Task } from '@fir/hq';
import { z } from 'zod';
import { dailyCron } from './config.js';
import type { ApprovalEditor } from './editor.js';
import type { Reporter } from './reporter.js';
import { openBuilderTasks } from './bridge.js';
import { Progress, deptRu, lastReason, reasonRu } from './progress.js';

const DAY = 86_400_000;
const HM = /^([01]?\d|2[0-3]):[0-5]\d$/;

/** The settings the owner may change by chat, with their validators. Anything else is refused. */
const SETTING_RULES: Record<string, { label: string; valid: (v: string) => boolean }> = {
  tz: { label: 'часовой пояс отделов', valid: (v) => { try { new Intl.DateTimeFormat('en-US', { timeZone: v }); return true; } catch { return false; } } },
  summary_time: { label: 'время утренней сводки', valid: (v) => HM.test(v) },
  approval_time: { label: 'время пачки на одобрение', valid: (v) => HM.test(v) },
  quiet_hours: { label: 'тихие часы (алерты копятся до сводки)', valid: (v) => v === '' || /^([01]?\d|2[0-3]):[0-5]\d-([01]?\d|2[0-3]):[0-5]\d$/.test(v) },
};

const intentSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('task'),
    title: z.string().min(1).max(200),
    dept: z.string().min(1),
    body: z.string().max(2000).optional(),
    priority: z.coerce.number().int().min(0).max(2).default(0),
    due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  }),
  z.object({ type: z.literal('status'), dept: z.string().nullable().optional() }),
  z.object({
    type: z.literal('rule'),
    target: z.enum(['setting', 'instructions']),
    key: z.string().optional(),
    value: z.string().max(200).optional(),
    agent_id: z.string().optional(),
    text: z.string().max(500).optional(),
  }),
  z.object({ type: z.literal('sales_reply'), id: z.coerce.number().int().positive(), text: z.string().max(2000).optional() }),
  z.object({ type: z.literal('builder'), title: z.string().min(1).max(200), body: z.string().max(2000).optional() }),
  z.object({ type: z.literal('production_command'), command: z.string().min(1).max(30), arg: z.string().max(1500).default('') }),
  z.object({ type: z.literal('backoffice_command'), command: z.string().min(1).max(30), arg: z.string().max(1500).default('') }),
  z.object({ type: z.literal('unknown'), question: z.string().max(300).optional() }),
]);
type Intent = z.output<typeof intentSchema>;

/** A confirmed-by-button change, kept in settings until the owner answers. */
interface PendingRule {
  target: 'setting' | 'instructions';
  key?: string;
  value?: string;
  agentId?: string;
  text?: string;
}

export interface DirectorDeps {
  hq: Hq;
  llm: LlmClient;
  messenger: Messenger;
  queue: ApprovalQueue;
  ownerId: number;
  /** Optional: the summary and alerts are mirrored into the "general" topic of the HQ group. */
  reporter?: Reporter;
}

const ruRole: Record<string, string> = { director: 'директор', head: 'голова', worker: 'исполнитель' };
const STATUS_RU: Record<string, string> = {
  inbox: 'ждёт отдел', assigned: 'ждёт отдел', running: 'в работе', review: 'на проверке', approval: 'ждёт вас в /approve', blocked: 'застряла', done: 'выполнена', rejected: 'отклонена',
};
/** Compact cheat sheet for /help (the full page: apps/hq/docs/owner-cheatsheet.md). */
export const HELP = [
  'Директор Fir Tech. Пишите задачу обычным текстом: передам отделу и буду править одно сообщение по ходу работы (взял, делает, ждёт вас, готово).',
  'Куда что приходит: ответы, карточки на одобрение и «живые» сообщения о задачах здесь, в личке. Отчёты отделов и сводки в группе HQ по темам.',
  '',
  'Каждый день:',
  '/status: кто чем занят, что ждёт вас, ближайшая рутина',
  '/tasks [отдел]: открытые задачи и что с каждой',
  '/approve: пачка на одобрение (сама приходит в 10:00)',
  '/retry <id>: повторить застрявшую задачу',
  '',
  'Ещё:',
  '/costs расходы, /org оргструктура, /pause и /resume <отдел>',
  '/reply <id>, /kp <лид или описание>, /referral, /referrals: продажи',
  '/ticket, /tickets, /client, /clients, /invoice, /invoices, /sub, /onboard, /paid <счёт или id>: сопровождение',
  '/project, /pstatus, /target, /mdone: производство; /doc, /lesson, /kb: документы и знания',
  '/builders, /builder <id>: задачи строителям; /topics: темы в группе; /drill: учения; /skip: отменить ожидание правки',
  '',
  'Статусы на сайте офиса: работает (идёт задача), ждёт (ответ за вами), застрял (нужна помощь, /retry), спит (ночь или тихие часы), офлайн (давно не отзывался).',
].join('\n');
const money = (n: number) => `$${n.toFixed(2)}`;
const oneLine = (s: string, n = 160) => s.replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * The Director: the only voice to the owner. Parses any owner message with the LLM (strict JSON) into a task, a
 * status question, a rule change (written only after a button) or a builder request. Writes by itself only the
 * morning summary, the approval batch and alerts.
 */
export class Director {
  readonly editors = new Map<string, ApprovalEditor>();
  /** Set by the Sales head: a business answered (`/reply <id>` or free text). Returns what to tell the owner. */
  onSalesReply: ((id: number, text?: string) => Promise<string>) | null = null;
  /** Set by the Sales head: /kp, /referral, /referrals, /paid go through as they are. Returns what to tell the owner. */
  onSalesCommand: ((name: string, arg: string) => Promise<string>) | null = null;
  /** Set by the Support head: `/ticket`, `/tickets`, `/client`, `/invoice`, `/paid`, `/onboard`... (generic passthrough). */
  onSupportCommand: ((name: string, args: string) => Promise<string>) | null = null;
  /** Set by the topic manager: `/topics` creates the missing topics (or explains the two steps). Returns the reply. */
  onTopicsCommand: (() => Promise<string>) | null = null;
  /** Set by the builder bridge: a builder task was just created, make its issue now instead of at the next poll. */
  onBuilderTask: (() => Promise<unknown>) | null = null;
  /** Set by the drill: `/drill [dept|report|clear]`. Returns the reply. */
  onDrillCommand: ((arg: string) => Promise<string>) | null = null;
  /** Commands of the Production and Back Office heads (`/project`, `/doc`...): name -> handler returning the reply. */
  readonly commands = new Map<string, { dept: 'production' | 'backoffice'; run: (arg: string) => Promise<string> }>();
  /** Extra lines of the morning summary from heads (overdue milestones, pending documents); null: nothing to say. */
  readonly summaryLines: (() => string | null)[] = [];
  private jobs: Cron[] = [];
  private readonly llm: LlmClient;
  /** The «live message» of the owner's tasks: one message, edited as the task moves. */
  readonly progress: Progress;

  constructor(private readonly d: DirectorDeps) {
    this.llm = meterLlm(d.llm, d.hq, { agentId: 'director' });
    this.progress = new Progress({ hq: d.hq, messenger: d.messenger, ownerId: d.ownerId });
    d.hq.onAlert((text) => this.alertOwner(text));
  }

  private get hq(): Hq {
    return this.d.hq;
  }

  /** The last message sent by `say` (a command reply can become the live message of the task it created). */
  private lastSay: { id: number; text: string } | null = null;

  private async say(text: string, buttons?: { text: string; data: string }[][]): Promise<void> {
    const id = await this.d.messenger.sendMessage(this.d.ownerId, text, buttons);
    this.lastSay = { id, text };
  }

  private lastTaskId(): number {
    return (this.hq.db.prepare('SELECT COALESCE(MAX(id), 0) m FROM tasks').get() as { m: number }).m;
  }

  /** Tasks the owner's message created through a head command (`/kp`, `/project`, `/doc`...): each gets its live message. */
  private async trackNew(afterId: number): Promise<void> {
    let reply = this.lastSay;
    for (const t of this.hq.tasks({ limit: 1000 })) {
      if (t.id <= afterId || t.creator !== 'owner' || t.meta.progress || t.status === 'done' || t.status === 'rejected') continue;
      if (reply) {
        // the command's own reply is the one message of the task
        this.progress.adopt(t, reply.id, reply.text);
        reply = null;
        continue;
      }
      await this.progress.track(t).catch((e) => log('warn', 'progress start failed', { task: t.id, err: errMsg(e) }));
    }
  }

  // ---- scheduling ----
  start(): void {
    this.stop();
    this.progress.start();
    const tz = this.hq.tz;
    this.jobs = [
      schedule('director-summary', dailyCron(this.hq.setting('summary_time')), tz, () => this.sendMorningSummary()),
      schedule('director-approvals', dailyCron(this.hq.setting('approval_time')), tz, async () => void (await this.sendApprovalBatch(false))),
    ];
  }

  stop(): void {
    this.progress.stop();
    for (const j of this.jobs) j.stop();
    this.jobs = [];
  }

  // ---- the three things the Director writes by itself ----
  async sendMorningSummary(): Promise<void> {
    const text = this.morningSummary();
    await this.say(text);
    await this.d.reporter?.post('general', text);
    this.hq.setSetting('held_alerts', '[]');
  }

  morningSummary(): string {
    const hq = this.hq;
    const p = zonedParts(hq.now(), hq.tz);
    const since = hq.now() - DAY;
    const out: string[] = [`Утренняя сводка, ${String(p.d).padStart(2, '0')}.${String(p.mo).padStart(2, '0')}`];
    const reports = hq.reports(since);
    out.push(
      reports.length
        ? `Отчёты отделов за сутки:\n${reports.map((r) => `- ${r.dept}: ${oneLine(r.body, 1200)}`).join('\n')}`
        : 'Отчётов отделов за сутки нет.',
    );
    const queued = hq.queuedApprovals().length;
    const waiting = this.d.queue.pending().length;
    out.push(queued + waiting > 0 ? `Ждёт одобрения: ${queued + waiting} (в пачке в ${hq.setting('approval_time')} или /approve).` : 'На одобрении ничего нет.');
    const blocked = hq.tasks({ status: 'blocked', limit: 30 }).filter((t) => !t.tags.includes('drill')).slice(0, 10);
    if (blocked.length) out.push(`Заблокировано:\n${blocked.map((t) => `- #${t.id} ${t.dept}: ${oneLine(t.title, 80)}${t.tags.includes('builder') ? ' (нужен строитель)' : ''}`).join('\n')}`);
    const builders = openBuilderTasks(hq).filter((t) => t.status === 'blocked');
    if (builders.length) out.push(`Открытых builder-issue: ${builders.filter((t) => t.meta.issue).length}, ждут создания issue: ${builders.filter((t) => !t.meta.issue).length}. Список: /builders.`);
    for (const line of this.summaryLines) {
      const text = line();
      if (text) out.push(text);
    }
    const spend = hq.costSummary(since);
    out.push(spend.length ? `Расходы за сутки: ${spend.map((s) => `${s.dept} ${money(s.usd)}`).join(', ')}.` : 'Расходов за сутки нет.');
    const held = this.held();
    if (held.length) out.push(`Инциденты за ночь:\n${held.map((h) => `- ${h}`).join('\n')}`);
    return out.join('\n\n');
  }

  /** The batch: every department's proposals as one numbered series. `manual`: say so when there is nothing. */
  async sendApprovalBatch(manual: boolean): Promise<number> {
    const n = await this.hq.releaseApprovals();
    if (n > 0) await this.say(`Пачка на одобрение: ${n}. Карточки ниже, у каждой кнопки.`);
    else if (manual) {
      const old = this.d.queue.pending().length;
      await this.say(old ? `Новых предложений нет. Ждут вашего решения ранее присланные: ${old}.` : 'Нечего одобрять.');
    }
    return n;
  }

  private held(): string[] {
    try {
      const v = JSON.parse(this.hq.setting('held_alerts') || '[]') as unknown;
      return Array.isArray(v) ? v.map(String) : [];
    } catch {
      return [];
    }
  }

  /** Alerts go out at once; in quiet hours they wait for the morning summary. */
  async alertOwner(text: string): Promise<void> {
    if (this.hq.isQuiet()) {
      this.hq.setSetting('held_alerts', JSON.stringify([...this.held(), oneLine(text, 300)].slice(-20)));
      return;
    }
    await this.say(`Алерт: ${text}`);
    await this.d.reporter?.post('general', `Алерт: ${text}`);
  }

  // ---- owner input ----
  /** The Telegram glue calls this after approval buttons ran, so tasks follow the owner's decisions. */
  afterDecision(): void {
    this.hq.reconcileApprovals();
  }

  async onEditPressed(approvalId: number): Promise<string | null> {
    const kind = this.d.queue.get(approvalId)?.kind;
    const editor = kind ? this.editors.get(kind) : undefined;
    return editor ? editor.press(approvalId) : null;
  }

  async onPartPicked(approvalId: number, part: string): Promise<string> {
    const kind = this.d.queue.get(approvalId)?.kind;
    const editor = kind ? this.editors.get(kind) : undefined;
    return editor ? editor.pick(approvalId, part) : 'Нет такой части';
  }

  async onCommand(name: string, arg = ''): Promise<void> {
    const before = this.lastTaskId();
    this.lastSay = null;
    await this.runCommand(name, arg);
    await this.trackNew(before);
  }

  private async runCommand(name: string, arg: string): Promise<void> {
    const dept = arg.trim().toLowerCase();
    switch (name) {
      case 'start':
      case 'help':
        return this.say(HELP);
      case 'status':
        return this.say(this.statusText());
      case 'tasks':
        return this.say(this.tasksText(dept || undefined));
      case 'retry':
        return this.retry(arg);
      case 'approve':
        await this.sendApprovalBatch(true);
        return;
      case 'costs':
        return this.say(this.costsText());
      case 'builders':
        return this.say(this.buildersText());
      case 'builder': {
        const id = Number.parseInt(dept, 10);
        const t = Number.isFinite(id) ? this.hq.task(id) : undefined;
        if (!t) return this.say('Укажите номер задачи: /builder <id>.');
        if (t.status === 'done' || t.status === 'rejected') return this.say(`Задача #${t.id} уже закрыта (${t.status}).`);
        if (t.tags.includes('builder') && t.status === 'blocked') return this.say(`Задача #${t.id} уже у строителей (/builders).`);
        if (typeof t.meta.kind !== 'string') this.hq.setMeta(t.id, { kind: 'adhoc' });
        this.hq.block(t.id, 'director', 'Нужен строитель: задача для Claude Code', ['builder']);
        return this.say(`Задача #${t.id} «${t.title.slice(0, 80)}» передана строителям: issue появится в течение 10 минут (/builders).`);
      }
      case 'org':
        return this.say(this.orgText());
      case 'pause':
      case 'resume': {
        if (!this.hq.departments().includes(dept)) return this.say(`Укажите отдел: ${this.hq.departments().join(', ')}.`);
        this.hq.setDeptStatus(dept, name === 'pause' ? 'paused' : 'active');
        return this.say(name === 'pause' ? `Отдел ${dept} на паузе: новые задачи не берёт, повторные пробуждения не идут.` : `Отдел ${dept} снова работает.`);
      }
      case 'kp':
      case 'referral':
      case 'referrals':
        return this.say(this.onSalesCommand ? await this.onSalesCommand(name, arg) : 'Отдел продаж не подключён.');
      case 'paid': // an invoice number (FT-2026-001, 2026-001) goes to Support, anything else is a referral id (Sales)
        if (/^#?(?:[A-Za-z]+-)?\d{4}-\d+$/.test(arg.trim())) return this.say(this.onSupportCommand ? await this.onSupportCommand(name, arg) : 'Отдел сопровождения не подключён.');
        return this.say(this.onSalesCommand ? await this.onSalesCommand(name, arg) : 'Отдел продаж не подключён.');
      case 'reply':
        return this.salesReply(Number(arg.trim().replace(/^#/, '')), undefined);
      case 'ticket': case 'tickets': case 'client': case 'clients': case 'invoice': case 'invoices': case 'sub': case 'onboard':
        return this.say(this.onSupportCommand ? await this.onSupportCommand(name, arg) : 'Отдел сопровождения не подключён.');
      case 'drill':
        return this.say(this.onDrillCommand ? await this.onDrillCommand(arg) : 'Учения не подключены.');
      case 'topics':
        return this.say(this.onTopicsCommand ? await this.onTopicsCommand() : 'Группа HQ не подключена.');
      case 'skip':
        for (const e of this.editors.values()) e.cancel();
        return this.say('Ок, ничего не жду.');
      default: {
        const handler = this.commands.get(name);
        if (handler) return this.say(await handler.run(arg));
        return;
      }
    }
  }

  /** A command of a head by name, only if registered for this department: the model's word is never a command by itself. */
  private async headCommand(dept: 'production' | 'backoffice', command: string, arg: string): Promise<void> {
    const handler = this.commands.get(command.replace(/^\//, '').toLowerCase());
    if (!handler || handler.dept !== dept) return this.say(`Не знаю такой команды отдела. Есть: ${[...this.commands].filter(([, h]) => h.dept === dept).map(([n]) => `/${n}`).join(', ') || 'нет'}.`);
    return this.say(await handler.run(arg));
  }

  async onText(text: string): Promise<void> {
    for (const e of this.editors.values()) if (await e.consume(text)) return;
    const before = this.lastTaskId();
    this.lastSay = null;
    await this.handleText(text);
    await this.trackNew(before);
  }

  private async handleText(text: string): Promise<void> {
    const intent = await this.parse(text);
    if (!intent) return this.say('Не смог разобрать сообщение (модель недоступна или ответила не по форме). Команды: /help.');
    switch (intent.type) {
      case 'task':
        return this.createTask(intent);
      case 'status':
        return this.say(intent.dept ? this.tasksText(intent.dept.toLowerCase()) : this.statusText());
      case 'sales_reply':
        return this.salesReply(intent.id, intent.text);
      case 'builder':
        return this.createBuilder(intent.title, intent.body ?? text);
      case 'rule':
        return this.proposeRule(intent);
      case 'production_command':
        return this.headCommand('production', intent.command, intent.arg);
      case 'backoffice_command':
        return this.headCommand('backoffice', intent.command, intent.arg);
      default:
        return this.say(intent.question ? `Уточните: ${intent.question}` : 'Не понял, что нужно сделать. Опишите задачу и отдел, или /help.');
    }
  }

  private async parse(text: string): Promise<Intent | null> {
    const depts = this.hq.departments();
    const agents = this.hq.agents().map((a) => `${a.id} (${a.dept}, ${ruRole[a.role]})`).join('; ');
    const system = `${this.hq.agent('director')?.instructions ?? ''}\n\nРазбери сообщение владельца в один JSON. Отделы: ${depts.join(', ') || 'нет'}. Агенты: ${agents}. Настройки: ${Object.entries(SETTING_RULES).map(([k, v]) => `${k} (${v.label})`).join('; ')}.
Формы ответа:
{"type":"task","title":"...","dept":"<отдел>","body":"...","priority":0-2,"due":"YYYY-MM-DD или null"}
{"type":"status","dept":"<отдел или null>"}
{"type":"rule","target":"setting","key":"<настройка>","value":"..."} или {"type":"rule","target":"instructions","agent_id":"<агент>","text":"<новое правило одной строкой>"}
{"type":"sales_reply","id":<номер бизнеса из карточки Разведчика>,"text":"<текст ответа бизнеса, если он есть в сообщении>"} (бизнес ответил на наше сообщение)
{"type":"builder","title":"...","body":"..."} (нужен новый инструмент, бот или интеграция, которых нет)
${this.commandForms()}{"type":"unknown","question":"<что переспросить>"}
Ответ: только JSON-объект.`;
    return tryJson(this.llm, { tier: 'haiku', system, messages: [{ role: 'user', content: text.slice(0, 3000) }], maxTokens: 500 }, intentSchema);
  }

  /** Prompt lines for the head commands that are registered (none: nothing is offered to the model). */
  private commandForms(): string {
    const names = (dept: string) => [...this.commands].filter(([, h]) => h.dept === dept).map(([n]) => n);
    const prod = names('production');
    const back = names('backoffice');
    return `${prod.length ? `{"type":"production_command","command":"${prod.join('|')}","arg":"<аргументы команды>"} (проект из КП: project "клиент: что делаем"; статус клиенту: pstatus; цель деплоя: target; закрыть этап: mdone)\n` : ''}${back.length ? `{"type":"backoffice_command","command":"${back.join('|')}","arg":"<аргументы команды>"} (документ: doc "тип клиент"; урок из проекта: lesson "проект: урок"; поиск по базе знаний: kb "запрос")\n` : ''}`;
  }

  // ---- intents ----
  private async createTask(i: Extract<Intent, { type: 'task' }>): Promise<void> {
    const dept = i.dept.toLowerCase();
    const head = this.hq.headOf(dept);
    if (!head) return this.say(`Не нашёл отдел «${i.dept}». Есть: ${this.hq.departments().join(', ')}. Повторите с названием отдела.`);
    let dueAt: number | null = null;
    if (i.due) {
      const [y, m, d] = i.due.split('-').map(Number) as [number, number, number];
      dueAt = zonedToMs(y, m, d, 23, 59, this.hq.tz);
    }
    const t = this.hq.createTask({ title: i.title, body: i.body ?? '', dept, creator: 'owner', priority: i.priority, dueAt });
    this.hq.wake(head.id, 'task');
    const fresh = this.hq.task(t.id)!;
    const intro = `${this.progress.intro(fresh)}${i.priority > 0 ? ' Приоритет выше обычного.' : ''}`;
    const sent = await this.progress.track(fresh, intro).catch(() => false);
    if (!sent) await this.say(`Задача #${t.id} отделу ${deptRu(dept)}: «${oneLine(t.title, 100)}». ${intro}`);
  }

  /** `/retry <id>`: a blocked task goes back to its department, with a new live message. */
  private async retry(arg: string): Promise<void> {
    const id = Number.parseInt(arg.trim().replace(/^#/, ''), 10);
    const t = Number.isFinite(id) ? this.hq.task(id) : undefined;
    if (!t) return this.say('Укажите номер задачи: /retry 12. Номера: /tasks.');
    if (t.tags.includes('drill')) return this.say('Это задача учений, повторять её не нужно (/drill).');
    if (t.status === 'done' || t.status === 'rejected') return this.say(`Задача #${t.id} уже закрыта. Создайте новую обычным текстом.`);
    if (t.status !== 'blocked') return this.say(`Задача #${t.id} не застряла (${STATUS_RU[t.status]}), повторять нечего.`);
    if (t.tags.includes('builder')) return this.say(`Задача #${t.id} у строителей, повтор не поможет: смотрите /builders.`);
    const head = this.hq.headOf(t.dept);
    if (!head) return this.say(`У отдела «${t.dept}» нет головы, повторить нельзя.`);
    this.hq.requeue(t.id, 'owner');
    this.hq.wake(head.id, 'task');
    const fresh = this.hq.task(t.id)!;
    const sent = await this.progress.track(fresh, `Поставил заново в очередь отдела ${deptRu(t.dept)}. Я обновлю это сообщение.`).catch(() => false);
    if (!sent) await this.say(`Задача #${t.id} снова в очереди отдела ${deptRu(t.dept)}.`);
  }

  private async salesReply(id: number, text: string | undefined): Promise<void> {
    if (!this.onSalesReply) return this.say('Отдел продаж не подключён.');
    if (!Number.isInteger(id) || id <= 0) return this.say('Формат: /reply <id>, номер из карточки (#12).');
    return this.say(await this.onSalesReply(id, text));
  }

  private async createBuilder(title: string, body: string): Promise<void> {
    const t = this.hq.createTask({ title, body, dept: 'hq', creator: 'owner', tags: ['builder'] });
    this.hq.block(t.id, 'director', 'Нужен строитель: задача для главного окна Claude Code', ['builder']);
    await this.onBuilderTask?.().catch(() => undefined);
    const fresh = this.hq.task(t.id)!;
    const sent = await this.progress.track(fresh, 'Строители работают в Claude Code, это не минуты. Список: /builders.').catch(() => false);
    if (!sent) await this.say(`Записал для строителя: #${t.id} «${oneLine(title, 100)}». Issue появится в течение 10 минут (/builders).`);
  }

  // ---- rule changes (written only after the owner's button) ----
  private async proposeRule(i: Extract<Intent, { type: 'rule' }>): Promise<void> {
    let rule: PendingRule;
    let what: string;
    if (i.target === 'setting') {
      const spec = i.key ? SETTING_RULES[i.key] : undefined;
      if (!i.key || !spec || i.value === undefined) return this.say(`Эту настройку менять нельзя. Доступны: ${Object.keys(SETTING_RULES).join(', ')}.`);
      const value = i.value.trim();
      if (!spec.valid(value)) return this.say(`Значение «${value}» не подходит для ${i.key} (${spec.label}).`);
      rule = { target: 'setting', key: i.key, value };
      what = `Настройка ${i.key} (${spec.label}): «${this.hq.setting(i.key)}» → «${value}»`;
    } else {
      const agent = i.agent_id ? this.hq.agent(i.agent_id) : undefined;
      const text = i.text?.replace(/\s+/g, ' ').trim();
      if (!agent || !text) return this.say(`Не понял, для какого агента правило. Агенты: ${this.hq.agents().map((a) => a.id).join(', ')}.`);
      rule = { target: 'instructions', agentId: agent.id, text };
      what = `Новое правило в инструкции «${agent.title}» (${agent.id}): ${text}`;
    }
    const seq = Number(this.hq.setting('pending_seq') || '0') + 1;
    this.hq.setSetting('pending_seq', String(seq));
    this.hq.setSetting(`pending_rule:${seq}`, JSON.stringify(rule));
    return this.say(`${what}\n\nПрименить?`, [[{ text: 'Применить', data: `rl:${seq}:y` }, { text: 'Отмена', data: `rl:${seq}:n` }]]);
  }

  /** Button on a rule-change card. Returns the callback toast. */
  async onRuleButton(seq: number, yes: boolean): Promise<string> {
    const key = `pending_rule:${seq}`;
    const raw = this.hq.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    if (!raw) return 'Уже обработано';
    this.hq.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    if (!yes) return 'Отменено';
    const rule = JSON.parse(raw.value) as PendingRule;
    try {
      if (rule.target === 'setting' && rule.key && SETTING_RULES[rule.key]?.valid(rule.value ?? '')) {
        this.hq.setSetting(rule.key, rule.value ?? '');
        this.hq.log('director', 'setting_changed', 'setting', rule.key);
        this.start(); // times or timezone may have changed
      } else if (rule.target === 'instructions' && rule.agentId && rule.text) {
        const agent = this.hq.agent(rule.agentId);
        if (!agent) return 'Агент не найден';
        this.hq.setInstructions(agent.id, appendRule(agent.instructions, rule.text));
      } else return 'Не могу применить';
    } catch (e) {
      log('error', 'rule apply failed', { err: errMsg(e) });
      return 'Ошибка';
    }
    return 'Применено';
  }

  // ---- texts ----
  /** One journal entry in words, or null when it is not worth showing (assignments, comments). */
  private eventWords(e: { kind: string; body: string }): string | null {
    const b = e.body;
    if (e.kind === 'result') return 'результат готов';
    if (e.kind === 'error') return `застряла: ${reasonRu(b)}`;
    if (e.kind === 'report') return 'отдел отчитался';
    if (e.kind === 'approval') {
      if (/executed/.test(b)) return 'вы одобрили';
      if (/rejected/.test(b)) return 'вы отклонили';
      if (/sent to the owner/.test(b)) return 'прислала вам карточку на одобрение';
      if (/failed/.test(b)) return 'одобренное не удалось выполнить';
      return 'ждёт вас в /approve';
    }
    if (e.kind !== 'status') return null;
    if (/^created/.test(b)) return 'создана';
    if (/claimed|-> running/.test(b)) return 'взята в работу';
    if (/-> approval/.test(b)) return 'ждёт вас в /approve';
    if (/-> review/.test(b)) return 'на проверке';
    if (/-> done/.test(b)) return 'выполнена';
    if (/-> blocked/.test(b)) return null; // the error entry before it says why
    if (/-> rejected/.test(b)) return 'отклонена';
    if (/-> inbox/.test(b)) return 'поставлена в очередь заново';
    return null;
  }

  private hm(at: number): string {
    const p = zonedParts(at, this.hq.tz);
    return `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
  }

  private nextRoutine(): string | null {
    const now = this.hq.now();
    let best: { at: number; title: string; dept: string } | null = null;
    for (const r of this.hq.routines().filter((x) => x.enabled)) {
      let at: number | undefined;
      try {
        at = new Cron(r.cron, { timezone: this.hq.tz, paused: true }).nextRun(new Date(now))?.getTime();
      } catch {
        at = undefined;
      }
      if (at !== undefined && (!best || at < best.at)) best = { at, title: r.title, dept: r.dept };
    }
    if (!best) return null;
    const p = zonedParts(best.at, this.hq.tz);
    const today = zonedParts(now, this.hq.tz);
    const day = p.d === today.d && p.mo === today.mo ? '' : `${String(p.d).padStart(2, '0')}.${String(p.mo).padStart(2, '0')} `;
    return `${day}${this.hm(best.at)}, ${deptRu(best.dept)}: ${oneLine(best.title, 60)}`;
  }

  statusText(): string {
    const hq = this.hq;
    const open = hq.tasks({ open: true, limit: 1000 }).filter((t) => !t.tags.includes('drill'));
    const lines = hq.departments().map((dept) => {
      const mine = open.filter((t) => t.dept === dept);
      const head = hq.headOf(dept);
      const work = mine.filter((t) => ['inbox', 'assigned', 'running', 'review'].includes(t.status)).length;
      const you = mine.filter((t) => t.status === 'approval').length;
      const stuck = mine.filter((t) => t.status === 'blocked').length;
      return `${deptRu(dept)}${head?.status === 'paused' ? ' (пауза)' : ''}: работает ${work} · ждут вас ${you} · застряли ${stuck}`;
    });
    const out = [`Сейчас в офисе:\n${lines.join('\n') || 'отделов пока нет'}`];
    const events = hq.recentEvents(40).map((e) => ({ e, w: this.eventWords(e) })).filter((x) => x.w).slice(0, 3);
    if (events.length) out.push(`Последнее:\n${events.map(({ e, w }) => `• ${this.hm(e.at)} #${e.taskId} ${deptRu(e.dept)}: ${w}`).join('\n')}`);
    const next = this.nextRoutine();
    if (next) out.push(`Дальше по расписанию: ${next}.`);
    const waiting = hq.queuedApprovals().length + this.d.queue.pending().length;
    out.push(waiting ? `Ждёт вашего решения: ${waiting}, откройте /approve.` : 'Ничего не ждёт вашего решения.');
    out.push(`Расходы за месяц: ${this.costLine()}`);
    return out.join('\n\n');
  }

  /** The task's last event in words: «ждёт вас в /approve», «застряла: причина». */
  private taskWords(t: Task): string {
    switch (t.status) {
      case 'inbox': case 'assigned': return 'ждёт, пока голова отдела её возьмёт';
      case 'running': return 'в работе';
      case 'review': return 'на проверке';
      case 'approval': return 'ждёт вас в /approve';
      case 'blocked': return t.tags.includes('builder') ? 'у строителей (/builders)' : `застряла: ${reasonRu(lastReason(this.hq, t))} (повторить: /retry ${t.id})`;
      default: return STATUS_RU[t.status] ?? t.status;
    }
  }

  tasksText(dept?: string): string {
    if (dept && !this.hq.departments().includes(dept)) return `Нет отдела «${dept}». Есть: ${this.hq.departments().join(', ')}.`;
    const tasks = this.hq.tasks({ ...(dept ? { dept } : {}), open: true, limit: 50 }).filter((t) => !t.tags.includes('drill')).slice(0, 20);
    if (!tasks.length) return dept ? `В отделе ${deptRu(dept)} открытых задач нет.` : 'Открытых задач нет.';
    return tasks.map((t: Task) => `#${t.id} ${deptRu(t.dept)}: ${oneLine(t.title, 70)}\n  ${this.taskWords(t)}`).join('\n');
  }

  buildersText(): string {
    const tasks = openBuilderTasks(this.hq);
    if (!tasks.length) return 'Открытых задач для строителей нет.';
    return tasks
      .slice(0, 30)
      .map((t) => {
        const issue = t.meta.issue as { number?: number; url?: string } | undefined;
        return `#${t.id} [${t.status}] ${t.dept}: ${oneLine(t.title, 80)}${issue?.url ? `\n  issue #${issue.number}: ${issue.url}` : '\n  issue ещё не создан'}`;
      })
      .join('\n');
  }

  private costLine(): string {
    const since = this.hq.monthStart();
    const rows = this.hq.costSummary(since);
    return rows.length ? rows.map((r) => `${r.dept} ${money(r.usd)}`).join(', ') : '$0.00';
  }

  costsText(): string {
    const hq = this.hq;
    const rows = hq.costSummary(hq.monthStart());
    const lines = hq.departments().map((dept) => {
      const r = rows.find((x) => x.dept === dept);
      const limit = hq.deptBudget(dept);
      return `${dept}: ${money(r?.usd ?? 0)}${limit > 0 ? ` из ${money(limit)}` : ' (без лимита)'}, токенов ${(r?.inputTokens ?? 0) + (r?.outputTokens ?? 0)}`;
    });
    return `Расходы за месяц (токены оценочные, бесплатные модели $0):\n${lines.join('\n') || 'нет данных'}`;
  }

  orgText(): string {
    return this.hq
      .agents()
      .map((a) => `${a.dept}/${a.id}: ${a.title}, ${ruRole[a.role]}${a.status === 'paused' ? ', пауза' : ''}${a.bossId ? `, подчинён ${a.bossId}` : ''}${a.role !== 'worker' ? `, доверие ${a.trustLevel}` : ''}`)
      .join('\n');
  }
}

/** Adds a rule line under "## Правила владельца" (created when missing); never rewrites the rest of the instructions. */
export function appendRule(instructions: string, rule: string): string {
  const heading = '## Правила владельца';
  const line = `- ${rule}`;
  if (!instructions.includes(heading)) return `${instructions.trimEnd()}\n\n${heading}\n${line}\n`;
  const [before, after = ''] = instructions.split(heading) as [string, string?];
  const next = /\n## /.exec(after);
  const body = next ? after.slice(0, next.index) : after;
  const rest = next ? after.slice(next.index) : '';
  return `${before}${heading}${body.trimEnd()}\n${line}\n${rest ? `\n${rest.trimStart()}` : ''}`;
}
