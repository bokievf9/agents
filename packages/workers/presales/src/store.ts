import { migrate, type Db } from '@fir/core';

export type DocKind = 'kp' | 'estimate' | 'contract';
export const DOC_KINDS: DocKind[] = ['kp', 'estimate', 'contract'];
export const DOC_RU: Record<DocKind, string> = { kp: 'Коммерческое предложение', estimate: 'Смета', contract: 'Черновик договора' };
/** draft: waits for the owner. approved: he approved it and sends it himself. rejected / superseded: not used. */
export type DocStatus = 'draft' | 'approved' | 'rejected' | 'superseded';

export interface PsDocument {
  id: number;
  /** The three documents made together share one pack. */
  packId: number;
  leadId: number | null;
  kind: DocKind;
  direction: string;
  title: string;
  body: string;
  status: DocStatus;
  createdAt: number;
  decidedAt: number | null;
}

interface Row {
  id: number; pack_id: number; lead_id: number | null; kind: DocKind; direction: string; title: string; body: string;
  status: DocStatus; created_at: number; decided_at: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ps_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pack_id INTEGER NOT NULL,
  lead_id INTEGER,
  kind TEXT NOT NULL,
  direction TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS ps_documents_pack ON ps_documents (pack_id);
CREATE INDEX IF NOT EXISTS ps_documents_lead ON ps_documents (lead_id);
`;

const map = (r: Row): PsDocument => ({
  id: r.id, packId: r.pack_id, leadId: r.lead_id, kind: r.kind, direction: r.direction, title: r.title, body: r.body,
  status: r.status, createdAt: r.created_at, decidedAt: r.decided_at,
});

export interface NewDoc {
  kind: DocKind;
  title: string;
  body: string;
}

export class PresalesStore {
  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {
    migrate(db, SCHEMA);
  }

  /** Stores the three documents of one proposal. Earlier drafts of the same lead are superseded. */
  createPack(leadId: number | null, direction: string, docs: NewDoc[]): PsDocument[] {
    const packId = ((this.db.prepare('SELECT COALESCE(MAX(pack_id), 0) AS m FROM ps_documents').get() as { m: number }).m) + 1;
    return this.db.transaction(() => {
      if (leadId !== null) this.db.prepare("UPDATE ps_documents SET status = 'superseded' WHERE lead_id = ? AND status = 'draft'").run(leadId);
      const ins = this.db.prepare('INSERT INTO ps_documents (pack_id, lead_id, kind, direction, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const d of docs) ins.run(packId, leadId, d.kind, direction, d.title, d.body, this.now());
      return this.pack(packId);
    })();
  }

  pack(packId: number): PsDocument[] {
    return (this.db.prepare('SELECT * FROM ps_documents WHERE pack_id = ? ORDER BY id').all(packId) as Row[]).map(map);
  }

  byLead(leadId: number): PsDocument[] {
    return (this.db.prepare('SELECT * FROM ps_documents WHERE lead_id = ? ORDER BY id').all(leadId) as Row[]).map(map);
  }

  /** Only a draft can be decided; a pack that was superseded or already decided stays as it is. */
  decide(packId: number, to: 'approved' | 'rejected'): number {
    return Number(this.db.prepare("UPDATE ps_documents SET status = ?, decided_at = ? WHERE pack_id = ? AND status = 'draft'").run(to, this.now(), packId).changes);
  }
}
