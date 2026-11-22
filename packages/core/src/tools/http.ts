import { pinnedFetch, resolvePublic, systemLookup, type PinnedAddress } from '../net.js';
import { fail, okv, type ToolResult } from './result.js';

/** The fetch the tools use: `pin` is the checked public address to connect to (production: `pinnedFetch`). Tests pass a fake. */
export type ToolFetch = (url: string, init: RequestInit, pin?: PinnedAddress) => Promise<Response>;
export type Lookup = (host: string) => Promise<string[]>;

/** An address that passes the public-address check, used when a test injects `fetch` without a resolver. */
const TEST_PUBLIC = ['93.184.215.14'];

export interface NetDeps {
  fetch?: ToolFetch | undefined;
  lookup?: Lookup | undefined;
  queue: HostQueue;
  /** This server's own addresses (`PUBLIC_IP`, `SELF_IPS`): a host that is or resolves to one of them is never fetched, like the site crawler (P2-10). */
  selfIps?: readonly string[] | undefined;
}

/** Which hosts a call may reach: exact names, or `'public'` (any public address; only for reading pages a search returned or the caller named). */
export type HostList = readonly string[] | 'public';

export interface RawRequest {
  method?: 'GET' | 'POST' | 'PUT';
  hosts: HostList;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  timeoutMs: number;
  maxBytes: number;
  /** Cut the body at `maxBytes` instead of failing with `too_large` (pages). */
  truncate?: boolean;
  /** Follow up to this many redirects, each hop checked again (default 0: a 3xx is returned as it is). */
  redirects?: number;
  /**
   * Our own network (monitoring): http or https to a listed host on any port, no public-address check and no pinned address (the
   * system resolver decides). Only `web.*` sets it, and only for departments the policy allows (`ToolPolicy.internal`).
   */
  internal?: boolean;
  /** Per-host queue settings. */
  perHost?: number;
  minGapMs?: number;
}

export interface RawResponse {
  status: number;
  headers: Record<string, string>;
  bytes: Buffer;
  truncated: boolean;
  /** The URL that answered (after redirects). */
  url: string;
}

const UA = 'FirTechAgent/1.0 (+https://firtech.pro)';
const isTimeout = (e: unknown): boolean => e instanceof Error && /timeout|abort/i.test(`${e.name} ${e.message}`);

/** https, port 443, no credentials, host in the list. A reason when refused. */
export function checkUrl(raw: string, hosts: HostList, internal = false): { url: URL } | { refused: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { refused: 'not a URL' };
  }
  if (u.username || u.password) return { refused: 'credentials in URL' };
  if (internal) {
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { refused: 'http or https only' };
  } else {
    if (u.protocol !== 'https:') return { refused: 'https only' };
    if (u.port && u.port !== '443') return { refused: 'port not allowed' };
  }
  if (hosts !== 'public' && !hosts.includes(u.hostname)) return { refused: `host ${u.hostname} not in the list` };
  return { url: u };
}

/**
 * One request through the SSRF-safe path of `net.ts`: listed https host, resolved once to a public address and connected to
 * exactly that address, timeout, size cap, redirects only when asked (each hop checked the same way). Never throws.
 */
export async function rawRequest(target: string, r: RawRequest, net: NetDeps): Promise<ToolResult<RawResponse>> {
  let cur = target;
  const baseLookup = net.lookup ?? (net.fetch ? () => Promise.resolve(TEST_PUBLIC) : systemLookup);
  // only the free-form fetch of an agent (`hosts: 'public'`) must not knock on this server; a listed host is a system call (the monitor's probe of the site on this same IP)
  const self = new Set((r.hosts === 'public' ? net.selfIps ?? [] : []).map((x) => x.trim().toLowerCase()).filter(Boolean));
  // a name that resolves to this server counts as a private address (`resolvePublic` refuses 0.0.0.0)
  const lookup = self.size ? async (h: string): Promise<string[]> => ((await baseLookup(h)).some((a) => self.has(a.toLowerCase())) ? ['0.0.0.0'] : baseLookup(h)) : baseLookup;
  for (let hop = 0; ; hop++) {
    const c = checkUrl(cur, r.hosts, r.internal === true);
    if ('refused' in c) return fail(r.hosts !== 'public' && /not in the list/.test(c.refused) ? 'blocked' : hop === 0 ? 'invalid' : 'blocked', c.refused);
    let pinned: PinnedAddress | undefined;
    if (!r.internal) {
      const bare = c.url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
      if (self.has(bare)) return fail('blocked', `${c.url.hostname} is this server`);
      const pin = await resolvePublic(c.url.hostname, lookup);
      if (pin === 'blocked') return fail('blocked', `${c.url.hostname} resolves to a private address`);
      if (pin === 'dns') return fail('network', `${c.url.hostname}: DNS lookup failed`);
      pinned = pin.ok;
    }
    const res = await net.queue.run(c.url.hostname, { perHost: r.perHost ?? 2, minGapMs: r.minGapMs ?? 0 }, () => readOnce(c.url.toString(), r, pinned, net.fetch ?? pinnedFetch));
    if (!res.ok) return res;
    const loc = res.value.headers.location;
    if (res.value.status >= 300 && res.value.status < 400 && loc && hop < (r.redirects ?? 0)) {
      try {
        cur = new URL(loc, c.url).toString();
      } catch {
        return fail('upstream', 'bad redirect', { status: res.value.status });
      }
      continue;
    }
    return res;
  }
}

