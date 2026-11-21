import { createHash } from 'node:crypto';
import { migrate, type Db } from '@fir/core';
import type { QState } from './receptionist.js';
import type { Budget, Deadline, Have, Lang, Need } from './texts.js';

export type ChatState = 'idle' | 'need' | 'need_text' | 'deadline' | 'budget' | 'hosting' | 'client_name' | 'client_question';

/**
 * The intake in progress. Free-text answers live here only until the lead or ticket is created (then the record holds
 * them, as the website form does) and the draft is cleared.
 */
export interface Draft {
  need?: Need;
  needText?: string;
  deadline?: Deadline;
  deadlineText?: string;
  budget?: Budget;
  budgetText?: string;
  /** Step 4: the client's own domain and hosting. */
  have?: Have;
  /** «Я уже клиент»: the client name found in Support or billing, or null when not found. */
  client?: string | null;
  clientQuery?: string;
  /** Web chat: the client's question, kept until the contact step creates the ticket or lead. */
  question?: string;
  /** Web chat: the page the visitor wrote from. */
  page?: string;
  /** Web chat: what the contact step finishes. */
  pending?: 'intake' | 'client' | 'handoff';
  /** ИИ-менеджер заявок 2.0: what the receptionist knows about the conversation (qualification, offers, intent). */
  q?: QState;
  /** Web chat: the signed-in cabinet account the visitor wrote from (email, id and name come from the site). */
  identity?: { email: string; cabinetId?: string; name?: string };
  /** Where the intake started (the demo salon sets `demo_salon`): becomes the lead's `source`. */
  source?: string;
}

