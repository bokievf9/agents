import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import type { ApprovalQueue, Db, Payload } from '@fir/core';
import type { Hq, Task, TaskApproval } from '@fir/hq';
import { BillingStore } from '@fir/worker-billing';
import { DocStore, DOC_RU as DOC_NAME } from '@fir/worker-documents';
import { captionOf } from '@fir/worker-publisher';
import { RenderQueue, SIZES, parseReel, replacePart, splitKit, splitPlatforms, storeFor, type ContentStore, type Item, type ItemType, type Platform, type ReadyRow } from '@fir/worker-content-maker';
import { analysisText, LinkStore } from '@fir/worker-trend-scout';
import { z } from 'zod';
import type { AdminReply } from './admin.js';
import type { createCrm } from './admin-crm.js';
import type { CabDocs } from './cab-docs.js';
import type { Director } from './director.js';
import type { MarketingHead } from './heads/marketing.js';
import type { OwnerChannel } from './presence.js';
import { AuditStore } from './audit-shared.js';
import { fail, ok } from './shell-crm.js';
import { PILOT_DIRECTIONS, withPilot } from '@fir/worker-presales';
import { ReviewVersions, type ReviewVersion } from './review-versions.js';

/**
 * «Ревью-центр»: one surface where the owner reads, edits, approves and publishes what the departments made. `GET /admin/review` maps EVERY approval of
 * the company (`task_approvals`, all kinds) to one item shape; `POST /admin/review/:id` runs an action. Decisions go through the same queue code as the
 * Telegram buttons (`decide` of the admin API: `queue.handle`, then the Telegram card is settled), never a second path. Contract: `docs/admin-crm-api.md`,
 * section «Ревью-центр (2026-11-21)».
 */
export interface ReviewDeps {
  hq: Hq;
  queue: ApprovalQueue;
  director: Director;
  channel: OwnerChannel;
  now: () => number;
  crm: ReturnType<typeof createCrm>;
  marketing?: MarketingHead | undefined;
  /** `DATA_DIR/renders`: media paths are relative to it, `GET /admin/files/<path>` serves them. */
  rendersDir?: string | undefined;
  /** The owner's decision on one open core approval (`admin.ts`: the queue's `handle`, tasks follow, the Telegram card is settled). */
  decide: (approvalId: number, action: 'approve' | 'reject') => Promise<unknown>;
  /** The lead call slot (`POST /admin/crm/leads/:id/call`). */
  callLead: (leadId: number, at: string) => Promise<AdminReply | null>;
  /** The cabinet's documents: a КП, смета or contract that already went to the client is revised in place. Without it the texts are replaced, nothing is re-rendered. */
  cabinet?: Pick<CabDocs, 'reviseDelivered' | 'revisable'> | undefined;
}

