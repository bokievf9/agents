import { migrate, type Db } from '@fir/core';
import { z } from 'zod';

/**
 * Idempotency of `POST /lead` (2026-11-23): the site sends `siteLeadId` (its own lead id) and may resend the same lead after a timeout. The first answer is kept
 * for `TTL_MS`; a repeat with the same id gets that answer plus `duplicate: true` and creates nothing (no second lead, no second notice).
 * Only the id and the answer (ids and flags) are stored, never a text of the lead.
 */
export const SITE_LEAD_ID = z.string().trim().regex(/^[A-Za-z0-9_.:-]{8,64}$/);
export const DEDUPE_TTL_MS = 72 * 3_600_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS site_lead_ids (
  site_lead_id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  reply TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS site_lead_ids_at ON site_lead_ids (at);
`;

export interface LeadDedupe {
  /** The stored answer of an earlier request with this id, or null. */
  find(id: string): Record<string, unknown> | null;
  /** Keeps the answer of the first request (only an accepted lead, never an error). */
  remember(id: string, reply: Record<string, unknown>): void;
}

export function leadDedupe(db: Db, now: () => number): LeadDedupe {
  migrate(db, SCHEMA);
  return {
    find(id) {
      const t = now();
      db.prepare('DELETE FROM site_lead_ids WHERE at < ?').run(t - DEDUPE_TTL_MS);
      const row = db.prepare('SELECT reply FROM site_lead_ids WHERE site_lead_id = ?').get(id) as { reply: string } | undefined;
      if (!row) return null;
      const parsed: unknown = JSON.parse(row.reply);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    },
    remember(id, reply) {
      db.prepare('INSERT OR IGNORE INTO site_lead_ids (site_lead_id, at, reply) VALUES (?, ?, ?)').run(id, now(), JSON.stringify(reply));
    },
  };
}
