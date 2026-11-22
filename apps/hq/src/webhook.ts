import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { z } from 'zod';
import { errMsg, log } from '@fir/core';
import type { AdminReply, AdminRequest } from './admin.js';
import type { BlogApi } from './blog.js';
import type { PayApi } from './pay.js';
import type { FileAccess, FileReply } from './shell-files.js';
import { EVENT_NAMES } from './shell-events.js';
import { auditInputSchema, type AuditInput, type AuditOutcome } from './audit-shared.js';
import { SITE_LEAD_ID, type LeadDedupe } from './lead-dedupe.js';
import { briefFieldsSchema } from '@fir/worker-lead-intake';
import { chatSchema, type ChatOutcome, type ChatRequest } from './client/web.js';

/** Same fields as the firtech.pro form (`../firtech/src/lib/lead.ts` leadSchema); `estimate` is the builder's leadSummary. */
export const webLeadSchema = z.object({
  name: z.string().trim().min(1).max(80),
  /** At least 3 characters, unless the lead comes from a signed-in cabinet (`clientEmail`): then the email stands in. */
  contact: z.string().trim().max(120).default(''),
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
  /** A signed-in cabinet client sent the lead: the account is upserted by this email and the lead is linked to it. A malformed value is ignored (the lead still counts). */
  clientEmail: z.string().trim().toLowerCase().max(254).email().optional().catch(undefined),
  cabinetId: z.string().trim().min(1).max(64).optional().catch(undefined),
  clientName: z.string().trim().max(120).optional().catch(undefined),
  /** The site's own id of this lead: a resend with the same id is answered from the first result (`duplicate: true`) and creates nothing. A malformed value is ignored. */
  siteLeadId: SITE_LEAD_ID.optional().catch(undefined),
  /** The builder's brief (site builder v4): `discovery.si` is the client's own site, `discovery.ig` the Instagram handle. A malformed value is ignored. */
  brief: briefFieldsSchema.extend({ discovery: z.object({ si: z.string().trim().max(300).optional().catch(undefined), ig: z.string().trim().max(120).optional().catch(undefined) }).optional().catch(undefined) }).optional().catch(undefined),
}).transform((d, ctx) => {
  const contact = d.contact.length >= 3 ? d.contact : d.clientEmail ?? '';
  if (contact.length < 3) ctx.addIssue({ code: 'custom', path: ['contact'], message: 'contact is required' });
  return { ...d, contact };
});

const MAX_BODY = 16 * 1024;
/** The Mac's answer of an Agent Reach job (`POST /admin/reach/jobs/:id/result`, result up to 200 KB) is the one body that may be larger. */
export const MAX_REACH_BODY = 420 * 1024;
const REACH_RESULT_PATH = /^\/admin\/reach\/jobs\/\d+\/result$/;
/** Cabinet v3 bodies that are bigger than a form: a drawn signature (a data URL up to 200 KB) and an uploaded file (10 MB as base64). */
export const MAX_SIGN_BODY = 330 * 1024;
export const MAX_UPLOAD_BODY = 14 * 1024 * 1024 + 64 * 1024;
const SIGN_PATH = /^\/admin\/clients\/\d+\/documents\/\d+\/sign$/;
const UPLOAD_PATH = /^\/admin\/clients\/\d+\/uploads$/;
/** The routes that take `PATCH` (the agent's settings, HQ settings, an owner's knowledge note); the site's proxy (`hq-admin.ts`) declares exactly these. Everything else of `/admin/*` is GET or POST. */
const AGENT_PATCH_PATH = /^\/admin\/(?:clients\/\d+\/agents\/\d+|settings|knowledge\/(?!rebuild$)[\w-]{1,64})$/;
/** The routes that take `DELETE` (no body): a knowledge note and a lesson. */
const ADMIN_DELETE_PATH = /^\/admin\/(?:knowledge\/(?!rebuild$)[\w-]{1,64}|quality\/lessons\/[\w-]{1,64})$/;
const bodyLimit = (path: string): number => (REACH_RESULT_PATH.test(path) ? MAX_REACH_BODY : SIGN_PATH.test(path) ? MAX_SIGN_BODY : UPLOAD_PATH.test(path) ? MAX_UPLOAD_BODY : MAX_BODY);
/** What a browser shows inline; the rest (Word, zip, text) is offered as a download. */
const INLINE_TYPES = /^(image\/|video\/|application\/pdf$)/;
const digest = (s: string) => createHash('sha256').update(s).digest();

