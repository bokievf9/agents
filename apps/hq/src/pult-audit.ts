import { errMsg, log, zonedToMs, type Db } from '@fir/core';
import type { Hq } from '@fir/hq';
import type { AdminReply } from './admin.js';
import { fail, ok } from './pult-crm.js';

/**
 * `GET /admin/audit?kind&actor&from&to&cursor&limit`: one read-only journal of changes and decisions for the HQ «Audit log» section.
 * It merges what HQ already records: approval decisions (`decisions`, and the task approvals of `activity`), settings (`settings_log`),
 * agent instructions (`instruction_versions`), trust level changes (`settings_log` `trust.*` and `activity` `level_set`) and other
 * owner actions (`activity` of the actor `owner`). Only ids, kinds, actors and counters leave: never an instruction text, a settings value
 * (old/new), a client's text or a contact. A table that does not exist yet is an empty source. Contract: `docs/admin-crm-api.md`, «Audit log».
 */
export const AUDIT_KINDS = ['decision', 'setting', 'instruction', 'trust', 'owner'] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DAY = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface AuditEntry {
  id: string;
  kind: AuditKind;
  at: string;
  actor: string;
  action: string;
  objectType: string;
  objectId: string;
  /** A short word or id (a decision, `v3`, a level): never a text. */
  detail: string;
}

interface Source {
  key: string;
  kind: AuditKind;
  /** The tie-break rank of the source for entries of the same millisecond. */
  rank: number;
  from: string;
  where: string;
  at: string;
  actor: string;
  action: string;
  objectType: string;
  objectId: string;
  detail: string;
}

const OWNER_OTHER = "agent_id = 'owner' AND action NOT IN ('approval_decided', 'level_set', 'settings_changed', 'instructions_changed')";
const SOURCES: Source[] = [
  {
    key: 'dec', kind: 'decision', rank: 0, from: 'decisions', where: '1', at: 'at',
    actor: "CASE WHEN decision IN ('auto', 'auto_failed') THEN 'system' ELSE 'owner' END", action: "'decision'", objectType: "'approval'", objectId: "COALESCE(CAST(approval_id AS TEXT), '')", detail: "kind || ' ' || decision",
  },
  {
    key: 'tap', kind: 'decision', rank: 1, from: 'activity', where: "action = 'approval_decided'", at: 'at',
    actor: "COALESCE(agent_id, 'system')", action: "'approval_decided'", objectType: "COALESCE(object_type, 'task')", objectId: "COALESCE(object_id, '')", detail: "COALESCE(detail, '')",
  },
  {
    key: 'set', kind: 'setting', rank: 2, from: 'settings_log', where: "key NOT LIKE 'trust.%'", at: 'at',
    actor: 'source', action: "'setting_changed'", objectType: "'setting'", objectId: 'key', detail: "''",
  },
  {
    key: 'trs', kind: 'trust', rank: 3, from: 'settings_log', where: "key LIKE 'trust.%'", at: 'at',
    actor: 'source', action: "'trust_changed'", objectType: "'setting'", objectId: 'key', detail: "''",
  },
  {
    key: 'tra', kind: 'trust', rank: 4, from: 'activity', where: "action = 'level_set'", at: 'at',
    actor: "COALESCE(agent_id, 'system')", action: "'level_set'", objectType: "COALESCE(object_type, '')", objectId: "COALESCE(object_id, '')", detail: "COALESCE(detail, '')",
  },
  {
    key: 'ins', kind: 'instruction', rank: 5, from: 'instruction_versions', where: '1', at: 'at',
    actor: 'actor', action: "'instructions_changed'", objectType: "'agent'", objectId: 'agent_id', detail: "'v' || version",
  },
  {
    key: 'own', kind: 'owner', rank: 6, from: 'activity', where: OWNER_OTHER, at: 'at',
    actor: "COALESCE(agent_id, 'system')", action: 'action', objectType: "COALESCE(object_type, '')", objectId: "COALESCE(object_id, '')", detail: "COALESCE(detail, '')",
  },
];

