import { errMsg, log, markdownToPdfDoc, PLAYBOOK_ROLES, PLAYBOOK_ROLE_RU, loadPlaybook, playbookSection, type PlaybookRole, type ApprovalQueue, type LlmClient, type Messenger } from '@fir/core';
import { meterLlm, type Agent, type Hq, type Task, type Worker, type WorkerCtx } from '@fir/hq';
import {
  DocStore, DOC_RU, DOC_TYPES, kindSpecs as docKinds, onDecision as onDocDecision, parseDocType, DocumentsWorker, type DocContext,
} from '@fir/worker-documents';
import { exportPlan, KbStore, KnowledgeWorker, parseLesson, playbookTitles, searchKb, searchText } from '@fir/worker-knowledge';
import { fmtDate, PmStore } from '@fir/worker-project-manager';
import type { Reporter } from '../reporter.js';
import { makeBackup, MAX_SEND_BYTES } from '../backup.js';
import { cleanRenders } from '../housekeeping.js';
import { toolsFor, type AppTools } from '../tools.js';

export const BACKOFFICE = 'backoffice';
export const BACKOFFICE_HEAD_ID = 'backoffice-head';
const DOCS_ID = 'documents';
const KNOWLEDGE_ID = 'knowledge';

export interface BackofficeSeedConfig {
  backofficeBudgetUsd: number;
}

/** First start: the Back Office org (head, two workers) and the Sunday lessons export. Instructions come from the file once. */
export function seedBackoffice(hq: Hq, cfg: BackofficeSeedConfig, readInstructions: (file: string) => string): void {
  hq.ensureAgent({
    id: BACKOFFICE_HEAD_ID, dept: BACKOFFICE, role: 'head', title: 'Голова бэк-офиса', instructions: readInstructions('backoffice-head.md'),
    bossId: 'director', bot: 'BACKOFFICE_BOT_TOKEN', budgetUsdMonth: cfg.backofficeBudgetUsd,
  });
  hq.ensureAgent({ id: DOCS_ID, dept: BACKOFFICE, role: 'worker', title: 'Документовед', bossId: BACKOFFICE_HEAD_ID });
  hq.ensureAgent({ id: KNOWLEDGE_ID, dept: BACKOFFICE, role: 'worker', title: 'Хранитель знаний', bossId: BACKOFFICE_HEAD_ID });
  hq.syncRoutines('backoffice', [
    { name: 'backoffice-lessons-weekly', cron: '0 19 * * 0', dept: BACKOFFICE, title: 'Обновить knowledge/lessons', meta: { action: 'lessons_export' } },
    { name: 'backoffice-backup-daily', cron: '30 3 * * *', dept: BACKOFFICE, title: 'Резервная копия баз и отправка владельцу', meta: { action: 'backup' } },
    { name: 'backoffice-renders-cleanup', cron: '45 3 * * *', dept: BACKOFFICE, title: 'Очистка старых рендеров', meta: { action: 'renders_cleanup' } },
  ]);
}

export interface BackofficeDeps {
  hq: Hq;
  /** Adapters and keys of the agents' toolbox (`docs/tools.md`, `src/tools.ts`); absent (tests): a toolbox without keys. */
  tools?: AppTools | undefined;
  llm: LlmClient;
  queue: ApprovalQueue;
  messenger: Messenger;
  ownerId: number;
  reporter: Reporter;
  /** Folder `knowledge/` for the playbook titles; without it `/kb` searches lessons only. */
  knowledgeDir?: string | undefined;
  /** Tests may replace the documents worker (another templates folder). */
  documents?: Worker;
  /** Nightly housekeeping (routines `backoffice-backup-daily` and `backoffice-renders-cleanup`); without them those tasks say so and end. */
  ops?: {
    dataDir: string;
    rendersDir: string;
    /** age public key for the backup archive; unset: the archive is sent unencrypted and the message says so. */
    ageRecipient?: string | undefined;
    /** Tests inject the process runner for tar and age. */
    exec?: (cmd: string, args: string[]) => Promise<unknown>;
  };
}

interface Staged {
  kind: string;
  payload: Record<string, unknown>;
  summary: string;
}

