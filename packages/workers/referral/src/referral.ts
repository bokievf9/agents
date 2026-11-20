import { type KindSpec, type Payload } from '@fir/core';
import type { ApprovalState, Task, TaskApproval, Worker, WorkerCtx, WorkerResult } from '@fir/hq';
import { DAY, PAYOUT_PERCENT, ReferralStore, STATUSES, STATUS_RU, type Referral } from './store.js';

export const KIND_REWARD = 'referral_reward';
/** The payout to the referrer (10% of the first confirmed estimate, USD): money, locked. Approving means the owner paid it. */
export const KIND_PAYOUT = 'referral_payout';
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

/** 10% of the estimate total, in USD cents precision. */
export const payoutAmount = (totalUsd: number): number => Math.round(totalUsd * PAYOUT_PERCENT) / 100;

const usd = (n: number): string => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
const ddmm = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

export function statsText(store: ReferralStore): string {
  const s = store.stats();
  if (s.total === 0) return 'Рекомендаций пока нет. Записать: /referral <клиент> -> <новый лид>.';
  const payouts = store.pendingPayouts();
  const open = store.all().filter((r) => r.status !== 'rewarded' && !payouts.includes(r));
  const later = store.stagePayouts().filter((x) => x.paidAt === null);
  return [
    `Рекомендации, всего ${s.total}: ${STATUSES.filter((k) => s.byStatus[k]).map((k) => `${STATUS_RU[k]} ${s.byStatus[k]}`).join(', ')}`,
    ...(payouts.length ? ['', `К выплате (${PAYOUT_PERCENT}% каждого оплаченного этапа, USDT, в течение 7 дней после оплаты клиента): ${usd(payouts.reduce((a, r) => a + (r.payoutUsd ?? 0), 0))}`, ...payouts.map((r) => `${describe(r)}: ${usd(r.payoutUsd ?? 0)}, контакт ${r.payoutContact || '-'}, ждёт с ${ddmm(r.payoutRequestedAt!)} (карточка в /approve)`)] : []),
    ...(later.length ? ['', `К выплате за следующие этапы: ${usd(later.reduce((a, x) => a + x.usd, 0))}`, ...later.map((x) => `рекомендация #${x.referralId}, этап ${x.stageNo}, счёт ${x.invoiceNumber}: ${usd(x.usd)}, контакт ${x.contact || '-'} (карточка в /approve)`)] : []),
    ...(open.length ? ['', 'Открытые:', ...open.map((r) => `${describe(r)}: ${STATUS_RU[r.status]}`)] : []),
  ].join('\n');
}

