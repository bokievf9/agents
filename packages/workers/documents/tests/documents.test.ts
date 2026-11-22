import { stagesFor } from '@fir/core';
import { describe, expect, it } from 'vitest';
import { DOC_TYPES, fillTemplate, loadTemplate, openPlaceholders, parseDocType } from '../src/index.js';

const data = { client: 'Салон Роза', what: 'Telegram-бот', date: '18.11.2026', number: '2026-4', milestones: ['- Бриф: до 20.11'] };

describe('offer and contract follow the site terms', () => {
  const offer = fillTemplate(loadTemplate('offer'), data);
  const contract = fillTemplate(loadTemplate('contract'), data);
  const both = [offer, contract];

  it('no placeholders for ИНН, court, country or city; the offer needs nothing from the owner; the contract leaves only price and term', () => {
    expect(openPlaceholders(offer)).toEqual([]);
    expect(openPlaceholders(contract).sort()).toEqual(['[срок]', '[цена]']);
    for (const t of both) {
      expect(t).not.toMatch(/ИНН|заполнить|______/);
      expect(t).not.toMatch(/Kaspi|Payme|Click|банковск/i);
    }
  });

  it('payment by stages, USDT TRC20 or TON or the wallet from the estimate, first-result guarantee per product, 30 days of fixes', () => {
    for (const t of both) {
      expect(t).toContain('Оплата по этапам: каждый этап оплачивается до его начала, последний до передачи доступов.');
      expect(t).toContain('Следующий счёт выставляется после приёмки предыдущего этапа');
      expect(t).not.toMatch(/50%|предоплат/i);
      expect(t).toContain('USDT в сети TRC20 или TON');
      expect(t).toContain('онлайн-кошелёк');
      expect(t).toContain('7 дней');
      for (const first of ['первый экран', 'первый сценарий на тестовом канале', 'первая связка на тестовых данных', 'первый ответ ассистента по документам', 'первый одобренный материал или первая неделя работы']) {
        expect(t, first).toContain(first);
      }
      for (const product of ['сайт', 'Mini App', 'автоматизация', 'внедрение ИИ', 'подписки']) expect(t, product).toContain(product);
      expect(t).toContain('30 дней');
      expect(t).toMatch(/ограничена суммой, которую заказчик оплатил/i);
      expect(t).toContain('14 дней');
      expect(t).toContain('Республика Таджикистан');
      expect(t).toContain('hello@firtech.pro');
    }
    expect(offer).toContain('чат в Telegram');
    expect(contract).toContain('чат в Telegram');
    expect(contract).toContain('Fir Tech');
    expect(`${offer}${contract}`).not.toMatch(/ООО|ИП |юридическ/i);
  });
});

describe('client documents never say «бот» (owner rule 2026-11-22)', () => {
  it('offer, contract, act, privacy carry no «бот» and no @firtech_bot', () => {
    const d = { ...data, what: 'ИИ-агент для записи клиентов' };
    for (const t of DOC_TYPES) {
      const text = fillTemplate(loadTemplate(t), d);
      expect(text, t).not.toMatch(/(^|[^а-яё])бот/i);
      expect(text, t).not.toMatch(/firtech_bot/i);
    }
  });
});

describe('document templates', () => {
  it('all four templates exist and fill without leftover {{ }}', () => {
    expect(DOC_TYPES).toEqual(['contract', 'offer', 'privacy', 'act']);
    for (const t of DOC_TYPES) expect(fillTemplate(loadTemplate(t), data)).not.toContain('{{');
  });

  it('fills client, subject, date, number and milestones; leaves [цена] and [срок] for the owner', () => {
    const text = fillTemplate(loadTemplate('contract'), data);
    expect(text).toContain('Договор оказания услуг № 2026-4');
    expect(text).toContain('Салон Роза');
    expect(text).toContain('Telegram-бот');
    expect(text).toContain('- Бриф: до 20.11');
    expect(openPlaceholders(text)).toContain('[цена]');
    expect(openPlaceholders(text)).toContain('[срок]');
  });

  it('missing data becomes [заполнить: ...], never an invented value', () => {
    const text = fillTemplate(loadTemplate('act'), { ...data, client: '', what: '', milestones: [] });
    expect(text).toContain('[заполнить: заказчик]');
    expect(text).toContain('[заполнить: этапы и даты]');
  });

  it('parses Russian and English type words', () => {
    expect(['Договор', 'оферта', 'политика', 'Акт', 'contract'].map(parseDocType)).toEqual(['contract', 'offer', 'privacy', 'act', 'contract']);
    expect(parseDocType('счёт')).toBeNull();
  });
});

