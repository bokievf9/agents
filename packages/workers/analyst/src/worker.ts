import { GOOGLE_HOSTS, errMsg, log, migrate, safeGetJson, tryJson, zonedParts, type Db } from '@fir/core';
import type { Task, Worker, WorkerCtx, WorkerResult } from '@fir/hq';
import { z } from 'zod';

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const DAY = 86_400_000;
const SCHEMA = `
CREATE TABLE IF NOT EXISTS an_snapshots (
  week_end TEXT PRIMARY KEY,
  yt_subscribers INTEGER,
  yt_views INTEGER,
  yt_videos INTEGER,
  numbers TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

export interface AnalystOptions {
  youtubeApiKey?: string | undefined;
  youtubeChannelId?: string | undefined;
  fetch?: FetchFn;
  /** Owner access (refresh-token flow): channel stats of the channel behind the token and per-video stats of the week's Shorts. */
  oauth?: { accessToken(): Promise<string> };
  /** Tests: replaces `safeGetJson` for the OAuth calls. */
  get?: (url: string, headers: Record<string, string>) => Promise<unknown>;
}

export interface YtStats {
  subscribers: number;
  views: number;
  videos: number;
}

/** The five numbers of the weekly report. null: no data source (shown as "нет данных"). */
export interface WeekNumbers {
  approved: number;
  published: number;
  publishedByPlatform: Record<string, number>;
  leads: number;
  leadsPrev: number;
  costUsd: number;
  subscribers: number | null;
  subscribersDelta: number | null;
  /** Prospector funnel counts by status, when the Sales tables exist. */
  funnel: Record<string, number> | null;
  /** Blog articles of the week (null: the content-maker has no article table or no article yet). */
  articles: { proposed: number; approved: number; published: number; fromArticles: number; hits: number | null } | null;
}

const recsSchema = z.object({ recommendations: z.array(z.string().min(5).max(300)).length(3) });
const ymd = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const hasTable = (db: Db, name: string): boolean => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
const hasColumn = (db: Db, table: string, col: string): boolean => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);

/** Sales tables the prospector may use; the first that exists with a `status` column becomes the funnel. */
export const FUNNEL_TABLES = ['pr_prospects', 'prospects', 'pr_cards'];

export async function fetchYoutubeStats(fetchFn: FetchFn, key: string, channelId: string): Promise<YtStats> {
  const url = `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${encodeURIComponent(channelId)}&key=${encodeURIComponent(key)}`;
  const res = await fetchFn(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`YouTube HTTP ${res.status}`);
  const s = ((await res.json()) as { items?: { statistics?: { subscriberCount?: string; viewCount?: string; videoCount?: string } }[] }).items?.[0]?.statistics;
  if (!s) throw new Error('YouTube: канал не найден (проверьте YOUTUBE_CHANNEL_ID)');
  return { subscribers: Number(s.subscriberCount ?? 0), views: Number(s.viewCount ?? 0), videos: Number(s.videoCount ?? 0) };
}

/** The `YouTube` GET with the owner's token (`mine=true`): an https allow-listed call, never the key path. */
async function oauthGet(opts: AnalystOptions, url: string): Promise<unknown> {
  const headers = { authorization: `Bearer ${await opts.oauth!.accessToken()}` };
  if (opts.get) return opts.get(url, headers);
  const r = await safeGetJson(url, { allowHosts: GOOGLE_HOSTS, headers, timeoutMs: 10_000 });
  if (!r.ok || r.status !== 200) throw new Error(`YouTube HTTP ${r.ok ? r.status : r.error}`);
  return r.body;
}

export async function fetchOwnYoutubeStats(opts: AnalystOptions): Promise<YtStats> {
  const s = ((await oauthGet(opts, 'https://www.googleapis.com/youtube/v3/channels?part=statistics&mine=true')) as { items?: { statistics?: { subscriberCount?: string; viewCount?: string; videoCount?: string } }[] }).items?.[0]?.statistics;
  if (!s) throw new Error('YouTube: канал не найден для этого токена');
  return { subscribers: Number(s.subscriberCount ?? 0), views: Number(s.viewCount ?? 0), videos: Number(s.videoCount ?? 0) };
}

/** Video ids of the Shorts the Publisher uploaded in the window (from `pb_posts.url`). */
export function weekVideoIds(db: Db, winFrom: number, winTo: number): string[] {
  if (!hasTable(db, 'pb_posts') || !hasColumn(db, 'pb_posts', 'url')) return [];
  const rows = db.prepare("SELECT url FROM pb_posts WHERE platform = 'shorts' AND url IS NOT NULL AND published_at >= ? AND published_at < ?").all(winFrom, winTo) as { url: string }[];
  return rows.map((r) => /\/shorts\/([\w-]{6,20})/.exec(r.url)?.[1]).filter((x): x is string => !!x);
}

export async function fetchVideoViews(opts: AnalystOptions, ids: string[]): Promise<number> {
  let views = 0;
  for (let i = 0; i < ids.length; i += 50) {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${ids.slice(i, i + 50).map(encodeURIComponent).join(',')}`;
    const items = ((await oauthGet(opts, url)) as { items?: { statistics?: { viewCount?: string } }[] }).items ?? [];
    views += items.reduce((n, v) => n + Number(v.statistics?.viewCount ?? 0), 0);
  }
  return views;
}