const clip = (s: string, n = 80) => {
  const one = String(s).replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

export function createAudit(d: { hq: Hq; db: Db }) {
  const { hq, db } = d;

  function all<T>(sql: string, args: unknown[]): T[] {
    try {
      return db.prepare(sql).all(...args) as T[];
    } catch (e) {
      if (!/no such (table|column)/i.test(errMsg(e))) log('warn', 'audit source failed', { err: errMsg(e) });
      return [];
    }
  }

  function dayStart(date: string): number {
    const [y, m, dd] = date.split('-').map(Number) as [number, number, number];
    return zonedToMs(y, m, dd, 0, 0, hq.tz);
  }

  function get(query: URLSearchParams): AdminReply {
    const kind = query.get('kind') || '';
    if (kind && !(AUDIT_KINDS as readonly string[]).includes(kind)) return fail(400, 'invalid', { hint: 'kind', kinds: AUDIT_KINDS });
    const actor = query.get('actor') || '';
    if (actor.length > 64) return fail(400, 'invalid', { hint: 'actor' });
    const from = query.get('from') || '';
    const to = query.get('to') || '';
    if ((from && !DATE.test(from)) || (to && !DATE.test(to))) return fail(400, 'invalid', { hint: 'from=YYYY-MM-DD&to=YYYY-MM-DD' });
    const fromMs = from ? dayStart(from) : null;
    const toMs = to ? dayStart(to) + DAY : null; // exclusive, inclusive date
    if ((fromMs !== null && Number.isNaN(fromMs)) || (toMs !== null && Number.isNaN(toMs))) return fail(400, 'invalid', { hint: 'date' });
    if (fromMs !== null && toMs !== null && toMs <= fromMs) return fail(400, 'invalid', { hint: 'to is before from' });
    const limRaw = query.get('limit');
    const limit = limRaw === null || limRaw === '' ? DEFAULT_LIMIT : /^\d+$/.test(limRaw) ? Math.min(Math.max(Number(limRaw), 1), MAX_LIMIT) : NaN;
    if (!Number.isFinite(limit)) return fail(400, 'invalid', { hint: 'limit' });
    const curRaw = query.get('cursor') || '';
    const cm = curRaw ? /^(\d{1,15})_(\d)_(\d{1,15})$/.exec(curRaw) : null;
    if (curRaw && !cm) return fail(400, 'invalid', { hint: 'cursor' });
    const cursor = cm ? { at: Number(cm[1]), rank: Number(cm[2]), id: Number(cm[3]) } : null;

    const base = (s: Source): { sql: string; args: unknown[] } => {
      const parts = [s.where];
      const args: unknown[] = [];
      if (fromMs !== null) { parts.push(`${s.at} >= ?`); args.push(fromMs); }
      if (toMs !== null) { parts.push(`${s.at} < ?`); args.push(toMs); }
      if (actor) { parts.push(`(${s.actor}) = ?`); args.push(actor); }
      return { sql: parts.join(' AND '), args };
    };

    // counters per kind: the date and the actor filters, not the kind and the cursor
    const counts = Object.fromEntries(AUDIT_KINDS.map((k) => [k, 0])) as Record<AuditKind, number>;
    for (const s of SOURCES) {
      const b = base(s);
      counts[s.kind] += all<{ n: number }>(`SELECT COUNT(*) n FROM ${s.from} WHERE ${b.sql}`, b.args)[0]?.n ?? 0;
    }
    const actors = new Set<string>();
    for (const s of SOURCES) {
      const parts = [s.where];
      const args: unknown[] = [];
      if (fromMs !== null) { parts.push(`${s.at} >= ?`); args.push(fromMs); }
      if (toMs !== null) { parts.push(`${s.at} < ?`); args.push(toMs); }
      for (const r of all<{ a: string }>(`SELECT DISTINCT ${s.actor} a FROM ${s.from} WHERE ${parts.join(' AND ')} LIMIT 50`, args)) if (r.a) actors.add(String(r.a).slice(0, 64));
    }

    const entries: (AuditEntry & { _at: number; _rank: number; _n: number })[] = [];
    for (const s of SOURCES) {
      if (kind && s.kind !== kind) continue;
      const b = base(s);
      let sql = b.sql;
      const args = [...b.args];
      if (cursor) {
        // strictly after the cursor in (at desc, rank asc, id desc) order
        if (s.rank > cursor.rank) { sql += ` AND ${s.at} <= ?`; args.push(cursor.at); }
        else if (s.rank === cursor.rank) { sql += ` AND (${s.at} < ? OR (${s.at} = ? AND id < ?))`; args.push(cursor.at, cursor.at, cursor.id); }
        else { sql += ` AND ${s.at} < ?`; args.push(cursor.at); }
      }
      const rows = all<{ id: number; at: number; actor: string; action: string; otype: string; oid: string; detail: string }>(
        `SELECT id, ${s.at} at, (${s.actor}) actor, ${s.action} action, (${s.objectType}) otype, (${s.objectId}) oid, (${s.detail}) detail
         FROM ${s.from} WHERE ${sql} ORDER BY ${s.at} DESC, id DESC LIMIT ?`,
        [...args, limit + 1],
      );
      for (const r of rows) {
        entries.push({
          id: `${s.key}:${r.id}`, kind: s.kind, at: new Date(r.at).toISOString(), actor: clip(String(r.actor), 64), action: clip(String(r.action), 64),
          objectType: clip(String(r.otype), 32), objectId: clip(String(r.oid), 64), detail: clip(String(r.detail)), _at: r.at, _rank: s.rank, _n: r.id,
        });
      }
    }
    entries.sort((a, b) => b._at - a._at || a._rank - b._rank || b._n - a._n);
    const page = entries.slice(0, limit);
    const last = page.at(-1);
    const nextCursor = entries.length > limit && last ? `${last._at}_${last._rank}_${last._n}` : null;
    return ok({
      tz: hq.tz, kinds: AUDIT_KINDS, counts, total: Object.values(counts).reduce((a, b) => a + b, 0), actors: [...actors].sort(), nextCursor,
      entries: page.map(({ _at, _rank, _n, ...e }) => { void _at; void _rank; void _n; return e; }),
    });
  }

  return { get };
}
