import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { z } from 'zod';
import { errMsg, log } from '@fir/core';
import type { AdminReply, AdminRequest } from './admin.js';
import type { BlogApi } from './blog.js';
import type { PayApi } from './pay.js';
import type { FileReply } from './pult-files.js';
import { auditInputSchema, type AuditInput, type AuditOutcome } from './audit-shared.js';
import { chatSchema, type ChatOutcome, type ChatRequest } from './client/web.js';

/** Same fields as the firtech.pro form (`../firtech/src/lib/lead.ts` leadSchema); `estimate` is the builder's leadSummary. */
export const webLeadSchema = z.object({
  name: z.string().trim().min(1).max(80),
  contact: z.string().trim().min(3).max(120),
  service: z.string().trim().max(40).default('unknown'),
  budget: z.string().trim().max(40).optional().default(''),
  message: z.string().trim().max(2000).optional().default(''),
  estimate: z.string().trim().max(1500).optional().default(''),
  locale: z.enum(['ru', 'en']).default('ru'),
  page: z.string().trim().max(600).optional().default(''),
  slot: z.string().trim().max(40).optional().default(''),
  source: z.string().trim().regex(/^(?:ref:[a-z0-9_-]{1,35}|[a-z0-9_-]{1,40})$/).optional().default(''),
  website: z.string().max(200).optional().default(''),
  /** The site sends `true` when its own Telegram bot already delivered this lead to the owner (the HQ card then says it is a copy). */
  telegramSent: z.boolean().optional(),
  /** The client already has a domain / hosting (the site's brief). Absent: not known. */
  hasDomain: z.boolean().optional(),
  hasHosting: z.boolean().optional(),
});

const MAX_BODY = 16 * 1024;
const digest = (s: string) => createHash('sha256').update(s).digest();

