import type { Db } from '@fir/core';
import { CAB_MESSAGES_SCHEMA } from '@fir/worker-customer-support';
import { LeadStore, type Lang } from '@fir/worker-lead-intake';
import type { Stage } from './lead-stage.js';

/**
 * The client cabinet's own tables and the helpers shared by the webhook, the cabinet API and the reply paths:
 * `cab_clients` (accounts made on the site), `cab_messages` (the thread of one lead: the client's messages and the manager's replies).
 */
const CAB_CLIENTS_SCHEMA = `CREATE TABLE IF NOT EXISTS cab_clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  telegram TEXT NOT NULL DEFAULT '',
  locale TEXT NOT NULL DEFAULT 'ru',
  supabase_id TEXT NOT NULL DEFAULT '',
  marketing_consent INTEGER NOT NULL DEFAULT 0,
  ref_slug TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_seen_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS cab_clients_slug ON cab_clients (ref_slug);`;

export const MESSAGE_CAP = 2000;
export type MessageFrom = 'manager' | 'client';

const ready = new WeakSet<object>();
/** Creates the cabinet tables (idempotent, once per database handle). */
export function ensureCabinetTables(db: Db): void {
  if (ready.has(db)) return;
  db.exec(CAB_CLIENTS_SCHEMA);
  db.exec(CAB_MESSAGES_SCHEMA);
  // who wrote a manager line: the owner himself (his own reply, no approval) or HQ (an approved draft); the chats of the review center show the difference
  if (!hasColumn(db, 'cab_messages', 'author')) db.exec("ALTER TABLE cab_messages ADD COLUMN author TEXT NOT NULL DEFAULT 'hq'");
  ready.add(db);
}

const hasTable = (db: Db, t: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) !== undefined;
const hasColumn = (db: Db, t: string, c: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).some((x) => x.name === c);

/** Stores one message of a lead's thread. */
export function addCabMessage(db: Db, now: number, m: { clientId: number; leadId: number; from: MessageFrom; text: string; ticketId?: number; by?: 'owner' | 'hq' }): number {
  ensureCabinetTables(db);
  return Number(db.prepare('INSERT INTO cab_messages (client_id, lead_id, "from", text, at, ticket_id, author) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    m.clientId, m.leadId, m.from, m.text.trim().slice(0, MESSAGE_CAP), now, m.ticketId ?? null, m.by ?? 'hq',
  ).lastInsertRowid);
}

/** The manager's reply on a lead, kept in the cabinet thread when the lead belongs to a cabinet client (otherwise nothing: no cabinet, no thread). */
export function recordManagerReply(db: Db, now: number, leadId: number, text: string, by: 'owner' | 'hq' = 'hq'): void {
  try {
    if (!text.trim() || !hasTable(db, 'li_leads') || !hasColumn(db, 'li_leads', 'client_id')) return;
    const r = db.prepare('SELECT client_id FROM li_leads WHERE id = ?').get(leadId) as { client_id: number | null } | undefined;
    if (r?.client_id == null) return;
    addCabMessage(db, now, { clientId: r.client_id, leadId, from: 'manager', text, by });
  } catch {
    /* the thread is a convenience for the client: a failure here never breaks the reply itself */
  }
}

export interface CabinetLeadInput {
  clientEmail: string;
  cabinetId?: string | undefined;
  clientName?: string | undefined;
  name: string;
  contact: string;
  service: string;
  budget: string;
  message: string;
  estimate: string;
  locale: Lang;
  source: string;
  hasDomain?: boolean | undefined;
  hasHosting?: boolean | undefined;
}

/**
 * A lead sent from a signed-in cabinet: upserts the account by email (like `POST /admin/clients`), makes the lead row right away
 * (the Приёмщик fills the rest when the task runs: one task, one lead) and links it to the account. Returns both ids.
 */
