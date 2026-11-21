import { migrate, type Db } from '@fir/core';

/**
 * The Director conversation of the website («Поручения» of the Пульт): the owner's lines (`POST /admin/say`), the commands (`POST /admin/command`) and the answers
 * of HQ, newest last. A small table in the HQ database; only the admin API writes it. Contract: `docs/admin-crm-api.md` («Поручения: история Директора»).
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS director_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  task_id INTEGER
);
`;
export type HistoryRole = 'owner' | 'command' | 'hq';
const KEEP = 2000;
const MAX_TEXT = 4000;

export function createDirectorHistory(db: Db, now: () => number) {
  migrate(db, SCHEMA);
  const ins = db.prepare('INSERT INTO director_history (at, role, text, task_id) VALUES (?, ?, ?, ?)');
  return {
    add(role: HistoryRole, text: string, taskId?: number): void {
      const t = text.trim();
      if (!t) return;
      ins.run(now(), role, t.slice(0, MAX_TEXT), taskId ?? null);
      db.prepare('DELETE FROM director_history WHERE id <= (SELECT MAX(id) FROM director_history) - ?').run(KEEP);
    },
    /** The last `limit` lines, oldest first (newest last). */
    list(limit: number): { id: number; at: string; role: HistoryRole; text: string; taskId: number | null }[] {
      const rows = db.prepare('SELECT id, at, role, text, task_id FROM director_history ORDER BY id DESC LIMIT ?').all(limit) as { id: number; at: number; role: HistoryRole; text: string; task_id: number | null }[];
      return rows.reverse().map((r) => ({ id: r.id, at: new Date(r.at).toISOString(), role: r.role, text: r.text, taskId: r.task_id }));
    },
  };
}
