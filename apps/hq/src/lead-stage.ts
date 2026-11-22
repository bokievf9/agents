import type { Db } from '@fir/core';
import { isQualified } from './heads/sales.js';

/**
 * The funnel stage of a lead («Shell v3»). Derived from what exists in the other tables, with a manual override
 * (`li_leads.stage_override`): the derived stage wins only when it is further along than the override.
 * new (nothing yet) < qualified (`isQualified`) < proposal (approved КП) < contract (a contract paper) < paid (invoice paid)
 * < project (a started project); `lost` is outside the line (manual, or the person's contact is in `lost_leads`).
 */
export const STAGES = ['new', 'qualified', 'proposal', 'contract', 'paid', 'project', 'lost'] as const;
export type Stage = (typeof STAGES)[number];
const RANK: Record<Exclude<Stage, 'lost'>, number> = { new: 0, qualified: 1, proposal: 2, contract: 3, paid: 4, project: 5 };
export const rankOf = (s: Stage): number => (s === 'lost' ? -1 : RANK[s]);
export const isStage = (s: unknown): s is Stage => typeof s === 'string' && (STAGES as readonly string[]).includes(s);

export interface LeadStageRow {
  id: number;
  task_id: number;
  name: string;
  contact: string;
  service: string;
  budget: string;
  estimate?: string | null;
  stage_override?: string | null;
}

const NEXT_ACTION: Record<Stage, string | null> = {
  new: 'Ответить лиду и выяснить задачу и бюджет',
  qualified: 'Проверить и одобрить КП',
  proposal: 'Согласовать договор и выставить счёт',
  contract: 'Получить оплату первого этапа',
  paid: 'Запустить проект',
  project: null,
  lost: null,
};
export const nextActionOf = (s: Stage): string | null => NEXT_ACTION[s];

/** Adds the nullable manual-stage column when the table is older than this feature. */
export function ensureStageColumn(db: Db): void {
  const cols = db.prepare('PRAGMA table_info(li_leads)').all() as { name: string }[];
  if (cols.length && !cols.some((c) => c.name === 'stage_override')) db.exec('ALTER TABLE li_leads ADD COLUMN stage_override TEXT');
}

/** The sets the derivation needs, loaded once per request (a handful of small queries, never one per lead). */
export class StageContext {
  private constructor(
    private readonly db: Db,
    private readonly kp: Set<number>,
    private readonly contractLeads: Set<number>,
    private readonly contractClients: Set<string>,
    private readonly paid: Set<number>,
    private readonly projects: Set<number>,
    private readonly lostContacts: Set<string>,
  ) {}

  static load(db: Db): StageContext {
    const has = (t: string) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t) !== undefined;
    const ids = (sql: string) => new Set((db.prepare(sql).all() as { v: number }[]).map((r) => r.v));
    const kp = has('ps_documents') ? ids("SELECT DISTINCT lead_id v FROM ps_documents WHERE kind = 'kp' AND status = 'approved' AND lead_id IS NOT NULL") : new Set<number>();
    // Cabinet v3: for a lead whose quote went to the client's cabinet the contract of the approved КП pack is only a draft inside the pack; the contract stage
    // starts when the contract itself is delivered to the client (`cab_documents`)
    const flowLeads = has('cab_documents') ? ids("SELECT DISTINCT lead_id v FROM cab_documents WHERE kind = 'quote' AND lead_id IS NOT NULL") : new Set<number>();
    const cabContracts = has('cab_documents') ? ids("SELECT DISTINCT lead_id v FROM cab_documents WHERE kind = 'contract' AND lead_id IS NOT NULL") : new Set<number>();
    const contractLeads = new Set<number>(cabContracts);
    if (has('ps_documents')) for (const id of ids("SELECT DISTINCT lead_id v FROM ps_documents WHERE kind = 'contract' AND status = 'approved' AND lead_id IS NOT NULL")) if (!flowLeads.has(id)) contractLeads.add(id);
    const contractClients = has('bo_documents')
      ? new Set((db.prepare("SELECT DISTINCT client FROM bo_documents WHERE type = 'contract' AND status != 'rejected'").all() as { client: string }[]).map((r) => r.client.trim().toLowerCase()))
      : new Set<string>();
    const hasCol = (t: string, c: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).some((x) => x.name === c);
    const paid = has('bl_invoices') && hasCol('bl_invoices', 'lead_id') ? ids("SELECT DISTINCT lead_id v FROM bl_invoices WHERE status = 'paid' AND lead_id IS NOT NULL") : new Set<number>();
    const projects = has('pm_projects') && hasCol('pm_projects', 'lead_id') ? ids("SELECT DISTINCT lead_id v FROM pm_projects WHERE status != 'draft' AND lead_id IS NOT NULL") : new Set<number>();
    const lostContacts = has('lost_leads')
      ? new Set((db.prepare("SELECT contact FROM lost_leads WHERE contact != ''").all() as { contact: string }[]).map((r) => r.contact.trim().toLowerCase()))
      : new Set<string>();
    return new StageContext(db, kp, contractLeads, contractClients, paid, projects, lostContacts);
  }

  private qualified(l: LeadStageRow): boolean {
    let raw: Record<string, unknown> = {};
    try {
      const m = (this.db.prepare('SELECT meta FROM tasks WHERE id = ?').get(l.task_id) as { meta: string } | undefined)?.meta;
      const lead = m ? (JSON.parse(m) as { lead?: unknown }).lead : undefined;
      if (lead && typeof lead === 'object') raw = lead as Record<string, unknown>;
    } catch {
      /* a task without readable meta is simply not qualified by it */
    }
    if (l.estimate && l.estimate.trim()) raw = { ...raw, estimate: l.estimate };
    return isQualified({ service: l.service ?? '', budget: l.budget ?? '' }, raw);
  }

  /** The stage the data alone gives (never the override). */
  derived(l: LeadStageRow): Stage {
    if (this.projects.has(l.id)) return 'project';
    if (this.paid.has(l.id)) return 'paid';
    if (this.contractLeads.has(l.id) || this.contractClients.has(l.name.trim().toLowerCase())) return 'contract';
    if (this.kp.has(l.id)) return 'proposal';
    if (this.qualified(l)) return 'qualified';
    return l.contact.trim() && this.lostContacts.has(l.contact.trim().toLowerCase()) ? 'lost' : 'new';
  }

  /** Override and derivation together: the derived stage wins only when it is further along; `lost` is kept unless the lead already paid. */
  stageOf(l: LeadStageRow): Stage {
    const d = this.derived(l);
    const o = isStage(l.stage_override) ? l.stage_override : null;
    if (!o) return d;
    if (o === 'lost') return rankOf(d) >= RANK.paid ? d : 'lost';
    return rankOf(d) > rankOf(o) ? d : o;
  }
}