/** Per chat only: id, username, language, state, last activity and a short masked summary (no message texts). */
export interface Chat {
  chatId: number;
  username: string;
  lang: Lang;
  state: ChatState;
  draft: Draft;
  /** The message whose keyboard is live (the welcome or the intake card). */
  card: number | null;
  muted: boolean;
  blocked: boolean;
  summary: string;
  /** The first name Telegram gave (empty when none): the reminder of the HQ bot names the client by it. */
  name: string;
  /** The Sales task of the last lead from this chat (call slot picks refer to it). */
  leadTask: number | null;
  lastHash: string;
  repeats: number;
  createdAt: number;
  lastAt: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cb_chats (
  chat_id INTEGER PRIMARY KEY,
  username TEXT NOT NULL DEFAULT '',
  lang TEXT NOT NULL DEFAULT 'ru',
  state TEXT NOT NULL DEFAULT 'idle',
  draft TEXT NOT NULL DEFAULT '{}',
  card INTEGER,
  muted INTEGER NOT NULL DEFAULT 0,
  blocked INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  lead_task INTEGER,
  last_hash TEXT NOT NULL DEFAULT '',
  repeats INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cb_chats_last ON cb_chats (last_at);
`;

interface Row {
  chat_id: number; username: string; lang: string; state: string; draft: string; card: number | null; muted: number; blocked: number;
  summary: string; name: string; lead_task: number | null; last_hash: string; repeats: number; created_at: number; last_at: number;
}

const toChat = (r: Row): Chat => ({
  chatId: r.chat_id, username: r.username, lang: r.lang === 'en' ? 'en' : 'ru', state: r.state as ChatState, draft: JSON.parse(r.draft) as Draft,
  card: r.card, muted: r.muted === 1, blocked: r.blocked === 1, summary: r.summary, name: r.name, leadTask: r.lead_task, lastHash: r.last_hash,
  repeats: r.repeats, createdAt: r.created_at, lastAt: r.last_at,
});

/** Short hash of a message, only to spot the same text sent again (the text itself is never stored). */
export const textHash = (s: string): string => createHash('sha256').update(s.trim().toLowerCase()).digest('hex').slice(0, 16);

/** `@ab***` for lists the owner reads. */
export const maskUsername = (u: string): string => (u ? `@${u.slice(0, 2)}***` : 'без username');

export class ChatStore {
  constructor(private readonly db: Db, private readonly now: () => number) {
    migrate(db, SCHEMA);
    // chats of a database made before the name column
    if (!(db.prepare('PRAGMA table_info(cb_chats)').all() as { name: string }[]).some((c) => c.name === 'name')) db.exec("ALTER TABLE cb_chats ADD COLUMN name TEXT NOT NULL DEFAULT ''");
  }

  get(chatId: number): Chat | undefined {
    const r = this.db.prepare('SELECT * FROM cb_chats WHERE chat_id = ?').get(chatId) as Row | undefined;
    return r ? toChat(r) : undefined;
  }

  /** The chat, created on first contact; username and activity refreshed, a blocked flag cleared (they wrote again). */
  touch(chatId: number, username: string, lang: Lang, name = ''): Chat {
    const t = this.now();
    this.db
      .prepare(
        `INSERT INTO cb_chats (chat_id, username, lang, name, created_at, last_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(chat_id) DO UPDATE SET username = excluded.username, name = CASE WHEN excluded.name != '' THEN excluded.name ELSE cb_chats.name END, last_at = excluded.last_at, blocked = 0`,
      )
      .run(chatId, username.slice(0, 40), lang, name.slice(0, 40), t, t);
    return this.get(chatId)!;
  }

  update(chatId: number, p: Partial<Omit<Chat, 'chatId' | 'createdAt'>>): void {
    const cols: Record<string, unknown> = {};
    if (p.username !== undefined) cols.username = p.username;
    if (p.lang !== undefined) cols.lang = p.lang;
    if (p.state !== undefined) cols.state = p.state;
    if (p.draft !== undefined) cols.draft = JSON.stringify(p.draft);
    if (p.card !== undefined) cols.card = p.card;
    if (p.muted !== undefined) cols.muted = p.muted ? 1 : 0;
    if (p.blocked !== undefined) cols.blocked = p.blocked ? 1 : 0;
    if (p.name !== undefined) cols.name = p.name.slice(0, 40);
    if (p.summary !== undefined) cols.summary = p.summary.slice(0, 200);
    if (p.leadTask !== undefined) cols.lead_task = p.leadTask;
    if (p.lastHash !== undefined) cols.last_hash = p.lastHash;
    if (p.repeats !== undefined) cols.repeats = p.repeats;
    if (p.lastAt !== undefined) cols.last_at = p.lastAt;
    const keys = Object.keys(cols);
    if (!keys.length) return;
    this.db.prepare(`UPDATE cb_chats SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE chat_id = @chatId`).run({ ...cols, chatId });
  }

  /** The chat of a Telegram username (case-insensitive), when that person wrote to the bot and did not block it. */
  chatIdByUsername(username: string): number | undefined {
    const u = username.replace(/^@/, '').trim();
    if (!u) return undefined;
    return (this.db.prepare('SELECT chat_id FROM cb_chats WHERE lower(username) = lower(?) AND blocked = 0 ORDER BY last_at DESC LIMIT 1').get(u) as { chat_id: number } | undefined)?.chat_id;
  }

  recent(limit = 15): Chat[] {
    return (this.db.prepare('SELECT * FROM cb_chats ORDER BY last_at DESC LIMIT ?').all(limit) as Row[]).map(toChat);
  }

  /** When any person last wrote to the bot (the latest `last_at`), null when nobody ever did. */
  lastActivity(): number | null {
    return (this.db.prepare('SELECT MAX(last_at) AS t FROM cb_chats').get() as { t: number | null }).t;
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM cb_chats').get() as { n: number }).n;
  }
}

/** The referral slug a person arrived with: `?start=ref_<slug>` in the bot, `ref` in the website chat. */
export const REF_SLUG = /^[a-z0-9_-]{1,32}$/;

/** A valid slug in canonical (lower-case) form, or null. */
export function parseRefSlug(raw: string | undefined): string | null {
  const s = (raw ?? '').trim().toLowerCase();
  return REF_SLUG.test(s) ? s : null;
}

/** The slug of a Telegram `/start` payload `ref_<slug>`, or null for any other payload. */
export function refFromStartArg(arg: string): string | null {
  const m = /^ref_(.+)$/i.exec(arg.trim());
  return m ? parseRefSlug(m[1]) : null;
}

const REF_SCHEMA = `
CREATE TABLE IF NOT EXISTS cb_refs (
  who TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  at INTEGER NOT NULL
);
`;

/**
 * Who brought a person: kept per chat (`tg:<chatId>`) or website session (`web:<sessionId>`) apart from the intake
 * draft, which is wiped often. The first referrer wins; the lead made later carries `origin: ref:<slug>`. 30 days.
 */
export class RefStore {
  constructor(private readonly db: Db, private readonly now: () => number) {
    migrate(db, REF_SCHEMA);
  }

  /** Remembers the slug unless the person already has one. Returns whether it was stored. */
  set(who: string, slug: string): boolean {
    this.db.prepare('DELETE FROM cb_refs WHERE at < ?').run(this.now() - 30 * 86_400_000);
    return this.db.prepare('INSERT OR IGNORE INTO cb_refs (who, slug, at) VALUES (?, ?, ?)').run(who, slug, this.now()).changes === 1;
  }

  get(who: string): string | null {
    return (this.db.prepare('SELECT slug FROM cb_refs WHERE who = ?').get(who) as { slug: string } | undefined)?.slug ?? null;
  }
}
