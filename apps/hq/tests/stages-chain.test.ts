import { stagesFor } from '@fir/core';
import { billingStoreFor } from '@fir/worker-billing';
import { PmStore, stageState } from '@fir/worker-project-manager';
import { describe, expect, it } from 'vitest';
import { approvedKp, chainWorld, QUALIFIED, type W } from './chain-helpers.js';

/** Payment by stages (owner decision 2026-11-21): each stage paid before it starts, the next invoice after acceptance, the last before handover. */
const APP = { ...QUALIFIED, source: 'miniapp', service: 'bots', message: 'Нужно Mini App для салона' };
const REF = { ...APP, name: 'Blanche', contact: '@blanche', source: 'ref:cambridge' };

const invoices = (w: W) => billingStoreFor({ db: w.db, now: w.hq.now }).invoices(undefined, 50).reverse();
const pm = (w: W) => new PmStore(w.db, w.hq.now);

/** The invoice card of the stage is approved (issued) and the owner marks it paid. */
async function payNext(w: W): Promise<string> {
  await w.beat();
  await w.director.sendApprovalBatch(false);
  const card = w.queue.pending().find((p) => p.kind === 'billing_invoice')!;
  await w.decide('approve', card.id);
  const inv = invoices(w).find((i) => i.status === 'issued')!;
  await w.cmd('paid', inv.number);
  return inv.number;
}

/** The ТЗ is approved after stage 1 is paid. */
async function approveSpec(w: W) {
  await w.beat();
  await w.director.sendApprovalBatch(false);
  await w.decide('approve', w.queue.pending().find((p) => p.kind === 'pm_spec')!.id);
}

