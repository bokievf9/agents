import type { Db } from '@fir/core';

/**
 * The legal party of a cabinet client (profile fields `legal_name`, `legal_address`, 2026-11-23): what the КП, the contract, the invoice and the act call
 * the customer. Without a legal name the client's own name stays. Tolerant: no cabinet table or no such columns (an old database) means no party.
 */
export interface LegalParty {
  name: string;
  address: string;
}

const clean = (s: unknown) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');

function read(db: Db, sql: string, id: number): LegalParty | null {
  try {
    const r = db.prepare(sql).get(id) as { legal_name?: string; legal_address?: string } | undefined;
    const name = clean(r?.legal_name);
    return name ? { name, address: clean(r?.legal_address) } : null;
  } catch {
    return null;
  }
}

export const legalPartyOfClient = (db: Db, clientId: number): LegalParty | null =>
  read(db, 'SELECT legal_name, legal_address FROM cab_clients WHERE id = ?', clientId);

export const legalPartyOfLead = (db: Db, leadId: number): LegalParty | null =>
  read(db, 'SELECT c.legal_name, c.legal_address FROM li_leads l JOIN cab_clients c ON c.id = l.client_id WHERE l.id = ?', leadId);

/** «ООО Ромашка, адрес: ...»: how a document names the customer; the plain name when there is no address. */
export const legalLabel = (p: LegalParty): string => (p.address ? `${p.name}, адрес: ${p.address}` : p.name);

/** The label as task meta (`legalLabel`): the documents worker and the invoice take it as the customer, nothing when there is no party. */
export const legalMeta = (p: LegalParty | null): { legalLabel?: string } => (p ? { legalLabel: legalLabel(p) } : {});
