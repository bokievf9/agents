import { openDb } from '@fir/core';
import type { Task, WorkerCtx } from '@fir/hq';
import { describe, expect, it } from 'vitest';
import { DEFAULT_REWARD, kindSpecs, KIND_REWARD, markPaid, onDecision, parseReferralArg, ReferralWorker, referrerFromSource, statsText, storeFor } from '../src/referral.js';
import { DAY, ReferralStore } from '../src/store.js';

const T0 = Date.UTC(2026, 10, 20, 5, 0);
function rig(reward?: string) {
  const db = openDb(':memory:');
  const clock = { t: T0 };
  const ctx = { db, now: () => clock.t, log: () => undefined } as unknown as WorkerCtx;
  const store = storeFor(ctx, reward);
  return { db, clock, ctx, store };
}

describe('status machine', () => {
  it('proposed to paid to rewarded; every other move throws', () => {
    const { store } = rig();
    const { referral } = store.propose({ referrer: 'Cambridge', referred: 'Blanche', source: 'owner' });
    expect(referral.status).toBe('proposed');
    expect(() => store.transition(referral.id, 'rewarded')).toThrow(/Illegal/);
    expect(store.transition(referral.id, 'paid').status).toBe('paid');
    expect(() => store.transition(referral.id, 'paid')).toThrow(/Illegal/);
    expect(store.transition(referral.id, 'rewarded').status).toBe('rewarded');
    expect(() => store.transition(referral.id, 'proposed')).toThrow(/Illegal/);
    expect(() => store.transition(999, 'paid')).toThrow(/No referral/);
  });

  it('records timestamps and the reward as it was when recorded (default: a month of support)', () => {
    const { store, clock } = rig();
    expect(DEFAULT_REWARD).toBe('месяц сопровождения бесплатно');
    const { referral } = store.propose({ referrer: 'A', referred: 'B', source: 'owner' });
    expect(referral.reward).toBe(DEFAULT_REWARD);
    clock.t += DAY;
    expect(store.transition(referral.id, 'paid').paidAt).toBe(T0 + DAY);
  });

  it('REFERRAL_REWARD is configurable', () => {
    const { store } = rig('скидка 20% на сопровождение');
    expect(store.propose({ referrer: 'A', referred: 'B', source: 'owner' }).referral.reward).toBe('скидка 20% на сопровождение');
  });

  it('does not record the same lead or the same open pair twice; needs both names', () => {
    const { store } = rig();
    const a = store.propose({ referrer: 'Cambridge', referred: 'Blanche', leadId: 5, source: 'lead' });
    expect(a.created).toBe(true);
    expect(store.propose({ referrer: 'Other', referred: 'Another', leadId: 5, source: 'lead' }).created).toBe(false);
    expect(store.propose({ referrer: ' cambridge ', referred: 'blanche', source: 'owner' }).created).toBe(false);
    expect(store.all()).toHaveLength(1);
    expect(() => store.propose({ referrer: '', referred: 'x', source: 'owner' })).toThrow();
  });
});

describe('reward only after the referred client paid', () => {
  it('the reward kind is locked at level 0 and refuses a referral that has not paid', async () => {
    const { ctx, store } = rig();
    const { referral } = store.propose({ referrer: 'A', referred: 'B', source: 'owner' });
    const spec = kindSpecs(ctx)[KIND_REWARD]!;
    expect(spec.locked).toBe(true);
    expect(spec.initialLevel).toBe(0);
    await expect(spec.execute({ referralId: referral.id }, 1)).rejects.toThrow(/only after/);
    expect(store.get(referral.id)!.status).toBe('proposed');
    expect(markPaid(store, referral.id)).toMatchObject({ ok: true, already: false });
    await spec.execute({ referralId: referral.id }, 1);
    expect(store.get(referral.id)!.status).toBe('rewarded');
    await expect(spec.execute({ referralId: referral.id }, 2)).rejects.toThrow();
  });

  it('/paid: unknown id, already paid (idempotent), already rewarded', () => {
    const { store } = rig();
    const { referral } = store.propose({ referrer: 'A', referred: 'B', source: 'owner' });
    expect(markPaid(store, 42)).toEqual({ ok: false, reason: 'unknown' });
    expect(markPaid(store, Number.NaN)).toEqual({ ok: false, reason: 'unknown' });
    expect(markPaid(store, referral.id)).toMatchObject({ ok: true, already: false });
    expect(markPaid(store, referral.id)).toMatchObject({ ok: true, already: true });
    store.transition(referral.id, 'rewarded');
    expect(markPaid(store, referral.id)).toMatchObject({ ok: false, reason: 'rewarded' });
  });

  it('a rejected reward leaves the referral paid and lets /paid ask again', () => {
    const { ctx, store } = rig();
    const { referral } = store.propose({ referrer: 'A', referred: 'B', source: 'owner' });
    store.transition(referral.id, 'paid');
    store.setRewardRequested(referral.id, true);
    onDecision(ctx, { kind: KIND_REWARD, payload: { referralId: referral.id } }, 'rejected');
    expect(store.get(referral.id)).toMatchObject({ status: 'paid', rewardRequested: false });
  });
});

