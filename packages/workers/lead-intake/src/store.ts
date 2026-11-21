import { migrate, type Db } from '@fir/core';

export type Temperature = 'hot' | 'warm' | 'cold';
export type Lang = 'ru' | 'en';

/**
 * What the owner sees on a lead card and in the review center about the conversation that made the lead (ИИ-менеджер заявок 2.0): three lines of summary,
 * the product family the receptionist detected, the niche, an intent score 0-100 and the builder link it proposed (a site path, `/ru/builder?b=...`).
 * Leads that did not come from the chat get a derived one (their message lines, the service, the temperature, the builder link of their estimate).
 */
export interface Enrichment {
  summary: string[];
  productFamily: string;
  niche: string;
  intentScore: number;
  builderLink: string;
}

export interface Lead {
  id: number;
  /** The Sales task this lead came in with (one lead per task: a rework of the task reuses the row). */
  taskId: number;
  name: string;
  contact: string;
  service: string;
  niche: string;
  task: string;
  deadline: string;
  budget: string;
  /** Where the website form was filled (the site's `source` field). */
  origin: string;
  temperature: Temperature;
  lang: Lang;
  /** The two proposed call slots (UTC ms). */
  slots: number[];
  /** The slot the client picked in the form, if any. */
  chosenSlot: number | null;
  priceAsked: boolean;
  priceApproved: boolean;
  createdAt: number;
  /** The builder's summary from the site (the chosen package, its total, what the client already has), as the form sent it. */
  estimate: string;
  /** The client already has a domain: true or false when known (an answer in the bot, the site's brief), null when nobody asked. */
  hasDomain: boolean | null;
  hasHosting: boolean | null;
  /** The cabinet account (cab_clients.id) the lead belongs to: the client sent it signed in, or registered later with the same contact. */
  clientId?: number | null;
  /** The conversation summary, product family, niche, intent score and builder link (see `Enrichment`); null for a lead made before the field existed. */
  enrichment?: Enrichment | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS li_leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  contact TEXT NOT NULL DEFAULT '',
  service TEXT NOT NULL DEFAULT '',
  niche TEXT NOT NULL DEFAULT '',
  task TEXT NOT NULL DEFAULT '',
  deadline TEXT NOT NULL DEFAULT '',
  budget TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL DEFAULT '',
  temperature TEXT NOT NULL DEFAULT 'cold',
  lang TEXT NOT NULL DEFAULT 'ru',
  slots TEXT NOT NULL DEFAULT '[]',
  chosen_slot INTEGER,
  price_asked INTEGER NOT NULL DEFAULT 0,
  price_approved INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
`;

interface Row {
  id: number; task_id: number; name: string; contact: string; service: string; niche: string; task: string; deadline: string;
  budget: string; origin: string; temperature: string; lang: string; slots: string; chosen_slot: number | null;
  price_asked: number; price_approved: number; created_at: number; estimate: string; has_domain: number | null; has_hosting: number | null; client_id?: number | null; enrichment?: string | null;
}

export function parseEnrichment(raw: string | null | undefined): Enrichment | null {
  if (!raw) return null;
  try {
    const e = JSON.parse(raw) as Partial<Enrichment>;
    return {
      summary: Array.isArray(e.summary) ? e.summary.map(String).slice(0, 3) : [], productFamily: String(e.productFamily ?? ''), niche: String(e.niche ?? ''),
      intentScore: Math.max(0, Math.min(100, Math.round(Number(e.intentScore) || 0))), builderLink: String(e.builderLink ?? ''),
    };
  } catch {
    return null;
  }
}

const toLead = (r: Row): Lead => ({
  id: r.id, taskId: r.task_id, name: r.name, contact: r.contact, service: r.service, niche: r.niche, task: r.task, deadline: r.deadline,
  budget: r.budget, origin: r.origin, temperature: r.temperature as Temperature, lang: r.lang as Lang, slots: JSON.parse(r.slots) as number[],
  chosenSlot: r.chosen_slot, priceAsked: r.price_asked === 1, priceApproved: r.price_approved === 1, createdAt: r.created_at,
  estimate: r.estimate ?? '', hasDomain: r.has_domain === null ? null : r.has_domain === 1, hasHosting: r.has_hosting === null ? null : r.has_hosting === 1,
  clientId: r.client_id ?? null,
  enrichment: parseEnrichment(r.enrichment),
});

export type LeadInput = Pick<Lead, 'name' | 'contact' | 'service' | 'niche' | 'task' | 'deadline' | 'budget' | 'origin' | 'temperature' | 'lang' | 'slots' | 'chosenSlot' | 'priceAsked'> & Partial<Pick<Lead, 'estimate' | 'hasDomain' | 'hasHosting'>>;

export class LeadStore {
  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {
    migrate(db, SCHEMA);
    // the brief gained the builder's summary and what the client already has (domain, hosting), see `docs/` and the КП conditions line
    const cols = db.prepare('PRAGMA table_info(li_leads)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'estimate')) db.exec("ALTER TABLE li_leads ADD COLUMN estimate TEXT NOT NULL DEFAULT ''");
    if (!cols.some((c) => c.name === 'has_domain')) db.exec('ALTER TABLE li_leads ADD COLUMN has_domain INTEGER');
    if (!cols.some((c) => c.name === 'has_hosting')) db.exec('ALTER TABLE li_leads ADD COLUMN has_hosting INTEGER');
    // the cabinet account this lead belongs to (cab_clients.id), set when the client registers on the site
    if (!cols.some((c) => c.name === 'client_id')) db.exec('ALTER TABLE li_leads ADD COLUMN client_id INTEGER');
    // a stage the owner set by hand in the workplace («Пульт v3»); the derived stage wins only when it is further along
    if (!cols.some((c) => c.name === 'enrichment')) db.exec('ALTER TABLE li_leads ADD COLUMN enrichment TEXT');
    if (!cols.some((c) => c.name === 'stage_override')) db.exec('ALTER TABLE li_leads ADD COLUMN stage_override TEXT');
  }

  get(id: number): Lead | undefined {
    const r = this.db.prepare('SELECT * FROM li_leads WHERE id = ?').get(id) as Row | undefined;
    return r ? toLead(r) : undefined;
  }

  byTask(taskId: number): Lead | undefined {
    const r = this.db.prepare('SELECT * FROM li_leads WHERE task_id = ?').get(taskId) as Row | undefined;
    return r ? toLead(r) : undefined;
  }

  /** Creates the lead of a task, or refreshes it when the task runs again (rework): one task, one lead. */
  upsert(taskId: number, l: LeadInput): Lead {
    this.db
      .prepare(
        `INSERT INTO li_leads (task_id, name, contact, service, niche, task, deadline, budget, origin, temperature, lang, slots, chosen_slot, price_asked, created_at, estimate, has_domain, has_hosting)
         VALUES (@taskId, @name, @contact, @service, @niche, @task, @deadline, @budget, @origin, @temperature, @lang, @slots, @chosenSlot, @priceAsked, @createdAt, @estimate, @hasDomain, @hasHosting)
         ON CONFLICT(task_id) DO UPDATE SET niche=excluded.niche, task=excluded.task, deadline=excluded.deadline, temperature=excluded.temperature,
           slots=excluded.slots, chosen_slot=excluded.chosen_slot, price_asked=excluded.price_asked, estimate=excluded.estimate,
           has_domain=excluded.has_domain, has_hosting=excluded.has_hosting`,
      )
      .run({
        taskId, name: l.name, contact: l.contact, service: l.service, niche: l.niche, task: l.task, deadline: l.deadline, budget: l.budget,
        origin: l.origin, temperature: l.temperature, lang: l.lang, slots: JSON.stringify(l.slots), chosenSlot: l.chosenSlot,
        priceAsked: l.priceAsked ? 1 : 0, createdAt: this.now(),
        estimate: l.estimate ?? '', hasDomain: l.hasDomain == null ? null : l.hasDomain ? 1 : 0, hasHosting: l.hasHosting == null ? null : l.hasHosting ? 1 : 0,
      });
    return this.byTask(taskId)!;
  }

  /** The conversation summary and the rest of `Enrichment` (written by the Lead Handler when it makes the card). */
  setEnrichment(id: number, e: Enrichment): void {
    this.db.prepare('UPDATE li_leads SET enrichment = ? WHERE id = ?').run(JSON.stringify(e), id);
  }

  /** Adds text to the lead's task (what the client wants): the clarifying answers or the assumptions the КП is made from. */
  appendBrief(id: number, text: string): void {
    const cur = (this.db.prepare('SELECT task FROM li_leads WHERE id = ?').get(id) as { task: string } | undefined)?.task ?? '';
    this.db.prepare('UPDATE li_leads SET task = ? WHERE id = ?').run(`${cur}${cur ? '\n' : ''}${text}`.slice(0, 3000), id);
  }

  setNiche(id: number, niche: string): void {
    this.db.prepare('UPDATE li_leads SET niche = ? WHERE id = ?').run(niche.slice(0, 100), id);
  }

  setPriceApproved(id: number): void {
    this.db.prepare('UPDATE li_leads SET price_approved = 1 WHERE id = ?').run(id);
  }

  recent(limit = 10): Lead[] {
    return (this.db.prepare('SELECT * FROM li_leads ORDER BY id DESC LIMIT ?').all(limit) as Row[]).map(toLead);
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM li_leads').get() as { n: number }).n;
  }
}