/** «YouTube за неделю: 3 Shorts, 1200 просмотров, 45 подписчиков (+6)». */
export function youtubeWeekLine(shorts: number, views: number, subs: number, delta: number | null): string {
  return `YouTube за неделю: ${shorts} Shorts, ${views} просмотров, ${subs} подписчиков${delta === null ? '' : ` (${delta >= 0 ? '+' : ''}${delta})`}`;
}

/** Everything from the HQ database for the 7 days ending at `to` (inclusive, YYYY-MM-DD, HQ timezone). */
export function aggregate(db: Db, from: string, to: string, nowMs: number, tz: string, yt: YtStats | null, prevSubs: number | null): WeekNumbers {
  const toMs = Date.parse(`${to}T00:00:00Z`) + DAY;
  const fromMs = Date.parse(`${from}T00:00:00Z`);
  // Timestamps are epoch ms; the week window in HQ time is approximated by UTC day borders shifted by the zone offset.
  const p = zonedParts(nowMs, tz);
  const offset = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - Math.floor(nowMs / 60_000) * 60_000;
  const winFrom = fromMs - offset;
  const winTo = toMs - offset;

  let approved = 0;
  if (hasTable(db, 'cm_ready')) {
    approved = (db.prepare("SELECT COUNT(*) c FROM cm_ready WHERE status IN ('ready','published') AND planned_date >= ? AND planned_date <= ?").get(from, to) as { c: number }).c;
  }
  const publishedByPlatform: Record<string, number> = {};
  let published = 0;
  if (hasTable(db, 'pb_posts')) {
    for (const r of db.prepare('SELECT platform, COUNT(*) n FROM pb_posts WHERE published_at >= ? AND published_at < ? GROUP BY platform').all(winFrom, winTo) as { platform: string; n: number }[]) {
      publishedByPlatform[r.platform] = r.n;
      published += r.n;
    }
  }
  let articles: WeekNumbers['articles'] = null;
  if (hasTable(db, 'cm_articles') && (db.prepare('SELECT COUNT(*) c FROM cm_articles').get() as { c: number }).c > 0) {
    const published = hasColumn(db, 'cm_articles', 'published');
    const rows = db.prepare(`SELECT created_at, decided_at, status, task_id${published ? ', published' : ''} FROM cm_articles`).all() as { created_at: number; decided_at: number | null; status: string; task_id: number | null; published?: number }[];
    // since 2026-11-19 HQ publishes an approved article itself (`published`, endpoint /blog); older rows were handed to a builder (published = the issue was closed)
    const closed = (taskId: number | null): boolean => {
      if (taskId === null || !hasTable(db, 'tasks')) return false;
      const m = (db.prepare('SELECT meta FROM tasks WHERE id = ?').get(taskId) as { meta: string } | undefined)?.meta ?? '';
      return /"builderClosed":\s*true/.test(m);
    };
    const decided = rows.filter((r) => r.status === 'approved' && r.decided_at !== null && r.decided_at >= winFrom && r.decided_at < winTo);
    const fromArticles = hasTable(db, 'cm_items') && hasColumn(db, 'cm_items', 'source_slug')
      ? (db.prepare("SELECT COUNT(*) c FROM cm_items WHERE source_slug IS NOT NULL AND status = 'ready' AND created_at >= ? AND created_at < ?").get(winFrom, winTo) as { c: number }).c
      : 0;
    // `/blog` requests the endpoint counted per day (cm_kv `blog_hits:<date>`)
    const hits = hasTable(db, 'cm_kv')
      ? (db.prepare("SELECT COALESCE(SUM(CAST(value AS INTEGER)), 0) s, COUNT(*) n FROM cm_kv WHERE key >= ? AND key <= ?").get(`blog_hits:${from}`, `blog_hits:${to}`) as { s: number; n: number })
      : null;
    articles = {
      proposed: rows.filter((r) => r.created_at >= winFrom && r.created_at < winTo && r.status !== 'draft').length,
      approved: decided.length,
      published: decided.filter((r) => (published ? r.published === 1 : false) || closed(r.task_id)).length,
      fromArticles,
      hits: hits && hits.n > 0 ? hits.s : null,
    };
  }
  const leadCount = (a: number, b: number): number => {
    const rows = db.prepare("SELECT tags, meta, title FROM tasks WHERE dept = 'sales' AND parent_id IS NULL AND created_at >= ? AND created_at < ?").all(a, b) as { tags: string; meta: string; title: string }[];
    return rows.filter((r) => !r.tags.split(',').includes('drill')).filter((r) => r.tags.split(',').includes('lead') || /"action":"lead"/.test(r.meta) || /^лид(?![\p{L}])/iu.test(r.title)).length;
  };
  let funnel: Record<string, number> | null = null;
  for (const t of FUNNEL_TABLES) {
    if (hasTable(db, t) && hasColumn(db, t, 'status')) {
      funnel = Object.fromEntries((db.prepare(`SELECT status, COUNT(*) n FROM ${t} GROUP BY status`).all() as { status: string; n: number }[]).map((r) => [r.status, r.n]));
      break;
    }
  }
  const costUsd = hasTable(db, 'costs') ? ((db.prepare('SELECT COALESCE(SUM(usd), 0) s FROM costs WHERE at >= ? AND at < ?').get(winFrom, winTo) as { s: number }).s) : 0;
  return {
    approved, published, publishedByPlatform, leads: leadCount(winFrom, winTo), leadsPrev: leadCount(winFrom - 7 * DAY, winFrom), costUsd,
    subscribers: yt?.subscribers ?? null, subscribersDelta: yt && prevSubs !== null ? yt.subscribers - prevSubs : null, funnel, articles,
  };
}

