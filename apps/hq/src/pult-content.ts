import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import type { ApprovalQueue } from '@fir/core';
import type { Hq } from '@fir/hq';
import { PublishStore, captionOf } from '@fir/worker-publisher';
import { RenderQueue, SIZES, shortReason, kitScopeOf, splitKit, splitPlatforms, storeFor, type ArticleRow, type ContentStore, type Item, type ReadyRow } from '@fir/worker-content-maker';
import { z } from 'zod';
import type { AdminReply } from './admin.js';
import type { MarketingHead } from './heads/marketing.js';
import type { OwnerChannel } from './presence.js';
import { fail, ok } from './pult-crm.js';
import { isoWeekOf, todayIn, weekRange } from './pult-week.js';

/** `GET /admin/content` and `POST /admin/content/:itemId`: the content calendar of the workplace. Contract: `docs/admin-crm-api.md` («Пульт v3»). */
export interface PultContentDeps {
  hq: Hq;
  queue: ApprovalQueue;
  channel: OwnerChannel;
  now: () => number;
  marketing?: MarketingHead | undefined;
  /** `DATA_DIR/renders`: file paths in the answer are relative to it, `GET /admin/files/<path>` serves them. */
  rendersDir?: string | undefined;
  decide: (approvalId: number, action: 'approve' | 'reject') => Promise<unknown>;
}

export const CONTENT_ACTIONS = ['approve', 'reject', 'revise', 'published', 'rerender', 'failed'] as const;
const PLATFORMS = ['instagram', 'tiktok', 'shorts'] as const;
/** `url` on `published` (and `failed` as a whole) come from the owner's Mac helper (`packages/mac-poster`): the row is marked `via = 'mac'`. */
const MAC = 'mac';
const postBody = z.object({
  action: z.enum(CONTENT_ACTIONS), note: z.string().trim().min(1).max(4000).optional(), platform: z.enum(PLATFORMS).optional(),
  url: z.string().trim().max(500).regex(/^https:\/\/[^\s]+$/).optional(),
}).strict();

type Status = 'draft' | 'pending' | 'approved' | 'rendering' | 'ready' | 'published' | 'rejected';
type Kind = 'clip' | 'post' | 'carousel' | 'story' | 'article' | 'profile';
interface FileOut { path: string; type: 'png' | 'mp4'; w: number; h: number }
interface Link { id: number; approvalId: number | null; state: string }

const KIND_OF: Record<Item['type'], Kind> = { clip: 'clip', post: 'post', carousel: 'carousel', story: 'story', profile: 'profile' };
const IMAGE_SIZE: Record<Item['type'], { width: number; height: number }> = {
  clip: SIZES.cover, post: SIZES.post, carousel: SIZES.slide, story: SIZES.story, profile: SIZES.cover,
};

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

