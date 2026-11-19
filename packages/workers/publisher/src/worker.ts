import { zonedParts } from '@fir/core';
import type { Task, Worker, WorkerCtx, WorkerResult } from '@fir/hq';
import { PLATFORM_LABEL, dayLabel, storeFor, todayReport } from '@fir/worker-content-maker';
import { assemblePacks, groupByItem, type PublishPack, type RenderLookup, type RenderNote } from './pack.js';
import { PublishStore } from './store.js';

const ymd = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function publishDay(ctx: Pick<WorkerCtx, 'now' | 'tz'>): string {
  const p = zonedParts(ctx.now(), ctx.tz);
  return ymd(Date.UTC(p.y, p.mo - 1, p.d));
}

export interface PublisherOptions {
  /** Stage 2: rendered files. Default: none. */
  render?: RenderLookup;
  /** Stage 2: why a reel has no video yet. Default: nothing. */
  renderNote?: RenderNote;
}

/**
 * Publisher, stage 1 (manual posting). Action `publish`: assembles per-platform publish packs for approved items
 * whose planned date has arrived, text only. It does not talk to anyone: the head delivers the packs with an
 * «Опубликовано» button, and `markPublished` records the press. Nothing is ever posted automatically.
 */
export class PublisherWorker implements Worker {
  readonly id = 'publisher';

  constructor(private readonly opts: PublisherOptions = {}) {}

  /** Packs that still need a reminder today: approved, planned date arrived, not published, not yet sent today. */
  packsToSend(ctx: Pick<WorkerCtx, 'db' | 'now' | 'tz'>): PublishPack[][] {
    const today = publishDay(ctx);
    const store = new PublishStore(ctx.db);
    return groupByItem(assemblePacks(ctx, today, this.opts.render, this.opts.renderNote).filter((p) => store.get(p.readyId)?.sentOn !== today));
  }

  /** The head calls this after a pack message went out. */
  markSent(ctx: Pick<WorkerCtx, 'db' | 'now' | 'tz'>, group: PublishPack[]): void {
    const store = new PublishStore(ctx.db);
    for (const p of group) store.markSent(p.readyId, p.itemId, p.platform, publishDay(ctx));
  }

  /** The owner pressed «Опубликовано» for one platform's row. */
  markPublished(ctx: Pick<WorkerCtx, 'db' | 'now'>, readyId: number): { ok: boolean; text: string } {
    const content = storeFor(ctx);
    const row = content.readyRow(readyId);
    if (!row) return { ok: false, text: 'Не нашёл материал' };
    if (row.status === 'published') return { ok: false, text: 'Уже отмечено' };
    const fresh = new PublishStore(ctx.db).markPublished(readyId, row.itemId, row.platform, ctx.now());
    content.markPublished(readyId);
    return { ok: fresh, text: `Отмечено: ${PLATFORM_LABEL[row.platform]}` };
  }

  run(task: Task, ctx: WorkerCtx): Promise<WorkerResult> {
    if (task.meta.action !== 'daily' && task.meta.action !== 'publish') return Promise.resolve({ ok: false, result: '', error: `Неизвестное действие: ${String(task.meta.action)}` });
    const today = publishDay(ctx);
    const packs = assemblePacks(ctx, today, this.opts.render, this.opts.renderNote);
    const head = todayReport(storeFor(ctx), today);
    if (packs.length === 0) return Promise.resolve({ ok: true, result: head });
    const items = groupByItem(packs);
    const lines = items.map((g) => `- ${g[0]!.title || 'без названия'}: ${g.map((p) => PLATFORM_LABEL[p.platform]).join(' + ')}${g[0]!.plannedDate < today ? ` (с ${dayLabel(g[0]!.plannedDate)})` : ''}`);
    return Promise.resolve({ ok: true, result: `${head}\n\nПакеты публикации (${packs.length} платформ, ${items.length} материалов, вручную, кнопка «Опубликовано»):\n${lines.join('\n')}` });
  }
}
