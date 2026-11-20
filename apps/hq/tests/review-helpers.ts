/* eslint-disable @typescript-eslint/no-explicit-any -- JSON bodies of the API under test */
import type { Payload } from '@fir/core';
import { BillingStore } from '@fir/worker-billing';
import { DocStore } from '@fir/worker-documents';
import { PmStore } from '@fir/worker-project-manager';
import { ProspectStore } from '@fir/worker-prospector';
import { ReferralStore } from '@fir/worker-referral';
import { storeFor } from '@fir/worker-content-maker';
import { pultWorld } from './pult-helpers.js';

/** The kinds the Sales and Back-office heads own (the Pult world seeds Marketing, Support and Production only): stubs that remember what was executed. */
const STUBS = ['lead_reply', 'lead_price', 'presales_pack', 'referral_reward', 'referral_payout', 'prospect_first', 'prospect_followup', 'prospect_reply', 'bo_document'];
const LOCKED = ['lead_price', 'presales_pack', 'referral_reward', 'referral_payout', 'bo_document'];

export function reviewWorld(opts: Parameters<typeof pultWorld>[0] = {}, o: { keepLevels?: boolean } = {}) {
  const p = pultWorld(opts);
  const executed: { kind: string; payload: Payload }[] = [];
  for (const kind of STUBS) p.w.hq.registerKind(kind, { initialLevel: 0, ...(LOCKED.includes(kind) ? { locked: true } : {}), execute: (payload) => { executed.push({ kind, payload }); return Promise.resolve(); } });
  // some kinds start at level 1 (the agent acts and reports): the fixtures want every card to wait for the owner, except where a test asks for it
  if (!o.keepLevels) for (const k of p.w.queue.trustTable()) p.w.queue.setLevel(k.kind, 0);
  /** A proposal of a department, queued for the next batch (`released`: sent to the owner as a card). */
  const propose = async (dept: string, kind: string, payload: Payload, summary: string, o: { release?: boolean } = {}) => {
    const task = p.w.hq.createTask({ title: `fixture ${kind}`, dept, creator: 'head' });
    const linkId = await p.w.hq.requestApproval(task.id, `${dept}-head`, kind, payload, summary);
    if (o.release) await p.w.hq.releaseApprovals();
    return { linkId, taskId: task.id, id: `ap_${linkId}` };
  };
  const items = async (qs = 'status=all&limit=200') => ((await p.call('GET', `/admin/review?${qs}`)).json.items as any[]);
  const item = async (id: string) => (await items()).find((i) => i.id === id) as any;
  const act = (id: string, body: Record<string, unknown>) => p.call('POST', `/admin/review/${id}`, body);
  const seed = {
    doc: () => new DocStore(p.w.db, p.t).add({ type: 'contract', client: 'Анна', projectId: null, text: 'Договор', taskId: null }),
    invoice: (leadId: number | null) => new BillingStore(p.w.db, p.t).addInvoice({ client: 'Анна', amountUsd: 250, what: 'Бот: предоплата', method: null, dueDate: '2026-11-25', subscriptionId: null, newProject: true, leadId, packId: null, projectId: null, totalUsd: 500, locale: 'ru' }, 2026),
    project: () => new PmStore(p.w.db, p.t).createProject({ client: 'Анна', what: 'Бот для салона', product: 'bot', source: 'test', taskId: null }),
    referral: (leadId: number) => new ReferralStore(p.w.db, '10%', p.t).propose({ referrer: 'Иван', referred: 'Анна', leadId, source: 'owner' }).referral,
    prospect: () => {
      const s = new ProspectStore(p.w.db, p.t);
      s.importCsv('id,ниша,город,название\n1,салон,Ташкент,Салон Роза');
      return s.find('Роза')[0]!;
    },
    article: (title: string) => {
      const s = storeFor({ db: p.w.db, now: p.t });
      const id = s.insertArticle('barbershop');
      s.setArticle(id, { status: 'proposed', title });
      return id;
    },
  };
  return { ...p, executed, propose, items, item, act, seed };
}
export type ReviewWorld = ReturnType<typeof reviewWorld>;
