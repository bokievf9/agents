import { stagesFor } from '@fir/core';
import { billingStoreFor } from '@fir/worker-billing';
import { leadStoreFor } from '@fir/worker-lead-intake';
import { OFFERS, storeFor as presalesStore } from '@fir/worker-presales';
import { PmStore } from '@fir/worker-project-manager';
import { storeFor as referralStore } from '@fir/worker-referral';
import { describe, expect, it } from 'vitest';
import { COMMAND_NAMES } from '../src/commands.js';
import { isQualified } from '../src/heads/sales.js';
import { approvedKp, chainWorld, DAY, QUALIFIED, type W } from './chain-helpers.js';
import { NOW, OWNER } from './helpers.js';

/**
 * The sales chain (owner decisions 2026-11-19): a qualified lead gets its КП by itself; an approved КП drafts the contract and the invoice for the
 * prepayment in one go and only RESERVES a project; the project starts when the first invoice is paid; the referral payout follows that payment.
 */
describe('qualified lead: the КП makes itself', () => {
  it('a service and a budget (or an estimate) qualify; a service alone, or a budget without a service, does not', () => {
    expect(isQualified({ service: 'bots', budget: '$300' })).toBe(true);
    expect(isQualified({ service: 'websites', budget: '' }, { estimate: 'Сайт-визитка, от $150' })).toBe(true);
    expect(isQualified({ service: 'unknown', budget: '$300' })).toBe(false);
    expect(isQualified({ service: 'other', budget: '$300' })).toBe(false);
    expect(isQualified({ service: 'bots', budget: '' })).toBe(false);
    expect(isQualified({ service: 'other', budget: '$300' }, { product: 'Бот-администратор' })).toBe(true);
  });

  it('Presales drafts the КП without /kp: one locked approval, once, with the lead on the card', async () => {
    const w = chainWorld();
    w.sales.createLeadTask(QUALIFIED, 'bots');
    await w.beat();
    const kpTask = w.hq.tasks({ dept: 'sales' }).find((t) => t.meta.action === 'kp')!;
    expect(kpTask).toMatchObject({ creator: 'head', meta: { action: 'kp', auto: true } });
    expect(w.hq.reports(0).some((r) => r.body.includes('квалифицирован'))).toBe(true);
    await w.beat();
    expect(w.hq.task(kpTask.id)!.status).toBe('approval');
    const lead = leadStoreFor({ db: w.db, now: w.hq.now }).byTask(1)!;
    expect(presalesStore({ db: w.db, now: w.hq.now }).byLead(lead.id)).toHaveLength(3);
    expect(w.queue.trustTable().find((t) => t.kind === 'presales_pack')).toMatchObject({ locked: true, level: 0 });
    await w.director.sendApprovalBatch(false);
    const card = w.messenger.sent.find((m) => m.text.includes('presales_pack'))!;
    expect(card.text).toContain(`лид #${lead.id} Dilnoza`);
    expect(card.text).toContain('договор и счёт на первый этап');
    // the same lead worked again (a rework) does not make a second КП: while the first one is open, and after it is made
    const again = () => (w.sales as unknown as { startKpFor(taskId: number, lead: unknown): Promise<void> }).startKpFor(1, lead);
    await again();
    expect(w.hq.tasks({ dept: 'sales' }).filter((t) => t.meta.action === 'kp')).toHaveLength(1);
    w.hq.setStatus(kpTask.id, 'rejected', 'owner');
    await again(); // the draft documents exist: still no second one
    expect(w.hq.tasks({ dept: 'sales' }).filter((t) => t.meta.action === 'kp')).toHaveLength(1);
  });

  it('a lead without a service and a budget waits for the owner: no КП', async () => {
    const w = chainWorld();
    w.sales.createLeadTask({ ...QUALIFIED, service: 'unknown', budget: '' }, 'unknown');
    w.sales.createLeadTask({ ...QUALIFIED, name: 'Blanche', budget: '' }, 'bots');
    await w.beat();
    await w.beat();
    expect(w.hq.tasks({ dept: 'sales' }).filter((t) => t.meta.action === 'kp')).toHaveLength(0);
    await w.cmd('kp', '#1'); // /kp stays
    expect(w.lastToOwner()).toContain('Готовлю КП');
  });
});

