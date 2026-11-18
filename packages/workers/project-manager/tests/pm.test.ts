import { MockLlm, openDb } from '@fir/core';
import { describe, expect, it } from 'vitest';
import { fmtDate, guessProduct, planMilestones, PmStore, buildSpec, statusMessage, templateSpec } from '../src/index.js';

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
  const ms = planMilestones('bot', T0, TZ).map((m, i) => ({ id: i, projectId: 1, taskId: null, doneAt: null, status: 'open' as const, ...m }));

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
