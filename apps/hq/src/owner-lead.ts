import { migrate, type Db } from '@fir/core';
import { leadStoreFor } from '@fir/worker-lead-intake';
import { z } from 'zod';
import type { SalesHead } from './heads/sales.js';

/**
 * «Клиент от владельца» (2026-11-26): an acquaintance who becomes a client without a site lead enters the SAME funnel as a site lead: a Sales task
 * (`createLeadTask`, source `owner`), the lead row, Sales qualification, the КП and the price approval. Used by `POST /admin/leads/owner` and by the
 * Director's intent `owner_lead` (one code path). Without a contact the delivery channel is `owner`: nothing is sent, the owner forwards the texts himself.
 */
export const OWNER_CONTACT = 'через владельца';

const httpUrl = z.string().trim().max(300).refine((u) => {
  try {
    const p = new URL(u).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
});

export const ownerLeadSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    contact: z.string().trim().max(200).optional(),
    need: z.string().trim().min(1).max(4000),
    links: z.array(httpUrl).max(10).optional(),
    clientRef: z.string().trim().min(1).max(80).optional(),
  })
  .strict();
export type OwnerLeadInput = z.output<typeof ownerLeadSchema>;
export interface OwnerLeadResult {
  id: number;
  leadId: number;
  duplicate: boolean;
  deliveryChannel: 'owner' | 'contact';
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS owner_lead_refs (
  client_ref TEXT PRIMARY KEY,
  task_id INTEGER NOT NULL,
  lead_id INTEGER NOT NULL,
  at INTEGER NOT NULL
);
`;

export function createOwnerLead(d: { hq: { db: Db; now: () => number }; sales: Pick<SalesHead, 'createLeadTask'> }, input: OwnerLeadInput): OwnerLeadResult {
  migrate(d.hq.db, SCHEMA);
  const channel = input.contact ? 'contact' : 'owner';
  if (input.clientRef) {
    const row = d.hq.db.prepare('SELECT task_id, lead_id FROM owner_lead_refs WHERE client_ref = ?').get(input.clientRef) as { task_id: number; lead_id: number } | undefined;
    if (row) return { id: row.task_id, leadId: row.lead_id, duplicate: true, deliveryChannel: channel };
  }
  const links = input.links ?? [];
  const message = `${input.need}${links.length ? `\n\nСсылки: ${links.join(' ')}` : ''}`;
  const contact = (input.contact || OWNER_CONTACT).slice(0, 120);
  const id = d.sales.createLeadTask(
    {
      name: input.name.slice(0, 80), contact, service: 'unknown', budget: '', message, estimate: '', locale: 'ru', slot: '', source: 'owner', fromOwner: true,
      ...(channel === 'owner' ? { deliveryChannel: 'owner' } : {}), ...(links.length ? { links } : {}),
    },
    'unknown',
  );
  // the lead row exists at once (the worker updates it by task id when Sales takes the task), so the owner gets its id in the answer
  const lead = leadStoreFor({ db: d.hq.db, now: d.hq.now }).upsert(id, {
    name: input.name.slice(0, 80), contact, service: 'unknown', niche: '', task: input.need.slice(0, 300), deadline: '', budget: '', origin: 'owner',
    temperature: 'cold', lang: 'ru', slots: [], chosenSlot: null, priceAsked: false,
  });
  if (input.clientRef) d.hq.db.prepare('INSERT OR IGNORE INTO owner_lead_refs (client_ref, task_id, lead_id, at) VALUES (?, ?, ?, ?)').run(input.clientRef, id, lead.id, d.hq.now());
  return { id, leadId: lead.id, duplicate: false, deliveryChannel: channel };
}