describe('an approved КП: contract and invoice in one go, the project only reserved', () => {
  it('Documents drafts the contract (locked), Billing the invoice of stage 1 only (locked); the cards name each other; nothing is sent to the client', async () => {
    const w = chainWorld();
    const pack = await approvedKp(w);
    const direction = presalesStore({ db: w.db, now: w.hq.now }).pack(1)[0]!.direction as keyof typeof OFFERS;
    const total = OFFERS[direction].fromUsd;
    // production is untouched: the project is reserved, not started
    expect(w.hq.tasks({ dept: 'production' })).toHaveLength(0);
    const pm = new PmStore(w.db, w.hq.now);
    const reserved = pm.projects('draft');
    expect(reserved).toHaveLength(1);
    expect(reserved[0]).toMatchObject({ client: 'Dilnoza', packId: 1, source: 'sales', product: 'bot' });
    // the milestones are the stages of the КП (a bot-administrator is a small project: two stages), none paid yet
    expect(pm.milestones(reserved[0]!.id).map((m) => [m.kind, m.stageNo, m.amountUsd, m.paidAt])).toEqual(stagesFor(total, ['admin']).map((x) => ['stage', x.no, x.amountUsd, null]));
    // both tasks exist at once
    expect(w.hq.tasks({ dept: 'backoffice' })[0]!.meta).toMatchObject({ action: 'doc', type: 'contract', projectId: reserved[0]!.id });
    expect(w.hq.tasks({ dept: 'support' }).find((t) => t.meta.action === 'kp_invoice')!.meta).toMatchObject({ amountUsd: stagesFor(total, ['admin'])[0]!.amountUsd, totalUsd: total, stageNo: 1 });
    await w.beat();
    await w.director.sendApprovalBatch(false);
    const contract = w.messenger.sent.find((m) => m.text.includes('bo_document'))!;
    const invoice = w.messenger.sent.find((m) => m.text.includes('billing_invoice'))!;
    expect(contract.text).toContain(`КП #1 (утверждено) → договор (эта карточка) → счёт этапа 1 → проект #${reserved[0]!.id} стартует после оплаты этапа 1`);
    expect(invoice.text).toContain('КП #1 (утверждено) → договор → счёт этапа 1 (эта карточка)');
    expect(invoice.text).toContain(`$${stagesFor(total, ['admin'])[0]!.amountUsd}`);
    expect(w.queue.trustTable().filter((t) => ['bo_document', 'billing_invoice'].includes(t.kind)).every((t) => t.locked && t.level === 0)).toBe(true);
    // «Одобрить все обычные» never takes them
    expect((await w.queue.approveAll(OWNER)).approved).toBe(0);
    // the invoice carries its chain: lead, pack, project, estimate total
    const inv = billingStoreFor({ db: w.db, now: w.hq.now }).invoice(1)!;
    expect(inv).toMatchObject({ client: 'Dilnoza', newProject: true, leadId: 1, packId: 1, projectId: reserved[0]!.id, totalUsd: total, stageNo: 1, amountUsd: stagesFor(total, ['admin'])[0]!.amountUsd, status: 'draft' });
    expect(pack).toBeGreaterThan(0);
    // the owner approves the invoice text: it goes to HIM to send (the system sends nothing), the invoice is issued
    const card = w.queue.pending().find((p) => p.kind === 'billing_invoice')!;
    await w.decide('approve', card.id);
    expect(w.toOwner().some((m) => m.includes('Счёт утверждён, отправьте клиенту Dilnoza'))).toBe(true);
    expect(billingStoreFor({ db: w.db, now: w.hq.now }).invoice(1)!.status).toBe('issued');
  });

  it('the exact price and the conditions line travel with the chain: КП, contract and invoice say the same, and what the client already has changes the line', async () => {
    const w = chainWorld();
    await approvedKp(w, { ...QUALIFIED, hasDomain: true, hasHosting: true });
    await w.beat();
    await w.director.sendApprovalBatch(false);
    const pack = presalesStore({ db: w.db, now: w.hq.now }).pack(1);
    const total = OFFERS[pack[0]!.direction as keyof typeof OFFERS].fromUsd; // the base package of a bot-administrator costs what the price list says
    const short = 'Домен и хостинг у заказчика есть, используем их; платные сторонние сервисы (SMS, API, платежи) оплачиваются отдельно.';
    expect(pack[0]!.body).toContain(short);
    const text = (w: W, kind: string) => String(w.queue.pending().find((p) => p.kind === kind)!.payload.text);
    const contract = text(w, 'bo_document');
    expect(contract).toContain(short);
    expect(contract).not.toContain('[цена]'); // the exact price is filled, the owner has nothing to type
    expect(contract).toContain(`в долларах США: $${total}.`);
    expect(text(w, 'billing_invoice')).toContain(`Что не входит в сумму: ${short}`);
    // a lead that never said anything about them gets the default line everywhere
    const w2 = chainWorld();
    await approvedKp(w2);
    await w2.beat();
    await w2.director.sendApprovalBatch(false);
    const dflt = 'Домен, хостинг, сервер и платные сторонние сервисы (SMS, API, платежи) в сумму не входят: заказчик оплачивает их напрямую, цена у всех разная. Для ориентира: домен $10-15 в год, хостинг от $5 в месяц.';
    expect(text(w2, 'bo_document')).toContain(dflt);
    expect(text(w2, 'billing_invoice')).toContain(dflt);
  });

  it('a drill КП never makes a real project, contract or invoice', async () => {
    const w = chainWorld();
    w.sales.createLeadTask(QUALIFIED, 'bots');
    await w.beat();
    await w.beat();
    const kpTask = w.hq.tasks({ dept: 'sales' }).find((t) => t.meta.action === 'kp')!;
    w.hq.addTags(kpTask.id, ['drill']);
    await w.director.sendApprovalBatch(false);
    await w.decide('approve', w.queue.pending().find((p) => p.kind === 'presales_pack')!.id);
    expect(new PmStore(w.db, w.hq.now).projects()).toHaveLength(0);
    expect(w.hq.tasks({ dept: 'backoffice' })).toHaveLength(0);
    expect(w.hq.tasks({ dept: 'support' }).filter((t) => t.meta.action === 'kp_invoice')).toHaveLength(0);
  });

  it('the same pack approved twice reserves one project (the reservation is per pack)', () => {
    const w = chainWorld();
    const pm = new PmStore(w.db, w.hq.now);
    const a = pm.reserve({ client: 'X', what: 'w', product: 'bot', leadId: null, packId: 7 });
    expect(pm.reserve({ client: 'X', what: 'w', product: 'bot', leadId: null, packId: 7 }).id).toBe(a.id);
    expect(pm.projects()).toHaveLength(1);
  });
});

