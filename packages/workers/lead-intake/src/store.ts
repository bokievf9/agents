import { migrate, type Db } from '@fir/core';

export type Temperature = 'hot' | 'warm' | 'cold';
export type Lang = 'ru' | 'en';

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
  price_asked: number; price_approved: number; created_at: number;
}

const toLead = (r: Row): Lead => ({
  id: r.id, taskId: r.task_id, name: r.name, contact: r.contact, service: r.service, niche: r.niche, task: r.task, deadline: r.deadline,
  budget: r.budget, origin: r.origin, temperature: r.temperature as Temperature, lang: r.lang as Lang, slots: JSON.parse(r.slots) as number[],
  chosenSlot: r.chosen_slot, priceAsked: r.price_asked === 1, priceApproved: r.price_approved === 1, createdAt: r.created_at,
});

export type LeadInput = Pick<Lead, 'name' | 'contact' | 'service' | 'niche' | 'task' | 'deadline' | 'budget' | 'origin' | 'temperature' | 'lang' | 'slots' | 'chosenSlot' | 'priceAsked'>;

export class LeadStore {
  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {
    migrate(db, SCHEMA);
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
        `INSERT INTO li_leads (task_id, name, contact, service, niche, task, deadline, budget, origin, temperature, lang, slots, chosen_slot, price_asked, created_at)
         VALUES (@taskId, @name, @contact, @service, @niche, @task, @deadline, @budget, @origin, @temperature, @lang, @slots, @chosenSlot, @priceAsked, @createdAt)
         ON CONFLICT(task_id) DO UPDATE SET niche=excluded.niche, task=excluded.task, deadline=excluded.deadline, temperature=excluded.temperature,
           slots=excluded.slots, chosen_slot=excluded.chosen_slot, price_asked=excluded.price_asked`,
      )
      .run({
        taskId, name: l.name, contact: l.contact, service: l.service, niche: l.niche, task: l.task, deadline: l.deadline, budget: l.budget,
        origin: l.origin, temperature: l.temperature, lang: l.lang, slots: JSON.stringify(l.slots), chosenSlot: l.chosenSlot,
        priceAsked: l.priceAsked ? 1 : 0, createdAt: this.now(),
      });
    return this.byTask(taskId)!;
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
