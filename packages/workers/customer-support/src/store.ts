import { migrate, type Db } from '@fir/core';

export interface CsClient {
  id: number;
  name: string;
  /** As the owner entered it (a @username, a phone, an email): never parsed or validated. */
  contact: string;
  product: string;
  plan: string;
  since: string;
  createdAt: number;
}

export type TicketStatus = 'open' | 'answered';

export interface CsTicket {
  id: number;
  clientId: number | null;
  clientName: string;
  contact: string;
  text: string;
  status: TicketStatus;
  money: boolean;
  /** SLA alert already raised for this ticket. */
  alerted: boolean;
  createdAt: number;
  answeredAt: number | null;
  /** Where the ticket came from: `owner` (the /ticket command), `bot`, `cabinet` (the client cabinet on the site). */
  source: string;
  /** The approved answer text, kept so the cabinet can show it; null until answered. */
  answer: string | null;
}

/**
 * The messages of a cabinet client about one lead (the client's own, the manager's replies). Owned by the HQ cabinet; the table is declared here
 * too because an approved ticket answer for such a lead lands in it (see `markAnswered`).
 */
export const CAB_MESSAGES_SCHEMA = `
CREATE TABLE IF NOT EXISTS cab_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  lead_id INTEGER NOT NULL,
  "from" TEXT NOT NULL CHECK ("from" IN ('manager', 'client')),
  text TEXT NOT NULL,
  at INTEGER NOT NULL,
  ticket_id INTEGER
);
CREATE INDEX IF NOT EXISTS cab_messages_lead ON cab_messages (lead_id, at);
CREATE UNIQUE INDEX IF NOT EXISTS cab_messages_ticket ON cab_messages (ticket_id, "from") WHERE ticket_id IS NOT NULL;
`;

/**
 * The messages of the cabinet threads that are not a lead's (a project, the support thread, the client's agent): `thread` is `project-<id>`, `support` or `agent-<id>`.
 * Owned by the HQ cabinet; declared here too because an approved ticket answer for such a thread lands in it (see `markAnswered`).
 */
export const CAB_TMSGS_SCHEMA = `
CREATE TABLE IF NOT EXISTS cab_tmsgs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  thread TEXT NOT NULL,
  "from" TEXT NOT NULL CHECK ("from" IN ('manager', 'client', 'agent')),
  text TEXT NOT NULL,
  attachments TEXT NOT NULL DEFAULT '[]',
  at INTEGER NOT NULL,
  ticket_id INTEGER,
  author TEXT NOT NULL DEFAULT 'hq'
);
CREATE INDEX IF NOT EXISTS cab_tmsgs_thread ON cab_tmsgs (client_id, thread, id);
CREATE UNIQUE INDEX IF NOT EXISTS cab_tmsgs_ticket ON cab_tmsgs (ticket_id, "from") WHERE ticket_id IS NOT NULL;
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cs_clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  contact TEXT NOT NULL DEFAULT '',
  product TEXT NOT NULL DEFAULT '',
  plan TEXT NOT NULL DEFAULT '',
  since TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cs_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER,
  client_name TEXT NOT NULL,
  contact TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  money INTEGER NOT NULL DEFAULT 0,
  alerted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  answered_at INTEGER
);
CREATE INDEX IF NOT EXISTS cs_tickets_status ON cs_tickets (status);
`;

interface ClientRow { id: number; name: string; contact: string; product: string; plan: string; since: string; created_at: number }
interface TicketRow {
  id: number; client_id: number | null; client_name: string; contact: string; text: string; status: string; money: number; alerted: number;
  created_at: number; answered_at: number | null; source: string | null; answer: string | null;
}

