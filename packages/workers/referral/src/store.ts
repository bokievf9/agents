import { migrate, type Db } from '@fir/core';

/** proposed: the client brought someone. paid: the referred client paid (owner's /paid). rewarded: the reward is applied. */
export type Status = 'proposed' | 'paid' | 'rewarded';
export const STATUSES: Status[] = ['proposed', 'paid', 'rewarded'];
export const STATUS_RU: Record<Status, string> = { proposed: 'ждём оплату', paid: 'оплатил, награда не применена', rewarded: 'награда применена' };
export const TRANSITIONS: Record<Status, Status[]> = { proposed: ['paid'], paid: ['rewarded'], rewarded: [] };

export const DAY = 86_400_000;
/** A referral waits this many days for the payment before the first reminder, then again every 7 days. */
export const REMIND_AFTER_DAYS = 3;
export const REMIND_EVERY_DAYS = 7;

export interface Referral {
  id: number;
  referrer: string;
  referred: string;
  leadId: number | null;
  /** `lead`: the form's source was `ref:<client>`. `owner`: the owner's /referral. */
  source: 'lead' | 'owner';
  status: Status;
  /** The reward as it was when the referral was recorded (the env value may change later). */
  reward: string;
  rewardRequested: boolean;
  createdAt: number;
  paidAt: number | null;
  rewardedAt: number | null;
  remindedAt: number | null;
}

interface Row {
  id: number; referrer: string; referred: string; lead_id: number | null; source: 'lead' | 'owner'; status: Status; reward: string;
  reward_requested: number; created_at: number; paid_at: number | null; rewarded_at: number | null; reminded_at: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rf_referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer TEXT NOT NULL,
  referred TEXT NOT NULL,
  lead_id INTEGER UNIQUE,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  reward TEXT NOT NULL,
  reward_requested INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  paid_at INTEGER,
  rewarded_at INTEGER,
  reminded_at INTEGER
);
CREATE INDEX IF NOT EXISTS rf_referrals_status ON rf_referrals (status);
`;

const map = (r: Row): Referral => ({
  id: r.id, referrer: r.referrer, referred: r.referred, leadId: r.lead_id, source: r.source, status: r.status, reward: r.reward,
  rewardRequested: r.reward_requested === 1, createdAt: r.created_at, paidAt: r.paid_at, rewardedAt: r.rewarded_at, remindedAt: r.reminded_at,
});

export interface NewReferral {
  referrer: string;
  referred: string;
  leadId?: number | null;
  source: 'lead' | 'owner';
}

const key = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

export class ReferralStore {
  constructor(private readonly db: Db, private readonly reward: string, private readonly now: () => number = Date.now) {
    migrate(db, SCHEMA);
  }

  get(id: number): Referral | undefined {
    const r = this.db.prepare('SELECT * FROM rf_referrals WHERE id = ?').get(id) as Row | undefined;
    return r ? map(r) : undefined;
  }

  all(): Referral[] {
    return (this.db.prepare('SELECT * FROM rf_referrals ORDER BY id').all() as Row[]).map(map);
  }

  /** Records a referral; the same lead, or the same pair while it is still open, is not recorded twice. */
  propose(n: NewReferral): { referral: Referral; created: boolean } {
    const referrer = n.referrer.trim();
    const referred = n.referred.trim();
    if (!referrer || !referred) throw new Error('Нужны оба имени: кто привёл и кого привёл');
    const leadId = n.leadId ?? null;
    const dup = this.all().find((r) => (leadId !== null && r.leadId === leadId) || (r.status === 'proposed' && key(r.referrer) === key(referrer) && key(r.referred) === key(referred)));
    if (dup) return { referral: dup, created: false };
    const info = this.db
      .prepare('INSERT INTO rf_referrals (referrer, referred, lead_id, source, reward, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(referrer, referred, leadId, n.source, this.reward, this.now());
    return { referral: this.get(Number(info.lastInsertRowid))!, created: true };
  }

  /** Throws on a transition the status machine does not allow. */
  transition(id: number, to: Status): Referral {
    const r = this.get(id);
    if (!r) throw new Error(`No referral ${id}`);
    if (!TRANSITIONS[r.status].includes(to)) throw new Error(`Illegal transition ${r.status} -> ${to}`);
    const now = this.now();
    this.db
      .prepare(`UPDATE rf_referrals SET status = ?, paid_at = CASE WHEN ? = 'paid' THEN ? ELSE paid_at END, rewarded_at = CASE WHEN ? = 'rewarded' THEN ? ELSE rewarded_at END WHERE id = ?`)
      .run(to, to, now, to, now, id);
    return this.get(id)!;
  }

  setRewardRequested(id: number, v: boolean): void {
    this.db.prepare('UPDATE rf_referrals SET reward_requested = ? WHERE id = ?').run(v ? 1 : 0, id);
  }

  /** Referrals still waiting for the payment, due for a reminder; marks them reminded. */
  takeReminders(now: number): Referral[] {
    const due = this.all().filter((r) => r.status === 'proposed' && now >= (r.remindedAt ?? r.createdAt + REMIND_AFTER_DAYS * DAY - REMIND_EVERY_DAYS * DAY) + REMIND_EVERY_DAYS * DAY);
    for (const r of due) this.db.prepare('UPDATE rf_referrals SET reminded_at = ? WHERE id = ?').run(now, r.id);
    return due;
  }

  stats(): { total: number; byStatus: Record<Status, number> } {
    const byStatus: Record<Status, number> = { proposed: 0, paid: 0, rewarded: 0 };
    const all = this.all();
    for (const r of all) byStatus[r.status]++;
    return { total: all.length, byStatus };
  }
}
