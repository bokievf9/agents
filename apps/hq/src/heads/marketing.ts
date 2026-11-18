import { errMsg, log, tryJson, zonedParts, type ApprovalQueue, type LlmClient, type Messenger } from '@fir/core';
import { meterLlm, type Agent, type Hq, type Task, type Worker, type WorkerCtx, type WorkerResult } from '@fir/hq';
import {
  KIND, ContentMakerWorker, editableParts, partLabel, replacePart, storeFor, titleOf, todayReport, ymd,
  type PartId,
} from '@fir/worker-content-maker';
import { z } from 'zod';
import type { ApprovalEditor } from '../editor.js';
import type { Reporter } from '../reporter.js';

export const MARKETING = 'marketing';
export const HEAD_ID = 'marketing-head';
const WORKER_ID = 'content-maker';

export interface MarketingDeps {
  hq: Hq;
  llm: LlmClient;
  queue: ApprovalQueue;
  messenger: Messenger;
  ownerId: number;
  reporter: Reporter;
  /** Default: the content-maker. Tests pass their own. */
  worker?: Worker;
  clipsPerWeek?: number;
  carouselsPerWeek?: number;
  rng?: () => number;
}

const splitSchema = z.object({
  action: z.enum(['pack', 'topic', 'daily', 'none']),
  topic: z.string().max(300).optional(),
  type: z.enum(['clip', 'carousel']).optional(),
});
const reviewSchema = z.object({ ok: z.boolean(), issues: z.array(z.string()).max(10).default([]) });

type Action = 'pack' | 'topic' | 'daily' | 'none';

/** Heuristics for the case without an LLM: only the obvious wordings. */
function guessAction(task: Task): { action: Action; topic?: string } {
  const text = `${task.title} ${task.body}`.toLowerCase();
  if (/пакет|на неделю|pack/.test(text)) return { action: 'pack' };
  if (/что публикуем|публикуем сегодня/.test(text)) return { action: 'daily' };
  if (/клип|ролик|карусел|рилс|reels|shorts/.test(text)) return { action: 'topic', topic: task.body.trim() || task.title };
  return { action: 'none' };
}

/**
 * Head of the Marketing department. One heartbeat cycle: take the department's tasks from the inbox, split them
 * for the worker, run it, review the result against the department checklist (LLM, strict JSON), send it back
 * once for rework, then to approval or done, and report. Proposals go to the Director's batch, never straight
 * to the owner. The head owns the worker's approval kind and the part-by-part editing of items.
 */
export class MarketingHead implements ApprovalEditor {
  readonly worker: Worker;

