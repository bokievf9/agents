import { migrate, type Db } from '@fir/core';
import { csvRecords } from './csv.js';

export type Status = 'new' | 'proposed' | 'sent' | 'replied' | 'no_reply' | 'skipped';
export const STATUSES: Status[] = ['new', 'proposed', 'sent', 'replied', 'no_reply', 'skipped'];
export const STATUS_RU: Record<Status, string> = {
  new: 'новые',
  proposed: 'на карточке',
  sent: 'отправлено',
  replied: 'ответили',
  no_reply: 'без ответа',
  skipped: 'пропущено',
};

/** new → proposed → sent → replied / no_reply / skipped. A late reply may still arrive after no_reply. */
export const TRANSITIONS: Record<Status, Status[]> = {
  new: ['proposed', 'skipped'],
  proposed: ['sent', 'skipped'],
  sent: ['replied', 'no_reply', 'skipped'],
  no_reply: ['replied'],
  replied: [],
  skipped: [],
};

/** What the pending draft is: the first message, a follow-up (3 and 7 days after sending) or an answer to a reply. */
export type DraftKind = 'first' | 'followup' | 'reply';

export const DAY = 86_400_000;
/** Follow-up i (0-based) is due this many days after `sent`; no_reply this many days after `sent`. */
export const FOLLOWUP_DAYS = [3, 7] as const;
export const NO_REPLY_DAYS = 10;

/** Niche priority from COMPANY.md: learning centres, Instagram/Telegram shops, beauty and dental, food; then reserve. */
const NICHE_ORDER: RegExp[] = [/учебн|репетитор|курс/i, /магазин/i, /салон|барбер|стомат/i, /доставк|кафе/i, /авто/i, /фитнес/i, /турагент|туризм/i, /недвиж/i];
export function nicheRank(niche: string): number {
  const i = NICHE_ORDER.findIndex((re) => re.test(niche));
  return i < 0 ? NICHE_ORDER.length : i;
}

export interface Prospect {
  id: number;
  extId: string;
  niche: string;
  city: string;
  name: string;
  website: string;
  instagram: string;
  telegram: string;
  phone: string;
  noticed: string;
  offer: string;
  hook: string;
  source: string;
  status: Status;
  draft: string | null;
  draftKind: DraftKind | null;
  followups: number;
  createdAt: number;
  proposedAt: number | null;
  sentAt: number | null;
  repliedAt: number | null;
  /** The first message as the owner sent it (the follow-up and reply drafts build on it). */
  sentText: string | null;
}

