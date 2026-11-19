import { zonedParts } from '@fir/core';
import type { Hq } from '@fir/hq';
import { billingStoreFor } from '@fir/worker-billing';
import { csStoreFor } from '@fir/worker-customer-support';
import { leadStoreFor } from '@fir/worker-lead-intake';
import type { SalesHead } from '../heads/sales.js';
import type { SupportHead } from '../heads/support.js';
import { AuditStore, submitAudit, type AuditGate } from '../audit-shared.js';
import type { MarketingHead } from '../heads/marketing.js';
import type { ClientSinks } from './engine.js';

/** The client bot's way into the company: leads to Sales, tickets to Support, lookups in their stores. */
export function clientSinks(d: { hq: Hq; sales: Pick<SalesHead, 'createLeadTask'>; support: Pick<SupportHead, 'clientTicket'>; invoicePrefix: string; audit?: { marketing: Pick<MarketingHead, 'requestAudit'>; gate: AuditGate } }): ClientSinks {
  const base = { db: d.hq.db, now: d.hq.now };
  return {
    createLead: (lead, service) => d.sales.createLeadTask(lead, service),
    createTicket: (client, text, chatId) => d.support.clientTicket(client, text, chatId),
    findClient: (q) => {
      const query = q.trim();
      if (query.length < 2) return null;
      const byName = csStoreFor(base).clientByName(query);
      if (byName) return byName.name;
      return billingStoreFor(base, d.invoicePrefix).byRef(query, zonedParts(d.hq.now(), d.hq.tz).y)?.client ?? null;
    },
    ...(d.audit
      ? {
          createAudit: (a) => {
            const audit = d.audit!;
            return Promise.resolve(submitAudit({ store: new AuditStore(d.hq.db, d.hq.now), gate: audit.gate, create: (x) => audit.marketing.requestAudit(x) }, a));
          },
        }
      : {}),
    leadSlots: (taskId) => {
      const lead = leadStoreFor(base).byTask(taskId);
      return lead ? { leadId: lead.id, slots: lead.slots } : null;
    },
  };
}
