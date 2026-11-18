import { log, type Button, type KindSpec, type Payload } from '@fir/core';
import type { TaskApproval, ApprovalState, Task, Worker, WorkerCtx, WorkerResult } from '@fir/hq';
import { draftFirst, draftFollowup, draftReply, loadPrompts, PLACEHOLDER, type Prompts } from './draft.js';
import { offerFor, priceLabel } from './offers.js';
import { FOLLOWUP_DAYS, ProspectStore, STATUSES, STATUS_RU, type DraftKind, type Prospect } from './store.js';

/**
 * Approval kinds of the Scout. All three are locked at level 0: a first message carries a price, a reply may carry
 * one, and "approve" here only records that the owner sent the text himself (nothing is sent by the system), so an
 * automatic level 1 would mean a false "sent". The owner's buttons are «Скопировать / Править / Пропустить / Отправлено».
 */
export const KIND_FIRST = 'prospect_first';
export const KIND_FOLLOWUP = 'prospect_followup';
export const KIND_REPLY = 'prospect_reply';
export const PROSPECT_KINDS = [KIND_FIRST, KIND_FOLLOWUP, KIND_REPLY] as const;
const KIND_OF: Record<DraftKind, string> = { first: KIND_FIRST, followup: KIND_FOLLOWUP, reply: KIND_REPLY };

/** Callback prefix of the «Скопировать» button (`pc:<approvalId>:c`); the other three use the core's `ap:` data. */
export const COPY_PREFIX = 'pc';

const stores = new WeakMap<object, ProspectStore>();
/** The worker's own tables (`pr_*`) live in the shared HQ database. */
export function storeFor(ctx: Pick<WorkerCtx, 'db' | 'now'>): ProspectStore {
  let s = stores.get(ctx.db);
  if (!s) {
    s = new ProspectStore(ctx.db, ctx.now);
    stores.set(ctx.db, s);
  }
  return s;
}

export const contactLines = (p: Prospect): string[] =>
  [
    p.telegram && `Telegram: ${p.telegram}`,
    p.instagram && `Instagram: ${p.instagram}`,
    p.phone && `Телефон: ${p.phone}`,
    p.website && `Сайт: ${p.website}`,
  ].filter((x): x is string => Boolean(x));

const cardTitle = (p: Prospect, kind: DraftKind): string =>
  kind === 'first'
    ? `#${p.id} ${p.name}`
    : kind === 'followup'
      ? `Дожим ${p.followups} (через ${FOLLOWUP_DAYS[p.followups - 1] ?? '?'} дн.) #${p.id} ${p.name}`
      : `Ответ на реплику #${p.id} ${p.name}`;

/** What the owner reads above the draft: business, niche, contacts, the offer with its price. */
export function renderSummary(p: Prospect, kind: DraftKind, draft: string): string {
  const offer = offerFor(p.offer);
  const head = [
    cardTitle(p, kind),
    `${p.niche} · ${p.city}`,
    ...contactLines(p),
    kind === 'first' ? `Предложение: ${offer.title}, ${priceLabel(offer)}` : '',
  ].filter(Boolean);
  const warn = PLACEHOLDER.test(draft) ? '\n\nВ тексте метка [цена] или [срок]: нажмите «Править» и вставьте цифры, иначе «Отправлено» не сработает.' : '';
  return `${head.join('\n')}${warn}\nОтправляете сами: «Скопировать», потом «Отправлено».`;
}

/** The four buttons of a card. */
export function cardButtons(id: number): Button[][] {
  return [
    [{ text: 'Скопировать', data: `${COPY_PREFIX}:${id}:c` }, { text: 'Править', data: `ap:${id}:e` }],
    [{ text: 'Пропустить', data: `ap:${id}:r` }, { text: 'Отправлено', data: `ap:${id}:a` }],
  ];
}

/** Owner's `/reply <id>`: the prospect answered. Moves sent / no_reply to replied. */
export function markReplied(store: ProspectStore, id: number): { ok: true; prospect: Prospect } | { ok: false; reason: 'unknown' | 'status'; prospect?: Prospect } {
  const p = Number.isInteger(id) ? store.get(id) : undefined;
  if (!p) return { ok: false, reason: 'unknown' };
  if (p.status === 'sent' || p.status === 'no_reply') {
    store.transition(p.id, 'replied');
    store.clearDraft(p.id);
  } else if (p.status !== 'replied') return { ok: false, reason: 'status', prospect: p };
  return { ok: true, prospect: store.get(p.id)! };
}

export function statsText(store: ProspectStore): string {
  const s = store.stats();
  const line = (b: Record<string, number>) => STATUSES.filter((k) => b[k]).map((k) => `${STATUS_RU[k]} ${b[k]}`).join(', ') || 'пусто';
  return [`Воронка, всего ${s.total}: ${line(s.byStatus)}`, '', 'По нишам:', ...s.byNiche.map((n) => `${n.niche} (${n.total}): ${line(n.byStatus)}`)].join('\n');
}

