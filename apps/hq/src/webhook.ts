import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { errMsg, log } from '@fir/core';

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

/**
 * `POST /lead` (header `x-lead-token`) and `GET /health`. Listens inside the hq container; compose publishes it on
 * 127.0.0.1 only (firtech.pro on the same host posts here). `onLead` creates the Sales task and returns its id.
 */
export function createWebhook(
  onLead: (lead: WebLeadInput) => Promise<number>,
  token: string,
  now: () => number = Date.now,
  /** `GET /office` (header `x-office-token`); without it the route answers 404. */
  office?: { token: string; get: () => unknown },
): Server {
  const hits: number[] = [];
  return createServer((req, res) => {
    void (async () => {
      try {
        if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true });
        if (req.method === 'GET' && req.url === '/office' && office) {
          if (!tokenOk(req.headers['x-office-token'] as string | undefined, office.token)) return json(res, 401, { ok: false, error: 'unauthorized' });
          return json(res, 200, office.get());
        }
        if (req.method !== 'POST' || req.url !== '/lead') return json(res, 404, { ok: false });
        if (!tokenOk(req.headers['x-lead-token'] as string | undefined, token)) return json(res, 401, { ok: false, error: 'unauthorized' });
        // Coarse global limit: the form is low traffic, a flood means abuse.
        const t = now();
        while (hits.length && hits[0]! < t - 60_000) hits.shift();
        if (hits.length >= 60) return json(res, 429, { ok: false, error: 'rate_limited' });
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
