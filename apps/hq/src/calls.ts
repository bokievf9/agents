import { errMsg, formatSlot, log, migrate } from '@fir/core';
import type { Hq } from '@fir/hq';
import { postFromFirTech } from './cabinet.js';
import type { Bilingual, ClientMail } from './client-mail.js';
import type { SiteBooking, SiteBookingRequest } from './client/site-slots.js';

/**
 * Calls with leads (audit 2026-11-22, P-02, P-04, P-18, P-19, P-20): HQ keeps the booking of every call, wherever it was picked (the website chat, the site's
 * form, the client bot, the Пульт). A window HQ books itself goes to the site (`POST <site>/api/slots`) so it is not offered twice; when the site does not take
 * it, the Sales head gets «подтвердить созвон». The client hears the time, a confirmation and a move by his own channel (the cabinet thread and an email, the
 * client bot, the website chat); reminders go a day and an hour before (client and owner), in the market's time zone (`TZ`), once each (`remind_24`, `remind_1`).
 * Logs carry ids only; the client's name and contact stay in the database and in the owner's own lines.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS call_bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  source TEXT NOT NULL DEFAULT '',
  site_state TEXT NOT NULL DEFAULT '',
  remind_24 INTEGER,
  remind_1 INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS call_bookings_at ON call_bookings (state, at);
CREATE UNIQUE INDEX IF NOT EXISTS call_bookings_live ON call_bookings (lead_id) WHERE state != 'cancelled';
`;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export type CallState = 'pending' | 'confirmed' | 'cancelled';
/** `site`: the site booked it itself (its form); `booked`: HQ booked it on the site; `taken`, `not_accepted`, `failed`: the site has not got it. */
export type CallSite = 'site' | SiteBooking;
export type CallSource = 'chat' | 'bot' | 'form' | 'pult';

export interface CallBooking {
  id: number;
  leadId: number;
  at: number;
  state: CallState;
  source: string;
  site: CallSite | '';
  remind24: number | null;
  remind1: number | null;
  createdAt: number;
}
interface Row { id: number; lead_id: number; at: number; state: CallState; source: string; site_state: string; remind_24: number | null; remind_1: number | null; created_at: number }
const toBooking = (r: Row): CallBooking => ({ id: r.id, leadId: r.lead_id, at: r.at, state: r.state, source: r.source, site: r.site_state as CallSite | '', remind24: r.remind_24, remind1: r.remind_1, createdAt: r.created_at });

interface LeadRow { id: number; task_id: number; name: string; contact: string; lang: string | null; client_id: number | null }

export interface CallsDeps {
  hq: Hq;
  /** Books the window on the site (`siteBooker`); absent: nothing is sent and the Sales head confirms by hand. */
  siteBook?: ((b: SiteBookingRequest) => Promise<SiteBooking>) | undefined;
  /** Emails to cabinet clients (absent: the thread line only). */
  mail?: ClientMail | undefined;
  /** A plain line in the owner's inbox (no approval). */
  notifyOwner?: ((text: string) => void) | undefined;
}

export type Told = 'cabinet' | 'email' | 'telegram' | 'web';

export class Calls {
  /** The public client bot (a Telegram lead hears the time in his chat); set by the app when the bot runs. */
  client: { send(chatId: number, text: string): Promise<unknown> } | null = null;
  /** The website chat: the text waits for the visitor's next request in his session (true when the session exists). */
  webReply: ((sessionId: string, text: string) => boolean) | null = null;

  constructor(private readonly d: CallsDeps) {
    migrate(d.hq.db, SCHEMA);
  }

  private get db() {
    return this.d.hq.db;
  }

  private lead(id: number): LeadRow | undefined {
    try {
      return this.db.prepare('SELECT id, task_id, name, contact, lang, client_id FROM li_leads WHERE id = ?').get(id) as LeadRow | undefined;
    } catch {
      return undefined;
    }
  }

  /** The live booking of a lead (pending or confirmed), or null. */
  of(leadId: number): CallBooking | null {
    const r = this.db.prepare("SELECT * FROM call_bookings WHERE lead_id = ? AND state != 'cancelled'").get(leadId) as Row | undefined;
    return r ? toBooking(r) : null;
  }

