import { errMsg } from '@fir/core';

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

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

async function getJson(fetchFn: FetchFn, url: string): Promise<unknown> {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
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
export async function fetchYoutube(fetchFn: FetchFn, key: string, regions: string[], now: number, queries = NICHE_QUERIES): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const base = 'https://www.googleapis.com/youtube/v3';
  for (const region of regions) {
    const url = `${base}/videos?part=snippet,statistics&chart=mostPopular&regionCode=${region}&maxResults=10&key=${encodeURIComponent(key)}`;
    out.push(...ytCandidates(await getJson(fetchFn, url), region, `в тренде ${region}`));
  }
  const after = encodeURIComponent(new Date(now - 7 * DAY).toISOString());
  for (const q of queries) {
    const s = `${base}/search?part=snippet&type=video&order=viewCount&relevanceLanguage=ru&maxResults=5&publishedAfter=${after}&q=${encodeURIComponent(q)}&key=${encodeURIComponent(key)}`;
    const found = (await getJson(fetchFn, s)) as { items?: { id?: { videoId?: string } }[] };
    const ids = (found.items ?? []).map((i) => i.id?.videoId).filter((x): x is string => Boolean(x));
    if (ids.length === 0) continue;
    const v = `${base}/videos?part=snippet,statistics&id=${ids.join(',')}&key=${encodeURIComponent(key)}`;
    out.push(...ytCandidates(await getJson(fetchFn, v), 'RU', `за 7 дней, запрос «${q}»`));
  }
  return out;
}

const decode = (s: string): string =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").trim();
const tag = (block: string, name: string): string | undefined => {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(block);
  return m ? decode(m[1]!) : undefined;
};

/** Google Trends daily RSS (public): trending searches of a region. */
export function parseTrendsRss(xml: string, region: string): Candidate[] {
  const out: Candidate[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1]!;
    const title = tag(block, 'title');
    if (!title) continue;
    const traffic = tag(block, 'ht:approx_traffic');
    const news = tag(block, 'ht:news_item_title');
    const url = tag(block, 'ht:news_item_url') ?? tag(block, 'link') ?? `https://trends.google.com/trends/explore?q=${encodeURIComponent(title)}&geo=${region}`;
    out.push({ source: 'google_trends', title: news ? `${title}: ${news}`.slice(0, 160) : title, url, metric: `${traffic ?? '?'} запросов в сутки`, region });
  }
  return out;
}

export async function fetchGoogleTrends(fetchFn: FetchFn, regions: string[]): Promise<{ items: Candidate[]; errors: string[] }> {
  const items: Candidate[] = [];
  const errors: string[] = [];
  for (const region of regions) {
    try {
      const res = await fetchFn(`https://trends.google.com/trending/rss?geo=${region}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      items.push(...parseTrendsRss(await res.text(), region).slice(0, 15));
    } catch (e) {
      errors.push(`Google Trends ${region}: ${errMsg(e)}`);
    }
  }
  return { items, errors };
}
