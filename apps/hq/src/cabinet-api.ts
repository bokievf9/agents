import type { Db, LlmClient, Tools } from '@fir/core';
import type { Hq } from '@fir/hq';
import type { BillingWorker } from '@fir/worker-billing';
import { CsStore } from '@fir/worker-customer-support';
import { CabDocs } from './cab-docs.js';
import { addThreadMessage } from './cabinet.js';
import { CabThreads } from './cab-threads.js';
import { Playground } from './playground.js';

/**
 * The Cabinet v3 routes under `/admin/clients/:id/` (documents, threads, uploads, agents): one dispatcher over the three modules. `admin-crm.ts` calls it
 * after its own routes; a path it does not know is `null` (the caller answers 404). Contract: `docs/admin-crm-api.md`, «Кабинет v3 (2026-11-22)».
 */
export interface CabinetApi {
  /** The owner-side hooks live in the admin API (inbox, Support tasks, the lead's task journal): it binds them when it is built. */
  bind(h: CabinetHooks): void;
  route(method: string, seg: string[], query: URLSearchParams, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> | null;
  docs: CabDocs;
  threads: CabThreads;
  playground: Playground;
}

export interface CabinetHooks {
  notifyOwner?: ((text: string) => void) | undefined;
  cabinetTicket?: ((t: { id: number; name: string; text: string; telegram: string; leadId?: number }) => void) | undefined;
  leadJournal?: ((taskId: number, text: string) => void) | undefined;
}

export interface CabinetDeps {
  hq: Hq;
  llm: LlmClient;
  tools: () => Tools;
  billing: BillingWorker;
  siteUrl: string;
  dataDir: string;
  mediaSecret?: string | undefined;
  mediaBase?: string | undefined;
  /** The key for agents' Telegram tokens at rest (`PG_SECRET`, else the media secret). */
  secret?: string | undefined;
  gate?: { llmAllowed(): boolean; llmUsed(): void } | undefined;
}

/** Builds the three modules of the cabinet and the dispatcher; the heads get `docs` (`sales.cabinet = cabinet.docs`, ...). */
export function buildCabinet(o: CabinetDeps): CabinetApi {
  const hooks: CabinetHooks = {};
  const now = o.hq.now;
  const notifyOwner = (t: string) => hooks.notifyOwner?.(t);
  const cabinetTicket = (t: { id: number; name: string; text: string; telegram: string; leadId?: number }) => hooks.cabinetTicket?.(t);
  const docs = new CabDocs({ hq: o.hq, now, tools: o.tools, billing: o.billing, siteUrl: o.siteUrl, notifyOwner });
  const ref: { pg?: Playground } = {};
  const threads = new CabThreads({
    db: o.hq.db, now, dataDir: o.dataDir, mediaSecret: o.mediaSecret, mediaBase: o.mediaBase, cabinetTicket, notifyOwner, leadJournal: (id, t) => hooks.leadJournal?.(id, t),
    agentReply: (cid, aid, text) => ref.pg!.threadReply(cid, aid, text), agents: (cid) => ref.pg?.agentsOf(cid) ?? [],
  });
  const playground = new Playground({
    db: o.hq.db, now, tz: () => o.hq.tz, llm: o.llm, secret: o.secret ?? o.mediaSecret, gate: o.gate, uploadText: (cid, uid) => threads.uploadText(cid, uid), notifyOwner,
    handoff: supportHandoff(o.hq.db, now, { cabinetTicket, notifyOwner }),
    journal: (agent, action, detail) => o.hq.log(agent, action, 'agent', detail),
  });
  ref.pg = playground;
  docs.attachPlayground(playground);
  const api = createCabinetApi({ docs, threads, playground });
  return { ...api, bind: (h) => void Object.assign(hooks, h) };
}

const num = (s: string | undefined): number | null => (s !== undefined && /^\d{1,12}$/.test(s) ? Number(s) : null);

export function createCabinetApi(m: { docs: CabDocs; threads: CabThreads; playground: Playground }): CabinetApi {
  const { docs, threads, playground } = m;
  return {
    docs, threads, playground, bind: () => undefined,
    route(method, seg, query, body) {
      const cid = num(seg[0]);
      if (cid === null) return null;
      const [, what, a, b, c] = seg;
      const get = method === 'GET';
      const post = method === 'POST';
      switch (what) {
        case 'documents':
          if (get && seg.length === 2) return docs.list(cid);
          if (post && seg.length === 4 && num(a) !== null && b === 'accept') return Promise.resolve(docs.accept(cid, num(a)!));
          if (post && seg.length === 4 && num(a) !== null && b === 'sign') return docs.sign(cid, num(a)!, body);
          return null;
        case 'threads':
          if (get && seg.length === 2) return Promise.resolve(threads.list(cid));
          if (get && seg.length === 4 && b === 'messages') {
            const after = query.get('after');
            if (after !== null && !/^\d{1,12}$/.test(after)) return Promise.resolve({ status: 400, body: { ok: false, error: 'invalid' } });
            return Promise.resolve(threads.messagesOf(cid, a!, after ? Number(after) : 0));
          }
          if (post && seg.length === 4 && b === 'messages') return threads.post(cid, a!, body);
          if (post && seg.length === 4 && b === 'read') return Promise.resolve(threads.read(cid, a!));
          return null;
        case 'uploads':
          return post && seg.length === 2 ? Promise.resolve(threads.upload(cid, body)) : null;
        case 'agents': {
          if (seg.length === 2) return get ? Promise.resolve(playground.list(cid)) : post ? Promise.resolve(playground.create(cid, body)) : null;
          const aid = num(a);
          if (aid === null) return null;
          if (seg.length === 3) {
            if (get) return Promise.resolve(playground.get(cid, aid));
            if (method === 'PATCH' || post) return Promise.resolve(playground.patch(cid, aid, body));
            return null;
          }
          if (get && seg.length === 4) {
            if (b === 'conversations') return Promise.resolve(playground.conversations(cid, aid));
            if (b === 'journal') return Promise.resolve(playground.journalOf(cid, aid));
            if (b === 'knowledge') return Promise.resolve(playground.knowledge(cid, aid));
            if (b === 'leads') return Promise.resolve(playground.leadsOf(cid, aid));
            return null;
          }
          if (post && seg.length === 4) {
            if (b === 'chat') return playground.chatAdmin(cid, aid, body);
            if (b === 'token') return Promise.resolve(playground.rotateToken(cid, aid));
            if (b === 'knowledge') return Promise.resolve(playground.addKnowledge(cid, aid, body));
          }
          if (post && seg.length === 6 && b === 'knowledge' && num(c) !== null && seg[5] === 'delete') return Promise.resolve(playground.removeKnowledge(cid, aid, num(c)!));
          return null;
        }
        default:
          return null;
      }
    },
  };
}

/**
 * The handoff of an agent (and any system line for the client's support thread): a message in the support thread, a Support ticket in the usual flow. The
 * ticket text carries the line; the answer the owner approves comes back into the same thread.
 */
export function supportHandoff(db: Db, now: () => number, deps: { cabinetTicket?: (t: { id: number; name: string; text: string; telegram: string }) => void; notifyOwner?: (text: string) => void }) {
  return (clientId: number, text: string): void => {
    const c = db.prepare('SELECT id, email, name, telegram FROM cab_clients WHERE id = ?').get(clientId) as { id: number; email: string; name: string; telegram: string } | undefined;
    if (!c) return;
    const tk = new CsStore(db, now).addCabinetTicket({ clientName: c.name || c.email, contact: c.email, text, thread: 'support' });
    addThreadMessage(db, now(), { clientId, thread: 'support', from: 'agent', text });
    deps.notifyOwner?.(`Агент клиента ${c.name || c.email} передал разговор человеку`);
    deps.cabinetTicket?.({ id: tk.id, name: tk.clientName, text: tk.text, telegram: c.telegram });
  };
}
