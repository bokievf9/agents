import { Cron } from 'croner';
import { errMsg, escapeHtml, log, schedule, stripHtml, tryJson, zonedParts, zonedToMs, type ApprovalQueue, type Button, type LlmClient, type Messenger } from '@fir/core';
import { meterLlm, type Hq, type Task } from '@fir/hq';
import { z } from 'zod';
import { dailyCron, weeklyCron } from './config.js';
import { helpHtml } from './commands.js';
import { workersText } from './workers.js';
import type { ApprovalEditor } from './editor.js';
import type { Reporter } from './reporter.js';
import { openBuilderTasks } from './bridge.js';
import { Progress, deptRu, lastReason, reasonRu } from './progress.js';
import { OwnerChannel, type InboxKind } from './presence.js';
import { KEYBOARD, approvalCardFormat, bold, cb, clip, code, esc, menuCommand, parseNav, type Nav } from './tg.js';

/** Tasks per page of the /tasks list. */
export const TASKS_PAGE = 10;
const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10;
  const m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};
const proposals = (n: number) => `${n} ${plural(n, 'предложение', 'предложения', 'предложений')}`;

/** Where a button was pressed: the message to edit in place. */
export interface ButtonAt {
  chatId: number;
  messageId: number;
}

const DAY = 86_400_000;
const HM = /^([01]?\d|2[0-3]):[0-5]\d$/;