export function createPultContent(d: PultContentDeps) {
  const { hq, now } = d;
  const db = hq.db;
  const store = (): ContentStore => storeFor({ db, now });
  const has = (t: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) !== undefined;
  const dayOf = (ms: number) => todayIn(ms, hq.tz);

  /** The approval link of a content item or an article (the newest one). */
  function linkOf(kind: 'content_item' | 'article', key: 'itemId' | 'articleId', id: number): Link | null {
    const r = db.prepare("SELECT id, approval_id a, state FROM task_approvals WHERE kind = ? AND json_extract(payload, ?) = ? ORDER BY id DESC LIMIT 1").get(kind, `$.${key}`, id) as { id: number; a: number | null; state: string } | undefined;
    return r ? { id: r.id, approvalId: r.a, state: r.state } : null;
  }

  function filesOf(item: Item, rows: ReadyRow[]): FileOut[] {
    if (!d.rendersDir) return [];
    const root = d.rendersDir;
    const out: FileOut[] = [];
    const rel = (abs: string): string | null => {
      const r = isAbsolute(abs) ? relative(root, abs) : abs;
      return r && !r.startsWith('..') && !isAbsolute(r) ? r.split('\\').join('/') : null;
    };
    for (const f of rows.flatMap((r) => r.files)) {
      const path = rel(f);
      if (!path || !existsSync(join(root, path))) continue;
      const dims = pngDims(join(root, path)) ?? { w: IMAGE_SIZE[item.type].width, h: IMAGE_SIZE[item.type].height };
      out.push({ path, type: 'png', ...dims });
    }
    if (item.type === 'clip' && existsSync(join(root, String(item.id), 'reel.mp4'))) out.push({ path: `${item.id}/reel.mp4`, type: 'mp4', w: 1080, h: 1920 });
    return out;
  }

  function igCaption(rows: ReadyRow[]): string {
    const r = rows.find((x) => x.platform === 'instagram');
    if (!r) return '';
    const { caption, hashtags } = captionOf(r.text, 'instagram');
    return [caption, hashtags.join(' ')].filter(Boolean).join('\n\n');
  }

  function itemView(item: Item) {
    const s = store();
    const rows = s.rowsOfItem(item.id);
    const files = filesOf(item, rows);
    const job = item.type === 'clip' && has('cm_render_jobs') ? new RenderQueue(db, now).latest(item.id) : undefined;
    const link = linkOf('content_item', 'itemId', item.id);
    const posts = has('pb_posts') ? (db.prepare('SELECT url, error FROM pb_posts WHERE item_id = ?').all(item.id) as { url: string | null; error: string | null }[]) : [];
    let status: Status;
    if (item.status === 'draft' || item.status === 'failed') status = 'draft';
    else if (item.status === 'proposed') status = 'pending';
    else if (item.status === 'rejected') status = 'rejected';
    else if (rows.length > 0 && rows.every((r) => r.status === 'published')) status = 'published';
    else if (job && (job.status === 'queued' || job.status === 'running') && !files.some((f) => f.type === 'mp4')) status = 'rendering';
    else status = files.length > 0 ? 'ready' : 'approved';
    const { body, sections } = splitPlatforms(rows.find((r) => r.platform === 'instagram')?.text ?? item.text);
    const cap = (p: (typeof PLATFORMS)[number]) => rows.find((r) => r.platform === p)?.text ?? sections[p] ?? (p === 'instagram' ? body : '');
    const err = job?.status === 'failed' || (job?.status === 'queued' && job.error) ? shortReason(job.error) : (posts.find((x) => x.error)?.error ?? (item.status === 'failed' ? (item.comment ?? 'не получилось') : null));
    // start kit: platform is the one the kit covers (instagram, youtube, tiktok) or `all`; `kit` holds the section texts
    const scope = item.type === 'profile' ? kitScopeOf(item.topicKey) : [];
    const kit = item.type === 'profile' ? splitKit(item.text) : undefined;
    return {
      id: item.id, kind: KIND_OF[item.type], platform: item.type === 'profile' ? (scope.length === 1 ? scope[0]! : 'all') : 'instagram', ...(kit ? { kit: { instagram: kit.instagram ?? '', youtube: kit.youtube ?? '', tiktok: kit.tiktok ?? '' } } : {}), status, title: item.title || item.topicText.slice(0, 120),
      hook: /^Хук[^:]*:\s*(.+)$/m.exec(item.text)?.[1]?.trim() ?? '',
      caption: { instagram: cap('instagram'), tiktok: cap('tiktok'), shorts: cap('shorts'), dzen: '' },
      files, sourceSlug: item.sourceSlug, approvalId: link && link.state === 'asked' ? link.approvalId : null,
      publishedUrl: posts.find((x) => x.url)?.url ?? null, error: err ? String(err).slice(0, 300) : null, plannedDate: item.plannedDate,
      // for the Mac helper: which platforms are already out, and the Instagram caption ready to paste (caption, blank line, hashtags)
      publishedOn: rows.filter((r) => r.status === 'published').map((r) => r.platform), igCaption: igCaption(rows),
    };
  }

  function articleView(a: ArticleRow) {
    const link = linkOf('article', 'articleId', a.id);
    const status: Status = a.status === 'draft' || a.status === 'failed' ? 'draft' : a.status === 'proposed' ? 'pending' : a.status === 'rejected' ? 'rejected' : a.published ? 'published' : 'approved';
    return {
      id: `a${a.id}`, kind: 'article' as const, platform: 'blog', status, title: a.title || a.niche, hook: '', caption: { instagram: '', tiktok: '', shorts: '', dzen: '' },
      files: [] as FileOut[], sourceSlug: a.slug || null, approvalId: link && link.state === 'asked' ? link.approvalId : null,
      publishedUrl: a.published && a.slug ? `/blog/${a.slug}` : null, error: a.status === 'failed' ? (a.comment ?? 'не получилось') : null, plannedDate: a.date ?? dayOf(a.createdAt),
      publishedOn: [] as string[], igCaption: '',
    };
  }

  function list(query: URLSearchParams): AdminReply {
    const week = query.get('week') || isoWeekOf(todayIn(now(), hq.tz));
    const range = weekRange(week);
    if (!range) return fail(400, 'invalid', { hint: 'week=YYYY-Www' });
    const s = store();
    const items = (db.prepare('SELECT id FROM cm_items WHERE planned_date >= ? AND planned_date <= ? ORDER BY planned_date, id').all(range.from, range.to) as { id: number }[])
      .map((r) => s.item(r.id)!).map(itemView);
    const articles = s.articles().map(articleView).filter((a) => a.plannedDate >= range.from && a.plannedDate <= range.to);
    const all = [...items, ...articles];
    const days: { date: string; items: Omit<(typeof all)[number], 'plannedDate'>[] }[] = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date(Date.parse(`${range.from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
      days.push({ date, items: all.filter((x) => x.plannedDate === date).map((x) => {
        const { plannedDate, ...rest } = x;
        void plannedDate;
        return rest;
      }) });
    }
    const n = (f: (x: { status: Status }) => boolean) => all.filter(f).length;
    return ok({
      week, days,
      summary: { pending: n((x) => x.status === 'pending'), approved: n((x) => ['approved', 'rendering', 'ready'].includes(x.status)), published: n((x) => x.status === 'published'), rendering: n((x) => x.status === 'rendering') },
    });
  }

  /** The open core approval of a link; `openQueued` makes one for a proposal that never went out as a card. null: nothing open (decided, or not asked). */
  function openApproval(link: Link | null): number | null {
    if (!link) return null;
    const id = link.approvalId ?? hq.openQueued(link.id);
    if (id === null) return null;
    const row = d.queue.get(id);
    return row && (row.status === 'pending' || row.status === 'editing') ? id : null;
  }

  async function post(rawId: string, body: unknown): Promise<AdminReply> {
    const m = /^(a)?(\d+)$/.exec(rawId);
    if (!m) return fail(404, 'not_found');
    const id = Number(m[2]);
    const isArticle = m[1] === 'a';
    const parsed = postBody.safeParse(body ?? {});
    if (!parsed.success) return fail(400, 'invalid', { allowed: CONTENT_ACTIONS });
    const { action, note, platform, url } = parsed.data;
    if (url !== undefined && action !== 'published') return fail(400, 'invalid', { hint: 'url only with published' });
    if ((url !== undefined || action === 'failed') && !platform) return fail(400, 'invalid', { hint: 'platform is required' });
    if (action === 'failed' && !note) return fail(400, 'invalid', { hint: 'failed needs a note' });
    const s = store();
    const item = isArticle ? undefined : s.item(id);
    const article = isArticle ? s.article(id) : undefined;
    if (!item && !article) return fail(404, 'not_found');
    const view = () => ok({ item: isArticle ? articleView(s.article(id)!) : itemView(s.item(id)!) });
    const status = isArticle ? articleView(article!).status : itemView(item!).status;
    const approved = ['approved', 'rendering', 'ready', 'published'].includes(status);

    if (action === 'approve' || action === 'reject') {
      // a decision already taken: asking again is a no-op (the queue claims an approval once); the opposite decision is refused
      if (action === 'approve' && approved) return view();
      if (action === 'reject' && status === 'rejected') return view();
      if (status === 'rejected' || approved) return fail(409, 'already_decided', { status });
      if (status !== 'pending') return fail(409, 'not_pending', { status });
      const link = isArticle ? linkOf('article', 'articleId', id) : linkOf('content_item', 'itemId', id);
      const core = openApproval(link);
      if (core === null) return fail(409, 'not_pending', { status });
      await d.decide(core, action);
      if (action === 'reject' && note && item) s.setStatus(id, 'rejected', note);
      return view();
    }
    if (!d.marketing) return fail(503, 'unavailable');
    if (action === 'revise') {
      if (!note) return fail(400, 'invalid', { hint: 'revise needs a note' });
      if (status !== 'pending') return fail(409, 'not_pending', { status });
      const core = openApproval(isArticle ? linkOf('article', 'articleId', id) : linkOf('content_item', 'itemId', id));
      if (core === null) return fail(409, 'not_pending', { status });
      const marketing = d.marketing;
      // an article: the owner's remark, the article is written again. An item: his text replaces one part (a platform's caption, else the script), the card is asked again
      const { result: applied } = await d.channel.capture(() => (isArticle ? marketing.reviseArticle(core, note) : marketing.applyEdit(core, note, platform ?? 'script')));
      if (!applied) return fail(409, 'not_applied', { status });
      return view();
    }
    if (isArticle) return fail(409, 'not_applicable', { status });
    if (action === 'published') {
      const rows = s.rowsOfItem(id);
      if (!approved || rows.length === 0) return fail(409, 'not_ready', { status });
      const mine = platform ? rows.filter((r) => r.platform === platform) : rows;
      if (mine.length === 0) return fail(400, 'invalid', { allowed: rows.map((r) => r.platform) });
      for (const r of mine) if (r.status === 'ready') d.marketing.onPublished(r.id, url ? 'mac-poster' : 'owner');
      if (url) {
        const pstore = new PublishStore(db);
        for (const r of mine) if (pstore.recordExternal(r.id, id, r.platform, MAC, now(), { url })) hq.log('mac-poster', 'published_url', 'content_ready', String(r.id), url);
      }
      return view();
    }
    if (action === 'failed') {
      // the Mac helper could not post: the row stays ready (the Telegram card remains manual), the reason shows as `error`
      const rows = s.rowsOfItem(id);
      if (!approved || rows.length === 0) return fail(409, 'not_ready', { status });
      const mine = rows.filter((r) => r.platform === platform);
      if (mine.length === 0) return fail(400, 'invalid', { allowed: rows.map((r) => r.platform) });
      const pstore = new PublishStore(db);
      const reason = note!.slice(0, 300);
      for (const r of mine) if (r.status === 'ready' && pstore.recordExternal(r.id, id, r.platform, MAC, now(), { error: reason })) hq.log('mac-poster', 'publish_failed', 'content_ready', String(r.id), reason);
      return view();
    }
    // rerender
    const r = await d.marketing.rerenderItem(id);
    if (!r.ok) return fail(409, 'cannot_rerender', { reason: r.note });
    return view();
  }

  return { list, post };
}
