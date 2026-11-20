import { migrate, type Db, type PaymentStage } from '@fir/core';

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
  done_at INTEGER,
  stage_no INTEGER,
  amount_usd REAL,
  invoice_number TEXT,
  paid_at INTEGER,
  accepted_at INTEGER,
  title_en TEXT
);
CREATE INDEX IF NOT EXISTS pm_milestones_project ON pm_milestones (project_id, id);
`;

/** draft: the spec waits for the owner; active: approved, work and deadlines run; done: closed. */
export type ProjectStatus = 'draft' | 'active' | 'done' | 'paused';
/** `stage` is a payment stage of a КП project (owner decision 2026-11-21): paid before it starts, accepted before the next one is invoiced. */
export type MilestoneKind = 'brief' | 'prototype' | 'delivery' | 'payment' | 'stage';
/** The kinds of the older fixed plan (what `/mdone <project> <kind>` accepts); a stage is addressed by its number. */
export type LegacyMilestoneKind = Exclude<MilestoneKind, 'stage'>;
export const MILESTONE_KINDS: LegacyMilestoneKind[] = ['brief', 'prototype', 'delivery', 'payment'];
export type Product = 'site' | 'bot' | 'app' | 'automation';

/** The state of a stage (payment by stages): what the cabinet and the owner's lists show. */
export type StageState = 'awaiting_payment' | 'in_progress' | 'awaiting_acceptance' | 'accepted';
export const stageState = (m: { paidAt: number | null; acceptedAt: number | null; status: string }): StageState =>
  m.acceptedAt !== null ? 'accepted' : m.paidAt === null ? 'awaiting_payment' : m.status === 'done' ? 'awaiting_acceptance' : 'in_progress';

/** The stage title without the «Этап N:» prefix. */
export const stageTitleRu = (title: string): string => title.replace(/^Этап \d+:\s*/, '');

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
  /** Payment by stages: the stage number (1-based) and its amount; null for a milestone of the older plan. */
  stageNo: number | null;
  amountUsd: number | null;
  /** The invoice of this stage and when it was paid and accepted. */
  invoiceNumber: string | null;
  paidAt: number | null;
  acceptedAt: number | null;
  /** The stage title in English, without the «Этап N:» prefix (the cabinet of an English-speaking client). */
  titleEn: string | null;
}

interface ProjectRow {
  id: number; client: string; what: string; product: string; status: string; spec: string; source: string; task_id: number | null; created_at: number;
  lead_id: number | null; pack_id: number | null;
}
interface MilestoneRow {
  id: number; project_id: number; kind: string; title: string; due_at: number; status: string; task_id: number | null; done_at: number | null;
  stage_no: number | null; amount_usd: number | null; invoice_number: string | null; paid_at: number | null; accepted_at: number | null; title_en: string | null;
}

const toProject = (r: ProjectRow): Project => ({
  id: r.id, client: r.client, what: r.what, product: r.product as Product, status: r.status as ProjectStatus, spec: r.spec,
  source: r.source, taskId: r.task_id, createdAt: r.created_at, leadId: r.lead_id, packId: r.pack_id,
});
const toMilestone = (r: MilestoneRow): Milestone => ({
  id: r.id, projectId: r.project_id, kind: r.kind as MilestoneKind, title: r.title, dueAt: r.due_at, status: r.status === 'done' ? 'done' : 'open',
  taskId: r.task_id, doneAt: r.done_at, stageNo: r.stage_no ?? null, amountUsd: r.amount_usd ?? null, invoiceNumber: r.invoice_number ?? null, paidAt: r.paid_at ?? null, acceptedAt: r.accepted_at ?? null, titleEn: r.title_en ?? null,
});

/** Tables `pm_projects` and `pm_milestones` in the shared HQ database. */
export class PmStore {
  constructor(private readonly db: Db, private readonly now: () => number) {
    migrate(db, SCHEMA);
    // added later: the lead and the pack a reserved project came from
    const cols = db.prepare('PRAGMA table_info(pm_projects)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'lead_id')) db.exec('ALTER TABLE pm_projects ADD COLUMN lead_id INTEGER');
    if (!cols.some((c) => c.name === 'pack_id')) db.exec('ALTER TABLE pm_projects ADD COLUMN pack_id INTEGER');
    // added 2026-11-21: payment by stages (a milestone is a stage with its amount, invoice, payment and acceptance)
    const mcols = db.prepare('PRAGMA table_info(pm_milestones)').all() as { name: string }[];
    for (const [c, t] of [['stage_no', 'INTEGER'], ['amount_usd', 'REAL'], ['invoice_number', 'TEXT'], ['paid_at', 'INTEGER'], ['accepted_at', 'INTEGER'], ['title_en', 'TEXT']] as const) {
      if (!mcols.some((x) => x.name === c)) db.exec(`ALTER TABLE pm_milestones ADD COLUMN ${c} ${t}`);
    }
  }

  createProject(p: { client: string; what: string; product: Product; source: string; taskId: number | null; leadId?: number | null; packId?: number | null }): Project {
    const r = this.db
      .prepare('INSERT INTO pm_projects (client, what, product, source, task_id, created_at, lead_id, pack_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(p.client, p.what, p.product, p.source, p.taskId, this.now(), p.leadId ?? null, p.packId ?? null);
    return this.project(Number(r.lastInsertRowid))!;
  }

  /**
   * An approved КП only RESERVES a project: a `draft` row without a ТЗ (the project starts when the first stage is paid). One reservation per pack:
   * approving the same pack again returns the same row. With `stages` (payment by stages) the milestones are the stages, none of them paid yet.
   */
  reserve(p: { client: string; what: string; product: Product; leadId: number | null; packId: number; stages?: PaymentStage[]; dueAts?: number[] }): Project {
    const cur = this.db.prepare('SELECT * FROM pm_projects WHERE pack_id = ?').get(p.packId) as ProjectRow | undefined;
    const proj = cur ? toProject(cur) : this.createProject({ client: p.client, what: p.what, product: p.product, source: 'sales', taskId: null, leadId: p.leadId, packId: p.packId });
    if (p.stages?.length && this.stageMilestones(proj.id).length === 0 && this.milestones(proj.id).length === 0) {
      p.stages.forEach((s, i) => this.addMilestone({ projectId: proj.id, kind: 'stage', title: `Этап ${s.no}: ${s.title.ru}`, dueAt: p.dueAts?.[i] ?? this.now(), stageNo: s.no, amountUsd: s.amountUsd, titleEn: s.title.en }));
    }
    return proj;
  }

  /** The reserved project of a КП for this client that has not started yet (no task made for it), by the client's name. */
  reservedFor(client: string): Project | undefined {
    const q = client.trim().toLowerCase();
    return this.projects('draft').find((p) => p.packId !== null && p.taskId === null && p.client.toLowerCase() === q);
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

  /** The owner moves a milestone's date from the workplace. */
  setDue(id: number, dueAt: number): void {
    this.db.prepare('UPDATE pm_milestones SET due_at = ? WHERE id = ?').run(dueAt, id);
  }

  addMilestone(m: { projectId: number; kind: MilestoneKind; title: string; dueAt: number; stageNo?: number; amountUsd?: number; titleEn?: string }): Milestone {
    const r = this.db.prepare('INSERT INTO pm_milestones (project_id, kind, title, due_at, stage_no, amount_usd, title_en) VALUES (?, ?, ?, ?, ?, ?, ?)').run(m.projectId, m.kind, m.title, m.dueAt, m.stageNo ?? null, m.amountUsd ?? null, m.titleEn ?? null);
    return this.milestone(Number(r.lastInsertRowid))!;
  }

  milestone(id: number): Milestone | undefined {
    const r = this.db.prepare('SELECT * FROM pm_milestones WHERE id = ?').get(id) as MilestoneRow | undefined;
    return r ? toMilestone(r) : undefined;
  }

  milestones(projectId: number): Milestone[] {
    return (this.db.prepare('SELECT * FROM pm_milestones WHERE project_id = ? ORDER BY id').all(projectId) as MilestoneRow[]).map(toMilestone);
  }

  /** The stages of a project in order (payment by stages); empty for a project of the older plan. */
  stageMilestones(projectId: number): Milestone[] {
    return (this.db.prepare('SELECT * FROM pm_milestones WHERE project_id = ? AND stage_no IS NOT NULL ORDER BY stage_no').all(projectId) as MilestoneRow[]).map(toMilestone);
  }

  stageMilestone(projectId: number, stageNo: number): Milestone | undefined {
    const r = this.db.prepare('SELECT * FROM pm_milestones WHERE project_id = ? AND stage_no = ?').get(projectId, stageNo) as MilestoneRow | undefined;
    return r ? toMilestone(r) : undefined;
  }

  /** The invoice made for a stage (kept on the milestone so the cabinet can show it). */
  setStageInvoice(id: number, invoiceNumber: string): void {
    this.db.prepare('UPDATE pm_milestones SET invoice_number = ? WHERE id = ?').run(invoiceNumber, id);
  }

  /** The stage's invoice was paid: once (false when it was paid before). `dueAt`, when given, is the stage's new target date. */
  markStagePaid(id: number, invoiceNumber: string, dueAt?: number): boolean {
    const r = this.db.prepare('UPDATE pm_milestones SET paid_at = ?, invoice_number = ?, due_at = COALESCE(?, due_at) WHERE id = ? AND paid_at IS NULL').run(this.now(), invoiceNumber, dueAt ?? null, id);
    return r.changes === 1;
  }

  /** The stage is accepted (by the client or by `/mdone`): done if it was open, accepted once. False when it was accepted before. */
  acceptStage(id: number): boolean {
    return this.db.transaction(() => {
      this.db.prepare("UPDATE pm_milestones SET status = 'done', done_at = ? WHERE id = ? AND status = 'open'").run(this.now(), id);
      return this.db.prepare('UPDATE pm_milestones SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL').run(this.now(), id).changes === 1;
    })();
  }

  setStageDates(updates: { id: number; dueAt: number }[]): void {
    for (const u of updates) this.db.prepare('UPDATE pm_milestones SET due_at = ? WHERE id = ?').run(u.dueAt, u.id);
  }

  milestoneOf(projectId: number, kind: LegacyMilestoneKind): Milestone | undefined {
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
         WHERE m.status = 'open' AND m.due_at < ? AND p.status = 'active' AND (m.stage_no IS NULL OR m.paid_at IS NOT NULL) ORDER BY m.due_at`,
      )
      .all(this.now()) as (MilestoneRow & { client: string })[];
    return rows.map((r) => ({ ...toMilestone(r), client: r.client }));
  }
}
