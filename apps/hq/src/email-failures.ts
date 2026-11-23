import { errMsg, log, migrate } from '@fir/core';
import type { Hq } from '@fir/hq';

/**
 * P-07 (audit 2026-11-22): an email to a client that did not go (Resend down, refused, over the daily cap) used to be a journal line only, so the owner
 * believed the КП, the contract, the invoice or the act had reached the client's mailbox. Each failure is a row here (the kind and a reference such as
 * «КП-12» or «лид #5», the reason code; never the address or the text) and the owner gets ONE summary alert an hour, the way lost leads do. The document
 * itself carries the mark (`cab_documents.mail_state = 'failed'`) and can be sent again from the Shell.
 */
export type EmailKind = 'quote' | 'contract' | 'invoice' | 'act' | 'other' | 'stage' | 'clarify' | 'message' | 'payment' | 'call' | 'review' | 'news' | 'recommendation' | 'journey';
const KIND_RU: Record<EmailKind, string> = {
  quote: 'КП', contract: 'договор', invoice: 'счёт', act: 'акт', other: 'документ', stage: 'этап проекта', clarify: 'уточняющие вопросы',
  message: 'новое сообщение', payment: 'оплата получена', call: 'созвон', review: 'просьба об отзыве', news: 'новости', recommendation: 'рекомендации', journey: 'путь заявки',
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS email_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  alerted INTEGER NOT NULL DEFAULT 0
);
`;
const HOUR = 3_600_000;
const ALERT_AT = 'email_failures_alert_at';

export class EmailFailures {
  constructor(private readonly hq: Hq) {
    migrate(hq.db, SCHEMA);
  }

  /** Never throws: the safety net must not break the delivery it watches. `reason` is a short code (`http_500`, `rate_limited`), never client data. */
  record(kind: EmailKind, ref: string, reason: string): void {
    try {
      const why = reason.replace(/\s+/g, ' ').trim().slice(0, 80) || 'unknown';
      this.hq.db.prepare('INSERT INTO email_failures (at, kind, ref, reason) VALUES (?, ?, ?, ?)').run(this.hq.now(), kind, ref.slice(0, 60), why);
      this.hq.log('documents', 'email_failed', kind, ref.slice(0, 60), why);
    } catch (e) {
      log('error', 'email failure not recorded', { err: errMsg(e) });
    }
  }

  /** At most once an hour: one alert with the count, what did not go and the reasons. Returns how many failures it covered. */
  async flush(): Promise<number> {
    const last = Number(this.hq.setting(ALERT_AT) || '0');
    if (this.hq.now() - last < HOUR) return 0;
    const rows = this.hq.db.prepare('SELECT id, kind, ref, reason FROM email_failures WHERE alerted = 0 ORDER BY id').all() as { id: number; kind: EmailKind; ref: string; reason: string }[];
    if (!rows.length) return 0;
    this.hq.db.prepare('UPDATE email_failures SET alerted = 1 WHERE alerted = 0').run();
    this.hq.setSetting(ALERT_AT, String(this.hq.now()));
    const what = [...new Set(rows.map((r) => `${KIND_RU[r.kind] ?? r.kind}${r.ref ? ` ${r.ref}` : ''}`))].slice(0, 6);
    const reasons = [...new Set(rows.map((r) => r.reason))].slice(0, 3);
    await this.hq.alert(
      `Письма клиентам не ушли: ${rows.length} (${what.join(', ')}${rows.length > what.length ? ', …' : ''}), причина: ${reasons.join(', ')}. `
      + 'Документы и строки в треде у клиента есть, почты нет. Отправить снова: Shell, документ клиента, «Отправить снова» (POST /admin/crm/cabinet-docs/:id {"action":"resend"}).',
      { kind: 'email_failed', short: `Письма клиентам не ушли: ${rows.length} (${what.slice(0, 3).join(', ')}). Отправить снова в Shell.` },
    );
    return rows.length;
  }

  /** Failures of the last day not sent again yet (the morning summary line). Null when none. */
  summaryLine(): string | null {
    const n = (this.hq.db.prepare('SELECT COUNT(*) c FROM email_failures WHERE at >= ?').get(this.hq.now() - 24 * HOUR) as { c: number }).c;
    return n > 0 ? `Писем клиентам не ушло за сутки: ${n} (подробности в алерте, «Отправить снова» в Shell).` : null;
  }
}
