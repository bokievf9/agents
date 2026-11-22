import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { decodeEntities, MAX_HTML_DEPTH, parseHtml, pinnedFetch, resolvePublic, systemLookup, type HNode } from '@fir/core';

/**
 * The crawler of a client's own website (brief «знания клиента», 2026-11-23). Same host only (`www.` is the same site), `robots.txt` respected, at most
 * `MAX_PAGES` pages and `MAX_CHARS` of text, `PAGE_TIMEOUT_MS` per page, sequential and polite. HTML becomes plain text with the headings kept (`# `, `## `);
 * lines repeated across pages (menus, footers) are kept once; a page whose text equals an earlier one is dropped. It never runs scripts and never logs
 * page text. The address comes from a stranger (the site's brief), so production fetches only public addresses (`publicFetcher`, pinned like the web tool).
 */
export const MAX_PAGES = 30;
export const MAX_CHARS = 1_500_000;
export const PAGE_TIMEOUT_MS = 10_000;
/** The body of one page is cut here. */
export const MAX_PAGE_BYTES = 600_000;
const MAX_PAGE_CHARS = 120_000;
const AGENT = 'FirTechKnowledgeBot';

export interface Fetched {
  status: number;
  type: string;
  location: string;
  body: string;
}
/** One GET without redirects; throws on network errors and timeouts. */
export type Fetcher = (url: string) => Promise<Fetched>;

async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    size += value.byteLength;
    if (size >= max) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return Buffer.concat(chunks).subarray(0, max).toString('utf8');
}

/** The body is read only for text types (HTML, XML, plain text) and for answers without a type: a video or an archive is never downloaded. */
async function bodyOf(res: Response): Promise<{ type: string; body: string }> {
  const type = res.headers.get('content-type') ?? '';
  if (type && !/html|xml|text\//i.test(type)) {
    await res.body?.cancel().catch(() => undefined);
    return { type, body: '' };
  }
  return { type, body: await readCapped(res, MAX_PAGE_BYTES) };
}

const headers = { 'user-agent': AGENT, accept: 'text/html,application/xhtml+xml,text/plain,application/xml;q=0.8' };
const CRAWL_PORTS = new Set(['', '80', '443']);

export interface PublicFetcherOptions {
  lookup?: (h: string) => Promise<string[]>;
  /** Addresses of this very server (`PUBLIC_IP`, `SELF_IPS`): a site that resolves to one of them is never fetched (the crawler must not knock on its own host). */
  selfIps?: readonly string[];
}

/** Production: only public addresses on ports 80 and 443, never this server itself; the checked address is the one connected to. */
export function publicFetcher(o: PublicFetcherOptions = {}): Fetcher {
  const lookup = o.lookup ?? systemLookup;
  const self = new Set((o.selfIps ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean));
  const guarded = async (h: string): Promise<string[]> => {
    const addrs = await lookup(h);
    return addrs.some((a) => self.has(a.toLowerCase())) ? ['0.0.0.0'] : addrs;
  };
  return async (url) => {
    const u = new URL(url);
    if (!CRAWL_PORTS.has(u.port)) throw new Error('port blocked');
    const bare = u.hostname.replace(/^\[|\]$/g, '');
    if (isIP(bare) !== 0 && self.has(bare.toLowerCase())) throw new Error('host blocked');
    const r = await resolvePublic(u.hostname, guarded);
    if (typeof r === 'string') throw new Error(`host ${r}`);
    const res = await pinnedFetch(url, { redirect: 'manual', signal: AbortSignal.timeout(PAGE_TIMEOUT_MS), headers }, r.ok);
    return { status: res.status, location: res.headers.get('location') ?? '', ...(await bodyOf(res)) };
  };
}

/** Tests and local runs: any address and port (a fixture on 127.0.0.1). Never wired in production. */
export function plainFetcher(): Fetcher {
  return async (url) => {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(PAGE_TIMEOUT_MS), headers });
    return { status: res.status, location: res.headers.get('location') ?? '', ...(await bodyOf(res)) };
  };
}

/** `http`/`https` only, no credentials. */
export function parseSiteUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || !u.hostname) return null;
  u.hash = '';
  return u;
}

const bareHost = (h: string): string => h.toLowerCase().replace(/^www\./, '');
/** The port that tells sites apart: the default ports of http and https are one (a redirect http to https stays on the site), any other port is its own site. */
const portKey = (u: URL): string => (u.port === '' || u.port === '80' || u.port === '443' ? 'default' : u.port);
export const sameSite = (a: URL, b: URL): boolean => bareHost(a.hostname) === bareHost(b.hostname) && portKey(a) === portKey(b);

