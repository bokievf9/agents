import { readFileSync } from 'node:fs';
import { detectInfrastructure, log, usd, type Button, type KindSpec, type Payload } from '@fir/core';
import type { ApprovalState, Task, TaskApproval, Worker, WorkerCtx, WorkerResult } from '@fir/hq';
import { leadStoreFor, legalLabel, legalPartyOfLead, type Lead } from '@fir/worker-lead-intake';
import { buildDocs, draftWording, exactLabel, PILOT_DIRECTIONS, stagesOf, type Brief } from './docs.js';
import { builderEstimate } from './estimate.js';
import { bundleOffer, guessDirection, OFFERS } from './offers.js';
import { builderTotal, quotePackage } from './package.js';
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
  return { leadId: l.id, client: l.name || '____________', niche: l.niche, request: l.task, estimate: l.estimate, hasDomain: l.hasDomain, hasHosting: l.hasHosting, ...(l.enrichment?.builderLink ? { builderLink: l.enrichment.builderLink } : {}) };
}

export interface PresalesOptions {
  /** Days a КП stands: a number, or a function read at every КП (the owner changes it in the settings without a restart). */
  validDays?: number | (() => number);
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
  private readonly validDaysOf: number | (() => number);
  private get validDays(): number {
    return typeof this.validDaysOf === 'function' ? this.validDaysOf() : this.validDaysOf;
  }

