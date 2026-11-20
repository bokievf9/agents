import type { Hq } from '@fir/hq';
import { storeFor } from '@fir/worker-content-maker';
import type { LinkRow } from '@fir/worker-trend-scout';
import { parseLink } from '@fir/worker-trend-scout';
import { z } from 'zod';
import type { AdminReply } from './admin.js';
import type { MarketingHead } from './heads/marketing.js';
import { fail, ok } from './pult-crm.js';

/**
 * `POST /admin/trends { url, note? }` and `GET /admin/trends`: the owner's own links for the Trendwatcher (the same flow as `/trend <url> [note]` in the Director bot).
 * Status per link: `analysing` (queued, being read or analysed, the analogue is being written), `proposed` (the analogue waits in the review center), `done` (the owner
 * decided it), `failed` (`error` says why). Contract: `docs/admin-crm-api.md`, section «Ревью-центр (2026-11-21)».
 */
export interface PultTrendsDeps {
  hq: Hq;
  now: () => number;
  marketing?: MarketingHead | undefined;
}

const postBody = z.object({ url: z.string().trim().min(1).max(600), note: z.string().trim().max(500).optional() }).strict();
const iso = (ms: number) => new Date(ms).toISOString();

export const LINK_STATUSES = ['analysing', 'proposed', 'done', 'failed'] as const;

export function createPultTrends(d: PultTrendsDeps) {
  const { hq } = d;
  const db = hq.db;

  function view(r: LinkRow) {
    const item = r.itemId !== null ? storeFor({ db, now: d.now }).item(r.itemId) : undefined;
    let status: (typeof LINK_STATUSES)[number];
    let error = r.error;
    if (r.status === 'failed') status = 'failed';
    else if (item) {
      if (item.status === 'failed') {
        status = 'failed';
        error = 'Материал не получился';
      } else if (item.status === 'ready' || item.status === 'rejected') status = 'done';
      else status = item.status === 'proposed' ? 'proposed' : 'analysing';
    } else status = 'analysing';
    const approval = r.itemId !== null ? (db.prepare("SELECT id FROM task_approvals WHERE kind = 'content_item' AND json_extract(payload, '$.itemId') = ? ORDER BY id DESC LIMIT 1").get(r.itemId) as { id: number } | undefined) : undefined;
    const parsed = parseLink(r.url);
    return {
      id: r.id, url: r.url, host: r.host, platform: parsed.ok ? parsed.platform : null, note: r.note, status, error, createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt), taskId: r.taskId,
      analysis: r.analysis ? { format: r.analysis.format, hook: r.analysis.hook, structure: r.analysis.structure, whyItWorks: r.analysis.whyItWorks, numbers: r.analysis.numbers ?? null, analogue: r.analysis.analogue } : null,
      reviewId: approval ? `ap_${approval.id}` : null, itemId: r.itemId,
    };
  }

  function post(body: unknown): AdminReply {
    if (!d.marketing) return fail(503, 'unavailable');
    const parsed = postBody.safeParse(body ?? {});
    if (!parsed.success) return fail(400, 'invalid');
    const r = d.marketing.addOwnerLink(parsed.data.url, parsed.data.note ?? '');
    if (!r.ok) return fail(400, 'invalid_link', { reason: r.reason });
    const row = d.marketing.links().get(r.id)!;
    return ok({ item: view(row), already: r.already });
  }

  function list(query: URLSearchParams): AdminReply {
    if (!d.marketing) return fail(503, 'unavailable');
    const limRaw = query.get('limit');
    const limit = limRaw === null || limRaw === '' ? 50 : /^\d+$/.test(limRaw) ? Math.min(Math.max(Number(limRaw), 1), 200) : NaN;
    if (!Number.isFinite(limit)) return fail(400, 'invalid', { hint: 'limit' });
    const curRaw = query.get('cursor');
    if (curRaw && !/^\d+$/.test(curRaw)) return fail(400, 'invalid', { hint: 'cursor' });
    const rows = d.marketing.links().list(limit + 1, curRaw ? Number(curRaw) : undefined);
    const page = rows.slice(0, limit);
    return ok({ items: page.map(view), nextCursor: rows.length > limit ? String(page.at(-1)!.id) : null, statuses: LINK_STATUSES });
  }

  return { post, list };
}
