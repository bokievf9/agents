import { errMsg, log, migrate, type Tools } from '@fir/core';
import type { Hq } from '@fir/hq';
import { ensureCabinetTables } from './cabinet.js';
import { EmailFailures, type EmailKind } from './email-failures.js';

/**
 * Emails to cabinet clients outside the documents (audit 2026-11-22, package «client will notice»): P-13 «новое сообщение в кабинете» (one email per thread
 * an hour, only for lines marked `notify`: a manager's or Support's answer, an agent's handoff; nothing when the client already read the thread), and the
 * one-off notices of calls (P-18, P-19, P-20) and of the closed project (P-16). The email never carries the message itself, only that there is one and the
 * link to the cabinet. Failures go to `EmailFailures` (one owner alert an hour). Marks (`client_marks`) make «once» and «once an hour» survive a restart.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS client_marks (
  key TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
`;
const HOUR = 3_600_000;

export interface Bilingual {
  ru: string;
  en: string;
}
export interface MailNotice {
  subject: Bilingual;
  text: Bilingual;
}
export type MailOutcome = 'email' | 'off' | 'failed' | 'no_client';

interface ClientRow { id: number; email: string; name: string; locale: string }

export interface ClientMailDeps {
  hq: Hq;
  /** The toolbox with `email.send` (Resend); without it the thread line is the only delivery (`off`). */
  tools: () => Tools;
  siteUrl: string;
}

const THREAD_TITLE: Record<'ru' | 'en', (thread: string) => string> = {
  ru: (t) => (t.startsWith('lead-') ? 'по вашей заявке' : t.startsWith('project-') ? 'по проекту' : t.startsWith('agent-') ? 'от вашего агента' : 'от поддержки'),
  en: (t) => (t.startsWith('lead-') ? 'about your request' : t.startsWith('project-') ? 'about your project' : t.startsWith('agent-') ? 'from your agent' : 'from support'),
};

export class ClientMail {
  constructor(private readonly d: ClientMailDeps) {
    ensureCabinetTables(d.hq.db);
    migrate(d.hq.db, SCHEMA);
  }

  private get db() {
    return this.d.hq.db;
  }

  private client(id: number): ClientRow | undefined {
    return this.db.prepare('SELECT id, email, name, locale FROM cab_clients WHERE id = ?').get(id) as ClientRow | undefined;
  }

  cabinetUrl(locale: string | null | undefined, thread?: string): string {
    return `${this.d.siteUrl.replace(/\/$/, '')}/${locale === 'en' ? 'en' : 'ru'}/cabinet${thread ? `?thread=${encodeURIComponent(thread)}` : ''}`;
  }

  /** When `key` was marked (ms), or null. */
  markedAt(key: string): number | null {
    return (this.db.prepare('SELECT at FROM client_marks WHERE key = ?').get(key) as { at: number } | undefined)?.at ?? null;
  }

