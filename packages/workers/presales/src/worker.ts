import { readFileSync } from 'node:fs';
import { log, type Button, type KindSpec, type Payload } from '@fir/core';
import type { ApprovalState, Task, TaskApproval, Worker, WorkerCtx, WorkerResult } from '@fir/hq';
import { leadStoreFor, type Lead } from '@fir/worker-lead-intake';
import { buildDocs, draftWording, type Brief } from './docs.js';
import { guessDirection, OFFERS, priceLabel } from './offers.js';
import { splitMessage } from './split.js';
import { DOC_RU, PresalesStore, type PsDocument } from './store.js';
import { loadTemplates, type Templates } from './template.js';

/**
 * One approval for the whole pack (КП, смета, черновик договора). Locked at level 0: prices and a contract. «Утвердить»
 * only marks the documents approved: the system sends nothing, the owner sends them himself.
 */
export const KIND_PACK = 'presales_pack';
/** Same callback prefix as the Scout's «Скопировать» (`pc:<approvalId>:c`), so the Telegram glue needs no new handler. */
export const COPY_PREFIX = 'pc';

const stores = new WeakMap<object, PresalesStore>();
export function storeFor(ctx: Pick<WorkerCtx, 'db' | 'now'>): PresalesStore {
  let s = stores.get(ctx.db);
  if (!s) {
    s = new PresalesStore(ctx.db, ctx.now);
    stores.set(ctx.db, s);
  }
  return s;
}

export function packButtons(id: number): Button[][] {
  return [
    [{ text: 'Скопировать документы', data: `${COPY_PREFIX}:${id}:c` }],
    [{ text: 'Отклонить', data: `ap:${id}:r` }, { text: 'Утвердить', data: `ap:${id}:a` }],
  ];
}

/** The texts the owner gets from «Скопировать документы»: each document split at 4096 characters, in order. */
export function packMessages(p: Payload): string[] {
  const out: string[] = [];
  for (const k of ['kp', 'estimate', 'contract'] as const) {
    const body = p[k];
    if (typeof body === 'string' && body) out.push(...splitMessage(body));
  }
  return out;
}

export function kindSpecs(ctx: Pick<WorkerCtx, 'db' | 'now'>): Record<string, KindSpec> {
  return {
    [KIND_PACK]: {
      initialLevel: 0,
      locked: true,
      buttons: (id) => packButtons(id),
      execute: async (payload) => {
        const n = storeFor(ctx).decide(Number(payload.packId), 'approved');
        if (n === 0) throw new Error('no draft documents in this pack (superseded or already decided)');
      },
    },
  };
}

/** The owner rejected the pack or its execution failed: the documents follow. Call from `hq.onApprovalDecision`. */
export function onDecision(ctx: Pick<WorkerCtx, 'db' | 'now'>, link: Pick<TaskApproval, 'kind' | 'payload'>, state: ApprovalState): void {
  if (link.kind !== KIND_PACK || state === 'executed') return;
  storeFor(ctx).decide(Number(link.payload.packId), 'rejected');
}

export function briefFromLead(l: Lead): Brief {
  return { leadId: l.id, client: l.name || '____________', niche: l.niche, request: l.task };
}

export interface PresalesOptions {
  prepaymentPercent?: number;
  validDays?: number;
  /** Directory with kp.md, estimate.md, contract.md. Default: the package's own templates. */
  templatesDir?: string;
  promptFile?: string;
}

/**
 * Presales (Пресейл): a lead card (`meta.leadId`) or the owner's text (`meta.text`) becomes КП + смета + черновик договора.
 * The model writes only wording with `[цена]` marks; every number comes from `offers.ts`. One approval for the pack.
 */
export class PresalesWorker implements Worker {
  readonly id = 'presales';
  private readonly templates: Templates;
  private readonly prompt: string;
  private readonly prepaymentPercent: number;
  private readonly validDays: number;

  constructor(opts: PresalesOptions = {}) {
    this.templates = loadTemplates(opts.templatesDir ?? new URL('../templates', import.meta.url).pathname);
    this.prompt = readFileSync(opts.promptFile ?? new URL('../prompts/kp.md', import.meta.url).pathname, 'utf8');
    this.prepaymentPercent = opts.prepaymentPercent ?? 50;
    this.validDays = opts.validDays ?? 14;
  }

  async run(task: Task, ctx: WorkerCtx): Promise<WorkerResult> {
    let brief: Brief;
    let source = '';
    let service = '';
    const leadId = Number(task.meta.leadId);
    if (Number.isInteger(leadId) && leadId > 0) {
      const lead = leadStoreFor(ctx).get(leadId);
      if (!lead) return { ok: false, result: '', error: `Лид ${leadId} не найден` };
      brief = briefFromLead(lead);
      source = lead.origin;
      service = lead.service;
    } else {
      const text = typeof task.meta.text === 'string' ? task.meta.text.trim() : '';
      if (!text) return { ok: false, result: '', error: 'Нет ни номера лида, ни текста запроса' };
      brief = { leadId: null, client: '____________', niche: '', request: text };
    }
    const offer = OFFERS[guessDirection({ source, service, text: `${brief.request} ${brief.niche}` })];
    const wording = await draftWording(ctx.llm, this.prompt, brief, offer);
    const docs = buildDocs(this.templates, offer, brief, wording, { prepaymentPercent: this.prepaymentPercent, validDays: this.validDays }, ctx.now(), ctx.tz);
    const saved = storeFor(ctx).createPack(brief.leadId, offer.id, docs);
    const packId = saved[0]!.packId;
    // the numbers the sales chain needs after the approval (contract, invoice for the prepayment, the project): base price of the direction
    const prepayUsd = Math.round((offer.fromUsd * this.prepaymentPercent) / 100);
    const payload: Payload = {
      packId, leadId: brief.leadId, direction: offer.id, docIds: saved.map((d) => d.id),
      kp: saved[0]!.body, estimate: saved[1]!.body, contract: saved[2]!.body,
      client: brief.client, what: offer.title, totalUsd: offer.fromUsd, prepayUsd, prepayPercent: this.prepaymentPercent, timeline: offer.timeline,
    };
    const who = brief.leadId ? `лид #${brief.leadId} ${brief.client}` : 'по запросу владельца';
    const summary = [
      `${DOC_RU.kp}, смета и черновик договора #${packId}: ${who}`,
      `Направление: ${offer.title}, ${priceLabel(offer)}. Предоплата ${this.prepaymentPercent}%, КП действует ${this.validDays} дн.`,
      'Тексты длинные: «Скопировать документы» пришлёт их сообщениями. «Утвердить» отмечает документы утверждёнными, отправляете клиенту сами.',
      `Дальше после «Утвердить»: договор и счёт на ${this.prepaymentPercent}% ($${prepayUsd}) придут отдельными карточками, проект стартует после оплаты счёта.`,
    ].join('\n');
    await ctx.requestApproval(KIND_PACK, payload, summary);
    log('info', 'presales pack', { packId, lead: brief.leadId, direction: offer.id });
    ctx.log('pack', `pack ${packId}, lead ${brief.leadId ?? '-'}, ${offer.id}`);
    return { ok: true, result: `КП, смета и черновик договора #${packId} (${offer.title}, ${priceLabel(offer)}) готовы, ждут одобрения.` };
  }
}

export const documentsOf = (d: PsDocument[]): string => d.map((x) => `${DOC_RU[x.kind]}: ${x.status}`).join(', ');
