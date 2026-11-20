import { dayIn, fail, okv, type ToolResult } from './result.js';
import type { Kit } from './kit.js';
import { policyOf } from './policy.js';
import type { Web } from './web.js';

/**
 * Openverse (api.openverse.org): openly licensed pictures and audio. Anonymous use is 20 requests a minute and 200 a day; we keep to 15 and 150
 * (counted in the journal settings, so every agent and process of the company shares one budget). Optional `OPENVERSE_CLIENT_ID` and
 * `OPENVERSE_CLIENT_SECRET` get a bearer token (client credentials) that is cached until it expires.
 */
export const OPENVERSE_HOST = 'api.openverse.org';
export type OpenverseKind = 'image' | 'audio';
export type OpenverseLicence = 'cc0' | 'pdm' | 'by' | 'commercial';

export interface OpenverseQuery {
  q: string;
  kind: OpenverseKind;
  /** `cc0`, `pdm` (public domain mark), `by` (attribution only) or `commercial` (any licence that allows commercial use). Default `commercial`. */
  licence?: OpenverseLicence;
  /** Results wanted, 1-20 (default 5). */
  pageSize?: number;
  /** The language of the credit line: `ru` (default) or `en`. */
  lang?: 'ru' | 'en';
}

export interface OpenverseHit {
  id: string;
  kind: OpenverseKind;
  title: string;
  creator: string;
  url: string;
  /** A small copy served by Openverse itself (host `api.openverse.org`): what the renderer downloads. */
  thumbnail: string;
  /** `cc0`, `pdm`, `by`, `by-sa`, `by-nd`... as the API says. */
  licence: string;
  licenceVersion: string;
  /** The page of the work at its source. */
  landingUrl: string;
  /** One line ready for a caption, never to be dropped: «Фото: «Title», Creator, CC BY 2.0, https://...». */
  attribution: string;
  /** The long attribution text of the API, as it is. */
  attributionFull: string;
}

export interface OpenverseTools {
  search(q: OpenverseQuery): Promise<ToolResult<OpenverseHit[]>>;
}

const str = (v: unknown, max = 300): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const https = (v: unknown): string => {
  const s = str(v, 1000);
  try {
    return new URL(s).protocol === 'https:' ? s : '';
  } catch {
    return '';
  }
};

/** «CC BY 2.0», «CC0 1.0», «Public Domain Mark 1.0». */
export function licenceLabel(licence: string, version: string): string {
  const l = licence.toLowerCase();
  if (l === 'cc0') return `CC0${version ? ` ${version}` : ''}`;
  if (l === 'pdm') return `Public Domain Mark${version ? ` ${version}` : ''}`;
  return `CC ${licence.toUpperCase()}${version ? ` ${version}` : ''}`;
}

/** The credit line for a caption. Written for every licence (CC0 does not require it, a credit costs nothing). */
export function creditLine(h: { kind: OpenverseKind; title: string; creator: string; licence: string; licenceVersion: string; landingUrl: string }, lang: 'ru' | 'en' = 'ru'): string {
  const label = lang === 'ru' ? (h.kind === 'audio' ? 'Аудио' : 'Фото') : h.kind === 'audio' ? 'Audio' : 'Photo';
  const who = h.creator || (lang === 'ru' ? 'автор не указан' : 'unknown author');
  return `${label}: «${h.title || (lang === 'ru' ? 'без названия' : 'untitled')}», ${who}, ${licenceLabel(h.licence, h.licenceVersion)}, ${h.landingUrl}`;
}