const oneLine = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * Head of the Back Office. Documents: `/doc <type> <client>` fills a template and sends it to the owner (level 0, locked);
 * he sends the approved text himself. Knowledge: lessons into `kb_lessons`, a weekly builder task commits them into the
 * repo `knowledge/`; `/kb` searches lessons and playbook titles. Finance lives under Support.
 */
export class BackofficeHead {
  readonly documents: Worker;
  readonly knowledge = new KnowledgeWorker();

  constructor(private readonly d: BackofficeDeps) {
    this.documents = d.documents ?? new DocumentsWorker({ lookup: (client) => this.lookup(client) });
    const base = { db: d.hq.db, now: d.hq.now };
    for (const [kind, spec] of Object.entries(
      docKinds(base, {
        deliver: async (doc) => {
          await d.messenger.send(d.ownerId, `${DOC_RU[doc.type]}, ${doc.client}, версия ${doc.version}: утверждён. Отправьте клиенту сами:\n\n${doc.text}`);
          await this.sendPdf(doc);
        },
      }),
    )) d.hq.registerKind(kind, spec);
    d.hq.onApprovalDecision((link, state) => onDocDecision(base, link, state));
  }

  /**
   * The approved document as an A4 PDF (`tools.media.pdf`, Onest), saved under `renders/docs/` and sent to the owner as a file. Best effort:
   * the text already went out, a PDF that cannot be made is only logged (no files folder in tests, no fonts, a Telegram error).
   */
  private async sendPdf(doc: { id: number; type: string; client: string; version: number; text: string }): Promise<void> {
    const tools = toolsFor(this.hq, this.d.tools, { agentId: DOCS_ID, dept: BACKOFFICE, messenger: this.d.messenger, ownerId: this.d.ownerId });
    if (!tools.can('files.put') || !tools.can('media.pdf') || !tools.can('telegram.sendDocument')) return;
    const pdf = await tools.media.pdf(markdownToPdfDoc(doc.text, { footer: 'Fir Tech · firtech.pro' }));
    if (!pdf.ok) return void log('warn', 'document pdf not rendered', { doc: doc.id, err: pdf.error });
    const file = await tools.files.put('docs', `${doc.type}-${doc.id}-v${doc.version}.pdf`, pdf.value.bytes);
    if (!file.ok) return void log('warn', 'document pdf not saved', { doc: doc.id, err: file.error });
    const sent = await tools.telegram.sendDocument(file.value.path, `${DOC_RU[doc.type as keyof typeof DOC_RU] ?? 'Документ'}, ${doc.client}, версия ${doc.version} (PDF)`);
    if (!sent.ok) log('warn', 'document pdf not sent', { doc: doc.id, err: sent.error });
  }

  private get hq(): Hq {
    return this.d.hq;
  }

  private agent(): Agent {
    return this.hq.agent(BACKOFFICE_HEAD_ID)!;
  }

  private llmFor(actor: string, taskId: number | null): LlmClient {
    return meterLlm(this.d.llm, this.hq, { agentId: actor, taskId });
  }

  private async report(taskId: number, text: string): Promise<void> {
    this.hq.addEvent(taskId, 'report', BACKOFFICE_HEAD_ID, text);
    await this.d.reporter.post(BACKOFFICE, text);
  }

  /** Project data for a document, from Production's tables (`pm_*`), by number or client name. */
  private lookup(client: string): (DocContext & { client: string }) | undefined {
    const pm = new PmStore(this.hq.db, this.hq.now);
    const p = pm.find(client);
    if (!p) return undefined;
    return {
      client: p.client, projectId: p.id, what: p.what,
      milestones: pm.milestones(p.id).map((m) => `- ${m.title}: до ${fmtDate(m.dueAt, this.hq.tz)}`),
    };
  }

  /** Documents waiting for the owner's decision: the line the Director adds to the morning summary. Null when none. */
  pendingLine(): string | null {
    const docs = new DocStore(this.hq.db, this.hq.now).pending();
    if (!docs.length) return null;
    return `Документы ждут решения: ${docs.map((x) => `${DOC_RU[x.type]} «${x.client}» v${x.version}`).join(', ')} (/approve).`;
  }