const platformLabel: Record<string, string> = { instagram: 'Instagram', tiktok: 'TikTok', shorts: 'Shorts' };

export function numbersText(n: WeekNumbers): string {
  const per = Object.entries(n.publishedByPlatform).map(([k, v]) => `${platformLabel[k] ?? k} ${v}`).join(', ');
  const subs = n.subscribers === null ? 'нет данных (YouTube не подключён)' : `${n.subscribers}${n.subscribersDelta === null ? '' : ` (${n.subscribersDelta >= 0 ? '+' : ''}${n.subscribersDelta} за неделю)`}`;
  return [
    `1. Одобрено материалов на неделю (платформ): ${n.approved}`,
    `2. Опубликовано (отмечено вручную): ${n.published}${per ? ` (${per})` : ''}`,
    `3. Лидов: ${n.leads} (неделей ранее ${n.leadsPrev})`,
    `4. Расходы на ИИ за неделю: $${n.costUsd.toFixed(2)}`,
    `5. Подписчики YouTube: ${subs}`,
    ...(n.articles ? [`6. Статьи блога: предложено ${n.articles.proposed}, одобрено ${n.articles.approved}, опубликовано ${n.articles.published} (одобренная публикуется сразу через /blog); из статей в материалах недели: ${n.articles.fromArticles}${n.articles.hits === null ? '' : `; обращений к /blog: ${n.articles.hits}`}`] : []),
  ].join('\n');
}

/** Rules for the three recommendations when the model is off or fails. */
export function fallbackRecommendations(n: WeekNumbers): string[] {
  const recs: string[] = [];
  if (n.approved > 0 && n.published < n.approved) recs.push(`Опубликовано ${n.published} из ${n.approved} одобренных: выложите отставшие материалы и нажмите «Опубликовано».`);
  if (n.leads === 0) recs.push('Лидов нет: проверьте, что ссылка firtech.pro стоит в шапке всех трёх профилей и в каждом призыве.');
  else if (n.leads < n.leadsPrev) recs.push('Лидов меньше, чем неделей ранее: повторите формат самого просматриваемого ролика недели.');
  if (n.subscribers === null) recs.push('Подключите YOUTUBE_API_KEY и YOUTUBE_CHANNEL_ID, чтобы отчёт видел рост канала.');
  recs.push('Сверьте тренды недели с темами пакета: возьмите один формат из свежих хуков в ближайший клип.');
  recs.push('Держите ритм 7 клипов в неделю: стабильность важнее одного удачного ролика.');
  return recs.slice(0, 3);
}

/**
 * Analyst, stage 1. Action `report` (weekly, Monday 08:00): assembles one RU report from what is already in the HQ
 * database, content per platform, Sales leads, prospector funnel (when its tables exist), costs, plus YouTube channel
 * stats when a key and channel id are set. Instagram and TikTok insights are stage 2 (see README). Reads only.
 */
