import { migrate, type Db } from '@fir/core';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kb_lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  exported_task INTEGER
);
`;

export interface Lesson {
  id: number;
  project: string;
  text: string;
  createdAt: number;
  /** Task of the weekly export that put this lesson into the repo; null: not exported yet. */
  exportedTask: number | null;
}

interface Row { id: number; project: string; text: string; created_at: number; exported_task: number | null }
const to = (r: Row): Lesson => ({ id: r.id, project: r.project, text: r.text, createdAt: r.created_at, exportedTask: r.exported_task });

export class KbStore {
  constructor(private readonly db: Db, private readonly now: () => number) {
    migrate(db, SCHEMA);
  }

  add(project: string, text: string): Lesson {
    const r = this.db.prepare('INSERT INTO kb_lessons (project, text, created_at) VALUES (?, ?, ?)').run(project, text, this.now());
    return this.get(Number(r.lastInsertRowid))!;
  }

  get(id: number): Lesson | undefined {
    const r = this.db.prepare('SELECT * FROM kb_lessons WHERE id = ?').get(id) as Row | undefined;
    return r ? to(r) : undefined;
  }

  unexported(): Lesson[] {
    return (this.db.prepare('SELECT * FROM kb_lessons WHERE exported_task IS NULL ORDER BY id').all() as Row[]).map(to);
  }

  markExported(ids: number[], taskId: number): void {
    const st = this.db.prepare('UPDATE kb_lessons SET exported_task = ? WHERE id = ?');
    for (const id of ids) st.run(taskId, id);
  }

  all(): Lesson[] {
    return (this.db.prepare('SELECT * FROM kb_lessons ORDER BY id').all() as Row[]).map(to);
  }
}