describe('the project starts on payment, not on the КП approval', () => {
  it('/paid on the stage-1 invoice creates the Production task for the reserved project: the stages are its milestones, the ТЗ for approval; a second /paid starts nothing', async () => {
    const w = chainWorld();
    await approvedKp(w);
    await w.beat();
    await w.director.sendApprovalBatch(false);
    await w.decide('approve', w.queue.pending().find((p) => p.kind === 'billing_invoice')!.id);
    const pm = new PmStore(w.db, w.hq.now);
    const reserved = pm.projects('draft')[0]!;
    expect(w.hq.tasks({ dept: 'production' })).toHaveLength(0);

    await w.cmd('paid', 'FT-2026-001');
    const reply = w.lastToOwner();
    expect(reply).toContain('оплачен');
    expect(reply).toContain(`Проект #${reserved.id} «Dilnoza» стартует по оплате этапа 1`);
    const task = w.hq.tasks({ dept: 'production' })[0]!;
    expect(task.meta).toMatchObject({ action: 'project', source: 'sales', projectId: reserved.id, product: 'bot' });
    await w.beat();
    // the SAME project row got its milestones (no second project), the ТЗ waits for the owner
    expect(pm.projects()).toHaveLength(1);
    expect(pm.milestones(reserved.id).map((m) => [m.kind, m.stageNo])).toEqual([['stage', 1], ['stage', 2]]);
    expect(pm.stageMilestone(reserved.id, 1)!.paidAt).not.toBeNull();
    expect(pm.stageMilestone(reserved.id, 2)!.paidAt).toBeNull();
    expect(pm.project(reserved.id)).toMatchObject({ status: 'draft', taskId: task.id, spec: expect.stringContaining('ТЗ') });
    expect(w.queue.pending().some((p) => p.kind === 'pm_spec')).toBe(false); // queued for the batch
    await w.director.sendApprovalBatch(false);
    const spec = w.queue.pending().find((p) => p.kind === 'pm_spec')!;
    await w.decide('approve', spec.id);
    expect(pm.project(reserved.id)!.status).toBe('active');
    // only the paid stage gets a builder task
    const builders = w.hq.tasks({ dept: 'production' }).filter((t) => t.tags.includes('builder'));
    expect(builders).toHaveLength(1);
    expect(builders[0]!.meta).toMatchObject({ kind: 'work', milestone: 'stage', stageNo: 1 });

    // nothing starts twice
    await w.cmd('paid', 'FT-2026-001');
    expect(w.lastToOwner()).toContain('уже отмечен');
    expect(w.hq.tasks({ dept: 'production' }).filter((t) => t.meta.action === 'project')).toHaveLength(1);
  });

  it('the project task fails loudly when the reserved project is already running (no second start)', async () => {
    const w = chainWorld();
    await approvedKp(w);
    const pm = new PmStore(w.db, w.hq.now);
    const reserved = pm.projects('draft')[0]!;
    pm.start(reserved.id, { product: 'bot', what: 'x', taskId: 99 });
    expect(w.production.onInvoicePaid({ client: 'Dilnoza', projectId: reserved.id })).toEqual([]);
    expect(w.production.onInvoicePaid({ client: 'Dilnoza', projectId: reserved.id, stageNo: 1, number: 'FT-2026-001' }).filter((l) => l.includes('стартует'))).toEqual([]);
  });

  it('a project made by hand with /project starts at once as before; /paid of an unlinked invoice starts nothing', async () => {
    const w = chainWorld();
    await w.cmd('project', 'Салон Роза: сайт с записью');
    await w.beat();
    expect(new PmStore(w.db, w.hq.now).projects()).toHaveLength(1);
    expect(new PmStore(w.db, w.hq.now).milestones(1).length).toBeGreaterThan(0);
    await w.cmd('invoice', 'Салон Роза 100 предоплата new');
    await w.cmd('paid', 'FT-2026-001');
    expect(w.hq.tasks({ dept: 'production' }).filter((t) => t.meta.action === 'project')).toHaveLength(1);
  });

  it('the commands of the chain stay: /kp, /doc, /invoice, /paid are in the one command list', () => {
    expect(COMMAND_NAMES).toEqual(expect.arrayContaining(['kp', 'doc', 'invoice', 'paid', 'project']));
  });
});