  constructor(opts: PresalesOptions = {}) {
    this.templates = loadTemplates(opts.templatesDir ?? new URL('../templates', import.meta.url).pathname);
    this.prompt = readFileSync(opts.promptFile ?? new URL('../prompts/kp.md', import.meta.url).pathname, 'utf8');
    this.validDaysOf = opts.validDays ?? 14;
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
      // the customer of the КП is the legal name the cabinet client gave (with the address), else the lead's name
      const party = legalPartyOfLead(ctx.db, lead.id);
      if (party) brief.client = legalLabel(party);
      const assumed = Array.isArray(task.meta.assumptions) ? task.meta.assumptions.filter((x): x is string => typeof x === 'string' && x.trim() !== '').slice(0, 6) : [];
      if (assumed.length) brief.assumptions = assumed;
      source = lead.origin;
      service = lead.service;
    } else {
      const text = typeof task.meta.text === 'string' ? task.meta.text.trim() : '';
      if (!text) return { ok: false, result: '', error: 'Нет ни номера лида, ни текста запроса' };
      brief = { leadId: null, client: '____________', niche: '', request: text, estimate: '', ...detectInfrastructure(text) };
    }
    // a builder estimate (several products and extras the client combined) is the price of the КП: the site's quote is the source of truth; without one, one direction from the words
    const built = builderEstimate({ estimate: brief.estimate, request: brief.request, link: brief.builderLink });
    const guessed = OFFERS[guessDirection({ source, service, text: `${brief.request} ${brief.niche} ${brief.estimate ?? ''}` })];
    const offer = built ? bundleOffer(built.directions, guessed) : guessed;
    const quote = built ? built.quote : quotePackage(offer.id, offer.title, `${brief.request} ${brief.niche} ${brief.estimate ?? ''}`);
    const wording = await draftWording(ctx.llm, this.prompt, brief, offer);
    // the pilot block of a flagship's КП: only when the package asks for it (`meta.pilot: true`, set by the owner), never by itself
    const pilot = task.meta.pilot === true && PILOT_DIRECTIONS.includes(offer.id);
    const docs = buildDocs(this.templates, offer, quote, brief, wording, { validDays: this.validDays }, ctx.now(), ctx.tz, { pilot });
    const saved = storeFor(ctx).createPack(brief.leadId, offer.id, docs);
    const packId = saved[0]!.packId;
    // the numbers the sales chain needs after the approval (contract, invoice for the prepayment, the project): the exact price of the package
    const stages = stagesOf(offer, quote);
    const prepayUsd = stages[0]!.amountUsd;
    const payload: Payload = {
      // P-08: every product of the package travels with it (the most expensive first), not only the direction of the main one
      packId, leadId: brief.leadId, direction: offer.id, directions: built?.directions.length ? built.directions : [offer.id], docIds: saved.map((d) => d.id),
      kp: saved[0]!.body, estimate: saved[1]!.body, contract: saved[2]!.body,
      client: brief.client, what: offer.title, totalUsd: quote.totalUsd, stages, prepayUsd, prepayPercent: stages[0]!.share, timeline: offer.timeline,
      ...(quote.monthlyUsd ? { monthlyUsd: quote.monthlyUsd } : {}),
      ...(PILOT_DIRECTIONS.includes(offer.id) ? { pilot } : {}),
      ...(brief.hasDomain != null ? { hasDomain: brief.hasDomain } : {}), ...(brief.hasHosting != null ? { hasHosting: brief.hasHosting } : {}),
    };
    const who = brief.leadId ? `лид #${brief.leadId} ${brief.client}` : 'по запросу владельца';
    // a lead from a signed-in cabinet gets the КП in his cabinet when the owner approves it (Cabinet v3); the card says so
    let cabinet = false;
    if (brief.leadId !== null) {
      try {
        cabinet = (ctx.db.prepare('SELECT client_id FROM li_leads WHERE id = ?').get(brief.leadId) as { client_id: number | null } | undefined)?.client_id != null;
      } catch {
        /* an older table without the column: no cabinet */
      }
    }
    // the client's own builder total is only compared, never used as a price: the lead form is public
    const seen = builderTotal(brief.estimate ?? '');
    const mismatch = seen !== null && seen !== quote.totalUsd ? ` Внимание: в конструкторе клиент видел итог ${usd(seen)}, в КП ${usd(quote.totalUsd)}: сверьте состав.` : '';
    const priced = built
      ? ` Цена взята из сметы конструктора (${built.source === 'link' ? 'по ссылке сборки, цены каталога сайта' : 'присланная сметой клиента'}).`
        + `${built.estimateTotalUsd !== null ? ` Внимание: в смете клиента ${usd(built.estimateTotalUsd)}, по ссылке сборки ${usd(quote.totalUsd)}, берём ссылку: сверьте состав.` : ''}`
        + `${built.onRequest.length ? ` По смете, без цены (в сумму не входит): ${built.onRequest.join(', ')}.` : ''}`
      : '';
    const summary = [
      `${DOC_RU.kp}, смета и черновик договора #${packId}: ${who}`,
      `Направление: ${offer.title}, цена ${exactLabel(quote)}${quote.lines.length > 1 ? ` (${quote.lines.map((l) => l.label).join(' + ')})` : ''}. Оплата по этапам (${stages.map((x) => `${x.no}: ${usd(x.amountUsd)}`).join(', ')}), каждый до его начала. КП действует ${this.validDays} дн.${mismatch}${priced}`,
      'Тексты длинные: «Скопировать документы» пришлёт их сообщениями.',
      ...(cabinet
        ? [
          '«Утвердить» отправляет КП и смету клиенту в кабинет и на почту (отправлять самому не нужно).',
          `Дальше: договор придёт карточкой, когда клиент примет КП; счёт на первый этап (${usd(prepayUsd)}), когда клиент подпишет договор; проект стартует после оплаты первого этапа, каждый следующий счёт после приёмки предыдущего этапа.`,
        ]
        : [
          '«Утвердить» отмечает документы утверждёнными, отправляете клиенту сами.',
          `Дальше после «Утвердить»: договор и счёт на первый этап (${usd(prepayUsd)}) придут отдельными карточками, проект стартует после оплаты первого этапа, каждый следующий счёт после приёмки предыдущего этапа.`,
        ]),
    ].join('\n');
    await ctx.requestApproval(KIND_PACK, payload, summary);
    log('info', 'presales pack', { packId, lead: brief.leadId, direction: offer.id });
    ctx.log('pack', `pack ${packId}, lead ${brief.leadId ?? '-'}, ${offer.id}`);
    return { ok: true, result: `КП, смета и черновик договора #${packId} (${offer.title}, ${exactLabel(quote)}) готовы, ждут одобрения.` };
  }
}

export const documentsOf = (d: PsDocument[]): string => d.map((x) => `${DOC_RU[x.kind]}: ${x.status}`).join(', ');
