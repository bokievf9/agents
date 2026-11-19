import { migrate, type Db } from '@fir/core';
import type { Draft } from './store.js';
import type { Lang } from './texts.js';

export type WebState = 'idle' | 'ask' | 'need' | 'deadline' | 'budget' | 'client_name' | 'client_question' | 'contact';

/** One website visitor's chat: state, the intake draft (until the lead exists), counters, a masked summary (no texts). */
export interface WebSession {
  id: string;
  locale: Lang;
  state: WebState;
  draft: Draft;
  /** Messages received, and LLM answers given (the per-session cap). */
  messages: number;
  llmAnswers: number;
  summary: string;
  createdAt: number;
  updatedAt: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS web_chat_sessions (
  id TEXT PRIMARY KEY,
  locale TEXT NOT NULL DEFAULT 'ru',
  state TEXT NOT NULL DEFAULT 'idle',
  data TEXT NOT NULL DEFAULT '{}',
  messages INTEGER NOT NULL DEFAULT 0,
  llm_answers INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS web_chat_sessions_updated ON web_chat_sessions (updated_at);
CREATE TABLE IF NOT EXISTS web_chat_owner_replies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  text TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS web_chat_owner_replies_session ON web_chat_owner_replies (session_id, id);
`;

interface Row {
  id: string; locale: string; state: string; data: string; messages: number; llm_answers: number; summary: string; created_at: number; updated_at: number;
}

const toSession = (r: Row): WebSession => ({
  id: r.id, locale: r.locale === 'en' ? 'en' : 'ru', state: r.state as WebState, draft: JSON.parse(r.data) as Draft,
  messages: r.messages, llmAnswers: r.llm_answers, summary: r.summary, createdAt: r.created_at, updatedAt: r.updated_at,
});

export const SESSION_TTL = 24 * 3_600_000;

export class WebSessionStore {
  constructor(private readonly db: Db, private readonly now: () => number) {
    migrate(db, SCHEMA);
  }

  /** Expired sessions (idle for 24 h) are deleted on every access. */
  sweep(): number {
    const n = this.db.prepare('DELETE FROM web_chat_sessions WHERE updated_at < ?').run(this.now() - SESSION_TTL).changes;
    this.db.prepare('DELETE FROM web_chat_owner_replies WHERE session_id NOT IN (SELECT id FROM web_chat_sessions)').run();
    return n;
  }

  /** The owner's own text for a visitor (written from the workplace): it waits for the session's next chat answer. False when the session is gone. */
  queueOwnerReply(sessionId: string, text: string): boolean {
    if (!this.get(sessionId)) return false;
    this.db.prepare('INSERT INTO web_chat_owner_replies (session_id, text, at) VALUES (?, ?, ?)').run(sessionId, text.slice(0, 2000), this.now());
    return true;
  }

  /** The waiting owner texts of a session, oldest first; they are handed over once. */
  takeOwnerReplies(sessionId: string): string[] {
    const rows = this.db.prepare('SELECT id, text FROM web_chat_owner_replies WHERE session_id = ? ORDER BY id').all(sessionId) as { id: number; text: string }[];
    if (rows.length) this.db.prepare('DELETE FROM web_chat_owner_replies WHERE session_id = ?').run(sessionId);
    return rows.map((r) => r.text);
  }

  get(id: string): WebSession | undefined {
    const r = this.db.prepare('SELECT * FROM web_chat_sessions WHERE id = ?').get(id) as Row | undefined;
    return r ? toSession(r) : undefined;
  }

  create(id: string, locale: Lang): WebSession {
    const t = this.now();
    this.db.prepare('INSERT INTO web_chat_sessions (id, locale, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, locale, t, t);
    return this.get(id)!;
  }

  update(id: string, p: Partial<Omit<WebSession, 'id' | 'createdAt' | 'updatedAt'>>): void {
    const cols: Record<string, unknown> = { updated_at: this.now() };
    if (p.locale !== undefined) cols.locale = p.locale;
    if (p.state !== undefined) cols.state = p.state;
    if (p.draft !== undefined) cols.data = JSON.stringify(p.draft);
    if (p.messages !== undefined) cols.messages = p.messages;
    if (p.llmAnswers !== undefined) cols.llm_answers = p.llmAnswers;
    if (p.summary !== undefined) cols.summary = p.summary.slice(0, 200);
    this.db.prepare(`UPDATE web_chat_sessions SET ${Object.keys(cols).map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...cols, id });
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM web_chat_sessions').get() as { n: number }).n;
  }
}
