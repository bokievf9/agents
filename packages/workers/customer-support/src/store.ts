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
}

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
  created_at: number; answered_at: number | null;
}

const toClient = (r: ClientRow): CsClient => ({ id: r.id, name: r.name, contact: r.contact, product: r.product, plan: r.plan, since: r.since, createdAt: r.created_at });
const toTicket = (r: TicketRow): CsTicket => ({
  id: r.id, clientId: r.client_id, clientName: r.client_name, contact: r.contact, text: r.text, status: r.status as TicketStatus, money: r.money === 1,
  alerted: r.alerted === 1, createdAt: r.created_at, answeredAt: r.answered_at,
});

export class CsStore {
  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {
    migrate(db, SCHEMA);
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

  ticket(id: number): CsTicket | undefined {
    const r = this.db.prepare('SELECT * FROM cs_tickets WHERE id = ?').get(id) as TicketRow | undefined;
    return r ? toTicket(r) : undefined;
  }

  recent(limit = 15): CsTicket[] {
    return (this.db.prepare("SELECT * FROM cs_tickets ORDER BY (status = 'open') DESC, id DESC LIMIT ?").all(limit) as TicketRow[]).map(toTicket);
  }

  markAnswered(id: number): void {
    this.db.prepare("UPDATE cs_tickets SET status = 'answered', answered_at = ? WHERE id = ? AND status = 'open'").run(this.now(), id);
  }

  /** Open tickets older than `slaMs` that were not alerted yet; marks them alerted (one alert per ticket). */
  takeSlaBreaches(slaMs: number): CsTicket[] {
    const rows = this.db.prepare("SELECT * FROM cs_tickets WHERE status = 'open' AND alerted = 0 AND created_at <= ? ORDER BY id").all(this.now() - slaMs) as TicketRow[];
    for (const r of rows) this.db.prepare('UPDATE cs_tickets SET alerted = 1 WHERE id = ?').run(r.id);
    return rows.map((r) => toTicket({ ...r, alerted: 1 }));
  }
}
