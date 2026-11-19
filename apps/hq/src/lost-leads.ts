import { errMsg, log, migrate } from '@fir/core';
import type { Hq } from '@fir/hq';

/**
 * Leads, chat messages and audit requests that were ACCEPTED (the visitor got a normal answer, HTTP 200) but failed before the owner could see
 * them. Each one is an `activity` row of kind `lost_lead` (reason only, never client text) plus a row here (with the contact, so the owner can
 * write to the person), and the owner hears about them in ONE summary an hour: «N обращений не доставлены, причина…».
 */
export type LostSource = 'lead' | 'chat' | 'bot' | 'audit';
export const SOURCE_RU: Record<LostSource, string> = { lead: 'форма сайта', chat: 'веб-чат', bot: 'клиентский бот', audit: 'заявка на аудит' };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lost_leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  source TEXT NOT NULL,
  reason TEXT NOT NULL,
  contact TEXT NOT NULL DEFAULT '',
  ref TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  alerted INTEGER NOT NULL DEFAULT 0
);
`;

const HOUR = 3_600_000;
/** A lead task nobody took or finished this long after it came in counts as lost until it is handled. */
export const STALE_LEAD_MS = 15 * 60_000;
const ALERT_AT = 'lost_leads_alert_at';

const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10;
  const m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};

export interface LostInfo {
  /** How to reach the person (shown to the owner in the summary). */
  contact?: string;
  /** A short reference: «задача #12», a session id. */
  ref?: string;
  /** What the person wrote (kept in the table for the owner, never in the activity row or the logs). */
  text?: string;
}

/**
 * `POST /lead` creates the Sales task through this: when the task cannot be created the form gets its error as before, but the person's
 * contact and words are kept (kind `lost_lead`) and the owner hears about it in the hourly summary.
 */
export function guardedLead<L extends { contact: string; message?: string }, R = number>(lost: LostLeads, create: (lead: L) => R): (lead: L) => Promise<R> {
  return (lead) => {
    try {
      return Promise.resolve(create(lead));
    } catch (e) {
      lost.record('lead', `задача продаж не создана: ${errMsg(e)}`, { contact: lead.contact, ...(lead.message ? { text: lead.message } : {}) });
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  };
}

export class LostLeads {
  constructor(private readonly hq: Hq) {
    migrate(hq.db, SCHEMA);
  }

  /** What the owner can still recover: the unsent requests, newest last (the person's own words stay here, not in the log). */
  recent(limit = 20): { at: number; source: LostSource; reason: string; contact: string; ref: string; text: string }[] {
    return this.hq.db.prepare('SELECT at, source, reason, contact, ref, text FROM lost_leads ORDER BY id DESC LIMIT ?').all(limit) as { at: number; source: LostSource; reason: string; contact: string; ref: string; text: string }[];
  }

  /** Never throws: a failure of the safety net must not break the path it watches. */
  record(source: LostSource, reason: string, info: LostInfo = {}): void {
    try {
      const why = reason.replace(/\s+/g, ' ').trim().slice(0, 160) || 'причина не указана';
      this.hq.log('hq', 'lost_lead', source, info.ref, why);
      this.hq.db.prepare('INSERT INTO lost_leads (at, source, reason, contact, ref, text) VALUES (?, ?, ?, ?, ?, ?)').run(this.hq.now(), source, why, (info.contact ?? '').slice(0, 120), (info.ref ?? '').slice(0, 60), (info.text ?? '').slice(0, 1000));
      log('warn', 'lost lead', { source, reason: why });
    } catch (e) {
      log('error', 'lost lead not recorded', { err: errMsg(e) });
    }
  }

  /** The line the Director adds to the morning summary: requests lost in the last day. Null when none. */
  summaryLine(): string | null {
    const n = (this.hq.db.prepare('SELECT COUNT(*) c FROM lost_leads WHERE at >= ?').get(this.hq.now() - 24 * HOUR) as { c: number }).c;
    return n > 0 ? `Обращений не дошло до вас за сутки: ${n}. Контакты и причины в алерте, слова людей в таблице lost_leads.` : null;
  }

  /** Lead tasks of Sales that nobody took or finished for 15 minutes (a paused department, a stuck head, a block): recorded once each. */
  watchStale(): number {
    let n = 0;
    for (const t of this.hq.tasks({ dept: 'sales', open: true, limit: 500 })) {
      if (t.meta.action !== 'lead' || t.meta.lostMarked === true || t.tags.includes('drill')) continue;
      if (!['inbox', 'assigned', 'blocked'].includes(t.status) || this.hq.now() - t.createdAt < STALE_LEAD_MS) continue;
      const lead = (t.meta.lead ?? {}) as { contact?: unknown };
      this.record('lead', `заявка не обработана ${Math.floor((this.hq.now() - t.createdAt) / 60_000)} мин (статус задачи: ${t.status})`, { ...(typeof lead.contact === 'string' ? { contact: lead.contact } : {}), ref: `задача #${t.id}` });
      this.hq.setMeta(t.id, { lostMarked: true });
      n++;
    }
    return n;
  }

  /** At most once an hour: one alert with the count, the reasons and the contacts. Returns how many items it covered. */
  async flush(): Promise<number> {
    const last = Number(this.hq.setting(ALERT_AT) || '0');
    if (this.hq.now() - last < HOUR) return 0;
    const rows = this.hq.db.prepare('SELECT * FROM lost_leads WHERE alerted = 0 ORDER BY id').all() as { id: number; source: LostSource; reason: string; contact: string; ref: string }[];
    if (!rows.length) return 0;
    this.hq.db.prepare('UPDATE lost_leads SET alerted = 1 WHERE alerted = 0').run();
    this.hq.setSetting(ALERT_AT, String(this.hq.now()));
    const byReason = new Map<string, number>();
    for (const r of rows) byReason.set(`${SOURCE_RU[r.source] ?? r.source}: ${r.reason}`, (byReason.get(`${SOURCE_RU[r.source] ?? r.source}: ${r.reason}`) ?? 0) + 1);
    const reasons = [...byReason].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, c]) => (c > 1 ? `${k} (${c})` : k));
    const contacts = [...new Set(rows.map((r) => r.contact).filter(Boolean))].slice(0, 5);
    const n = rows.length;
    await this.hq.alert(
      `${n} ${plural(n, 'обращение не доставлено', 'обращения не доставлены', 'обращений не доставлены')} владельцу, причина: ${reasons.join('; ')}.${contacts.length ? ` Связаться с людьми: ${contacts.join(', ')}.` : ''} Подробности: задачи продаж (/tasks sales) и журнал.`,
    );
    return n;
  }
}