/** Approval kinds of the Scout for the head to register: «Отправлено» records the send, buttons are the card's. */
export function kindSpecs(ctx: Pick<WorkerCtx, 'db' | 'now'>): Record<string, KindSpec> {
  const spec = (draftKind: DraftKind): KindSpec => ({
    initialLevel: 0,
    locked: true,
    buttons: (id) => cardButtons(id),
    execute: async (payload: Payload) => {
      const store = storeFor(ctx);
      const text = typeof payload.text === 'string' ? payload.text : '';
      if (!text) throw new Error('empty draft');
      if (PLACEHOLDER.test(text)) throw new Error('draft still has [цена] / [срок]');
      const id = Number(payload.prospectId);
      if (draftKind === 'first' && store.get(id)?.status === 'proposed') {
        store.transition(id, 'sent');
        store.setSentText(id, text);
      }
      store.clearDraft(id);
    },
  });
  return { [KIND_FIRST]: spec('first'), [KIND_FOLLOWUP]: spec('followup'), [KIND_REPLY]: spec('reply') };
}

/** The owner rejected («Пропустить») or the execution failed: the prospect follows. Call from `hq.onApprovalDecision`. */
export function onDecision(ctx: Pick<WorkerCtx, 'db' | 'now'>, link: Pick<TaskApproval, 'kind' | 'payload'>, state: ApprovalState): void {
  if (!(PROSPECT_KINDS as readonly string[]).includes(link.kind)) return;
  const store = storeFor(ctx);
  const id = Number(link.payload.prospectId);
  const p = store.get(id);
  if (!p) return;
  if (state === 'rejected') {
    if (link.kind === KIND_FIRST && p.status === 'proposed') store.transition(id, 'skipped');
    store.clearDraft(id);
  } else if (state === 'failed') {
    if (link.kind === KIND_FIRST) store.release(id);
    else store.clearDraft(id);
  }
}

export interface ProspectorOptions {
  /** New cards per batch when the task does not say (`meta.limit`). */
  batchSize?: number;
  /** Directory with first.md, followup.md, reply.md. Default: the package's own prompts. */
  promptsDir?: string;
}

/**
 * Prospector (Разведчик): prepares first messages, follow-ups and reply drafts for businesses. It never writes to
 * anybody: every draft goes through `ctx.requestApproval` and the owner sends it himself. Actions (task.meta.action):
 *  - `batch`: up to `meta.limit` (default `batchSize`) new cards by niche priority.
 *  - `followups`: closes silent prospects (no_reply) and prepares follow-ups 3 and 7 days after sending.
 *  - `reply`: a business answered (`meta.prospectId`, `meta.replyText`): a draft answer with the two call slots.
 */
export class ProspectorWorker implements Worker {
  readonly id = 'prospector';
  private readonly prompts: Prompts;
  private readonly batchSize: number;

  constructor(opts: ProspectorOptions = {}) {
    this.prompts = loadPrompts(opts.promptsDir ?? new URL('../prompts', import.meta.url).pathname);
    this.batchSize = opts.batchSize ?? 10;
  }

  private async propose(ctx: WorkerCtx, p: Prospect, kind: DraftKind, draft: string): Promise<void> {
    await ctx.requestApproval(KIND_OF[kind], { text: draft, prospectId: p.id, draftKind: kind }, renderSummary(p, kind, draft));
  }

  async run(task: Task, ctx: WorkerCtx): Promise<WorkerResult> {
    const store = storeFor(ctx);
    const action = task.meta.action;
    if (action === 'batch') {
      const limit = Math.max(0, Math.floor(Number(task.meta.limit ?? this.batchSize)));
      const fresh = store.pickNew(limit);
      for (const p of fresh) {
        const draft = await draftFirst(ctx.llm, this.prompts, p);
        store.transition(p.id, 'proposed');
        store.setDraft(p.id, 'first', draft);
        await this.propose(ctx, store.get(p.id)!, 'first', draft);
      }
      const left = store.stats().byStatus.new;
      log('info', 'prospector batch', { proposed: fresh.length, left });
      ctx.log('batch', `cards ${fresh.length}, left ${left}`);
      return { ok: true, result: `Новых карточек ${fresh.length}. Осталось новых в базе: ${left}.${left === 0 && fresh.length === 0 ? ' База пуста: загрузите CSV (import-prospects).' : ''}` };
    }
    if (action === 'followups') {
      const closed = store.expireNoReply(ctx.now());
      const due = store.dueFollowups(ctx.now());
      for (const p of due) {
        const stage = (p.followups + 1) as 1 | 2;
        const draft = await draftFollowup(ctx.llm, this.prompts, p, stage, p.sentText ?? '');
        store.bumpFollowups(p.id);
        store.setDraft(p.id, 'followup', draft);
        await this.propose(ctx, store.get(p.id)!, 'followup', draft);
      }
      log('info', 'prospector followups', { followups: due.length, closed });
      ctx.log('followups', `followups ${due.length}, closed ${closed}`);
      return { ok: true, result: `Дожимов ${due.length}${closed ? `, закрыто без ответа ${closed}` : ''}.` };
    }
    if (action === 'reply') {
      const p = store.get(Number(task.meta.prospectId));
      const text = typeof task.meta.replyText === 'string' ? task.meta.replyText.trim() : '';
      if (!p) return { ok: false, result: '', error: `Бизнес ${String(task.meta.prospectId)} не найден` };
      if (!text) return { ok: false, result: '', error: 'Нет текста ответа бизнеса' };
      const draft = await draftReply(ctx.llm, this.prompts, p, p.sentText ?? '', text);
      store.setDraft(p.id, 'reply', draft);
      await this.propose(ctx, p, 'reply', draft);
      ctx.log('reply_drafted', `prospect ${p.id}`);
      return { ok: true, result: `Черновик ответа для #${p.id} ${p.name} готов.` };
    }
    return { ok: false, result: '', error: `Неизвестное действие: ${String(action)}` };
  }
}
