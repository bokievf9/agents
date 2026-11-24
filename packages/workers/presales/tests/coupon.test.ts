import { FALLBACK_PRICES, MockLlm, openDb, setPrices, type Payload } from '@fir/core';
import type { Task, WorkerCtx } from '@fir/hq';
import { leadStoreFor } from '@fir/worker-lead-intake';
import { beforeEach, describe, expect, it } from 'vitest';
import { withCoupon, type PackageQuote } from '../src/package.js';
import { PresalesWorker } from '../src/worker.js';

beforeEach(() => setPrices(FALLBACK_PRICES));

const quote = (lines: { label: string; usd: number }[], monthlyUsd: number | null = null): PackageQuote => ({ totalUsd: lines.reduce((s, l) => s + l.usd, 0), monthlyUsd, lines });

describe('withCoupon: the cabinet coupon on the one-time part', () => {
  it('adds one negative line, computed on the one-time sum; the monthly fee is untouched', () => {
    const r = withCoupon(quote([{ label: 'Лендинг', usd: 150 }, { label: 'Второй язык', usd: 50 }], 20), 10);
    expect(r).toMatchObject({ applied: true, usd: 20 });
    expect(r.quote.totalUsd).toBe(180);
    expect(r.quote.monthlyUsd).toBe(20);
    expect(r.quote.lines.at(-1)).toEqual({ label: 'Купон за кабинет −10 % на разовую часть', usd: -20 });
  });
  it('a bundle discount of 10 % or more wins: the quote is unchanged and the coupon is not applied', () => {
    const q = quote([{ label: 'Сайт', usd: 500 }, { label: 'Бот', usd: 500 }, { label: 'Скидка за набор', usd: -100 }]);
    expect(withCoupon(q, 10)).toEqual({ quote: q, applied: false, usd: 0 });
    expect(withCoupon(quote([{ label: 'Сайт', usd: 500 }, { label: 'Бот', usd: 500 }, { label: 'Скидка за набор', usd: -150 }]), 10).applied).toBe(false);
  });
  it('a smaller bundle discount is replaced by the larger coupon, never stacked', () => {
    const r = withCoupon(quote([{ label: 'Сайт', usd: 500 }, { label: 'Бот', usd: 500 }, { label: 'Скидка за набор', usd: -100 }]), 15);
    expect(r.applied).toBe(true);
    expect(r.quote.totalUsd).toBe(850);
    expect(r.quote.lines.map((l) => l.usd)).toEqual([500, 500, -150]);
  });
  it('a zero percent or an empty quote changes nothing', () => {
    const q = quote([{ label: 'Лендинг', usd: 150 }]);
    expect(withCoupon(q, 0).applied).toBe(false);
    expect(withCoupon(quote([]), 10).applied).toBe(false);
  });
});

describe('the КП of a lead whose coupon is claimed', () => {
  const T0 = Date.UTC(2026, 10, 25, 5, 0);
  function rig(coupon: (leadId: number) => number | null) {
    const db = openDb(':memory:');
    const staged: { kind: string; payload: Payload; summary: string }[] = [];
    const ctx: WorkerCtx = {
      llm: new MockLlm(() => 'nope'), db, tz: 'Asia/Dushanbe', now: () => T0,
      requestApproval: (kind, payload, summary) => Promise.resolve(staged.push({ kind, payload, summary }) - 1),
      log: () => undefined,
    };
    const worker = new PresalesWorker({ coupon });
    const task = (meta: Record<string, unknown>): Task => ({
      id: 1, title: 'T', body: '', dept: 'sales', assigneeId: 'presales', creator: 'owner', parentId: null, status: 'running', priority: 0,
      dueAt: null, result: null, costUsd: 0, meta, tags: [], routineId: null, createdAt: 0, updatedAt: 0,
    });
    const lead = (estimate = '') => leadStoreFor(ctx).upsert(1, { name: 'Алиса', contact: '@alice', service: 'websites', niche: '', task: 'Нужен лендинг', deadline: '', budget: '', origin: 'site', temperature: 'hot', lang: 'ru', slots: [], chosenSlot: null, priceAsked: false, estimate });
    return { staged, lead, run: (leadId: number) => worker.run(task({ leadId }), ctx) };
  }

  it('the quote carries the coupon line, the total, the stages and the payload mark', async () => {
    const r = rig(() => 10);
    await r.run(r.lead().id);
    const p = r.staged[0]!.payload;
    expect(p.totalUsd).toBe(135);
    expect(p.coupon).toEqual({ percent: 10, usd: 15 });
    expect(p.kp as string).toContain('Купон за кабинет −10 % на разовую часть | -$15');
    expect(p.kp as string).toContain('| Итого | $135 |');
    expect((p.stages as { amountUsd: number }[]).reduce((s, x) => s + x.amountUsd, 0)).toBe(135);
    expect(r.staged[0]!.summary).toContain('Купон за кабинет');
  });

  it('without a coupon (or with none for this lead) the quote is as before', async () => {
    const r = rig(() => null);
    await r.run(r.lead().id);
    expect(r.staged[0]!.payload.totalUsd).toBe(150);
    expect(r.staged[0]!.payload.coupon).toBeUndefined();
  });
});
