import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import type { Hq } from '@fir/hq';
import { RenderQueue, storeFor, type ContentStore } from '@fir/worker-content-maker';
import { z } from 'zod';
import type { AdminReply } from './admin.js';
import { fail, ok } from './shell-crm.js';
import { todayIn } from './shell-week.js';

/**
 * `POST /admin/content/purge` (docs/admin-crm-api.md, «Content Studio: чистка»): deletes Content Studio materials (items and articles), their
 * approval links, review versions, orders and rendered files. `pending` (waiting for the owner) is never deleted. `dryRun` only counts.
 */
export interface ShellContentPurgeDeps {
  hq: Hq;
  now: () => number;
  rendersDir?: string | undefined;
}

export const PURGE_STATUSES = ['draft', 'pending', 'stale', 'approved', 'rendering', 'ready', 'published', 'rejected'] as const;
type Status = (typeof PURGE_STATUSES)[number];
const purgeBody = z.object({
  before: z.string().trim().refine((v) => /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/.test(v) && !Number.isNaN(Date.parse(v)), 'ISO date').optional(),
  statuses: z.array(z.enum(PURGE_STATUSES)).max(8).optional(),
  dryRun: z.boolean().optional(),
}).strict();

export interface PurgeCounts { materials: number; orphans: number; approvals: number; reviews: number; files: number; orders: number; bytes: number }

