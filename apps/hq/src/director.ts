import { Cron } from 'croner';
import { errMsg, log, schedule, tryJson, zonedParts, zonedToMs, type ApprovalQueue, type LlmClient, type Messenger } from '@fir/core';
import { meterLlm, type Hq, type Task } from '@fir/hq';
import { z } from 'zod';
import { dailyCron } from './config.js';
import type { ApprovalEditor } from './editor.js';
import type { Reporter } from './reporter.js';

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
  private jobs: Cron[] = [];
  private readonly llm: LlmClient;

  constructor(private readonly d: DirectorDeps) {
    this.llm = meterLlm(d.llm, d.hq, { agentId: 'director' });
    d.hq.onAlert((text) => this.alertOwner(text));
  }

  private get hq(): Hq {
    return this.d.hq;
  }

  private say(text: string, buttons?: { text: string; data: string }[][]): Promise<void> {
    return this.d.messenger.send(this.d.ownerId, text, buttons);
  }

  // ---- scheduling ----
  start(): void {
    this.stop();
    const tz = this.hq.tz;
    this.jobs = [
      schedule('director-summary', dailyCron(this.hq.setting('summary_time')), tz, () => this.sendMorningSummary()),
      schedule('director-approvals', dailyCron(this.hq.setting('approval_time')), tz, async () => void (await this.sendApprovalBatch(false))),
    ];
  }

  stop(): void {
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
        ? `Отчёты отделов за сутки:\n${reports.map((r) => `- ${r.dept}: ${oneLine(r.body, 400)}`).join('\n')}`
        : 'Отчётов отделов за сутки нет.',
    );
    const queued = hq.queuedApprovals().length;
    const waiting = this.d.queue.pending().length;
    out.push(queued + waiting > 0 ? `Ждёт одобрения: ${queued + waiting} (в пачке в ${hq.setting('approval_time')} или /approve).` : 'На одобрении ничего нет.');
    const blocked = hq.tasks({ status: 'blocked', limit: 10 });
    if (blocked.length) out.push(`Заблокировано:\n${blocked.map((t) => `- #${t.id} ${t.dept}: ${oneLine(t.title, 80)}${t.tags.includes('builder') ? ' (нужен строитель)' : ''}`).join('\n')}`);
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
    const dept = arg.trim().toLowerCase();
    switch (name) {
      case 'start':
      case 'help':
        return this.say('Директор Fir Tech. Пишите задачи обычным текстом, я передам отделу.\n/status: сводка по отделам\n/tasks [отдел]: открытые задачи\n/approve: пачка на одобрение\n/costs: расходы за месяц\n/org: оргструктура\n/pause <отдел>, /resume <отдел>\n/reply <id>: бизнес ответил (продажи)\n/skip: отменить ожидание правки');
      case 'status':
        return this.say(this.statusText());
      case 'tasks':
        return this.say(this.tasksText(dept || undefined));
      case 'approve':
        await this.sendApprovalBatch(true);
        return;
      case 'costs':
        return this.say(this.costsText());
      case 'org':
        return this.say(this.orgText());
      case 'pause':
      case 'resume': {
        if (!this.hq.departments().includes(dept)) return this.say(`Укажите отдел: ${this.hq.departments().join(', ')}.`);
        this.hq.setDeptStatus(dept, name === 'pause' ? 'paused' : 'active');
        return this.say(name === 'pause' ? `Отдел ${dept} на паузе: новые задачи не берёт, повторные пробуждения не идут.` : `Отдел ${dept} снова работает.`);
      }
      case 'reply':
        return this.salesReply(Number(arg.trim().replace(/^#/, '')), undefined);
      case 'skip':
        for (const e of this.editors.values()) e.cancel();
        return this.say('Ок, ничего не жду.');
      default:
        return;
    }
  }

  async onText(text: string): Promise<void> {
    for (const e of this.editors.values()) if (await e.consume(text)) return;
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
{"type":"unknown","question":"<что переспросить>"}
Ответ: только JSON-объект.`;
    return tryJson(this.llm, { tier: 'haiku', system, messages: [{ role: 'user', content: text.slice(0, 3000) }], maxTokens: 500 }, intentSchema);
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
    return this.say(`Задача #${t.id} отделу ${dept}: «${oneLine(t.title, 100)}»${i.priority > 0 ? ', приоритет выше обычного' : ''}. Голова возьмёт её при ближайшем пробуждении (до 30 секунд).`);
  }

  private async salesReply(id: number, text: string | undefined): Promise<void> {
    if (!this.onSalesReply) return this.say('Отдел продаж не подключён.');
    if (!Number.isInteger(id) || id <= 0) return this.say('Формат: /reply <id>, номер из карточки (#12).');
    return this.say(await this.onSalesReply(id, text));
  }

  private async createBuilder(title: string, body: string): Promise<void> {
    const t = this.hq.createTask({ title, body, dept: 'hq', creator: 'owner', tags: ['builder'] });
    this.hq.block(t.id, 'director', 'Нужен строитель: задача для главного окна Claude Code', ['builder']);
    return this.say(`Записал для строителя (главное окно): #${t.id} «${oneLine(title, 100)}». Статус blocked, пометка builder.`);
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
  statusText(): string {
    const hq = this.hq;
    const lines = hq.departments().map((dept) => {
      const c = hq.countByStatus(dept);
      const head = hq.headOf(dept);
      const open = c.inbox + c.assigned + c.running + c.review;
      return `${dept}${head?.status === 'paused' ? ' (пауза)' : ''}: в работе ${open}, на одобрении ${c.approval}, заблокировано ${c.blocked}, готово ${c.done}`;
    });
    const waiting = hq.queuedApprovals().length + this.d.queue.pending().length;
    return [lines.length ? lines.join('\n') : 'Отделов пока нет.', `Ждёт одобрения: ${waiting}.`, `Расходы за месяц: ${this.costLine()}`].join('\n\n');
  }

  tasksText(dept?: string): string {
    if (dept && !this.hq.departments().includes(dept)) return `Нет отдела «${dept}». Есть: ${this.hq.departments().join(', ')}.`;
    const tasks = this.hq.tasks({ ...(dept ? { dept } : {}), open: true, limit: 20 });
    if (!tasks.length) return dept ? `В отделе ${dept} открытых задач нет.` : 'Открытых задач нет.';
    return tasks.map((t: Task) => `#${t.id} [${t.status}] ${t.dept}: ${oneLine(t.title, 90)}`).join('\n');
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