describe('stage plan: the chain stage by stage', () => {
  it('an approved КП makes the milestones = stages and the invoice of stage 1 ONLY', async () => {
    const w = chainWorld();
    await approvedKp(w, APP);
    const total = 660;
    const stages = stagesFor(total, ['miniapp']);
    expect(stages.map((s) => s.amountUsd)).toEqual([165, 165, 165, 165]);
    const p = pm(w).projects('draft')[0]!;
    expect(pm(w).stageMilestones(p.id).map((m) => [m.stageNo, m.amountUsd])).toEqual([[1, 165], [2, 165], [3, 165], [4, 165]]);
    await w.beat();
    expect(invoices(w)).toHaveLength(1);
    expect(invoices(w)[0]).toMatchObject({ stageNo: 1, amountUsd: 165, projectId: p.id, totalUsd: total, status: 'draft' });
    expect(pm(w).stageMilestone(p.id, 1)!.invoiceNumber).toBe(invoices(w)[0]!.number);
    expect(pm(w).stageMilestone(p.id, 2)!.invoiceNumber).toBeNull();
    await w.director.sendApprovalBatch(false);
    const card = w.messenger.sent.find((m) => m.text.includes('billing_invoice'))!;
    expect(card.text).toContain('счёт этапа 1 (эта карточка)');
    expect(card.text).toContain('Ссылка на оплату: https://firtech.pro/ru/pay/FT-2026-001?k=');
    expect(card.text).not.toMatch(/50%|предоплат/i);
  });

  it('paid stage 1 starts the project; accepting stage N proposes the invoice of N+1; paid N+1 starts that stage; every step happens once', async () => {
    const w = chainWorld();
    await approvedKp(w, APP);
    const p = pm(w).projects('draft')[0]!;
    await payNext(w);
    expect(w.lastToOwner()).toContain('стартует по оплате этапа 1');
    await approveSpec(w);
    expect(pm(w).project(p.id)!.status).toBe('active');
    let builders = w.hq.tasks({ dept: 'production' }).filter((t) => t.tags.includes('builder'));
    expect(builders.map((t) => t.meta.stageNo)).toEqual([1]);
    expect(stageState(pm(w).stageMilestone(p.id, 1)!)).toBe('in_progress');
    // no invoice for stage 2 before stage 1 is accepted
    await w.beat();
    expect(invoices(w)).toHaveLength(1);
    // the owner accepts stage 1 (/mdone <project> <stage>): the next invoice is proposed, once
    await w.cmd('mready', `${p.id} 1`); // P-15: the stage is ready first, then accepted
    await w.cmd('mdone', `${p.id} 1`);
    expect(w.lastToOwner()).toContain('этап 1');
    expect(w.lastToOwner()).toContain('принят');
    await w.cmd('mdone', `${p.id} 1`);
    expect(w.lastToOwner()).toContain('уже принят');
    expect(stageState(pm(w).stageMilestone(p.id, 1)!)).toBe('accepted');
    await w.beat();
    expect(invoices(w).map((i) => [i.stageNo, i.status])).toEqual([[1, 'paid'], [2, 'draft']]);
    expect(w.hq.tasks({ dept: 'support' }).filter((t) => t.meta.action === 'kp_invoice' && t.meta.stageNo === 2)).toHaveLength(1);
    // stage 2 is not started until paid
    expect(stageState(pm(w).stageMilestone(p.id, 2)!)).toBe('awaiting_payment');
    await payNext(w);
    expect(stageState(pm(w).stageMilestone(p.id, 2)!)).toBe('in_progress');
    builders = w.hq.tasks({ dept: 'production' }).filter((t) => t.tags.includes('builder'));
    expect(builders.map((t) => t.meta.stageNo)).toEqual([1, 2]);
    // a second /paid starts nothing
    await w.cmd('paid', 'FT-2026-002');
    expect(w.hq.tasks({ dept: 'production' }).filter((t) => t.tags.includes('builder'))).toHaveLength(2);
  });

  it('a stage cannot be accepted before it is paid; a finished builder stage waits for acceptance', async () => {
    const w = chainWorld();
    await approvedKp(w, APP);
    const p = pm(w).projects('draft')[0]!;
    expect(w.production.acceptStage(p.id, 1, 'owner').status).toBe('not_paid');
    expect(w.production.acceptStage(p.id, 9, 'owner').status).toBe('unknown');
    await payNext(w);
    expect(w.production.acceptStage(p.id, 1, 'client').status).toBe('not_ready'); // still in progress
    pm(w).markDone(pm(w).stageMilestone(p.id, 1)!.id);
    expect(stageState(pm(w).stageMilestone(p.id, 1)!)).toBe('awaiting_acceptance');
    expect(w.production.acceptStage(p.id, 1, 'client').status).toBe('accepted');
    expect(w.production.acceptStage(p.id, 1, 'client').status).toBe('already');
  });

  it('the last invoice is proposed when the penultimate stage is accepted; the handover task is blocked until it is paid; accepting the last closes the project', async () => {
    const w = chainWorld();
    await approvedKp(w, APP);
    const p = pm(w).projects('draft')[0]!;
    await payNext(w);
    await approveSpec(w);
    await w.cmd('mready', `${p.id} 1`); // P-15: the stage is ready first, then accepted
    await w.cmd('mdone', `${p.id} 1`);
    await payNext(w);
    await w.cmd('mready', `${p.id} 2`); // P-15: the stage is ready first, then accepted
    await w.cmd('mdone', `${p.id} 2`);
    await payNext(w); // stage 3 paid
    expect(w.hq.tasks({ dept: 'production' }).some((t) => t.meta.action === 'handover')).toBe(false);
    await w.cmd('mready', `${p.id} 3`); // P-15: the stage is ready first, then accepted
    await w.cmd('mdone', `${p.id} 3`); // penultimate accepted: the invoice of stage 4 and the handover hold
    expect(w.lastToOwner()).toContain('передача доступов ждёт его оплаты');
    const handover = () => w.hq.tasks({ dept: 'production', limit: 100 }).find((t) => t.meta.action === 'handover')!;
    expect(handover().status).toBe('blocked');
    await w.beat();
    expect(invoices(w).at(-1)).toMatchObject({ stageNo: 4, status: 'draft' });
    expect(w.queue.pending().length + w.messenger.sent.length).toBeGreaterThan(0);
    await w.director.sendApprovalBatch(false);
    const card = w.queue.pending().find((p2) => p2.kind === 'billing_invoice')!;
    expect(String(card.payload.text)).toContain('Этап 4 из 4');
    await w.decide('approve', card.id);
    expect(handover().status).toBe('blocked'); // issued but not paid
    await w.cmd('paid', invoices(w).at(-1)!.number);
    expect(w.lastToOwner()).toContain('разблокирована');
    expect(handover().status).toBe('inbox');
    await w.beat();
    expect(handover().status).toBe('done');
    // the last stage accepted: the project closes, no fifth invoice
    await w.cmd('mready', `${p.id} 4`); // P-15: the stage is ready first, then accepted
    await w.cmd('mdone', `${p.id} 4`);
    expect(w.lastToOwner()).toContain('Проект закрыт');
    expect(pm(w).project(p.id)!.status).toBe('done');
    await w.beat();
    expect(invoices(w)).toHaveLength(4);
  });

  it('a small project (under the threshold) is two stages; the second invoice comes after stage 1 is accepted and the handover waits for it', async () => {
    const w = chainWorld();
    await approvedKp(w);
    const p = pm(w).projects('draft')[0]!;
    expect(pm(w).stageMilestones(p.id)).toHaveLength(2);
    await payNext(w);
    await approveSpec(w);
    await w.cmd('mready', `${p.id} 1`); // P-15: the stage is ready first, then accepted
    await w.cmd('mdone', `${p.id} 1`);
    expect(w.hq.tasks({ dept: 'production', limit: 100 }).find((t) => t.meta.action === 'handover')!.status).toBe('blocked');
    await w.beat();
    expect(invoices(w).at(-1)).toMatchObject({ stageNo: 2 });
  });

  it('proposing the next invoice twice (a repeated task) makes one invoice', async () => {
    const w = chainWorld();
    await approvedKp(w, APP);
    const p = pm(w).projects('draft')[0]!;
    await payNext(w);
    await approveSpec(w);
    await w.cmd('mready', `${p.id} 1`); // P-15: the stage is ready first, then accepted
    await w.cmd('mdone', `${p.id} 1`);
    await w.beat();
    const meta = w.hq.tasks({ dept: 'support', limit: 100 }).find((t) => t.meta.action === 'kp_invoice' && t.meta.stageNo === 2)!.meta;
    w.hq.createTask({ title: 'дубль', dept: 'support', creator: 'head', meta });
    w.hq.wake('support-head', 'task');
    await w.beat();
    expect(invoices(w).filter((i) => i.stageNo === 2)).toHaveLength(1);
  });
});