export class AnalystWorker implements Worker {
  readonly id = 'analyst';
  private readonly fetchFn: FetchFn;

  constructor(private readonly opts: AnalystOptions = {}) {
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
  }

  async run(task: Task, ctx: WorkerCtx): Promise<WorkerResult> {
    if (task.meta.action !== 'report') return { ok: false, result: '', error: `Неизвестное действие: ${String(task.meta.action)}` };
    migrate(ctx.db, SCHEMA);
    const p = zonedParts(ctx.now(), ctx.tz);
    const today = ymd(Date.UTC(p.y, p.mo - 1, p.d));
    // The week that just ended: the seven days before today.
    const to = ymd(Date.parse(`${today}T00:00:00Z`) - DAY);
    const from = ymd(Date.parse(`${to}T00:00:00Z`) - 6 * DAY);
    let yt: YtStats | null = null;
    let note = '';
    if (this.opts.oauth) {
      try {
        yt = await fetchOwnYoutubeStats(this.opts);
      } catch (e) {
        note = `YouTube: ${errMsg(e)}`;
        log('warn', 'analyst: youtube (oauth) failed', { err: note });
      }
    }
    if (!yt && this.opts.youtubeApiKey && this.opts.youtubeChannelId) {
      try {
        yt = await fetchYoutubeStats(this.fetchFn, this.opts.youtubeApiKey, this.opts.youtubeChannelId);
      } catch (e) {
        note = `YouTube: ${errMsg(e).replace(this.opts.youtubeApiKey, '***')}`;
        log('warn', 'analyst: youtube failed', { err: note });
      }
    }
    const prev = ctx.db.prepare('SELECT yt_subscribers s FROM an_snapshots WHERE week_end < ? ORDER BY week_end DESC LIMIT 1').get(to) as { s: number | null } | undefined;
    const n = aggregate(ctx.db, from, to, ctx.now(), ctx.tz, yt, prev?.s ?? null);
    ctx.db
      .prepare('INSERT INTO an_snapshots (week_end, yt_subscribers, yt_views, yt_videos, numbers, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(week_end) DO UPDATE SET yt_subscribers = excluded.yt_subscribers, yt_views = excluded.yt_views, yt_videos = excluded.yt_videos, numbers = excluded.numbers, created_at = excluded.created_at')
      .run(to, yt?.subscribers ?? null, yt?.views ?? null, yt?.videos ?? null, JSON.stringify(n), ctx.now());

    let ytLine = '';
    if (this.opts.oauth && yt) {
      const p2 = zonedParts(ctx.now(), ctx.tz);
      const off = Date.UTC(p2.y, p2.mo - 1, p2.d, p2.h, p2.mi) - Math.floor(ctx.now() / 60_000) * 60_000;
      const ids = weekVideoIds(ctx.db, Date.parse(`${from}T00:00:00Z`) - off, Date.parse(`${to}T00:00:00Z`) + DAY - off);
      try {
        ytLine = `\n${youtubeWeekLine(ids.length, ids.length ? await fetchVideoViews(this.opts, ids) : 0, yt.subscribers, n.subscribersDelta)}`;
      } catch (e) {
        note = `${note ? `${note}\n` : ''}YouTube: ${errMsg(e)}`;
      }
    }
    const text = numbersText(n) + ytLine;
    const funnel = n.funnel ? `\nВоронка разведчика: ${Object.entries(n.funnel).map(([k, v]) => `${k} ${v}`).join(', ')}.` : '';
    const llm = await tryJson(
      ctx.llm,
      {
        tier: 'haiku', maxTokens: 700,
        system: 'Ты аналитик отдела маркетинга студии Fir Tech (ИИ-агенты и боты, короткие видео RU). По числам недели дай ровно 3 конкретных рекомендации на следующую неделю. Русский, без эмодзи и длинных тире, без выдуманных цифр, только то, что следует из чисел. Ответ: только JSON {"recommendations":["...","...","..."]}.',
        messages: [{ role: 'user', content: `${text}${funnel}`.slice(0, 3000) }],
      },
      recsSchema,
    );
    const recs = llm?.recommendations ?? fallbackRecommendations(n);
    const result = `Недельный отчёт маркетинга, ${from.slice(8)}.${from.slice(5, 7)} - ${to.slice(8)}.${to.slice(5, 7)}\n${text}${funnel}\n\nРекомендации:\n${recs.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n\nInstagram и TikTok: статистики пока нет (этап 2).${note ? `\n${note}` : ''}`;
    return { ok: true, result };
  }
}
