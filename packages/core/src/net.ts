import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';

/*
 * SSRF-safe outbound GET (moved from the SEO worker's audit, 2026-11-19): public addresses only, the host is resolved once and the
 * connection goes to exactly the checked address (no DNS rebinding). Used by the site audit and by the payment watcher.
 */
// ---- fetching a stranger's URL: public addresses only, the checked address is the one we connect to ----
const privateV4 = (ip: string): boolean => {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return true; // not an address we understand: never fetch
  const [a, b, c] = p as [number, number, number, number];
  return (
    a === 0 || // this network
    a === 10 || // private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64.0.0/10 (also Alibaba metadata 100.100.100.200)
    (a === 169 && b === 254) || // link-local, cloud metadata 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 192 && b === 0 && c === 2) || // documentation
    (a === 192 && b === 88 && c === 99) || // 6to4 relay anycast 192.88.99.0/24 (deprecated)
    (a === 192 && b === 168) || // private
    (a === 198 && (b === 18 || b === 19)) || // benchmarking 198.18.0.0/15
    (a === 198 && b === 51 && c === 100) || // documentation
    (a === 203 && b === 0 && c === 113) || // documentation
    a >= 224 // multicast 224/4, reserved 240/4, broadcast
  );
};

/** The eight 16-bit groups of an IPv6 address (`::` expanded, a dotted IPv4 tail read as two groups), or null when it is not one. */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().split('%')[0]!;
  if (isIP(s) !== 6) return null;
  const tail = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const q = tail[2]!.split('.').map(Number);
    s = `${tail[1]}${((q[0]! << 8) | q[1]!).toString(16)}:${((q[2]! << 8) | q[3]!).toString(16)}`;
  }
  const [head, rest] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = rest !== undefined && rest !== '' ? rest.split(':') : [];
  const fill = s.includes('::') ? 8 - h.length - t.length : 0;
  const all = [...h, ...Array<string>(Math.max(fill, 0)).fill('0'), ...t].map((g) => parseInt(g, 16));
  return all.length === 8 && all.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? all : null;
}

const v4Of = (hi: number, lo: number): string => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/**
 * True for every address a stranger's site must never resolve to: private, loopback, link-local, CGNAT 100.64/10,
 * 198.18/15, documentation, multicast and reserved IPv4; and their IPv6 equivalents, including unique-local, link-local,
 * multicast, NAT64 `64:ff9b::/96`, 6to4, Teredo, and IPv4 hidden in IPv4-mapped (`::ffff:a.b.c.d`) or IPv4-compatible forms.
 * Anything that is not an address at all counts as private (never fetched).
 */
export function isPrivateAddress(ip: string): boolean {
  const v = ip.trim();
  if (isIP(v) === 4) return privateV4(v);
  const g = ipv6Groups(v);
  if (!g) return true;
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  if (g.every((x) => x === 0)) return true; // ::
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) return true; // ::ffff:0:0/96 IPv4-mapped: a resolver never answers with it for a real site
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) return g6 === 0 && g7 <= 1 ? true : privateV4(v4Of(g6, g7)); // compatible, ::1
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0) return true; // link-local, site-local
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  if (g0 === 0x64 && g1 === 0xff9b && (g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0)) return true; // NAT64 64:ff9b::/96
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return true; // 64:ff9b:1::/48 local-use NAT64
  if (g0 === 0x2002) return privateV4(v4Of(g1, g2)); // 6to4 carries an IPv4
  if (g0 === 0x2001 && (g1 === 0 || g1 === 0xdb8)) return true; // Teredo, documentation
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true; // discard-only
  return false;
}

export interface PinnedAddress {
  address: string;
  family: 4 | 6;
}

/**
 * Resolves a host once. Every answer must be public, otherwise `blocked`; the first answer is returned to connect to,
 * so the address that was checked is the address that is used (a second DNS answer cannot swap it, DNS rebinding).
 */
export async function resolvePublic(host: string, lookup: (h: string) => Promise<string[]>): Promise<{ ok: PinnedAddress } | 'blocked' | 'dns'> {
  const bare = host.replace(/^\[|\]$/g, '');
  let addrs: string[];
  if (isIP(bare) !== 0) addrs = [bare];
  else {
    try {
      addrs = await lookup(bare);
    } catch {
      return 'dns';
    }
  }
  if (addrs.length === 0) return 'dns';
  if (addrs.some(isPrivateAddress)) return 'blocked';
  const address = addrs[0]!;
  return { ok: { address, family: isIP(address) === 6 ? 6 : 4 } };
}

export async function resolvesPublic(host: string, lookup: (h: string) => Promise<string[]>): Promise<'ok' | 'blocked' | 'dns'> {
  const r = await resolvePublic(host, lookup);
  return typeof r === 'string' ? r : 'ok';
}

/** The system resolver, every answer (for `resolvePublic`). */
export const systemLookup = async (h: string): Promise<string[]> => (await dnsLookup(h, { all: true })).map((a) => a.address);

/**
 * A GET (or, with `init.method` and a string or bytes `init.body`, a POST/PUT) that connects to `pin` instead of resolving the hostname again (TLS still checks the certificate for the
 * hostname, `Host` stays the hostname). No automatic redirects and no decompression: the caller follows hops itself.
 */
