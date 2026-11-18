import { type KindSpec, type Payload } from '@fir/core';
import type { ApprovalState, Task, TaskApproval, Worker, WorkerCtx, WorkerResult } from '@fir/hq';
import { DAY, ReferralStore, STATUSES, STATUS_RU, type Referral } from './store.js';

export const KIND_REWARD = 'referral_reward';
/** Default reward (env `REFERRAL_REWARD`): one month of support free. */
export const DEFAULT_REWARD = 'месяц сопровождения бесплатно';

const stores = new WeakMap<object, ReferralStore>();
/** The worker's own table (`rf_referrals`) lives in the shared HQ database. The reward text is fixed on first use. */
export function storeFor(ctx: Pick<WorkerCtx, 'db' | 'now'>, reward: string = DEFAULT_REWARD): ReferralStore {
  let s = stores.get(ctx.db);
  if (!s) {
    s = new ReferralStore(ctx.db, reward, ctx.now);
    stores.set(ctx.db, s);
  }
  return s;
}

/** `/referral <client> -> <new lead>`: the arrow may be `->`, `→` or `=>`. */
export function parseReferralArg(arg: string): { referrer: string; referred: string } | null {
  const m = /^(.+?)\s*(?:->|→|=>)\s*(.+)$/s.exec(arg.trim());
  if (!m) return null;
  const referrer = m[1]!.trim();
  const referred = m[2]!.trim();
  return referrer && referred ? { referrer, referred } : null;
}

/** The form's `source=ref:<client>` to the referring client's name. */
export function referrerFromSource(source: string): string | null {
  const m = /^ref:(.+)$/i.exec(source.trim());
  return m ? m[1]!.replace(/[_-]+/g, ' ').trim() || null : null;
}

export const describe = (r: Referral): string => `#${r.id} ${r.referrer} привёл(а) ${r.referred}`;

export function statsText(store: ReferralStore): string {
  const s = store.stats();
  if (s.total === 0) return 'Рекомендаций пока нет. Записать: /referral <клиент> -> <новый лид>.';
  const open = store.all().filter((r) => r.status !== 'rewarded');
  return [
    `Рекомендации, всего ${s.total}: ${STATUSES.filter((k) => s.byStatus[k]).map((k) => `${STATUS_RU[k]} ${s.byStatus[k]}`).join(', ')}`,
    ...(open.length ? ['', 'Открытые:', ...open.map((r) => `${describe(r)}: ${STATUS_RU[r.status]}`)] : []),
  ].join('\n');
}

/** Owner's `/paid <id>`: the referred client paid. Only a proposed referral moves; the reward is asked by the caller. */
export function markPaid(store: ReferralStore, id: number): { ok: true; referral: Referral; already: boolean } | { ok: false; reason: 'unknown' | 'rewarded'; referral?: Referral } {
  const r = Number.isInteger(id) ? store.get(id) : undefined;
  if (!r) return { ok: false, reason: 'unknown' };
  if (r.status === 'rewarded') return { ok: false, reason: 'rewarded', referral: r };
  if (r.status === 'paid') return { ok: true, referral: r, already: true };
  return { ok: true, referral: store.transition(id, 'paid'), already: false };
}

export function rewardSummary(r: Referral): string {
  return `Награда за рекомендацию ${describe(r)}: клиент оплатил.\nНачислить: ${r.reward}.\n«Утвердить» значит, что вы применили награду сами. Система клиенту ничего не отправляет.`;
}

/** Locked at level 0: the reward is money. Approval of a paid referral is the only way to `rewarded`. */
export function kindSpecs(ctx: Pick<WorkerCtx, 'db' | 'now'>): Record<string, KindSpec> {
  return {
    [KIND_REWARD]: {
      initialLevel: 0,
      locked: true,
      buttons: (id) => [[{ text: 'Отклонить', data: `ap:${id}:r` }, { text: 'Утвердить', data: `ap:${id}:a` }]],
      execute: async (payload: Payload) => {
        const store = storeFor(ctx);
        const id = Number(payload.referralId);
        if (store.get(id)?.status !== 'paid') throw new Error('reward only after the referred client paid');
        store.transition(id, 'rewarded');
      },
    },
  };
}

/** The owner rejected the reward or it failed: the referral stays paid, a new /paid asks again. */
export function onDecision(ctx: Pick<WorkerCtx, 'db' | 'now'>, link: Pick<TaskApproval, 'kind' | 'payload'>, state: ApprovalState): void {
  if (link.kind !== KIND_REWARD || state === 'executed') return;
  storeFor(ctx).setRewardRequested(Number(link.payload.referralId), false);
}

/**
 * Referral (Рекомендации): actions (task.meta.action):
 *  - `reminders` (or the head's `referral_reminders`): referrals that wait for the payment (3 days, then every 7): a line each for the morning summary.
 */
export class ReferralWorker implements Worker {
  readonly id = 'referral';

  async run(task: Task, ctx: WorkerCtx): Promise<WorkerResult> {
    if (task.meta.action !== 'reminders' && task.meta.action !== 'referral_reminders') return { ok: false, result: '', error: `Неизвестное действие: ${String(task.meta.action)}` };
    const due = storeFor(ctx).takeReminders(ctx.now());
    if (due.length === 0) return { ok: true, result: '' };
    const days = (r: Referral) => Math.floor((ctx.now() - r.createdAt) / DAY);
    ctx.log('reminders', `due ${due.length}`);
    return { ok: true, result: `Рекомендации ждут оплаты: ${due.map((r) => `${describe(r)} (${days(r)} дн.), когда оплатит: /paid ${r.id}`).join('; ')}.` };
  }
}
