import { GOOGLE_HOSTS, errMsg, parseTrendsFeed, type TrendItem, type Tools } from '@fir/core';

export interface Candidate {
  source: 'youtube' | 'google_trends';
  title: string;
  url: string;
  /** Human-readable popularity: "1.2M просмотров", "200+ запросов". */
  metric: string;
  region: string;
}

export const NICHE_QUERIES = [
  'бот для записи клиентов',
  'автоматизация бизнеса с помощью ИИ',
  'нейросети для малого бизнеса',
  'telegram бот для бизнеса',
  'ИИ агент для бизнеса',
  'как автоматизировать рутину',
];

const TIMEOUT_MS = 10_000;
const DAY = 86_400_000;

/** A GET through the toolbox (allow-listed Google hosts, pinned DNS, retries on 5xx); a failure becomes an error for the caller's note. */
async function getJson(tools: Tools, url: string): Promise<unknown> {
  const r = await tools.web.getJson(url, { hosts: GOOGLE_HOSTS, timeoutMs: TIMEOUT_MS });
  if (!r.ok) throw new Error(r.status ? `HTTP ${r.status}` : r.error);
  return r.value;
}

const fmtViews = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));

interface YtVideo {
  id?: string;
  snippet?: { title?: string };
  statistics?: { viewCount?: string };
}

function ytCandidates(json: unknown, region: string, what: string): Candidate[] {
  const items = ((json as { items?: YtVideo[] }).items ?? []).filter((v) => typeof v.id === 'string' && v.snippet?.title);
  return items.map((v) => ({
    source: 'youtube' as const,
    title: v.snippet!.title!.slice(0, 140),
    url: `https://www.youtube.com/watch?v=${v.id}`,
    metric: `${fmtViews(Number(v.statistics?.viewCount ?? 0))} просмотров (${what})`,
    region,
  }));
}

/**
 * YouTube Data API v3 (free quota, official API): most popular videos per region (1 unit each) and niche searches
 * in Russian by view count for the last 7 days (100 units each, so about 700 units a day of the 10 000 default).
 */
export async function fetchYoutube(tools: Tools, key: string, regions: string[], now: number, queries = NICHE_QUERIES): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const base = 'https://www.googleapis.com/youtube/v3';
  for (const region of regions) {
    const url = `${base}/videos?part=snippet,statistics&chart=mostPopular&regionCode=${region}&maxResults=10&key=${encodeURIComponent(key)}`;
    out.push(...ytCandidates(await getJson(tools, url), region, `в тренде ${region}`));
  }
  const after = encodeURIComponent(new Date(now - 7 * DAY).toISOString());
  for (const q of queries) {
    const s = `${base}/search?part=snippet&type=video&order=viewCount&relevanceLanguage=ru&maxResults=5&publishedAfter=${after}&q=${encodeURIComponent(q)}&key=${encodeURIComponent(key)}`;
    const found = (await getJson(tools, s)) as { items?: { id?: { videoId?: string } }[] };
    const ids = (found.items ?? []).map((i) => i.id?.videoId).filter((x): x is string => Boolean(x));
    if (ids.length === 0) continue;
    const v = `${base}/videos?part=snippet,statistics&id=${ids.join(',')}&key=${encodeURIComponent(key)}`;
    out.push(...ytCandidates(await getJson(tools, v), 'RU', `за 7 дней, запрос «${q}»`));
  }
  return out;
}

const candidate = (t: TrendItem): Candidate => ({
  source: 'google_trends', title: t.newsTitle ? `${t.title}: ${t.newsTitle}`.slice(0, 160) : t.title, url: t.newsUrl ?? t.link, metric: `${t.traffic ?? '?'} запросов в сутки`, region: t.geo,
});

/** Google Trends daily RSS (public): trending searches of a region (the parser lives in core, `parseTrendsFeed`). */
export function parseTrendsRss(xml: string, region: string): Candidate[] {
  return parseTrendsFeed(xml, region).map(candidate);
}

/** Trending searches per region through `tools.google.trends` (cached an hour); a failed region is a note, not a crash. */
export async function fetchGoogleTrends(tools: Tools, regions: string[]): Promise<{ items: Candidate[]; errors: string[] }> {
  const items: Candidate[] = [];
  const errors: string[] = [];
  for (const region of regions) {
    try {
      const r = await tools.google.trends({ geo: region, limit: 15 });
      if (!r.ok) throw new Error(r.status ? `HTTP ${r.status}` : r.error);
      items.push(...r.value.map(candidate));
    } catch (e) {
      errors.push(`Google Trends ${region}: ${errMsg(e)}`);
    }
  }
  return { items, errors };
}
