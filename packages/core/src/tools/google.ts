import { createSign } from 'node:crypto';
import { GOOGLE_HOSTS, GoogleAuth, parseClientJson, type PostFn } from '../google-oauth.js';
import { errMsg } from '../log.js';
import { safePost } from '../net.js';
import { YT_QUOTA_LIMIT, YT_UPLOAD_COST, youtubeResumableUpload } from '../youtube.js';
import { decodeBody, rawRequest } from './http.js';
import type { Kit } from './kit.js';
import { policyOf } from './policy.js';
import { dayIn, fail, failStatus, okv, type ToolResult } from './result.js';

export interface ChannelStats {
  subscribers: number;
  views: number;
  videos: number;
}
export interface VideoStats {
  id: string;
  title: string;
  publishedAt: string | null;
  views: number;
  likes: number;
  comments: number;
}
export interface TrendItem {
  title: string;
  /** «200+», as Google writes it. */
  traffic: string | null;
  newsTitle: string | null;
  newsUrl: string | null;
  link: string;
  geo: string;
}
export interface GscRow {
  key: string;
  clicks: number;
  impressions: number;
  position: number;
}
export interface GscReport {
  queries: GscRow[];
  pages: GscRow[];
  from: string;
  to: string;
}
export interface UploadInput {
  /** Bytes of the video (an MP4), or a path under the files folder (`files.put` result). */
  bytes?: Uint8Array;
  path?: string;
  title: string;
  description?: string;
  tags?: string[];
  privacy?: 'public' | 'unlisted' | 'private';
  /** Scheduled publication (ISO); the video is uploaded private and goes public then. */
  publishAt?: string;
}

export interface Google {
  youtube: {
    channel(): Promise<ToolResult<ChannelStats>>;
    videos(ids: string[]): Promise<ToolResult<VideoStats[]>>;
    upload(v: UploadInput): Promise<ToolResult<{ id: string; url: string }>>;
  };
  /** Google Trends daily trending searches of a region (public RSS, no key); `q` keeps only items that mention it. */
  trends(o: { geo: string; q?: string; limit?: number }): Promise<ToolResult<TrendItem[]>>;
  /** Search Console top queries and pages of the last `days` (data lag about 3 days). */
  searchConsole(o?: { days?: number }): Promise<ToolResult<GscReport>>;
}

export const TRENDS_HOST = 'trends.google.com';
const YT = 'https://www.googleapis.com/youtube/v3';
const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

const decode = (s: string): string =>
  s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").trim();
const tag = (block: string, name: string): string | undefined => {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(block);
  return m ? decode(m[1]!) : undefined;
};

/** Google Trends daily RSS -> items (titles, approximate traffic, the first news link). */
export function parseTrendsFeed(xml: string, geo: string): TrendItem[] {
  const out: TrendItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1]!;
    const title = tag(block, 'title');
    if (!title) continue;
    out.push({
      title, traffic: tag(block, 'ht:approx_traffic') ?? null, newsTitle: tag(block, 'ht:news_item_title') ?? null, newsUrl: tag(block, 'ht:news_item_url') ?? null,
      link: tag(block, 'link') ?? `https://trends.google.com/trends/explore?q=${encodeURIComponent(title)}&geo=${geo}`, geo,
    });
  }
  return out;
}

