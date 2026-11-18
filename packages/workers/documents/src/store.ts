import { migrate, type Db } from '@fir/core';
import type { DocType } from './templates.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bo_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  client TEXT NOT NULL,
  project_id INTEGER,
  version INTEGER NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  task_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bo_documents_key ON bo_documents (type, client, version);
`;

/** pending: waits for the owner; approved: he approved it and sends it himself; rejected. */
export type DocStatus = 'pending' | 'approved' | 'rejected';

export interface DocRow {
  id: number;
  type: DocType;
  client: string;
  projectId: number | null;
  version: number;
  text: string;
  status: DocStatus;
  taskId: number | null;
  createdAt: number;
}

interface Row {
  id: number; type: string; client: string; project_id: number | null; version: number; text: string; status: string; task_id: number | null; created_at: number;
}
const to = (r: Row): DocRow => ({
  id: r.id, type: r.type as DocType, client: r.client, projectId: r.project_id, version: r.version, text: r.text, status: r.status as DocStatus,
  taskId: r.task_id, createdAt: r.created_at,
});

export class DocStore {
  constructor(private readonly db: Db, private readonly now: () => number) {
    migrate(db, SCHEMA);
  }

  /** A new version of the same document for the same client (1, 2, ...). */
  add(d: { type: DocType; client: string; projectId: number | null; text: string; taskId: number | null }): DocRow {
    const v = (this.db.prepare('SELECT COALESCE(MAX(version), 0) v FROM bo_documents WHERE type = ? AND client = ?').get(d.type, d.client) as { v: number }).v + 1;
    const r = this.db
      .prepare('INSERT INTO bo_documents (type, client, project_id, version, text, task_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(d.type, d.client, d.projectId, v, d.text, d.taskId, this.now());
    return this.get(Number(r.lastInsertRowid))!;
  }

  get(id: number): DocRow | undefined {
    const r = this.db.prepare('SELECT * FROM bo_documents WHERE id = ?').get(id) as Row | undefined;
    return r ? to(r) : undefined;
  }

  setStatus(id: number, status: DocStatus, text?: string): void {
    if (text !== undefined) this.db.prepare('UPDATE bo_documents SET status = ?, text = ? WHERE id = ?').run(status, text, id);
    else this.db.prepare('UPDATE bo_documents SET status = ? WHERE id = ?').run(status, id);
  }

  pending(): DocRow[] {
    return (this.db.prepare("SELECT * FROM bo_documents WHERE status = 'pending' ORDER BY id").all() as Row[]).map(to);
  }

  all(): DocRow[] {
    return (this.db.prepare('SELECT * FROM bo_documents ORDER BY id').all() as Row[]).map(to);
  }
}