export function tokenOk(given: string | undefined, expected: string): boolean {
  return timingSafeEqual(digest(given ?? ''), digest(expected));
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, res: ServerResponse, max = MAX_BODY): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let over = false;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (over) return; // the rest of an oversized body is dropped, not stored
      if (size > max) {
        over = true;
        chunks.length = 0;
        // the 413 must reach the caller: the socket is cut only after the answer went out (destroying it now made the caller see a reset, not a 413)
        res.setHeader('connection', 'close');
        res.once('finish', () => req.destroy());
        resolve(null);
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * What the cabinet token may call (P1-4): the registered-client routes only. `POST /admin/clients` (registration), `anonymize`, `/admin/files`,
 * settings, prices, CRM, tasks and everything else need the full admin token.
 */
export function cabinetRouteAllowed(method: string, pathname: string): boolean {
  if (pathname === '/admin/clients/by-email') return method === 'GET';
  const m = /^\/admin\/clients\/\d+(?:\/([^/]+)(?:\/.*)?)?$/.exec(pathname);
  if (!m) return false;
  if (m[1] === 'anonymize') return false;
  return method === 'GET' || method === 'POST' || method === 'PATCH';
}

export type WebLeadInput = z.output<typeof webLeadSchema>;

const stripMapped = (a: string): string => (a.toLowerCase().startsWith('::ffff:') && isIP(a.slice(7)) === 4 ? a.slice(7) : a);

/**
 * Peers whose `x-real-ip` / `x-visitor-ip` we believe: loopback, plus the exact addresses set by `setTrustedProxies` (env `TRUSTED_PROXY_IP`, else the
 * gateway of the docker network this container sits in, see `dockerGateways`). NOT the whole 172.16/12 or 192.168/16 (P2-8): another container
 * on the same host must not be able to name any visitor.
 */
let trustedPeers: ReadonlySet<string> = new Set();
export function setTrustedProxies(addresses: readonly string[]): void {
  trustedPeers = new Set(addresses.map((x) => stripMapped(x.trim())).filter((x) => isIP(x) !== 0));
}
export function trustedProxies(): string[] {
  return [...trustedPeers];
}

/** The gateway address (network address + 1) of every IPv4 interface that is not loopback: the docker bridge gateway the published port arrives from. */
export function dockerGateways(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string[] {
  const out: string[] = [];
  for (const list of Object.values(interfaces)) {
    for (const i of list ?? []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      const ip = i.address.split('.').map(Number);
      const mask = i.netmask.split('.').map(Number);
      if (ip.length !== 4 || mask.length !== 4 || ip.some(Number.isNaN) || mask.some(Number.isNaN)) continue;
      const net = ip.map((o, k) => o & mask[k]!);
      net[3] = net[3]! + 1;
      out.push(net.join('.'));
    }
  }
  return out;
}

/** The peer is the site or the reverse proxy on this host: loopback, or one of the configured proxy addresses. */
export function isTrustedPeer(address: string | undefined): boolean {
  if (!address) return false;
  const a = stripMapped(address);
  if (a === '::1' || /^127(?:\.\d{1,3}){3}$/.test(a)) return true;
  return trustedPeers.has(a);
}

const validIp = (raw: string | string[] | undefined): string => {
  const v = stripMapped((Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '');
  return v && isIP(v) !== 0 ? v : '';
};

/**
 * The visitor's IP for rate limits. Believed only when the request came from a trusted peer: `x-visitor-ip` (the site's server, and only after the
 * site-token check: `tokenValid`), else `x-real-ip` (nginx, which overwrites it with `$remote_addr`). `x-forwarded-for` is never read: a visitor can
 * put anything in it. Anything else: the socket address.
 */
export function visitorIp(req: IncomingMessage, tokenValid: boolean): string {
  const peer = req.socket.remoteAddress;
  if (isTrustedPeer(peer)) {
    if (tokenValid) {
      const v = validIp(req.headers['x-visitor-ip']);
      if (v) return v;
    }
    const real = validIp(req.headers['x-real-ip']);
    if (real) return real;
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
  onLead: (lead: WebLeadInput) => Promise<number | { id: number; leadId?: number | null }>,
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
    /** `CABINET_TOKEN` (header `x-cabinet-token`): a second key that opens only `cabinetRouteAllowed` routes. Unset: off. */
    cabinetToken?: string | undefined;
    handle: (req: AdminRequest) => Promise<AdminReply>;
    /** `GET /admin/files/<path>` (rendered files of the content calendar, `shell-files.ts`); without it the path is an ordinary 404. */
    file?: (path: string, range: string | undefined, access: FileAccess) => FileReply;
  },
  /**
   * `POST /audit` (header `x-lead-token`, the same token as `/lead`) and the public `GET /status` (no token, per-IP rate limit).
   * Without `audit` the route answers 404; without `status` too.
   */
  extra: {
    audit?: { token: string; handle: (a: AuditInput) => Promise<AuditOutcome> };
    status?: { get: () => unknown };
    /** Idempotency of `POST /lead` by `siteLeadId` (`lead-dedupe.ts`); without it every request makes a lead. */
    leadDedupe?: LeadDedupe;
    /** Public `GET /blog?lang=all` and `GET /blog/:slug` (no token, per-IP rate limit, 60 s cache header). Without it the routes answer 404. */
    blog?: BlogApi;
    /** `POST /events` (header `x-site-token`, site page counters, 120 a minute per visitor IP). Without it the route answers 404. */
    events?: { token: string; handle: (data: unknown) => 'ok' | 'invalid' };
    /** Public `GET /pay/:number?k=<key>` (no token, per-IP rate limit, the key is the protection). Without it the route answers 404. */
    pay?: PayApi;
    /**
     * Public `GET|HEAD /media/<signature>/<path>` for the Instagram Graph API (it fetches our PNG/MP4 by URL). The signature is
     * HMAC(secret, path); `resolve` returns the file only for a valid signature and a path under DATA_DIR/renders. Without it: 404.
     */
    media?: { resolve: (sig: string, rel: string, exp?: number | null) => { file: string; type: string; size: number } | null };
    /**
     * Public `POST|OPTIONS /agent/:publicId/chat` (the playground, `playground.ts`): the site widget of a client's live agent (header `x-agent-token`, the origin the
     * client set) and the builder preview (`demo-<niche>`, no token). Per-IP limits here, the daily limits of the agent inside `handle`. Without it: 404.
     */
    agent?: { handle: (publicId: string, req: { token: string; origin: string; body: unknown; trusted: boolean }) => Promise<{ status: number; body: Record<string, unknown>; allowOrigin?: string }> };
  } = {},
): Server {
  /** A request from the site's server carries one of its tokens: then its `x-visitor-ip` is believed (public routes: /pay, /status, /blog, /agent). */
  const siteTokens = [token, chat?.token, extra.events?.token, extra.audit?.token].filter((x): x is string => Boolean(x));
  const siteTokenValid = (req: IncomingMessage): boolean => {
    const given = ['x-site-token', 'x-chat-token', 'x-lead-token'].map((h) => req.headers[h]).find((v): v is string => typeof v === 'string' && v !== '');
    return given !== undefined && siteTokens.some((t) => tokenOk(given, t));
  };
  const hits: number[] = [];
  const fileHits: number[] = [];
  const auditHits: number[] = [];
  const statusHits = new Map<string, number[]>();
  const blogHits = new Map<string, number[]>();
  const payByIp = new KeyedLimit(60, 60_000);
  const mediaByIp = new KeyedLimit(300, 60_000);
  const agentByIp = new KeyedLimit(20, 60_000);
  const agentByIpDay = new KeyedLimit(300, 86_400_000);
  const auditByIp = new KeyedLimit(10, 3_600_000);
  const leadByIp = new KeyedLimit(20, 3_600_000);
  const eventsByIp = new KeyedLimit(120, 60_000);
  const leadInFlight = new Map<string, Promise<Record<string, unknown>>>();
  return createServer((req, res) => {
    void (async () => {
      try {
        if (admin && req.url?.startsWith('/admin/')) {
          const adminGiven = req.headers['x-admin-token'] as string | undefined;
          const cabGiven = req.headers['x-cabinet-token'] as string | undefined;
          const isAdmin = adminGiven !== undefined && tokenOk(adminGiven, admin.token);
          const isCabinet = !isAdmin && admin.cabinetToken !== undefined && cabGiven !== undefined && tokenOk(cabGiven, admin.cabinetToken);
          if (!isAdmin && !isCabinet) return json(res, 401, { ok: false, error: 'unauthorized' });
          const url = new URL(req.url, 'http://hq.local');
          if (isCabinet && !cabinetRouteAllowed(req.method ?? 'GET', url.pathname)) return json(res, 403, { ok: false, error: 'forbidden' });
          if (req.method === 'GET' && admin.file && url.pathname.startsWith('/admin/files/')) {
            // pictures and video of one page load are many requests: their own, wider window (the 600 of `/admin/*` is for the API calls)
            const t = now();
            while (fileHits.length && fileHits[0]! < t - 600_000) fileHits.shift();
            if (fileHits.length >= 3000) return json(res, 429, { ok: false, error: 'rate_limited' });
            fileHits.push(t);
            const rangeHeader = req.headers.range;
            const out = admin.file(url.pathname.slice('/admin/files/'.length), typeof rangeHeader === 'string' ? rangeHeader : undefined, { allowCabinet: isAdmin });
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
          if (req.method === 'POST' || (req.method === 'PATCH' && AGENT_PATCH_PATH.test(url.pathname))) {
            const raw = await readBody(req, res, bodyLimit(url.pathname));
            if (raw === null) return json(res, 413, { ok: false, error: 'too_large' });
            try {
              body = raw.trim() ? JSON.parse(raw) : {};
            } catch {
              return json(res, 400, { ok: false, error: 'invalid' });
            }
          } else if (req.method === 'DELETE' && ADMIN_DELETE_PATH.test(url.pathname)) {
            body = {};
          } else if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method_not_allowed' });
          const out = await admin.handle({ method: req.method, path: url.pathname, query: url.searchParams, body });
          return json(res, out.status, out.body);
        }
        if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true });
        if (req.method === 'GET' && req.url?.split('?')[0] === '/status' && extra.status) {
          const ip = visitorIp(req, siteTokenValid(req));
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
          const ip = visitorIp(req, siteTokenValid(req));
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
        if ((req.method === 'GET' || req.method === 'HEAD') && extra.media && /^\/media\//.test(req.url ?? '')) {
          const ip = visitorIp(req, siteTokenValid(req));
          if (!mediaByIp.take(ip, now())) return json(res, 429, { ok: false, error: 'rate_limited' });
          const m = /^\/media\/([0-9a-f]{32})\/([^?#]+)(?:\?([^#]*))?/.exec(req.url!);
          const expRaw = m?.[3] ? new URLSearchParams(m[3]).get('e') : null;
          if (expRaw !== null && !/^\d{1,12}$/.test(expRaw)) return json(res, 404, { ok: false, error: 'not_found' });
          let rel = '';
          try {
            rel = m ? m[2]!.split('/').map(decodeURIComponent).join('/') : '';
          } catch {
            /* a broken escape is just an unknown file */
          }
          const found = m && rel ? extra.media.resolve(m[1]!, rel, expRaw === null ? null : Number(expRaw)) : null;
          if (!found) return json(res, 404, { ok: false, error: 'not_found' });
          res.writeHead(200, {
            'content-type': found.type, 'content-length': found.size, 'cache-control': expRaw === null ? 'public, max-age=3600' : 'private, max-age=600', 'x-content-type-options': 'nosniff',
            ...(INLINE_TYPES.test(found.type) ? {} : { 'content-disposition': 'attachment' }),
          });
          if (req.method === 'HEAD') return void res.end();
          const stream = createReadStream(found.file);
          stream.on('error', () => res.destroy());
          return void stream.pipe(res);
        }
        if (extra.agent && (req.method === 'POST' || req.method === 'OPTIONS') && /^\/agent\/[A-Za-z0-9_-]{1,40}\/chat(?:\?|$)/.test(req.url ?? '')) {
          const publicId = /^\/agent\/([A-Za-z0-9_-]{1,40})\/chat/.exec(req.url!)![1]!;
          const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
          // the browser asks first (preflight): the demo is open to any page, a real agent answers with the origin its client set (checked again on the POST)
          const cors = (allow: string) => ({ 'access-control-allow-origin': allow, 'access-control-allow-headers': 'content-type, x-agent-token', 'access-control-allow-methods': 'POST, OPTIONS', vary: 'origin' });
          if (req.method === 'OPTIONS') {
            res.writeHead(204, cors(publicId.startsWith('demo-') ? '*' : origin || '*'));
            return void res.end();
          }
          const ip = visitorIp(req, siteTokenValid(req));
          if (!agentByIp.take(ip, now()) || !agentByIpDay.take(ip, now())) {
            res.writeHead(429, { 'content-type': 'application/json', ...cors(publicId.startsWith('demo-') ? '*' : origin || '*') });
            return void res.end(JSON.stringify({ ok: false, error: 'rate_limited' }));
          }
          const raw = await readBody(req, res, 8 * 1024);
          if (raw === null) return json(res, 413, { ok: false, error: 'too_large' });
          let data: unknown = null;
          try {
            data = JSON.parse(raw);
          } catch {
            /* falls through to invalid */
          }
          const token = typeof req.headers['x-agent-token'] === 'string' ? req.headers['x-agent-token'] : '';
          // the signed-in identity of a demo request counts only from the site's server (its `x-chat-token`); a browser's body alone names nobody (M1)
          const trusted = Boolean(chat) && tokenOk(req.headers['x-chat-token'] as string | undefined, chat!.token);
          const out = await extra.agent.handle(publicId, { token, origin, body: data, trusted });
          res.writeHead(out.status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors(publicId.startsWith('demo-') ? '*' : out.allowOrigin ?? '') });
          return void res.end(JSON.stringify(out.body));
        }
        if (req.method === 'GET' && extra.pay && /^\/pay\//.test(req.url ?? '')) {
          const url = new URL(req.url!, 'http://hq.local');
          const ip = visitorIp(req, siteTokenValid(req));
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
          const raw = await readBody(req, res);
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
        if (req.method === 'POST' && req.url === '/events' && extra.events) {
          if (!tokenOk(req.headers['x-site-token'] as string | undefined, extra.events.token)) return json(res, 401, { ok: false, error: 'unauthorized' });
          if (!eventsByIp.take(visitorIp(req, true), now())) return json(res, 429, { ok: false, error: 'rate_limited' });
          const raw = await readBody(req, res);
          if (raw === null) return json(res, 413, { ok: false, error: 'too_large' });
          let data: unknown = null;
          try {
            data = JSON.parse(raw);
          } catch {
            /* falls through to invalid */
          }
          if (extra.events.handle(data) !== 'ok') return json(res, 400, { ok: false, error: 'invalid', allowed: EVENT_NAMES });
          return json(res, 200, { ok: true });
        }
        if (req.method === 'GET' && req.url === '/office' && office) {
          if (!tokenOk(req.headers['x-office-token'] as string | undefined, office.token)) return json(res, 401, { ok: false, error: 'unauthorized' });
          return json(res, 200, office.get());
        }
        if (req.method === 'POST' && req.url === '/chat') {
          if (!chat) return json(res, 404, { ok: false }); // no WEB_CHAT_TOKEN: the route does not exist
          if (!tokenOk(req.headers['x-chat-token'] as string | undefined, chat.token)) return json(res, 401, { ok: false, error: 'unauthorized' });
          const raw = await readBody(req, res);
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
          if (out.kind === 'login_required') return json(res, 401, { ok: false, error: 'login_required' });
          if (out.kind === 'limit') return json(res, 429, out.body);
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
        const raw = await readBody(req, res);
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
        const dedupe = extra.leadDedupe;
        const sid = lead.siteLeadId;
        if (dedupe && sid) {
          const first = dedupe.find(sid);
          if (first) return json(res, 200, { ...first, duplicate: true });
          const pending = leadInFlight.get(sid);
          if (pending) return json(res, 200, { ...(await pending), duplicate: true });
        }
        const work = (async (): Promise<Record<string, unknown>> => {
          const made = await onLead(lead);
          return typeof made === 'number' ? { ok: true, id: made, notified: true } : { ok: true, id: made.id, ...(made.leadId != null ? { leadId: made.leadId } : {}), notified: true };
        })();
        if (dedupe && sid) leadInFlight.set(sid, work);
        let reply: Record<string, unknown>;
        try {
          reply = await work;
        } finally {
          if (sid) leadInFlight.delete(sid);
        }
        if (dedupe && sid) dedupe.remember(sid, reply);
        return json(res, 200, reply);
      } catch (e) {
        log('error', 'webhook failed', { err: errMsg(e) });
        json(res, 500, { ok: false, error: 'internal' });
      }
    })();
  });
}
