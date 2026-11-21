import { errMsg, log, zonedParts } from '@fir/core';
import type { Hq } from '@fir/hq';
import { billingStoreFor } from '@fir/worker-billing';
import { csStoreFor } from '@fir/worker-customer-support';
import { leadStoreFor } from '@fir/worker-lead-intake';
import { addThreadMessage, ensureCabinetTables, registerCabinetLead } from '../cabinet.js';
import type { SalesHead } from '../heads/sales.js';
import type { SupportHead } from '../heads/support.js';
import { AuditStore, submitAudit, type AuditGate } from '../audit-shared.js';
import type { MarketingHead } from '../heads/marketing.js';
import type { ClientSinks } from './engine.js';
import type { Calls } from '../calls.js';

/** The client bot's way into the company: leads to Sales, tickets to Support, lookups in their stores. */
export function clientSinks(d: { hq: Hq; sales: Pick<SalesHead, 'createLeadTask'>; support: Pick<SupportHead, 'clientTicket'>; invoicePrefix: string; audit?: { marketing: Pick<MarketingHead, 'requestAudit'>; gate: AuditGate }; calls?: Pick<Calls, 'book'> }): ClientSinks {
  const base = { db: d.hq.db, now: d.hq.now };
  return {
    createLead: (lead, service) => {
      const id = d.sales.createLeadTask(lead, service);
      // a signed-in cabinet client wrote in the web chat: the account and the lead row are linked at once (the same step as `POST /lead` with `clientEmail`)
      const email = typeof lead.clientEmail === 'string' ? lead.clientEmail : '';
      if (email) {
        try {
          const s = (k: string) => (typeof lead[k] === 'string' ? (lead[k] as string) : '');
          registerCabinetLead(d.hq.db, d.hq.now, id, {
            clientEmail: email, cabinetId: s('cabinetId') || undefined, clientName: s('clientName') || undefined, name: s('name') || email, contact: s('contact') || email, service: s('service'), budget: s('budget'),
            message: s('message'), estimate: s('estimate'), locale: lead.locale === 'en' ? 'en' : 'ru', source: s('source'),
          });
        } catch (e) {
          log('warn', 'chat cabinet lead not linked', { task: id, err: errMsg(e) });
        }
      }
      return id;
    },
    clientMessage: async (client, text) => {
      ensureCabinetTables(d.hq.db);
      const c = d.hq.db.prepare('SELECT id, name FROM cab_clients WHERE email = ?').get(client.email.toLowerCase()) as { id: number; name: string } | undefined;
      const name = c?.name || client.name || client.email;
      // the client's line in his support thread (the cabinet shows it) and a Support ticket, so the answer is drafted through the usual approvals
      if (c) addThreadMessage(d.hq.db, d.hq.now(), { clientId: c.id, thread: 'support', from: 'client', text });
      return d.support.clientTicket(name, text);
    },
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
    ...(d.calls ? { bookCall: async (leadId: number, at: number) => void (await d.calls!.book(leadId, at, 'bot')) } : {}),
    leadSlots: (taskId) => {
      const lead = leadStoreFor(base).byTask(taskId);
      return lead ? { leadId: lead.id, slots: lead.slots } : null;
    },
  };
}
