import { errMsg, log, type Db } from '@fir/core';
import { asksMoney, escalationModeOf, escalationOf, type Escalation, type EscalationMode } from '@fir/fira';
import type { Hq } from '@fir/hq';

/**
 * Autopilot for client support answers (owner setting `autopilot.support`, `ask_me | policy | autopilot`, default `policy`). The Support head's draft
 * answer to a client's ticket goes through the same escalation policy as Fira's lead manager (`escalationOf`): an escalation keeps the draft in the
 * owner's queue and sends one reminder; anything else is approved by the autopilot and delivered by the usual approval path (cabinet thread, email,
 * Telegram chat). Money, discounts and refunds stay with the owner in EVERY mode (stricter than the lead manager's policy).
 */
export const SUPPORT_AUTOPILOT_PER_CLIENT_DAY = 20;
const DAY_MS = 24 * 3600_000;

export const supportModeOf = (hq: Pick<Hq, 'setting'>): EscalationMode => escalationModeOf(hq.setting('autopilot.support'));

const PROJECT_LABEL = /^\s*\[по проекту #\d+\]\s*/;
/** The client's own words: the thread label the cabinet puts in front is not part of them. */
export const clientWords = (text: string): string => text.replace(PROJECT_LABEL, '').replace(/^\s*\[по заявке #\d+\]\s*/, '').trim();

export const SCHEMA = `CREATE TABLE IF NOT EXISTS support_autopilot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_key TEXT NOT NULL,
  ticket_id INTEGER,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS support_autopilot_client ON support_autopilot (client_key, at);`;

const hasTable = (db: Db, name: string): boolean => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

/** A client with a project is a VIP: the cabinet label of a project thread, or a project of a lead of the client (found by the cabinet email). */
export function isVip(db: Db, o: { text: string; contact: string }): boolean {
  if (PROJECT_LABEL.test(o.text)) return true;
  const email = o.contact.trim().toLowerCase();
  if (!email.includes('@') || !hasTable(db, 'cab_clients') || !hasTable(db, 'li_leads') || !hasTable(db, 'pm_projects')) return false;
  const row = db.prepare('SELECT 1 AS x FROM cab_clients c JOIN li_leads l ON l.client_id = c.id JOIN pm_projects p ON p.lead_id = l.id WHERE lower(c.email) = ? LIMIT 1').get(email);
  return Boolean(row);
}

export interface SupportDraft {
  /** The client's message (cabinet labels allowed). */
  text: string;
  /** The draft answer waiting for approval. */
  draft: string;
  contact: string;
  /** `support_money` or the ticket's own money flag. */
  money: boolean;
}

/**
 * The escalation of a support draft under the mode, or null when the autopilot may send it. Money is owner-only in every mode; an empty draft or one
 * with a `[placeholder]` counts as «unsure», so it is never sent alone (and in `policy` the owner gets the reminder).
 */
export function supportEscalation(db: Db, mode: EscalationMode, d: SupportDraft, channel: string): Escalation | null {
  const text = clientWords(d.text);
  const lang = /[а-яё]/i.test(text) ? 'ru' : 'en';
  const unsure = !d.draft.trim() || /\[[^\]]*\]/.test(d.draft);
  const vip = isVip(db, { text: d.text, contact: d.contact });
  const base = { text, lang, mode, vip, outcome: { unknown: unsure } };
  let e = escalationOf(base, { channel });
  // money, discounts and refunds are never answered alone, whatever the mode (the lead manager's `autopilot` lets prices through; support does not)
  if (!e && (d.money || asksMoney(text))) e = escalationOf({ ...base, mode: 'policy' }, { channel });
  // an empty or unfinished draft waits for the owner even when the mode would not bother him about it
  if (!e && unsure) e = escalationOf({ ...base, mode: 'ask_me', text: '', vip: false }, { channel });
  return e ? { ...e, short: e.short.replace('ИИ-менеджер заявок', 'Поддержка'), line: e.line.replace('ИИ-менеджер заявок', 'Поддержка') } : null;
}

export class SupportAutopilotLimit {
  constructor(private readonly db: Db, private readonly now: () => number) {
    this.db.exec(SCHEMA);
  }

  count(clientKey: string): number {
    return (this.db.prepare('SELECT COUNT(*) n FROM support_autopilot WHERE client_key = ? AND at > ?').get(clientKey, this.now() - DAY_MS) as { n: number }).n;
  }

  full(clientKey: string): boolean {
    return this.count(clientKey) >= SUPPORT_AUTOPILOT_PER_CLIENT_DAY;
  }

  note(clientKey: string, ticketId: number | null): void {
    this.db.prepare('INSERT INTO support_autopilot (client_key, ticket_id, at) VALUES (?, ?, ?)').run(clientKey, ticketId, this.now());
  }
}

/** One owner reminder per task, never twice (the activity log is the memory). */
export async function remindOnce(hq: Hq, taskId: number, e: Escalation): Promise<boolean> {
  const seen = hq.db.prepare("SELECT 1 AS x FROM activity WHERE action = 'support_human_alert' AND object_type = 'task' AND object_id = ? LIMIT 1").get(String(taskId));
  if (seen) return false;
  hq.log('support-head', 'support_human_alert', 'task', String(taskId), e.reason);
  try {
    await hq.alert(e.line, { kind: 'human', short: e.short });
  } catch (err) {
    log('warn', 'support reminder failed', { task: taskId, err: errMsg(err) });
  }
  return true;
}
