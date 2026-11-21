import { migrate, type Db } from '@fir/core';
import { lessonFromEdit, wordScore, type Lesson, type Lessons } from '@fir/fira';

/**
 * Lessons of the lead manager (Fira §5, owner 2026-11-23): the owner's corrections become text the agent sees as few-shot on a close question.
 * Table `fira_lessons` in the HQ database (question, the bad answer, the good one, a tag, the source, a unique `ref` against doubles); the same
 * columns as `lessons` of `packages/fira/sql/fira-schema.sql` for when Supabase is wired. Closeness by words for now (embeddings later).
 * Sources, harvested hourly (`harvestLessons`):
 * - the review center: a client-facing sales item (`lead_reply`, `lead_price`) the owner edited (`review_versions`: v1 the worker's text, the last
 *   owner version the good one; the question is the item's summary);
 * - the chats: the owner's answer in a client's Telegram thread (`ch_messages` with `chat_id`) after the client's own line (`ch_inbound`).
 * Texts never go to the logs.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS fira_lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  question TEXT NOT NULL,
  bad TEXT NOT NULL DEFAULT '',
  good TEXT NOT NULL,
  tag TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  ref TEXT UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS fira_lessons_agent ON fira_lessons (company_id, role_id);
`;

const MAX_PER_ROLE = 200;
const MIN_SCORE = 0.2;

interface Row { id: number; company_id: string; agent_id: string; role_id: string; question: string; bad: string; good: string; tag: string; source: string; created_at: number }
const toLesson = (r: Row): Lesson => ({
  id: String(r.id), companyId: r.company_id, agentId: r.agent_id, roleId: r.role_id, question: r.question, bad: r.bad, good: r.good,
  source: r.source as Lesson['source'], createdAt: r.created_at, ...(r.tag ? { tag: r.tag } : {}),
});

export class SqliteLessons implements Lessons {
  constructor(private readonly db: Db) {
    migrate(db, SCHEMA);
  }

  add(l: Omit<Lesson, 'id'>, ref?: string): Promise<string> {
    const r = this.db.prepare('INSERT OR IGNORE INTO fira_lessons (company_id, agent_id, role_id, question, bad, good, tag, source, ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(l.companyId, l.agentId, l.roleId, l.question, l.bad, l.good, l.tag ?? '', l.source, ref ?? null, l.createdAt);
    // the newest MAX_PER_ROLE lessons of a role are kept
    this.db.prepare('DELETE FROM fira_lessons WHERE company_id = ? AND role_id = ? AND id NOT IN (SELECT id FROM fira_lessons WHERE company_id = ? AND role_id = ? ORDER BY id DESC LIMIT ?)')
      .run(l.companyId, l.roleId, l.companyId, l.roleId, MAX_PER_ROLE);
    return Promise.resolve(String(r.lastInsertRowid));
  }

  near(companyId: string, agentId: string, roleId: string, query: string, k: number): Promise<Lesson[]> {
    const rows = this.db.prepare('SELECT * FROM fira_lessons WHERE company_id = ? AND role_id = ? AND (agent_id = ? OR agent_id = ?) ORDER BY id DESC').all(companyId, roleId, agentId, '*') as Row[];
    // the same question corrected twice: the newest answer wins
    const seen = new Set<string>();
    const scored = rows.filter((r) => (seen.has(r.question) ? false : (seen.add(r.question), true)))
      .map((r) => ({ r, s: wordScore(query, r.question) })).filter((x) => x.s >= MIN_SCORE)
      .sort((a, b) => b.s - a.s || b.r.id - a.r.id).slice(0, k);
    return Promise.resolve(scored.map((x) => toLesson(x.r)));
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) n FROM fira_lessons').get() as { n: number }).n;
  }
}

const has = (db: Db, table: string): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
const textOf = (raw: string): string => {
  try {
    const t = JSON.parse(raw) as Record<string, unknown>;
    for (const k of ['text', 'body', 'draft', 'reply', 'message']) if (typeof t[k] === 'string' && (t[k] as string).trim()) return (t[k] as string).trim();
  } catch {
    /* not JSON */
  }
  return '';
};

/** Kinds of the review center whose texts go to a client and whose corrections teach the lead manager. */
export const LESSON_KINDS = ['lead_reply', 'lead_price'] as const;
const AGENT = 'firtech/lead-manager';
const ROLE = 'lead-manager';

/** New lessons from the owner's edits and thread answers since the last run; returns how many were added. Idempotent (`ref`). */
export async function harvestLessons(db: Db, lessons: SqliteLessons, now: number): Promise<number> {
  let added = 0;
  if (has(db, 'review_versions') && has(db, 'task_approvals')) {
    const items = db.prepare(`SELECT rv.approval_id aid, a.summary summary, MAX(rv.v) last FROM review_versions rv JOIN task_approvals a ON ('ap_' || a.id) = rv.approval_id
      WHERE a.kind IN (${LESSON_KINDS.map(() => '?').join(',')}) AND rv.author = 'owner' GROUP BY rv.approval_id`).all(...LESSON_KINDS) as { aid: string; summary: string; last: number }[];
    for (const it of items) {
      const v1 = db.prepare("SELECT text FROM review_versions WHERE approval_id = ? AND author = 'worker' ORDER BY v LIMIT 1").get(it.aid) as { text: string } | undefined;
      const lastOwner = db.prepare("SELECT text, created_at FROM review_versions WHERE approval_id = ? AND author = 'owner' ORDER BY v DESC LIMIT 1").get(it.aid) as { text: string; created_at: number } | undefined;
      if (!v1 || !lastOwner) continue;
      const l = lessonFromEdit({ companyId: 'firtech', agentId: '*', roleId: ROLE, question: it.summary, before: textOf(v1.text), after: textOf(lastOwner.text), source: 'owner_review', at: lastOwner.created_at });
      if (!l) continue;
      const before = lessons.count();
      await lessons.add({ ...l, tag: 'review' }, `rv:${it.aid}:${it.last}`);
      if (lessons.count() > before) added++;
    }
  }
  if (has(db, 'ch_messages') && has(db, 'ch_inbound')) {
    const answers = db.prepare('SELECT id, chat_id, text, at FROM ch_messages WHERE chat_id IS NOT NULL ORDER BY id').all() as { id: number; chat_id: number; text: string; at: number }[];
    for (const a of answers) {
      const q = db.prepare('SELECT text FROM ch_inbound WHERE chat_id = ? AND at <= ? ORDER BY at DESC, id DESC LIMIT 1').get(a.chat_id, a.at) as { text: string } | undefined;
      if (!q?.text.trim()) continue;
      const l = lessonFromEdit({ companyId: 'firtech', agentId: AGENT, roleId: ROLE, question: q.text, before: '', after: a.text, source: 'owner_review', at: a.at });
      if (!l) continue;
      const before = lessons.count();
      await lessons.add({ ...l, tag: 'thread' }, `ch:${a.id}`);
      if (lessons.count() > before) added++;
    }
  }
  void now;
  return added;
}