const SKIP_EXT = /\.(?:pdf|jpe?g|png|gif|webp|svg|ico|avif|mp4|mp3|mov|avi|zip|rar|7z|gz|docx?|xlsx?|pptx?|css|js|json|xml|txt|woff2?|ttf|eot)$/i;

/** One canonical form per page: no hash, no tracking parameters, no trailing slash (but the root), host lowercase. */
export function canonical(u: URL): string {
  const c = new URL(u.href);
  c.hash = '';
  for (const k of [...c.searchParams.keys()]) if (/^(?:utm_|fbclid|gclid|yclid|_ga|ref$)/i.test(k)) c.searchParams.delete(k);
  c.searchParams.sort();
  if (c.pathname.length > 1) c.pathname = c.pathname.replace(/\/+$/, '') || '/';
  return c.href;
}

// ---- robots.txt ----
export interface Robots {
  allowed(path: string): boolean;
  sitemaps: string[];
  crawlDelayMs: number;
}
const ALLOW_ALL: Robots = { allowed: () => true, sitemaps: [], crawlDelayMs: 0 };
const DENY_ALL: Robots = { allowed: () => false, sitemaps: [], crawlDelayMs: 0 };
/** A rule longer than this, or with more `*`, is ignored; a path is cut here before matching. They bound the work of one match. */
export const ROBOTS_MAX_RULE = 256;
export const ROBOTS_MAX_STARS = 3;
export const ROBOTS_MAX_PATH = 2000;

/** `Disallow`/`Allow` pattern against a path without a regular expression: the parts between `*` are found in order (`$` at the end anchors). Linear in the path times the stars. */
export function ruleMatches(pat: string, rawPath: string): boolean {
  const path = rawPath.length > ROBOTS_MAX_PATH ? rawPath.slice(0, ROBOTS_MAX_PATH) : rawPath;
  const anchored = pat.endsWith('$');
  const parts = (anchored ? pat.slice(0, -1) : pat).split('*');
  const first = parts[0]!;
  if (!path.startsWith(first)) return false;
  let pos = first.length;
  if (parts.length === 1) return anchored ? path.length === first.length : true;
  const last = parts[parts.length - 1]!;
  for (let i = 1; i < parts.length - 1; i++) {
    const at = path.indexOf(parts[i]!, pos);
    if (at < 0) return false;
    pos = at + parts[i]!.length;
  }
  if (!anchored) {
    if (last === '') return true;
    return path.indexOf(last, pos) >= 0;
  }
  return path.length - last.length >= pos && path.endsWith(last);
}

export function parseRobots(text: string): Robots {
  const sitemaps: string[] = [];
  const groups: { agents: string[]; rules: { allow: boolean; pat: string }[]; delay: number }[] = [];
  let cur: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of text.slice(0, 500_000).replace(/\r/g, '').split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const val = m[2]!.trim();
    if (key === 'sitemap') {
      sitemaps.push(val);
      continue;
    }
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [], delay: 0 };
        groups.push(cur);
      }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if (key === 'allow' || key === 'disallow') cur.rules.push({ allow: key === 'allow', pat: val });
    else if (key === 'crawl-delay') cur.delay = Math.min(10, Math.max(0, Number(val) || 0)) * 1000;
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== '*' && AGENT.toLowerCase().includes(a)));
  const use = mine.length ? mine : groups.filter((g) => g.agents.includes('*'));
  // a rule that is too long or has too many wildcards is dropped (a hostile file must not cost time)
  const rules = use.flatMap((g) => g.rules).filter((r) => r.pat !== '' && r.pat.length <= ROBOTS_MAX_RULE && (r.pat.match(/\*/g)?.length ?? 0) <= ROBOTS_MAX_STARS).slice(0, 500);
  const delay = Math.max(0, ...use.map((g) => g.delay));
  return {
    sitemaps: sitemaps.slice(0, 10),
    crawlDelayMs: delay,
    allowed(path) {
      let best: { allow: boolean; len: number } | null = null;
      for (const r of rules) {
        if (best && r.pat.length < best.len) continue;
        if (!ruleMatches(r.pat, path)) continue;
        if (!best || r.pat.length > best.len || r.allow) best = { allow: r.allow, len: r.pat.length };
      }
      return best ? best.allow : true;
    },
  };
}