/** The owner's card of a payout: who, how much, where to send it. */
export function payoutSummary(r: Referral, invoiceNumber: string, stage?: { no: number; usd: number }): string {
  if (stage && stage.no > 1) {
    return `Выплата рекомендателю ${describe(r)}: клиент оплатил этап ${stage.no}, счёт ${invoiceNumber}.\nСумма: ${usd(stage.usd)} (${PAYOUT_PERCENT}% оплаты этапа ${stage.no}), USDT.\nКонтакт рекомендателя: ${r.payoutContact || '[контакт не найден: уточните]'}.\n«Утвердить» значит, что вы выплатили сами. Система денег не двигает.`;
  }
  return `Выплата рекомендателю ${describe(r)}: клиент оплатил ${stage ? `этап 1, счёт ${invoiceNumber}` : `первый счёт ${invoiceNumber}`}.\nСумма: ${usd(r.payoutUsd ?? 0)} (${PAYOUT_PERCENT}% ${stage ? 'оплаты этапа 1' : 'первой сметы'}), USDT.\nКонтакт рекомендателя: ${r.payoutContact || '[контакт не найден: уточните]'}.\n«Утвердить» значит, что вы выплатили сами. Система денег не двигает.`;
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

/** Locked at level 0: a payout is money, only the owner's own button marks it paid (`rewarded`). */
export function payoutKindSpecs(ctx: Pick<WorkerCtx, 'db' | 'now'>): Record<string, KindSpec> {
  return {
    [KIND_PAYOUT]: {
      initialLevel: 0,
      locked: true,
      buttons: (id) => [[{ text: 'Отклонить', data: `ap:${id}:r` }, { text: 'Выплатил', data: `ap:${id}:a` }]],
      execute: async (payload: Payload) => {
        const store = storeFor(ctx);
        const id = Number(payload.referralId);
        // the payout of a later stage (payment by stages): the referral row belongs to the first stage's payout
        const stageNo = Number(payload.stageNo);
        if (stageNo > 1) {
          if (!store.get(id)) throw new Error('unknown referral');
          store.settleStagePayout(id, stageNo);
          return;
        }
        if (store.get(id)?.status !== 'paid') throw new Error('payout only after the referred client paid');
        store.transition(id, 'rewarded');
      },
    },
  };
}

/** The owner rejected the reward or the payout, or it failed: the referral stays paid; a reward is asked again with /paid, a payout is cleared. */
export function onDecision(ctx: Pick<WorkerCtx, 'db' | 'now'>, link: Pick<TaskApproval, 'kind' | 'payload'>, state: ApprovalState): void {
  if (state === 'executed') return;
  if (link.kind === KIND_REWARD) storeFor(ctx).setRewardRequested(Number(link.payload.referralId), false);
  if (link.kind === KIND_PAYOUT) {
    const stageNo = Number(link.payload.stageNo);
    if (stageNo > 1) storeFor(ctx).releaseStagePayout(Number(link.payload.referralId), stageNo);
    else storeFor(ctx).clearPayout(Number(link.payload.referralId));
  }
}

/**
 * Referral (Рекомендации): actions (task.meta.action):
 *  - `reminders` (or the head's `referral_reminders`): referrals that wait for the payment (3 days, then every 7): a line each for the morning summary.
 */
export class ReferralWorker implements Worker {
  readonly id = 'referral';

  async run(task: Task, ctx: WorkerCtx): Promise<WorkerResult> {
    if (task.meta.action !== 'reminders' && task.meta.action !== 'referral_reminders') return { ok: false, result: '', error: `Неизвестное действие: ${String(task.meta.action)}` };
    const store = storeFor(ctx);
    const due = store.takeReminders(ctx.now());
    const payouts = store.takePayoutReminders(ctx.now());
    if (due.length === 0 && payouts.length === 0) return { ok: true, result: '' };
    const days = (r: Referral) => Math.floor((ctx.now() - r.createdAt) / DAY);
    const out: string[] = [];
    if (due.length) out.push(`Рекомендации ждут оплаты: ${due.map((r) => `${describe(r)} (${days(r)} дн.), когда оплатит: /paid ${r.id}`).join('; ')}.`);
    if (payouts.length) {
      out.push(`Выплаты рекомендателям ждут 7 дней и больше: ${payouts.map((r) => `${describe(r)}, ${usd(r.payoutUsd ?? 0)}, контакт ${r.payoutContact || '-'}`).join('; ')}. Карточка в /approve.`);
    }
    ctx.log('reminders', `due ${due.length}, payouts ${payouts.length}`);
    return { ok: true, result: out.join('\n') };
  }

  /**
   * The referred client's first invoice was paid: the payout (10% of the estimate total, USD) is asked of the owner as a locked approval
   * with the referrer's contact. Once per referral. Returns the referral, or null when there is nothing to ask (no such referral,
   * or asked before). The caller stages the approval (`payoutSummary`, kind `KIND_PAYOUT`).
   */
  requestPayout(ctx: Pick<WorkerCtx, 'db' | 'now'>, a: { referralId: number; totalUsd: number; contact: string }): Referral | null {
    const store = storeFor(ctx);
    const r = store.get(a.referralId);
    if (!r || r.status === 'rewarded' || r.payoutRequestedAt !== null) return null;
    if (r.status === 'proposed') store.transition(r.id, 'paid');
    if (!store.requestPayout(r.id, { usd: payoutAmount(a.totalUsd), contact: a.contact })) return null;
    return store.get(r.id)!;
  }

  /**
   * A later stage (2, 3, ...) of the referred client's project was paid: 10% of THAT stage is asked of the owner, once per stage
   * (idempotent by referral and stage). Returns the amount, or null when it was asked before or the referral is unknown.
   */
  requestStagePayout(ctx: Pick<WorkerCtx, 'db' | 'now'>, a: { referralId: number; stageNo: number; stageUsd: number; contact: string; invoiceNumber: string }): { usd: number } | null {
    const store = storeFor(ctx);
    const r = store.get(a.referralId);
    if (!r || a.stageNo < 2) return null;
    if (r.status === 'proposed') store.transition(r.id, 'paid');
    const usd = payoutAmount(a.stageUsd);
    return store.claimStagePayout({ referralId: r.id, stageNo: a.stageNo, invoiceNumber: a.invoiceNumber, usd, contact: a.contact }) ? { usd } : null;
  }
}
