import { migrate, type Db } from '@fir/core';
import { z } from 'zod';
import type { AdminReply } from './admin.js';
import { fail, ok } from './pult-crm.js';
import { SqliteLessons } from './fira-lessons.js';

/**
 * `/admin/quality/*`: how the owner steers the quality of Fira's answers (contract `docs/briefs/fira/knowledge-quality-api.md`): the lessons (table
 * `fira_lessons`), the ratings of answers (`fira_ratings`; a bad rating with a note becomes a lesson of source `rating`) and the last run of the
 * comparison (`fira-compare` writes it into the setting `fira.eval.last`). Texts go only to the owner; logs carry ids and counts.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS fira_ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL,
  thread TEXT NOT NULL,
  value INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  lesson_id INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (message_id, thread)
);`;

export const EVAL_SETTING = 'fira.eval.last';

export interface EvalRun {
  at: string;
  runtime: 'fira' | 'legacy';
  lead: { passed: number; total: number };
  red: { passed: number; total: number };
  handoffRate: number;
  toolRate: number;
}

/** Records the last comparison run (`fira-compare` calls it with the HQ settings after every run). */
export function saveEvalRun(hq: { setSetting(k: string, v: string): void }, run: EvalRun): void {
  hq.setSetting(EVAL_SETTING, JSON.stringify(run));
}

const rateBody = z.object({
  messageId: z.union([z.string().trim().min(1).max(120), z.number().int().nonnegative()]).transform(String),
  thread: z.string().trim().min(1).max(120),
  value: z.union([z.literal(1), z.literal(-1)]),
  note: z.string().trim().max(2000).optional(),
}).strict();

interface LessonRow { id: number; question: string; bad: string; good: string; tag: string; source: string; created_at: number }
interface RatingRow { id: number; message_id: string; thread: string; value: number; note: string; created_at: number }
const iso = (ms: number): string => new Date(ms).toISOString();
const has = (db: Db, t: string): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));
const limitOf = (q: URLSearchParams): number => Math.min(500, Math.max(1, Number(q.get('limit')) || 100));

export interface PultQualityDeps {
  db: Db;
  now: () => number;
  setting: (key: string) => string;
}

export function createQualityApi(d: PultQualityDeps) {
  const { db } = d;
  migrate(db, SCHEMA);
  const lessons = new SqliteLessons(db); // creates fira_lessons when the lead manager is off

  const sourceOf = (r: LessonRow): 'review' | 'thread' | 'rating' => (r.source === 'rating' ? 'rating' : r.tag === 'thread' ? 'thread' : 'review');

  function listLessons(q: URLSearchParams): AdminReply {
    const rows = db.prepare('SELECT id, question, bad, good, tag, source, created_at FROM fira_lessons ORDER BY id DESC LIMIT ?').all(limitOf(q)) as LessonRow[];
    return ok({ items: rows.map((r) => ({ id: String(r.id), question: r.question, bad: r.bad, good: r.good, tag: r.tag, source: sourceOf(r), at: iso(r.created_at) })) });
  }

  function deleteLesson(id: string): AdminReply {
    if (!/^\d{1,9}$/.test(id)) return fail(404, 'not_found');
    const r = db.prepare('DELETE FROM fira_lessons WHERE id = ?').run(Number(id));
    return r.changes ? ok({}) : fail(404, 'not_found');
  }

  function listRatings(q: URLSearchParams): AdminReply {
    const rows = db.prepare('SELECT * FROM fira_ratings ORDER BY id DESC LIMIT ?').all(limitOf(q)) as RatingRow[];
    return ok({ items: rows.map((r) => ({ id: String(r.id), messageId: r.message_id, thread: r.thread, value: r.value, note: r.note, at: iso(r.created_at) })) });
  }

  /** Best effort: the rated answer (`ch_messages.id`) and the client's line before it, for the lesson. */
  function context(messageId: string): { question: string; bad: string } {
    if (!/^\d{1,9}$/.test(messageId) || !has(db, 'ch_messages')) return { question: '', bad: '' };
    const m = db.prepare('SELECT chat_id, text, at FROM ch_messages WHERE id = ?').get(Number(messageId)) as { chat_id: number | null; text: string; at: number } | undefined;
    if (!m) return { question: '', bad: '' };
    const q = m.chat_id !== null && has(db, 'ch_inbound')
      ? (db.prepare('SELECT text FROM ch_inbound WHERE chat_id = ? AND at <= ? ORDER BY at DESC, id DESC LIMIT 1').get(m.chat_id, m.at) as { text: string } | undefined)
      : undefined;
    return { question: q?.text ?? '', bad: m.text };
  }

  async function rate(body: unknown): Promise<AdminReply> {
    const b = rateBody.safeParse(body ?? {});
    if (!b.success) return fail(400, 'invalid');
    const { messageId, thread, value } = b.data;
    const note = b.data.note ?? '';
    const at = d.now();
    const ref = `rate:${messageId}:${thread}`;
    db.prepare('DELETE FROM fira_lessons WHERE ref = ?').run(ref); // a changed rating replaces its earlier lesson
    let lessonId: number | null = null;
    if (value === -1 && note) {
      const c = context(messageId);
      await lessons.add({ companyId: 'firtech', agentId: '*', roleId: 'lead-manager', question: (c.question || note).slice(0, 500), bad: c.bad.slice(0, 1500), good: note.slice(0, 1500), tag: 'rating', source: 'rating', createdAt: at }, ref);
      lessonId = (db.prepare('SELECT id FROM fira_lessons WHERE ref = ?').get(ref) as { id: number } | undefined)?.id ?? null;
    }
    db.prepare(`INSERT INTO fira_ratings (message_id, thread, value, note, lesson_id, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (message_id, thread) DO UPDATE SET value = excluded.value, note = excluded.note, lesson_id = excluded.lesson_id, created_at = excluded.created_at`).run(messageId, thread, value, note, lessonId, at);
    const id = (db.prepare('SELECT id FROM fira_ratings WHERE message_id = ? AND thread = ?').get(messageId, thread) as { id: number }).id;
    return ok({ id: String(id), ...(lessonId !== null ? { lessonId: String(lessonId) } : {}) });
  }

  function evalLast(): AdminReply {
    let last: EvalRun | null = null;
    try {
      const raw = d.setting(EVAL_SETTING);
      if (raw) last = JSON.parse(raw) as EvalRun;
    } catch {
      last = null;
    }
    return ok({ last });
  }

  async function handle(method: string, seg: string[], query: URLSearchParams, body: unknown): Promise<AdminReply> {
    // seg: after `quality`
    const [a, id] = seg;
    if (a === 'lessons' && seg.length === 1) return method === 'GET' ? listLessons(query) : fail(405, 'method_not_allowed');
    if (a === 'lessons' && seg.length === 2) return method === 'DELETE' ? deleteLesson(decodeURIComponent(id!)) : fail(405, 'method_not_allowed');
    if (a === 'ratings' && seg.length === 1) return method === 'GET' ? listRatings(query) : fail(405, 'method_not_allowed');
    if (a === 'rate' && seg.length === 1) return method === 'POST' ? rate(body) : fail(405, 'method_not_allowed');
    if (a === 'eval' && seg.length === 1) return method === 'GET' ? evalLast() : fail(405, 'method_not_allowed');
    return fail(404, 'not_found');
  }

  return { handle };
}
