import { migrate, type Db } from '@fir/core';
import { z } from 'zod';

/** A site URL a visitor may ask us to audit: http(s), max 200 chars, a hostname with a dot, never an IP literal or a local name. */
export function auditHost(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (!host.includes('.') || host.startsWith('[') || /^\d+(\.\d+){3}$/.test(host) || /\.(local|internal|localhost|lan|home)$/.test(host)) return null;
  if (!/^[\p{L}\p{N}.-]+$/u.test(host)) return null;
  return host;
}

const TG = /^@[A-Za-z][A-Za-z0-9_]{2,31}$/;
const PHONE = /^\+?[\d\s().-]{7,25}$/;

/** `POST /audit` body (and the client bot's `/audit`, with `tg:<chatId>` as contact when the person has no username). */
export const auditInputSchema = z.object({
  url: z.string().trim().max(200).refine((v) => auditHost(v) !== null, 'bad url'),
  contact: z.string().trim().min(3).max(64).refine((v) => TG.test(v) || /^tg:\d{1,15}$/.test(v) || (PHONE.test(v) && v.replace(/\D/g, '').length >= 7 && v.replace(/\D/g, '').length <= 15), 'bad contact'),
  name: z.string().trim().max(80).optional(),
  locale: z.enum(['ru', 'en']),
  ref: z.string().trim().regex(/^[A-Za-z0-9_:.-]{1,40}$/).optional(),
});
export type AuditInput = z.output<typeof auditInputSchema>;
export type AuditOutcome = 'ok' | 'duplicate' | 'rate_limited' | 'invalid';

export type AuditStatus = 'queued' | 'proposed' | 'delivered' | 'handed_off' | 'failed' | 'rejected';

export interface AuditRow {
  id: number;
  url: string;
  contact: string;
  name: string;
  locale: 'ru' | 'en';
  ref: string;
  chatId: number | null;
  status: AuditStatus;
  created: number;
  delivered: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mk_audits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,
  contact TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  locale TEXT NOT NULL DEFAULT 'ru',
  ref TEXT NOT NULL DEFAULT '',
  chat_id INTEGER,
  status TEXT NOT NULL DEFAULT 'queued',
  created INTEGER NOT NULL,
  delivered INTEGER
);
CREATE INDEX IF NOT EXISTS mk_audits_contact ON mk_audits (contact, created);
`;

interface R {
  id: number; url: string; contact: string; name: string; locale: string; ref: string; chat_id: number | null; status: string; created: number; delivered: number | null;
}
const toRow = (r: R): AuditRow => ({
  id: r.id, url: r.url, contact: r.contact, name: r.name, locale: r.locale === 'en' ? 'en' : 'ru', ref: r.ref, chatId: r.chat_id,
  status: r.status as AuditStatus, created: r.created, delivered: r.delivered,
});

export const normContact = (c: string): string => c.trim().toLowerCase().replace(/[\s().-]/g, '');

export class AuditStore {
  constructor(private readonly db: Db, private readonly now: () => number) {
    migrate(db, SCHEMA);
  }

  add(a: AuditInput & { chatId?: number }): number {
    const r = this.db
      .prepare('INSERT INTO mk_audits (url, contact, name, locale, ref, chat_id, created) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(a.url, normContact(a.contact), a.name ?? '', a.locale, a.ref ?? '', a.chatId ?? null, this.now());
    return Number(r.lastInsertRowid);
  }

  get(id: number): AuditRow | undefined {
    const r = this.db.prepare('SELECT * FROM mk_audits WHERE id = ?').get(id) as R | undefined;
    return r ? toRow(r) : undefined;
  }

  /** Whether this contact already asked in the last 24 hours. */
  recentFor(contact: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM mk_audits WHERE contact = ? AND created >= ?').get(normContact(contact), this.now() - 86_400_000));
  }

  setStatus(id: number, status: AuditStatus): void {
    this.db.prepare('UPDATE mk_audits SET status = ?, delivered = CASE WHEN ? IN (\'delivered\', \'handed_off\') THEN ? ELSE delivered END WHERE id = ?').run(status, status, this.now(), id);
  }
}

/** In-memory: at most `perHour` audits an hour for everyone (the per-contact rule lives in the store, so it survives restarts). */
export class AuditGate {
  private readonly hits: number[] = [];

  constructor(private readonly now: () => number, private readonly perHour = 20) {}

  take(): boolean {
    const t = this.now();
    while (this.hits.length && this.hits[0]! < t - 3_600_000) this.hits.shift();
    if (this.hits.length >= this.perHour) return false;
    this.hits.push(t);
    return true;
  }
}

/** The one path of a new audit request, shared by `POST /audit` and the client bot: per-contact 24 h, 20 an hour overall. */
export function submitAudit(
  d: { store: AuditStore; gate: AuditGate; create: (a: AuditInput & { chatId?: number }) => unknown },
  a: AuditInput & { chatId?: number },
): AuditOutcome {
  if (d.store.recentFor(a.contact)) return 'duplicate';
  if (!d.gate.take()) return 'rate_limited';
  d.create(a);
  return 'ok';
}
