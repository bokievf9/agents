import { parseStages, placeholderHold, usd, zonedParts, type KindSpec, type Payload } from '@fir/core';
import type { ApprovalState, SubtaskSpec, Task, TaskApproval, Worker, WorkerCtx, WorkerResult } from '@fir/hq';
import { DocStore } from './store.js';
import { DOC_RU, DOC_TYPES, fillTemplate, loadTemplate, openPlaceholders, type DocData, type DocType } from './templates.js';

export const WORKER_ID = 'documents';
export const KIND_DOC = 'bo_document';

export const storeFor = (ctx: Pick<WorkerCtx, 'db' | 'now'>): DocStore => new DocStore(ctx.db, ctx.now);

/** Facts about the client and project the head knows (from `pm_projects`); the worker itself knows no other tables. */
export interface DocContext {
  projectId: number | null;
  what: string;
  milestones: string[];
}

export interface DocumentsOptions {
  /** Project data by client name or project number; absent: the document has `[заполнить: ...]` where data is missing. */
  lookup?: (client: string) => (DocContext & { client: string }) | undefined;
  /** Another templates folder (tests). */
  templatesDir?: URL;
}

/**
 * Documents: fills a template (`templates/*.md`) with the project and client data and stages the document for the owner.
 * `meta.action` is `doc`, `meta.type` is a `DocType`, `meta.client`. No LLM: legal text is never rewritten by a model.
 * The result is a version in `bo_documents`; the owner sends the approved text himself.
 */
/** The exact price and what the client already has, when the sales chain (an approved КП) made this task; a manual `/doc` has none. */
function priceFromMeta(meta: Record<string, unknown>): Pick<DocData, 'price' | 'infra' | 'stages'> {
  const stages = parseStages(meta.stages);
  const total = Number(meta.priceUsd);
  const monthly = Number(meta.monthlyUsd);
  return {
    ...(stages ? { stages } : {}),
    ...(total > 0 ? { price: `${usd(total)}${monthly > 0 ? ` + ${usd(monthly)} в месяц` : ''}` } : {}),
    infra: { hasDomain: typeof meta.hasDomain === 'boolean' ? meta.hasDomain : null, hasHosting: typeof meta.hasHosting === 'boolean' ? meta.hasHosting : null },
  };
}

export class DocumentsWorker implements Worker {
  readonly id = WORKER_ID;
  constructor(private readonly o: DocumentsOptions = {}) {}

  async plan(): Promise<SubtaskSpec[] | null> {
    return null;
  }

  async run(task: Task, ctx: WorkerCtx): Promise<WorkerResult> {
    const type = task.meta.type as DocType;
    if (!DOC_TYPES.includes(type)) return { ok: false, result: '', error: `неизвестный тип документа, есть: ${DOC_TYPES.join(', ')}` };
    const asked = typeof task.meta.client === 'string' ? task.meta.client.trim() : '';
    const needsClient = type !== 'offer' && type !== 'privacy';
    if (needsClient && !asked) return { ok: false, result: '', error: 'нужен клиент: /doc <тип> <клиент>' };
    const found = asked ? this.o.lookup?.(asked) : undefined;
    const client = found?.client ?? asked;
    // the customer of the papers: the cabinet client's legal name and address when he filled them in (the lookups above stay by the project's own name)
    const legalLabel = typeof task.meta.legalLabel === 'string' ? task.meta.legalLabel.trim().slice(0, 500) : '';
    const store = storeFor(ctx);
    const p = zonedParts(ctx.now(), ctx.tz);
    const date = `${String(p.d).padStart(2, '0')}.${String(p.mo).padStart(2, '0')}.${p.y}`;
    const docKey = client || 'firtech.pro';
    const data: DocData = {
      // the sales chain names what is made (every product of the КП, P-08); a manual /doc takes it from the project
      client: legalLabel || client, what: (typeof task.meta.what === 'string' && task.meta.what.trim()) || found?.what || '', date, number: '',
      milestones: found?.milestones ?? [],
      ...priceFromMeta(task.meta),
    };
    // The number is the version row id, known after insert: fill twice.
    // the owner's own text of a contract (edited inside the КП pack) replaces the template; nothing edited: the template
    const edited = type === 'contract' && typeof task.meta.contractText === 'string' ? task.meta.contractText.trim() : '';
    const template = edited || loadTemplate(type, this.o.templatesDir);
    const row = store.add({ type, client: docKey, projectId: found?.projectId ?? null, text: '', taskId: task.id });
    data.number = `${p.y}-${row.id}`;
    const text = fillTemplate(template, data);
    store.setStatus(row.id, 'pending', text);
    const open = openPlaceholders(text);
    // the sales chain (КП → договор → счёт первого этапа): the cards name each other
    const chain = typeof task.meta.chain === 'string' && task.meta.chain ? `${task.meta.chain}\n` : '';
    await ctx.requestApproval(KIND_DOC, { text, docId: row.id }, `${chain}${DOC_RU[type]}, ${docKey}, версия ${row.version}. Незаполнено: ${open.length ? open.join(', ') : 'нет'}.\n\n${text}`);
    ctx.log('doc_drafted', `${type} v${row.version}`);
    return { ok: true, result: `${DOC_RU[type]} для «${docKey}», версия ${row.version}: ждёт одобрения, незаполненных мест ${open.length}.` };
  }
}

export interface DocHooks {
  /** The owner approved the document: the head hands him the text to send. */
  deliver(doc: { id: number; type: DocType; client: string; version: number; text: string }): Promise<void>;
}

/**
 * Approval kind for the head to register: contracts are always level 0 and locked. Approving a text that still has
 * `[цена]`, `[срок]` or `[заполнить: ...]` fails: the owner presses «Править» and sends the full text.
 */
export function kindSpecs(ctx: Pick<WorkerCtx, 'db' | 'now'>, hooks: DocHooks): Record<string, KindSpec> {
  return {
    [KIND_DOC]: {
      initialLevel: 0,
      locked: true,
      ready: (payload: Payload) => {
        const doc = storeFor(ctx).get(Number(payload.docId));
        return doc ? placeholderHold(openPlaceholders(typeof payload.text === 'string' ? payload.text : doc.text)) : null;
      },
      execute: async (payload: Payload) => {
        const store = storeFor(ctx);
        const doc = store.get(Number(payload.docId));
        if (!doc) throw new Error('document not found');
        const text = typeof payload.text === 'string' ? payload.text : doc.text;
        const open = openPlaceholders(text);
        if (open.length) throw new Error(`document still has placeholders: ${open.join(', ')}`);
        store.setStatus(doc.id, 'approved', text);
        await hooks.deliver({ id: doc.id, type: doc.type, client: doc.client, version: doc.version, text });
      },
    },
  };
}

/** The owner rejected the document or approval failed: the version is closed. Call from `hq.onApprovalDecision`. */
export function onDecision(ctx: Pick<WorkerCtx, 'db' | 'now'>, link: Pick<TaskApproval, 'kind' | 'payload'>, state: ApprovalState): void {
  if (link.kind !== KIND_DOC || (state !== 'rejected' && state !== 'failed')) return;
  const store = storeFor(ctx);
  const doc = store.get(Number(link.payload.docId));
  if (doc?.status === 'pending') store.setStatus(doc.id, 'rejected');
}