  // ---- commands through the Director ----
  async command(name: string, arg: string): Promise<string> {
    switch (name) {
      case 'doc': {
        const [word = '', ...rest] = arg.trim().split(/\s+/);
        const type = parseDocType(word);
        if (!type) return `Формат: /doc <тип> <клиент>. Типы: договор, оферта, политика, акт.`;
        const client = rest.join(' ').trim();
        if ((type === 'contract' || type === 'act') && !client) return 'Для договора и акта нужен клиент: /doc договор <клиент>';
        const t = this.hq.createTask({ title: `${DOC_RU[type]}: ${client || 'firtech.pro'}`, dept: BACKOFFICE, creator: 'owner', priority: 1, meta: { action: 'doc', type, client } });
        this.hq.wake(BACKOFFICE_HEAD_ID, 'task');
        return `Задача #${t.id}: ${DOC_RU[type].toLowerCase()}. Черновик придёт в пачке на одобрение (/approve), до 30 секунд на подготовку. Утвердить можно после заполнения всех мест в квадратных скобках.`;
      }
      case 'lesson': {
        const l = parseLesson(arg);
        if (!l) return 'Формат: /lesson <проект>: <что узнали>';
        const row = new KbStore(this.hq.db, this.hq.now).add(l.project, l.text);
        this.hq.log(KNOWLEDGE_ID, 'lesson_added', 'lesson', String(row.id));
        return `Урок #${row.id} записан (проект «${l.project}»). В репозиторий уйдёт в воскресной выгрузке (19:00).`;
      }
      case 'kb': {
        if (!arg.trim()) return 'Формат: /kb <запрос>';
        const r = searchKb(arg, new KbStore(this.hq.db, this.hq.now).all(), playbookTitles(this.d.knowledgeDir));
        return searchText(arg.trim(), r);
      }
      case 'playbook':
        return playbookText(arg, this.d.knowledgeDir);
      default:
        return 'Неизвестная команда бэк-офиса.';
    }
  }

  // ---- heartbeat ----
  async onHeartbeat(): Promise<void> {
    if (this.agent().status !== 'active') return;
    for (const t of [...this.hq.tasks({ dept: BACKOFFICE, status: 'inbox' }), ...this.hq.tasks({ dept: BACKOFFICE, status: 'assigned', assigneeId: BACKOFFICE_HEAD_ID })]) {
      await this.handle(t).catch((e) => this.crash(t, e));
    }
    // A builder committed the lessons (the issue closed, the bridge returned the task to the head): close it with the result.
    for (const t of this.hq.tasks({ dept: BACKOFFICE, status: 'review' }).filter((x) => x.meta.builderClosed === true && x.meta.kind === 'lessons')) {
      const comment = this.hq.events(t.id).filter((e) => e.kind === 'result').at(-1)?.body ?? 'готово';
      this.hq.complete(t.id, BACKOFFICE_HEAD_ID, oneLine(comment, 1500));
      await this.report(t.id, `Уроки в репозитории (задача #${t.id}): ${oneLine(comment, 400)}`);
    }
  }

  private async crash(task: Task, e: unknown): Promise<void> {
    log('error', 'backoffice task crashed', { task: task.id, err: errMsg(e) });
    const cur = this.hq.task(task.id);
    if (cur && cur.status !== 'blocked' && cur.status !== 'done' && cur.status !== 'rejected') this.hq.block(task.id, BACKOFFICE_HEAD_ID, `Сбой: ${errMsg(e)}`.slice(0, 300));
    await this.hq.alert(`Бэк-офис: задача #${task.id} заблокирована (сбой), подробности в журнале задачи.`);
  }

  private ctx(task: Task, staged: Staged[], actor: string): WorkerCtx {
    const llm = this.llmFor(actor, task.id);
    return {
      llm, db: this.hq.db, tz: this.hq.tz, now: this.hq.now,
      requestApproval: (kind, payload, summary) => Promise.resolve(staged.push({ kind, payload, summary }) - 1),
      log: (action, detail) => this.hq.log(actor, action, 'task', String(task.id), detail),
      tools: toolsFor(this.hq, this.d.tools, { agentId: actor, dept: BACKOFFICE, taskId: task.id, llm, messenger: this.d.messenger, ownerId: this.d.ownerId }),
    };
  }

