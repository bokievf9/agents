import { decodeEntities } from './html.js';

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  /** Age or date the provider reports, as it gives it (Brave only). */
  age?: string;
}

export const BRAVE_HOST = 'api.search.brave.com';
export const DDG_HOST = 'html.duckduckgo.com';

const stripTags = (s: string): string => decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
const httpsOnly = (u: string): boolean => /^https?:\/\//i.test(u);

export function braveUrl(q: string, limit: number, lang?: string): string {
  const p = new URLSearchParams({ q, count: String(limit), safesearch: 'moderate' });
  if (lang) p.set('search_lang', lang);
  return `https://${BRAVE_HOST}/res/v1/web/search?${p.toString()}`;
}

/** Brave Search API answer -> hits. null when the answer is not the expected shape. */
export function parseBrave(body: unknown): SearchHit[] | null {
  const web = (body as { web?: { results?: unknown } } | null)?.web;
  if (!body || typeof body !== 'object') return null;
  if (!web) return [];
  if (!Array.isArray(web.results)) return null;
  const out: SearchHit[] = [];
  for (const r of web.results as { title?: unknown; url?: unknown; description?: unknown; age?: unknown; page_age?: unknown }[]) {
    if (typeof r?.url !== 'string' || !httpsOnly(r.url) || typeof r.title !== 'string') continue;
    const age = typeof r.page_age === 'string' ? r.page_age : typeof r.age === 'string' ? r.age : undefined;
    out.push({ title: stripTags(r.title), url: r.url, snippet: typeof r.description === 'string' ? stripTags(r.description) : '', ...(age ? { age } : {}) });
  }
  return out;
}

const DDG_REGION: Record<string, string> = { ru: 'ru-ru', en: 'us-en', uz: 'uz-uz', kk: 'kz-ru' };

export function ddgUrl(q: string, lang?: string): string {
  const p = new URLSearchParams({ q, kl: (lang && DDG_REGION[lang]) || 'wt-wt' });
  return `https://${DDG_HOST}/html/?${p.toString()}`;
}

/** The real target of a DuckDuckGo result link (`//duckduckgo.com/l/?uddg=<encoded>`), or the link itself. null for ads. */
function ddgTarget(href: string): string | null {
  const h = decodeEntities(href);
  if (/duckduckgo\.com\/y\.js/.test(h)) return null; // ad click
  const m = /[?&]uddg=([^&]+)/.exec(h);
  if (m) {
    try {
      return decodeURIComponent(m[1]!);
    } catch {
      return null;
    }
  }
  return h.startsWith('//') ? `https:${h}` : h;
}

/** DuckDuckGo HTML results page -> hits (organic results only; ads and the «no results» block are skipped). */
export function parseDdg(html: string): SearchHit[] {
  const out: SearchHit[] = [];
  // one result block per `result__body`; ads carry `result--ad`
  const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/i).slice(1);
  for (const b of blocks) {
    const head = /^[^>]*>/.exec(b)?.[0] ?? '';
    if (/result--ad/.test(head) || /result--ad/.test(b.slice(0, 200))) continue;
    const a = /<a[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(b) ?? /<a[^>]+href="([^"]+)"[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(b);
    if (!a) continue;
    const url = ddgTarget(a[1]!);
    if (!url || !httpsOnly(url)) continue;
    const sn = /<(?:a|div|td)[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/i.exec(b);
    out.push({ title: stripTags(a[2]!), url, snippet: sn ? stripTags(sn[1]!) : '' });
  }
  const seen = new Set<string>();
  return out.filter((h) => (seen.has(h.url) ? false : (seen.add(h.url), true)));
}

/** DuckDuckGo answers bots with a challenge page instead of results. */
export const ddgBlocked = (html: string): boolean => /anomaly-modal|challenge-form|If this error persists/i.test(html);
