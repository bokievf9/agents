import type { Db } from '@fir/core';
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const RENDER_KEEP_DAYS = 14;

/**
 * Deletes `renders/<item id>` folders nobody needs any more: items rejected, or published on every platform, more than
 * `keepDays` ago (the folder's age stands for the decision time of a rejected item, the last `published_at` for a published
 * one), and folders of items that no longer exist. Approved but unpublished items keep their files (the owner still posts
 * them). Returns the item ids removed.
 */
export function cleanRenders(o: { db: Db; rendersDir: string; now: number; keepDays?: number }): number[] {
  if (!existsSync(o.rendersDir)) return [];
  const cutoff = o.now - (o.keepDays ?? RENDER_KEEP_DAYS) * 86_400_000;
  const removed: number[] = [];
  for (const name of readdirSync(o.rendersDir)) {
    const id = Number(name);
    const dir = join(o.rendersDir, name);
    if (!Number.isInteger(id) || id <= 0 || !statSync(dir).isDirectory()) continue;
    const item = o.db.prepare('SELECT status FROM cm_items WHERE id = ?').get(id) as { status: string } | undefined;
    let drop = false;
    if (!item) drop = statSync(dir).mtimeMs < cutoff;
    else if (item.status === 'rejected') drop = statSync(dir).mtimeMs < cutoff;
    else if (item.status === 'ready') {
      const r = o.db
        .prepare(
          `SELECT COUNT(*) total, SUM(CASE WHEN p.published_at IS NOT NULL THEN 1 ELSE 0 END) done, MAX(p.published_at) last
           FROM cm_ready r LEFT JOIN pb_posts p ON p.ready_id = r.id WHERE r.item_id = ?`,
        )
        .get(id) as { total: number; done: number | null; last: number | null };
      drop = r.total > 0 && r.done === r.total && (r.last ?? Infinity) < cutoff;
    }
    if (drop) {
      rmSync(dir, { recursive: true, force: true });
      removed.push(id);
    }
  }
  return removed;
}