describe('referral payout: 10% of the paid stage, in USD, locked', () => {
  const REF = { ...QUALIFIED, name: 'Blanche', contact: '@blanche', source: 'ref:cambridge' };

  async function paidReferred(w: W) {
    await w.cmd('client', 'cambridge | @cambridge_owner | бот');
    await approvedKp(w, REF);
    await w.beat();
    await w.director.sendApprovalBatch(false);
    await w.decide('approve', w.queue.pending().find((p) => p.kind === 'billing_invoice')!.id);
    await w.cmd('paid', 'FT-2026-001');
  }

  it('the first paid stage of a ref: lead asks a locked payout with the amount and the referrer contact; /referrals lists it', async () => {
    const w = chainWorld();
    await paidReferred(w);
    const payout = Math.round(stagesFor(OFFERS.admin.fromUsd, ['admin'])[0]!.amountUsd * 10) / 100; // 10% of stage 1
    expect(w.toOwner().some((m) => m.includes(`Рекомендатель cambridge: выплата $${payout}`))).toBe(true);
    expect(w.queue.trustTable().find((t) => t.kind === 'referral_payout')).toMatchObject({ locked: true, level: 0 });
    await w.director.sendApprovalBatch(false);
    const card = w.messenger.sent.find((m) => m.text.includes('referral_payout'))!;
    expect(card.text).toContain(`Сумма: $${payout}`);
    expect(card.text).toContain('Контакт рекомендателя: @cambridge_owner');
    expect(card.buttons!.flat().map((b) => b.text)).toEqual(['Отклонить', 'Выплатил']);
    // the payout is listed with the pending ones
    await w.cmd('referrals');
    expect(w.lastToOwner()).toContain('К выплате');
    expect(w.lastToOwner()).toContain(`$${payout}`);
    expect(w.lastToOwner()).toContain('@cambridge_owner');
    // a second /paid or a repeated hook asks nothing again
    await w.cmd('paid', 'FT-2026-001');
    expect(w.queue.pending().filter((p) => p.kind === 'referral_payout')).toHaveLength(1);
    // the owner paid the referrer: «Выплатил» closes it
    await w.decide('approve', w.queue.pending().find((p) => p.kind === 'referral_payout')!.id);
    expect(referralStore({ db: w.db, now: w.hq.now }).get(1)).toMatchObject({ status: 'rewarded', payoutUsd: payout });
    await w.cmd('referrals');
    expect(w.lastToOwner()).not.toContain('К выплате');
  });

  it('a payout not paid within 7 days is reminded: in the report and as an alert; rejecting it clears the request', async () => {
    const w = chainWorld();
    await paidReferred(w);
    const run = async () => {
      w.hq.createTask({ title: 'Напоминания', dept: 'sales', creator: 'routine', meta: { action: 'referral_reminders' } });
      w.hq.wake('sales-head', 'schedule');
      await w.sales.onHeartbeat();
    };
    await run();
    expect(w.alerts.filter((a) => a.includes('Выплаты рекомендателям'))).toHaveLength(0);
    w.clock.t += 7 * DAY + 1000;
    await run();
    expect(w.alerts.filter((a) => a.includes('Выплаты рекомендателям ждут 7 дней'))).toHaveLength(1);
    expect(w.hq.reports(0).some((r) => r.body.includes('Выплаты рекомендателям'))).toBe(true);
    // not reminded again the next day
    w.clock.t += DAY;
    await run();
    expect(w.alerts.filter((a) => a.includes('Выплаты рекомендателям'))).toHaveLength(1);
    await w.director.sendApprovalBatch(false);
    await w.decide('reject', w.queue.pending().find((p) => p.kind === 'referral_payout')!.id);
    expect(referralStore({ db: w.db, now: w.hq.now }).get(1)).toMatchObject({ status: 'paid', payoutUsd: null, payoutRequestedAt: null });
  });

  it('a lead without a referral tag, or a second paid invoice of the lead, asks no payout', async () => {
    const w = chainWorld();
    await approvedKp(w);
    await w.beat();
    await w.director.sendApprovalBatch(false);
    await w.decide('approve', w.queue.pending().find((p) => p.kind === 'billing_invoice')!.id);
    await w.cmd('paid', 'FT-2026-001');
    expect(w.queue.pending().filter((p) => p.kind === 'referral_payout')).toHaveLength(0);
    expect(await w.sales.onInvoicePaid({ ...billingStoreFor({ db: w.db, now: w.hq.now }).invoice(1)!, leadId: null })).toEqual([]);
  });
});
