import { describe, expect, it } from 'vitest';
import { costsLine, detectInfrastructure, guaranteeLine, paymentLine, stagesFor } from '../src/index.js';

describe('the conditions line (domain, hosting, third-party services)', () => {
  it('the default line is the owner\'s sentence', () => {
    const line = 'Домен, хостинг, сервер и платные сторонние сервисы (SMS, API, платежи) в сумму не входят: заказчик оплачивает их напрямую, цена у всех разная. Для ориентира: домен $10-15 в год, хостинг от $5 в месяц.';
    expect(costsLine()).toBe(line);
    expect(costsLine({ hasDomain: null, hasHosting: null })).toBe(line);
    expect(costsLine({ hasDomain: false, hasHosting: false })).toBe(line);
  });

  it('the client has both: use them, third-party services are paid separately', () => {
    expect(costsLine({ hasDomain: true, hasHosting: true })).toBe('Домен и хостинг у заказчика есть, используем их; платные сторонние сервисы (SMS, API, платежи) оплачиваются отдельно.');
  });

  it('one of the two: the other stays excluded with its own reference figure', () => {
    expect(costsLine({ hasDomain: true })).toContain('Хостинг, сервер и платные сторонние сервисы');
    expect(costsLine({ hasDomain: true })).not.toContain('домен $10');
    expect(costsLine({ hasHosting: true })).toContain('Домен и платные сторонние сервисы');
    expect(costsLine({ hasHosting: true })).toContain('$10-15 в год');
  });

  it('no long dashes', () => {
    for (const h of [{}, { hasDomain: true }, { hasHosting: true }, { hasDomain: true, hasHosting: true }]) expect(costsLine(h)).not.toMatch(/[—–]/);
  });

  it('reads the site\'s scope sentences and plain Russian; no signal is null, not false', () => {
    expect(detectInfrastructure('Домен и хостинг у вас уже есть, используем их; платные сторонние сервисы')).toEqual({ hasDomain: true, hasHosting: true });
    expect(detectInfrastructure('Домен у вас уже есть, используем его. Хостинг, сервер и платные')).toEqual({ hasDomain: true, hasHosting: null });
    expect(detectInfrastructure('Хостинг у вас уже есть, используем его. Домен и платные')).toEqual({ hasDomain: null, hasHosting: true });
    expect(detectInfrastructure('You already have a domain and hosting, we will use them')).toEqual({ hasDomain: true, hasHosting: true });
    expect(detectInfrastructure('Домен, хостинг, сервер и платные сторонние сервисы в сумму не входят')).toEqual({ hasDomain: null, hasHosting: null });
    expect(detectInfrastructure('нужен сайт для салона')).toEqual({ hasDomain: null, hasHosting: null });
  });
});

describe('payment by stages (owner decision 2026-11-21)', () => {
  it('a template project lists every stage with its amount and share; each stage before its start, the last before handover', () => {
    const line = paymentLine(stagesFor(1000, ['site']));
    expect(line).toBe('Оплата по этапам, каждый этап оплачивается до его начала, последний до передачи доступов: этап 1 «Структура и первый экран»: $300 (30%); этап 2 «Все страницы и наполнение»: $400 (40%); этап 3 «Запуск, SEO, передача»: $300 (30%).');
    expect(paymentLine(stagesFor(1000, ['site']), 'en')).toContain('stage 2 "All pages and content": $400 (40%)');
  });

  it('the 50/50 wording is only the small-project sentence', () => {
    const small = paymentLine(stagesFor(290, ['admin']));
    expect(small).toBe('Небольшой проект оплачивается двумя этапами: 50% до начала работ ($145) и 50% до запуска и передачи доступов ($145).');
    expect(paymentLine(stagesFor(290, ['admin']), 'en')).toContain('50% before work starts ($145)');
    for (const total of [300, 450, 1200]) for (const id of ['site', 'admin', 'automation', 'miniapp']) expect(paymentLine(stagesFor(total, [id]))).not.toContain('Небольшой проект');
  });

  it('a subscription has one setup stage; no stages is the general rule', () => {
    expect(paymentLine(stagesFor(90, ['content']))).toBe('Настройка ($90) оплачивается до начала работ; ежемесячная плата, если она есть, вносится вперёд за месяц.');
    expect(paymentLine([])).toContain('каждый этап оплачивается до его начала');
  });

  it('the guarantee returns the first stage', () => {
    expect(guaranteeLine()).toContain('оплату первого этапа');
    expect(guaranteeLine('en')).toContain('first stage');
  });

  it('no long dashes', () => {
    for (const t of [1000, 290]) expect(paymentLine(stagesFor(t, ['site']))).not.toMatch(/[—–]/);
    expect(guaranteeLine()).not.toMatch(/[—–]/);
  });
});