describe('payment clause from the approved КП', () => {
  const stages = stagesFor(1000, ['site']);
  it('the contract, the offer and the act name the stage plan of the КП; without it the general rule', () => {
    for (const type of ['contract', 'offer'] as const) {
      const t = fillTemplate(loadTemplate(type), { ...data, price: '$1000', stages });
      expect(t).toContain('этап 1 «Структура и первый экран»: $300 (30%); этап 2 «Все страницы и наполнение»: $400 (40%); этап 3 «Запуск, SEO, передача»: $300 (30%).');
      expect(t).toContain('оплата первого этапа возвращается полностью');
    }
    const small = fillTemplate(loadTemplate('contract'), { ...data, stages: stagesFor(290, ['admin']) });
    expect(small).toContain('Небольшой проект оплачивается двумя этапами: 50% до начала работ ($145) и 50% до запуска и передачи доступов ($145).');
    expect(fillTemplate(loadTemplate('act'), data)).toContain('Каждый этап оплачен до его начала');
  });
});

describe('exact price and the conditions line', () => {
  it('the contract takes the exact price and the line from the approved КП; without them [цена] stays and the default line is printed', () => {
    const chain = fillTemplate(loadTemplate('contract'), { ...data, price: '$350', infra: { hasDomain: true, hasHosting: true } });
    expect(chain).toContain('Стоимость работ в долларах США: $350.');
    expect(openPlaceholders(chain)).toEqual(['[срок]']);
    expect(chain).toContain('Домен и хостинг у заказчика есть, используем их; платные сторонние сервисы (SMS, API, платежи) оплачиваются отдельно.');
    const manual = fillTemplate(loadTemplate('contract'), data);
    expect(manual).toContain('[цена]');
    expect(manual).toContain('Домен, хостинг, сервер и платные сторонние сервисы (SMS, API, платежи) в сумму не входят');
    expect(manual).toContain('Оплата по этапам: каждый этап оплачивается до его начала');
    expect(manual).toContain('Гарантия первого результата');
    expect(fillTemplate(loadTemplate('contract'), { ...data, price: '$90 + $60 в месяц' })).toContain('$90 + $60 в месяц.');
    expect(fillTemplate(loadTemplate('act'), { ...data, price: '$350' })).toContain('Стоимость работ: $350.');
  });
});

describe('the customer of a document is the cabinet client\'s legal name and address', () => {
  it('a task with `legalLabel` names that customer in the contract; without it the client name stays', async () => {
    const { openDb } = await import('@fir/core');
    const { DocumentsWorker } = await import('../src/index.js');
    const db = openDb(':memory:');
    const staged: string[] = [];
    const ctx = {
      llm: { enabled: false, complete: () => Promise.reject(new Error('no llm')) }, db, tz: 'Asia/Dushanbe', now: () => Date.UTC(2026, 10, 23, 5),
      requestApproval: (_k: string, p: { text: string }) => Promise.resolve(staged.push(p.text) - 1), log: () => undefined,
    };
    const worker = new DocumentsWorker();
    const task = (meta: Record<string, unknown>) => ({ id: 1, meta }) as never;
    await worker.run(task({ action: 'doc', type: 'contract', client: 'Алиса', legalLabel: 'ООО Ромашка, адрес: Душанбе, ул. Рудаки 1' }), ctx as never);
    await worker.run(task({ action: 'doc', type: 'contract', client: 'Алиса' }), ctx as never);
    expect(staged[0]).toContain('ООО Ромашка, адрес: Душанбе, ул. Рудаки 1 (далее Заказчик)');
    expect(staged[0]).toContain('Заказчик: ООО Ромашка, адрес: Душанбе, ул. Рудаки 1');
    expect(staged[1]).toContain('Алиса (далее Заказчик)');
    expect(staged[1]).not.toContain('Ромашка');
  });
});
