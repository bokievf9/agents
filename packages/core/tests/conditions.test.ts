import { describe, expect, it } from 'vitest';
import { costsLine, detectInfrastructure } from '../src/index.js';

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