export function registerCabinetLead(db: Db, now: () => number, taskId: number, l: CabinetLeadInput): { clientId: number; leadId: number } {
  ensureCabinetTables(db);
  const store = new LeadStore(db, now);
  const t = now();
  const name = (l.clientName ?? '').trim().slice(0, 120);
  db.prepare(
    `INSERT INTO cab_clients (email, name, locale, supabase_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET name = CASE WHEN ? != '' OR name = '' THEN excluded.name ELSE name END,
       supabase_id = CASE WHEN excluded.supabase_id != '' THEN excluded.supabase_id ELSE supabase_id END, updated_at = excluded.updated_at`,
  ).run(l.clientEmail, name || l.name.slice(0, 120), l.locale, l.cabinetId ?? '', t, t, name);
  const client = db.prepare('SELECT id FROM cab_clients WHERE email = ?').get(l.clientEmail) as { id: number };
  const lead = store.upsert(taskId, {
    name: l.name.slice(0, 80), contact: l.contact.slice(0, 120), service: l.service, niche: '', task: l.message.slice(0, 300), deadline: '', budget: l.budget.slice(0, 40),
    origin: l.source, temperature: 'cold', lang: l.locale, slots: [], chosenSlot: null, priceAsked: false, estimate: l.estimate,
    hasDomain: l.hasDomain ?? null, hasHosting: l.hasHosting ?? null,
  });
  db.prepare('UPDATE li_leads SET client_id = ? WHERE id = ?').run(client.id, lead.id);
  return { clientId: client.id, leadId: lead.id };
}

/** What the client reads under each lead: one short sentence per stage (the lead's language, Russian by default). */
const NEXT_STEP: Record<Lang, Record<Stage, string>> = {
  ru: {
    new: 'Менеджер уточнит детали в течение рабочего дня',
    qualified: 'Готовим коммерческое предложение',
    proposal: 'КП отправлено, ждём вашего решения',
    contract: 'Договор и счёт на 50% готовы',
    paid: 'Оплата получена, запускаем проект',
    project: 'Проект в работе, этапы ниже',
    lost: 'Заявка закрыта',
  },
  en: {
    new: 'A manager will get back to you with questions within a working day',
    qualified: 'We are preparing the commercial proposal',
    proposal: 'The proposal has been sent, we are waiting for your decision',
    contract: 'The contract and the 50% invoice are ready',
    paid: 'Payment received, we are starting the project',
    project: 'The project is in progress, the stages are below',
    lost: 'The request is closed',
  },
};
export const nextStepOf = (stage: Stage, lang: string | null | undefined): string => NEXT_STEP[lang === 'en' ? 'en' : 'ru'][stage];

export type TimelineKind = 'lead' | 'reply' | 'kp' | 'contract' | 'invoice' | 'paid' | 'project' | 'stage';
const TITLES: Record<Lang, Record<Exclude<TimelineKind, 'stage'>, string>> = {
  ru: { lead: 'Заявка получена', reply: 'Менеджер ответил', kp: 'Коммерческое предложение утверждено', contract: 'Договор подготовлен', invoice: 'Счёт выставлен', paid: 'Оплата получена', project: 'Проект запущен' },
  en: { lead: 'Request received', reply: 'A manager replied', kp: 'Commercial proposal approved', contract: 'Contract prepared', invoice: 'Invoice issued', paid: 'Payment received', project: 'Project started' },
};
const STAGE_MOVE: Record<Lang, Record<Stage, string>> = {
  ru: { new: 'Заявка возвращена на первичный разбор', qualified: 'Заявка квалифицирована', proposal: 'Этап: коммерческое предложение', contract: 'Этап: договор', paid: 'Этап: оплачено', project: 'Этап: проект', lost: 'Заявка закрыта' },
  en: { new: 'Request returned to the first review', qualified: 'Request qualified', proposal: 'Stage: proposal', contract: 'Stage: contract', paid: 'Stage: paid', project: 'Stage: project', lost: 'Request closed' },
};
export const timelineTitle = (kind: Exclude<TimelineKind, 'stage'>, lang: string | null | undefined): string => TITLES[lang === 'en' ? 'en' : 'ru'][kind];
export const stageMoveTitle = (stage: Stage, lang: string | null | undefined): string => STAGE_MOVE[lang === 'en' ? 'en' : 'ru'][stage];