/** Service-account OAuth without a library: an RS256 JWT bearer grant. The key never leaves this function. */
export function serviceAccountAssertion(json: { client_email: string; private_key: string }, scope: string, nowMs: number): string {
  const b64 = (v: string) => Buffer.from(v).toString('base64url');
  const iat = Math.floor(nowMs / 1000);
  const claim = { iss: json.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3000 };
  const unsigned = `${b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64(JSON.stringify(claim))}`;
  return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(json.private_key).toString('base64url')}`;
}

const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export function createGoogle(k: Kit): Google {
  const cfg = k.cfg;
  const post: PostFn = (url, o) => safePost(url, { ...o, ...(k.deps.fetch ? { fetch: k.deps.fetch } : {}), ...(k.net.lookup ? { lookup: k.net.lookup } : k.deps.fetch ? { lookup: () => Promise.resolve(['93.184.215.14']) } : {}) });
  const client = parseClientJson(cfg.ytOauthClientJson);
  const oauth = client && cfg.ytRefreshToken ? new GoogleAuth({ client, refreshToken: cfg.ytRefreshToken, now: k.now, post }) : null;

  const get = async (name: string, url: string, headers: Record<string, string> = {}): Promise<ToolResult<unknown>> => {
    const l = policyOf(name)!.limits;
    const r = await rawRequest(url, { hosts: GOOGLE_HOSTS, headers: { accept: 'application/json', ...headers }, timeoutMs: l.timeoutMs ?? 10_000, maxBytes: l.maxBytes ?? 1_000_000, perHost: l.perHost ?? 2, minGapMs: l.minGapMs ?? 0 }, k.net);
    if (!r.ok) return r;
    if (r.value.status !== 200) return failStatus(r.value.status, 'Google API');
    try {
      return okv(JSON.parse(r.value.bytes.toString('utf8')));
    } catch {
      return fail('upstream', 'Google API: answer is not JSON', { retryable: false });
    }
  };
  /** Auth for a read: the owner's token (`mine`) or the API key; null when neither. */
  const readAuth = async (): Promise<{ headers: Record<string, string>; key: string } | ToolResult<never>> => {
    if (oauth) {
      try {
        return { headers: { authorization: `Bearer ${await oauth.accessToken()}` }, key: '' };
      } catch (e) {
        return fail('upstream', `Google OAuth: ${errMsg(e).slice(0, 80)}`, { retryable: false });
      }
    }
    return { headers: {}, key: `&key=${encodeURIComponent(cfg.youtubeApiKey!)}` };
  };

  return {
    youtube: {
      channel: () =>
        k.call('google.youtube.channel', async () => {
          const a = await readAuth();
          if ('ok' in a) return a;
          const url = oauth ? `${YT}/channels?part=statistics&mine=true` : `${YT}/channels?part=statistics&id=${encodeURIComponent(cfg.youtubeChannelId!)}${a.key}`;
          const r = await get('google.youtube.channel', url, a.headers);
          if (!r.ok) return r;
          const s = (r.value as { items?: { statistics?: Record<string, unknown> }[] }).items?.[0]?.statistics;
          if (!s) return fail('not_found', 'YouTube: channel not found');
          return okv({ subscribers: n(s.subscriberCount), views: n(s.viewCount), videos: n(s.videoCount) });
        }),
      videos: (ids) =>
        k.call('google.youtube.videos', async () => {
          if (!Array.isArray(ids) || ids.length === 0 || ids.length > 50 || ids.some((i) => typeof i !== 'string' || !/^[\w-]{6,20}$/.test(i))) return fail('invalid', 'ids: 1..50 video ids');
          const a = await readAuth();
          if ('ok' in a) return a;
          const r = await get('google.youtube.videos', `${YT}/videos?part=snippet,statistics&id=${ids.map(encodeURIComponent).join(',')}${a.key}`, a.headers);
          if (!r.ok) return r;
          const items = (r.value as { items?: { id?: string; snippet?: { title?: string; publishedAt?: string }; statistics?: Record<string, unknown> }[] }).items ?? [];
          return okv(items.filter((v) => typeof v.id === 'string').map((v) => ({
            id: v.id!, title: v.snippet?.title ?? '', publishedAt: v.snippet?.publishedAt ?? null, views: n(v.statistics?.viewCount), likes: n(v.statistics?.likeCount), comments: n(v.statistics?.commentCount),
          })));
        }),
      upload: (v) =>
        k.call('google.youtube.upload', async () => {
          if (!v || typeof v.title !== 'string' || !v.title.trim() || v.title.length > 100) return fail('invalid', 'title: 1..100 characters');
          if (v.description !== undefined && (typeof v.description !== 'string' || v.description.length > 5000)) return fail('invalid', 'description: up to 5000 characters');
          if (v.publishAt !== undefined && !Number.isFinite(Date.parse(v.publishAt))) return fail('invalid', 'publishAt: an ISO date');
          let bytes = v.bytes;
          if (!bytes && v.path) {
            const files = k.files();
            const f = await files.get(v.path);
            if (!f.ok) return f;
            bytes = f.value.bytes;
          }
          if (!bytes || bytes.length < 12) return fail('invalid', 'bytes or path of a video is required');
          const max = policyOf('google.youtube.upload')!.limits.maxBytes!;
          if (bytes.length > max) return fail('too_large', `video over ${max} bytes`);
          const day = dayIn(k.now(), k.tz);
          if (k.deps.youtubeQuota && k.deps.youtubeQuota.used(day) + YT_UPLOAD_COST > YT_QUOTA_LIMIT) return fail('rate_limited', 'YouTube quota of the day is spent', { retryable: false });
          let token: string;
          try {
            token = await oauth!.accessToken();
          } catch (e) {
            return fail('upstream', `Google OAuth: ${errMsg(e).slice(0, 80)}`, { retryable: false });
          }
          k.deps.youtubeQuota?.add(day, YT_UPLOAD_COST);
          const meta = {
            snippet: { title: v.title.trim(), description: v.description ?? '', tags: (v.tags ?? []).slice(0, 30), categoryId: '28', defaultLanguage: 'ru' },
            status: { privacyStatus: v.publishAt ? 'private' : (v.privacy ?? 'public'), selfDeclaredMadeForKids: false, ...(v.publishAt ? { publishAt: new Date(v.publishAt).toISOString() } : {}) },
          };
          const r = await youtubeResumableUpload(post, token, meta, bytes);
          if (!r.ok) return fail(r.transport === 'timeout' ? 'timeout' : r.transport ? 'network' : 'upstream', `YouTube ${r.stage}: ${r.transport ?? `HTTP ${r.status}${r.reason}`}`, { retryable: false, ...(r.status ? { status: r.status } : {}) });
          return okv({ id: r.id, url: `https://youtube.com/shorts/${r.id}` });
        }),
    },
    trends: (o) =>
      k.call('google.trends', async () => {
        const geo = typeof o?.geo === 'string' ? o.geo.toUpperCase() : '';
        if (!/^[A-Z]{2}$/.test(geo)) return fail('invalid', 'geo: a two-letter region code');
        const l = policyOf('google.trends')!.limits;
        const limit = Math.min(Math.max(1, o.limit ?? l.maxResults!), l.maxResults!);
        const ck = `t:trends:${geo}`;
        let items = k.cache.getJson<TrendItem[]>(ck);
        if (!items) {
          const r = await rawRequest(`https://${TRENDS_HOST}/trending/rss?geo=${geo}`, { hosts: [TRENDS_HOST], headers: { accept: 'application/rss+xml, application/xml, text/xml' }, timeoutMs: l.timeoutMs!, maxBytes: l.maxBytes!, perHost: l.perHost!, minGapMs: l.minGapMs! }, k.net);
          if (!r.ok) return r;
          if (r.value.status !== 200) return failStatus(r.value.status, 'Google Trends');
          items = parseTrendsFeed(decodeBody(r.value.bytes, r.value.headers['content-type']), geo);
          k.cache.setJson(ck, items, l.cacheTtlMs!);
        }
        const q = o.q?.trim().toLowerCase();
        return okv((q ? items.filter((i) => `${i.title} ${i.newsTitle ?? ''}`.toLowerCase().includes(q)) : items).slice(0, limit));
      }),
    searchConsole: (o = {}) =>
      k.call('google.searchConsole', async () => {
        const days = Math.min(Math.max(7, Math.floor(o.days ?? 28)), 90);
        let json: { client_email?: string; private_key?: string };
        try {
          json = JSON.parse(cfg.gscServiceAccountJson!) as typeof json;
        } catch {
          return fail('not_configured', 'GSC_SERVICE_ACCOUNT_JSON is not JSON');
        }
        if (!json.client_email || !json.private_key) return fail('not_configured', 'GSC_SERVICE_ACCOUNT_JSON: no client_email or private_key');
        const ck = `t:gsc:${cfg.gscSiteUrl}:${days}:${dayIn(k.now(), k.tz)}`;
        const hit = k.cache.getJson<GscReport>(ck);
        if (hit) return okv(hit);
        let assertion: string;
        try {
          assertion = serviceAccountAssertion({ client_email: json.client_email, private_key: json.private_key }, GSC_SCOPE, k.now());
        } catch {
          return fail('not_configured', 'GSC_SERVICE_ACCOUNT_JSON: the private key does not sign');
        }
        const tok = await post('https://oauth2.googleapis.com/token', {
          allowHosts: GOOGLE_HOSTS, headers: { 'content-type': 'application/x-www-form-urlencoded' }, timeoutMs: 10_000,
          body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
        });
        if (!tok.ok) return fail(tok.error === 'timeout' ? 'timeout' : 'network', `GSC token: ${tok.error}`);
        const token = (tok.body as { access_token?: unknown } | null)?.access_token;
        if (tok.status !== 200 || typeof token !== 'string') return failStatus(tok.status === 200 ? 502 : tok.status, 'GSC token');
        const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
        const to = ymd(k.now() - 3 * 86_400_000);
        const from = ymd(k.now() - (days + 3) * 86_400_000);
        const query = async (dimension: 'query' | 'page'): Promise<ToolResult<GscRow[]>> => {
          const r = await post(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(cfg.gscSiteUrl!)}/searchAnalytics/query`, {
            allowHosts: GOOGLE_HOSTS, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, timeoutMs: 10_000,
            body: JSON.stringify({ startDate: from, endDate: to, dimensions: [dimension], rowLimit: 10 }),
          });
          if (!r.ok) return fail(r.error === 'timeout' ? 'timeout' : 'network', `GSC query: ${r.error}`);
          if (r.status !== 200) return failStatus(r.status, 'GSC query');
          const rows = (r.body as { rows?: { keys?: string[]; clicks?: number; impressions?: number; position?: number }[] } | null)?.rows ?? [];
          return okv(rows.map((x) => ({ key: x.keys?.[0] ?? '', clicks: n(x.clicks), impressions: n(x.impressions), position: Math.round(n(x.position) * 10) / 10 })));
        };
        const queries = await query('query');
        if (!queries.ok) return queries;
        const pages = await query('page');
        if (!pages.ok) return pages;
        const rep = { queries: queries.value, pages: pages.value, from, to };
        k.cache.setJson(ck, rep, policyOf('google.searchConsole')!.limits.cacheTtlMs!);
        return okv(rep);
      }),
  };
}
