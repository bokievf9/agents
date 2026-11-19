import { errMsg, log, zonedParts, type KindSpec, type Payload } from '@fir/core';
import type { SubtaskSpec, Task, Worker, WorkerCtx, WorkerResult } from '@fir/hq';
import { fill, generateItem, loadPrompts, noTrends, type Prompts, type TrendHint, type TrendsProvider } from './generate.js';
import { PLATFORM_LABEL, splitPlatforms, type ItemType, type Platform } from './format.js';
import { ContentStore } from './store.js';
import { ALL_TOPICS, freeTopic, pickFormatTopics, pickTopics, type Topic } from './topics.js';
import { renderItem } from './render.js';
import { articleSchema, articleSummary, articlePreview, contentIssues, ruPartSchema, contentSchema, type ArticleJson } from './article.js';
import { findNiche, TOPIC_NICHES, nicheById } from './niches.js';
import { tryJson } from '@fir/core';
import { z } from 'zod';

export const KIND = 'content_item';
export const ARTICLE_KIND = 'article';
const DAY = 86_400_000;

export interface Cadence {
  /** Reel scripts a week, 1-7 (one per day, Monday first). */
  clipsPerWeek: number;
  /** Carousels a week, 0-7 (a fraction works: 0.5 = one every other week). */
  carouselsPerWeek: number;
  /** Single static posts a week, 0-7. */
  postsPerWeek: number;
  /** Stories series a week, 0-7. */
  storiesPerWeek: number;
}
export const DEFAULT_CADENCE: Cadence = { clipsPerWeek: 7, carouselsPerWeek: 2, postsPerWeek: 3, storiesPerWeek: 5 };

/** ISO 8601 week number of a YYYY-MM-DD date. */
export function isoWeek(date: string): number {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dow); // the Thursday of this week decides the year
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - yearStart) / DAY + 1) / 7);
}

/**
 * How many carousels week w gets: floor(w * r) - floor((w - 1) * r), r = carouselsPerWeek. For r = 0.5 that is one in
 * every even ISO week, r = 2 two every week, r = 0 none. No stored counter is needed.
 * (Around the 52/53-week year end the gap of a fractional rate can stretch to three weeks.)
 */
export function carouselCount(week: number, r: number): number {
  return Math.floor(week * r + 1e-9) - Math.floor((week - 1) * r + 1e-9);
}
export const hasCarousel = (week: number, r: number): boolean => carouselCount(week, r) > 0;

/** `n` days spread over Mon-Sun starting from `offset`, never past Sunday. */
const spread = (n: number, offset = 0): number[] => Array.from({ length: n }, (_, i) => Math.min(6, offset + Math.floor((i * 7) / n)));

const TYPE_ORDER: ItemType[] = ['clip', 'post', 'carousel', 'story', 'profile'];

/**
 * Pack layout for the Instagram page (7 reels, 3 posts, 2 carousels, 5 stories by default): reels one every day,
 * posts on Mon, Wed, Fri, carousels on Tue and Fri, stories on the five days Mon, Tue, Wed, Fri, Sat. Sorted by day,
 * inside a day reel, post, carousel, story.
 */
export function buildPackPlan(weekStart: string, c: Cadence = DEFAULT_CADENCE): { type: ItemType; day: number }[] {
  const clean = (v: number, min: number) => Math.min(7, Math.max(min, Math.round(v)));
  const plan: { type: ItemType; day: number }[] = [
    ...spread(clean(c.clipsPerWeek, 1)).map((day) => ({ type: 'clip' as const, day })),
    ...spread(clean(c.postsPerWeek, 0)).map((day) => ({ type: 'post' as const, day })),
    ...spread(clean(carouselCount(isoWeek(weekStart), c.carouselsPerWeek), 0), 1).map((day) => ({ type: 'carousel' as const, day })),
    ...spread(clean(c.storiesPerWeek, 0)).map((day) => ({ type: 'story' as const, day })),
  ];
  return plan.sort((x, y) => x.day - y.day || TYPE_ORDER.indexOf(x.type) - TYPE_ORDER.indexOf(y.type));
}

