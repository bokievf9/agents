import type { LlmClient, Tools } from '@fir/core';
import type { Hq } from '@fir/hq';
import type { BillingWorker } from '@fir/worker-billing';
import { CabDocs } from './cab-docs.js';
import { CabThreads } from './cab-threads.js';
import type { ClientKnowledge } from './client-knowledge.js';
import { ClientMail } from './client-mail.js';
import type { DemoUsage } from './demo-usage.js';
import { Playground } from './playground.js';
import { addReview } from './reviews.js';

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
  /** «Знания клиента»: `GET /admin/clients/:id/knowledge`, `POST .../knowledge/import`. Absent: those routes answer 404. */
  siteKnowledge?: ClientKnowledge;
  /** P-13 and the call, review notices: emails to cabinet clients outside the documents (`client-mail.ts`). Only `buildCabinet` makes it. */
  mail?: ClientMail;
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
  /** `UNSUBSCRIBE_SECRET`: without it HQ sends no news or recommendation letters. */
  unsubscribeSecret?: string | undefined;
  dataDir: string;
  mediaSecret?: string | undefined;
  mediaBase?: string | undefined;
  /** The key for agents' Telegram tokens at rest (`PG_SECRET`, else the media secret). */
  secret?: string | undefined;
  gate?: { llmAllowed(): boolean; llmUsed(): void } | undefined;
  /** How long a КП stands (`KP_VALID_DAYS`): the quote expires after it (P-11). */
  kpValidDays?: number | (() => number) | undefined;
  /** «Демо только для вошедших»: booking and cap of the demo per client (`demo-usage.ts`) and the switch that refuses an anonymous demo. */
  demoUsage?: DemoUsage | undefined;
  demoRequireClient?: boolean | undefined;
  /** The imported knowledge of the client's own website (`client-knowledge.ts`). */
  siteKnowledge?: ClientKnowledge | undefined;
}

/** Builds the three modules of the cabinet and the dispatcher; the heads get `docs` (`sales.cabinet = cabinet.docs`, ...). */
export function buildCabinet(o: CabinetDeps): CabinetApi {
  const hooks: CabinetHooks = {};
  const now = o.hq.now;
  const notifyOwner = (t: string) => hooks.notifyOwner?.(t);
  const cabinetTicket = (t: { id: number; name: string; text: string; telegram: string; leadId?: number }) => hooks.cabinetTicket?.(t);
  const mail = new ClientMail({ hq: o.hq, tools: o.tools, siteUrl: o.siteUrl, unsubscribeSecret: o.unsubscribeSecret });
  const docs = new CabDocs({ hq: o.hq, now, tools: o.tools, billing: o.billing, siteUrl: o.siteUrl, notifyOwner, mail, ...(o.kpValidDays !== undefined ? { kpValidDays: o.kpValidDays } : {}) });
  const ref: { pg?: Playground } = {};
  const threads = new CabThreads({
    db: o.hq.db, now, dataDir: o.dataDir, mediaSecret: o.mediaSecret, mediaBase: o.mediaBase, cabinetTicket, notifyOwner, leadJournal: (id, t) => hooks.leadJournal?.(id, t),
    agentReply: (cid, aid, text) => ref.pg!.threadReply(cid, aid, text), agents: (cid) => ref.pg?.agentsOf(cid) ?? [],
  });
  const playground = new Playground({
    db: o.hq.db, now, tz: () => o.hq.tz, llm: o.llm, secret: o.secret ?? o.mediaSecret, gate: o.gate, uploadText: (cid, uid) => threads.uploadText(cid, uid), notifyOwner,
    // P-21: the handoff of a client's agent goes to the client (his agent thread); the owner only hears the fact
    handoff: (clientId, agentId) => notifyOwner(`Агент #${agentId} клиента ${clientId} передал разговор посетителя владельцу агента (тред агента в кабинете клиента)`),
    journal: (agent, action, detail) => o.hq.log(agent, action, 'agent', detail), siteUrl: o.siteUrl, demoUsage: o.demoUsage, demoRequireClient: o.demoRequireClient, siteKnowledge: o.siteKnowledge,
  });
  ref.pg = playground;
  docs.attachPlayground(playground);
  const api = createCabinetApi({ docs, threads, playground, ...(o.siteKnowledge ? { siteKnowledge: o.siteKnowledge } : {}) });
  return { ...api, mail, ...(o.siteKnowledge ? { siteKnowledge: o.siteKnowledge } : {}), bind: (h) => void Object.assign(hooks, h) };
}

const num = (s: string | undefined): number | null => (s !== undefined && /^\d{1,12}$/.test(s) ? Number(s) : null);

export function createCabinetApi(m: { docs: CabDocs; threads: CabThreads; playground: Playground; siteKnowledge?: ClientKnowledge }): CabinetApi {
  const { docs, threads, playground, siteKnowledge } = m;
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
          if (post && seg.length === 4 && num(a) !== null && b === 'reject') return Promise.resolve(docs.reject(cid, num(a)!, body));
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
        case 'reviews':
          // P-16: the client's review of a closed project (the cabinet form)
          return post && seg.length === 2 ? Promise.resolve(addReview(docs.db, docs.now(), cid, body, docs.ownerLine)) : null;
        case 'uploads':
          return post && seg.length === 2 ? Promise.resolve(threads.upload(cid, body)) : null;
        case 'knowledge':
          if (!siteKnowledge) return null;
          if (get && seg.length === 2) return Promise.resolve(siteKnowledge.statusRoute(cid));
          if (post && seg.length === 3 && a === 'import') return Promise.resolve(siteKnowledge.importRoute(cid, body));
          return null;
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

