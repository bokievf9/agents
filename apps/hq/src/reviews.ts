import { randomBytes } from 'node:crypto';
import { migrate, type Db } from '@fir/core';
import { z } from 'zod';
import { ensureCabinetTables } from './cabinet.js';

/**
 * P-16 (audit 2026-11-22): the client's review of a closed project. One per project, from the cabinet form (`POST /admin/clients/:id/reviews`); the owner lists
 * them in the Shell (`GET /admin/crm/reviews`). The request to leave one goes with the last stage's acceptance (`CabDocs.onStageAccepted`).
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS crm_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL UNIQUE,
  rating INTEGER NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL
);
`;
const body = z.object({ projectId: z.number().int().positive(), rating: z.number().int().min(1).max(5), text: z.string().trim().max(2000).default('') }).strict();
type Reply = { status: number; body: Record<string, unknown> };
const iso = (ms: number) => new Date(ms).toISOString();

export function ensureReviews(db: Db): void {
  ensureCabinetTables(db);
  migrate(db, SCHEMA);
}

/** The client's referral slug (`?ref=<slug>` on the site, `ref_<slug>` in the bot): lower-case letters and digits, unique, issued once. */
export function ensureRefSlug(db: Db, clientId: number): string {
  ensureCabinetTables(db);
  const have = (db.prepare('SELECT ref_slug FROM cab_clients WHERE id = ?').get(clientId) as { ref_slug: string | null } | undefined)?.ref_slug;
  if (have) return have;
  for (let i = 0; i < 5; i++) {
    const slug = `c${clientId.toString(36)}${randomBytes(3).toString('hex')}`;
    try {
      if (db.prepare('UPDATE cab_clients SET ref_slug = ? WHERE id = ? AND ref_slug IS NULL').run(slug, clientId).changes === 1) return slug;
    } catch {
      /* the slug is taken by somebody else: another try */
    }
    const now = (db.prepare('SELECT ref_slug FROM cab_clients WHERE id = ?').get(clientId) as { ref_slug: string | null } | undefined)?.ref_slug;
    if (now) return now;
  }
  return `c${clientId.toString(36)}`;
}

/** The project belongs to this client (through its lead)? */
function projectOf(db: Db, clientId: number, projectId: number): boolean {
  try {
    const r = db.prepare('SELECT l.client_id FROM pm_projects p JOIN li_leads l ON l.id = p.lead_id WHERE p.id = ?').get(projectId) as { client_id: number | null } | undefined;
    return r?.client_id === clientId;
  } catch {
    return false;
  }
}

/** `POST /admin/clients/:id/reviews { projectId, rating 1..5, text }`: 404 unknown client or someone else's project, 409 `exists` (one per project). */
export function addReview(db: Db, now: number, clientId: number, raw: unknown, onAdded?: (text: string) => void): Reply {
  ensureReviews(db);
  if (!db.prepare('SELECT 1 FROM cab_clients WHERE id = ?').get(clientId)) return { status: 404, body: { ok: false, error: 'not_found' } };
  const p = body.safeParse(raw ?? {});
  if (!p.success) return { status: 400, body: { ok: false, error: 'invalid' } };
  if (!projectOf(db, clientId, p.data.projectId)) return { status: 404, body: { ok: false, error: 'not_found' } };
  if (db.prepare('SELECT 1 FROM crm_reviews WHERE project_id = ?').get(p.data.projectId)) return { status: 409, body: { ok: false, error: 'exists' } };
  const id = Number(db.prepare('INSERT INTO crm_reviews (client_id, project_id, rating, text, at) VALUES (?, ?, ?, ?, ?)').run(clientId, p.data.projectId, p.data.rating, p.data.text, now).lastInsertRowid);
  onAdded?.(`Новый отзыв по проекту #${p.data.projectId}: ${p.data.rating} из 5 (Shell, отзывы).`);
  return { status: 200, body: { ok: true, item: { id, clientId, projectId: p.data.projectId, rating: p.data.rating, text: p.data.text, at: iso(now) } } };
}

/** `GET /admin/crm/reviews`: newest first. */
export function listReviews(db: Db, limit = 100): Record<string, unknown>[] {
  ensureReviews(db);
  return (db.prepare('SELECT r.*, c.name, c.email FROM crm_reviews r JOIN cab_clients c ON c.id = r.client_id ORDER BY r.id DESC LIMIT ?').all(Math.min(Math.max(limit, 1), 500)) as
    { id: number; client_id: number; project_id: number; rating: number; text: string; at: number; name: string; email: string }[])
    .map((r) => ({ id: r.id, clientId: r.client_id, client: r.name || r.email, projectId: r.project_id, rating: r.rating, text: r.text, at: iso(r.at) }));
}

export const hasReview = (db: Db, projectId: number): boolean => {
  ensureReviews(db);
  return db.prepare('SELECT 1 FROM crm_reviews WHERE project_id = ?').get(projectId) !== undefined;
};
