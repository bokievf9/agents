import { errMsg, log, tryJson, withPlaybook, zonedParts } from '@fir/core';
import { toolsOf, type Task, type Worker, type WorkerCtx, type WorkerResult } from '@fir/hq';
import { z } from 'zod';
import { LinkStore, analyseLink, analysisText, fetchLinkMeta, gatherReach, parseLink, type LinkMeta } from './link.js';
import { fetchGoogleTrends, fetchYoutube, type Candidate } from './sources.js';
import { TrendStore, type NewTrendItem, type TrendItem } from './store.js';

/** The eight service directions (ids as in directions.ts of the site and the content-maker). */
export const DIRECTION_IDS = ['admin', 'receptionist', 'automation', 'content', 'miniapp', 'agent', 'implementation', 'training'] as const;

export interface TrendScoutOptions {
  /** YouTube Data API key; without it the YouTube source is off. */
  youtubeApiKey?: string | undefined;
  /** Region codes for Google Trends and YouTube charts; empty: both sources off. */
  regions?: string[];
}

const pickSchema = z.object({
  items: z
    .array(
      z.object({
        n: z.coerce.number().int().min(1),
        hook: z.string().min(5).max(160),
        format: z.string().min(3).max(120),
        why: z.string().min(5).max(220),
        direction: z.enum(DIRECTION_IDS).nullable().optional(),
      }),
    )
    .min(1)
    .max(5),
});
const weeklySchema = z.object({ lines: z.array(z.string().min(5).max(300)).min(1).max(6) });

const ymd = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export function todayOf(ctx: Pick<WorkerCtx, 'now' | 'tz'>): string {
  const p = zonedParts(ctx.now(), ctx.tz);
  return ymd(Date.UTC(p.y, p.mo - 1, p.d));
}

export const trendStoreFor = (() => {
  const stores = new WeakMap<object, TrendStore>();
  return (ctx: Pick<WorkerCtx, 'db' | 'now'>): TrendStore => {
    let s = stores.get(ctx.db);
    if (!s) stores.set(ctx.db, (s = new TrendStore(ctx.db, ctx.now)));
    return s;
  };
})();

/** What the content-maker reads: the newest day's trends (not older than a week). Wire as `trends` provider. */
export function latestTrendHints(ctx: Pick<WorkerCtx, 'db' | 'now'>, tz = 'Asia/Tashkent') {
  return trendStoreFor(ctx).latest(todayOf({ now: ctx.now, tz })).map((t) => ({
    hook: t.hook, format: t.format, why: t.why, ...(t.direction ? { direction: t.direction } : {}),
  }));
}

export function formatItems(items: TrendItem[] | NewTrendItem[]): string {
  return items
    .map((t, i) => `${i + 1}. ${t.hook}\n   Формат: ${t.format}. Почему растёт: ${t.why}. Направление: ${t.direction ?? 'любое'}.\n   Источник: ${t.url}`)
    .join('\n');
}

/**
 * Trend scout: reads public trend signals and turns them into five hooks-and-formats a day (RU) for the content-maker.
 * Actions (task.meta.action): `trends` (daily), `trends_weekly` (Sunday digest from the week's stored items).
 * It never writes outside: results go to the task and the `ts_items` table. TikTok is deliberately not used.
 */
export class TrendScoutWorker implements Worker {
  readonly id = 'trend-scout';

  /** Network goes through `ctx.tools` (Google hosts only, pinned DNS, per-host queue, journal); tests inject a fake fetch there. */
  constructor(private readonly opts: TrendScoutOptions = {}) {}

  /** Source names that are on, for the report. */
  get sources(): string[] {
    const regions = this.opts.regions ?? [];
    if (regions.length === 0) return [];
    return ['google_trends', ...(this.opts.youtubeApiKey ? ['youtube'] : [])];
  }

  async run(task: Task, ctx: WorkerCtx): Promise<WorkerResult> {
    try {
      if (task.meta.action === 'trends_weekly') return await this.weekly(ctx);
      if (task.meta.action === 'trends') return await this.daily(task, ctx);
      if (task.meta.action === 'owner_link') return await this.ownerLink(task, ctx);
      return { ok: false, result: '', error: `Неизвестное действие: ${String(task.meta.action)}` };
    } catch (e) {
      log('error', 'trend scout failed', { err: errMsg(e) });
      return { ok: false, result: '', error: errMsg(e) };
    }
  }

