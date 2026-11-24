import type { Db } from '@fir/core';
import { CAB_MESSAGES_SCHEMA, CAB_TMSGS_SCHEMA } from '@fir/worker-customer-support';
import { LeadStore, type Lang } from '@fir/worker-lead-intake';
import { Coupons } from './coupon.js';
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

/** Files a client uploaded (`DATA_DIR/uploads/<client>/<id>.<ext>`) and the read marks of the cabinet threads (client side). */
const CAB_FILES_SCHEMA = `CREATE TABLE IF NOT EXISTS cab_uploads (
  id TEXT PRIMARY KEY,
  client_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER NOT NULL,
  rel TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cab_uploads_client ON cab_uploads (client_id);
CREATE TABLE IF NOT EXISTS cab_reads (
  client_id INTEGER NOT NULL,
  thread TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (client_id, thread)
);`;

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
  // Cabinet v3 (2026-11-22): attachments of a lead thread's message (JSON list of upload ids); the other threads live in cab_tmsgs
  if (!hasColumn(db, 'cab_messages', 'attachments')) db.exec("ALTER TABLE cab_messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]'");
  db.exec(CAB_TMSGS_SCHEMA);
  db.exec(CAB_FILES_SCHEMA);
  // the profile of the cabinet (2026-11-22): phone and company next to the name, the Telegram handle and the language
  for (const c of ['phone', 'company']) if (!hasColumn(db, 'cab_clients', c)) db.exec(`ALTER TABLE cab_clients ADD COLUMN ${c} TEXT NOT NULL DEFAULT ''`);
  // profile v2 (2026-11-23): consents, channel, the business facts and the legal party of the papers (site contract `docs/cabinet.md`, `client-prefs.ts`)
  if (!hasColumn(db, 'cab_clients', 'recommendations_consent')) db.exec('ALTER TABLE cab_clients ADD COLUMN recommendations_consent INTEGER NOT NULL DEFAULT 0');
  if (!hasColumn(db, 'cab_clients', 'notify_channel')) db.exec("ALTER TABLE cab_clients ADD COLUMN notify_channel TEXT NOT NULL DEFAULT 'email'");
  // the chat of the client's own Telegram bot link; nothing writes it yet (the link by the bot is not built), so «telegram» channels fall back to email
  if (!hasColumn(db, 'cab_clients', 'tg_chat_id')) db.exec('ALTER TABLE cab_clients ADD COLUMN tg_chat_id INTEGER');
  for (const c of ['niche', 'website', 'city', 'legal_name', 'legal_address', 'refund_wallet']) if (!hasColumn(db, 'cab_clients', c)) db.exec(`ALTER TABLE cab_clients ADD COLUMN ${c} TEXT NOT NULL DEFAULT ''`);
  // P-13 (2026-11-22): a manager line the client should hear about by email (`notify`) and whether that email went (`mailed`); see `client-mail.ts`
  for (const t of ['cab_messages', 'cab_tmsgs']) {
    for (const c of ['notify', 'mailed']) if (!hasColumn(db, t, c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} INTEGER NOT NULL DEFAULT 0`);
  }
  ready.add(db);
}

const hasTable = (db: Db, t: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) !== undefined;
const hasColumn = (db: Db, t: string, c: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).some((x) => x.name === c);

/** Stores one message of a lead's thread. */
/** `notify`: the client gets an email «new message in the cabinet» for it (P-13, at most one per thread an hour, `client-mail.ts`). */
export function addCabMessage(db: Db, now: number, m: { clientId: number; leadId: number; from: MessageFrom; text: string; ticketId?: number; by?: 'owner' | 'hq'; notify?: boolean }): number {
  ensureCabinetTables(db);
  return Number(db.prepare('INSERT INTO cab_messages (client_id, lead_id, "from", text, at, ticket_id, author, notify) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    m.clientId, m.leadId, m.from, m.text.trim().slice(0, MESSAGE_CAP), now, m.ticketId ?? null, m.by ?? 'hq', m.notify ? 1 : 0,
  ).lastInsertRowid);
}

/** The manager's reply on a lead, kept in the cabinet thread when the lead belongs to a cabinet client (otherwise nothing: no cabinet, no thread). */
export function recordManagerReply(db: Db, now: number, leadId: number, text: string, by: 'owner' | 'hq' = 'hq'): void {
  try {
    if (!text.trim() || !hasTable(db, 'li_leads') || !hasColumn(db, 'li_leads', 'client_id')) return;
    const r = db.prepare('SELECT client_id FROM li_leads WHERE id = ?').get(leadId) as { client_id: number | null } | undefined;
    if (r?.client_id == null) return;
    // P-13: a manager's answer is something the client should hear about: one email «new message» per thread an hour
    addCabMessage(db, now, { clientId: r.client_id, leadId, from: 'manager', text, by, notify: true });
  } catch {
    /* the thread is a convenience for the client: a failure here never breaks the reply itself */
  }
}

/** Stores one message of a project, support or agent thread (`thread`: `project-<id>`, `support`, `agent-<id>`). */
export function addThreadMessage(
  db: Db, now: number, m: { clientId: number; thread: string; from: 'client' | 'manager' | 'agent'; text: string; attachments?: string[]; ticketId?: number; by?: 'owner' | 'hq'; notify?: boolean },
): number {
  ensureCabinetTables(db);
  return Number(db.prepare('INSERT INTO cab_tmsgs (client_id, thread, "from", text, attachments, at, ticket_id, author, notify) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    m.clientId, m.thread, m.from, m.text.trim().slice(0, MESSAGE_CAP), JSON.stringify(m.attachments ?? []), now, m.ticketId ?? null, m.by ?? 'hq', m.notify ? 1 : 0,
  ).lastInsertRowid);
}

/** A line from Fir Tech in the client's lead thread when the lead is known, else in the support thread (documents, payments, status). */
export function postFromFirTech(db: Db, now: number, clientId: number, leadId: number | null, text: string): void {
  try {
    if (leadId !== null) addCabMessage(db, now, { clientId, leadId, from: 'manager', text });
    else addThreadMessage(db, now, { clientId, thread: 'support', from: 'manager', text });
  } catch {
    /* the thread is a convenience for the client: a failure never breaks the step that wrote to it */
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
  /** The percent of the cabinet coupon issued to a new account (`settings.coupon.percent`); default 10. */
  couponPercent?: number | undefined;
}

/**
 * A lead sent from a signed-in cabinet: upserts the account by email (like `POST /admin/clients`), makes the lead row right away
 * (the lead-intake worker fills the rest when the task runs: one task, one lead) and links it to the account. Returns both ids.
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
  // the cabinet coupon is issued with the account (an old account without one gets it only while it is younger than 30 days)
  new Coupons(db, now, l.couponPercent ? () => l.couponPercent! : undefined).ensure(client.id);
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
    new: 'Первый ответ за 5 минут, круглосуточно; цены и сроки подтверждает менеджер проекта',
    qualified: 'Готовим коммерческое предложение',
    proposal: 'КП отправлено, ждём вашего решения',
    contract: 'Договор и счёт первого этапа готовы',
    paid: 'Оплата получена, запускаем проект',
    project: 'Проект в работе, этапы ниже',
    lost: 'Заявка закрыта',
  },
  en: {
    new: 'First reply within 5 minutes, around the clock; prices and timing are confirmed by the project manager',
    qualified: 'We are preparing the commercial proposal',
    proposal: 'The proposal has been sent, we are waiting for your decision',
    contract: 'The contract and the invoice for the first stage are ready',
    paid: 'Payment received, we are starting the project',
    project: 'The project is in progress, the stages are below',
    lost: 'The request is closed',
  },
};
export const nextStepOf = (stage: Stage, lang: string | null | undefined): string => NEXT_STEP[lang === 'en' ? 'en' : 'ru'][stage];

export type TimelineKind = 'lead' | 'reply' | 'kp' | 'kp_accepted' | 'contract' | 'contract_signed' | 'invoice' | 'paid' | 'project' | 'stage';
const TITLES: Record<Lang, Record<Exclude<TimelineKind, 'stage'>, string>> = {
  ru: { lead: 'Заявка получена', reply: 'Менеджер ответил', kp: 'Коммерческое предложение утверждено', kp_accepted: 'КП принято вами', contract: 'Договор подготовлен', contract_signed: 'Договор подписан', invoice: 'Счёт выставлен', paid: 'Оплата получена', project: 'Проект запущен' },
  en: { lead: 'Request received', reply: 'A manager replied', kp: 'Commercial proposal approved', kp_accepted: 'Proposal accepted by you', contract: 'Contract prepared', contract_signed: 'Contract signed', invoice: 'Invoice issued', paid: 'Payment received', project: 'Project started' },
};
const STAGE_MOVE: Record<Lang, Record<Stage, string>> = {
  ru: { new: 'Заявка возвращена на первичный разбор', qualified: 'Заявка квалифицирована', proposal: 'Этап: коммерческое предложение', contract: 'Этап: договор', paid: 'Этап: оплачено', project: 'Этап: проект', lost: 'Заявка закрыта' },
  en: { new: 'Request returned to the first review', qualified: 'Request qualified', proposal: 'Stage: proposal', contract: 'Stage: contract', paid: 'Stage: paid', project: 'Stage: project', lost: 'Request closed' },
};
export const timelineTitle = (kind: Exclude<TimelineKind, 'stage'>, lang: string | null | undefined): string => TITLES[lang === 'en' ? 'en' : 'ru'][kind];
export const stageMoveTitle = (stage: Stage, lang: string | null | undefined): string => STAGE_MOVE[lang === 'en' ? 'en' : 'ru'][stage];

/** The stage fields the next-step line reads (the cabinet's milestone view). */
export interface StageLine {
  stageNo: number | null;
  title: string | null;
  amountUsd: number | null;
  state: 'awaiting_payment' | 'in_progress' | 'awaiting_acceptance' | 'accepted' | null;
  invoiceNumber: string | null;
  payUrl: string | null;
}

/**
 * What the client does next in a project paid by stages: accept a finished stage, or pay the stage whose invoice is issued. Null when there is
 * nothing for the client to do (no stages, the stage runs, the invoice is not issued yet): the lead's stage sentence is used then.
 */
export function stageNextStep(stages: StageLine[], lang: string | null | undefined): string | null {
  const en = lang === 'en';
  for (const s of stages) {
    if (s.stageNo === null || s.state === 'accepted') continue;
    const name = `${s.title ? `«${s.title}»` : ''}`;
    if (s.state === 'awaiting_acceptance') return en ? `Accept stage ${s.stageNo} ${name}`.trim() : `Примите этап ${s.stageNo} ${name}`.trim();
    if (s.state === 'awaiting_payment' && s.payUrl) return en ? `Pay stage ${s.stageNo} ${name}: $${s.amountUsd}`.replace(/\s+:/, ':') : `Оплатите этап ${s.stageNo} ${name}: $${s.amountUsd}`.replace(/\s+:/, ':');
    return null; // the stage runs, or its invoice is not issued yet
  }
  return null;
}
