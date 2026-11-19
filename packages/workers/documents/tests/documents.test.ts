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

  it('50/50 payment, USDT TRC20 or TON or the wallet from the estimate, first-result guarantee per product, 30 days of fixes', () => {
    for (const t of both) {
      expect(t).toMatch(/50% .*до начала работы/);
      expect(t).toContain('остальные 50% после приёмки');
      expect(t).toContain('USDT в сети TRC20 или TON');
      expect(t).toContain('онлайн-кошелёк');
      expect(t).toContain('7 дней');
      for (const first of ['первый экран', 'первый сценарий в тестовом боте', 'первая связка на тестовых данных', 'первый ответ ассистента по документам', 'первый одобренный материал или первая неделя работы']) {
        expect(t, first).toContain(first);
      }
      for (const product of ['сайт', 'Mini App', 'автоматизация', 'внедрение ИИ', 'подписки']) expect(t, product).toContain(product);
      expect(t).toContain('30 дней');
      expect(t).toMatch(/ограничена суммой, которую заказчик оплатил/i);
      expect(t).toContain('14 дней');
      expect(t).toContain('Республика Таджикистан');
      expect(t).toContain('hello@firtech.pro');
    }
    expect(offer).toContain('@firtech_bot');
    expect(contract).toContain('@firtech_bot');
    expect(contract).toContain('Fir Tech');
    expect(`${offer}${contract}`).not.toMatch(/ООО|ИП |юридическ/i);
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

describe('exact price and the conditions line', () => {
  it('the contract takes the exact price and the line from the approved КП; without them [цена] stays and the default line is printed', () => {
    const chain = fillTemplate(loadTemplate('contract'), { ...data, price: '$350', infra: { hasDomain: true, hasHosting: true } });
    expect(chain).toContain('Стоимость работ в долларах США: $350.');
    expect(openPlaceholders(chain)).toEqual(['[срок]']);
    expect(chain).toContain('Домен и хостинг у заказчика есть, используем их; платные сторонние сервисы (SMS, API, платежи) оплачиваются отдельно.');
    const manual = fillTemplate(loadTemplate('contract'), data);
    expect(manual).toContain('[цена]');
    expect(manual).toContain('Домен, хостинг, сервер и платные сторонние сервисы (SMS, API, платежи) в сумму не входят');
    expect(manual).toContain('Предоплата 50%');
    expect(manual).toContain('Гарантия первого результата');
    expect(fillTemplate(loadTemplate('contract'), { ...data, price: '$90 + $60 в месяц' })).toContain('$90 + $60 в месяц.');
    expect(fillTemplate(loadTemplate('act'), { ...data, price: '$350' })).toContain('Стоимость работ: $350.');
  });
});
