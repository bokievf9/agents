import { MockLlm, openDb, stagesFor } from '@fir/core';
import { describe, expect, it } from 'vitest';
import { fmtDate, guessProduct, planMilestones, planStageDates, PmStore, buildSpec, stageDueAt, statusMessage, templateSpec } from '../src/index.js';

const TZ = 'Asia/Tashkent';
const T0 = Date.UTC(2026, 10, 18, 7, 0);

describe('project manager helpers', () => {
  it('guesses the product and plans dated milestones in order', () => {
    expect(guessProduct('Telegram-бот для записи')).toBe('bot');
    expect(guessProduct('лендинг для студии')).toBe('site');
    expect(guessProduct('мобильное приложение')).toBe('app');
    expect(guessProduct('автоматизация заявок в CRM')).toBe('automation');
    const ms = planMilestones('site', T0, TZ);
    expect(ms.map((m) => m.kind)).toEqual(['brief', 'prototype', 'delivery', 'payment']);
    expect(ms.map((m) => fmtDate(m.dueAt, TZ))).toEqual(['20.11', '25.11', '02.12', '04.12']);
  });

  it('finds projects by number or by client name in any case (Cyrillic)', () => {
    const s = new PmStore(openDb(':memory:'), () => T0);
    const a = s.createProject({ client: 'Салон Роза', what: 'x', product: 'bot', source: 'owner', taskId: null });
    const b = s.createProject({ client: 'Кафе Ош', what: 'y', product: 'site', source: 'owner', taskId: null });
    expect(s.find('#2')?.id).toBe(b.id);
    expect(s.find('роза')?.id).toBe(a.id);
    expect(s.find('ОШ')?.id).toBe(b.id);
    expect(s.find('нет такого')).toBeUndefined();
  });

  it('overdue counts only open milestones of active projects past their date', () => {
    let now = T0;
    const s = new PmStore(openDb(':memory:'), () => now);
    const p = s.createProject({ client: 'К', what: 'x', product: 'site', source: 'owner', taskId: null });
    const m1 = s.addMilestone({ projectId: p.id, kind: 'brief', title: 'Бриф', dueAt: T0 + 1000 });
    s.addMilestone({ projectId: p.id, kind: 'delivery', title: 'Сдача', dueAt: T0 + 5 * 86_400_000 });
    now = T0 + 86_400_000;
    expect(s.overdue()).toHaveLength(0); // draft
    s.setStatus(p.id, 'active');
    expect(s.overdue().map((m) => m.title)).toEqual(['Бриф']);
    s.markDone(m1.id);
    expect(s.overdue()).toHaveLength(0);
  });
});

describe('ТЗ', () => {
  const p = { client: 'Салон Роза', what: 'Бот для записи', product: 'bot' as const };
  const ms = planMilestones('bot', T0, TZ).map((m, i) => ({ id: i, projectId: 1, taskId: null, doneAt: null, stageNo: null, amountUsd: null, invoiceNumber: null, paidAt: null, acceptedAt: null, titleEn: null, status: 'open' as const, ...m }));

  it('without a model it is the template with [цена] and [срок]', async () => {
    const spec = await buildSpec(new MockLlm(() => ''), p, ms, TZ);
    expect(spec).toBe(templateSpec(p, ms, TZ));
    expect(spec).toContain('[цена]');
    expect(spec).toContain('[срок]');
  });

  it('a model text that names a price is rejected for the template', async () => {
    const withMoney = `${'# ТЗ\n'.repeat(60)}Стоимость 500 USD. [цена] [срок]`;
    expect(await buildSpec(new MockLlm(() => withMoney), p, ms, TZ)).toBe(templateSpec(p, ms, TZ));
    const fine = `${'# ТЗ\nСостав работ и этапы.\n'.repeat(12)}Стоимость: [цена]. Срок: [срок].`;
    expect(await buildSpec(new MockLlm(() => fine), p, ms, TZ)).toBe(fine);
  });

  it('a status message has facts and no money', () => {
    const msg = statusMessage(p, [{ ...ms[0]!, status: 'done' }, ...ms.slice(1)], TZ);
    expect(msg).toContain('Готово: бриф');
    expect(msg).toContain('Следующий этап: прототип');
  });
});