export function pinnedFetch(url: string, init: RequestInit = {}, pin?: PinnedAddress): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const u = new URL(url);
    const lookup: LookupFunction | undefined = pin
      ? (_host, opts, cb) => {
          if ((opts as { all?: boolean }).all) (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address: pin.address, family: pin.family }]);
          else cb(null, pin.address, pin.family);
        }
      : undefined;
    const headers: Record<string, string> = { 'accept-encoding': 'identity' };
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const payload = init.body === undefined || init.body === null ? undefined : typeof init.body === 'string' ? Buffer.from(init.body) : Buffer.from(init.body as Uint8Array);
    if (payload) headers['content-length'] = String(payload.length);
    const req = (u.protocol === 'https:' ? https : http).request(u, { method: init.method ?? 'GET', headers, ...(lookup ? { lookup } : {}), ...(init.signal ? { signal: init.signal } : {}) }, (res) => {
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) h.append(k, x);
      const status = res.statusCode ?? 0;
      const bodyless = status < 200 || status === 204 || status === 205 || status === 304;
      resolve(new Response(bodyless ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>), { status, headers: h }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

export type SafeGetError = 'not_allowed' | 'blocked' | 'dns' | 'timeout' | 'network' | 'too_large' | 'invalid_json';
export type SafeGetResult = { ok: true; status: number; body: unknown } | { ok: false; status: number; error: SafeGetError };

export interface SafeGetOptions {
  /** Exact host names that may be called (https only); anything else is refused before any network work. */
  allowHosts: readonly string[];
  headers?: Record<string, string>;
  /** Default 8 s. */
  timeoutMs?: number;
  /** Default 1 MB. */
  maxBytes?: number;
  /** Tests: a fake resolver and fetch; production resolves with the system resolver and connects through `pinnedFetch`. */
  lookup?: (host: string) => Promise<string[]>;
  fetch?: (url: string, init: RequestInit, pin?: PinnedAddress) => Promise<Response>;
}

/**
 * A GET of JSON from an allow-listed https host: resolved once, public addresses only, connected to the checked address, no
 * redirects followed, a timeout and a size cap. Never throws: a non-2xx answer is `ok: true` with its status (the caller decides
 * about 429/5xx), a transport problem is `ok: false` with status 0.
 */
export async function safeGetJson(url: string, opts: SafeGetOptions): Promise<SafeGetResult> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, status: 0, error: 'not_allowed' };
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || !opts.allowHosts.includes(u.hostname)) return { ok: false, status: 0, error: 'not_allowed' };
  const g = await resolvePublic(u.hostname, opts.lookup ?? systemLookup);
  if (typeof g === 'string') return { ok: false, status: 0, error: g };
  const max = opts.maxBytes ?? 1_000_000;
  let res: Response;
  try {
    res = await (opts.fetch ?? pinnedFetch)(u.toString(), { redirect: 'manual', signal: AbortSignal.timeout(opts.timeoutMs ?? 8000), headers: { accept: 'application/json', ...(opts.headers ?? {}) } }, g.ok);
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error && /timeout|abort/i.test(`${e.name} ${e.message}`) ? 'timeout' : 'network' };
  }
  let text: string;
  try {
    if (!res.body) text = await res.text();
    else {
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > max) {
          await reader.cancel().catch(() => undefined);
          return { ok: false, status: res.status, error: 'too_large' };
        }
        chunks.push(value);
      }
      text = Buffer.concat(chunks).toString('utf8');
    }
  } catch (e) {
    return { ok: false, status: res.status, error: e instanceof Error && /timeout|abort/i.test(`${e.name} ${e.message}`) ? 'timeout' : 'network' };
  }
  if (res.status < 200 || res.status >= 300) return { ok: true, status: res.status, body: null };
  try {
    return { ok: true, status: res.status, body: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, status: res.status, error: 'invalid_json' };
  }
}

export interface SafePostOptions extends SafeGetOptions {
  method?: 'POST' | 'PUT';
  /** A string or bytes (a video is sent in one request). */
  body?: string | Uint8Array;
}
export type SafePostResult =
  | { ok: true; status: number; body: unknown; headers: Record<string, string> }
  | { ok: false; status: number; error: Exclude<SafeGetError, 'invalid_json'> };

/**
 * A POST or PUT to an allow-listed https host, with the same guarantees as `safeGetJson`: https only, exact host list,
 * public addresses only (resolved once, pinned), no redirects, timeout (default 60 s: uploads are slow), size cap on the
 * answer. Never throws. A non-2xx answer is `ok: true` with its status; `body` is the parsed JSON answer or null (empty or
 * not JSON); `headers` are the response headers in lower case (the resumable upload session URL is `location`).
 */
export async function safePost(url: string, opts: SafePostOptions): Promise<SafePostResult> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, status: 0, error: 'not_allowed' };
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443') || !opts.allowHosts.includes(u.hostname)) return { ok: false, status: 0, error: 'not_allowed' };
  const g = await resolvePublic(u.hostname, opts.lookup ?? systemLookup);
  if (typeof g === 'string') return { ok: false, status: 0, error: g };
  const max = opts.maxBytes ?? 1_000_000;
  let res: Response;
  try {
    res = await (opts.fetch ?? pinnedFetch)(u.toString(), { method: opts.method ?? 'POST', redirect: 'manual', signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000), headers: { accept: 'application/json', ...(opts.headers ?? {}) }, ...(opts.body !== undefined ? { body: opts.body as BodyInit } : {}) }, g.ok);
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error && /timeout|abort/i.test(`${e.name} ${e.message}`) ? 'timeout' : 'network' };
  }
  let text = '';
  try {
    if (res.body) {
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > max) {
          await reader.cancel().catch(() => undefined);
          return { ok: false, status: res.status, error: 'too_large' };
        }
        chunks.push(value);
      }
      text = Buffer.concat(chunks).toString('utf8');
    }
  } catch (e) {
    return { ok: false, status: res.status, error: e instanceof Error && /timeout|abort/i.test(`${e.name} ${e.message}`) ? 'timeout' : 'network' };
  }
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  let body: unknown;
  try {
    body = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    body = null;
  }
  return { ok: true, status: res.status, body, headers };
}