describe('parsing and stats', () => {
  it('parses /referral and ref: sources', () => {
    expect(parseReferralArg('Cambridge -> Blanche Salon')).toEqual({ referrer: 'Cambridge', referred: 'Blanche Salon' });
    expect(parseReferralArg('A → B')).toEqual({ referrer: 'A', referred: 'B' });
    expect(parseReferralArg('A=>B')).toEqual({ referrer: 'A', referred: 'B' });
    expect(parseReferralArg('только одно имя')).toBeNull();
    expect(parseReferralArg('-> B')).toBeNull();
    expect(referrerFromSource('ref:cambridge_center')).toBe('cambridge center');
    expect(referrerFromSource('instagram_bio')).toBeNull();
    expect(referrerFromSource('ref:')).toBeNull();
  });

  it('stats list counts and open referrals', () => {
    const { store } = rig();
    expect(statsText(store)).toContain('пока нет');
    const a = store.propose({ referrer: 'A', referred: 'B', source: 'owner' }).referral;
    store.propose({ referrer: 'C', referred: 'D', source: 'owner' });
    store.transition(a.id, 'paid');
    const t = statsText(store);
    expect(t).toContain('всего 2');
    expect(t).toContain('#1 A привёл(а) B: оплатил, награда не применена');
    expect(t).toContain('#2 C привёл(а) D: ждём оплату');
  });
});

describe('reminders for the morning summary', () => {
  const task = (action: string): Task => ({
    id: 1, title: 'T', body: '', dept: 'sales', assigneeId: 'referral', creator: 'routine', parentId: null, status: 'running', priority: 0,
    dueAt: null, result: null, costUsd: 0, meta: { action }, tags: [], routineId: null, createdAt: 0, updatedAt: 0,
  });
  it('first reminder after 3 days of waiting, then every 7; paid ones are not nagged', async () => {
    const { ctx, store, clock } = rig();
    const w = new ReferralWorker();
    const a = store.propose({ referrer: 'A', referred: 'B', source: 'owner' }).referral;
    const b = store.propose({ referrer: 'C', referred: 'D', source: 'owner' }).referral;
    store.transition(b.id, 'paid');
    clock.t += 2 * DAY;
    expect((await w.run(task('reminders'), ctx)).result).toBe('');
    clock.t += DAY;
    const r1 = await w.run(task('reminders'), ctx);
    expect(r1.result).toContain(`#${a.id} A привёл(а) B (3 дн.), когда оплатит: /paid ${a.id}`);
    expect(r1.result).not.toContain('C привёл');
    clock.t += 5 * DAY;
    expect((await w.run(task('reminders'), ctx)).result).toBe('');
    clock.t += 2 * DAY;
    expect((await w.run(task('reminders'), ctx)).result).toContain('A привёл');
    expect((await w.run(task('nope'), ctx)).ok).toBe(false);
  });
});

describe('store is plain SQL on the shared db', () => {
  it('two stores over one db share the rows', () => {
    const { db, store } = rig();
    store.propose({ referrer: 'A', referred: 'B', source: 'owner' });
    expect(new ReferralStore(db, 'x').all()).toHaveLength(1);
  });
});
