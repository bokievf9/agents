import { errMsg, log, type Messenger } from '@fir/core';
import type { Hq, Task } from '@fir/hq';
import type { OwnerChannel } from './presence.js';

/** How often the tracker looks at its tasks, and the least time between two edits of one message. */
export const PROGRESS_TICK_MS = 5000;
const MIN_EDIT_MS = 5000;
/** Tracking stops after this long, whatever the task does. */
export const PROGRESS_MAX_MS = 2 * 3_600_000;
const MAX_EDIT_ERRORS = 3;

export const DEPT_RU: Record<string, string> = {
  marketing: 'Маркетинг', sales: 'Продажи', support: 'Сопровождение', production: 'Производство', backoffice: 'Бэк-офис', hq: 'HQ',
};
export const deptRu = (dept: string) => DEPT_RU[dept] ?? dept;

/** What a worker is doing, by the task's action (shown as «<кто> <делает>»). */
const DOING: Record<string, string> = {
  topic: 'пишет сценарий', trends: 'ищет тренды', trends_weekly: 'ищет тренды', seo: 'проверяет сайт', report: 'считает отчёт', pack: 'собирает пакет недели',
  daily: 'готовит публикации', lead: 'готовит ответ лиду', kp: 'готовит КП', batch: 'готовит карточки', ticket: 'разбирает тикет', invoice: 'готовит счёт',
  project: 'составляет ТЗ', doc: 'пишет документ', onboard: 'готовит онбординг', weekly: 'считает расходы', referral_reminders: 'проверяет рекомендации',
};
const DONE_NOUN: Record<string, string> = {
  topic: 'сценарий готов', trends: 'тренды готовы', seo: 'проверка готова', report: 'отчёт готов', lead: 'ответ лиду готов', kp: 'КП готово', ticket: 'ответ клиенту готов',
  invoice: 'счёт готов', project: 'ТЗ готово', doc: 'документ готов', pack: 'пакет готов',
};
/** How long the owner should expect to wait, by department. */
const ETA: Record<string, string> = {
  marketing: 'обычно 30–60 с, клип дольше', sales: 'обычно 30–60 с', support: 'обычно до минуты', production: 'ТЗ готово за 1–2 минуты', backoffice: 'обычно 30–60 с',
};