  constructor(private readonly d: MarketingDeps) {
    this.worker =
      d.worker ??
      new ContentMakerWorker({
        ...(d.clipsPerWeek !== undefined ? { clipsPerWeek: d.clipsPerWeek } : {}),
        ...(d.carouselsPerWeek !== undefined ? { carouselsPerWeek: d.carouselsPerWeek } : {}),
        ...(d.rng ? { rng: d.rng } : {}),
      });
    if (this.worker instanceof ContentMakerWorker) {
      const spec = this.worker.kindSpec({ db: d.hq.db, now: d.hq.now }, (id) => d.queue.get(id)?.edited ?? false);
      d.hq.registerKind(KIND, spec);
    }
    // The owner rejected an item: the worker's own table follows.
    d.hq.onApprovalDecision((link, state) => {
      if (link.kind === KIND && state === 'rejected') storeFor({ db: d.hq.db, now: d.hq.now }).setStatus(Number(link.payload.itemId), 'rejected');
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

  private today(): string {
    const p = zonedParts(this.hq.now(), this.hq.tz);
    return ymd(Date.UTC(p.y, p.mo - 1, p.d));
  }

  /** Report: always into the task journal (the morning summary reads it), plus the department topic when configured. */
  private async report(taskId: number, text: string): Promise<void> {
    this.hq.addEvent(taskId, 'report', HEAD_ID, text);
    await this.d.reporter.post(MARKETING, text);
  }

  // ---- heartbeat ----
  async onHeartbeat(): Promise<void> {
    if (this.agent().status !== 'active') return;
    for (const t of [...this.hq.tasks({ dept: MARKETING, status: 'inbox' }), ...this.hq.tasks({ dept: MARKETING, status: 'assigned', assigneeId: HEAD_ID })]) {
      await this.handle(t).catch((e) => this.crash(t, e));
    }
    for (const t of this.hq.tasks({ dept: MARKETING, status: 'assigned', assigneeId: WORKER_ID })) {
      await this.runChild(t).catch((e) => this.crash(t, e));
    }
    await this.finalizeParents();
  }

  private async crash(task: Task, e: unknown): Promise<void> {
    log('error', 'marketing task crashed', { task: task.id, err: errMsg(e) });
    const cur = this.hq.task(task.id);
    if (cur && cur.status !== 'blocked' && cur.status !== 'done' && cur.status !== 'rejected') this.hq.block(task.id, HEAD_ID, `Сбой: ${errMsg(e)}`.slice(0, 300));
    if (!task.parentId) await this.hq.alert(`Маркетинг: задача #${task.id} заблокирована (сбой), подробности в журнале задачи.`);
  }

  private async decide(task: Task): Promise<{ action: Action; topic?: string; type?: 'clip' | 'carousel' }> {
    const metaAction = task.meta.action;
    if (metaAction === 'pack' || metaAction === 'topic' || metaAction === 'daily') {
      return { action: metaAction, ...(typeof task.meta.topic === 'string' ? { topic: task.meta.topic } : {}) };
    }
    const res = await tryJson(
      this.llmFor(HEAD_ID, task.id),
      {
        tier: 'haiku', maxTokens: 400,
        system: `${this.agent().instructions}\n\nОпредели, что нужно сделать исполнителю по задаче. Ответ: только JSON {"action": "pack"|"topic"|"daily"|"none", "topic": "тема материала", "type": "clip"|"carousel"}. pack: пакет недели; topic: один материал на тему; daily: что публикуем сегодня; none: задача не для Контент-мейкера.`,
        messages: [{ role: 'user', content: `Задача: ${task.title}\n${task.body}`.slice(0, 2000) }],
      },
      splitSchema,
    );
    if (res) return { action: res.action, ...(res.topic ? { topic: res.topic } : {}), ...(res.type ? { type: res.type } : {}) };
    return guessAction(task);
  }

  // ---- taking and splitting a task ----
  private async handle(task: Task): Promise<void> {
    if (!this.hq.claim(task.id, HEAD_ID)) return;
    if (this.hq.overBudget(MARKETING)) return void this.hq.block(task.id, HEAD_ID, 'Лимит расходов отдела исчерпан');
    const { action, topic, type } = await this.decide(task);
    if (action === 'none') {
      this.hq.block(task.id, HEAD_ID, 'Нет подходящего исполнителя в отделе маркетинга');
      await this.report(task.id, `Задача #${task.id} «${task.title}» не для маркетинга: нет исполнителя. Нужен строитель или другой отдел?`);
      return;
    }
    if (action === 'daily') {
      const text = todayReport(storeFor({ db: this.hq.db, now: this.hq.now }), this.today());
      this.hq.complete(task.id, HEAD_ID, text);
      return void (await this.report(task.id, text));
    }
    if (action === 'topic') {
      this.hq.setMeta(task.id, { action: 'topic', topic: topic ?? (task.body.trim() || task.title), ...(type ? { type } : {}) });
      await this.runWorkerTask(task.id, HEAD_ID);
      return;
    }
    // pack: the worker splits it into items, each item is a subtask of the content-maker
    this.hq.setMeta(task.id, { action: 'pack' });
    const specs = await this.worker.plan!(this.hq.task(task.id)!, this.ctx(this.hq.task(task.id)!, [], WORKER_ID));
    if (!specs || specs.length === 0) {
      this.hq.complete(task.id, HEAD_ID, 'Пакет на эту неделю уже есть, новый не создаю.');
      return void (await this.report(task.id, 'Пакет недели уже создан раньше, повторно не делаю.'));
    }
    for (const s of specs) {
      this.hq.createTask({ title: s.title, body: s.body ?? '', dept: MARKETING, assigneeId: WORKER_ID, creator: 'head', parentId: task.id, priority: task.priority, meta: s.meta });
    }
    this.hq.comment(task.id, HEAD_ID, `Разбито на ${specs.length} подзадач для Контент-мейкера`);
    for (const child of this.hq.tasks({ parentId: task.id, status: 'assigned' })) await this.runChild(child).catch((e) => this.crash(child, e));
    await this.finalizeParents();
  }

  private async runChild(child: Task): Promise<void> {
    if (!this.hq.claim(child.id, WORKER_ID)) return;
    if (this.hq.overBudget(MARKETING)) return void this.hq.block(child.id, HEAD_ID, 'Лимит расходов отдела исчерпан');
    await this.runWorkerTask(child.id, WORKER_ID);
  }

  /** Parents whose subtasks all left the work stages are done: the pack is prepared, the items wait for the owner. */
  private async finalizeParents(): Promise<void> {
    for (const p of this.hq.tasks({ dept: MARKETING, status: 'running', assigneeId: HEAD_ID })) {
      const kids = this.hq.tasks({ parentId: p.id });
      if (kids.length === 0 || kids.some((k) => ['inbox', 'assigned', 'running', 'review'].includes(k.status))) continue;
      const n = (s: string) => kids.filter((k) => k.status === s).length;
      const blocked = n('blocked');
      const text = `${p.title}: материалов ${kids.length}, на одобрение ${n('approval') + n('done')}${blocked ? `, не получилось ${blocked}` : ''}.`;
      this.hq.complete(p.id, HEAD_ID, text);
      await this.report(p.id, text);
      if (blocked) await this.hq.alert(`Маркетинг: в задаче #${p.id} не получилось материалов: ${blocked}. Подробности: /tasks marketing.`);
    }
  }

  // ---- worker run, review, one rework, approval ----
  private ctx(task: Task, staged: { kind: string; payload: Record<string, unknown>; summary: string }[], actor: string): WorkerCtx {
    return {
      llm: this.llmFor(actor, task.id), db: this.hq.db, tz: this.hq.tz, now: this.hq.now,
      requestApproval: (kind, payload, summary) => Promise.resolve(staged.push({ kind, payload, summary }) - 1),
      log: (action, detail) => this.hq.log(actor, action, 'task', String(task.id), detail),
    };
  }

  private async review(task: Task, result: string): Promise<{ ok: boolean; issues: string[] }> {
    const res = await tryJson(
      this.llmFor(HEAD_ID, task.id),
      {
        tier: 'haiku', maxTokens: 600,
        system: `${this.agent().instructions}\n\nПроверь материал по чек-листу выше. Ответ: только JSON {"ok": true|false, "issues": ["что исправить, коротко"]}. ok true, если нарушений нет. Не придумывай замечаний, которых нет.`,
        messages: [{ role: 'user', content: `Задача: ${task.title}\n\nМатериал:\n${result}`.slice(0, 8000) }],
      },
      reviewSchema,
    );
    return res ?? { ok: true, issues: [] }; // LLM off or garbage: the owner's approval is the safety net
  }

  private async runOnce(taskId: number, actor: string, staged: { kind: string; payload: Record<string, unknown>; summary: string }[]): Promise<WorkerResult> {
    staged.length = 0;
    const t = this.hq.task(taskId)!;
    try {
      return await this.worker.run(t, this.ctx(t, staged, actor));
    } catch (e) {
      return { ok: false, result: '', error: errMsg(e) };
    }
  }

  private async runWorkerTask(taskId: number, actor: string): Promise<void> {
    const staged: { kind: string; payload: Record<string, unknown>; summary: string }[] = [];
    let res = await this.runOnce(taskId, actor, staged);
    const fail = async (error: string | undefined) => {
      this.hq.block(taskId, actor, error ?? 'исполнитель не вернул результат');
      if (!this.hq.task(taskId)!.parentId) await this.hq.alert(`Маркетинг: задача #${taskId} не выполнена: ${(error ?? '').slice(0, 200)}`);
    };
    if (!res.ok) return fail(res.error);
    this.hq.setStatus(taskId, 'review', HEAD_ID, 'проверка по чек-листу');
    let verdict = await this.review(this.hq.task(taskId)!, res.result);
    if (!verdict.ok) {
      this.hq.comment(taskId, HEAD_ID, `Ревью, замечания: ${verdict.issues.join('; ')}`);
      this.hq.setStatus(taskId, 'running', HEAD_ID, 'доработка');
      this.hq.setMeta(taskId, { feedback: verdict.issues.join('; ') });
      res = await this.runOnce(taskId, actor, staged);
      if (!res.ok) return fail(res.error);
      this.hq.setStatus(taskId, 'review', HEAD_ID, 'повторная проверка');
      verdict = await this.review(this.hq.task(taskId)!, res.result);
    }
    const warn = verdict.ok ? '' : `\nРевью отдела после доработки: ${verdict.issues.join('; ')}.`;
    this.hq.complete(taskId, actor, res.result, staged.length > 0 ? 'review' : 'done');
    for (const s of staged) await this.hq.requestApproval(taskId, actor, s.kind, s.payload, s.summary + warn);
    const t = this.hq.task(taskId)!;
    if (!t.parentId) await this.report(taskId, staged.length > 0 ? `Задача #${taskId} «${t.title}»: ${staged.length} на одобрение (придёт в пачке).` : `Задача #${taskId} «${t.title}» выполнена.`);
  }

  // ---- part-by-part editing of items (ApprovalEditor) ----
  private store() {
    return storeFor({ db: this.hq.db, now: this.hq.now });
  }

  private editable(approvalId: number) {
    const row = this.d.queue.get(approvalId);
    if (!row || row.kind !== KIND || (row.status !== 'pending' && row.status !== 'editing')) return null;
    const item = this.store().item(Number(row.payload.itemId));
    return item ? { row, item } : null;
  }

  async press(approvalId: number): Promise<string> {
    const e = this.editable(approvalId);
    if (!e) return 'Уже обработано';
    const buttons = editableParts(e.item.type).map((p) => ({ text: partLabel(e.item.type, p), data: `ce:${approvalId}:${p}` }));
    await this.d.messenger.send(this.d.ownerId, `Что править в материале #${e.item.id}? Выберите часть, следующее сообщение заменит только её.`, [buttons]);
    return 'Что править?';
  }

  async pick(approvalId: number, part: string): Promise<string> {
    const e = this.editable(approvalId);
    if (!e) return 'Уже обработано';
    const id = editableParts(e.item.type).find((p) => p === part);
    if (!id) return 'Нет такой части';
    this.store().setKv('await_edit', `${approvalId}:${id}`);
    await this.d.messenger.send(this.d.ownerId, `Пришлите новый текст для части «${partLabel(e.item.type, id)}» (материал #${e.item.id}) одним сообщением. /skip отменяет.`);
    return `Жду: ${partLabel(e.item.type, id)}`;
  }

  async consume(text: string): Promise<boolean> {
    const pending = this.store().getKv('await_edit');
    if (!pending) return false;
    this.store().setKv('await_edit', null);
    const [aid, part] = pending.split(':') as [string, PartId];
    const approvalId = Number(aid);
    const e = this.editable(approvalId);
    if (!e) {
      await this.d.messenger.send(this.d.ownerId, 'Этот материал уже обработан, правка не применена.');
      return true;
    }
    const next = replacePart(typeof e.row.payload.text === 'string' ? e.row.payload.text : e.item.text, part, text);
    if (!next) {
      this.store().setKv('await_edit', pending);
      await this.d.messenger.send(this.d.ownerId, 'Часть не изменена: текст пустой или такой части нет. Пришлите текст ещё раз или /skip.');
      return true;
    }
    this.store().setText(e.item.id, next, titleOf(next));
    await this.d.queue.applyEdit(approvalId, next);
    return true;
  }

  cancel(): void {
    this.store().setKv('await_edit', null);
  }
}
