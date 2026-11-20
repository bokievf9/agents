import { decodeBody, rawRequest, type HostList, type RawResponse } from './http.js';
import { extractReadable, type Readable } from './html.js';
import type { Kit } from './kit.js';
import { policyOf } from './policy.js';
import { fail, failStatus, okv, type Dept, type ToolResult } from './result.js';
import { BRAVE_HOST, DDG_HOST, braveUrl, ddgBlocked, ddgUrl, parseBrave, parseDdg, type SearchHit } from './search.js';

export interface GetOptions {
  /** Exact https hosts the URL may point to (required: no tool takes an arbitrary URL). */
  hosts: readonly string[];
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  /**
   * Our own network (docker service names, plain http): only departments the policy lists (`support`, Monitoring); the same timeouts and size
   * caps, no public-address check and no pinned address. Anyone else gets `not_allowed`.
   */
  internal?: boolean;
  /** No repeat after a retryable failure, whatever the policy says (APIs with a call budget). */
  noRetry?: boolean;
}

export interface TextPage {
  status: number;
  text: string;
  /** The body was longer than the cap and was cut. */
  truncated: boolean;
  contentType: string;
  lastModified: string | null;
  /** The URL that answered (after redirects). */
  url: string;
}

export interface PostOptions extends GetOptions {
  /** `json` (default for objects), `form` (x-www-form-urlencoded) or `raw` (a string or bytes as given). */
  as?: 'json' | 'form' | 'raw';
  method?: 'POST' | 'PUT';
}

export interface PostAnswer {
  status: number;
  /** Parsed JSON, or null when the answer is empty or not JSON. */
  body: unknown;
  headers: Record<string, string>;
}

export interface Web {
  getJson<T = unknown>(url: string, o: GetOptions): Promise<ToolResult<T>>;
  getText(url: string, o: GetOptions): Promise<ToolResult<TextPage>>;
  /** GET a picture or another small binary file (up to 3 MB) from listed https hosts: the bytes as they are. */
  getBytes(url: string, o: { hosts: readonly string[]; timeoutMs?: number }): Promise<ToolResult<{ bytes: Buffer; contentType: string; url: string }>>;
  /** Article of a page. Hosts: the listed ones, or any public host a `search` of this toolbox returned, or `'public'` explicitly. */
  readable(url: string, o?: { hosts?: HostList; maxChars?: number }): Promise<ToolResult<Readable & { url: string; /** `jina` when the page's own HTML gave under 400 characters and Jina Reader supplied the text. */ via?: 'jina' }>>;
  search(q: string, o?: { limit?: number; lang?: string }): Promise<ToolResult<SearchHit[]>>;
  post(url: string, body: unknown, o: PostOptions): Promise<ToolResult<PostAnswer>>;
}

const lim = (name: string) => policyOf(name)!.limits;

/** Jina Reader (https://r.jina.ai/<url>): a readable-page fallback for pages whose HTML holds no text (script-built pages). */
export const JINA_HOST = 'r.jina.ai';
/** Below this many characters the page's own extraction counts as empty and Jina is tried. */
export const JINA_BELOW_CHARS = 400;
const JINA_TIMEOUT_MS = 10_000;

