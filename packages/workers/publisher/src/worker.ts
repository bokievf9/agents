import { existsSync } from 'node:fs';
import { errMsg, log, zonedParts } from '@fir/core';
import type { Task, Worker, WorkerCtx, WorkerResult } from '@fir/hq';
import { PLATFORM_LABEL, dayLabel, storeFor, todayReport } from '@fir/worker-content-maker';
import { assemblePacks, groupByItem, isVideo, type PublishPack, type RenderLookup, type RenderNote } from './pack.js';
import { PostPending, type PlatformPoster } from './poster.js';
import { PublishStore } from './store.js';
import { QuotaExceeded } from './youtube.js';

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
  /** Stage 2: real API posters by platform (YouTube only for now). Without one a platform stays manual. */
  posters?: PlatformPoster[];
  /** Tests: does the video file exist. */
  fileExists?: (path: string) => boolean;
}

/** What one morning auto-posting run did with one pack. */
export interface AutoResult {
  readyId: number;
  itemId: number;
  platform: PublishPack['platform'];
  title: string;
  /** Set when the pack was posted. */
  url?: string;
  /** Set when posting failed (the manual flow shows it). */
  error?: string;
  /** The day's quota is spent: manual for the rest. */
  quota?: boolean;
  /** Accepted by the platform, finishes on the next run (a Reel still processing). */
  pending?: boolean;
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

  /**
   * The morning run, before the owner's messages: every approved, due, not yet published pack of a platform that has a
   * poster and whose MP4 exists is posted (one try per row per day, never retried blindly). Posted rows are marked published
   * exactly as the owner's button would; a failure leaves the row `ready` with the reason in `pb_posts.error`. Rows without
   * a file, and other platforms, are untouched.
   */
  async autoPublish(ctx: Pick<WorkerCtx, 'db' | 'now' | 'tz'>): Promise<AutoResult[]> {
    const posters = this.opts.posters ?? [];
    if (posters.length === 0) return [];
    const today = publishDay(ctx);
    const store = new PublishStore(ctx.db);
    const content = storeFor(ctx);
    const exists = this.opts.fileExists ?? existsSync;
    const out: AutoResult[] = [];
    for (const p of assemblePacks(ctx, today, this.opts.render, this.opts.renderNote)) {
      const poster = posters.find((x) => x.platform === p.platform);
      if (!poster || !(poster.canPost ? poster.canPost(p) : p.files.some(isVideo)) || p.files.length === 0 || !p.files.every((f) => exists(f))) continue;
      const prev = store.get(p.readyId);
      // a container waiting at the platform is finished on a later day too (it is the same attempt)
      if (prev?.publishedAt != null || (store.auto(p.readyId).autoOn === today && store.container(p.readyId) === null)) continue;
      const base = { readyId: p.readyId, itemId: p.itemId, platform: p.platform, title: p.title };
      store.markAttempt(p.readyId, p.itemId, p.platform, today);
      try {
        const { url } = await poster.post(p);
        store.setUrl(p.readyId, url);
        store.markPublished(p.readyId, p.itemId, p.platform, ctx.now());
        content.markPublished(p.readyId);
        out.push({ ...base, url });
      } catch (e) {
        if (e instanceof PostPending) {
          out.push({ ...base, pending: true });
          continue;
        }
        const quota = e instanceof QuotaExceeded;
        const error = errMsg(e);
        store.setError(p.readyId, error);
        log('warn', 'publisher: auto post failed', { readyId: p.readyId, platform: p.platform, err: error });
        out.push({ ...base, error, ...(quota ? { quota: true } : {}) });
      }
    }
    return out;
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
