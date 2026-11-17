import { migrate, zonedParts, type Db } from '@fir/core';
import type { Memory } from './fsrs.js';

export interface Profile {
  language: 'zh';
  level: 'zero' | 'beginner' | 'confident';
  goal: string;
  minutesPerDay: number;
  /** "HH:mm" local time of the daily lesson reminder. */
  lessonTime: string;
  tz: string;
  streak: number;
  bestStreak: number;
  /** Local date (YYYY-MM-DD) of the last finished lesson. */
  lastLessonDate: string | null;
  /** The next lesson day to study. */
  lessonDay: number;
  placementScore: number | null;
  createdAt: number;
}

export interface Card extends Memory {
  key: string;
  kind: 'word' | 'phrase';
  h: string;
  p: string;
  r: string;
  due: number;
  lastReview: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  language TEXT NOT NULL, level TEXT NOT NULL, goal TEXT NOT NULL, minutes_per_day INTEGER NOT NULL,
  lesson_time TEXT NOT NULL, tz TEXT NOT NULL, streak INTEGER NOT NULL DEFAULT 0, best_streak INTEGER NOT NULL DEFAULT 0,
  last_lesson_date TEXT, lesson_day INTEGER NOT NULL DEFAULT 1, placement_score REAL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cards (
  key TEXT PRIMARY KEY, kind TEXT NOT NULL, h TEXT NOT NULL, p TEXT NOT NULL, r TEXT NOT NULL,
  stability REAL NOT NULL DEFAULT 0, difficulty REAL NOT NULL DEFAULT 0, reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL, last_review INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cards_due ON cards (due);
CREATE TABLE IF NOT EXISTS reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, grade INTEGER NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS lessons_done (day INTEGER NOT NULL, date TEXT NOT NULL, score INTEGER NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS touches (at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS touches_at ON touches (at);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS voice_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, file_id TEXT NOT NULL, duration INTEGER, at INTEGER NOT NULL, handled INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS talk (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL);
`;

interface ProfileRow {
  language: string; level: string; goal: string; minutes_per_day: number; lesson_time: string; tz: string; streak: number;
  best_streak: number; last_lesson_date: string | null; lesson_day: number; placement_score: number | null; created_at: number;
}
interface CardRow {
  key: string; kind: string; h: string; p: string; r: string; stability: number; difficulty: number; reps: number;
  lapses: number; due: number; last_review: number | null;
}

const toCard = (r: CardRow): Card => ({
  key: r.key, kind: r.kind as Card['kind'], h: r.h, p: r.p, r: r.r, stability: r.stability, difficulty: r.difficulty,
  reps: r.reps, lapses: r.lapses, due: r.due, lastReview: r.last_review,
});

/** Local calendar date key (YYYY-MM-DD) of an instant in a zone. */
export function dateKey(ms: number, tz: string): string {
  const p = zonedParts(ms, tz);
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** The date key `n` days after (or before) another date key. */
export function addDays(key: string, n: number): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** A pause longer than this between two taps starts a new stretch of study (the pause is not counted). */
const GAP_MS = 5 * 60_000;

/** Everything Polly remembers about the one learner (the owner). SQLite, WAL. */
export class PollyStore {
  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {
    migrate(db, SCHEMA);
  }

  // ---- profile ----
  profile(): Profile | undefined {
    const r = this.db.prepare('SELECT * FROM profile WHERE id = 1').get() as ProfileRow | undefined;
    return (
      r && {
        language: r.language as 'zh', level: r.level as Profile['level'], goal: r.goal, minutesPerDay: r.minutes_per_day,
        lessonTime: r.lesson_time, tz: r.tz, streak: r.streak, bestStreak: r.best_streak, lastLessonDate: r.last_lesson_date,
        lessonDay: r.lesson_day, placementScore: r.placement_score, createdAt: r.created_at,
      }
    );
  }

  saveProfile(p: Omit<Profile, 'createdAt'>): Profile {
    this.db
      .prepare(
        `INSERT INTO profile (id, language, level, goal, minutes_per_day, lesson_time, tz, streak, best_streak, last_lesson_date, lesson_day, placement_score, created_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET language=excluded.language, level=excluded.level, goal=excluded.goal, minutes_per_day=excluded.minutes_per_day,
           lesson_time=excluded.lesson_time, tz=excluded.tz, streak=excluded.streak, best_streak=excluded.best_streak,
           last_lesson_date=excluded.last_lesson_date, lesson_day=excluded.lesson_day, placement_score=excluded.placement_score`,
      )
      .run(p.language, p.level, p.goal, p.minutesPerDay, p.lessonTime, p.tz, p.streak, p.bestStreak, p.lastLessonDate, p.lessonDay, p.placementScore, this.now());
    return this.profile()!;
  }

  // ---- cards ----
  /** Adds a card if it is not there yet (due right now). Returns true when it is new. */
  addCard(c: { key: string; kind: Card['kind']; h: string; p: string; r: string }): boolean {
    const t = this.now();
    const res = this.db
      .prepare('INSERT OR IGNORE INTO cards (key, kind, h, p, r, due, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(c.key, c.kind, c.h, c.p, c.r, t, t);
    return res.changes === 1;
  }

  card(key: string): Card | undefined {
    const r = this.db.prepare('SELECT * FROM cards WHERE key = ?').get(key) as CardRow | undefined;
    return r && toCard(r);
  }

  dueCards(now: number, limit: number): Card[] {
    return (this.db.prepare('SELECT * FROM cards WHERE due <= ? ORDER BY due, rowid LIMIT ?').all(now, limit) as CardRow[]).map(toCard);
  }

  dueCount(now: number): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM cards WHERE due <= ?').get(now) as { n: number }).n;
  }

  nextDue(): number | null {
    const r = this.db.prepare('SELECT MIN(due) AS d FROM cards').get() as { d: number | null };
    return r.d;
  }

  cardCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM cards').get() as { n: number }).n;
  }

  saveReview(key: string, grade: number, mem: Memory, due: number): void {
    const t = this.now();
    this.db
      .prepare('UPDATE cards SET stability = ?, difficulty = ?, reps = ?, lapses = ?, due = ?, last_review = ? WHERE key = ?')
      .run(mem.stability, mem.difficulty, mem.reps, mem.lapses, due, t, key);
    this.db.prepare('INSERT INTO reviews (key, grade, at) VALUES (?, ?, ?)').run(key, grade, t);
  }

  /** Words "in the active vocabulary": reviewed at least once and now remembered for two days or more. */
  activeWords(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM cards WHERE kind = 'word' AND reps >= 1 AND stability >= 2").get() as { n: number }).n;
  }

  reviewsSince(since: number): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM reviews WHERE at >= ?').get(since) as { n: number }).n;
  }

  // ---- lessons, activity ----
  recordLesson(day: number, date: string, score: number): void {
    this.db.prepare('INSERT INTO lessons_done (day, date, score, at) VALUES (?, ?, ?, ?)').run(day, date, score, this.now());
  }

  lessonDoneOn(date: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM lessons_done WHERE date = ? LIMIT 1').get(date));
  }

  lessonsSince(since: number): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM lessons_done WHERE at >= ?').get(since) as { n: number }).n;
  }

  touch(): void {
    this.db.prepare('INSERT INTO touches (at) VALUES (?)').run(this.now());
  }

  /** Study minutes: the sum of pauses between consecutive taps that are shorter than five minutes. */
  activeMinutes(since: number, until: number): number {
    const rows = this.db.prepare('SELECT at FROM touches WHERE at >= ? AND at <= ? ORDER BY at').all(since, until) as { at: number }[];
    let ms = 0;
    for (let i = 1; i < rows.length; i++) {
      const gap = rows[i]!.at - rows[i - 1]!.at;
      if (gap <= GAP_MS) ms += gap;
    }
    return Math.round(ms / 60_000);
  }

  // ---- small state ----
  getKv(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }

  setKv(key: string, value: string): void {
    this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // ---- voice queue (stage 2 transcribes it) ----
  queueVoice(fileId: string, duration: number | null): number {
    this.db.prepare('INSERT INTO voice_queue (file_id, duration, at) VALUES (?, ?, ?)').run(fileId, duration, this.now());
    return this.voiceQueueSize();
  }

  voiceQueueSize(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM voice_queue WHERE handled = 0').get() as { n: number }).n;
  }

  // ---- free talk history ----
  addTalk(role: 'user' | 'assistant', text: string): void {
    this.db.prepare('INSERT INTO talk (role, text, at) VALUES (?, ?, ?)').run(role, text, this.now());
  }

  recentTalk(limit: number): { role: 'user' | 'assistant'; content: string }[] {
    const rows = this.db.prepare('SELECT role, text FROM talk ORDER BY id DESC LIMIT ?').all(limit) as { role: 'user' | 'assistant'; text: string }[];
    return rows.reverse().map((r) => ({ role: r.role, content: r.text }));
  }

  clearTalk(): void {
    this.db.prepare('DELETE FROM talk').run();
  }
}
