import { migrate, type Db } from '@fir/core';

export type Temperature = 'hot' | 'warm' | 'cold';
export type Lang = 'ru' | 'en';
export type Field = 'niche' | 'task' | 'deadline';

export interface Lead {
  id: number;
  source: 'telegram' | 'web';
  chatId: number | null;
  name: string;
  contact: string;
  niche: string;
  task: string;
  deadline: string;
  budget: string;
  /** Where the website form was filled (the site's `source` field), empty for Telegram. */
  origin: string;
  temperature: Temperature;
  state: 'asking' | 'card_sent';
  askField: Field | null;
  questions: number;
  lang: Lang;
  slots: number[];
  chosenSlot: number | null;
  priceAsked: boolean;
  priceApproved: boolean;
  createdAt: number;
  updatedAt: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  chat_id INTEGER,
  name TEXT NOT NULL DEFAULT '',
  contact TEXT NOT NULL DEFAULT '',
  niche TEXT NOT NULL DEFAULT '',
  task TEXT NOT NULL DEFAULT '',
  deadline TEXT NOT NULL DEFAULT '',
  budget TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL DEFAULT '',
  temperature TEXT NOT NULL DEFAULT 'cold',
  state TEXT NOT NULL,
  ask_field TEXT,
  questions INTEGER NOT NULL DEFAULT 0,
  lang TEXT NOT NULL DEFAULT 'ru',
  slots TEXT NOT NULL DEFAULT '[]',
  chosen_slot INTEGER,
  price_asked INTEGER NOT NULL DEFAULT 0,
  price_approved INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS leads_chat ON leads (chat_id);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id),
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_lead ON messages (lead_id);
`;

interface Row {
  id: number; source: string; chat_id: number | null; name: string; contact: string; niche: string; task: string;
  deadline: string; budget: string; origin: string; temperature: string; state: string; ask_field: string | null; questions: number;
  lang: string; slots: string; chosen_slot: number | null; price_asked: number; price_approved: number;
  created_at: number; updated_at: number;
}

const toLead = (r: Row): Lead => ({
  id: r.id,
  source: r.source as Lead['source'],
  chatId: r.chat_id,
  name: r.name,
  contact: r.contact,
  niche: r.niche,
  task: r.task,
  deadline: r.deadline,
  budget: r.budget,
  origin: r.origin,
  temperature: r.temperature as Temperature,
  state: r.state as Lead['state'],
  askField: r.ask_field as Field | null,
  questions: r.questions,
  lang: r.lang as Lang,
  slots: JSON.parse(r.slots) as number[],
  chosenSlot: r.chosen_slot,
  priceAsked: r.price_asked === 1,
  priceApproved: r.price_approved === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export type LeadPatch = Partial<Omit<Lead, 'id' | 'createdAt' | 'source' | 'chatId'>>;

const COLUMN: Record<string, string> = {
  askField: 'ask_field', chosenSlot: 'chosen_slot', priceAsked: 'price_asked', priceApproved: 'price_approved', updatedAt: 'updated_at',
};

export class LeadStore {
  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {
    migrate(db, SCHEMA);
    // Databases created before `origin` existed.
    if (!(db.prepare('PRAGMA table_info(leads)').all() as { name: string }[]).some((c) => c.name === 'origin')) {
      migrate(db, "ALTER TABLE leads ADD COLUMN origin TEXT NOT NULL DEFAULT ''");
    }
  }

  create(input: { source: Lead['source']; chatId: number | null; name: string; contact: string; lang: Lang; state: Lead['state'] }): Lead {
    const t = this.now();
    const r = this.db
      .prepare('INSERT INTO leads (source, chat_id, name, contact, lang, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(input.source, input.chatId, input.name, input.contact, input.lang, input.state, t, t);
    return this.get(Number(r.lastInsertRowid))!;
  }

  get(id: number): Lead | undefined {
    const r = this.db.prepare('SELECT * FROM leads WHERE id = ?').get(id) as Row | undefined;
    return r ? toLead(r) : undefined;
  }

  /** The newest lead of a Telegram chat; a chat has one running conversation. */
  byChat(chatId: number): Lead | undefined {
    const r = this.db.prepare('SELECT * FROM leads WHERE chat_id = ? ORDER BY id DESC LIMIT 1').get(chatId) as Row | undefined;
    return r ? toLead(r) : undefined;
  }

  update(id: number, patch: LeadPatch): Lead {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries({ ...patch, updatedAt: this.now() })) {
      sets.push(`${COLUMN[k] ?? k} = ?`);
      vals.push(k === 'slots' ? JSON.stringify(v) : typeof v === 'boolean' ? (v ? 1 : 0) : v);
    }
    this.db.prepare(`UPDATE leads SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    return this.get(id)!;
  }

  addMessage(leadId: number, role: 'client' | 'agent', text: string): void {
    this.db.prepare('INSERT INTO messages (lead_id, role, text, at) VALUES (?, ?, ?, ?)').run(leadId, role, text, this.now());
  }

  clientTexts(leadId: number, limit = 10): string[] {
    const rows = this.db.prepare("SELECT text FROM messages WHERE lead_id = ? AND role = 'client' ORDER BY id DESC LIMIT ?").all(leadId, limit) as { text: string }[];
    return rows.map((r) => r.text).reverse();
  }

  /** Client messages of one chat since `since` (for the anti-spam limit; all leads of the chat). */
  recentClientMessages(chatId: number, since: number): number {
    const r = this.db
      .prepare("SELECT COUNT(*) AS n FROM messages m JOIN leads l ON l.id = m.lead_id WHERE l.chat_id = ? AND m.role = 'client' AND m.at >= ?")
      .get(chatId, since) as { n: number };
    return r.n;
  }

  recent(limit = 10): Lead[] {
    return (this.db.prepare('SELECT * FROM leads ORDER BY id DESC LIMIT ?').all(limit) as Row[]).map(toLead);
  }

  staleAsking(before: number): Lead[] {
    return (this.db.prepare("SELECT * FROM leads WHERE state = 'asking' AND updated_at < ?").all(before) as Row[]).map(toLead);
  }

  withCards(): Lead[] {
    return (this.db.prepare("SELECT * FROM leads WHERE state = 'card_sent' ORDER BY id").all() as Row[]).map(toLead);
  }
}