const oneLine = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const secs = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} с` : `${Math.floor(s / 60)} мин ${String(s % 60).padStart(2, '0')} с`;
};

/** Hides what must not sit in a chat history: tokens, long keys, emails, phones, links with credentials. */
export function mask(text: string): string {
  return text
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{25,}\b/g, '[токен]')
    .replace(/\b(?:sk|ghp|gho|github_pat|xox[bp])[-_][A-Za-z0-9_-]{16,}\b/g, '[ключ]')
    .replace(/\b[A-Za-z0-9+/_-]{32,}={0,2}/g, '[ключ]')
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@\S+/g, '[ссылка]')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[почта]')
    .replace(/\+?\d[\d\s().-]{8,}\d/g, '[номер]');
}

/** A reason from the task journal in words the owner understands. */
export function reasonRu(raw: string): string {
  const t = oneLine(mask(raw), 140);
  if (!t) return 'причина не записана';
  if (/Лимит расходов/i.test(t)) return 'исчерпан лимит расходов отдела на месяц';
  if (/Нужен строитель/i.test(t)) return 'нужен строитель (Claude Code), задача передана разработчикам';
  if (/не для (продаж|маркетинга|сопровождения)|нет подходящего исполнителя/i.test(t)) return 'у отдела нет подходящего исполнителя';
  if (/approval .* failed to execute/i.test(t)) return 'не удалось выполнить одобренное действие';
  if (!/[а-яё]/i.test(t)) return `внутренняя ошибка (${t.slice(0, 80)})`;
  return t.replace(/^Сбой:\s*/i, 'сбой: ');
}

/** Last error note of the task, or its result. */
export function lastReason(hq: Hq, t: Task): string {
  return hq.events(t.id).filter((e) => e.kind === 'error').at(-1)?.body ?? t.result ?? '';
}

interface Stored {
  /** Absent for a web-only task (owner at the desk): there is no Telegram message, only `line`. */
  chatId?: number;
  messageId?: number;
  startedAt: number;
  /** The status line as of the last status change (what the admin API shows for a closed task). */
  line?: string;
  /** The status already reported to the owner inbox (done, rejected, blocked). */
  notified?: string;
  lineStatus?: string;
  closed?: boolean;
  /** The command reply this message started as: kept under the status lines. */
  note?: string;
}

const storedOf = (t: Task): Stored | null => {
  const p = t.meta.progress as Partial<Stored> | undefined;
  if (!p) return null;
  const tg = typeof p.chatId === 'number' && typeof p.messageId === 'number';
  if (!tg && typeof p.line !== 'string') return null;
  return {
    ...(tg ? { chatId: p.chatId!, messageId: p.messageId! } : {}),
    startedAt: typeof p.startedAt === 'number' ? p.startedAt : t.createdAt,
    ...(p.closed ? { closed: true } : {}),
    ...(typeof p.note === 'string' ? { note: p.note } : {}),
    ...(typeof p.line === 'string' ? { line: p.line } : {}),
    ...(typeof p.notified === 'string' ? { notified: p.notified } : {}),
    ...(typeof p.lineStatus === 'string' ? { lineStatus: p.lineStatus } : {}),
  };
};

export interface ProgressDeps {
  hq: Hq;
  messenger: Messenger;
  ownerId: number;
  /** With the owner channel: at the desk (or for a command from the website) tasks get no Telegram message, and final states go to the inbox. */
  channel?: OwnerChannel;
}

/**
 * The «live message»: when the owner gives a task, one message goes to his chat and is edited in place as the task moves
 * (taken, worked on, ready for approval, done, failed). The pair chat/message is kept in `meta.progress`, so a restart
 * continues editing the same message. A tick (every 5 s) compares the rendered text with the last one and edits at most
 * once per 5 s and only when the text changed. Drill tasks are never tracked.
 */
export class Progress {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly watched = new Set<number>();
  private readonly lastText = new Map<number, string>();
  private readonly lastEditAt = new Map<number, number>();
  private readonly errors = new Map<number, number>();
  private ticking = false;

  constructor(private readonly d: ProgressDeps) {}

  private get hq(): Hq {
    return this.d.hq;
  }

  /** Picks up the open messages from the database (restart) and starts the 5-second tick. */
  start(): void {
    this.stop();
    this.resume();
    this.timer = setInterval(() => void this.tick().catch((e) => log('error', 'progress tick failed', { err: errMsg(e) })), PROGRESS_TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Tasks with an unfinished live message in the database (after a restart). Returns how many are watched. */
  resume(): number {
    for (const t of this.hq.tasks({ limit: 1000 })) {
      const p = storedOf(t);
      if (p && !p.closed && !t.tags.includes('drill')) this.watched.add(t.id);
    }
    return this.watched.size;
  }

  watching(): number[] {
    return [...this.watched];
  }

  /**
   * Sends the live message of a task and starts watching it. `intro`: lines for the first text only (what to expect).
   * Returns false when nothing was sent (drill task, closed task, ).
   */
  async track(task: Task, intro?: string): Promise<boolean> {
    if (task.tags.includes('drill')) return false;
    const text = this.render(task);
    if (this.d.channel?.webOnly()) {
      const at = this.hq.now();
      this.hq.setMeta(task.id, { progress: { startedAt: at, line: text, lineStatus: task.status } satisfies Stored });
      this.watched.add(task.id);
      this.lastText.set(task.id, text);
      return false;
    }
    const id = await this.d.messenger.sendMessage(this.d.ownerId, intro ? `${text}\n\n${intro}` : text);
    const now = this.hq.now();
    this.hq.setMeta(task.id, { progress: { chatId: this.d.ownerId, messageId: id, startedAt: now, line: text, lineStatus: task.status } satisfies Stored });
    this.watched.add(task.id);
    this.lastText.set(task.id, text);
    this.lastEditAt.set(task.id, now);
    return true;
  }

  /**
   * Turns a message that was already sent (the reply to a command) into the live message of the task: the reply stays
   * at the bottom, the status lines are put above it.
   */
  adopt(task: Task, messageId: number, reply: string): boolean {
    if (task.tags.includes('drill')) return false;
    const now = this.hq.now();
    const note = reply.slice(0, 600);
    this.hq.setMeta(task.id, { progress: { chatId: this.d.ownerId, messageId, startedAt: now, note, line: this.render(task), lineStatus: task.status } satisfies Stored });
    this.watched.add(task.id);
    this.lastText.set(task.id, reply);
    this.lastEditAt.set(task.id, now);
    return true;
  }

  /** One pass over the watched tasks. Returns how many messages were edited. */
  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    let edited = 0;
    try {
      const now = this.hq.now();
      for (const id of [...this.watched]) {
        const t = this.hq.task(id);
        const p = t ? storedOf(t) : null;
        if (!t || !p || p.closed) {
          this.forget(id);
          continue;
        }
        const final = t.status === 'done' || t.status === 'rejected';
        const expired = now - p.startedAt >= PROGRESS_MAX_MS;
        const line = this.render(t);
        const text = p.note ? `${line}\n\n${p.note}` : line;
        // the line for the API, kept on status changes only (every write also touches the task's updated_at)
        const report = (final || t.status === 'blocked') && p.notified !== t.status;
        if (p.lineStatus !== t.status || report) {
          p.line = line;
          p.lineStatus = t.status;
          if (report) {
            p.notified = t.status;
            // a web-only task reaches Telegram now if the owner has left the desk; a Telegram one already shows it in its message
            if (p.messageId === undefined) await this.d.channel?.notify('progress', line, { taskId: t.id }).catch((e) => log('warn', 'progress notify failed', { task: t.id, err: errMsg(e) }));
            else this.d.channel?.record('progress', line, t.id);
          }
          this.saveQuietly(t, p);
        }
        if (p.messageId === undefined || p.chatId === undefined) {
          // no Telegram message: nothing to edit
          if (final || expired) this.close(t, p);
          continue;
        }
        const last = this.lastText.get(id);
        const due = now - (this.lastEditAt.get(id) ?? 0) >= MIN_EDIT_MS;
        if (text !== last && due) {
          try {
            await this.d.messenger.edit(p.chatId, p.messageId, text);
            this.lastText.set(id, text);
            this.lastEditAt.set(id, now);
            this.errors.delete(id);
            edited++;
          } catch (e) {
            const n = (this.errors.get(id) ?? 0) + 1;
            this.errors.set(id, n);
            log('warn', 'progress edit failed', { task: id, err: errMsg(e) });
            if (n >= MAX_EDIT_ERRORS) this.close(t, p);
            continue;
          }
          if (final) this.close(t, p);
        } else if (text === last && (final || expired)) this.close(t, p);
      }
    } finally {
      this.ticking = false;
    }
    return edited;
  }

  /** Writes `meta.progress` without touching `updated_at` (the age in the message counts from it). */
  private saveQuietly(t: Task, p: Stored): void {
    const fresh = this.hq.task(t.id);
    if (!fresh) return;
    this.hq.db.prepare('UPDATE tasks SET meta = ? WHERE id = ?').run(JSON.stringify({ ...fresh.meta, progress: { ...p } }), t.id);
  }

  private close(t: Task, p: Stored): void {
    this.hq.setMeta(t.id, { progress: { ...p, closed: true } });
    this.forget(t.id);
  }

  private forget(id: number): void {
    this.watched.delete(id);
    this.lastText.delete(id);
    this.lastEditAt.delete(id);
    this.errors.delete(id);
  }

  // ---- text ----
  /** Where the work is now: the running child (a worker's own task) if there is one, else the task itself. */
  private current(t: Task): Task {
    if (t.status !== 'running') return t;
    return this.hq.tasks({ parentId: t.id, status: 'running', limit: 5 })[0] ?? t;
  }

  private who(t: Task): string {
    const cur = this.current(t);
    const a = cur.assigneeId ? this.hq.agent(cur.assigneeId) : this.hq.headOf(cur.dept);
    const action = typeof cur.meta.action === 'string' ? cur.meta.action : typeof t.meta.action === 'string' ? t.meta.action : '';
    const worker = a?.title ?? 'голова отдела';
    return `${worker} ${DOING[action] ?? 'работает'}`;
  }

  private preview(t: Task): string {
    const link = this.hq.db.prepare("SELECT summary FROM task_approvals WHERE task_id = ? AND state IN ('queued','asked','executed') ORDER BY id DESC LIMIT 1").get(t.id) as { summary: string } | undefined;
    const raw = (link?.summary ?? t.result ?? '').trim();
    if (!raw) return '';
    const lines = mask(raw).split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2).join('\n');
    return lines.length > 300 ? `${lines.slice(0, 299)}…` : lines;
  }

  render(t: Task): string {
    const now = this.hq.now();
    const head = `#${t.id} ${deptRu(t.dept)}: «${oneLine(t.title, 90)}»`;
    const took = '✅ принял';
    const age = secs(Math.max(0, (t.status === 'inbox' || t.status === 'assigned' || t.status === 'running' ? now : t.updatedAt) - t.createdAt));
    const action = typeof t.meta.action === 'string' ? t.meta.action : '';
    const prev = this.preview(t);
    const tail = prev ? `\n${prev}` : '';
    switch (t.status) {
      case 'inbox':
      case 'assigned':
        return `${head}\n${took} · ⏳ ждёт голову отдела (${age})`;
      case 'running':
        return `${head}\n${took} · ⏳ ${this.who(t)} (${age})`;
      case 'review':
        return `${head}\n${took} · ⏳ проверяю результат (${age})`;
      case 'approval':
        return `${head}\n${took} · ✅ ${DONE_NOUN[action] ?? 'готово'} (${age}) · 📋 в пачке на одобрение: /approve${tail}`;
      case 'done': {
        const approved = (this.hq.db.prepare("SELECT COUNT(*) c FROM task_approvals WHERE task_id = ? AND state = 'executed'").get(t.id) as { c: number }).c > 0;
        return `${head}\n${took} · ✅ ${approved ? 'одобрено вами и выполнено' : 'готово'} (${age})${tail}`;
      }
      case 'rejected':
        return `${head}\n${took} · 🚫 вы отклонили`;
      case 'blocked':
        if (t.tags.includes('builder')) return `${head}\n${took} · 🛠 передано строителям (Claude Code): issue появится в течение 10 минут, список /builders`;
        return `${head}\n❌ не получилось: ${reasonRu(lastReason(this.hq, t))}\nМожно повторить: /retry ${t.id}`;
    }
  }

  /** The first lines for a new live message: what will happen and how long it takes. */
  intro(t: Task): string {
    const dept = deptRu(t.dept);
    return `${dept} взял задачу: голова отдела подхватит её в течение 30 с (${ETA[t.dept] ?? 'обычно до минуты'}). Я обновлю это сообщение.`;
  }
}
