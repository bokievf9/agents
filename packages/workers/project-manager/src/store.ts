import { migrate, type Db } from '@fir/core';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pm_projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client TEXT NOT NULL,
  what TEXT NOT NULL,
  product TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  spec TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'owner',
  task_id INTEGER,
  created_at INTEGER NOT NULL,
  lead_id INTEGER,
  pack_id INTEGER
);
CREATE TABLE IF NOT EXISTS pm_milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  task_id INTEGER,
  done_at INTEGER
);
CREATE INDEX IF NOT EXISTS pm_milestones_project ON pm_milestones (project_id, id);
`;

/** draft: the spec waits for the owner; active: approved, work and deadlines run; done: closed. */
export type ProjectStatus = 'draft' | 'active' | 'done';
export type MilestoneKind = 'brief' | 'prototype' | 'delivery' | 'payment';
export const MILESTONE_KINDS: MilestoneKind[] = ['brief', 'prototype', 'delivery', 'payment'];
export type Product = 'site' | 'bot' | 'app' | 'automation';

export interface Project {
  id: number;
  client: string;
  what: string;
  product: Product;
  status: ProjectStatus;
  spec: string;
  source: string;
  taskId: number | null;
  createdAt: number;
  /** A project reserved by an approved КП: the lead and the presales pack it came from (the project itself starts on the first payment). */
  leadId: number | null;
  packId: number | null;
}

export interface Milestone {
  id: number;
  projectId: number;
  kind: MilestoneKind;
  title: string;
  dueAt: number;
  status: 'open' | 'done';
  taskId: number | null;
  doneAt: number | null;
}

interface ProjectRow {
  id: number; client: string; what: string; product: string; status: string; spec: string; source: string; task_id: number | null; created_at: number;
  lead_id: number | null; pack_id: number | null;
}
interface MilestoneRow {
  id: number; project_id: number; kind: string; title: string; due_at: number; status: string; task_id: number | null; done_at: number | null;
}

const toProject = (r: ProjectRow): Project => ({
  id: r.id, client: r.client, what: r.what, product: r.product as Product, status: r.status as ProjectStatus, spec: r.spec,
  source: r.source, taskId: r.task_id, createdAt: r.created_at, leadId: r.lead_id, packId: r.pack_id,
});
const toMilestone = (r: MilestoneRow): Milestone => ({
  id: r.id, projectId: r.project_id, kind: r.kind as MilestoneKind, title: r.title, dueAt: r.due_at, status: r.status === 'done' ? 'done' : 'open',
  taskId: r.task_id, doneAt: r.done_at,
});

/** Tables `pm_projects` and `pm_milestones` in the shared HQ database. */
export class PmStore {
  constructor(private readonly db: Db, private readonly now: () => number) {
    migrate(db, SCHEMA);
    // added later: the lead and the pack a reserved project came from
    const cols = db.prepare('PRAGMA table_info(pm_projects)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'lead_id')) db.exec('ALTER TABLE pm_projects ADD COLUMN lead_id INTEGER');
    if (!cols.some((c) => c.name === 'pack_id')) db.exec('ALTER TABLE pm_projects ADD COLUMN pack_id INTEGER');
  }

  createProject(p: { client: string; what: string; product: Product; source: string; taskId: number | null; leadId?: number | null; packId?: number | null }): Project {
    const r = this.db
      .prepare('INSERT INTO pm_projects (client, what, product, source, task_id, created_at, lead_id, pack_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(p.client, p.what, p.product, p.source, p.taskId, this.now(), p.leadId ?? null, p.packId ?? null);
    return this.project(Number(r.lastInsertRowid))!;
  }

  /**
   * An approved КП only RESERVES a project: a `draft` row without milestones or a ТЗ (the project starts when the first invoice
   * is paid). One reservation per pack: approving the same pack again returns the same row.
   */
  reserve(p: { client: string; what: string; product: Product; leadId: number | null; packId: number }): Project {
    const cur = this.db.prepare('SELECT * FROM pm_projects WHERE pack_id = ?').get(p.packId) as ProjectRow | undefined;
    return cur ? toProject(cur) : this.createProject({ client: p.client, what: p.what, product: p.product, source: 'sales', taskId: null, leadId: p.leadId, packId: p.packId });
  }

  /** The project reserved by a КП for this client that has not started yet (no milestones), by the client's name. */
  reservedFor(client: string): Project | undefined {
    const q = client.trim().toLowerCase();
    return this.projects('draft').find((p) => p.packId !== null && p.client.toLowerCase() === q && this.milestones(p.id).length === 0);
  }

  /** The reserved project starts: it takes its task, product and description. */
  start(id: number, p: { product: Product; what: string; taskId: number }): void {
    this.db.prepare('UPDATE pm_projects SET product = ?, what = ?, task_id = ? WHERE id = ?').run(p.product, p.what, p.taskId, id);
  }

  project(id: number): Project | undefined {
    const r = this.db.prepare('SELECT * FROM pm_projects WHERE id = ?').get(id) as ProjectRow | undefined;
    return r ? toProject(r) : undefined;
  }

  /** A project by its number ("12", "#12") or by a part of the client name (the latest one). */
  find(ref: string): Project | undefined {
    const s = ref.trim().replace(/^#/, '');
    if (/^\d+$/.test(s)) return this.project(Number(s));
    if (!s) return undefined;
    // SQLite lower() is ASCII-only, so the case-insensitive match is done here.
    const q = s.toLowerCase();
    return this.projects().filter((p) => p.client.toLowerCase().includes(q)).at(-1);
  }

  projects(status?: ProjectStatus): Project[] {
    const rows = (status
      ? this.db.prepare('SELECT * FROM pm_projects WHERE status = ? ORDER BY id').all(status)
      : this.db.prepare('SELECT * FROM pm_projects ORDER BY id').all()) as ProjectRow[];
    return rows.map(toProject);
  }

  setSpec(id: number, spec: string): void {
    this.db.prepare('UPDATE pm_projects SET spec = ? WHERE id = ?').run(spec, id);
  }

  setStatus(id: number, status: ProjectStatus): void {
    this.db.prepare('UPDATE pm_projects SET status = ? WHERE id = ?').run(status, id);
  }

  addMilestone(m: { projectId: number; kind: MilestoneKind; title: string; dueAt: number }): Milestone {
    const r = this.db.prepare('INSERT INTO pm_milestones (project_id, kind, title, due_at) VALUES (?, ?, ?, ?)').run(m.projectId, m.kind, m.title, m.dueAt);
    return this.milestone(Number(r.lastInsertRowid))!;
  }

  milestone(id: number): Milestone | undefined {
    const r = this.db.prepare('SELECT * FROM pm_milestones WHERE id = ?').get(id) as MilestoneRow | undefined;
    return r ? toMilestone(r) : undefined;
  }

  milestones(projectId: number): Milestone[] {
    return (this.db.prepare('SELECT * FROM pm_milestones WHERE project_id = ? ORDER BY id').all(projectId) as MilestoneRow[]).map(toMilestone);
  }

  milestoneOf(projectId: number, kind: MilestoneKind): Milestone | undefined {
    const r = this.db.prepare('SELECT * FROM pm_milestones WHERE project_id = ? AND kind = ?').get(projectId, kind) as MilestoneRow | undefined;
    return r ? toMilestone(r) : undefined;
  }

  setMilestoneTask(id: number, taskId: number): void {
    this.db.prepare('UPDATE pm_milestones SET task_id = ? WHERE id = ?').run(taskId, id);
  }

  /** Returns false when it was already done or unknown. */
  markDone(id: number): boolean {
    return this.db.prepare("UPDATE pm_milestones SET status = 'done', done_at = ? WHERE id = ? AND status = 'open'").run(this.now(), id).changes === 1;
  }

  /** Open milestones past their date in projects whose work runs (draft projects have no deadlines yet). */
  overdue(): (Milestone & { client: string })[] {
    const rows = this.db
      .prepare(
        `SELECT m.*, p.client AS client FROM pm_milestones m JOIN pm_projects p ON p.id = m.project_id
         WHERE m.status = 'open' AND m.due_at < ? AND p.status = 'active' ORDER BY m.due_at`,
      )
      .all(this.now()) as (MilestoneRow & { client: string })[];
    return rows.map((r) => ({ ...toMilestone(r), client: r.client }));
  }
}