  private async collect(ctx: WorkerCtx): Promise<{ items: Candidate[]; notes: string[] }> {
    const regions = this.opts.regions ?? [];
    const items: Candidate[] = [];
    const notes: string[] = [];
    if (regions.length === 0) return { items, notes: ['Регионы не заданы (TRENDS_REGIONS пуст): источники выключены.'] };
    const tools = toolsOf(ctx, 'marketing', this.id);
    const g = await fetchGoogleTrends(tools, regions);
    items.push(...g.items);
    notes.push(...g.errors);
    if (this.opts.youtubeApiKey) {
      try {
        items.push(...(await fetchYoutube(tools, this.opts.youtubeApiKey, regions, ctx.now())));
      } catch (e) {
        notes.push(`YouTube: ${errMsg(e).replace(this.opts.youtubeApiKey, '***')}`);
      }
    } else notes.push('YouTube выключен: нет YOUTUBE_API_KEY.');
    notes.push('TikTok не используется: публичного API трендов без входа в аккаунт нет.');
    return { items, notes };
  }

  private async daily(task: Task, ctx: WorkerCtx): Promise<WorkerResult> {
    const store = trendStoreFor(ctx);
    const day = todayOf(ctx);
    if (!task.meta.force && store.hasDay(day)) return { ok: true, result: `Тренды на ${day} уже собраны.\n${formatItems(store.latest(day, 0))}` };
    if (!ctx.llm.enabled) return { ok: false, result: '', error: 'LLM off: нет LLM_API_KEY, тренды не отранжированы' };
    const { items: cands, notes } = await this.collect(ctx);
    if (cands.length === 0) return { ok: false, result: '', error: `Источники не дали данных. ${notes.join(' ')}` };
    const list = cands.slice(0, 80);
    const res = await tryJson(
      ctx.llm,
      {
        tier: 'sonnet', maxTokens: 2500,
        system: withPlaybook(
          'Ты трендвотчер студии Fir Tech: ИИ-агенты и боты для малого бизнеса (Ташкент, Алматы, Душанбе, Бишкек), короткие видео на русском для Instagram, TikTok и Shorts. ' +
          'Из списка сигналов выбери до 5 самых полезных для хуков и форматов роликов студии. Сигнал годится, если его механику (формат подачи, тип хука, тема внимания) можно перенести на услуги студии. Новости, политика и спорт не годятся. ' +
          `Пиши по-русски, коротко, без эмодзи и без длинных тире. Хук пиши своими словами, не копируй заголовки и тексты авторов. Направления: ${DIRECTION_IDS.join(', ')} или null. ` +
          'Ответ: только JSON {"items":[{"n": номер сигнала, "hook":"текст хука", "format":"формат ролика", "why":"почему растёт", "direction":"id или null"}]}.',
          'trend-scout',
        ),
        messages: [{ role: 'user', content: list.map((c, i) => `${i + 1}. [${c.source} ${c.region}] ${c.title} (${c.metric})`).join('\n') }],
      },
      pickSchema,
    );
    if (!res) return { ok: false, result: '', error: 'Модель не дала валидный ответ с трендами' };
    const seen = new Set<number>();
    const picked: NewTrendItem[] = [];
    for (const i of res.items) {
      const c = list[i.n - 1];
      if (!c || seen.has(i.n)) continue;
      seen.add(i.n);
      picked.push({ hook: i.hook, format: i.format, why: i.why, source: c.source, url: c.url, direction: i.direction ?? null });
    }
    if (picked.length === 0) return { ok: false, result: '', error: 'Модель выбрала несуществующие сигналы' };
    store.saveDay(day, picked);
    ctx.log('trends_saved', `${picked.length} items, ${cands.length} signals`);
    return { ok: true, result: `Хуки и форматы на ${day} (сигналов: ${cands.length}):\n${formatItems(picked)}\n\nЗаметки: ${notes.join(' ')}` };
  }