const toClient = (r: ClientRow): CsClient => ({ id: r.id, name: r.name, contact: r.contact, product: r.product, plan: r.plan, since: r.since, createdAt: r.created_at });
const toTicket = (r: TicketRow): CsTicket => ({
  id: r.id, clientId: r.client_id, clientName: r.client_name, contact: r.contact, text: r.text, status: r.status as TicketStatus, money: r.money === 1,
  alerted: r.alerted === 1, createdAt: r.created_at, answeredAt: r.answered_at, source: r.source ?? '', answer: r.answer ?? null,
});

export class CsStore {
  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {
    migrate(db, SCHEMA);
    // added later: where the ticket came from and the approved answer (the client cabinet shows it)
    const cols = db.prepare('PRAGMA table_info(cs_tickets)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'source')) db.exec("ALTER TABLE cs_tickets ADD COLUMN source TEXT NOT NULL DEFAULT ''");
    if (!cols.some((c) => c.name === 'answer')) db.exec('ALTER TABLE cs_tickets ADD COLUMN answer TEXT');
    // a cabinet message about a lead (cab_messages): the approved answer goes back to that lead's thread
    if (!cols.some((c) => c.name === 'lead_id')) db.exec('ALTER TABLE cs_tickets ADD COLUMN lead_id INTEGER');
    // a cabinet message in a project or support thread (cab_tmsgs): the approved answer goes back to that thread
    if (!cols.some((c) => c.name === 'thread')) db.exec('ALTER TABLE cs_tickets ADD COLUMN thread TEXT');
  }

  upsertClient(c: { name: string; contact?: string; product?: string; plan?: string; since?: string }): CsClient {
    this.db
      .prepare(
        `INSERT INTO cs_clients (name, contact, product, plan, since, created_at) VALUES (@name, @contact, @product, @plan, @since, @createdAt)
         ON CONFLICT(name) DO UPDATE SET contact = CASE WHEN excluded.contact != '' THEN excluded.contact ELSE contact END,
           product = CASE WHEN excluded.product != '' THEN excluded.product ELSE product END,
           plan = CASE WHEN excluded.plan != '' THEN excluded.plan ELSE plan END,
           since = CASE WHEN excluded.since != '' THEN excluded.since ELSE since END`,
      )
      .run({ name: c.name.trim(), contact: c.contact ?? '', product: c.product ?? '', plan: c.plan ?? '', since: c.since ?? '', createdAt: this.now() });
    return this.clientByName(c.name)!;
  }

  /** Exact name (any case), else the only client whose name starts with the text. */
  clientByName(name: string): CsClient | undefined {
    const n = name.trim();
    const exact = this.db.prepare('SELECT * FROM cs_clients WHERE name = ?').get(n) as ClientRow | undefined;
    if (exact) return toClient(exact);
    const like = this.db.prepare("SELECT * FROM cs_clients WHERE lower(name) LIKE lower(?) || '%'").all(n) as ClientRow[];
    return like.length === 1 ? toClient(like[0]!) : undefined;
  }

  clients(): CsClient[] {
    return (this.db.prepare('SELECT * FROM cs_clients ORDER BY name').all() as ClientRow[]).map(toClient);
  }

  addTicket(t: { clientName: string; text: string; money: boolean }): CsTicket {
    const client = this.clientByName(t.clientName);
    const r = this.db
      .prepare('INSERT INTO cs_tickets (client_id, client_name, contact, text, money, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(client?.id ?? null, client?.name ?? t.clientName.trim(), client?.contact ?? '', t.text, t.money ? 1 : 0, this.now());
    return this.ticket(Number(r.lastInsertRowid))!;
  }

  /** A ticket from the client cabinet: the name and contact (email) are the cabinet's own, no cs_clients lookup. */
  addCabinetTicket(t: { clientName: string; contact: string; text: string; leadId?: number; thread?: string }): CsTicket {
    const r = this.db
      .prepare("INSERT INTO cs_tickets (client_id, client_name, contact, text, money, created_at, source, lead_id, thread) VALUES (NULL, ?, ?, ?, 0, ?, 'cabinet', ?, ?)")
      .run(t.clientName.trim(), t.contact, t.text, this.now(), t.leadId ?? null, t.thread ?? null);
    return this.ticket(Number(r.lastInsertRowid))!;
  }

  setMoney(id: number, money: boolean): void {
    this.db.prepare('UPDATE cs_tickets SET money = ? WHERE id = ?').run(money ? 1 : 0, id);
  }

  ticket(id: number): CsTicket | undefined {
    const r = this.db.prepare('SELECT * FROM cs_tickets WHERE id = ?').get(id) as TicketRow | undefined;
    return r ? toTicket(r) : undefined;
  }

  recent(limit = 15): CsTicket[] {
    return (this.db.prepare("SELECT * FROM cs_tickets ORDER BY (status = 'open') DESC, id DESC LIMIT ?").all(limit) as TicketRow[]).map(toTicket);
  }

  markAnswered(id: number, answer?: string): void {
    if (answer !== undefined) {
      this.db.prepare('UPDATE cs_tickets SET answer = ? WHERE id = ?').run(answer.slice(0, 4000), id);
      this.answerToLeadThread(id, answer);
    }
    this.db.prepare("UPDATE cs_tickets SET status = 'answered', answered_at = ? WHERE id = ? AND status = 'open'").run(this.now(), id);
  }

  /** A ticket written about a lead in the cabinet: its approved answer is also the manager's message in that lead's thread (once per ticket). */
  private answerToLeadThread(id: number, answer: string): void {
    const t = this.db.prepare('SELECT lead_id, contact, thread FROM cs_tickets WHERE id = ?').get(id) as { lead_id: number | null; contact: string; thread: string | null } | undefined;
    if (!t || (t.lead_id === null && !t.thread) || !answer.trim()) return;
    const hasClients = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cab_clients'").get() !== undefined;
    if (!hasClients) return;
    const c = this.db.prepare('SELECT id FROM cab_clients WHERE email = ?').get(t.contact.trim().toLowerCase()) as { id: number } | undefined;
    if (!c) return;
    if (t.thread) {
      this.db.exec(CAB_TMSGS_SCHEMA);
      this.db
        .prepare("INSERT OR IGNORE INTO cab_tmsgs (client_id, thread, \"from\", text, at, ticket_id) VALUES (?, ?, 'manager', ?, ?, ?)")
        .run(c.id, t.thread, answer.trim().slice(0, 2000), this.now(), id);
      this.flagNotify('cab_tmsgs', id);
      return;
    }
    this.db.exec(CAB_MESSAGES_SCHEMA);
    this.db
      .prepare("INSERT OR IGNORE INTO cab_messages (client_id, lead_id, \"from\", text, at, ticket_id) VALUES (?, ?, 'manager', ?, ?, ?)")
      .run(c.id, t.lead_id, answer.trim().slice(0, 2000), this.now(), id);
    this.flagNotify('cab_messages', id);
  }

  /** P-13: the approved answer is a manager line the client hears about by email (the HQ cabinet adds the column; without it nothing happens). */
  private flagNotify(table: 'cab_messages' | 'cab_tmsgs', ticketId: number): void {
    try {
      this.db.prepare(`UPDATE ${table} SET notify = 1 WHERE ticket_id = ? AND "from" = 'manager' AND mailed = 0`).run(ticketId);
    } catch {
      /* an older table without the email columns: the thread line is the delivery */
    }
  }

  /** Open tickets older than `slaMs` that were not alerted yet; marks them alerted (one alert per ticket). */
  takeSlaBreaches(slaMs: number): CsTicket[] {
    const rows = this.db.prepare("SELECT * FROM cs_tickets WHERE status = 'open' AND alerted = 0 AND created_at <= ? ORDER BY id").all(this.now() - slaMs) as TicketRow[];
    for (const r of rows) this.db.prepare('UPDATE cs_tickets SET alerted = 1 WHERE id = ?').run(r.id);
    return rows.map((r) => toTicket({ ...r, alerted: 1 }));
  }
}