export const REVIEW_DEPTS = ['marketing', 'sales', 'support', 'production', 'backoffice', 'director'] as const;
export const REVIEW_STATUSES = ['pending', 'approved', 'rejected', 'published', 'failed'] as const;
export const REVIEW_ACTIONS = ['approve', 'edit', 'revise', 'reject', 'publish_now', 'reschedule', 'send', 'call'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

interface Media { type: 'video' | 'image' | 'pdf' | 'html'; url: string; poster: string | null; w: number | null; h: number | null; durationS: number | null }
type Json = Record<string, unknown>;

/** What a kind contributes to an item; the rest (status, versions, actions) is common. */
interface Part {
  title: string;
  summary: string;
  text: Json;
  media: Media[];
  meta: Json;
  /** How the owner can replace the text: `content` (parts of an item), `draft` (the whole `payload.text`), or not at all. */
  edit: 'content' | 'draft' | 'pack' | null;
  /** The edit is also open after the approval (a КП, смета or contract the client has not acted on yet): a new version, the client sees the latest. */
  editApproved?: boolean;
  /** The kind has its own «Правки» to a worker. */
  revise: boolean;
  publishable: boolean;
  /** Content item facts for the actions. */
  item?: { id: number; type: ItemType; hasUnpublished: boolean; published: boolean; failed: string | null; ready: boolean };
  leadId: number | null;
  sendable: boolean;
  error: string | null;
  /** The approval looks decided to the owner even though the core row says executed (an article that is live, an item that is out). */
  published: boolean;
}

const textBody = z.object({
  draft: z.string().max(8000).optional(),
  body: z.string().max(8000).optional(),
  caption: z.string().max(4000).optional(),
  hashtags: z.array(z.string().trim().min(1).max(60)).max(40).optional(),
  captions: z.object({ instagram: z.string().max(4000).optional(), tiktok: z.string().max(4000).optional(), shorts: z.string().max(4000).optional() }).strict().optional(),
}).strict();
const DOC_KEYS = ['kp', 'estimate', 'contract'] as const;
const postBody = z.object({
  action: z.enum(REVIEW_ACTIONS),
  /** A plain string is the same as `{draft: string}`. */
  text: z.preprocess((v) => (typeof v === 'string' ? { draft: v } : v), textBody).optional(),
  /** Which document of a КП pack the text replaces (`presales_pack` only). */
  doc: z.enum(DOC_KEYS).optional(),
  /** `presales_pack` of a flagship (Персональный ИИ, ИИ-компания): puts the block «пилот бесплатно за кейс и отзыв» into the КП (`true`) or takes it out (`false`); no `text` needed. */
  pilot: z.boolean().optional(),
  note: z.string().trim().min(1).max(4000).optional(),
  slot: z.string().trim().min(1).max(40).optional(),
  platform: z.enum(['instagram', 'tiktok', 'shorts', 'youtube']).optional(),
}).strict();

const PLATFORM_ORDER: Platform[] = ['instagram', 'tiktok', 'shorts'];
const FORMAT: Record<ItemType, string> = { clip: 'reel', post: 'post', carousel: 'carousel', story: 'story', profile: 'profile' };
const IMAGE_SIZE: Record<ItemType, { width: number; height: number }> = { clip: SIZES.cover, post: SIZES.post, carousel: SIZES.slide, story: SIZES.story, profile: SIZES.cover };
const PROSPECT_RU: Record<string, string> = { first: 'первое сообщение', followup: 'дожим', reply: 'ответ' };

const iso = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());
const oneLine = (s: string, n = 160) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1).trimEnd()}…` : one;
};
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** The batch prefix of a card summary («[2/9] marketing, задача #4») is not part of the title. */
const stripPrefix = (s: string) => s.replace(/^\[\d+\/\d+\][^\n]*\n/, '').replace(/^Срочно,[^\n]*\n/, '');

/** Width and height from a PNG header (24 bytes); null when the file is not readable as a PNG. */
function pngDims(file: string): { w: number; h: number } | null {
  try {
    const fd = openSync(file, 'r');
    try {
      const b = Buffer.alloc(24);
      if (readSync(fd, b, 0, 24, 0) < 24 || b.readUInt32BE(0) !== 0x89504e47) return null;
      return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * The one definition of «a card waits for the owner» (`GET /admin/review` counts, `/admin/hub`, `/admin/today`, the Telegram lines): a proposal that
 * is queued (no core row yet, or an open one) or asked (open core row), never a weekly pack's own card.
 */
const PENDING_WHERE = `t.kind != 'content_pack' AND ((t.state = 'queued' AND (a.id IS NULL OR a.status IN ('pending','editing'))) OR (t.state = 'asked' AND a.status IN ('pending','editing')))`;
const PENDING_FROM = 'FROM task_approvals t LEFT JOIN approvals a ON a.id = t.approval_id';

/** The cards waiting for the owner, by department and kind: the one query behind `counts` of `GET /admin/review` and the dashboard's approvals block. */
export function pendingApprovals(db: Db): { dept: string; kind: string; n: number }[] {
  return db.prepare(`SELECT t.dept dept, t.kind kind, COUNT(*) n ${PENDING_FROM} WHERE ${PENDING_WHERE} GROUP BY t.dept, t.kind`).all() as { dept: string; kind: string; n: number }[];
}

/** How many cards wait for the owner: the one number shown by the review counts, the hub, `/admin/today`, the menu badge and Telegram. */
export function pendingApprovalsCount(db: Db): number {
  return (db.prepare(`SELECT COUNT(*) n ${PENDING_FROM} WHERE ${PENDING_WHERE}`).get() as { n: number }).n;
}

/** The waiting cards, the longest waiting first (`id` is the review id `ap_<id>`). */
export function pendingApprovalRows(db: Db, limit: number): { id: number; dept: string; kind: string; summary: string; createdAt: number }[] {
  return (db.prepare(`SELECT t.id id, t.dept dept, t.kind kind, t.summary summary, t.created_at createdAt ${PENDING_FROM} WHERE ${PENDING_WHERE} ORDER BY t.id ASC LIMIT ?`).all(limit)) as { id: number; dept: string; kind: string; summary: string; createdAt: number }[];
}

export function createReview(d: ReviewDeps) {
  const { hq, queue, now } = d;
  const db = hq.db;
  const { views } = d.crm;
  const versions = new ReviewVersions(db, now);
  const has = (t: string) => views.has(t);
  const cstore = (): ContentStore => storeFor({ db, now });
  const rid = (linkId: number) => `ap_${linkId}`;
  const linkOfRid = (id: string): number | null => (/^ap_(\d+)$/.exec(id) ? Number(id.slice(3)) : null);

  // ---- the states of one approval ----
  const coreOf = (l: TaskApproval) => (l.approvalId !== null ? queue.get(l.approvalId) : undefined);
  /** The payload the owner sees now: the core row's (an edit lands there), else the proposal's. */
  const payloadOf = (l: TaskApproval): Payload => coreOf(l)?.payload ?? l.payload;

  function baseStatus(l: TaskApproval): ReviewStatus {
    const core = coreOf(l);
    if (core) {
      if (core.status === 'executed') return 'approved';
      if (core.status === 'rejected') return 'rejected';
      if (core.status === 'failed') return 'failed';
      return 'pending'; // pending, editing, running
    }
    return l.state === 'executed' ? 'approved' : l.state === 'rejected' ? 'rejected' : l.state === 'failed' ? 'failed' : 'pending';
  }

  /** The open core approval of a link; a proposal that never went out as a card (batch, pack) gets its row now. null: nothing open. */
  function openApproval(l: TaskApproval): number | null {
    const id = l.approvalId ?? hq.openQueued(l.id);
    if (id === null) return null;
    const row = queue.get(id);
    return row && (row.status === 'pending' || row.status === 'editing') ? id : null;
  }

  // ---- lead, ticket, client facts ----
  /** The stage an invoice card pays (payment by stages): its number, how many stages the project has, its title and amount. */
  function reviewStage(projectId: number, stageNo: number): Json {
    const stages = views.stageViews(projectId);
    const m = stages.find((x) => x.stageNo === stageNo);
    return { no: stageNo, of: stages.length || null, title: m?.title ?? null, amountUsd: m?.amountUsd ?? null };
  }

  function leadFacts(leadId: number | null): { lead: Json | null; client: Json } {
    const none = { lead: null, client: { id: null, email: null, cabinet: false } };
    if (leadId === null || !has('li_leads')) return none;
    const v = views.lead(leadId);
    if (!v) return none;
    const c = views.one<{ client_id: number | null }>('SELECT client_id FROM li_leads WHERE id = ?', leadId);
    const cab = c?.client_id != null && has('cab_clients') ? views.one<{ id: number; email: string }>('SELECT id, email FROM cab_clients WHERE id = ?', c.client_id) : undefined;
    return {
      lead: { id: v.id, name: v.name, contact: v.contact, service: v.service, budget: v.budget, stage: v.stage, source: v.source, temperature: v.temperature, taskId: v.taskId, callAt: v.callAt, cabinet: v.cabinet, enrichment: v.enrichment, message: v.message, estimate: v.estimate, builderUrl: v.builderUrl },
      client: cab ? { id: cab.id, email: cab.email, cabinet: true } : { id: null, email: null, cabinet: false },
    };
  }

  function ticketFacts(ticketId: number | null): { ticket: Json | null; leadId: number | null } {
    if (ticketId === null || !has('cs_tickets')) return { ticket: null, leadId: null };
    const t = views.ticketsWhere('id = ?', [ticketId])[0];
    if (!t) return { ticket: null, leadId: null };
    const lead = views.one<{ lead_id: number | null }>('SELECT lead_id FROM cs_tickets WHERE id = ?', ticketId);
    return { ticket: { id: t.id, clientName: t.clientName, contact: t.contact, status: t.status, money: t.money, question: t.text, createdAt: t.createdAt, answeredAt: t.answeredAt }, leadId: lead?.lead_id ?? null };
  }

  // ---- content items ----
  function mediaOfItem(item: Item, rows: ReadyRow[]): Media[] {
    if (!d.rendersDir) return [];
    const root = d.rendersDir;
    const out: Media[] = [];
    const rel = (abs: string): string | null => {
      const r = isAbsolute(abs) ? relative(root, abs) : abs;
      return r && !r.startsWith('..') && !isAbsolute(r) ? r.split('\\').join('/') : null;
    };
    for (const f of rows.flatMap((r) => r.files)) {
      const path = rel(f);
      if (!path || !existsSync(join(root, path))) continue;
      if (path.toLowerCase().endsWith('.pdf')) {
        out.push({ type: 'pdf', url: `/admin/files/${path}`, poster: null, w: null, h: null, durationS: null });
        continue;
      }
      const dims = pngDims(join(root, path)) ?? { w: IMAGE_SIZE[item.type].width, h: IMAGE_SIZE[item.type].height };
      out.push({ type: 'image', url: `/admin/files/${path}`, poster: null, w: dims.w, h: dims.h, durationS: null });
    }
    if (item.type === 'clip' && existsSync(join(root, String(item.id), 'reel.mp4'))) {
      const reel = parseReel(item.text);
      out.push({ type: 'video', url: `/admin/files/${item.id}/reel.mp4`, poster: null, w: 1080, h: 1920, durationS: reel?.durationSec ?? null });
    }
    return out;
  }

  /** The text of a content item as the review center shows and edits it. */
  function contentText(item: Item, full: string): Json {
    const { body, sections } = splitPlatforms(full);
    const out: Json = { body, draft: full };
    const ig = sections.instagram;
    if (ig) {
      const c = captionOf(ig, 'instagram');
      out.caption = c.caption;
      out.hashtags = c.hashtags;
    } else {
      out.caption = '';
      out.hashtags = [];
    }
    out.captions = Object.fromEntries(PLATFORM_ORDER.filter((p) => sections[p] !== undefined).map((p) => [p, sections[p]]));
    if (item.type === 'profile') {
      const kit = splitKit(full);
      out.kit = { instagram: kit.instagram ?? '', youtube: kit.youtube ?? '', tiktok: kit.tiktok ?? '' };
    }
    return out;
  }

  function taskMetaOf(l: TaskApproval): Record<string, unknown> {
    return hq.task(l.taskId)?.meta ?? {};
  }

  function sourceOf(l: TaskApproval): string {
    const t = hq.task(l.taskId);
    if (t?.meta.source === 'owner_link') return 'owner_link';
    if (t?.creator === 'owner' || t?.creator === 'director') return 'owner';
    return 'routine';
  }

  function contentPart(l: TaskApproval, payload: Payload, status: ReviewStatus): Part | null {
    const s = cstore();
    const item = s.item(Number(payload.itemId));
    if (!item) return null;
    const rows = s.rowsOfItem(item.id);
    const media = mediaOfItem(item, rows);
    const full = typeof payload.text === 'string' ? payload.text : item.text;
    const text = contentText(item, full);
    const platforms = rows.length > 0 ? rows.map((r) => r.platform) : item.type === 'clip' ? PLATFORM_ORDER : (['instagram'] as Platform[]);
    const queued = has('mac_queue') ? (db.prepare("SELECT platform FROM mac_queue WHERE item_id = ? AND status = 'queued'").all(item.id) as { platform: string }[]).map((r) => r.platform) : [];
    const posts = has('pb_posts') ? (db.prepare('SELECT ready_id, url, error, published_at FROM pb_posts WHERE item_id = ?').all(item.id) as { ready_id: number; url: string | null; error: string | null; published_at: number | null }[]) : [];
    const unpublished = rows.filter((r) => r.status !== 'published');
    const published = rows.length > 0 && unpublished.length === 0;
    const err = posts.find((p) => p.error && p.published_at === null)?.error ?? null;
    const job = item.type === 'clip' && has('cm_render_jobs') ? new RenderQueue(db, now).latest(item.id) : undefined;
    // pictures are drawn when the item is approved, a reel's video by the renderer after it: «none» is the state before that
    const renderState = media.length > 0 ? 'ready'
      : item.type === 'clip' ? (job?.status === 'failed' || (job?.status === 'queued' && job.error) ? 'failed' : job && (job.status === 'queued' || job.status === 'running') ? 'rendering' : 'none')
      : status === 'pending' || !d.rendersDir ? 'none' : 'failed';
    const hook = /^Хук[^:]*:\s*(.+)$/m.exec(item.type === 'clip' ? full : '')?.[1]?.trim();
    const link = new LinkStore(db, now).byItem(item.id);
    const meta: Json = {
      slot: item.plannedDate, plannedDate: item.plannedDate, platform: item.type === 'profile' ? 'all' : 'instagram', platforms, format: FORMAT[item.type], itemId: item.id,
      source: link ? 'owner_link' : sourceOf(l), render: { state: renderState }, publishedOn: rows.filter((r) => r.status === 'published').map((r) => r.platform), macQueued: queued,
      publishedUrl: posts.find((p) => p.url)?.url ?? null, ...(item.sourceSlug ? { sourceSlug: item.sourceSlug } : {}),
      ...(link ? { link: { id: link.id, url: link.url, note: link.note } } : {}),
    };
    const publishable = item.type !== 'profile' && status !== 'rejected' && !published;
    const ready = item.type === 'clip' ? media.some((m) => m.type === 'video') : media.length > 0;
    return {
      title: item.title || oneLine(item.topicText, 120), summary: oneLine(hook ?? stripPrefix(l.summary).split('\n')[0] ?? ''), text, media, meta, edit: 'content', revise: item.type !== 'profile', publishable,
      item: { id: item.id, type: item.type, hasUnpublished: unpublished.length > 0, published, failed: err, ready }, leadId: null, sendable: false, error: err, published,
    };
  }

  function articlePart(l: TaskApproval, payload: Payload): Part | null {
    const a = cstore().article(Number(payload.articleId));
    if (!a) return null;
    const live = a.published && a.status === 'approved';
    const body = str(payload.text);
    return {
      title: a.title || a.niche, summary: oneLine(stripPrefix(l.summary).split('\n')[0] ?? ''), text: { subject: a.title || a.niche, body, draft: body }, media: [],
      meta: { platform: 'blog', article: { id: a.id, niche: a.niche, line: a.line, slug: a.slug || null }, url: live && a.slug ? `/blog/${a.slug}` : null, source: sourceOf(l) },
      edit: null, revise: true, publishable: !live, leadId: null, sendable: false, error: a.status === 'failed' ? (a.comment ?? 'не получилось') : null, published: live,
    };
  }

  function packPart(l: TaskApproval, payload: Payload): Part {
    const ids = Array.isArray(payload.itemTaskIds) ? payload.itemTaskIds.filter((x): x is number => typeof x === 'number') : [];
    const children = ids.length ? (db.prepare(`SELECT id FROM task_approvals WHERE kind = 'content_item' AND task_id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(...ids) as { id: number }[]).map((r) => rid(r.id)) : [];
    return {
      title: `Пакет недели: ${children.length} материалов`, summary: oneLine(stripPrefix(l.summary).split('\n')[0] ?? ''),
      text: { body: stripPrefix(l.summary) }, media: [], meta: { pack: { count: children.length, itemIds: children }, source: 'routine' },
      edit: null, revise: false, publishable: false, leadId: null, sendable: false, error: null, published: false,
    };
  }

  // ---- documents: a КП pack and a Back Office document can be edited, before and after the approval ----
  /** A КП pack after its approval: the КП and the смета can be changed until the client acted on them (no cabinet row counts as open). */
  const packRevisable = (payload: Payload): boolean => {
    const packId = num(payload.packId);
    return packId !== null && (d.cabinet?.revisable('ps_quote', packId) ?? true) && (d.cabinet?.revisable('ps_estimate', packId) ?? true);
  };
  /** An approved Back Office document: new versions until the client signed it. */
  const docRevisable = (docId: number): boolean => d.cabinet?.revisable('bo', docId) ?? true;
  const draftOf = (b: z.output<typeof postBody>): string => (b.text?.draft ?? b.text?.body ?? '').trim();

  /** `presales_pack`: `doc` names the document (`kp`, `estimate`, `contract`); pending: the proposal's payload and the stored draft change, the card stays open; approved: КП and смета go to the client's cabinet again. */
  async function editPack(l: TaskApproval, b: z.output<typeof postBody>, extra: Payload = {}): Promise<AdminReply> {
    if (!b.doc) return fail(400, 'invalid', { hint: 'doc is required for a КП pack: kp, estimate or contract' });
    const next = draftOf(b);
    if (!next) return fail(400, 'invalid', { hint: 'text.draft is required' });
    const key = rid(l.id);
    const before = build(l);
    const payload = payloadOf(l);
    if (next === str(payload[b.doc]).trim()) return fail(409, 'not_applied', { reason: 'текст не изменился' });
    const packId = num(payload.packId);
    const approved = baseStatus(l) === 'approved';
    const base = { text: before.text as Json, media: [] as unknown[], note: '', at: l.createdAt };
    if (approved) {
      // the contract of an approved pack is already a Back Office document of its own (a card, then the client's signature): it is edited there
      if (b.doc === 'contract') return fail(409, 'not_applicable', { reason: 'договор после одобрения КП правится карточкой документа (bo_document)' });
      if (packId === null || !packRevisable(payload)) return fail(409, 'locked', { reason: 'клиент уже принял КП' });
      if (l.approvalId === null) return fail(409, 'not_pending', { status: baseStatus(l) });
      await d.cabinet?.reviseDelivered(b.doc === 'kp' ? 'ps_quote' : 'ps_estimate', packId, next);
      queue.amendPayload(l.approvalId, { [b.doc]: next, ...extra });
    } else {
      const core = openApproval(l);
      if (core === null) return fail(409, 'not_pending', { status: baseStatus(l) });
      const { result } = await d.channel.capture(() => queue.applyPatch(core, b.doc === 'contract' ? { contract: next, contractEdited: true } : { [b.doc!]: next, ...extra }));
      if (!result) return fail(409, 'not_applied', { status: queue.get(core)?.status ?? baseStatus(l) });
      await queue.settleCard(core).catch(() => false);
    }
    // the stored document follows (the cabinet and the chain read the payload; the archive reads the table)
    if (packId !== null && has('ps_documents')) db.prepare('UPDATE ps_documents SET body = ? WHERE pack_id = ? AND kind = ? AND status IN (\'draft\', \'approved\')').run(next, packId, b.doc);
    const after = build(hq.approvalLink(l.id)!);
    versions.add(key, { text: after.text as Json, media: [], note: `${b.note ? `владелец: ${b.note}` : 'владелец'} (${b.doc})`, author: 'owner' }, { ...base, note: baseNote(l, describe(l, payload, 'pending')) });
    return ok({ item: view(l) });
  }

  /** An approved Back Office document: a new version row (the client's cabinet row follows it and its PDF is rendered again) until the client signed. */
  async function reviseApprovedDoc(l: TaskApproval, b: z.output<typeof postBody>): Promise<AdminReply> {
    if (l.kind !== 'bo_document' || l.approvalId === null) return fail(409, 'not_applicable', { status: baseStatus(l) });
    const next = draftOf(b);
    if (!next) return fail(400, 'invalid', { hint: 'text.draft is required' });
    const payload = payloadOf(l);
    const docs = new DocStore(db, now);
    const old = docs.get(Number(payload.docId));
    if (!old) return fail(404, 'not_found', { reason: 'документ не найден' });
    if (next === old.text.trim()) return fail(409, 'not_applied', { reason: 'текст не изменился' });
    if (!docRevisable(old.id)) return fail(409, 'locked', { reason: 'клиент уже подписал документ' });
    const key = rid(l.id);
    const before = build(l);
    const row = docs.add({ type: old.type, client: old.client, projectId: old.projectId, text: next, taskId: old.taskId });
    docs.setStatus(row.id, 'approved', next);
    await d.cabinet?.reviseDelivered('bo', old.id, next, row.id);
    queue.amendPayload(l.approvalId, { text: next, docId: row.id });
    const after = build(hq.approvalLink(l.id)!);
    versions.add(key, { text: after.text as Json, media: [], note: b.note ? `владелец: ${b.note}` : `владелец (версия ${row.version})`, author: 'owner' }, { text: before.text as Json, media: [], note: '', at: l.createdAt });
    return ok({ item: view(l) });
  }

  // ---- other kinds ----
  function generic(l: TaskApproval, payload: Payload, title: string, extra: { meta?: Json; text?: Json; leadId?: number | null; sendable?: boolean; edit?: 'draft' | 'pack' | null; editApproved?: boolean } = {}): Part {
    const draft = typeof payload.text === 'string' ? payload.text : null;
    return {
      title: oneLine(title, 140), summary: oneLine(stripPrefix(l.summary).split('\n')[0] ?? ''), text: { ...(draft !== null ? { draft, body: draft } : { body: stripPrefix(l.summary) }), ...(extra.text ?? {}) },
      media: [], meta: extra.meta ?? {}, edit: extra.edit === undefined ? (draft !== null ? 'draft' : null) : extra.edit, revise: false, publishable: false, leadId: extra.leadId ?? null, ...(extra.editApproved ? { editApproved: true } : {}),
      sendable: extra.sendable ?? false, error: null, published: false,
    };
  }

  function describe(l: TaskApproval, payload: Payload, status: ReviewStatus): Part {
    switch (l.kind) {
      case 'content_item': {
        const p = contentPart(l, payload, status);
        if (p) return p;
        break;
      }
      case 'content_pack':
        return packPart(l, payload);
      case 'article': {
        const p = articlePart(l, payload);
        if (p) return p;
        break;
      }
      case 'lead_reply':
      case 'lead_price': {
        const leadId = num(payload.leadId);
        const f = leadFacts(leadId);
        return generic(l, payload, `${l.kind === 'lead_price' ? 'Цена и сроки' : 'Ответ лиду'}: ${str(payload.name) || str((f.lead as Json | null)?.name) || `лид #${leadId ?? '?'}`}`, {
          meta: {
            lead: f.lead, client: f.client, delivery: payload.chatId !== undefined ? 'telegram' : 'owner',
            // a clarifying question of the Sales head (level 1, already sent): the questions and how many went out
            ...(payload.clarify === true ? { clarify: { questions: Array.isArray(payload.questions) ? payload.questions : [], sent: true } } : {}),
          }, leadId, sendable: true,
        });
      }
      case 'support_answer':
      case 'support_money': {
        const t = ticketFacts(num(payload.ticketId));
        const f = leadFacts(t.leadId);
        return generic(l, payload, `${l.kind === 'support_money' ? 'Деньги' : 'Ответ клиенту'}: тикет #${num(payload.ticketId) ?? '?'}`, {
          meta: { ticket: t.ticket, lead: f.lead, client: f.client, delivery: payload.chatId !== undefined ? 'telegram' : 'owner' }, leadId: t.leadId, sendable: true,
        });
      }
      case 'presales_pack': {
        const leadId = num(payload.leadId);
        const f = leadFacts(leadId);
        // the rows of this pack in `ps_documents` (the newest of each kind): the site matches its document rows by these ids
        const packIdNum = num(payload.packId);
        const rowIds = new Map<string, number>();
        if (packIdNum !== null && has('ps_documents')) {
          for (const r of db.prepare('SELECT id, kind FROM ps_documents WHERE pack_id = ? ORDER BY id').all(packIdNum) as { id: number; kind: string }[]) rowIds.set(r.kind, r.id);
        }
        const docs = [
          { key: 'kp', title: 'Коммерческое предложение', body: str(payload.kp) }, { key: 'estimate', title: 'Смета', body: str(payload.estimate) }, { key: 'contract', title: 'Договор (черновик)', body: str(payload.contract) },
        ].filter((x) => x.body).map((x) => ({ id: rowIds.get(x.key) ?? null, ...x }));
        return generic(l, payload, `КП: ${str(payload.client) || f.lead?.name || 'клиент'}, ${str(payload.what)}`, {
          text: { body: str(payload.kp), documents: docs }, edit: 'pack', editApproved: status === 'approved' && packRevisable(payload), leadId,
          meta: {
            lead: f.lead, client: f.client,
            pack: { id: num(payload.packId), documentIds: docs.map((x) => x.id).filter((x): x is number => x !== null), direction: str(payload.direction), totalUsd: num(payload.totalUsd), prepayUsd: num(payload.prepayUsd), prepayPercent: num(payload.prepayPercent), stages: Array.isArray(payload.stages) ? payload.stages : null, timeline: str(payload.timeline) || null, ...(typeof payload.pilot === 'boolean' ? { pilot: payload.pilot, monthlyUsd: num(payload.monthlyUsd) } : {}) },
          },
        });
      }
      case 'bo_document': {
        const doc = has('bo_documents') ? views.one<{ id: number; type: string; client: string; version: number; project_id: number | null }>('SELECT id, type, client, version, project_id FROM bo_documents WHERE id = ?', Number(payload.docId)) : undefined;
        return generic(l, payload, doc ? `Документ: ${DOC_NAME[doc.type as keyof typeof DOC_NAME]?.toLowerCase() ?? doc.type}, ${doc.client}, версия ${doc.version}` : 'Документ', { ...(status === 'approved' && doc && docRevisable(doc.id) ? { editApproved: true } : {}), meta: { document: doc ? { id: doc.id, type: doc.type, client: doc.client, version: doc.version, projectId: doc.project_id } : { id: num(payload.docId) } } });
      }
      case 'billing_invoice':
      case 'billing_reminder': {
        const inv = has('bl_invoices') ? new BillingStore(db, now).invoice(Number(payload.invoiceId)) : undefined;
        const f = leadFacts(inv?.leadId ?? null);
        return generic(l, payload, `${l.kind === 'billing_invoice' ? 'Счёт' : 'Напоминание'} ${inv?.number ?? ''}: ${inv?.client ?? str(payload.name)}`.replace(/\s+:/, ':'), {
          meta: {
            invoice: inv ? { id: inv.id, number: inv.number, client: inv.client, amountUsd: inv.amountUsd, dueDate: inv.dueDate, status: inv.status, what: inv.what, leadId: inv.leadId, projectId: inv.projectId } : { id: num(payload.invoiceId) },
            ...(inv?.stageNo != null && inv.projectId != null ? { stage: reviewStage(inv.projectId, inv.stageNo) } : {}),
            lead: f.lead, client: f.client,
          },
          leadId: inv?.leadId ?? null,
        });
      }
      case 'referral_reward':
      case 'referral_payout': {
        const r = has('rf_referrals') ? views.one<{ id: number; referrer: string; referred: string; status: string; reward: string }>('SELECT id, referrer, referred, status, reward FROM rf_referrals WHERE id = ?', Number(payload.referralId)) : undefined;
        return generic(l, payload, `${l.kind === 'referral_payout' ? 'Выплата рекомендателю' : 'Награда за рекомендацию'}: ${r?.referrer ?? '?'}`, {
          meta: { referral: r ? { id: r.id, referrer: r.referrer, referred: r.referred, status: r.status, reward: r.reward } : { id: num(payload.referralId) } }, edit: null,
        });
      }
      case 'pm_spec':
      case 'pm_client_status': {
        const p = views.project(Number(payload.projectId));
        return generic(l, payload, `${l.kind === 'pm_spec' ? 'ТЗ проекта' : 'Статус клиенту'} #${num(payload.projectId) ?? '?'}${p ? `: ${p.client}` : ''}`, { meta: { project: p ? { id: p.id, client: p.client, status: p.status } : { id: num(payload.projectId) } } });
      }
      case 'client_campaign':
        // a mailing to clients: the owner reads (and may edit) the text that will go out; the audience is a count in the summary, never addresses
        return generic(l, payload, `Рассылка #${num(payload.campaignId) ?? '?'}: ${oneLine(stripPrefix(l.summary).split('\n')[0] ?? 'клиентам', 100)}`, { text: { body: str(payload.text) }, meta: { campaign: { id: num(payload.campaignId) } } });
      case 'onboarding_guide':
        return generic(l, payload, `Инструкция клиенту ${str(payload.name)}`, { meta: { client: { id: null, email: null, cabinet: false, name: str(payload.name) }, onboarding: { id: num(payload.onboardingId) } } });
      case 'prospect_first':
      case 'prospect_followup':
      case 'prospect_reply': {
        const pr = has('pr_prospects') ? views.one<{ id: number; name: string; niche: string; city: string; telegram: string; instagram: string }>('SELECT id, name, niche, city, telegram, instagram FROM pr_prospects WHERE id = ?', Number(payload.prospectId)) : undefined;
        return generic(l, payload, `Prospector, ${PROSPECT_RU[str(payload.draftKind)] ?? 'сообщение'}: ${pr?.name ?? '?'}`, { meta: { prospect: pr ? { id: pr.id, name: pr.name, niche: pr.niche, city: pr.city, telegram: pr.telegram, instagram: pr.instagram } : { id: num(payload.prospectId) }, draftKind: str(payload.draftKind) || null } });
      }
      case 'seo_proposal':
        return generic(l, payload, `SEO: ${str(payload.title)}`, { text: { body: str(payload.change), page: str(payload.page) }, edit: null, meta: { seo: { key: str(payload.key), page: str(payload.page), needsBuilder: payload.needsBuilder === true } } });
      case 'audit': {
        const host = str(payload.host);
        return generic(l, payload, `Аудит сайта: ${host}`, { sendable: true, meta: { audit: { id: num(payload.auditId), host, locale: str(payload.locale) || 'ru' }, delivery: 'contact' } });
      }
      default:
    }
    return generic(l, payload, oneLine(stripPrefix(l.summary).split('\n')[0] ?? l.kind, 120));
  }

  // ---- versions, parents ----
  /** Review id of the item this one revises: the owner's «Правки» (task meta) or, for an article, the card of the same article before it. */
  function parentRid(l: TaskApproval, payload: Payload): string | null {
    const via = taskMetaOf(l).reviseOf;
    if (typeof via === 'string' && linkOfRid(via) !== null && hq.approvalLink(linkOfRid(via)!)) return via;
    if (l.kind === 'article') {
      const prev = db.prepare("SELECT id FROM task_approvals WHERE kind = 'article' AND id < ? AND json_extract(payload, '$.articleId') = ? ORDER BY id DESC LIMIT 1").get(l.id, Number(payload.articleId)) as { id: number } | undefined;
      return prev ? rid(prev.id) : null;
    }
    return null;
  }

  /** The cards that revise this one (newest first): «Правки» tasks, or the next card of the same article. */
  function childrenOf(l: TaskApproval, payload: Payload): { rid: string | null; task: Task | null }[] {
    const key = rid(l.id);
    const tasks = (db.prepare("SELECT id FROM tasks WHERE json_extract(meta, '$.reviseOf') = ? ORDER BY id DESC").all(key) as { id: number }[]).map((r) => hq.task(r.id)!).filter(Boolean);
    const out: { rid: string | null; task: Task | null }[] = tasks.map((t) => {
      const c = db.prepare('SELECT id FROM task_approvals WHERE task_id = ? ORDER BY id DESC LIMIT 1').get(t.id) as { id: number } | undefined;
      return { rid: c ? rid(c.id) : null, task: t };
    });
    if (l.kind === 'article') {
      const next = db.prepare("SELECT id FROM task_approvals WHERE kind = 'article' AND id > ? AND json_extract(payload, '$.articleId') = ? ORDER BY id DESC LIMIT 1").get(l.id, Number(payload.articleId)) as { id: number } | undefined;
      if (next) out.push({ rid: rid(next.id), task: null });
    }
    return out;
  }

  /** The first version's note: the owner's remark that made this item, or the analysis of the link it came from. */
  function baseNote(l: TaskApproval, part: Part): string {
    const meta = taskMetaOf(l);
    if (typeof meta.reviseNote === 'string') return `владелец: ${meta.reviseNote}`;
    if (l.kind === 'article' && typeof meta.feedback === 'string') return `владелец: ${meta.feedback}`;
    const link = part.item ? new LinkStore(db, now).byItem(part.item.id) : undefined;
    return link?.analysis ? analysisText(link.analysis, link.url) : '';
  }

  function versionsOf(l: TaskApproval, part: Part, depth = 0): ReviewVersion[] {
    const payload = payloadOf(l);
    const own = versions.list(rid(l.id));
    const created = iso(l.createdAt)!;
    const current: ReviewVersion[] = own.length > 0 ? own : [{ v: 1, createdAt: created, text: part.text, media: part.media, note: baseNote(l, part), author: 'worker' }];
    const parent = depth < 6 ? parentRid(l, payload) : null;
    if (!parent) return current;
    const pl = hq.approvalLink(linkOfRid(parent)!)!;
    const pv = versionsOf(pl, describe(pl, payloadOf(pl), baseStatus(pl)), depth + 1);
    return [...pv, ...current.map((v, i) => ({ ...v, v: pv.length + i + 1 }))];
  }

  // ---- the item ----
  function actionsOf(l: TaskApproval, status: ReviewStatus, part: Part): ReviewAction[] {
    const out: ReviewAction[] = [];
    const pending = status === 'pending';
    if (pending) out.push('approve');
    if (part.edit && (pending || (status === 'approved' && part.editApproved))) out.push('edit');
    if (pending && part.revise && d.marketing) out.push('revise');
    if (pending) out.push('reject');
    // «Выложить сейчас»: an article is published by its approval; a post, carousel or story is approved and sent in one go; a reel needs its video first
    if (d.marketing && part.publishable && !part.published && (pending || status === 'approved' || status === 'failed')) {
      if (l.kind === 'article' ? pending : part.item && (pending ? part.item.type !== 'clip' : part.item.ready)) out.push('publish_now');
    }
    if (part.item && !part.item.published && (pending || status === 'approved' || status === 'failed') && d.marketing) out.push('reschedule');
    if (pending && part.sendable) out.push('send');
    if (part.leadId !== null) out.push('call');
    return out;
  }

  function build(l: TaskApproval): Json {
    const payload = payloadOf(l);
    let status = baseStatus(l);
    const part = describe(l, payload, status);
    if (status === 'approved' && part.published) status = 'published';
    else if (status === 'approved' && part.error && part.item) status = 'failed';
    const parent = parentRid(l, payload);
    const vs = versionsOf(l, part);
    const kids = childrenOf(l, payload);
    const meta: Json = { ...part.meta };
    if (l.held) meta.heldByPack = true;
    if (kids.length > 0 && status === 'pending') {
      meta.revision = { taskId: kids[0]!.task?.id ?? null, state: kids[0]!.rid ? 'delivered' : 'working', reviewId: kids[0]!.rid };
    }
    if (l.kind === 'content_item') {
      const packRow = db.prepare("SELECT id FROM task_approvals WHERE kind = 'content_pack' AND state IN ('queued','asked') ORDER BY id DESC").all() as { id: number }[];
      for (const p of packRow) {
        const pl = hq.approvalLink(p.id);
        if (pl && Array.isArray(pl.payload.itemTaskIds) && (pl.payload.itemTaskIds as unknown[]).includes(l.taskId)) {
          meta.pack = rid(p.id);
          break;
        }
      }
    }
    return {
      id: rid(l.id), kind: l.kind, dept: l.dept, createdAt: iso(l.createdAt), status, title: part.title, summary: part.summary, media: part.media, text: part.text, meta,
      versions: vs, currentVersion: vs.at(-1)?.v ?? 1, parentId: parent, taskId: l.taskId, error: part.error, actions: status === 'rejected' || status === 'published' ? (part.leadId !== null ? ['call'] : []) : actionsOf(l, status, part),
    };
  }

  const view = (l: TaskApproval): Json => build(hq.approvalLink(l.id) ?? l);

  // ---- GET /admin/review ----
  function counts(): Record<string, number> {
    const out: Record<string, number> = Object.fromEntries(REVIEW_DEPTS.map((x) => [x, 0]));
    for (const r of pendingApprovals(db)) out[r.dept] = (out[r.dept] ?? 0) + r.n;
    return out;
  }

  function list(query: URLSearchParams): AdminReply {
    const dept = query.get('dept') ?? 'all';
    const status = query.get('status') ?? 'pending';
    if (dept !== 'all' && !(REVIEW_DEPTS as readonly string[]).includes(dept)) return fail(400, 'invalid', { hint: 'dept', allowed: ['all', ...REVIEW_DEPTS] });
    if (!['pending', 'decided', 'all'].includes(status)) return fail(400, 'invalid', { hint: 'status', allowed: ['pending', 'decided', 'all'] });
    const limRaw = query.get('limit');
    const limit = limRaw === null || limRaw === '' ? 50 : /^\d+$/.test(limRaw) ? Math.min(Math.max(Number(limRaw), 1), 200) : NaN;
    if (!Number.isFinite(limit)) return fail(400, 'invalid', { hint: 'limit' });
    const curRaw = query.get('cursor');
    if (curRaw && !/^\d+$/.test(curRaw)) return fail(400, 'invalid', { hint: 'cursor' });
    let before = curRaw ? Number(curRaw) : Number.MAX_SAFE_INTEGER;
    const items: Json[] = [];
    let lastId: number | null = null;
    let more = false;
    scan: for (;;) {
      const ids = (db.prepare(`SELECT id FROM task_approvals WHERE id < ?${dept !== 'all' ? ' AND dept = ?' : ''}${status === 'pending' ? " AND state IN ('queued','asked')" : ''} ORDER BY id DESC LIMIT 200`).all(...(dept !== 'all' ? [before, dept] : [before])) as { id: number }[]);
      if (ids.length === 0) break;
      for (const { id } of ids) {
        before = id;
        const l = hq.approvalLink(id);
        if (!l) continue;
        const st = baseStatus(l);
        if (status === 'pending' ? st !== 'pending' : status === 'decided' ? st === 'pending' : false) continue;
        if (items.length === limit) {
          more = true;
          break scan;
        }
        items.push(build(l));
        lastId = id;
      }
    }
    return ok({ items, counts: counts(), nextCursor: more && lastId !== null ? String(lastId) : null });
  }

  // ---- POST /admin/review/:id ----
  /** The new full text of a content item after the owner's edit (parts replaced, markers rebuilt); a string error for the 409 otherwise. */
  function editedContent(current: string, t: z.output<typeof textBody>): string | { error: string } {
    let next = current;
    if (t.draft !== undefined) next = t.draft.trim();
    if (t.body !== undefined) {
      const r = replacePart(next, 'script', t.body);
      if (!r) return { error: 'body: пустой текст' };
      next = r;
    }
    const caps: Partial<Record<Platform, string>> = { ...(t.captions ?? {}) };
    if (t.caption !== undefined || t.hashtags !== undefined) {
      const old = splitPlatforms(next).sections.instagram ?? '';
      const o = captionOf(old, 'instagram');
      caps.instagram = [t.caption ?? o.caption, (t.hashtags ?? o.hashtags).join(' ')].filter(Boolean).join('\n');
    }
    for (const p of PLATFORM_ORDER) {
      const v = caps[p];
      if (v === undefined) continue;
      const r = replacePart(next, p, v);
      if (!r) return { error: `captions.${p}: такой части нет в материале или текст пустой` };
      next = r;
    }
    return next.trim() ? next : { error: 'пустой текст' };
  }

  async function post(rawId: string, body: unknown): Promise<AdminReply> {
    const n = linkOfRid(rawId);
    if (n === null) return fail(404, 'not_found');
    const l = hq.approvalLink(n);
    if (!l) return fail(404, 'not_found');
    const parsed = postBody.safeParse(body ?? {});
    if (!parsed.success) return fail(400, 'invalid', { allowed: REVIEW_ACTIONS });
    const b = parsed.data;
    const current = build(l);
    const status = current.status as ReviewStatus;
    const actions = current.actions as ReviewAction[];
    const answer = () => view(l);

    // a decision already taken: asking again is a no-op, the opposite one is refused
    if (b.action === 'approve' && (status === 'approved' || status === 'published')) return ok({ item: answer() });
    if (b.action === 'reject' && status === 'rejected') return ok({ item: answer() });
    if ((b.action === 'approve' || b.action === 'reject') && status !== 'pending') return fail(409, status === 'failed' ? 'not_pending' : 'already_decided', { status });
    if (['edit', 'revise', 'send'].includes(b.action) && status !== 'pending' && !(b.action === 'edit' && status === 'approved' && actions.includes('edit'))) return fail(409, 'not_pending', { status });
    if (!actions.includes(b.action)) return fail(409, 'not_applicable', { status, actions });

    switch (b.action) {
      case 'approve':
      case 'reject':
        return decideRoute(l, b.action, b.note);
      case 'edit':
        return editRoute(l, b);
      case 'revise':
        return reviseRoute(l, b.note);
      case 'publish_now':
        return publishRoute(l, b.platform);
      case 'reschedule':
        return rescheduleRoute(l, b.slot);
      case 'send':
        return sendRoute(l, b.text?.draft);
      case 'call':
        return callRoute(l, b.slot);
      default:
        return fail(400, 'invalid', { allowed: REVIEW_ACTIONS });
    }
  }

  async function decideRoute(l: TaskApproval, action: 'approve' | 'reject', note: string | undefined): Promise<AdminReply> {
    const core = openApproval(l);
    if (core === null) return fail(409, 'not_pending', { status: baseStatus(l) });
    // a template left in the text (`[цена]`): the card stays open, the owner fills it (edit) and approves again
    const hold = action === 'approve' ? queue.notReady(core) : null;
    if (hold) {
      const open = [...new Set((typeof queue.get(core)?.payload.text === 'string' ? (queue.get(core)!.payload.text as string) : '').match(/\[[^\]\n]{2,60}\]/g) ?? [])].slice(0, 5);
      return fail(409, /Править/.test(hold) ? 'placeholder' : 'not_ready', { reason: hold, ...(open.length ? { placeholders: open } : {}) });
    }
    await d.decide(core, action);
    if (action === 'reject' && note && l.kind === 'content_item') cstore().setStatus(Number(payloadOf(l).itemId), 'rejected', note);
    if (queue.get(core)?.status === 'failed') return { status: 200, body: { ok: false, error: 'failed', status: 'failed', item: view(l) } };
    return ok({ item: view(l) });
  }

  /** `{ action: 'edit', pilot: true|false }` on a flagship's КП: the pilot block goes in or out of the КП text (the owner's switch, nothing automatic); the pack's `pilot` field follows. */
  async function pilotRoute(l: TaskApproval, b: z.output<typeof postBody>): Promise<AdminReply> {
    const payload = payloadOf(l);
    if (!PILOT_DIRECTIONS.includes(str(payload.direction))) return fail(409, 'not_applicable', { reason: 'пилот только у Персонального ИИ и ИИ-компании' });
    const next = withPilot(str(payload.kp), b.pilot === true);
    if (next.trim() === str(payload.kp).trim()) return fail(409, 'not_applied', { reason: b.pilot ? 'блок пилота уже в КП' : 'блока пилота в КП нет' });
    return editPack(l, { ...b, doc: 'kp', text: { draft: next } }, { pilot: b.pilot === true });
  }

  async function editRoute(l: TaskApproval, b: z.output<typeof postBody>): Promise<AdminReply> {
    if (l.kind === 'presales_pack' && b.pilot !== undefined && !b.text) return pilotRoute(l, b);
    if (!b.text) return fail(400, 'invalid', { hint: 'text is required' });
    if (l.kind === 'presales_pack') return editPack(l, b);
    if (baseStatus(l) === 'approved') return reviseApprovedDoc(l, b);
    const key = rid(l.id);
    const before = build(l);
    const payload = payloadOf(l);
    // the new text first: a refused edit must not touch the proposal (opening a queued one makes its approval row)
    let next: string;
    if (l.kind === 'content_item') {
      const item = cstore().item(Number(payload.itemId));
      const r = editedContent(typeof payload.text === 'string' ? payload.text : (item?.text ?? ''), b.text);
      if (typeof r !== 'string') return fail(409, 'not_applied', { reason: r.error });
      next = r;
    } else {
      const t = (b.text.draft ?? b.text.body ?? '').trim();
      if (!t) return fail(400, 'invalid', { hint: 'text.draft is required' });
      next = t;
    }
    if (next.trim() === (typeof payload.text === 'string' ? payload.text : '').trim()) return fail(409, 'not_applied', { reason: 'текст не изменился' });
    const core = openApproval(l);
    if (core === null) return fail(409, 'not_pending', { status: baseStatus(l) });
    const editor = d.director.editors.get(l.kind);
    const base = { text: before.text as Json, media: before.media as unknown[], note: baseNote(l, describe(l, payload, 'pending')), at: l.createdAt };
    // the new card the queue sends after an edit is the owner's own action: not stored, not sent; the old Telegram card shows the edited text with its buttons
    const { result } = await d.channel.capture(() => (editor?.applyEdit ? editor.applyEdit(core, next) : queue.applyEdit(core, next)));
    if (!result) return fail(409, 'not_applied', { status: queue.get(core)?.status ?? baseStatus(l) });
    await queue.settleCard(core).catch(() => false);
    const after = build(hq.approvalLink(l.id)!);
    versions.add(key, { text: after.text as Json, media: after.media as unknown[], note: b.note ? `владелец: ${b.note}` : 'владелец', author: 'owner' }, base);
    return ok({ item: view(l) });
  }

  async function reviseRoute(l: TaskApproval, note: string | undefined): Promise<AdminReply> {
    if (!note) return fail(400, 'invalid', { hint: 'revise needs a note' });
    const m = d.marketing;
    if (!m) return fail(503, 'unavailable');
    const payload = payloadOf(l);
    if (l.kind === 'article') {
      const core = openApproval(l);
      if (core === null) return fail(409, 'not_pending', { status: baseStatus(l) });
      const { result } = await d.channel.capture(() => m.reviseArticle(core, note));
      if (!result) return fail(409, 'not_applied', { status: baseStatus(l) });
      return ok({ state: 'revising', item: view(l) });
    }
    const t = m.requestRevision(Number(payload.itemId), note, rid(l.id));
    if (!t) return fail(409, 'not_applicable', { status: baseStatus(l) });
    return ok({ state: 'revising', taskId: t.taskId, item: view(l) });
  }

  async function rescheduleRoute(l: TaskApproval, slot: string | undefined): Promise<AdminReply> {
    const date = slot && /^(\d{4}-\d{2}-\d{2})(?:$|[T ])/.exec(slot)?.[1];
    if (!date || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) return fail(400, 'invalid', { hint: 'slot: YYYY-MM-DD or an ISO datetime (the day is used)' });
    if (!d.marketing?.reschedule(Number(payloadOf(l).itemId), date)) return fail(409, 'not_applicable');
    return ok({ item: view(l) });
  }

  async function callRoute(l: TaskApproval, slot: string | undefined): Promise<AdminReply> {
    if (!slot || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(slot) || Number.isNaN(Date.parse(slot))) return fail(400, 'invalid', { hint: 'slot: ISO datetime of the call' });
    const leadId = describe(l, payloadOf(l), baseStatus(l)).leadId;
    if (leadId === null) return fail(409, 'not_applicable');
    const r = await d.callLead(leadId, slot);
    if (!r || r.status !== 200) return r ?? fail(404, 'not_found');
    return ok({ callAt: (r.body.item as { callAt?: string } | undefined)?.callAt ?? null, item: view(l) });
  }

  async function sendRoute(l: TaskApproval, text: string | undefined): Promise<AdminReply> {
    const core = openApproval(l);
    if (core === null) return fail(409, 'not_pending', { status: baseStatus(l) });
    const key = rid(l.id);
    const row = queue.get(core)!;
    const before = build(l);
    let final = typeof row.payload.text === 'string' ? row.payload.text : '';
    if (text !== undefined && text.trim() && text.trim() !== final.trim()) {
      final = text.trim();
      const { result } = await d.channel.capture(() => queue.applyEdit(core, final));
      if (!result) return fail(409, 'not_applied', { status: queue.get(core)?.status ?? baseStatus(l) });
      versions.add(key, { text: { ...(before.text as Json), draft: final, body: final }, media: [], note: 'владелец', author: 'owner' }, { text: before.text as Json, media: [], note: '', at: l.createdAt });
    }
    // a draft with an unfilled placeholder («[цена]», «[решение владельца]») is not a text a client may get
    const placeholders = [...final.matchAll(/\[[^\]\n]{2,60}\]/g)].map((m) => m[0]);
    if (placeholders.length > 0 && ['lead_price', 'support_money', 'support_answer'].includes(l.kind)) return fail(409, 'placeholder', { placeholders: placeholders.slice(0, 5) });
    await d.decide(core, 'approve');
    const done = queue.get(core)?.status;
    const payload = payloadOf(l);
    const audit = l.kind === 'audit' ? new AuditStore(db, now).get(Number(payload.auditId)) : undefined;
    const via = l.kind === 'audit' ? (audit?.status === 'delivered' ? 'telegram' : 'owner') : payload.chatId !== undefined ? 'telegram' : (build(l).meta as { client?: { cabinet?: boolean } }).client?.cabinet ? 'cabinet' : 'owner';
    if (done !== 'executed') return { status: 200, body: { ok: false, error: 'not_delivered', status: baseStatus(l), via, item: view(l) } };
    return ok({ state: via === 'owner' ? 'handed_off' : 'sent', via, item: view(l) });
  }

  async function publishRoute(l: TaskApproval, platform: 'instagram' | 'tiktok' | 'shorts' | 'youtube' | undefined): Promise<AdminReply> {
    const m = d.marketing;
    if (!m) return fail(503, 'unavailable');
    // an article: the approval is the publication (HQ serves it from /blog)
    if (l.kind === 'article') {
      const core = openApproval(l);
      if (core !== null) await d.decide(core, 'approve');
      const it = view(l);
      return it.status === 'published' ? ok({ state: 'published', url: (it.meta as { url?: string }).url ?? null, item: it }) : { status: 200, body: { ok: false, error: 'publish_failed', state: 'failed', item: it } };
    }
    if (l.kind !== 'content_item') return fail(409, 'not_applicable');
    const itemId = Number(payloadOf(l).itemId);
    const s = cstore();
    let want: Platform[] | null = platform ? [platform === 'youtube' ? 'shorts' : platform] : null;
    if (baseStatus(l) === 'pending') {
      const core = openApproval(l);
      if (core === null) return fail(409, 'not_pending', { status: baseStatus(l) });
      await d.decide(core, 'approve');
      if (queue.get(core)?.status !== 'executed') return { status: 200, body: { ok: false, error: 'failed', status: 'failed', item: view(l) } };
    }
    const rows = s.rowsOfItem(itemId);
    if (rows.length === 0) return fail(409, 'not_ready', { reason: 'материал не одобрен' });
    want ??= PLATFORM_ORDER.filter((p) => rows.some((r) => r.platform === p));
    if (want.some((p) => !rows.some((r) => r.platform === p))) return fail(400, 'invalid', { allowed: rows.map((r) => r.platform) });
    const results: Json[] = [];
    for (const p of want) {
      const r = await m.publishNow(itemId, p);
      results.push({ platform: p, ...r });
    }
    const failed = results.filter((r) => r.state === 'failed');
    const notReady = results.filter((r) => r.state === 'not_ready');
    const it = view(l);
    const first = results.find((r) => r.state === 'published');
    // an explicit platform that cannot be done now is an error of the request; with all platforms, parts that cannot go are reported per platform
    if (platform && notReady.length > 0) return fail(409, 'not_ready', { reason: notReady[0]!.reason, results, item: it });
    if (platform && results[0]!.state === 'manual') return fail(409, 'not_configured', { reason: results[0]!.reason, results, item: it });
    if (failed.length > 0) return { status: 200, body: { ok: false, error: 'publish_failed', state: 'failed', message: failed[0]!.error, results, item: it } };
    const anyDone = results.some((r) => r.state === 'published' || r.state === 'queued');
    if (!anyDone) return fail(409, 'not_ready', { reason: (notReady[0] ?? results[0])?.reason ?? 'нечего публиковать', results, item: it });
    const allPublished = results.every((r) => r.state === 'published' || r.state === 'skipped');
    return ok({ state: allPublished ? 'published' : 'queued', ...(first ? { url: first.url } : {}), results, item: it });
  }

  return { list, post, counts, item: (id: string): Json | null => { const n = linkOfRid(id); const l = n === null ? undefined : hq.approvalLink(n); return l ? build(l) : null; } };
}