describe('payment by stages: the milestones are the stages', () => {
  const stages = stagesFor(1000, ['site']);
  const make = (now: () => number = () => T0) => {
    const s = new PmStore(openDb(':memory:'), now);
    const p = s.reserve({ client: 'Dilnoza', what: 'сайт', product: 'site', leadId: 1, packId: 5, stages });
    return { s, p };
  };

  it('reserve creates one milestone per stage with its amount, none paid; a second reserve of the pack adds nothing', () => {
    const { s, p } = make();
    const ms = s.stageMilestones(p.id);
    expect(ms.map((m) => [m.stageNo, m.amountUsd, m.kind, m.paidAt, m.acceptedAt, m.invoiceNumber])).toEqual([[1, 300, 'stage', null, null, null], [2, 400, 'stage', null, null, null], [3, 300, 'stage', null, null, null]]);
    expect(ms[0]!.title).toBe('Этап 1: Структура и первый экран');
    expect(ms[0]!.titleEn).toBe('Structure and first screen');
    expect(s.reserve({ client: 'Dilnoza', what: 'сайт', product: 'site', leadId: 1, packId: 5, stages }).id).toBe(p.id);
    expect(s.milestones(p.id)).toHaveLength(3);
    // a reserved stage project has not started: it can still be found by the client's name
    expect(s.reservedFor('dilnoza')?.id).toBe(p.id);
    s.start(p.id, { product: 'site', what: 'сайт', taskId: 9 });
    expect(s.reservedFor('dilnoza')).toBeUndefined();
  });

  it('markStagePaid and acceptStage work once; accepting closes the milestone', () => {
    const { s, p } = make();
    const m = s.stageMilestone(p.id, 1)!;
    expect(s.markStagePaid(m.id, 'FT-2026-001', T0 + 1000)).toBe(true);
    expect(s.markStagePaid(m.id, 'FT-2026-001')).toBe(false);
    expect(s.stageMilestone(p.id, 1)).toMatchObject({ invoiceNumber: 'FT-2026-001', dueAt: T0 + 1000, status: 'open' });
    expect(s.stageMilestone(p.id, 1)!.paidAt).not.toBeNull();
    expect(s.acceptStage(m.id)).toBe(true);
    expect(s.acceptStage(m.id)).toBe(false);
    expect(s.stageMilestone(p.id, 1)).toMatchObject({ status: 'done' });
    expect(s.stageMilestone(p.id, 1)!.acceptedAt).not.toBeNull();
  });

  it('overdue counts only paid stages: a stage waiting for payment is never late', () => {
    let now = T0;
    const { s, p } = make(() => now);
    s.setStatus(p.id, 'active');
    now = T0 + 90 * 86_400_000;
    expect(s.overdue()).toEqual([]);
    s.markStagePaid(s.stageMilestone(p.id, 1)!.id, 'FT-1');
    expect(s.overdue().map((m) => m.stageNo)).toEqual([1]);
  });

  it('stage dates: the delivery term split by cumulative share; one stage starting now gets its share, at least two days', () => {
    const dates = planStageDates('site', [30, 40, 30], T0, TZ).map((d) => fmtDate(d, TZ));
    expect(dates).toEqual(['22.11', '28.11', '02.12']);
    expect(fmtDate(stageDueAt('site', 40, T0, TZ), TZ)).toBe('24.11');
    expect(fmtDate(stageDueAt('site', 5, T0, TZ), TZ)).toBe('20.11');
  });

  it('the client status names a done stage by its title', () => {
    const { s, p } = make();
    s.markStagePaid(s.stageMilestone(p.id, 1)!.id, 'FT-1');
    s.acceptStage(s.stageMilestone(p.id, 1)!.id);
    const text = statusMessage(p, s.milestones(p.id), TZ);
    expect(text).toContain('Готово: этап 1: структура и первый экран.');
    expect(text).toContain('Следующий этап: этап 2: все страницы и наполнение');
  });
});