interface Row {
  id: number; ext_id: string; niche: string; city: string; name: string; website: string; instagram: string;
  telegram: string; phone: string; noticed: string; offer: string; hook: string; source: string; status: Status;
  draft: string | null; draft_kind: DraftKind | null; followups: number; created_at: number;
  proposed_at: number | null; sent_at: number | null; replied_at: number | null; sent_text: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS prospects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ext_id TEXT NOT NULL DEFAULT '',
  niche TEXT NOT NULL,
  city TEXT NOT NULL,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  website TEXT NOT NULL DEFAULT '',
  instagram TEXT NOT NULL DEFAULT '',
  telegram TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  noticed TEXT NOT NULL DEFAULT '',
  offer TEXT NOT NULL DEFAULT '',
  hook TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new',
  draft TEXT,
  draft_kind TEXT,
  followups INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  proposed_at INTEGER,
  sent_at INTEGER,
  replied_at INTEGER,
  sent_text TEXT
);
CREATE INDEX IF NOT EXISTS prospects_status ON prospects (status);
`;

const map = (r: Row): Prospect => ({
  id: r.id, extId: r.ext_id, niche: r.niche, city: r.city, name: r.name, website: r.website, instagram: r.instagram,
  telegram: r.telegram, phone: r.phone, noticed: r.noticed, offer: r.offer, hook: r.hook, source: r.source,
  status: r.status, draft: r.draft, draftKind: r.draft_kind, followups: r.followups, createdAt: r.created_at,
  proposedAt: r.proposed_at, sentAt: r.sent_at, repliedAt: r.replied_at, sentText: r.sent_text,
});

export const nameKey = (name: string, city: string): string =>
  `${name}|${city}`.toLowerCase().replace(/\s+/g, ' ').trim();

export interface ImportResult {
  added: number;
  duplicates: number;
  invalid: number;
}

export class ProspectStore {
  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {
    migrate(db, SCHEMA);
  }

  /** Loads the prospects CSV (columns as in docs/prospects-*.csv). Dedupe by name + city; safe to run again. */
  importCsv(text: string): ImportResult {
    const res: ImportResult = { added: 0, duplicates: 0, invalid: 0 };
    const ins = this.db.prepare(
      `INSERT OR IGNORE INTO prospects (ext_id, niche, city, name, name_key, website, instagram, telegram, phone, noticed, offer, hook, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      for (const r of csvRecords(text)) {
        const name = r['название'] ?? '';
        const city = r['город'] ?? '';
        if (!name || !city) {
          res.invalid++;
          continue;
        }
        const info = ins.run(
          r['id'] ?? '', r['ниша'] ?? '', city, name, nameKey(name, city), r['сайт'] ?? '', r['instagram'] ?? '',
          r['telegram'] ?? '', r['телефон'] ?? '', r['что заметил'] ?? '', r['что предложить'] ?? '',
          r['зацепка для первого сообщения'] ?? '', r['источник'] ?? '', this.now(),
        );
        if (info.changes) res.added++;
        else res.duplicates++;
      }
    })();
    return res;
  }

  get(id: number): Prospect | undefined {
    const r = this.db.prepare('SELECT * FROM prospects WHERE id = ?').get(id) as Row | undefined;
    return r ? map(r) : undefined;
  }

  /** Next `limit` new prospects: niche priority first, then CSV order. */
  pickNew(limit: number): Prospect[] {
    const all = (this.db.prepare("SELECT * FROM prospects WHERE status = 'new' ORDER BY id").all() as Row[]).map(map);
    return all.sort((a, b) => nicheRank(a.niche) - nicheRank(b.niche) || a.id - b.id).slice(0, limit);
  }

  /** Throws on a transition the status machine does not allow. */
  transition(id: number, to: Status): Prospect {
    const p = this.get(id);
    if (!p) throw new Error(`No prospect ${id}`);
    if (!TRANSITIONS[p.status].includes(to)) throw new Error(`Illegal transition ${p.status} -> ${to}`);
    const now = this.now();
    this.db
      .prepare(
        `UPDATE prospects SET status = ?,
           proposed_at = CASE WHEN ? = 'proposed' THEN ? ELSE proposed_at END,
           sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END,
           replied_at = CASE WHEN ? = 'replied' THEN ? ELSE replied_at END
         WHERE id = ?`,
      )
      .run(to, to, now, to, now, to, now, id);
    return this.get(id)!;
  }

  setDraft(id: number, kind: DraftKind, text: string): void {
    this.db.prepare('UPDATE prospects SET draft = ?, draft_kind = ? WHERE id = ?').run(text, kind, id);
  }

  setSentText(id: number, text: string): void {
    this.db.prepare('UPDATE prospects SET sent_text = ? WHERE id = ?').run(text, id);
  }

  editDraft(id: number, text: string): void {
    this.db.prepare('UPDATE prospects SET draft = ? WHERE id = ? AND draft_kind IS NOT NULL').run(text, id);
  }

  clearDraft(id: number): void {
    this.db.prepare('UPDATE prospects SET draft = NULL, draft_kind = NULL WHERE id = ?').run(id);
  }

  /** Counts a follow-up as proposed (stage 1 or 2). */
  bumpFollowups(id: number): void {
    this.db.prepare('UPDATE prospects SET followups = followups + 1 WHERE id = ?').run(id);
  }

  /** Sent and silent: follow-up 1 after 3 days, follow-up 2 after 7 days (since `sent`). */
  dueFollowups(now: number): Prospect[] {
    const rows = this.db.prepare("SELECT * FROM prospects WHERE status = 'sent' AND sent_at IS NOT NULL ORDER BY sent_at").all() as Row[];
    return rows.map(map).filter((p) => {
      const days = FOLLOWUP_DAYS[p.followups];
      return days !== undefined && now >= p.sentAt! + days * DAY;
    });
  }

  /** Both follow-ups went out and nobody answered: no_reply. Returns how many were closed. */
  expireNoReply(now: number): number {
    const rows = this.db.prepare("SELECT * FROM prospects WHERE status = 'sent' AND sent_at IS NOT NULL").all() as Row[];
    let n = 0;
    for (const p of rows.map(map)) {
      if (p.followups >= FOLLOWUP_DAYS.length && now >= p.sentAt! + NO_REPLY_DAYS * DAY) {
        this.transition(p.id, 'no_reply');
        this.clearDraft(p.id);
        n++;
      }
    }
    return n;
  }

  stats(): { total: number; byStatus: Record<Status, number>; byNiche: { niche: string; total: number; byStatus: Record<Status, number> }[] } {
    const empty = (): Record<Status, number> => ({ new: 0, proposed: 0, sent: 0, replied: 0, no_reply: 0, skipped: 0 });
    const byStatus = empty();
    const niches = new Map<string, { niche: string; total: number; byStatus: Record<Status, number> }>();
    const rows = this.db.prepare('SELECT niche, status, COUNT(*) AS n FROM prospects GROUP BY niche, status').all() as { niche: string; status: Status; n: number }[];
    let total = 0;
    for (const r of rows) {
      total += r.n;
      byStatus[r.status] += r.n;
      const g = niches.get(r.niche) ?? { niche: r.niche, total: 0, byStatus: empty() };
      g.total += r.n;
      g.byStatus[r.status] += r.n;
      niches.set(r.niche, g);
    }
    return { total, byStatus, byNiche: [...niches.values()].sort((a, b) => nicheRank(a.niche) - nicheRank(b.niche)) };
  }

  /** Case-insensitive (Cyrillic too: SQLite lower() is ASCII only, so this filters in JS; the base is small). */
  find(query: string, limit = 10): Prospect[] {
    const q = query.toLowerCase().trim();
    if (!q) return [];
    const rows = this.db.prepare('SELECT * FROM prospects ORDER BY id').all() as Row[];
    return rows
      .map(map)
      .filter((p) => [p.name, p.city, p.niche, p.extId, p.hook, p.phone, p.instagram, p.telegram].some((f) => f.toLowerCase().includes(q)))
      .slice(0, limit);
  }
}