  /** Marks `key` once: true the first time, false when it was marked already (the «once per project / per call» guard). */
  markOnce(key: string): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO client_marks (key, at) VALUES (?, ?)').run(key, this.d.hq.now()).changes === 1;
  }

  private setMark(key: string): void {
    this.db.prepare('INSERT INTO client_marks (key, at) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET at = excluded.at').run(key, this.d.hq.now());
  }

  /**
   * One email to a cabinet client (his language, his name, the cabinet link at the end). Never throws. `kind`/`ref` name the failure for the owner's hourly
   * alert (never the address or the text). `thread` points the link at that thread.
   */
  async send(clientId: number, n: MailNotice, kind: EmailKind, ref: string, thread?: string): Promise<MailOutcome> {
    const c = this.client(clientId);
    if (!c) return 'no_client';
    let tools: Tools;
    try {
      tools = this.d.tools();
    } catch (e) {
      log('warn', 'client mail tools unavailable', { err: errMsg(e) });
      return 'off';
    }
    if (!tools.can('email.send')) return 'off';
    const en = c.locale === 'en';
    const hello = en ? `Hello${c.name ? `, ${c.name}` : ''}!` : `Здравствуйте${c.name ? `, ${c.name}` : ''}!`;
    let why: string;
    try {
      const sent = await tools.email.send({
        to: c.email, subject: en ? n.subject.en : n.subject.ru,
        text: `${hello}\n\n${en ? n.text.en : n.text.ru}\n\n${en ? 'Open your cabinet' : 'Откройте личный кабинет'}: ${this.cabinetUrl(c.locale, thread)}\n\nFir Tech\nhello@firtech.pro`,
      });
      if (sent.ok) return 'email';
      why = String(sent.error);
    } catch (e) {
      why = errMsg(e).slice(0, 60);
    }
    new EmailFailures(this.d.hq).record(kind, ref, why || 'unknown');
    return 'failed';
  }

  /**
   * P-13, from the due ticker: the manager lines marked `notify` that the client has not had an email for. Per client and thread: nothing when he already read
   * the thread after the newest line; otherwise ONE email «новое сообщение в кабинете», at most one an hour for the thread (the lines that come within the hour
   * wait and go together with the next one). Returns how many emails went.
   */
  async messageTick(): Promise<number> {
    const groups = [
      ...(this.db.prepare(`SELECT client_id, 'lead-' || lead_id AS thread, MAX(at) AS last FROM cab_messages WHERE notify = 1 AND mailed = 0 AND "from" = 'manager' GROUP BY client_id, lead_id`).all() as { client_id: number; thread: string; last: number }[]),
      ...(this.db.prepare(`SELECT client_id, thread, MAX(at) AS last FROM cab_tmsgs WHERE notify = 1 AND mailed = 0 AND "from" IN ('manager', 'agent') GROUP BY client_id, thread`).all() as { client_id: number; thread: string; last: number }[]),
    ];
    let sent = 0;
    for (const g of groups) {
      const done = (state: 1 | 2) => {
        if (g.thread.startsWith('lead-')) this.db.prepare("UPDATE cab_messages SET mailed = ? WHERE client_id = ? AND lead_id = ? AND notify = 1 AND mailed = 0 AND at <= ?").run(state, g.client_id, Number(g.thread.slice(5)), g.last);
        else this.db.prepare('UPDATE cab_tmsgs SET mailed = ? WHERE client_id = ? AND thread = ? AND notify = 1 AND mailed = 0 AND at <= ?').run(state, g.client_id, g.thread, g.last);
      };
      const read = (this.db.prepare('SELECT at FROM cab_reads WHERE client_id = ? AND thread = ?').get(g.client_id, g.thread) as { at: number } | undefined)?.at ?? 0;
      if (read >= g.last) {
        done(1);
        continue;
      }
      const key = `mail:thread:${g.client_id}:${g.thread}`;
      const last = this.markedAt(key);
      if (last !== null && this.d.hq.now() - last < HOUR) continue;
      const how = await this.send(g.client_id, {
        subject: { ru: 'Новое сообщение в кабинете Fir Tech', en: 'A new message in your Fir Tech cabinet' },
        text: {
          ru: `В личном кабинете новое сообщение ${THREAD_TITLE.ru(g.thread)}. Ответить можно там же, в разделе «Сообщения».`,
          en: `There is a new message ${THREAD_TITLE.en(g.thread)} in your cabinet. You can answer there, in Messages.`,
        },
      }, 'message', `тред ${g.thread}`, g.thread);
      if (how === 'email') {
        this.setMark(key);
        sent++;
      }
      // a failed email is in the owner's hourly alert; it is not tried again on every tick (the next message of the thread gets its own try)
      done(how === 'failed' ? 2 : 1);
      this.d.hq.log('documents', 'message_mail', 'client', String(g.client_id), `${g.thread} ${how}`);
    }
    return sent;
  }
}
