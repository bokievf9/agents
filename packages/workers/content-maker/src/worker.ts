import { errMsg, log, zonedParts, type KindSpec, type Payload } from '@fir/core';
import type { SubtaskSpec, Task, Worker, WorkerCtx, WorkerResult } from '@fir/hq';
import { generateItem, loadPrompts, type Prompts } from './generate.js';
import { PLATFORM_LABEL, splitPlatforms, type ItemType, type Platform } from './format.js';
import { ContentStore } from './store.js';
import { ALL_TOPICS, freeTopic, pickTopics, type Topic } from './topics.js';

export const KIND = 'content_item';
const DAY = 86_400_000;

export interface Cadence {
  /** Clip scripts a week, 1-7 (one per day, Monday first). */
  clipsPerWeek: number;
  /** 0-1 carousels a week; 0.5 = one every other week. */
  carouselsPerWeek: number;
}
export const DEFAULT_CADENCE: Cadence = { clipsPerWeek: 7, carouselsPerWeek: 0.5 };

/** ISO 8601 week number of a YYYY-MM-DD date. */
export function isoWeek(date: string): number {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dow); // the Thursday of this week decides the year
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - yearStart) / DAY + 1) / 7);
}

/**
 * Carousel rule: week w gets one when floor(w * r) > floor((w - 1) * r), r = carouselsPerWeek. For r = 0.5 that
 * is every even ISO week (one every other week), r = 1 every week, r = 0 never. No stored counter is needed.
 * (Around the 52/53-week year end the gap can stretch to three weeks.)
 */
export function hasCarousel(week: number, r: number): boolean {
  return Math.floor(week * r + 1e-9) > Math.floor((week - 1) * r + 1e-9);
}

/**
 * Pack layout: `clips` clips spread over Mon-Sun (7 clips: one every day), plus a carousel on a day without a
 * clip when there is one (Wednesday first), otherwise on Wednesday next to a clip. Sorted by day.
 */
export function buildPackPlan(weekStart: string, c: Cadence = DEFAULT_CADENCE): { type: ItemType; day: number }[] {
  const n = Math.min(7, Math.max(1, Math.round(c.clipsPerWeek)));
  const plan: { type: ItemType; day: number }[] = Array.from({ length: n }, (_, i) => ({ type: 'clip' as const, day: Math.floor((i * 7) / n) }));
  if (hasCarousel(isoWeek(weekStart), c.carouselsPerWeek)) {
    const free = [2, 3, 1, 4, 5, 0, 6].find((d) => !plan.some((p) => p.day === d));
    plan.push({ type: 'carousel', day: free ?? 2 });
  }
  return plan.sort((x, y) => x.day - y.day || (x.type === 'clip' ? -1 : 1));
}

export const TYPE_RU: Record<ItemType, string> = { clip: 'клип', carousel: 'карусель' };
export const PLATFORMS: Record<ItemType, Platform[]> = { clip: ['instagram', 'tiktok', 'shorts'], carousel: ['instagram'] };

