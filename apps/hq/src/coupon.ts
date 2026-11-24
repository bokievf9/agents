import { errMsg, log, migrate, type Db } from '@fir/core';
import type { Hq } from '@fir/hq';
import type { ClientMail, MailOutcome } from './client-mail.js';

/**
 * The cabinet coupon (owner 2026-11-24, contract `coupon/contract.md`): one coupon `cabinet10` per client account, `percent` off the ONE-TIME part of the first
 * order, valid 30 days from the account's creation. HQ is the source of truth; the site only shows it and sends `brief.coupon` with a lead. The coupon is issued
 * when the account is made (`ensure`, also lazily on the first payload read of an account younger than 30 days), claimed by the lead whose brief carried it,
 * carried by that lead's КП as one discount line (presales `withCoupon`) and marked used when the client accepts that КП. A day after sign-up, a client with no
 * lead gets one reminder letter. Contract and payload: `docs/admin-crm-api.md`, «Купон за кабинет».
 */
export const COUPON_CODE = 'cabinet10';
export const COUPON_DAYS = 30;
export const COUPON_PERCENT_SETTING = 'coupon.percent';
export const DEFAULT_COUPON_PERCENT = 10;
const DAY = 86_400_000;
/** The reminder goes to accounts at most this old: an account older than that never gets a burst of letters when the feature goes live. */
const REMIND_MAX_AGE = 3 * DAY;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS client_coupons (
  client_id INTEGER PRIMARY KEY,
  code TEXT NOT NULL,
  percent INTEGER NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  lead_id INTEGER,
  claimed_lead_id INTEGER,
  reminded_at INTEGER
);
`;

/** The percent in force for new coupons: `settings.coupon.percent` (1..50), else 10. */
export const couponPercent = (hq: Pick<Hq, 'setting'>): number => {
  const n = Number(hq.setting(COUPON_PERCENT_SETTING));
  return Number.isInteger(n) && n >= 1 && n <= 50 ? n : DEFAULT_COUPON_PERCENT;
};

export interface CouponView { code: string; percent: number; expiresAt: string; used: boolean; usedAt?: string; usedLeadId?: number }
interface Row { client_id: number; code: string; percent: number; issued_at: number; expires_at: number; used_at: number | null; lead_id: number | null; claimed_lead_id: number | null; reminded_at: number | null }

const ready = new WeakSet<object>();

export class Coupons {
  constructor(private readonly db: Db, private readonly now: () => number, private readonly percent: () => number = () => DEFAULT_COUPON_PERCENT) {
    if (!ready.has(db)) {
      migrate(db, SCHEMA);
      ready.add(db);
    }
  }

  private row(clientId: number): Row | undefined {
    return this.db.prepare('SELECT * FROM client_coupons WHERE client_id = ?').get(clientId) as Row | undefined;
  }

  /**
   * Issues the coupon when the account has none and is younger than 30 days (the account's creation is the start of the term); an older account without one
   * gets nothing. Idempotent. Returns the row or undefined.
   */
  ensure(clientId: number): Row | undefined {
    const have = this.row(clientId);
    if (have) return have;
    const c = this.db.prepare('SELECT created_at FROM cab_clients WHERE id = ?').get(clientId) as { created_at: number } | undefined;
    if (!c) return undefined;
    const expires = c.created_at + COUPON_DAYS * DAY;
    if (expires <= this.now()) return undefined;
    this.db.prepare('INSERT OR IGNORE INTO client_coupons (client_id, code, percent, issued_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(clientId, COUPON_CODE, this.percent(), this.now(), expires);
    return this.row(clientId);
  }

  /** The payload field `coupon` of the cabinet and the admin client payload: `null` when the client has no coupon. */
  view(clientId: number): CouponView | null {
    const r = this.ensure(clientId);
    if (!r) return null;
    return {
      code: r.code, percent: r.percent, expiresAt: new Date(r.expires_at).toISOString(), used: r.used_at !== null,
      ...(r.used_at !== null ? { usedAt: new Date(r.used_at).toISOString() } : {}),
      ...(r.used_at !== null && r.lead_id !== null ? { usedLeadId: r.lead_id } : {}),
    };
  }

  /** The lead's brief carried the coupon: valid (not used, not expired) means the lead claims it. False when there is nothing to claim. */
  claim(clientId: number, leadId: number): boolean {
    const r = this.ensure(clientId);
    if (!r || r.used_at !== null || r.expires_at <= this.now()) return false;
    this.db.prepare('UPDATE client_coupons SET claimed_lead_id = ? WHERE client_id = ?').run(leadId, clientId);
    return true;
  }

  /** The percent a lead's КП applies: the coupon is claimed by THIS lead and still unused; else null. */
  forLead(leadId: number): number | null {
    const r = this.db.prepare('SELECT percent FROM client_coupons WHERE claimed_lead_id = ? AND used_at IS NULL').get(leadId) as { percent: number } | undefined;
    return r?.percent ?? null;
  }

  /** The client accepted the КП that carried the coupon. False when it was used already. */
  markUsed(clientId: number, leadId: number | null): boolean {
    return this.db.prepare('UPDATE client_coupons SET used_at = ?, lead_id = ? WHERE client_id = ? AND used_at IS NULL').run(this.now(), leadId, clientId).changes === 1;
  }

  /**
   * From the due ticker: a day after sign-up, a client with no lead and an unused, unexpired coupon gets ONE letter «Ваш купон 10 % ждёт». `reminded_at` is
   * written before the send (a restart never doubles it). The letter follows the client's project-mail choice (`ClientMail.send`). Returns how many went.
   */
  async remindTick(mail: ClientMail | undefined, siteUrl: string): Promise<number> {
    if (!mail) return 0;
    const t = this.now();
    for (const c of this.db.prepare('SELECT id FROM cab_clients WHERE created_at <= ? AND created_at > ?').all(t - DAY, t - REMIND_MAX_AGE) as { id: number }[]) this.ensure(c.id);
    const hasLeads = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'li_leads'").get() !== undefined
      && (this.db.prepare('PRAGMA table_info(li_leads)').all() as { name: string }[]).some((x) => x.name === 'client_id');
    const rows = this.db.prepare(
      `SELECT k.client_id, k.percent, k.expires_at, c.locale FROM client_coupons k JOIN cab_clients c ON c.id = k.client_id
       WHERE k.reminded_at IS NULL AND k.used_at IS NULL AND k.expires_at > ? AND c.created_at <= ? AND c.created_at > ?
       ${hasLeads ? 'AND NOT EXISTS (SELECT 1 FROM li_leads l WHERE l.client_id = k.client_id)' : ''} ORDER BY k.client_id`,
    ).all(t, t - DAY, t - REMIND_MAX_AGE) as { client_id: number; percent: number; expires_at: number; locale: string }[];
    let sent = 0;
    const base = siteUrl.replace(/\/$/, '');
    for (const r of rows) {
      try {
        if (this.db.prepare('UPDATE client_coupons SET reminded_at = ? WHERE client_id = ? AND reminded_at IS NULL').run(t, r.client_id).changes !== 1) continue;
        const lang = r.locale === 'en' ? 'en' : 'ru';
        const d = new Date(r.expires_at);
        const until = `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        const link = `${base}/${lang}/builder`;
        const how: MailOutcome = await mail.send(r.client_id, {
          subject: { ru: `Ваш купон ${r.percent} % ждёт`, en: `Your ${r.percent}% coupon is waiting` },
          text: {
            ru: `Ваш купон ${r.percent} % на первый заказ действует до ${until}. Соберите проект в конструкторе: ${link}\nСкидка попадёт в коммерческое предложение отдельной строкой.`,
            en: `Your ${r.percent}% coupon for the first order is valid until ${until}. Put your project together in the builder: ${link}\nThe discount appears in the proposal as a separate line.`,
          },
        }, 'journey', `купон клиента ${r.client_id}`);
        if (how === 'email') sent++;
      } catch (e) {
        log('warn', 'coupon reminder failed', { client: r.client_id, err: errMsg(e) });
      }
    }
    return sent;
  }
}