export function createOpenverse(k: Kit, web: Web): OpenverseTools {
  const l = policyOf('media.openverse.search')!.limits;
  const dayKey = () => `tools.openverse.${dayIn(k.now(), k.tz)}`;
  const minuteKey = 'tools.openverse.minute';
  const book = k.deps.journal;
  const memMinute: number[] = [];

  /** Reserves one call in the minute window and the day counter; a refusal says which budget is spent. */
  function reserve(): ToolResult<true> {
    const now = k.now();
    const days = book ? Number(book.setting(dayKey()) || 0) : 0;
    if (days >= l.perDay!) return fail('rate_limited', `Openverse budget of ${l.perDay} calls a day is spent`, { retryable: false });
    let recent: number[];
    try {
      recent = book ? (JSON.parse(book.setting(minuteKey) || '[]') as number[]) : memMinute;
    } catch {
      recent = [];
    }
    recent = recent.filter((t) => typeof t === 'number' && now - t < 60_000);
    if (recent.length >= l.perMinute!) return fail('rate_limited', `Openverse budget of ${l.perMinute} calls a minute is spent, try again in a minute`, { retryable: true });
    recent.push(now);
    if (book) {
      book.setSetting(minuteKey, JSON.stringify(recent));
      book.setSetting(dayKey(), String(days + 1));
    } else {
      memMinute.length = 0;
      memMinute.push(...recent);
    }
    return okv(true as const);
  }

  /** A bearer token when the keys are set (cached until it expires); null: anonymous. A failed token request falls back to anonymous. */
  async function token(): Promise<string | null> {
    const id = k.cfg.openverseClientId;
    const secret = k.cfg.openverseClientSecret;
    if (!id || !secret) return null;
    const cached = k.cache.getJson<{ token: string }>('t:openverse:token');
    if (cached?.token) return cached.token;
    const r = await web.post(`https://${OPENVERSE_HOST}/v1/auth_tokens/token/`, { grant_type: 'client_credentials', client_id: id, client_secret: secret }, { hosts: [OPENVERSE_HOST], as: 'form' });
    if (!r.ok) return null;
    const body = r.value.body as { access_token?: unknown; expires_in?: unknown } | null;
    const t = typeof body?.access_token === 'string' ? body.access_token : '';
    if (!t) return null;
    const ttl = Math.max(60, Math.min(Number(body?.expires_in) || 3600, 86_400) - 60) * 1000;
    k.cache.setJson('t:openverse:token', { token: t }, ttl);
    return t;
  }

  return {
    search: (q) =>
      k.call('media.openverse.search', async () => {
        if (!q || typeof q.q !== 'string' || !q.q.trim() || q.q.length > 200) return fail('invalid', 'q: 1..200 characters');
        if (q.kind !== 'image' && q.kind !== 'audio') return fail('invalid', 'kind: image or audio');
        const licence = q.licence ?? 'commercial';
        if (!['cc0', 'pdm', 'by', 'commercial'].includes(licence)) return fail('invalid', 'licence: cc0, pdm, by or commercial');
        const size = Math.min(Math.max(Math.floor(Number(q.pageSize ?? 5)) || 5, 1), l.maxResults!);
        const ck = `t:openverse:${q.kind}:${licence}:${size}:${q.q.trim().toLowerCase()}`;
        const lang = q.lang === 'en' ? 'en' : 'ru';
        const cached = k.cache.getJson<OpenverseHit[]>(ck);
        if (cached) return okv(cached);
        const spent = reserve();
        if (!spent.ok) return spent;
        const params = new URLSearchParams({ q: q.q.trim(), page_size: String(size), license_type: 'commercial' });
        if (licence !== 'commercial') params.set('license', licence);
        const bearer = await token();
        const r = await web.getJson<{ results?: unknown }>(`https://${OPENVERSE_HOST}/v1/${q.kind === 'image' ? 'images' : 'audio'}/?${params.toString()}`, {
          hosts: [OPENVERSE_HOST], noRetry: true, ...(bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {}),
        });
        if (!r.ok) return r;
        if (!r.value || !Array.isArray(r.value.results)) return fail('upstream', 'Openverse: unexpected answer', { retryable: false });
        const hits: OpenverseHit[] = [];
        for (const raw of r.value.results as Record<string, unknown>[]) {
          const url = https(raw.url);
          const landingUrl = https(raw.foreign_landing_url) || url;
          const thumbnail = https(raw.thumbnail);
          const licenceName = str(raw.license, 20).toLowerCase();
          if (!url || !licenceName || (q.kind === 'image' && !thumbnail)) continue;
          const hit = {
            id: str(raw.id, 80), kind: q.kind, title: str(raw.title, 140), creator: str(raw.creator, 120), url, thumbnail: thumbnail || url,
            licence: licenceName, licenceVersion: str(raw.license_version, 10), landingUrl,
          };
          hits.push({ ...hit, attribution: creditLine(hit, lang), attributionFull: str(raw.attribution, 600) });
          if (hits.length >= size) break;
        }
        k.cache.setJson(ck, hits, l.cacheTtlMs!);
        return okv(hits);
      }),
  };
}