export const ymd = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const addDays = (date: string, n: number): string => ymd(Date.parse(`${date}T00:00:00Z`) + n * DAY);
export const ddmm = (date: string): string => `${date.slice(8, 10)}.${date.slice(5, 7)}`;
const weekday = (date: string) => new Intl.DateTimeFormat('ru-RU', { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
export const dayLabel = (date: string): string => `${weekday(date)} ${ddmm(date)}`;

const stores = new WeakMap<object, ContentStore>();
/** The worker's own tables (`cm_*`) live in the shared HQ database. */
export function storeFor(ctx: Pick<WorkerCtx, 'db' | 'now'>): ContentStore {
  let s = stores.get(ctx.db);
  if (!s) {
    s = new ContentStore(ctx.db, ctx.now);
    stores.set(ctx.db, s);
  }
  return s;
}

/** Called after the owner approved a `content_item`: the item becomes ready, one row per platform. */
export function onApproved(store: ContentStore, payload: Payload, edited: boolean): void {
  const itemId = Number(payload.itemId);
  const item = store.item(itemId);
  if (!item) throw new Error(`item ${itemId} not found`);
  const text = typeof payload.text === 'string' ? payload.text : item.text;
  const { body, sections } = splitPlatforms(text);
  const rows = PLATFORMS[item.type].map((platform) => {
    const own = sections[platform];
    return { platform, text: own ? `${body}\n\n${PLATFORM_LABEL[platform]}:\n${own}` : text };
  });
  store.markReady(itemId, text, edited, rows);
}

export interface ContentWorkerOptions {
  clipsPerWeek?: number;
  carouselsPerWeek?: number;
  /** Directory with system.md, clip.md, carousel.md. Default: the package's own prompts. */
  promptsDir?: string;
  rng?: () => number;
}

/**
 * Content-maker: scripts for clips and carousels. It only writes drafts: every item is proposed through
 * `ctx.requestApproval`, the head decides when it goes to the owner. Actions (task.meta.action):
 *  - `pack`: weekly pack. `plan` makes a pack and one draft item per day, `run` fills one item (`item`).
 *  - `topic`: one item on a topic (`meta.topic`, `meta.type`).
 */
export class ContentMakerWorker implements Worker {
  readonly id = 'content-maker';
  private readonly prompts: Prompts;
  private readonly cadence: Cadence;
  private readonly rng: () => number;

  constructor(opts: ContentWorkerOptions = {}) {
    this.prompts = loadPrompts(opts.promptsDir ?? new URL('../prompts', import.meta.url).pathname);
    this.cadence = { clipsPerWeek: opts.clipsPerWeek ?? DEFAULT_CADENCE.clipsPerWeek, carouselsPerWeek: opts.carouselsPerWeek ?? DEFAULT_CADENCE.carouselsPerWeek };
    this.rng = opts.rng ?? Math.random;
  }

  /** The approval kind to register in the HQ (never promoted to level 1: every item needs the owner's button). */
  kindSpec(ctx: Pick<WorkerCtx, 'db' | 'now'>, isEdited: (approvalId: number) => boolean): KindSpec {
    return { initialLevel: 0, locked: true, execute: (payload, approvalId) => Promise.resolve(onApproved(storeFor(ctx), payload, isEdited(approvalId))) };
  }

  /** The pack covers the week starting on Monday: today when it is Monday, otherwise the next Monday. */
  weekStart(now: number, tz: string): string {
    const p = zonedParts(now, tz);
    const today = ymd(Date.UTC(p.y, p.mo - 1, p.d));
    return addDays(today, p.dow === 1 ? 0 : (8 - p.dow) % 7);
  }

  async plan(task: Task, ctx: WorkerCtx): Promise<SubtaskSpec[] | null> {
    if (task.meta.action !== 'pack') return null;
    if (!ctx.llm.enabled) throw new Error('LLM off: нет LLM_API_KEY, пакет не создан');
    const store = storeFor(ctx);
    const week = this.weekStart(ctx.now(), ctx.tz);
    if (!task.meta.force && store.packExists(week)) return [];
    const plan = buildPackPlan(week, this.cadence);
    const topics = pickTopics(store.history(), plan.length, ctx.now(), this.rng);
    const packId = store.createPack(week);
    return plan.map((p, i) => {
      const topic = topics[i]!;
      const itemId = store.insertItem({ packId, seq: i + 1, total: plan.length, type: p.type, topicKey: topic.key, topicText: topic.text, plannedDate: addDays(week, p.day) });
      store.recordTopic(topic.key);
      return { title: `Материал ${i + 1} из ${plan.length}: ${TYPE_RU[p.type]}, ${dayLabel(addDays(week, p.day))}`, meta: { action: 'item', itemId } };
    });
  }

  async run(task: Task, ctx: WorkerCtx): Promise<WorkerResult> {
    if (!ctx.llm.enabled) return { ok: false, result: '', error: 'LLM off: нет LLM_API_KEY' };
    const store = storeFor(ctx);
    let itemId = Number(task.meta.itemId) || 0;
    if (!itemId) {
      if (task.meta.action !== 'topic') return { ok: false, result: '', error: `Неизвестное действие: ${String(task.meta.action)}` };
      const m = /^(карусель|carousel)\s+/i.exec(String(task.meta.topic ?? ''));
      const type: ItemType = task.meta.type === 'carousel' || m ? 'carousel' : 'clip';
      const text = String(task.meta.topic ?? '').slice(m ? m[0].length : 0).trim().slice(0, 300);
      if (!text) return { ok: false, result: '', error: 'Не указана тема' };
      const topic = freeTopic(text);
      itemId = store.insertItem({ packId: null, seq: 1, total: 1, type, topicKey: topic.key, topicText: topic.text, plannedDate: addDays(ymd(ctx.now()), 1) });
      store.recordTopic(topic.key);
    }
    const item = store.item(itemId);
    if (!item) return { ok: false, result: '', error: `Материал ${itemId} не найден` };
    const topic: Topic = ALL_TOPICS.find((t) => t.key === item.topicKey) ?? { key: item.topicKey, directionId: null, text: item.topicText };
    const feedback = typeof task.meta.feedback === 'string' ? task.meta.feedback : '';
    try {
      const gen = await generateItem(ctx.llm, this.prompts, {
        type: item.type, topic, week: item.packId ? `с ${ddmm(item.plannedDate)}` : '', ...(feedback ? { comment: feedback, previous: item.text } : {}),
      });
      if (!gen) {
        store.setStatus(itemId, 'failed');
        return { ok: false, result: '', error: `Материал ${item.seq} из ${item.total} (${TYPE_RU[item.type]}, ${topic.text}): модель не дала валидный ответ` };
      }
      const head = `${item.packId ? `Пакет, материал ${item.seq} из ${item.total}` : 'Отдельный материал'}${feedback ? ' (вторая версия)' : ''}. ${TYPE_RU[item.type]}, ${PLATFORMS[item.type].map((p) => PLATFORM_LABEL[p]).join(' + ')}. Выход: ${dayLabel(item.plannedDate)}. Тема: ${topic.text}`;
      const warn = gen.issues.length ? `\nПроверка тона нашла: ${gen.issues.join('; ')}.` : '';
      store.setProposed(itemId, gen.text, gen.title);
      await ctx.requestApproval(KIND, { text: gen.text, itemId }, head + warn);
      ctx.log('item_drafted', `item ${itemId}`);
      return { ok: true, result: `${head}${warn}\n\n${gen.text}` };
    } catch (e) {
      store.setStatus(itemId, 'failed');
      log('error', 'item failed', { itemId, err: errMsg(e) });
      return { ok: false, result: '', error: `Материал ${itemId}: ${errMsg(e)}` };
    }
  }
}

/** One-line summary of what is ready to publish on `date`, for the daily "what do we publish today" report. */
export function todayReport(store: ContentStore, date: string): string {
  const rows = store.readyOn(date);
  const items = new Map<number, typeof rows>();
  for (const r of rows) items.set(r.itemId, [...(items.get(r.itemId) ?? []), r]);
  if (items.size === 0) return `На ${dayLabel(date)} одобренных материалов нет.`;
  const lines = [...items.entries()].map(([id, rs]) => `- ${TYPE_RU[rs[0]!.type]}, ${rs.map((r) => PLATFORM_LABEL[r.platform]).join(' + ')}: ${store.item(id)?.title ?? ''}`);
  return `На ${dayLabel(date)} к выходу (${items.size}):\n${lines.join('\n')}`;
}

/** Approved queue for the owner (`/queue`-style text). */
export function queueText(store: ContentStore): string {
  const rows = store.readyRows();
  const byItem = new Map<number, typeof rows>();
  for (const r of rows) byItem.set(r.itemId, [...(byItem.get(r.itemId) ?? []), r]);
  const lines = [...byItem.entries()].map(([itemId, rs]) => `${dayLabel(rs[0]!.plannedDate)}: ${TYPE_RU[rs[0]!.type]}, ${rs.map((r) => PLATFORM_LABEL[r.platform]).join(' + ')}. ${store.item(itemId)?.title ?? ''}`);
  const pending = store.counts().proposed;
  return [lines.length ? `Одобрено и ждёт выхода (${byItem.size}):\n${lines.join('\n')}` : 'Одобренных материалов в очереди нет.', pending ? `Ждут вашего решения: ${pending}.` : ''].filter(Boolean).join('\n');
}

export function statsText(store: ContentStore): string {
  const c = store.counts();
  return `Одобрено: ${c.ready} (с правкой: ${c.edited})\nОтклонено: ${c.rejected}\nВторых версий: ${c.regenerated}\nЖдут решения: ${c.proposed}\nНе получились: ${c.failed}`;
}