// ---- html to text ----
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'canvas', 'head', 'select', 'textarea', 'input', 'button', 'object', 'audio', 'video', 'title']);
const BLOCKS = new Set(['p', 'div', 'section', 'article', 'main', 'ul', 'ol', 'li', 'table', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'figure', 'figcaption', 'header', 'footer', 'nav', 'aside', 'form', 'dl', 'dt', 'dd', 'br', 'hr', 'address']);
const HEADING = /^h([1-6])$/;
const MAX_LINKS = 3000;

export interface PageText {
  title: string;
  text: string;
  links: string[];
  noindex: boolean;
}

/** Text with headings kept as `#` lines, list items as `- `; the links of the page as absolute URLs. */
export function htmlToText(html: string, base: string): PageText {
  const root = parseHtml(html);
  const parts: string[] = [];
  const links: string[] = [];
  let title = '';
  let noindex = false;
  // an explicit stack, not recursion: a page of very deep markup cannot overflow the call stack
  interface Frame { n: HNode; drop: boolean; block: boolean; i: number }
  const stack: Frame[] = [];
  const enter = (n: HNode, skip: boolean): void => {
    if (n.tag === 'title' && !title) title = decodeEntities(n.children.filter((c): c is string => typeof c === 'string').join(' ')).replace(/\s+/g, ' ').trim();
    if (n.tag === 'meta' && (n.attrs.name ?? '').toLowerCase() === 'robots' && /noindex/i.test(n.attrs.content ?? '')) noindex = true;
    if (n.tag === 'a' && n.attrs.href && links.length < MAX_LINKS && !/\bnofollow\b/i.test(n.attrs.rel ?? '')) {
      try {
        links.push(new URL(n.attrs.href, base).href);
      } catch {
        /* a broken href */
      }
    }
    const hidden = n.attrs.hidden !== undefined || n.attrs['aria-hidden'] === 'true' || /display\s*:\s*none/i.test(n.attrs.style ?? '');
    const drop = skip || SKIP_TAGS.has(n.tag) || hidden;
    const block = BLOCKS.has(n.tag);
    const h = HEADING.exec(n.tag);
    if (!drop && block) parts.push('\n');
    if (!drop && h) parts.push(`${'#'.repeat(Number(h[1]))} `);
    else if (!drop && n.tag === 'li') parts.push('- ');
    stack.push({ n, drop, block, i: 0 });
  };
  enter(root, false);
  while (stack.length) {
    const f = stack[stack.length - 1]!;
    const c = f.n.children[f.i++];
    if (c === undefined) {
      if (!f.drop && f.block) parts.push('\n');
      stack.pop();
    } else if (typeof c === 'string') {
      if (!f.drop) parts.push(c);
    } else if (stack.length <= MAX_HTML_DEPTH + 8) enter(c, f.drop);
  }
  const lines = parts.join('').split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l !== '' && !/^[#-]+$/.test(l));
  return { title, text: lines.join('\n'), links, noindex };
}

// ---- the crawl ----
export interface CrawledPage {
  url: string;
  title: string;
  text: string;
}
export interface CrawlResult {
  pages: CrawledPage[];
  /** Pages tried and not kept: errors, robots, non-HTML, noindex, duplicates. Counts only. */
  skipped: number;
  errors: number;
  chars: number;
  truncated: boolean;
}

export interface CrawlOptions {
  fetcher: Fetcher;
  maxPages?: number;
  maxChars?: number;
  /** Pause between requests (default 300 ms, the larger of it and the site's Crawl-delay). */
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const MAX_HOPS = 3;

export async function crawlSite(start: URL, o: CrawlOptions): Promise<CrawlResult> {
  const maxPages = Math.min(MAX_PAGES, Math.max(1, Math.floor(o.maxPages ?? MAX_PAGES)));
  const maxChars = Math.min(MAX_CHARS, o.maxChars ?? MAX_CHARS);
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const origin = new URL(start.origin);

  /** One GET that follows at most `MAX_HOPS` redirects, only inside the site; null when it leads away or loops. `final` is the address that answered. */
  const getFollowing = async (url: string): Promise<{ res: Fetched; final: string } | null> => {
    let cur = url;
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      const res = await o.fetcher(cur);
      if (res.status < 300 || res.status >= 400 || !res.location) return { res, final: cur };
      const next = parseSiteUrl(new URL(res.location, cur).href);
      if (!next || !sameSite(next, start)) return null;
      cur = next.href;
    }
    return null;
  };

  // robots.txt of every origin the crawl touches (`example.com` and `www.example.com`, http and https are different origins)
  const robotsOf = new Map<string, Robots>();
  const robotsFor = async (u: URL): Promise<Robots> => {
    const key = u.origin;
    const known = robotsOf.get(key);
    if (known) return known;
    let robots: Robots;
    try {
      const r = await getFollowing(new URL('/robots.txt', u.origin).href);
      robots = !r ? DENY_ALL : r.res.status >= 500 ? DENY_ALL : r.res.status === 200 ? parseRobots(r.res.body) : ALLOW_ALL;
    } catch {
      robots = DENY_ALL;
    }
    robotsOf.set(key, robots);
    return robots;
  };
  const startRobots = await robotsFor(origin);
  const delay = Math.max(o.delayMs ?? 300, startRobots.crawlDelayMs);
  const allowed = async (u: URL): Promise<boolean> => (await robotsFor(u)).allowed(u.pathname + u.search);

  const queue: string[] = [];
  const seen = new Set<string>();
  const enqueue = (u: URL): void => {
    if (queue.length >= maxPages * 4 || !sameSite(u, start) || SKIP_EXT.test(u.pathname)) return;
    const c = canonical(u);
    if (seen.has(c)) return;
    seen.add(c);
    queue.push(c);
  };
  enqueue(start);
  const fromSitemap = async (): Promise<void> => {
    const urls = [...new Set([...startRobots.sitemaps, new URL('/sitemap.xml', origin).href])].filter((x) => {
      const p = parseSiteUrl(x);
      return p !== null && sameSite(p, start);
    }).slice(0, 3);
    for (const x of urls) {
      try {
        const r = await getFollowing(x);
        if (!r || r.res.status !== 200) continue;
        for (const m of r.res.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
          const p = parseSiteUrl(decodeEntities(m[1]!));
          if (p && /\.xml$/i.test(p.pathname)) continue; // nested sitemaps are not followed
          if (p) enqueue(p);
          if (queue.length >= maxPages * 4) return;
        }
      } catch {
        /* a sitemap is a bonus */
      }
    }
  };
  await fromSitemap();

  const pages: CrawledPage[] = [];
  const texts = new Set<string>();
  const lines = new Set<string>();
  let skipped = 0;
  let errors = 0;
  let chars = 0;
  let truncated = false;
  let first = true;
  while (queue.length && pages.length < maxPages) {
    const url = queue.shift()!;
    if (!(await allowed(new URL(url)))) {
      skipped++;
      continue;
    }
    if (!first && delay > 0) await sleep(delay);
    first = false;
    let res: Fetched | null = null;
    let cur = url;
    try {
      // the redirect is followed by hand so that every hop is checked against the robots.txt of its own origin
      for (let hop = 0; hop <= MAX_HOPS; hop++) {
        res = await o.fetcher(cur);
        if (res.status < 300 || res.status >= 400 || !res.location) break;
        const next = parseSiteUrl(new URL(res.location, cur).href);
        res = null;
        if (!next || !sameSite(next, start) || !(await allowed(next))) break;
        cur = next.href;
      }
    } catch {
      res = null;
      errors++;
    }
    if (!res || res.status !== 200 || !/html|xml/i.test(res.type || 'text/html')) {
      skipped++;
      if (res && res.status >= 400) errors++;
      continue;
    }
    const doc = htmlToText(res.body, cur);
    if (doc.noindex) {
      skipped++;
      continue;
    }
    for (const l of doc.links) {
      const p = parseSiteUrl(l);
      if (p) enqueue(p);
    }
    // lines already seen on earlier pages (menus, footers) are kept once
    const kept = doc.text.split('\n').filter((l) => {
      if (l.length < 12) return true;
      const key = l.toLowerCase();
      if (lines.has(key)) return false;
      lines.add(key);
      return true;
    }).join('\n').slice(0, MAX_PAGE_CHARS);
    const fp = createHash('sha256').update(kept).digest('hex');
    if (kept.replace(/[#\s-]/g, '').length < 40 || texts.has(fp)) {
      skipped++;
      continue;
    }
    if (chars + kept.length > maxChars) {
      truncated = true;
      break;
    }
    texts.add(fp);
    chars += kept.length;
    pages.push({ url: canonical(new URL(cur)), title: doc.title.slice(0, 200), text: kept });
  }
  return { pages, skipped, errors, chars, truncated };
}