  private async handle(task: Task): Promise<void> {
    if (!this.hq.claim(task.id, BACKOFFICE_HEAD_ID)) return;
    const action = task.meta.action;
    // housekeeping makes no LLM calls: the department's money limit does not stop it
    if (action === 'backup') return this.backup(task);
    if (action === 'renders_cleanup') return this.rendersCleanup(task);
    if (this.hq.overBudget(BACKOFFICE)) return void this.hq.block(task.id, BACKOFFICE_HEAD_ID, 'Лимит расходов отдела исчерпан');
    if (action === 'lessons_export') return this.exportLessons(task);
    if (action === 'doc') {
      const staged: Staged[] = [];
      const res = await this.documents.run(this.hq.task(task.id)!, this.ctx(task, staged, DOCS_ID)).catch((e) => ({ ok: false, result: '', error: errMsg(e) }));
      if (!res.ok) {
        this.hq.block(task.id, DOCS_ID, res.error ?? 'исполнитель не вернул результат');
        return void (await this.hq.alert(`Бэк-офис: задача #${task.id} не выполнена: ${(res.error ?? '').slice(0, 200)}`));
      }
      this.hq.complete(task.id, DOCS_ID, res.result, staged.length > 0 ? 'review' : 'done');
      for (const s of staged) await this.hq.requestApproval(task.id, DOCS_ID, s.kind, s.payload, s.summary);
      return void (await this.report(task.id, `${res.result} Придёт в пачке на одобрение.`));
    }
    this.hq.block(task.id, BACKOFFICE_HEAD_ID, `Бэк-офис умеет: документы (/doc ${DOC_TYPES.join('|')}), уроки (/lesson), поиск (/kb)`);
    await this.report(task.id, `Задача #${task.id} «${oneLine(task.title, 80)}» не для бэк-офиса: умею документы и базу знаний.`);
  }

  /**
   * Night routine: a consistent copy of hq.db (and any other SQLite file in the data dir), tar.gz without renders, age-encrypted
   * when BACKUP_AGE_RECIPIENT is set, sent to the owner as a document through the Director bot; seven copies stay in
   * DATA_DIR/backups. Over 49 MB (Telegram's bot limit) it is not sent: the owner is alerted and the copy stays on the server.
   */
  private async backup(task: Task): Promise<void> {
    const ops = this.d.ops;
    if (!ops) return void this.hq.complete(task.id, BACKOFFICE_HEAD_ID, 'Резервное копирование не подключено (нет каталога данных).');
    let r;
    try {
      r = await makeBackup({ dataDir: ops.dataDir, now: this.hq.now, ageRecipient: ops.ageRecipient, ...(ops.exec ? { exec: ops.exec } : {}) });
    } catch (e) {
      this.hq.block(task.id, BACKOFFICE_HEAD_ID, `Бэкап не сделан: ${errMsg(e)}`.slice(0, 300));
      return void (await this.hq.alert(`Резервная копия не сделана: ${errMsg(e).slice(0, 200)}. Задача #${task.id}.`));
    }
    const mb = (r.bytes / 1_048_576).toFixed(1);
    const note = r.encrypted ? 'зашифрована age' : 'НЕ зашифрована (BACKUP_AGE_RECIPIENT не задан, в архиве базы с клиентами: храните в закрытом чате)';
    let sent = false;
    if (r.bytes > MAX_SEND_BYTES) {
      await this.hq.alert(`Резервная копия ${mb} МБ больше лимита Telegram (50 МБ), в чат не отправлена: лежит на сервере в data/backups (хранится 7 копий). Нужно внешнее хранилище.`);
    } else if (!this.d.messenger.sendDocument) {
      await this.hq.alert('Резервная копия сделана, но этот канал не умеет отправлять файлы: лежит на сервере в data/backups.');
    } else {
      try {
        await this.d.messenger.sendDocument(this.d.ownerId, r.file, `Резервная копия HQ: ${r.databases.join(', ')}, ${mb} МБ, ${note}.`);
        sent = true;
      } catch (e) {
        await this.hq.alert(`Резервная копия сделана (${mb} МБ), но не отправилась в Telegram: ${errMsg(e).slice(0, 150)}. Лежит на сервере в data/backups.`);
      }
    }
    const text = `Резервная копия: ${r.databases.length} баз, ${mb} МБ, ${r.encrypted ? 'age' : 'без шифрования'}, ${sent ? 'отправлена владельцу' : 'не отправлена'}; старых удалено: ${r.removed.length}.`;
    this.hq.complete(task.id, BACKOFFICE_HEAD_ID, text);
  }