async function readOnce(url: string, r: RawRequest, pin: PinnedAddress | undefined, f: ToolFetch): Promise<ToolResult<RawResponse>> {
  let res: Response;
  try {
    res = await f(
      url,
      {
        method: r.method ?? 'GET', redirect: 'manual', signal: AbortSignal.timeout(r.timeoutMs),
        headers: { 'user-agent': UA, ...(r.headers ?? {}) }, ...(r.body !== undefined ? { body: r.body as BodyInit } : {}),
      },
      pin,
    );
  } catch (e) {
    return isTimeout(e) ? fail('timeout', `${new URL(url).hostname}: timeout`) : fail('network', `${new URL(url).hostname}: network error`);
  }
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (size + value.length > r.maxBytes) {
          if (!r.truncate) {
            void reader.cancel().catch(() => undefined); // not awaited: a teed body resolves cancel only when both branches stop
            return fail('too_large', `answer over ${r.maxBytes} bytes`, { status: res.status });
          }
          chunks.push(value.subarray(0, r.maxBytes - size));
          size = r.maxBytes;
          truncated = true;
          void reader.cancel().catch(() => undefined);
          break;
        }
        size += value.length;
        chunks.push(value);
      }
    }
  } catch (e) {
    return isTimeout(e) ? fail('timeout', 'timeout while reading the answer') : fail('network', 'connection lost while reading the answer');
  }
  return okv({ status: res.status, headers, bytes: Buffer.concat(chunks), truncated, url });
}

/** Text of a body by its `content-type` charset (utf-8 by default; windows-1251 and friends through TextDecoder). */
export function decodeBody(bytes: Buffer, contentType = ''): string {
  const cs = /charset=["']?([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase();
  if (cs && cs !== 'utf-8' && cs !== 'utf8') {
    try {
      return new TextDecoder(cs).decode(bytes);
    } catch {
      /* unknown label: utf-8 below */
    }
  }
  return bytes.toString('utf8');
}

/**
 * Per-host queue shared by every toolbox of the process: at most `perHost` calls to one host at a time and a minimum pause
 * between starts, so one busy agent cannot hammer a site or an API and get the company banned.
 */
export class HostQueue {
  private readonly hosts = new Map<string, { running: number; lastStart: number; waiting: (() => void)[] }>();
  constructor(private readonly now: () => number = Date.now, private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {}

  async run<T>(host: string, o: { perHost: number; minGapMs: number }, fn: () => Promise<T>): Promise<T> {
    const h = this.hosts.get(host) ?? { running: 0, lastStart: 0, waiting: [] };
    this.hosts.set(host, h);
    while (h.running >= Math.max(1, o.perHost)) await new Promise<void>((r) => h.waiting.push(r));
    h.running++;
    try {
      // the slot is taken before the pause, so two waiters never share one gap
      const gap = h.lastStart + o.minGapMs - this.now();
      h.lastStart = Math.max(this.now(), h.lastStart + o.minGapMs);
      if (gap > 0) await this.sleep(gap);
      return await fn();
    } finally {
      h.running--;
      h.waiting.shift()?.();
    }
  }
}

/** The process-wide queue (tests make their own). */
export const sharedHostQueue = new HostQueue();