export function tokenOk(given: string | undefined, expected: string): boolean {
  return timingSafeEqual(digest(given ?? ''), digest(expected));
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        resolve(null);
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export type WebLeadInput = z.output<typeof webLeadSchema>;

const stripMapped = (a: string): string => (a.toLowerCase().startsWith('::ffff:') && isIP(a.slice(7)) === 4 ? a.slice(7) : a);

/** The peer is the site on this host: loopback, or the docker gateway of the compose network (172.16.0.0/12, 192.168.0.0/16). */
export function isTrustedPeer(address: string | undefined): boolean {
  if (!address) return false;
  const a = stripMapped(address);
  if (a === '::1') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (!m) return false;
  const [o1, o2] = [Number(m[1]), Number(m[2])];
  return o1 === 127 || (o1 === 172 && o2 >= 16 && o2 <= 31) || (o1 === 192 && o2 === 168);
}

/**
 * The visitor's IP for rate limits. The site (firtech.pro on the same host) passes it in `x-visitor-ip`; it is believed
 * only when the request came from a trusted peer (loopback or the docker gateway) AND already passed the site-token
 * check (call this after the token is verified). Anything else: the socket address.
 */
export function visitorIp(req: IncomingMessage, tokenValid: boolean): string {
  const peer = req.socket.remoteAddress;
  if (tokenValid && isTrustedPeer(peer)) {
    const raw = req.headers['x-visitor-ip'];
    const v = stripMapped((Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '');
    if (v && isIP(v) !== 0) return v;
  }
  return peer ? stripMapped(peer) : 'unknown';
}

/** Sliding-window counter per key (the visitor IP). In memory: a restart only makes it more generous for a moment. */
class KeyedLimit {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly max: number, private readonly windowMs: number) {}
  /** True when the key may go on (and is counted). */
  take(key: string, t: number): boolean {
    const mine = (this.hits.get(key) ?? []).filter((x) => x > t - this.windowMs);
    if (mine.length >= this.max) {
      this.hits.set(key, mine);
      return false;
    }
    mine.push(t);
    this.hits.set(key, mine);
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (!v.some((x) => x > t - this.windowMs)) this.hits.delete(k);
    return true;
  }
}

/**
 * `POST /lead` (header `x-lead-token`) and `GET /health`. Listens inside the hq container; compose publishes it on
 * 127.0.0.1 only (firtech.pro on the same host posts here). `onLead` creates the Sales task and returns its id.
 */
export function createWebhook(
  onLead: (lead: WebLeadInput) => Promise<number>,
  /** Without it `POST /lead` answers 404 (the server may run for `/chat` only). */
  token: string | undefined,
  now: () => number = Date.now,
  /** `GET /office` (header `x-office-token`); without it the route answers 404. */
  office?: { token: string; get: () => unknown },
  /** `POST /chat` (header `x-chat-token`), the website version of the client bot; `ip` is `x-visitor-ip` from a trusted peer, else the socket (see `visitorIp`). */
  chat?: { token: string; handle: (req: ChatRequest, ip: string) => Promise<ChatOutcome> },
  /** `/admin/*` (header `x-admin-token`), the owner's website workplace (`admin.ts`); without it the routes answer 404. */
  admin?: {
    token: string;
    handle: (req: AdminRequest) => Promise<AdminReply>;
    /** `GET /admin/files/<path>` (rendered files of the content calendar, `pult-files.ts`); without it the path is an ordinary 404. */
    file?: (path: string, range: string | undefined) => FileReply;
  },
  /**
   * `POST /audit` (header `x-lead-token`, the same token as `/lead`) and the public `GET /status` (no token, per-IP rate limit).
   * Without `audit` the route answers 404; without `status` too.
   */
  extra: {
    audit?: { token: string; handle: (a: AuditInput) => Promise<AuditOutcome> };
    status?: { get: () => unknown };
    /** Public `GET /blog?lang=all` and `GET /blog/:slug` (no token, per-IP rate limit, 60 s cache header). Without it the routes answer 404. */
    blog?: BlogApi;
    /** Public `GET /pay/:number?k=<key>` (no token, per-IP rate limit, the key is the protection). Without it the route answers 404. */
    pay?: PayApi;
  } = {},
): Server {
  const hits: number[] = [];
  const fileHits: number[] = [];
  const auditHits: number[] = [];
  const statusHits = new Map<string, number[]>();
  const blogHits = new Map<string, number[]>();
  const payByIp = new KeyedLimit(60, 60_000);
  const auditByIp = new KeyedLimit(10, 3_600_000);
  const leadByIp = new KeyedLimit(20, 3_600_000);
  return createServer((req, res) => {
    void (async () => {
      try {
        if (admin && req.url?.startsWith('/admin/')) {
          if (!tokenOk(req.headers['x-admin-token'] as string | undefined, admin.token)) return json(res, 401, { ok: false, error: 'unauthorized' });
          const url = new URL(req.url, 'http://hq.local');
          if (req.method === 'GET' && admin.file && url.pathname.startsWith('/admin/files/')) {
            // pictures and video of one page load are many requests: their own, wider window (the 600 of `/admin/*` is for the API calls)
            const t = now();
            while (fileHits.length && fileHits[0]! < t - 600_000) fileHits.shift();
            if (fileHits.length >= 3000) return json(res, 429, { ok: false, error: 'rate_limited' });
            fileHits.push(t);
            const rangeHeader = req.headers.range;
            const out = admin.file(url.pathname.slice('/admin/files/'.length), typeof rangeHeader === 'string' ? rangeHeader : undefined);
            if ('json' in out) {
              res.writeHead(out.status, { 'content-type': 'application/json', ...out.headers });
              return void res.end(JSON.stringify(out.json));
            }
            res.writeHead(out.status, out.headers);
            const stream = out.stream();
            stream.on('error', () => res.destroy());
            res.on('close', () => stream.destroy());
            return void stream.pipe(res);
          }
          let body: unknown = null;
          if (req.method === 'POST') {
            const raw = await readBody(req);
            if (raw === null) return json(res, 413, { ok: false, error: 'too_large' });
            try {
              body = raw.trim() ? JSON.parse(raw) : {};
            } catch {
              return json(res, 400, { ok: false, error: 'invalid' });
            }
          } else if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method_not_allowed' });
          const out = await admin.handle({ method: req.method, path: url.pathname, query: url.searchParams, body });
          return json(res, out.status, out.body);
        }
        if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true });
        if (req.method === 'GET' && req.url?.split('?')[0] === '/status' && extra.status) {
          const fwd = req.headers['x-forwarded-for'];
          const ip = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
          const t = now();
          const mine = (statusHits.get(ip) ?? []).filter((x) => x > t - 60_000);
          if (mine.length >= 30) return json(res, 429, { ok: false, error: 'rate_limited' });
          mine.push(t);
          statusHits.set(ip, mine);
          if (statusHits.size > 5000) for (const [k, v] of statusHits) if (!v.some((x) => x > t - 60_000)) statusHits.delete(k);
          res.setHeader('cache-control', 'public, max-age=60');
          return json(res, 200, extra.status.get());
        }
        if (req.method === 'GET' && extra.blog && /^\/blog(?:\/|$)/.test(req.url?.split('?')[0] ?? '')) {
          const url = new URL(req.url!, 'http://hq.local');
          const fwd = req.headers['x-forwarded-for'];
          const ip = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
          const t = now();
          const mine = (blogHits.get(ip) ?? []).filter((x) => x > t - 60_000);
          if (mine.length >= 60) return json(res, 429, { ok: false, error: 'rate_limited' });
          mine.push(t);
          blogHits.set(ip, mine);
          if (blogHits.size > 5000) for (const [k, v] of blogHits) if (!v.some((x) => x > t - 60_000)) blogHits.delete(k);
          if (url.pathname === '/blog') {
            const lang = url.searchParams.get('lang');
            if (lang !== null && lang !== 'all') return json(res, 400, { ok: false, error: 'invalid' });
            res.setHeader('cache-control', 'public, max-age=60');
            return json(res, 200, extra.blog.list());
          }
          const m = /^\/blog\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(url.pathname);
          const found = m ? extra.blog.get(m[1]!) : null;
          if (!found) return json(res, 404, { ok: false, error: 'not_found' });
          res.setHeader('cache-control', 'public, max-age=60');
          return json(res, 200, found);
        }
        if (req.method === 'GET' && extra.pay && /^\/pay\//.test(req.url ?? '')) {
          const url = new URL(req.url!, 'http://hq.local');
          const fwd = req.headers['x-forwarded-for'];
          const ip = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
          if (!payByIp.take(ip, now())) return json(res, 429, { ok: false, error: 'rate_limited' });
          res.setHeader('cache-control', 'no-store');
          const m = /^\/pay\/([^/]{1,40})$/.exec(url.pathname);
          let number = '';
          try {
            number = m ? decodeURIComponent(m[1]!) : '';
          } catch {
            /* a broken escape is just an unknown number */
          }
          const found = extra.pay.get(number, url.searchParams.get('k') ?? '');
          if (!found) return json(res, 404, { ok: false, error: 'not_found' });
          return json(res, 200, found);
        }
        if (req.method === 'POST' && req.url === '/audit' && extra.audit) {
          if (!tokenOk(req.headers['x-lead-token'] as string | undefined, extra.audit.token)) return json(res, 401, { ok: false, error: 'unauthorized' });
          const t = now();
          while (auditHits.length && auditHits[0]! < t - 60_000) auditHits.shift();
          if (auditHits.length >= 60) return json(res, 429, { ok: false, error: 'rate_limited' });
          if (!auditByIp.take(visitorIp(req, true), t)) return json(res, 429, { ok: false, error: 'rate_limited' });
          auditHits.push(t);
          const raw = await readBody(req);
          if (raw === null) return json(res, 413, { ok: false, error: 'too_large' });
          let data: unknown = null;
          try {
            data = JSON.parse(raw);
          } catch {
            /* falls through to invalid */
          }
          const parsed = auditInputSchema.safeParse(data);
          if (!parsed.success) return json(res, 400, { ok: false, error: 'invalid' });
          const out = await extra.audit.handle(parsed.data);
          if (out === 'rate_limited') return json(res, 429, { ok: false, error: 'rate_limited' });
          if (out === 'invalid') return json(res, 400, { ok: false, error: 'invalid' });
          return json(res, 200, out === 'duplicate' ? { ok: true, duplicate: true } : { ok: true });
        }
        if (req.method === 'GET' && req.url === '/office' && office) {
          if (!tokenOk(req.headers['x-office-token'] as string | undefined, office.token)) return json(res, 401, { ok: false, error: 'unauthorized' });
          return json(res, 200, office.get());
        }
        if (req.method === 'POST' && req.url === '/chat') {
          if (!chat) return json(res, 404, { ok: false }); // no WEB_CHAT_TOKEN: the route does not exist
          if (!tokenOk(req.headers['x-chat-token'] as string | undefined, chat.token)) return json(res, 401, { ok: false, error: 'unauthorized' });
          const raw = await readBody(req);
          if (raw === null) return json(res, 413, { ok: false, error: 'too_large' });
          let data: unknown = null;
          try {
            data = JSON.parse(raw);
          } catch {
            /* falls through to invalid */
          }
          const parsed = chatSchema.safeParse(data);
          if (!parsed.success) return json(res, 400, { ok: false, error: 'invalid' });
          const out = await chat.handle(parsed.data, visitorIp(req, true));
          if (out.kind === 'rate_limited') return json(res, 429, { ok: false, error: 'rate_limited' });
          if (out.kind === 'unavailable') return json(res, 503, { ok: false, error: 'unavailable' });
          return json(res, 200, out.body);
        }
        if (req.method !== 'POST' || req.url !== '/lead' || !token) return json(res, 404, { ok: false });
        if (!tokenOk(req.headers['x-lead-token'] as string | undefined, token)) return json(res, 401, { ok: false, error: 'unauthorized' });
        // Coarse global limit: the form is low traffic, a flood means abuse.
        const t = now();
        while (hits.length && hits[0]! < t - 60_000) hits.shift();
        if (hits.length >= 60) return json(res, 429, { ok: false, error: 'rate_limited' });
        if (!leadByIp.take(visitorIp(req, true), t)) return json(res, 429, { ok: false, error: 'rate_limited' });
        hits.push(t);
        const raw = await readBody(req);
        if (raw === null) return json(res, 413, { ok: false, error: 'too_large' });
        let data: unknown = null;
        try {
          data = JSON.parse(raw);
        } catch {
          /* falls through to invalid */
        }
        const parsed = webLeadSchema.safeParse(data);
        if (!parsed.success) return json(res, 400, { ok: false, error: 'invalid' });
        const lead = parsed.data;
        if (lead.website) return json(res, 200, { ok: true }); // honeypot: bots get a normal answer, nothing is stored
        const id = await onLead(lead);
        json(res, 200, { ok: true, id });
      } catch (e) {
        log('error', 'webhook failed', { err: errMsg(e) });
        json(res, 500, { ok: false, error: 'internal' });
      }
    })();
  });
}