  /** The windows HQ holds (pending or confirmed, in the future): the receptionist does not offer them again even when the site has not got them. */
  held(): number[] {
    return (this.db.prepare("SELECT at FROM call_bookings WHERE state != 'cancelled' AND at > ?").all(this.d.hq.now()) as { at: number }[]).map((r) => r.at);
  }

  /**
   * The site's free windows minus the ones HQ holds. A held call blocks the windows closer to it than its length plus the buffer (the owner's settings
   * `call_min`, default 30, and `call_buffer_min`, default 0), so with the defaults only the same window is blocked.
   */
  freeOf(slots: number[]): number[] {
    const num = (key: string, d: number) => {
      const raw = this.d.hq.setting(key);
      return raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : d;
    };
    const gap = (num('call_min', 30) + num('call_buffer_min', 0)) * 60_000;
    const held = this.held();
    return slots.filter((s) => !held.some((h) => Math.abs(h - s) < gap));
  }

  private when(at: number, lang: string | null | undefined): string {
    return formatSlot(at, this.d.hq.tz, lang === 'en' ? 'en' : 'ru');
  }

  /**
   * A call for a lead at `at`: a new booking, the same one again (nothing happens) or a move of the live one (`reschedule`). The window goes to the site unless the
   * site booked it itself (`siteBooked`: the site's form); a window the site did not take becomes a Sales task «подтвердить созвон». `tell`: the client hears the
   * time by his channel (the Пульт, P-18); the chat and the form already told him themselves.
   */
  async book(leadId: number, at: number, source: CallSource, o: { siteBooked?: boolean; tell?: boolean } = {}): Promise<{ booking: CallBooking; told: Told[]; moved: boolean } | null> {
    const lead = this.lead(leadId);
    if (!lead || !Number.isFinite(at)) return null;
    const live = this.of(leadId);
    if (live && live.at === at) return { booking: live, told: [], moved: false };
    if (live) {
      const r = await this.reschedule(leadId, at, source);
      return r ? { ...r, moved: true } : null;
    }
    const t = this.d.hq.now();
    const id = Number(this.db.prepare('INSERT INTO call_bookings (lead_id, at, state, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(leadId, at, 'pending', source, t, t).lastInsertRowid);
    this.setChosen(leadId, at);
    const site = await this.toSite(lead, at, source, o.siteBooked === true);
    this.db.prepare('UPDATE call_bookings SET site_state = ? WHERE id = ?').run(site, id);
    this.d.hq.log('sales-head', 'call_booked', 'lead', String(leadId), `${source} site:${site}`);
    if (site !== 'site' && site !== 'booked') this.confirmTask(lead, at, site);
    const told = o.tell ? await this.tell(lead, {
      ru: `Созвон назначен: ${this.when(at, 'ru')}. Менеджер подтвердит время, напоминание придёт за сутки и за час.`,
      en: `Your call is set for ${this.when(at, 'en')}. A manager will confirm the time; a reminder comes a day and an hour before.`,
    }, { ru: 'Созвон с Fir Tech назначен', en: 'Your call with Fir Tech is set' }) : [];
    return { booking: this.of(leadId)!, told, moved: false };
  }

  /** P-19: the owner confirms the time (Пульт). The client hears it by his channel. Null without a live booking. */
  async confirm(leadId: number): Promise<{ booking: CallBooking; told: Told[] } | null> {
    const lead = this.lead(leadId);
    const live = this.of(leadId);
    if (!lead || !live) return null;
    if (live.state === 'confirmed') return { booking: live, told: [] };
    this.db.prepare("UPDATE call_bookings SET state = 'confirmed', updated_at = ? WHERE id = ?").run(this.d.hq.now(), live.id);
    this.d.hq.log('owner', 'call_confirmed', 'lead', String(leadId));
    const told = await this.tell(lead, {
      ru: `Созвон подтверждён: ${this.when(live.at, 'ru')}. Напоминание придёт за сутки и за час.`,
      en: `Your call is confirmed: ${this.when(live.at, 'en')}. A reminder comes a day and an hour before.`,
    }, { ru: 'Созвон с Fir Tech подтверждён', en: 'Your call with Fir Tech is confirmed' });
    return { booking: this.of(leadId)!, told };
  }

  /** P-19: the call moves to another window (the reminders start again). The new window goes to the site; the client hears the new time. */
  async reschedule(leadId: number, at: number, source: CallSource = 'pult'): Promise<{ booking: CallBooking; told: Told[] } | null> {
    const lead = this.lead(leadId);
    const live = this.of(leadId);
    if (!lead || !live || !Number.isFinite(at)) return null;
    if (live.at === at) return { booking: live, told: [] };
    const t = this.d.hq.now();
    // `created_at` is when this window was set: a move to tomorrow evening gets only the hour reminder, like a fresh booking
    this.db.prepare("UPDATE call_bookings SET at = ?, state = 'pending', remind_24 = NULL, remind_1 = NULL, created_at = ?, updated_at = ? WHERE id = ?").run(at, t, t, live.id);
    this.setChosen(leadId, at);
    const site = await this.toSite(lead, at, source, false);
    this.db.prepare('UPDATE call_bookings SET site_state = ? WHERE id = ?').run(site, live.id);
    this.d.hq.log('owner', 'call_moved', 'lead', String(leadId), `site:${site}`);
    if (site !== 'booked') this.confirmTask(lead, at, site);
    const told = await this.tell(lead, {
      ru: `Созвон перенесён: ${this.when(at, 'ru')} (было ${this.when(live.at, 'ru')}). Напоминание придёт за сутки и за час.`,
      en: `Your call has moved to ${this.when(at, 'en')} (was ${this.when(live.at, 'en')}). A reminder comes a day and an hour before.`,
    }, { ru: 'Созвон с Fir Tech перенесён', en: 'Your call with Fir Tech has moved' });
    return { booking: this.of(leadId)!, told };
  }

  /** The call is off (the owner): the client hears it; no more reminders. */
  async cancel(leadId: number): Promise<{ told: Told[] } | null> {
    const lead = this.lead(leadId);
    const live = this.of(leadId);
    if (!lead || !live) return null;
    this.db.prepare("UPDATE call_bookings SET state = 'cancelled', updated_at = ? WHERE id = ?").run(this.d.hq.now(), live.id);
    this.d.hq.log('owner', 'call_cancelled', 'lead', String(leadId));
    const told = await this.tell(lead, {
      ru: `Созвон ${this.when(live.at, 'ru')} отменён. Напишите здесь, если хотите выбрать другое время.`,
      en: `The call on ${this.when(live.at, 'en')} is cancelled. Write here if you would like another time.`,
    }, { ru: 'Созвон с Fir Tech отменён', en: 'Your call with Fir Tech is cancelled' });
    return { told };
  }

  /**
   * P-20, from the due ticker: a day before and an hour before each live call, the client (thread and email, the bot or the chat) and the owner (inbox) hear it,
   * once each. A call booked less than a day ahead gets only the hour reminder; a reminder whose moment passed while HQ was down is not sent late. Returns how many
   * reminders went.
   */
  async tick(): Promise<number> {
    const now = this.d.hq.now();
    let sent = 0;
    const rows = this.db.prepare("SELECT * FROM call_bookings WHERE state != 'cancelled' AND at > ? AND (remind_24 IS NULL OR remind_1 IS NULL)").all(now - HOUR) as Row[];
    for (const r of rows) {
      try {
        if (r.remind_24 === null && now >= r.at - DAY) {
          // claimed first: a second ticker in flight sends nothing
          if (this.db.prepare('UPDATE call_bookings SET remind_24 = ? WHERE id = ? AND remind_24 IS NULL').run(now, r.id).changes !== 1) continue;
          if (r.created_at <= r.at - DAY && now < r.at - HOUR) {
            await this.remind(r, 'day');
            sent++;
          } else this.db.prepare('UPDATE call_bookings SET remind_24 = -1 WHERE id = ?').run(r.id);
        }
        if (r.remind_1 === null && now >= r.at - HOUR) {
          if (this.db.prepare('UPDATE call_bookings SET remind_1 = ? WHERE id = ? AND remind_1 IS NULL').run(now, r.id).changes !== 1) continue;
          if (now < r.at) {
            await this.remind(r, 'hour');
            sent++;
          } else this.db.prepare('UPDATE call_bookings SET remind_1 = -1 WHERE id = ?').run(r.id);
        }
      } catch (e) {
        log('warn', 'call reminder failed', { booking: r.id, err: errMsg(e) });
      }
    }
    return sent;
  }

  private async remind(r: Row, when: 'day' | 'hour'): Promise<void> {
    const lead = this.lead(r.lead_id);
    if (!lead) return;
    const day = when === 'day';
    await this.tell(lead, {
      ru: day ? `Напоминаем: завтра созвон с Fir Tech, ${this.when(r.at, 'ru')}.` : `Через час созвон с Fir Tech, ${this.when(r.at, 'ru')}.`,
      en: day ? `A reminder: your call with Fir Tech is tomorrow, ${this.when(r.at, 'en')}.` : `Your call with Fir Tech is in an hour, ${this.when(r.at, 'en')}.`,
    }, { ru: day ? 'Завтра созвон с Fir Tech' : 'Через час созвон с Fir Tech', en: day ? 'Your call with Fir Tech is tomorrow' : 'Your call with Fir Tech is in an hour' });
    this.d.notifyOwner?.(`${day ? 'Завтра' : 'Через час'} созвон: лид #${lead.id} ${lead.name || ''}, ${this.when(r.at, 'ru')} (время рынка, ${this.d.hq.tz})${r.state === 'pending' ? ', время ещё не подтверждено: Shell, лид, «Подтвердить созвон»' : ''}.`.replace(/\s+,/g, ','));
    this.d.hq.log('sales-head', 'call_reminded', 'lead', String(lead.id), when);
  }

  private setChosen(leadId: number, at: number): void {
    try {
      this.db.prepare('UPDATE li_leads SET chosen_slot = ? WHERE id = ?').run(at, leadId);
    } catch {
      /* no lead table (tests without Sales): the booking row is enough */
    }
  }

  private async toSite(lead: LeadRow, at: number, source: CallSource, siteBooked: boolean): Promise<CallSite> {
    if (siteBooked) return 'site';
    if (!this.d.siteBook) return 'not_accepted';
    const email = lead.client_id !== null ? (this.db.prepare('SELECT email FROM cab_clients WHERE id = ?').get(lead.client_id) as { email: string } | undefined)?.email : undefined;
    return this.d.siteBook({ at, leadId: lead.id, name: lead.name, contact: email ?? lead.contact, locale: lead.lang === 'en' ? 'en' : 'ru', source });
  }

  /** P-04: the site has not got the window: the Sales head (the owner) confirms the call by hand, one open task per lead. */
  private confirmTask(lead: LeadRow, at: number, site: CallSite): void {
    const hq = this.d.hq;
    if (hq.tasks({ dept: 'sales', open: true, limit: 500 }).some((t) => t.meta.action === 'call_confirm' && t.meta.leadId === lead.id)) return;
    const why = site === 'taken' ? 'окно на сайте уже занято' : site === 'failed' ? 'сайт не ответил' : 'сайт не принял бронь';
    hq.createTask({
      title: `Подтвердить созвон: лид #${lead.id}`, body: `${this.when(at, 'ru')} (${hq.tz}), ${why}.`, dept: 'sales', creator: 'head', priority: 1,
      meta: { action: 'call_confirm', leadId: lead.id, at, site },
    });
    hq.wake('sales-head', 'task');
  }

  /** The client's own channel: the cabinet thread (and an email) for a cabinet lead, the client bot for a Telegram lead, the website chat session otherwise. */
  private async tell(lead: LeadRow, text: Bilingual, subject: Bilingual): Promise<Told[]> {
    const told: Told[] = [];
    const en = lead.lang === 'en';
    if (lead.client_id !== null) {
      postFromFirTech(this.db, this.d.hq.now(), lead.client_id, lead.id, en ? text.en : text.ru);
      told.push('cabinet');
      if (this.d.mail && (await this.d.mail.send(lead.client_id, { subject, text }, 'call', `лид #${lead.id}`, `lead-${lead.id}`)) === 'email') told.push('email');
    }
    const meta = (this.d.hq.task(lead.task_id)?.meta.lead ?? {}) as { chatId?: unknown; sessionId?: unknown };
    if (typeof meta.chatId === 'number' && this.client) {
      try {
        await this.client.send(meta.chatId, en ? text.en : text.ru);
        told.push('telegram');
      } catch (e) {
        log('warn', 'call notice to the bot failed', { lead: lead.id, err: errMsg(e) });
      }
    } else if (!told.length && typeof meta.sessionId === 'string' && this.webReply?.(meta.sessionId, en ? text.en : text.ru)) told.push('web');
    return told;
  }
}