export const TYPE_RU: Record<ItemType, string> = { clip: 'клип', carousel: 'карусель', post: 'пост', story: 'история', profile: 'профиль' };
export const PLATFORMS: Record<ItemType, Platform[]> = {
  clip: ['instagram', 'tiktok', 'shorts'], carousel: ['instagram'], post: ['instagram'], story: ['instagram'], profile: ['instagram'],
};
/** Types that go out as pictures: rendered to PNG on approval. */
export const IMAGE_TYPES: ItemType[] = ['post', 'carousel', 'story', 'profile'];

export const ymd = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const addDays = (date: string, n: number): string => ymd(Date.parse(`${date}T00:00:00Z`) + n * DAY);
export const ddmm = (date: string): string => `${date.slice(8, 10)}.${date.slice(5, 7)}`;
const weekday = (date: string) => new Intl.DateTimeFormat('ru-RU', { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
export const dayLabel = (date: string): string => `${weekday(date)} ${ddmm(date)}`;

/** «карусель ...», «пост ...», «история ...», «рилс ...» in front of a free topic picks the type. */
const PREFIX_RE = /^(карусель|carousel|пост|post|история|stories|story|рилс|reel|клип)\s+/i;
const PREFIX_TYPE: Record<string, ItemType> = { 'карусель': 'carousel', carousel: 'carousel', 'пост': 'post', post: 'post', 'история': 'story', stories: 'story', story: 'story', 'рилс': 'clip', reel: 'clip', 'клип': 'clip' };

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
  postsPerWeek?: number;
  storiesPerWeek?: number;
  /** Where rendered PNG files go (`<dir>/<itemId>/<n>.png`, normally `DATA_DIR/renders`). Absent: nothing is rendered. */
  rendersDir?: string;
  /** Directory with system.md, clip.md, carousel.md. Default: the package's own prompts. */
  promptsDir?: string;
  rng?: () => number;
  /** Fresh niche trends for the prompt (the Trend scout's latest items). Default: none. */
  trends?: TrendsProvider;
}

/** Up to two trends for a topic: the ones suggested for its direction first, then the top of the list. */
export function pickTrends(all: TrendHint[], directionId: string | null): TrendHint[] {
  const own = directionId ? all.filter((t) => t.direction === directionId) : [];
  return [...own, ...all.filter((t) => !own.includes(t))].slice(0, 2);
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
  private readonly trends: TrendsProvider;
  private readonly rendersDir: string | undefined;

  constructor(opts: ContentWorkerOptions = {}) {
    this.prompts = loadPrompts(opts.promptsDir ?? new URL('../prompts', import.meta.url).pathname);
    this.cadence = {
      clipsPerWeek: opts.clipsPerWeek ?? DEFAULT_CADENCE.clipsPerWeek, carouselsPerWeek: opts.carouselsPerWeek ?? DEFAULT_CADENCE.carouselsPerWeek,
      postsPerWeek: opts.postsPerWeek ?? DEFAULT_CADENCE.postsPerWeek, storiesPerWeek: opts.storiesPerWeek ?? DEFAULT_CADENCE.storiesPerWeek,
    };
    this.rendersDir = opts.rendersDir;
    this.rng = opts.rng ?? Math.random;
    this.trends = opts.trends ?? noTrends;
  }

  /** The approval kind to register in the HQ (never promoted to level 1: every item needs the owner's button). */
  kindSpec(ctx: Pick<WorkerCtx, 'db' | 'now'>, isEdited: (approvalId: number) => boolean): KindSpec {
    return {
      initialLevel: 0, locked: true,
      execute: async (payload, approvalId) => {
        const store = storeFor(ctx);
        onApproved(store, payload, isEdited(approvalId));
        await this.renderApproved(store, Number(payload.itemId));
      },
    };
  }

  /**
   * Posts, carousel slides, story frames and highlight covers become PNG files on approval. A failure (fonts, native
   * module) never blocks the approval: the item stays ready without files and the publisher says «только текст».
   */
  async renderApproved(store: ContentStore, itemId: number): Promise<string[]> {
    const item = store.item(itemId);
    if (!item || !this.rendersDir || !IMAGE_TYPES.includes(item.type)) return [];
    try {
      const files = await renderItem(this.rendersDir, itemId, item.type, item.text);
      store.setFiles(itemId, files);
      return files;
    } catch (e) {
      log('error', 'render failed, the item stays text only', { itemId, err: errMsg(e) });
      return [];
    }
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
    const classic = plan.filter((p) => p.type === 'clip' || p.type === 'carousel').length;
    const classicTopics = pickTopics(store.history(), classic, ctx.now(), this.rng);
    const formatTopics = pickFormatTopics(store.history(), plan.length - classic, this.rng);
    const packId = store.createPack(week);
    return plan.map((p, i) => {
      const topic = (p.type === 'clip' || p.type === 'carousel' ? classicTopics : formatTopics).shift()!;
      const itemId = store.insertItem({ packId, seq: i + 1, total: plan.length, type: p.type, topicKey: topic.key, topicText: topic.text, plannedDate: addDays(week, p.day) });
      store.recordTopic(topic.key);
      return { title: `Материал ${i + 1} из ${plan.length}: ${TYPE_RU[p.type]}, ${dayLabel(addDays(week, p.day))}`, meta: { action: 'item', itemId } };
    });
  }

  async run(task: Task, ctx: WorkerCtx): Promise<WorkerResult> {
    if (!ctx.llm.enabled) return { ok: false, result: '', error: 'LLM off: нет LLM_API_KEY' };
    if (task.meta.action === 'article') return this.runArticle(task, ctx);
    const store = storeFor(ctx);
    let itemId = Number(task.meta.itemId) || 0;
    if (!itemId && task.meta.action === 'profile') {
      itemId = store.insertItem({ packId: null, seq: 1, total: 1, type: 'profile', topicKey: 'profile:setup', topicText: 'Оформление профиля Instagram', plannedDate: addDays(ymd(ctx.now()), 1) });
    } else if (!itemId) {
      if (task.meta.action !== 'topic') return { ok: false, result: '', error: `Неизвестное действие: ${String(task.meta.action)}` };
      const m = PREFIX_RE.exec(String(task.meta.topic ?? ''));
      const type: ItemType = m ? PREFIX_TYPE[m[1]!.toLowerCase()]! : (['carousel', 'post', 'story'] as const).find((t) => t === task.meta.type) ?? 'clip';
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
    let trends: TrendHint[] = [];
    try {
      trends = item.type === 'clip' || item.type === 'carousel' ? pickTrends(this.trends({ db: ctx.db, now: ctx.now }), topic.directionId) : [];
    } catch (e) {
      log('warn', 'trends provider failed, continuing without trends', { err: errMsg(e) });
    }
    try {
      const gen = await generateItem(ctx.llm, this.prompts, {
        type: item.type, topic, week: item.packId ? `с ${ddmm(item.plannedDate)}` : '', ...(feedback ? { comment: feedback, previous: item.text } : {}), ...(trends.length ? { trends } : {}),
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

  /**
   * `article`: one blog article. `meta.niche` (id or a name fragment) picks the niche, otherwise the first niche without
   * an article. `meta.articleId` + `meta.feedback`: a rework of a row the owner sent back. RU first, then the English
   * version from it, each as strict JSON with the site's rules checked; one repair pass per language.
   */
  async runArticle(task: Task, ctx: WorkerCtx): Promise<WorkerResult> {
    const store = storeFor(ctx);
    let id = Number(task.meta.articleId) || 0;
    let nicheId = id ? store.article(id)?.niche : undefined;
    if (!nicheId) {
      const asked = typeof task.meta.niche === 'string' ? task.meta.niche.trim() : '';
      if (asked) {
        const n = findNiche(asked);
        if (!n) return { ok: false, result: '', error: `Не нашёл нишу «${asked.slice(0, 60)}». Нужна ниша из каталога конструктора, например барбершоп, стоматология, автосервис.` };
        nicheId = n.id;
      } else {
        const covered = store.coveredNiches();
        const free = TOPIC_NICHES.filter((n) => !covered.has(n.id));
        if (free.length === 0) return { ok: true, result: 'Все ниши каталога уже покрыты статьями, новой не делаю.' };
        nicheId = free[Math.floor(this.rng() * free.length)]!.id;
      }
    }
    const niche = nicheById(nicheId)!;
    if (!id) id = store.insertArticle(niche.id);
    const feedback = typeof task.meta.feedback === 'string' ? task.meta.feedback : '';
    const prev = store.article(id)?.json;
    const fail = (why: string): WorkerResult => {
      store.setArticle(id, { status: 'failed', comment: why });
      return { ok: false, result: '', error: `Статья «${niche.name}»: ${why}` };
    };
    try {
      const extra = [
        feedback ? `Прошлый вариант вернули с замечанием владельца: ${feedback}\nУчти его и напиши заново.${prev ? `\nПрошлый вариант (не повторяй его):\n${prev.slice(0, 6000)}` : ''}` : '',
      ].filter(Boolean).join('\n\n');
      const ruReq = (fix?: string) => ({
        tier: 'sonnet' as const, system: this.prompts.articleSystem, maxTokens: 12_000,
        messages: [{ role: 'user' as const, content: fill(this.prompts.articleRu, { niche: niche.name, nicheId: niche.id, extra: [extra, fix ? `В черновике найдено: ${fix}. Исправь и верни полный JSON.` : ''].filter(Boolean).join('\n\n') }) }],
      });
      let ru = await tryJson(ctx.llm, ruReq(), ruPartSchema);
      let ruIssues = ru ? contentIssues(ru.ru, 'ru') : [];
      if (ru && ruIssues.length) {
        const again = await tryJson(ctx.llm, ruReq(ruIssues.join('; ')), ruPartSchema);
        if (again) {
          const left = contentIssues(again.ru, 'ru');
          if (left.length <= ruIssues.length) {
            ru = again;
            ruIssues = left;
          }
        }
      }
      if (!ru) return fail('модель не дала валидный русский текст');
      const enReq = (fix?: string) => ({
        tier: 'sonnet' as const, system: this.prompts.articleSystem, maxTokens: 12_000,
        messages: [{ role: 'user' as const, content: fill(this.prompts.articleEn, { nicheId: niche.id, ru: JSON.stringify(ru!.ru), extra: fix ? `The previous draft had problems: ${fix}. Fix them and return the full JSON.` : '' }) }],
      });
      const enSchema = z.object({ en: contentSchema });
      let en = await tryJson(ctx.llm, enReq(), enSchema);
      let enIssues = en ? contentIssues(en.en, 'en') : [];
      if (en && enIssues.length) {
        const again = await tryJson(ctx.llm, enReq(enIssues.join('; ')), enSchema);
        if (again && contentIssues(again.en, 'en').length <= enIssues.length) {
          en = again;
          enIssues = contentIssues(again.en, 'en');
        }
      }
      if (!en) return fail('модель не дала валидный английский текст');
      const article: ArticleJson = articleSchema.parse({ slug: ru.slug, niche: niche.id, ru: ru.ru, en: en.en });
      store.setArticle(id, { status: 'proposed', slug: article.slug, title: article.ru.title, json: JSON.stringify(article) });
      const warn = [...ruIssues, ...enIssues];
      const summary = `${articleSummary(article, niche.name)}${warn.length ? `\nПроверка нашла: ${warn.join('; ')}.` : ''}`;
      await ctx.requestApproval(ARTICLE_KIND, { text: articlePreview(article), articleId: id }, summary);
      ctx.log('article_drafted', `article ${id}`);
      return { ok: true, result: summary };
    } catch (e) {
      log('error', 'article failed', { articleId: id, err: errMsg(e) });
      return fail(errMsg(e));
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