describe('referral payout per paid stage', () => {
  async function through(w: W) {
    await w.cmd('client', 'cambridge | @cambridge_owner | бот');
    await approvedKp(w, REF);
    const p = pm(w).projects('draft')[0]!;
    await payNext(w);
    await approveSpec(w);
    return p;
  }

  it('one locked payout per paid stage: 10% of THAT stage; a repeated /paid asks nothing; the owner can approve each', async () => {
    const w = chainWorld();
    const p = await through(w);
    expect(w.toOwner().some((m) => m.includes('Рекомендатель cambridge: выплата $16.5 (10% этапа 1'))).toBe(true);
    await w.cmd('mready', `${p.id} 1`); // P-15: the stage is ready first, then accepted
    await w.cmd('mdone', `${p.id} 1`);
    await payNext(w);
    expect(w.toOwner().some((m) => m.includes('выплата $16.5 (10% этапа 2'))).toBe(true);
    await w.cmd('paid', 'FT-2026-002');
    const payouts = () => w.queue.pending().filter((x) => x.kind === 'referral_payout');
    await w.director.sendApprovalBatch(false);
    expect(payouts().map((x) => x.payload.stageNo)).toEqual([1, 2]);
    expect(payouts().map((x) => x.payload.amountUsd)).toEqual([16.5, 16.5]);
    for (const x of payouts()) await w.decide('approve', x.id);
    await w.cmd('referrals');
    expect(w.lastToOwner()).not.toContain('К выплате');
  });

  it('an invoice outside the stage plan keeps the old rule: only the first paid invoice of the lead, 10% of the total', async () => {
    const w = chainWorld();
    await w.cmd('client', 'cambridge | @cambridge_owner | бот');
    await approvedKp(w, REF);
    const inv = (await import('@fir/worker-billing')).billingStoreFor({ db: w.db, now: w.hq.now });
    await w.beat();
    inv.markManualPaid(1);
    const one = inv.invoice(1)!;
    expect(await w.sales.onInvoicePaid({ ...one, stageNo: null, totalUsd: 1000, amountUsd: 500, status: 'paid' })).toEqual([expect.stringContaining('10% сметы')]);
  });
});