/** Title, date, text and links from Jina's markdown answer («Title: ...», «Published Time: ...», «Markdown Content:»). */
export function parseJina(body: string, maxChars: number): (Readable & { text: string }) | null {
  const at = body.indexOf('Markdown Content:');
  const head = at >= 0 ? body.slice(0, at) : '';
  const md = (at >= 0 ? body.slice(at + 'Markdown Content:'.length) : body).trim();
  const links: Readable['links'] = [];
  for (const m of md.matchAll(/(?<!!)\[([^\]]{1,160})\]\((https:\/\/[^)\s]+)[^)]*\)/g)) if (links.length < 30 && !links.some((l) => l.href === m[2])) links.push({ href: m[2]!, text: m[1]!.trim() });
  const text = md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*(?:#{1,6}|>|[-*+])\s+/gm, '')
    .replace(/[*_`]{1,3}/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxChars);
  if (!text) return null;
  const title = /^Title:\s*(.+)$/m.exec(head)?.[1]?.trim() ?? /^#\s+(.+)$/m.exec(md)?.[1]?.trim() ?? '';
  const when = /^Published Time:\s*(.+)$/m.exec(head)?.[1]?.trim();
  const published = when && Number.isFinite(Date.parse(when)) ? new Date(Date.parse(when)).toISOString() : null;
  return { title, text, published, links, lang: null };
}
const hostsOk = (hosts: unknown): hosts is readonly string[] => Array.isArray(hosts) && hosts.length > 0 && hosts.every((h) => typeof h === 'string' && /^[a-z0-9.-]+$/i.test(h));

export function createWeb(k: Kit): Web {
  /** Hosts that searches of this toolbox returned: `readable` may open them without a list. */
  const searched = new Set<string>();

  /** `internal: true` is a department right of the policy (`ToolPolicy.internal`), not a plain option. */
  function internalDenied(name: string, o: { internal?: boolean } | undefined): ToolResult<never> | null {
    if (!o?.internal) return null;
    return policyOf(name)?.internal?.includes(k.cx.dept as Dept) ? null : fail('not_allowed', `${name}: internal hosts are not allowed for department ${k.cx.dept}`);
  }

  async function text(name: string, url: string, hosts: HostList, o: { headers?: Record<string, string>; timeoutMs?: number; maxBytes?: number; internal?: boolean }): Promise<ToolResult<TextPage>> {
    const l = lim(name);
    const r = await rawRequest(url, {
      hosts, headers: { accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5', ...(o.headers ?? {}) },
      timeoutMs: o.timeoutMs ?? l.timeoutMs!, maxBytes: Math.min(o.maxBytes ?? l.maxBytes!, l.maxBytes!), truncate: true, redirects: 3,
      perHost: l.perHost!, minGapMs: l.minGapMs!, ...(o.internal ? { internal: true } : {}),
    }, k.net);
    if (!r.ok) return r;
    const v = r.value;
    if (v.status < 200 || v.status >= 300) return failStatus(v.status, new URL(v.url).hostname);
    const ct = v.headers['content-type'] ?? '';
    if (ct && !/text\/|html|xml|json|javascript/i.test(ct)) return fail('invalid', `not a text answer (${ct.slice(0, 40)})`, { status: v.status });
    return okv({ status: v.status, text: decodeBody(v.bytes, ct), truncated: v.truncated, contentType: ct, lastModified: v.headers['last-modified'] ?? null, url: v.url });
  }

  async function json<T>(name: string, url: string, o: GetOptions): Promise<ToolResult<T>> {
    if (!hostsOk(o?.hosts)) return fail('invalid', 'hosts: a non-empty list of host names is required');
    const denied = internalDenied(name, o);
    if (denied) return denied;
    const l = lim(name);
    const r = await rawRequest(url, {
      hosts: o.hosts, headers: { accept: 'application/json', ...(o.headers ?? {}) }, timeoutMs: o.timeoutMs ?? l.timeoutMs!,
      maxBytes: Math.min(o.maxBytes ?? l.maxBytes!, 10_000_000), perHost: l.perHost!, minGapMs: l.minGapMs!, ...(o.internal ? { internal: true } : {}),
    }, k.net);
    if (!r.ok) return r;
    if (r.value.status < 200 || r.value.status >= 300) return failStatus(r.value.status, new URL(url).hostname);
    try {
      return okv(JSON.parse(r.value.bytes.toString('utf8')) as T);
    } catch {
      return fail('upstream', `${new URL(url).hostname}: answer is not JSON`, { status: r.value.status, retryable: false });
    }
  }

  /** The text of a page through Jina Reader, or null (the answer is journaled either way; it never fails the call). */
  async function jina(pageUrl: string, maxChars: number): Promise<(Readable & { text: string }) | null> {
    const host = new URL(pageUrl).hostname;
    const say = (detail: string) => k.deps.journal?.log(k.cx.agentId, 'tool:web.readable.jina', 'url', host, detail);
    const r = await text('web.readable', `https://${JINA_HOST}/${pageUrl}`, [JINA_HOST], { timeoutMs: JINA_TIMEOUT_MS, headers: { accept: 'text/plain', 'x-return-format': 'markdown' } });
    if (!r.ok) {
      say(`failed ${r.error}`);
      return null;
    }
    const parsed = parseJina(r.value.text, maxChars);
    say(parsed ? `ok ${parsed.text.length} chars` : 'empty');
    return parsed;
  }

  async function search(q: string, o: { limit?: number; lang?: string } = {}): Promise<ToolResult<SearchHit[]>> {
    const query = typeof q === 'string' ? q.trim().replace(/\s+/g, ' ') : '';
    if (!query || query.length > 400) return fail('invalid', 'query: 1..400 characters');
    const l = lim('web.search');
    const limit = Math.min(Math.max(1, Math.floor(o.limit ?? l.maxResults!)), l.maxResults!);
    const lang = o.lang && /^[a-z]{2}$/.test(o.lang) ? o.lang : undefined;
    const key = k.cfg.braveSearchKey;
    const provider = key ? 'brave' : 'ddg';
    const ck = `t:search:${provider}:${lang ?? ''}:${limit}:${query.toLowerCase()}`;
    const hit = k.cache.getJson<SearchHit[]>(ck);
    if (hit) {
      for (const h of hit) searched.add(new URL(h.url).hostname);
      return okv(hit);
    }
    let hits: SearchHit[];
    if (key) {
      const r = await rawRequest(braveUrl(query, limit, lang), {
        hosts: [BRAVE_HOST], headers: { accept: 'application/json', 'x-subscription-token': key }, timeoutMs: l.timeoutMs!, maxBytes: 2_000_000, perHost: 1, minGapMs: l.minGapMs!,
      }, k.net);
      if (!r.ok) return r;
      if (r.value.status !== 200) return failStatus(r.value.status, 'Brave Search');
      let body: unknown;
      try {
        body = JSON.parse(r.value.bytes.toString('utf8'));
      } catch {
        return fail('upstream', 'Brave Search: answer is not JSON', { retryable: false });
      }
      const parsed = parseBrave(body);
      if (!parsed) return fail('upstream', 'Brave Search: unexpected answer', { retryable: false });
      hits = parsed;
    } else {
      const r: ToolResult<RawResponse> = await rawRequest(ddgUrl(query, lang), {
        hosts: [DDG_HOST], headers: { accept: 'text/html', 'accept-language': lang === 'en' ? 'en' : 'ru,en;q=0.8' }, timeoutMs: l.timeoutMs!, maxBytes: 1_000_000,
        truncate: true, perHost: 1, minGapMs: l.minGapMs!,
      }, k.net);
      if (!r.ok) return r;
      if (r.value.status !== 200) return failStatus(r.value.status, 'DuckDuckGo');
      const html = r.value.bytes.toString('utf8');
      if (ddgBlocked(html)) return fail('rate_limited', 'DuckDuckGo asked for a challenge; set BRAVE_SEARCH_KEY', { retryable: false });
      hits = parseDdg(html);
    }
    hits = hits.slice(0, limit);
    k.cache.setJson(ck, hits, l.cacheTtlMs!);
    for (const h of hits) {
      try {
        searched.add(new URL(h.url).hostname);
      } catch {
        /* skipped */
      }
    }
    return okv(hits);
  }

  return {
    // an internal call is a monitoring probe: no `activity` line on success and no retries (the monitor's own hysteresis decides)
    getJson: <T>(url: string, o: GetOptions) => k.call('web.getJson', () => json<T>('web.getJson', url, o), o?.internal ? { quiet: true, retries: 0 } : o?.noRetry ? { retries: 0 } : undefined),
    getText: (url, o) =>
      k.call('web.getText', () => {
        if (!hostsOk(o?.hosts)) return Promise.resolve(fail('invalid', 'hosts: a non-empty list of host names is required'));
        const denied = internalDenied('web.getText', o);
        return denied ? Promise.resolve(denied) : text('web.getText', url, o.hosts, o);
      }, o?.internal ? { quiet: true, retries: 0 } : undefined),
    getBytes: (url, o) =>
      k.call('web.getBytes', async () => {
        if (!hostsOk(o?.hosts)) return fail('invalid', 'hosts: a non-empty list of host names is required');
        const l = lim('web.getBytes');
        const r = await rawRequest(url, { hosts: o.hosts, headers: { accept: 'image/*,*/*;q=0.5' }, timeoutMs: o.timeoutMs ?? l.timeoutMs!, maxBytes: l.maxBytes!, redirects: 3, perHost: l.perHost!, minGapMs: l.minGapMs! }, k.net);
        if (!r.ok) return r;
        if (r.value.status < 200 || r.value.status >= 300) return failStatus(r.value.status, new URL(r.value.url).hostname);
        return okv({ bytes: r.value.bytes, contentType: r.value.headers['content-type'] ?? '', url: r.value.url });
      }),
    readable: (url, o = {}) =>
      k.call('web.readable', async () => {
        let hosts: HostList;
        if (o.hosts === 'public') hosts = 'public';
        else if (o.hosts !== undefined) {
          if (!hostsOk(o.hosts)) return fail('invalid', 'hosts: a list of host names or "public"');
          hosts = o.hosts;
        } else hosts = [...searched];
        if (hosts !== 'public' && hosts.length === 0) return fail('blocked', 'no host list: pass hosts, or read a page a search returned');
        const page = await text('web.readable', url, hosts, {});
        if (!page.ok) return page;
        const max = o.maxChars ?? 20_000;
        const own: Readable & { url: string; via?: 'jina' } =
          !/html|xml/i.test(page.value.contentType) && !/<html|<body|<p[\s>]/i.test(page.value.text.slice(0, 2000))
            ? { url: page.value.url, title: '', text: page.value.text.slice(0, max), published: page.value.lastModified ? new Date(page.value.lastModified).toISOString() : null, links: [], lang: null }
            : { url: page.value.url, ...extractReadable(page.value.text, page.value.url, max) };
        // a page whose HTML holds almost no text (built by scripts): Jina Reader gets one try, 10 s; its failure leaves the own result as it was
        if (own.text.length < JINA_BELOW_CHARS) {
          const j = await jina(page.value.url, max);
          if (j && j.text.length > own.text.length) return okv({ ...own, title: j.title || own.title, text: j.text, published: own.published ?? j.published, links: own.links.length ? own.links : j.links, via: 'jina' as const });
        }
        return okv(own);
      }),
    search: (q, o) => k.call('web.search', () => search(q, o)),
    post: (url, body, o) =>
      k.call('web.post', async () => {
        if (!hostsOk(o?.hosts)) return fail('invalid', 'hosts: a non-empty list of host names is required');
        const as = o.as ?? (typeof body === 'string' || body instanceof Uint8Array ? 'raw' : 'json');
        let payload: string | Uint8Array;
        let ct: string | undefined;
        if (as === 'raw') {
          if (typeof body !== 'string' && !(body instanceof Uint8Array)) return fail('invalid', 'raw body must be a string or bytes');
          payload = body;
        } else if (as === 'form') {
          if (!body || typeof body !== 'object') return fail('invalid', 'form body must be an object');
          payload = new URLSearchParams(Object.entries(body as Record<string, unknown>).map(([a, b]) => [a, String(b)])).toString();
          ct = 'application/x-www-form-urlencoded';
        } else {
          try {
            payload = JSON.stringify(body);
          } catch {
            return fail('invalid', 'body is not serialisable');
          }
          ct = 'application/json';
        }
        const l = lim('web.post');
        const r = await rawRequest(url, {
          method: o.method ?? 'POST', hosts: o.hosts, headers: { accept: 'application/json', ...(ct ? { 'content-type': ct } : {}), ...(o.headers ?? {}) },
          body: payload, timeoutMs: o.timeoutMs ?? l.timeoutMs!, maxBytes: Math.min(o.maxBytes ?? l.maxBytes!, 10_000_000), perHost: l.perHost!, minGapMs: l.minGapMs!,
        }, k.net);
        if (!r.ok) return { ...r, retryable: false }; // a POST is never repeated blindly
        let parsed: unknown;
        try {
          parsed = r.value.bytes.length ? JSON.parse(r.value.bytes.toString('utf8')) : null;
        } catch {
          parsed = null;
        }
        if (r.value.status < 200 || r.value.status >= 300) return { ...failStatus(r.value.status, new URL(url).hostname), retryable: false };
        return okv({ status: r.value.status, body: parsed, headers: r.value.headers });
      }),
  };
}

/**
 * Hosts of the public pages the owner may drop as links for the Trendwatcher (`/trend <url>`, `POST /admin/trends`): Instagram, TikTok and
 * YouTube posts, and the oEmbed endpoints of YouTube and TikTok. Passed as `hosts` to `web.getText` / `web.getJson` (the policy is by
 * department, the host list is by call). Never a login: only what the platform serves to an anonymous visitor.
 */
export const SOCIAL_HOSTS = ['www.instagram.com', 'instagram.com', 'www.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com', 'www.youtube.com', 'm.youtube.com', 'youtube.com', 'youtu.be'] as const;
