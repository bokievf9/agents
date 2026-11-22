import { migrate, type Db } from '@fir/core';

/**
 * The Director conversation of the website («Поручения» of the Shell): the owner's lines (`POST /admin/say`), the commands (`POST /admin/command`) and the answers
 * of HQ, newest last. A small table in the HQ database; only the admin API writes it. Contract: `docs/admin-crm-api.md` («Поручения: история Директора»).
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS director_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  task_id INTEGER,
  source TEXT NOT NULL DEFAULT 'site'
);
`;
export type HistoryRole = 'owner' | 'command' | 'hq';
/** Where the line came from: the site (`/admin/say`, `/admin/command`) or the owner's Telegram chat (P-17). */
export type HistorySource = 'site' | 'telegram';
const KEEP = 2000;
const MAX_TEXT = 4000;

export function createDirectorHistory(db: Db, now: () => number) {
  migrate(db, SCHEMA);
  // a table made before P-17 has no `source`
  if (!(db.prepare('PRAGMA table_info(director_history)').all() as { name: string }[]).some((c) => c.name === 'source')) db.exec("ALTER TABLE director_history ADD COLUMN source TEXT NOT NULL DEFAULT 'site'");
  const ins = db.prepare('INSERT INTO director_history (at, role, text, task_id, source) VALUES (?, ?, ?, ?, ?)');
  return {
    add(role: HistoryRole, text: string, taskId?: number, source: HistorySource = 'site'): void {
      const t = text.trim();
      if (!t) return;
      ins.run(now(), role, t.slice(0, MAX_TEXT), taskId ?? null, source);
      db.prepare('DELETE FROM director_history WHERE id <= (SELECT MAX(id) FROM director_history) - ?').run(KEEP);
    },
    /** The last `limit` lines, oldest first (newest last). */
    list(limit: number): { id: number; at: string; role: HistoryRole; text: string; taskId: number | null; source: HistorySource }[] {
      const rows = db.prepare('SELECT id, at, role, text, task_id, source FROM director_history ORDER BY id DESC LIMIT ?').all(limit) as { id: number; at: number; role: HistoryRole; text: string; task_id: number | null; source: HistorySource }[];
      return rows.reverse().map((r) => ({ id: r.id, at: new Date(r.at).toISOString(), role: r.role, text: r.text, taskId: r.task_id, source: r.source }));
    },
  };
}