  /**
   * `owner_link` (`meta.linkId`): a public post the owner dropped. Reads what an anonymous visitor sees (oEmbed, og tags through `ctx.tools.web`, hosts
   * `SOCIAL_HOSTS`, never a login), analyses it (format, hook, structure, why it works) and stores the analysis with the Fir Tech analogue in `ts_links`.
   * The head makes the content item from the analogue. Nothing leaves the studio.
   */
  private async ownerLink(task: Task, ctx: WorkerCtx): Promise<WorkerResult> {
    const links = new LinkStore(ctx.db, ctx.now);
    const row = links.get(Number(task.meta.linkId));
    if (!row) return { ok: false, result: '', error: 'Ссылка владельца не найдена' };
    const fail = (error: string): WorkerResult => {
      links.setState(row.id, 'failed', error);
      return { ok: false, result: '', error };
    };
    const parsed = parseLink(row.url);
    if (!parsed.ok) return fail(`Ссылка не подходит: ${parsed.reason}`);
    if (!ctx.llm.enabled) return fail('LLM off: нет LLM_API_KEY, разбор невозможен');
    links.setState(row.id, 'analysing');
    const tools = toolsOf(ctx, 'marketing', this.id);
    // the owner's Mac first (YouTube subtitles through Agent Reach): a job not answered yet parks the task, it runs again when the answer is in
    const reach = await gatherReach(tools, ctx.db, parsed);
    if ('waiting' in reach) {
      links.setState(row.id, 'waiting');
      ctx.log('owner_link_waiting', `link ${row.id}, reach job ${reach.waiting}`);
      return { ok: true, result: `Жду Мак: субтитры и данные видео читает Agent Reach (задание ${reach.waiting}).`, waiting: { jobId: reach.waiting } };
    }
    let meta: LinkMeta | null = await fetchLinkMeta(tools, parsed);
    if (reach.transcript || reach.title) {
      meta ??= { platform: parsed.platform, title: '', description: '', author: '', image: '', sources: [] };
      meta.title ||= reach.title ?? '';
      meta.author ||= reach.author ?? '';
      if (reach.transcript) meta.transcript = reach.transcript;
      if (reach.views !== undefined) meta.views = reach.views;
      if (reach.likes !== undefined) meta.likes = reach.likes;
      meta.sources.push('reach');
    }
    if (!meta) return fail('Страница не отдала название и описание без входа в аккаунт (закрытая или недоступная ссылка)');
    const analysis = await analyseLink(ctx.llm, meta, row.note);
    if (!analysis) return fail('Модель не дала валидный разбор');
    links.setAnalysis(row.id, analysis);
    ctx.log('owner_link_analysed', `link ${row.id}, ${parsed.platform}`);
    return { ok: true, result: analysisText(analysis, row.url) };
  }

  private async weekly(ctx: WorkerCtx): Promise<WorkerResult> {
    const store = trendStoreFor(ctx);
    const to = todayOf(ctx);
    const from = ymd(Date.parse(`${to}T00:00:00Z`) - 6 * 86_400_000);
    const items = store.since(from, to);
    if (items.length === 0) return { ok: true, result: 'Тренды ниши за неделю: данных нет, ежедневный сбор ничего не сохранил.' };
    const lines = await tryJson(
      ctx.llm,
      {
        tier: 'haiku', maxTokens: 900,
        system: 'Сведи хуки и форматы недели в 3-5 коротких строк: что растёт в нише ИИ и ботов для малого бизнеса и что из этого снять студии. Русский, без эмодзи и длинных тире. Ответ: только JSON {"lines":["..."]}.',
        messages: [{ role: 'user', content: items.map((t) => `${t.day}: ${t.hook} (${t.format}; ${t.why})`).join('\n').slice(0, 6000) }],
      },
      weeklySchema,
    );
    const body = lines ? lines.lines.map((l) => `- ${l}`).join('\n') : items.slice(0, 5).map((t) => `- ${t.hook} (${t.format})`).join('\n');
    return { ok: true, result: `Тренды ниши за неделю ${from} - ${to}:\n${body}` };
  }
}