/** The settings the owner may change by chat, with their validators. Anything else is refused. */
const validZone = (v: string) => { try { new Intl.DateTimeFormat('en-US', { timeZone: v }); return true; } catch { return false; } };
const SETTING_RULES: Record<string, { label: string; valid: (v: string) => boolean }> = {
  tz: { label: 'часовой пояс компании: рынок, клиенты, публикации (сейчас Душанбе)', valid: validZone },
  owner_tz: { label: 'ваш часовой пояс: сводка, пачка, дайджест, тихие часы (сейчас Куала-Лумпур)', valid: validZone },
  summary_time: { label: 'время утренней сводки, ваше время', valid: (v) => HM.test(v) },
  approval_time: { label: 'время пачки на одобрение, ваше время', valid: (v) => HM.test(v) },
  digest_time: { label: 'время недельного дайджеста по понедельникам, ваше время', valid: (v) => HM.test(v) },
  quiet_hours: { label: 'тихие часы, ваше время (алерты копятся до сводки)', valid: (v) => v === '' || /^([01]?\d|2[0-3]):[0-5]\d-([01]?\d|2[0-3]):[0-5]\d$/.test(v) },
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
/** The cheat sheet of /help, Telegram HTML, made from the one command list (`commands.ts`; the full page: apps/hq/docs/owner-cheatsheet.md). */
export const HELP = helpHtml();
export const WELCOME = [
  '👋 <b>Директор Fir Tech</b>',
  'Пишите задачу обычным текстом: я передам её отделу и покажу ход работы в одном сообщении.',
  'Кнопки внизу: одобрения, задачи, статус, отделы, помощь. Все команды: кнопка «Меню» слева от поля ввода.',
].join('\n');
const HINT = 'Кнопки внизу: одобрения, задачи, статус. Или опишите задачу и отдел обычным текстом. Все команды: /help.';
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
  /** Set by the Marketing head: the buttons of a weekly pack's card (`pk:<id>:o` opens the items one by one, `v` sends previews). Returns the toast. */
  onPackButton: ((op: 'o' | 'v', approvalId: number, at: ButtonAt) => Promise<string>) | null = null;
  /** Set by the app: a clock or a time setting changed, so the routines and the heads' own crons must restart on the new clock. */
  onTimingChange: (() => void) | null = null;
  /** Set by the builder bridge: a builder task was just created, make its issue now instead of at the next poll. */
  onBuilderTask: (() => Promise<unknown>) | null = null;
  /** Set by the drill: `/drill [dept|report|clear]`. Returns the reply. */
  onDrillCommand: ((arg: string) => Promise<string>) | null = null;
  /** Commands of the Production and Back Office heads (`/project`, `/doc`...): name -> handler returning the reply. */
  readonly commands = new Map<string, { dept: 'production' | 'backoffice' | 'marketing'; run: (arg: string) => Promise<string> }>();
  /** Extra lines of the morning summary from heads (overdue milestones, pending documents); null: nothing to say. */
  readonly summaryLines: (() => string | null)[] = [];
  private jobs: Cron[] = [];
  private readonly llm: LlmClient;
  /** Set when the messenger is the owner channel: presence routing, the inbox and the website scopes. */
  readonly channel: OwnerChannel | null;
  /** The «live message» of the owner's tasks: one message, edited as the task moves. */
  readonly progress: Progress;

  constructor(private readonly d: DirectorDeps) {
    this.llm = meterLlm(d.llm, d.hq, { agentId: 'director' });
    this.channel = d.messenger instanceof OwnerChannel ? d.messenger : null;
    this.progress = new Progress({ hq: d.hq, messenger: d.messenger, ownerId: d.ownerId, ...(this.channel ? { channel: this.channel } : {}) });
    d.hq.onAlert((text) => this.alertOwner(text));
    d.queue.setCardFormat(approvalCardFormat(d.hq, this.editors));
  }

  private get hq(): Hq {
    return this.d.hq;
  }

  /** The last message sent by `say` (a command reply can become the live message of the task it created). */
  private lastSay: { id: number; text: string } | null = null;

  /** A plain text to the owner (escaped, sent as HTML like everything the Director writes). */
  private async say(text: string, buttons?: Button[][], kind?: InboxKind, force = false): Promise<void> {
    await this.sayHtml(escapeHtml(text), { ...(buttons ? { buttons } : {}), ...(kind ? { kind } : {}), force });
  }

  /** Telegram HTML to the owner, through the owner channel when there is one. Returns the Telegram message id (0: none). */
  private async sayHtml(html: string, o: { buttons?: Button[][]; kind?: InboxKind; force?: boolean; keyboard?: boolean } = {}): Promise<number> {
    const keyboard = o.keyboard && !o.buttons ? { keyboard: KEYBOARD } : {};
    const id = this.channel
      ? await this.channel.notify(o.kind, html, { ...(o.buttons ? { buttons: o.buttons } : {}), ...(o.force ? { force: true } : {}), html: true, ...keyboard })
      : await this.d.messenger.sendMessage(this.d.ownerId, html, o.buttons, { html: true, ...keyboard });
    // id 0: nothing went to Telegram (inbox only or captured for the website), so there is no message to turn into a live one
    this.lastSay = id > 0 ? { id, text: stripHtml(html) } : null;
    return id;
  }

  /** Edits the message a button was on (HTML, the new buttons or none). */
  private async editAt(at: ButtonAt, html: string, buttons?: Button[][]): Promise<void> {
    await this.d.messenger.edit(at.chatId, at.messageId, html, { html: true, ...(buttons ? { buttons } : {}) });
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
  /** The Director's own cron jobs and the clock each runs on: everything addressed to the owner is on HIS clock (`owner_tz`), not the company's. */
  schedulePlan(): { name: string; cron: string; tz: string }[] {
    const tz = this.hq.ownerTz;
    return [
      { name: 'director-summary', cron: dailyCron(this.hq.setting('summary_time')), tz },
      { name: 'director-approvals', cron: dailyCron(this.hq.setting('approval_time')), tz },
      { name: 'director-digest', cron: weeklyCron(this.hq.setting('digest_time'), 1), tz },
    ];
  }

  start(): void {
    this.stop();
    this.progress.start();
    const jobs: Record<string, () => Promise<unknown>> = {
      'director-summary': () => this.sendMorningSummary(),
      'director-approvals': () => this.sendApprovalBatch(false),
      'director-digest': () => this.sendWeeklyDigest(),
    };
    this.jobs = this.schedulePlan().map((p) => schedule(p.name, p.cron, p.tz, async () => void (await jobs[p.name]!())));
  }

  stop(): void {
    this.progress.stop();
    for (const j of this.jobs) j.stop();
    this.jobs = [];
  }

  // ---- the three things the Director writes by itself ----
  async sendMorningSummary(): Promise<void> {
    const text = this.morningSummary();
    await this.say(text, undefined, 'summary');
    await this.d.reporter?.post('general', text);
    this.hq.setSetting('held_alerts', '[]');
  }

  /** Monday's digest: the week in numbers and what each department reported. Not held by quiet hours (it comes at 08:30 on his clock). */
  async sendWeeklyDigest(): Promise<void> {
    const text = this.weeklyDigest();
    await this.say(text, undefined, 'summary');
    await this.d.reporter?.post('general', text);
  }

  weeklyDigest(): string {
    const hq = this.hq;
    const now = hq.now();
    const since = now - 7 * DAY;
    const day = (at: number) => {
      const p = zonedParts(at, hq.ownerTz);
      return `${String(p.d).padStart(2, '0')}.${String(p.mo).padStart(2, '0')}`;
    };
    const count = (sql: string, ...args: unknown[]): number => {
      try {
        return (hq.db.prepare(sql).get(...args) as { c: number | null } | undefined)?.c ?? 0;
      } catch {
        return 0; // a worker table that does not exist yet counts as empty
      }
    };
    const out: string[] = [`Недельный дайджест, ${day(since)}-${day(now)}`];
    const done = hq.db.prepare("SELECT dept, COUNT(*) c FROM tasks WHERE status = 'done' AND updated_at >= ? AND (',' || tags || ',') NOT LIKE '%,drill,%' GROUP BY dept ORDER BY dept").all(since) as { dept: string; c: number }[];
    out.push(done.length ? `Задач выполнено: ${done.map((r) => `${deptRu(r.dept)} ${r.c}`).join(', ')}.` : 'Выполненных задач за неделю нет.');
    const approved = count("SELECT COUNT(*) c FROM decisions WHERE decision IN ('approve','auto') AND at >= ?", since);
    const rejected = count("SELECT COUNT(*) c FROM decisions WHERE decision = 'reject' AND at >= ?", since);
    const waiting = hq.queuedApprovals().length + hq.heldApprovals().length + this.d.queue.pending().length;
    out.push(`Одобрения: одобрено ${approved}, отклонено ${rejected}, ждёт вас ${waiting}.`);
    const leads = count('SELECT COUNT(*) c FROM li_leads WHERE created_at >= ?', since);
    const lost = count("SELECT COUNT(*) c FROM activity WHERE action = 'lost_lead' AND at >= ?", since);
    out.push(`Лидов за неделю: ${leads}${lost ? `, не доставлено владельцу: ${lost} (см. алерты)` : ''}.`);
    const revenue = count("SELECT COALESCE(SUM(amount_usd), 0) c FROM bl_invoices WHERE status = 'paid' AND paid_at >= ?", since);
    out.push(`Оплаты за неделю: ${money(revenue)}.`);
    const spend = hq.costSummary(since);
    out.push(spend.length ? `Расходы на модели: ${spend.map((r) => `${r.dept} ${money(r.usd)}`).join(', ')}.` : 'Расходов на модели за неделю нет.');
    const reports = hq.reports(since);
    if (reports.length) {
      const last = new Map<string, string>();
      for (const r of reports) last.set(r.dept, oneLine(r.body, 500));
      out.push(`Что писали отделы (последний отчёт):\n${[...last].map(([dept, body]) => `- ${deptRu(dept)}: ${body}`).join('\n')}`);
    }
    const blocked = hq.tasks({ status: 'blocked', limit: 30 }).filter((t) => !t.tags.includes('drill')).slice(0, 8);
    if (blocked.length) out.push(`Застряло:\n${blocked.map((t) => `- #${t.id} ${deptRu(t.dept)}: ${oneLine(t.title, 80)}`).join('\n')}`);
    return out.join('\n\n');
  }

  morningSummary(): string {
    const hq = this.hq;
    const p = zonedParts(hq.now(), hq.ownerTz);
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

  /**
   * The batch: a header «Пачка на одобрение: N» with «✅ Одобрить все обычные» and «⏭ Позже», then one card per proposal
   * (every department, one numbered series). `manual`: say so when there is nothing new.
   */
  async sendApprovalBatch(manual: boolean): Promise<number> {
    const resent = manual ? (await this.channel?.resendUndelivered()) ?? 0 : 0;
    const queued = this.hq.queuedApprovals();
    // the header with «Одобрить все обычные» only when there are at least two ordinary cards to approve at once
    const ordinary = queued.filter((l) => this.d.queue.isBulk(l.kind)).length;
    if (queued.length > 0 && ordinary >= 2) {
      await this.sayHtml(
        `Пачка на одобрение: ${proposals(queued.length)}. Карточки ниже, у каждой кнопки.\n<i>«Одобрить все обычные» берёт контент (пакеты недели и отдельные материалы) и не трогает деньги, цены, документы и ответы клиентам: их по одной.</i>`,
        { buttons: [[{ text: '✅ Одобрить все обычные', data: 'ap:all' }, { text: '⏭ Позже', data: 'ap:later' }]] },
      );
    }
    const n = await this.hq.releaseApprovals();
    if (n > 0 && ordinary < 2) await this.say(`Пачка на одобрение: ${proposals(n)}, карточки выше. Решаются по одной.`);
    if (n === 0 && manual && resent > 0) await this.say(`Карточки, которые копились на сайте: ${resent}, они выше.`);
    else if (n === 0 && manual) {
      const old = this.d.queue.pending().length;
      if (old) {
        await this.say(`Новых предложений нет. Ждут вашего решения ранее присланные: ${old}.`, [[
          { text: '📥 Показать снова', data: 'ap:show' }, { text: '✅ Одобрить все обычные', data: 'ap:all' },
        ]]);
      } else await this.say('Нечего одобрять.');
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
    await this.say(`Алерт: ${text}`, undefined, 'alert');
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
      case 'desk':
      case 'away': {
        if (!this.channel) return this.say('Режим присутствия не подключён.');
        await this.channel.setMode(name);
        return this.say(
          name === 'desk'
            ? `Вы за столом: сообщения копятся на сайте firtech.pro/admin, в Telegram не шлю (если сайт молчит ${this.channel.awayAfterMin} минут, вернусь в Telegram сам). /away вернёт всё в Telegram.`
            : 'Вы в пути: всё, что требует вас, шлю в Telegram. /desk переключит на сайт.',
          undefined, 'message', true,
        );
      }
      case 'start':
        await this.sayHtml(WELCOME, { keyboard: true });
        return;
      case 'help':
        await this.sayHtml(HELP, { keyboard: true });
        return;
      case 'status':
        return this.sendStatus();
      case 'tasks':
        return this.sendTasks(dept || undefined);
      case 'depts': {
        const v = this.deptsView();
        await this.sayHtml(v.text, { buttons: v.buttons });
        return;
      }
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
      case 'level':
        return this.say(this.levelCommand(arg));
      case 'workers':
        return this.say(workersText(this.hq));
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
        return this.hint(`Не знаю команды /${name}.`);
      }
    }
  }

  /** Unknown input: a short hint and the reply keyboard, never silence. */
  async hint(lead = 'Не понял.'): Promise<void> {
    await this.sayHtml(`${esc(lead)} ${esc(HINT)}`, { keyboard: true });
  }

  /** A command of a head by name, only if registered for this department: the model's word is never a command by itself. */
  private async headCommand(dept: 'production' | 'backoffice', command: string, arg: string): Promise<void> {
    const handler = this.commands.get(command.replace(/^\//, '').toLowerCase());
    if (!handler || handler.dept !== dept) return this.say(`Не знаю такой команды отдела. Есть: ${[...this.commands].filter(([, h]) => h.dept === dept).map(([n]) => `/${n}`).join(', ') || 'нет'}.`);
    return this.say(await handler.run(arg));
  }

  async onText(text: string): Promise<void> {
    const menu = menuCommand(text);
    if (menu) return this.onCommand(menu, '');
    for (const e of this.editors.values()) if (await e.consume(text)) return;
    const before = this.lastTaskId();
    this.lastSay = null;
    await this.handleText(text);
    await this.trackNew(before);
  }

  private async handleText(text: string): Promise<void> {
    const intent = await this.parse(text);
    if (!intent) {
      await this.sayHtml(esc('Не смог разобрать сообщение (модель недоступна или ответила не по форме). Кнопки внизу или /help.'), { keyboard: true });
      return;
    }
    switch (intent.type) {
      case 'task':
        return this.createTask(intent);
      case 'status':
        return intent.dept ? this.sendTasks(intent.dept.toLowerCase()) : this.sendStatus();
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
        if (intent.question) return this.say(`Уточните: ${intent.question}`);
        return this.hint('Не понял, что нужно сделать.');
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
      dueAt = zonedToMs(y, m, d, 23, 59, this.hq.ownerTz); // the owner's own deadline, on his clock
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
        this.start(); // times or a clock may have changed
        this.onTimingChange?.(); // routines and the heads' crons run on these clocks too
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

  // ---- buttons: lists and cards edited in place ----
  /**
   * An inline button of the Director (`pg:`, `tk:`, `dp:`, `ap:all|later|show`, `ap:<id>:f|s`). Edits the message it was
   * on and returns the callback toast; null when the data is not the Director's (the next handler answers it).
   */
  async onButton(data: string, at: ButtonAt): Promise<string | null> {
    const nav = parseNav(data);
    if (!nav) return null;
    try {
      return await this.navigate(nav, at);
    } catch (e) {
      log('warn', 'button failed', { ns: nav.ns, err: errMsg(e) });
      return 'Не получилось, попробуйте ещё раз';
    }
  }

  private async navigate(nav: Nav, at: ButtonAt): Promise<string> {
    switch (nav.ns) {
      case 'pg': {
        if (nav.filter !== 'all' && !this.hq.departments().includes(nav.filter)) return 'Устарело';
        const v = this.tasksView(nav.filter, nav.page);
        await this.editAt(at, v.text, v.buttons);
        return v.pages > 1 ? `Стр. ${v.page + 1} из ${v.pages}` : 'Задачи';
      }
      case 'tk':
        return this.taskButton(nav, at);
      case 'dp': {
        if (nav.op === 'list' || !nav.dept) {
          const v = this.deptsView();
          await this.editAt(at, v.text, v.buttons);
          return 'Отделы';
        }
        if (!this.hq.departments().includes(nav.dept)) return 'Устарело';
        let toast = deptRu(nav.dept);
        if (nav.op === 'p' || nav.op === 'r') {
          this.hq.setDeptStatus(nav.dept, nav.op === 'p' ? 'paused' : 'active');
          toast = nav.op === 'p' ? '⏸ На паузе' : '▶ Снова работает';
        }
        const v = this.deptCard(nav.dept);
        await this.editAt(at, v.text, v.buttons);
        return toast;
      }
      case 'ap':
        return this.approvalButton(nav, at);
      case 'pk':
        return this.onPackButton ? this.onPackButton(nav.op, nav.id, at) : 'Устарело';
    }
  }

  private async approvalButton(nav: Extract<Nav, { ns: 'ap' }>, at: ButtonAt): Promise<string> {
    const q = this.d.queue;
    if (nav.op === 'full' || nav.op === 'short') return q.expandCard(nav.id!, nav.op === 'full', at);
    if (nav.op === 'later') {
      const n = q.pending().length;
      await this.editAt(at, n ? `⏭ ${bold('Отложено')}: ждут решения ${proposals(n)}. Кнопка «📥 Одобрения» покажет их снова.` : 'Нечего одобрять.');
      return 'Позже';
    }
    if (nav.op === 'show') {
      const rows = q.pending();
      if (!rows.length) {
        await this.editAt(at, 'Нечего одобрять.');
        return 'Устарело';
      }
      await this.editAt(at, `📥 ${bold('Ждут решения')}: ${proposals(rows.length)}, карточки ниже.`, [[{ text: '✅ Одобрить все обычные', data: 'ap:all' }]]);
      for (const r of rows) await q.showCard(r.id);
      return 'Карточки ниже';
    }
    // approve every ordinary one
    const r = await q.approveAll(this.d.ownerId);
    this.afterDecision();
    if (r.approved + r.failed === 0) {
      await this.editAt(at, r.skipped ? `Обычных нет: ${proposals(r.skipped)} решаются по одной (цены, деньги, особые карточки).` : 'Нечего одобрять.');
      return r.skipped ? 'Только по одной' : 'Устарело';
    }
    const lines = [`✅ ${bold('Одобрено')}: ${code(r.approved)}`];
    if (r.failed) lines.push(`⚠️ Не выполнено: ${code(r.failed)} (подробности в логе)`);
    if (r.skipped) lines.push(`По одной осталось: ${code(r.skipped)} (цены, деньги, особые карточки), их карточки выше.`);
    await this.editAt(at, lines.join('\n'));
    return `Одобрено: ${r.approved}`;
  }

  async sendStatus(): Promise<void> {
    const v = this.statusView();
    await this.sayHtml(v.text, { buttons: v.buttons });
  }

  async sendTasks(dept?: string): Promise<void> {
    if (dept && !this.hq.departments().includes(dept)) return this.say(`Нет отдела «${dept}». Есть: ${this.hq.departments().join(', ')}.`);
    const v = this.tasksView(dept ?? 'all', 0);
    await this.sayHtml(v.text, { buttons: v.buttons });
  }

  private openTasks(dept?: string): Task[] {
    return this.hq.tasks({ ...(dept ? { dept } : {}), open: true, limit: 1000 }).filter((t) => !t.tags.includes('drill'));
  }

  private counts(dept: string, open: Task[]): { work: number; you: number; stuck: number } {
    const mine = open.filter((t) => t.dept === dept);
    return {
      work: mine.filter((t) => ['inbox', 'assigned', 'running', 'review'].includes(t.status)).length,
      you: mine.filter((t) => t.status === 'approval').length,
      stuck: mine.filter((t) => t.status === 'blocked').length,
    };
  }

  /** `/status`: the summary with a button per department (its tasks), «Отделы» and the approvals when something waits. */
  statusView(): { text: string; buttons: Button[][] } {
    const html = esc(this.statusText())
      .replace(/^Сейчас в офисе:/, `📊 ${bold('Сейчас в офисе:')}`)
      .replace(/\nПоследнее:/, `\n${bold('Последнее:')}`);
    const open = this.openTasks();
    const depts = this.hq.departments().map((dept) => {
      const n = open.filter((t) => t.dept === dept).length;
      return { text: `${deptRu(dept)} · ${n}`, data: cb.page(dept, 0) };
    });
    const buttons: Button[][] = [];
    for (let i = 0; i < depts.length; i += 3) buttons.push(depts.slice(i, i + 3));
    const waiting = this.hq.queuedApprovals().length + this.d.queue.pending().length;
    buttons.push([{ text: '🏢 Отделы', data: cb.depts }, ...(waiting ? [{ text: `📥 Одобрения · ${waiting}`, data: 'ap:show' }] : [])]);
    return { text: html, buttons };
  }

  /** `/tasks`: 10 per page, a filter row of departments on top, a `#id` button per task, ◀ ▶ under it. */
  tasksView(filter: string, page: number): { text: string; buttons: Button[][]; page: number; pages: number } {
    const dept = filter === 'all' ? undefined : filter;
    const tasks = this.openTasks(dept);
    const pages = Math.max(1, Math.ceil(tasks.length / TASKS_PAGE));
    const p = Math.min(Math.max(0, page), pages - 1);
    const slice = tasks.slice(p * TASKS_PAGE, (p + 1) * TASKS_PAGE);
    const head = `📋 ${bold('Открытые задачи')} · ${esc(dept ? deptRu(dept) : 'все отделы')} · ${code(tasks.length)}`;
    const body = slice.length
      ? slice.map((t) => `${code(`#${t.id}`)} ${dept ? '' : `${esc(deptRu(t.dept))}: `}${esc(clip(t.title, 60))}\n  <i>${esc(this.taskWords(t))}</i>`).join('\n')
      : esc(dept ? `В отделе ${deptRu(dept)} открытых задач нет.` : 'Открытых задач нет.');
    const filters = [{ text: filter === 'all' ? '• Все' : 'Все', data: cb.page('all', 0) }, ...this.hq.departments().map((d) => ({ text: `${d === filter ? '• ' : ''}${deptRu(d)}`, data: cb.page(d, 0) }))];
    const buttons: Button[][] = [];
    for (let i = 0; i < filters.length; i += 3) buttons.push(filters.slice(i, i + 3));
    for (let i = 0; i < slice.length; i += 5) buttons.push(slice.slice(i, i + 5).map((t) => ({ text: `#${t.id}`, data: cb.task(t.id, 'o', filter, p) })));
    if (pages > 1) {
      buttons.push([
        { text: '◀', data: cb.page(filter, p > 0 ? p - 1 : pages - 1) },
        { text: `${p + 1} / ${pages}`, data: cb.page(filter, p) },
        { text: '▶', data: cb.page(filter, p < pages - 1 ? p + 1 : 0) },
      ]);
    }
    return { text: `${head}${pages > 1 ? ` · стр. ${p + 1}/${pages}` : ''}\n\n${body}`, buttons, page: p, pages };
  }

  private async taskButton(nav: Extract<Nav, { ns: 'tk' }>, at: ButtonAt): Promise<string> {
    const t = this.hq.task(nav.id);
    if (!t) return 'Устарело';
    const back = { filter: nav.filter, page: nav.page };
    let toast = `Задача #${t.id}`;
    let extra = '';
    if (nav.op === 'j') {
      const v = this.journalView(t, back);
      await this.editAt(at, v.text, v.buttons);
      return 'Журнал';
    }
    if (nav.op === 'r') {
      if (t.status !== 'blocked' || t.tags.includes('builder') || t.tags.includes('drill')) toast = 'Повторять нечего';
      else {
        const head = this.hq.headOf(t.dept);
        if (!head) toast = 'У отдела нет головы';
        else {
          this.hq.requeue(t.id, 'owner');
          this.hq.wake(head.id, 'task');
          toast = '🔁 Снова в очереди';
          extra = `🔁 Поставил заново в очередь отдела ${deptRu(t.dept)}.`;
        }
      }
    }
    if (nav.op === 'x') {
      if (t.status === 'done' || t.status === 'rejected') toast = 'Задача уже закрыта';
      else {
        const v = this.taskCard(t, back);
        await this.editAt(at, `${v.text}\n\n❓ ${bold('Отклонить задачу?')} Отдел перестанет над ней работать, её карточки на одобрение тоже отклоню.`, [[
          { text: '❌ Да, отклонить', data: cb.task(t.id, 'X', nav.filter, nav.page) },
          { text: '◀ Нет', data: cb.task(t.id, 'o', nav.filter, nav.page) },
        ]]);
        return 'Подтвердите';
      }
    }
    if (nav.op === 'X') {
      if (t.status === 'done' || t.status === 'rejected') toast = 'Задача уже закрыта';
      else {
        await this.rejectTask(t);
        toast = '❌ Отклонена';
        extra = '❌ Вы отклонили задачу.';
      }
    }
    const fresh = this.hq.task(t.id)!;
    const v = this.taskCard(fresh, back);
    await this.editAt(at, extra ? `${v.text}\n\n${esc(extra)}` : v.text, v.buttons);
    return toast;
  }

  /** The owner rejects a task: its pending proposals are rejected, queued ones dropped, the task closed. */
  private async rejectTask(t: Task): Promise<void> {
    const links = this.hq.db.prepare("SELECT id, approval_id, state, held FROM task_approvals WHERE task_id = ? AND state IN ('queued','asked')").all(t.id) as { id: number; approval_id: number | null; state: string; held: number }[];
    for (const l of links) {
      if (l.held === 1) this.hq.rejectHeld(l.id);
      else if (l.state === 'asked' && l.approval_id !== null) {
        await this.d.queue.handle('reject', l.approval_id, this.d.ownerId);
        await this.d.queue.settleCard(l.approval_id).catch(() => false);
      } else this.hq.db.prepare("UPDATE task_approvals SET state = 'rejected' WHERE id = ?").run(l.id);
    }
    this.afterDecision();
    const fresh = this.hq.task(t.id);
    if (fresh && fresh.status !== 'done' && fresh.status !== 'rejected') this.hq.setStatus(t.id, 'rejected', 'owner', 'отклонена владельцем');
    this.hq.log('owner', 'rejected', 'task', String(t.id));
  }

  /** A task card: title, department, status in words, assignee, progress line, last event; actions by status. */
  taskCard(t: Task, back: { filter: string; page: number } = { filter: 'all', page: 0 }): { text: string; buttons: Button[][] } {
    const assignee = t.assigneeId ? this.hq.agent(t.assigneeId)?.title ?? t.assigneeId : this.hq.headOf(t.dept)?.title ?? 'голова отдела';
    const progressLine = this.progress.render(t).split('\n').slice(1).join('\n');
    const last = this.hq.events(t.id).map((e) => ({ e, w: this.eventWords(e) })).filter((x) => x.w).at(-1);
    const lines = [
      `📌 ${bold(`#${t.id} · ${deptRu(t.dept)}`)}`,
      esc(`«${clip(t.title, 200)}»`),
      '',
      `Статус: ${bold(STATUS_RU[t.status] ?? t.status)}`,
      `Исполнитель: ${esc(assignee)}`,
    ];
    if (progressLine) lines.push(`Ход: ${esc(progressLine)}`);
    if (last) lines.push(`Последнее: ${code(this.hm(last.e.at))} ${esc(last.w!)}`);
    const open = t.status !== 'done' && t.status !== 'rejected';
    const row: Button[] = [];
    if (t.status === 'blocked' && !t.tags.includes('builder') && !t.tags.includes('drill')) row.push({ text: '🔁 Повторить', data: cb.task(t.id, 'r', back.filter, back.page) });
    if (open) row.push({ text: '❌ Отклонить', data: cb.task(t.id, 'x', back.filter, back.page) });
    const buttons: Button[][] = [];
    if (row.length) buttons.push(row);
    buttons.push([{ text: '📜 Журнал', data: cb.task(t.id, 'j', back.filter, back.page) }, { text: '◀ Назад', data: cb.page(back.filter, back.page) }]);
    return { text: lines.join('\n'), buttons };
  }

  /** The last 8 journal entries of a task, in words. */
  journalView(t: Task, back: { filter: string; page: number }): { text: string; buttons: Button[][] } {
    const rows = this.hq.events(t.id).map((e) => ({ e, w: this.eventWords(e) ?? (e.kind === 'comment' ? `комментарий: ${clip(e.body, 80)}` : null) })).filter((x) => x.w).slice(-8);
    const body = rows.length ? rows.map(({ e, w }) => `${code(this.hm(e.at))} ${esc(w!)}`).join('\n') : 'Записей пока нет.';
    return {
      text: `📜 ${bold(`Журнал #${t.id}`)} · ${esc(clip(t.title, 60))}\n\n${body}`,
      buttons: [[{ text: '◀ К задаче', data: cb.task(t.id, 'o', back.filter, back.page) }, { text: '📋 К списку', data: cb.page(back.filter, back.page) }]],
    };
  }

  /** «🏢 Отделы»: one line per department, a button opens its card. */
  deptsView(): { text: string; buttons: Button[][] } {
    const open = this.openTasks();
    const lines = this.hq.departments().map((dept) => {
      const c = this.counts(dept, open);
      const paused = this.hq.headOf(dept)?.status === 'paused';
      return `${paused ? '⏸' : '▶'} ${bold(deptRu(dept))}: работает ${c.work} · ждут вас ${c.you} · застряли ${c.stuck}`;
    });
    const btns = this.hq.departments().map((d) => ({ text: deptRu(d), data: cb.dept(d) }));
    const buttons: Button[][] = [];
    for (let i = 0; i < btns.length; i += 3) buttons.push(btns.slice(i, i + 3));
    return { text: `🏢 ${bold('Отделы')}\n\n${lines.join('\n') || 'Отделов пока нет.'}`, buttons };
  }

  /** A department card: state, head, open tasks, month spend; pause or resume, its tasks, back. */
  deptCard(dept: string): { text: string; buttons: Button[][] } {
    const head = this.hq.headOf(dept);
    const paused = head?.status === 'paused';
    const c = this.counts(dept, this.openTasks());
    const spent = this.hq.costSummary(this.hq.monthStart()).find((r) => r.dept === dept)?.usd ?? 0;
    const limit = this.hq.deptBudget(dept);
    const text = [
      `🏢 ${bold(deptRu(dept))} · ${paused ? '⏸ на паузе' : '▶ работает'}`,
      `Голова: ${esc(head?.title ?? 'нет')} · исполнителей ${this.hq.agents(dept).filter((a) => a.role === 'worker').length}`,
      `Задачи: работает ${c.work} · ждут вас ${c.you} · застряли ${c.stuck}`,
      `Расходы за месяц: ${code(money(spent))}${limit > 0 ? ` из ${code(money(limit))}` : ' (без лимита)'}`,
      paused ? '<i>На паузе отдел не берёт новые задачи.</i>' : '',
    ].filter(Boolean).join('\n');
    return {
      text,
      buttons: [
        [paused ? { text: '▶ Возобновить', data: cb.dept(dept, 'r') } : { text: '⏸ Пауза', data: cb.dept(dept, 'p') }, { text: '📋 Задачи', data: cb.page(dept, 0) }],
        [{ text: '◀ Отделы', data: cb.depts }],
      ],
    };
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

  /** A time of day for the owner, on his clock. */
  private hm(at: number): string {
    const p = zonedParts(at, this.hq.ownerTz);
    return `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
  }

  private nextRoutine(): string | null {
    const now = this.hq.now();
    let best: { at: number; title: string; dept: string } | null = null;
    for (const r of this.hq.routines().filter((x) => x.enabled)) {
      let at: number | undefined;
      try {
        at = new Cron(r.cron, { timezone: this.hq.routineTz(r), paused: true }).nextRun(new Date(now))?.getTime();
      } catch {
        at = undefined;
      }
      if (at !== undefined && (!best || at < best.at)) best = { at, title: r.title, dept: r.dept };
    }
    if (!best) return null;
    const p = zonedParts(best.at, this.hq.ownerTz);
    const today = zonedParts(now, this.hq.ownerTz);
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

  /**
   * `/level` lists the trust levels; `/level <kind|agent> <0|1>` is the owner's own decision and writes the level the core
   * reads (0: every proposal waits for a button, 1: the agent acts and reports). A kind is changed as given (also a locked
   * one: that is the way to unlock it); an agent id moves every unlocked kind its department has proposed.
   */
  levelCommand(arg: string): string {
    const q = this.d.queue;
    const [target, lv] = arg.trim().split(/\s+/);
    if (!target) {
      const rows = q.trustTable().map((r) => `${r.kind}: уровень ${r.level}${r.locked ? ' (деньги/цены, замок)' : ''}, подряд ${r.streak}`);
      return `Уровни доверия (0: жду кнопку, 1: делаю сам и отчитываюсь):\n${rows.join('\n') || 'типов нет'}\nИзменить: /level <тип или агент> <0|1>`;
    }
    if (lv !== '0' && lv !== '1') return 'Укажите уровень 0 или 1: /level <тип или агент> <0|1>.';
    const level = lv === '1' ? 1 : 0;
    const kinds = q.trustTable();
    if (kinds.some((k) => k.kind === target)) {
      q.setLevel(target, level);
      this.hq.log('owner', 'level_set', 'kind', target, String(level));
      return level === 0 ? `Тип «${target}» на уровне 0: каждое предложение ждёт вашу кнопку.` : `Тип «${target}» на уровне 1: делаю сам и отчитываюсь. Вернуть: /level ${target} 0`;
    }
    const agent = this.hq.agent(target);
    if (!agent) return `Не знаю «${target}». Типы: ${kinds.map((k) => k.kind).join(', ') || 'нет'}; агенты: /org.`;
    const used = new Set((this.hq.db.prepare('SELECT DISTINCT kind FROM task_approvals WHERE dept = ?').all(agent.dept) as { kind: string }[]).map((r) => r.kind));
    const moved = kinds.filter((k) => used.has(k.kind) && !k.locked);
    for (const k of moved) q.setLevel(k.kind, level);
    this.hq.upsertAgent({ ...agent, trustLevel: level });
    this.hq.log('owner', 'level_set', 'agent', target, `${level}: ${moved.map((k) => k.kind).join(',')}`);
    return `${agent.id}: уровень ${level}${moved.length ? `, типы: ${moved.map((k) => k.kind).join(', ')}` : ' (у отдела пока нет типов, замки цен и денег не трогаю)'}.`;
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