  /** Night routine: render folders of items published or rejected more than 14 days ago are deleted. */
  private async rendersCleanup(task: Task): Promise<void> {
    const ops = this.d.ops;
    if (!ops) return void this.hq.complete(task.id, BACKOFFICE_HEAD_ID, 'Очистка рендеров не подключена.');
    const removed = cleanRenders({ db: this.hq.db, rendersDir: ops.rendersDir, now: this.hq.now() });
    this.hq.complete(task.id, BACKOFFICE_HEAD_ID, `Рендеры: удалено папок ${removed.length}${removed.length ? ` (${removed.slice(0, 20).join(', ')})` : ''}.`);
  }

  /** Sunday routine: unexported lessons become one builder task; no lessons, no task. */
  private async exportLessons(task: Task): Promise<void> {
    const store = new KbStore(this.hq.db, this.hq.now);
    const plan = exportPlan(store, { tz: this.hq.tz, now: this.hq.now });
    if (!plan) {
      this.hq.complete(task.id, KNOWLEDGE_ID, 'Новых уроков нет, обновлять нечего.');
      return void (await this.report(task.id, 'Новых уроков за неделю нет.'));
    }
    const bt = this.hq.createTask({ title: plan.title, body: plan.body, dept: BACKOFFICE, creator: 'head', tags: ['builder'], meta: { kind: 'lessons', lessons: plan.lessonIds } });
    this.hq.block(bt.id, BACKOFFICE_HEAD_ID, 'Нужен строитель: закоммитить уроки в knowledge/', ['builder']);
    store.markExported(plan.lessonIds, bt.id);
    this.hq.complete(task.id, KNOWLEDGE_ID, `Уроков к выгрузке: ${plan.lessonIds.length}, builder-задача #${bt.id}.`);
    await this.report(task.id, `Уроков к выгрузке в knowledge/lessons: ${plan.lessonIds.length}. Builder-задача #${bt.id} (/builders).`);
  }
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').trim();

/** A role by its id («content-maker») or its Russian name («контент-мейкер»), also by a start of either; null when unclear. */
export function findPlaybookRole(query: string): PlaybookRole | null {
  const q = norm(query);
  if (!q) return null;
  const hit = PLAYBOOK_ROLES.find((r) => r === q || norm(PLAYBOOK_ROLE_RU[r]) === q)
    ?? PLAYBOOK_ROLES.find((r) => r.startsWith(q) || norm(PLAYBOOK_ROLE_RU[r]).startsWith(q));
  return hit ?? null;
}

/**
 * `/playbook <role>`: the Правила of the role's playbook, for the owner to read and ask for edits. The whole text goes out as one
 * reply; the messenger splits it by the Telegram limit. Without an argument: the list of roles.
 */
export function playbookText(arg: string, knowledgeDir?: string): string {
  const list = PLAYBOOK_ROLES.map((r) => `${r} (${PLAYBOOK_ROLE_RU[r]})`).join(', ');
  if (!arg.trim()) return `Формат: /playbook <роль>. Роли: ${list}.`;
  const role = findPlaybookRole(arg);
  if (!role) return `Не нашёл роль «${arg.trim().slice(0, 40)}». Роли: ${list}.`;
  const text = loadPlaybook(role, knowledgeDir);
  const rules = playbookSection(text, 'Правила');
  if (!rules) return `Плейбук роли «${PLAYBOOK_ROLE_RU[role]}» не найден в базе знаний (knowledge/playbooks/${role}.md).`;
  return `Плейбук «${PLAYBOOK_ROLE_RU[role]}»: правила\n\n${rules}\n\nЧтобы поменять, напишите, что исправить: строитель внесёт правку в knowledge/playbooks/${role}.md. Остальные разделы (чеклист, шаблоны) в том же файле.`;
}