/** Number of files and bytes under `dir` (a real directory, not a link). */
function sizeOf(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const walk = (p: string) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const f = join(p, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) {
        files++;
        bytes += lstatSync(f).size;
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

/**
 * A material the feed calls `pending` (proposed) but nobody can decide: ORPHAN, feed status `stale`. Rule: it has no open approval, that is no
 * `task_approvals` link of it in state `queued`/`asked` and no link whose core `approvals` row is `pending`/`editing` (a missing link counts as none).
 * Closed links (executed, rejected, ...) do not keep it alive.
 */
export function isOrphan(db: Hq['db'], kind: 'content_item' | 'article', id: number): boolean {
  const t = (n: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(n) !== undefined;
  if (!t('task_approvals')) return true;
  const key = kind === 'article' ? '$.articleId' : '$.itemId';
  const ls = db.prepare('SELECT state, approval_id a FROM task_approvals WHERE kind = ? AND json_extract(payload, ?) = ?').all(kind, key, id) as { state: string; a: number | null }[];
  for (const l of ls) {
    if (l.state === 'queued' || l.state === 'asked') return false;
    if (l.a !== null && t('approvals')) {
      const r = db.prepare('SELECT status FROM approvals WHERE id = ?').get(l.a) as { status: string } | undefined;
      if (r?.status === 'pending' || r?.status === 'editing') return false;
    }
  }
  return true;
}

export function createShellContentPurge(d: ShellContentPurgeDeps) {
  const { hq } = d;
  const db = hq.db;
  const store = (): ContentStore => storeFor({ db, now: d.now });
  const has = (t: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) !== undefined;
  const root = d.rendersDir;

  /** A path inside the renders folder (lexically), relative to it; null for anything else. */
  function inside(path: string): string | null {
    if (!root || path.includes('\0')) return null;
    const r = isAbsolute(path) ? relative(root, path) : path;
    return r && !r.startsWith('..') && !isAbsolute(r) && !r.split(/[\\/]/).some((s) => s === '..' || s === '') ? r : null;
  }

  function run(body: unknown): AdminReply {
    const parsed = purgeBody.safeParse(body ?? {});
    if (!parsed.success) return fail(400, 'invalid', { allowed: PURGE_STATUSES });
    const { before, dryRun } = parsed.data;
    const only = parsed.data.statuses ? new Set<Status>(parsed.data.statuses) : null;
    const cutoff = before ? todayIn(Date.parse(before), hq.tz) : null;
    const s = store();
    const hasTa = has('task_approvals');
    const openCore = (id: number | null): boolean => {
      if (id === null || !has('approvals')) return false;
      const r = db.prepare('SELECT status FROM approvals WHERE id = ?').get(id) as { status: string } | undefined;
      return r?.status === 'pending' || r?.status === 'editing';
    };
    const links = (kind: 'content_item' | 'article', key: 'itemId' | 'articleId', id: number) => (hasTa
      ? (db.prepare("SELECT id, approval_id a FROM task_approvals WHERE kind = ? AND json_extract(payload, ?) = ?").all(kind, `$.${key}`, id) as { id: number; a: number | null }[])
      : []);
    // orphans (proposed, no open approval) are swept when `statuses` is absent or lists `stale` or `pending`; live pending is never deleted
    const sweepOrphans = only === null || only.has('stale') || only.has('pending');
    const orphanIds = new Set<string>();
    const keep = (status: Status, planned: string, ls: { a: number | null }[], orphanKey: string | null) => {
      if (ls.some((l) => openCore(l.a)) || (cutoff !== null && planned >= cutoff)) return true;
      if (status === 'pending') {
        if (orphanKey === null || !sweepOrphans) return true;
        orphanIds.add(orphanKey);
        return false;
      }
      return only !== null && !only.has(status);
    };

    // ---- what goes ----
    const itemIds: number[] = [];
    for (const r of db.prepare('SELECT id FROM cm_items').all() as { id: number }[]) {
      const it = s.item(r.id);
      if (!it) continue;
      const rows = s.rowsOfItem(it.id);
      let status: Status;
      if (it.status === 'draft' || it.status === 'failed') status = 'draft';
      else if (it.status === 'proposed') status = 'pending';
      else if (it.status === 'rejected') status = 'rejected';
      else if (rows.length > 0 && rows.every((x) => x.status === 'published')) status = 'published';
      else {
        const job = it.type === 'clip' && has('cm_render_jobs') ? new RenderQueue(db, d.now).latest(it.id) : undefined;
        const rendered = rows.some((x) => x.files.length > 0) || (root !== undefined && existsSync(join(root, String(it.id), 'reel.mp4')));
        status = job && (job.status === 'queued' || job.status === 'running') && !(root !== undefined && existsSync(join(root, String(it.id), 'reel.mp4'))) ? 'rendering' : rendered ? 'ready' : 'approved';
      }
      if (!keep(status, it.plannedDate, links('content_item', 'itemId', it.id), status === 'pending' && isOrphan(db, 'content_item', it.id) ? `i${it.id}` : null)) itemIds.push(it.id);
    }
    const articleIds: number[] = [];
    for (const a of s.articles()) {
      const status: Status = a.status === 'draft' || a.status === 'failed' ? 'draft' : a.status === 'proposed' ? 'pending' : a.status === 'rejected' ? 'rejected' : a.published ? 'published' : 'approved';
      const planned = a.date ?? todayIn(a.createdAt, hq.tz);
      if (!keep(status, planned, links('article', 'articleId', a.id), status === 'pending' && isOrphan(db, 'article', a.id) ? `a${a.id}` : null)) articleIds.push(a.id);
    }

    const taIds: number[] = [];
    const coreIds: number[] = [];
    for (const [kind, key, ids] of [['content_item', 'itemId', itemIds], ['article', 'articleId', articleIds]] as const) {
      for (const id of ids) for (const l of links(kind, key, id)) {
        taIds.push(l.id);
        if (l.a !== null && !openCore(l.a)) coreIds.push(l.a);
      }
    }
    const reviewKeys = taIds.map((n) => `ap_${n}`);
    const reviewRows = has('review_versions') ? reviewKeys.reduce((n, k) => n + (db.prepare('SELECT COUNT(*) c FROM review_versions WHERE approval_id = ?').get(k) as { c: number }).c, 0) : 0;

    // orders: Studio tasks whose delivered item goes, or failed ones the filters cover (never one still working)
    const orderIds: number[] = [];
    const goneItems = new Set(itemIds);
    for (const t of db.prepare("SELECT id, created_at c FROM tasks WHERE json_extract(meta, '$.studio') IS NOT NULL").all() as { id: number; c: number }[]) {
      const card = hasTa ? (db.prepare("SELECT payload FROM task_approvals WHERE kind = 'content_item' AND (task_id = ? OR task_id IN (SELECT id FROM tasks WHERE parent_id = ?)) ORDER BY id DESC LIMIT 1").get(t.id, t.id) as { payload: string } | undefined) : undefined;
      if (card) {
        const itemId = Number((JSON.parse(card.payload) as { itemId?: unknown }).itemId);
        if (goneItems.has(itemId)) orderIds.push(t.id);
        continue;
      }
      const task = hq.task(t.id);
      if (task && (task.status === 'blocked' || task.status === 'rejected') && only === null && (cutoff === null || todayIn(t.c, hq.tz) < cutoff)) orderIds.push(t.id);
    }

    // files: the item's folder under the renders dir plus any listed file that is inside it
    const dirs: string[] = [];
    const loose: string[] = [];
    let files = 0;
    let bytes = 0;
    if (root) {
      for (const id of itemIds) {
        const dir = join(root, String(id));
        if (existsSync(dir) && lstatSync(dir).isDirectory()) {
          const z = sizeOf(dir);
          files += z.files;
          bytes += z.bytes;
          dirs.push(dir);
        }
        for (const row of s.rowsOfItem(id)) for (const f of row.files) {
          const rel = inside(f);
          if (rel && !rel.startsWith(`${id}/`) && existsSync(join(root, rel)) && lstatSync(join(root, rel)).isFile()) {
            files++;
            bytes += lstatSync(join(root, rel)).size;
            loose.push(join(root, rel));
          }
        }
      }
    }

    const counts: PurgeCounts = { materials: itemIds.length + articleIds.length, orphans: orphanIds.size, approvals: taIds.length + coreIds.length, reviews: reviewRows, files, orders: orderIds.length, bytes };
    if (dryRun) return ok({ dryRun: true, counts });

    // ---- rows in one transaction, then files ----
    db.transaction(() => {
      const each = (sql: string, ids: readonly (number | string)[]) => {
        const st = db.prepare(sql);
        for (const id of ids) st.run(id);
      };
      if (hasTa) each('DELETE FROM task_approvals WHERE id = ?', taIds);
      if (has('review_versions')) each('DELETE FROM review_versions WHERE approval_id = ?', reviewKeys);
      if (has('approval_cards')) each('DELETE FROM approval_cards WHERE approval_id = ?', coreIds);
      if (has('approvals')) each('DELETE FROM approvals WHERE id = ?', coreIds);
      for (const t of ['cm_ready', 'cm_render_jobs', 'pb_posts', 'mac_queue']) if (has(t)) each(`DELETE FROM ${t} WHERE item_id = ?`, itemIds);
      each('DELETE FROM cm_items WHERE id = ?', itemIds);
      each('DELETE FROM cm_articles WHERE id = ?', articleIds);
      for (const id of orderIds) {
        const ids = [id, ...(db.prepare('SELECT id FROM tasks WHERE parent_id = ?').all(id) as { id: number }[]).map((r) => r.id)];
        for (const tid of ids) {
          if (has('task_events')) db.prepare('DELETE FROM task_events WHERE task_id = ?').run(tid);
          db.prepare('DELETE FROM tasks WHERE id = ?').run(tid);
        }
      }
      hq.log('owner', 'content_purged', 'content', '', JSON.stringify({ ...counts, ...(before ? { before } : {}), ...(only ? { statuses: [...only] } : {}) }));
    })();
    for (const f of loose) rmSync(f, { force: true });
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    return ok({ dryRun: false, counts });
  }

  return { run };
}
