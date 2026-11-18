import { openDb, type Payload } from '@fir/core';
import type { WorkerCtx } from '@fir/hq';
import { describe, expect, it } from 'vitest';
import { guessProduct, guideMarkdown } from '../src/product.js';
import { KIND_GUIDE, OnboardingWorker, obStoreFor, parseOnboardArgs } from '../src/worker.js';

const NOW = Date.UTC(2026, 10, 18, 4, 30); // Wed 09:30 Tashkent
const DAY = 86_400_000;

function setup() {
  const db = openDb(':memory:');
  const clock = { t: NOW };
  const staged: { kind: string; payload: Payload; summary: string }[] = [];
  const ctx: WorkerCtx = {
    llm: { enabled: false, complete: () => Promise.reject(new Error('no llm')) }, db, tz: 'Asia/Tashkent', now: () => clock.t,
    requestApproval: (kind, payload, summary) => Promise.resolve(staged.push({ kind, payload, summary }) - 1),
    log: () => undefined,
  };
  const worker = new OnboardingWorker();
  const delivered: unknown[] = [];
  const specs = worker.kindSpecs((d) => Promise.resolve(void delivered.push(d)));
  return { db, ctx, clock, staged, worker, delivered, specs };
}

describe('product type and guide', () => {
  it('guesses the type from the free text', () => {
    expect(guessProduct('бот записи для салона')).toBe('bot');
    expect(guessProduct('сайт под ключ')).toBe('site');
    expect(guessProduct('автоматизация заказов')).toBe('automation');
    expect(guessProduct('PWA приложение')).toBe('app');
    expect(guessProduct('что-то')).toBe('other');
  });

  it('builds RU Markdown by type', () => {
    const bot = guideMarkdown('Dilnoza', 'bot');
    expect(bot).toMatch(/^# Инструкция: Telegram-бот для Dilnoza/);
    expect(bot).toContain('## Первая неделя');
    expect(bot).toContain('приветствия');
    expect(guideMarkdown('X', 'site')).toContain('по вашему домену');
  });

  it('parses /onboard arguments', () => {
    expect(parseOnboardArgs('Dilnoza: бот записи')).toEqual({ client: 'Dilnoza', product: 'бот записи' });
    expect(parseOnboardArgs('Салон Роза')).toEqual({ client: 'Салон Роза', product: '' });
    expect(parseOnboardArgs('  ')).toBeNull();
  });
});

describe('onboarding checklist', () => {
  it('creates accesses by type, a guide approval and 3 check-ins on days 1, 3, 7', async () => {
    const r = setup();
    const res = await r.worker.start(r.ctx, { client: 'Dilnoza', product: 'бот записи', invoiceNumber: 'FT-2026-001' });
    expect(res.existing).toBe(false);
    expect(res.checklist).toContain('Telegram-бот (токен');
    expect(res.checklist).toContain('Инструкция клиенту');
    expect(res.checklist).toMatch(/День 1.*19\.11/);
    expect(res.checklist).toMatch(/День 3.*21\.11/);
    expect(res.checklist).toMatch(/День 7.*25\.11/);
    expect(r.staged).toHaveLength(1);
    expect(r.staged[0]!.kind).toBe(KIND_GUIDE);
    expect(String(r.staged[0]!.payload.text)).toContain('# Инструкция');
    const items = obStoreFor(r.ctx).items(res.onboarding.id);
    expect(items.filter((i) => i.kind === 'checkin')).toHaveLength(3);
    expect(items.filter((i) => i.kind === 'access')).toHaveLength(2);
  });

  it('a second start for the same client does not duplicate', async () => {
    const r = setup();
    await r.worker.start(r.ctx, { client: 'Dilnoza', product: 'бот' });
    const again = await r.worker.start(r.ctx, { client: 'dilnoza', product: 'бот' });
    expect(again.existing).toBe(true);
    expect(r.staged).toHaveLength(1);
  });

  it('check-ins come due on their days, once each; the last closes the onboarding', async () => {
    const r = setup();
    const { onboarding } = await r.worker.start(r.ctx, { client: 'Dilnoza', product: 'сайт' });
    expect(r.worker.checkins(r.ctx).lines).toEqual([]);
    r.clock.t = NOW + 1 * DAY + 3600_000; // day 1, 10:30
    expect(r.worker.checkins(r.ctx).lines).toEqual(['Онбординг Dilnoza: День 1: спросить клиента, как идёт.']);
    expect(r.worker.checkins(r.ctx).lines).toEqual([]);
    r.clock.t = NOW + 3 * DAY + 3600_000;
    expect(r.worker.checkins(r.ctx).lines).toHaveLength(1);
    r.clock.t = NOW + 7 * DAY + 3600_000;
    const last = r.worker.checkins(r.ctx);
    expect(last.lines).toHaveLength(1);
    expect(last.finished.map((o) => o.id)).toEqual([onboarding.id]);
    expect(obStoreFor(r.ctx).openFor('Dilnoza')).toBeUndefined();
  });

  it('approved guide is delivered to the owner', async () => {
    const r = setup();
    await r.worker.start(r.ctx, { client: 'Dilnoza', product: 'бот' });
    await r.specs[KIND_GUIDE]!.execute(r.staged[0]!.payload, 1);
    expect(r.delivered).toHaveLength(1);
  });
});
