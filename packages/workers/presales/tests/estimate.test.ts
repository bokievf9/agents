import { FALLBACK_PRICES, MockLlm, openDb, setPrices, type Payload } from '@fir/core';
import type { Task, WorkerCtx } from '@fir/hq';
import { leadStoreFor } from '@fir/worker-lead-intake';
import { beforeEach, describe, expect, it } from 'vitest';
import { builderEstimate, builderCodeIn, parseEstimateJson, parseEstimateText, priceBuilderCode } from '../src/estimate.js';
import { PresalesWorker } from '../src/worker.js';

/**
 * The numbers below are what the site itself shows for the same link (`quote(decodeBuild(code))`, `stagesFor` and `leadSummary` of firtech main 773ae52,
 * run read-only on 2026-11-22): a clinic builds a site, a booking agent, SEO, monthly support and an unpriced content product.
 */
const CODE = 'websites.company.telegram-cms-language~bots.booking.payments-broadcasts~x.support-seo~p.site-adminbot-content~k.clinic';
const SUMMARY_RU = [
  'Бизнес: Клиника и медцентр',
  'Продукты: Сайт, ИИ-администратор, Контент на автопилоте',
  'Сайты и лендинги: Сайт компании + Заявки в Telegram + Панель для правок + Второй язык ($510, 2-3 недели)',
  'Агенты в Telegram: Запись и заказы + Оплата в боте + Рассылки ($350, 1-2 недели)',
  'Карты, SEO и аналитика ($50)',
  'Скидка 10% от двух частей проекта: $910 -> $820',
  'Итого: $820',
  'По смете, без цены: Контент на автопилоте',
  'Поддержка по подписке: $20/мес',
  'Оплата по этапам: 1. $246 (30%), 2. $328 (40%), 3. $246 (30%)',
  'Домен, хостинг, сервер и платные сторонние сервисы (SMS, API, платежи) в сумму не входят: заказчик оплачивает их напрямую, цена у всех разная. Для ориентира: домен $10-15 в год, хостинг от $5 в месяц.',
  'Где живёт: Telegram',
].join('\n');
const SUMMARY_EN = [
  'Business: Clinic and medical centre',
  'Websites: Company website + Leads to Telegram + Content editor + Second language ($510, 2-3 weeks)',
  'Telegram agents: Bookings and orders + In-bot payments + Broadcasts ($350, 1-2 weeks)',
  'Maps, SEO and analytics ($50)',
  '10% off from two parts of the project: $910 -> $820',
  'Total: $820',
  'On quote, no price: Content on autopilot',
  'Support subscription: $20/mo',
].join('\n');

beforeEach(() => setPrices(FALLBACK_PRICES));

describe('priceBuilderCode: the builder link priced like the site', () => {
  it('matches the site 1:1 on the example link: lines, discount, total, monthly, stages', () => {
    const e = priceBuilderCode(CODE)!;
    expect(e.source).toBe('link');
    expect(e.quote.lines.map((l) => l.usd)).toEqual([510, 350, 50, -90]);
    expect(e.quote.lines.map((l) => l.label)).toEqual([
      'Сайты и лендинги: Сайт компании + Заявки в Telegram + Панель для правок + Второй язык',
      'Агенты в Telegram: Запись и заказы + Оплата в боте + Рассылки',
      'Карты, SEO и аналитика',
      'Скидка за набор',
    ]);
    expect(e.quote.totalUsd).toBe(820);
    expect(e.quote.monthlyUsd).toBe(20);
    expect(e.directions).toEqual(['site', 'admin']);
    expect(e.onRequest).toEqual(['Контент на автопилоте']);
    expect(e.quote.stageIds).toEqual(['site']);
  });

  it('other links match the site too: the bot template, the app template with four stages, a single extra (no discount, 50/50)', () => {
    expect(priceBuilderCode('websites.landing~bots.faq.ai')!.quote.totalUsd).toBe(330);
    expect(priceBuilderCode('websites.landing~bots.faq.ai')!.quote.stageIds).toEqual(['bot']);
    const big = priceBuilderCode('bots.miniapp.payments~automation.crm.sheets~x.design-crm')!;
    expect(big.quote.lines.map((l) => l.usd)).toEqual([660, 500, 90, 450, -170]);
    expect(big.quote.totalUsd).toBe(1530);
    expect(big.quote.stageIds).toEqual(['app']);
    const seo = priceBuilderCode('x.seo')!;
    expect(seo.quote.totalUsd).toBe(50);
    expect(seo.quote.lines).toHaveLength(1);
  });

  it('follows the price list: a changed price changes the quote; unknown ids and a code without parts give nothing', () => {
    setPrices({ ...FALLBACK_PRICES, catalog: { ...FALLBACK_PRICES.catalog, websites: { ...FALLBACK_PRICES.catalog.websites, variants: { ...FALLBACK_PRICES.catalog.websites.variants, landing: 200 } } } });
    expect(priceBuilderCode('websites.landing')!.quote.totalUsd).toBe(200);
    expect(priceBuilderCode('websites.nope~k.cafe')).toBeNull();
    expect(priceBuilderCode('k.cafe~p.site')).toBeNull();
  });

  it('finds the code in a link, a path, a page with &step and a text', () => {
    expect(builderCodeIn(`https://firtech.pro/ru/builder?b=${CODE}`)).toBe(CODE);
    expect(builderCodeIn(`/ru/builder/estimate?b=${CODE}&step=8`)).toBe(CODE);
    expect(builderCodeIn('просто текст')).toBeNull();
  });
});

describe('the estimate the site sends: summary text and JSON', () => {
  it('reads the Russian and the English summary of the site: the same lines, discount, total and monthly as the link', () => {
    for (const text of [SUMMARY_RU, SUMMARY_EN]) {
      const e = parseEstimateText(text)!;
      expect(e.source).toBe('text');
      expect(e.quote.lines.map((l) => l.usd)).toEqual([510, 350, 50, -90]);
      expect(e.quote.totalUsd).toBe(820);
      expect(e.quote.monthlyUsd).toBe(20);
      expect(e.directions).toEqual(['site', 'admin']);
      expect(e.quote.stageIds).toEqual(['site']);
      expect(e.onRequest).toHaveLength(1);
    }
    expect(parseEstimateText(SUMMARY_RU)!.quote.lines[0]!.label).toBe('Сайты и лендинги: Сайт компании + Заявки в Telegram + Панель для правок + Второй язык');
  });

  it('a thousand separator, no discount, a single part', () => {
    const e = parseEstimateText('Агенты в Telegram: Telegram Mini App ($1,250, 3-4 недели)\nИтого: $1,250')!;
    expect(e.quote.totalUsd).toBe(1250);
    expect(e.quote.stageIds).toEqual(['app']);
    expect(e.directions).toEqual(['miniapp']);
  });

  it('a text that does not add up (a cut, a forged total, no lines) is not an estimate', () => {
    expect(parseEstimateText(SUMMARY_RU.replace('Итого: $820', 'Итого: $100'))).toBeNull();
    expect(parseEstimateText(SUMMARY_RU.split('\n').filter((l) => !l.startsWith('Агенты')).join('\n'))).toBeNull();
    expect(parseEstimateText('Итого: $820')).toBeNull();
    expect(parseEstimateText('Лендинг: одна страница\nИтого: $1')).toBeNull();
    expect(parseEstimateText('')).toBeNull();
  });

  it('the JSON of the contract: lines, discount, total, monthly, unpriced products; it must add up too', () => {
    const json = JSON.stringify({
      v: 1, lines: [{ label: 'Сайт: лендинг', usd: 150 }, { label: 'ИИ-администратор', usd: 250 }], discountUsd: 40, totalUsd: 360, monthlyUsd: 20, onRequest: ['Контент на автопилоте'],
    });
    const e = parseEstimateJson(json)!;
    expect(e.source).toBe('json');
    expect(e.quote.lines).toEqual([{ label: 'Сайт: лендинг', usd: 150 }, { label: 'ИИ-администратор', usd: 250 }, { label: 'Скидка за набор', usd: -40 }]);
    expect(e.quote.totalUsd).toBe(360);
    expect(e.quote.monthlyUsd).toBe(20);
    expect(e.directions).toEqual(['admin', 'site']);
    expect(parseEstimateJson(JSON.stringify({ lines: [{ label: 'x', usd: 100 }], totalUsd: 999 }))).toBeNull();
    expect(parseEstimateJson('{"lines":[')).toBeNull();
    expect(parseEstimateJson('Итого: $820')).toBeNull();
  });

  it('builderEstimate: the estimate first, the link as the fallback, a differing link is reported; nothing at all is null', () => {
    expect(builderEstimate({ estimate: SUMMARY_RU })).toMatchObject({ source: 'text', linkTotalUsd: null });
    // a cut summary (the site's 1500 limit) falls back to the link in the estimate, the client's words or the link field
    expect(builderEstimate({ estimate: 'Сайты и лендинги: Сайт компании ($350', request: `см. /ru/builder?b=${CODE}` })).toMatchObject({ source: 'link', quote: { totalUsd: 820 } });
    expect(builderEstimate({ estimate: '', link: `/ru/builder?b=${CODE}&step=8` })!.quote.totalUsd).toBe(820);
    expect(builderEstimate({ estimate: SUMMARY_RU.replace(/\$910 -> \$820/, '$900 -> $810').replace('Итого: $820', 'Итого: $810').replace('$510', '$500'), link: `?b=${CODE}` })).toMatchObject({ source: 'text', quote: { totalUsd: 810 }, linkTotalUsd: 820 });
    expect(builderEstimate({ estimate: 'Нужен сайт', request: 'и бот' })).toBeNull();
    expect(builderEstimate({})).toBeNull();
  });
});

describe('the КП of a lead with a builder estimate', () => {
  const T0 = Date.UTC(2026, 10, 22, 5, 0);
  function rig() {
    const db = openDb(':memory:');
    const staged: { kind: string; payload: Payload; summary: string }[] = [];
    const ctx: WorkerCtx = {
      llm: new MockLlm(() => 'nope'), db, tz: 'Asia/Dushanbe', now: () => T0,
      requestApproval: (kind, payload, summary) => Promise.resolve(staged.push({ kind, payload, summary }) - 1),
      log: () => undefined,
    };
    const worker = new PresalesWorker();
    const task = (meta: Record<string, unknown>): Task => ({
      id: 1, title: 'T', body: '', dept: 'sales', assigneeId: 'presales', creator: 'owner', parentId: null, status: 'running', priority: 0,
      dueAt: null, result: null, costUsd: 0, meta, tags: [], routineId: null, createdAt: 0, updatedAt: 0,
    });
    const lead = (estimate: string, enrichmentLink = '') => {
      const store = leadStoreFor(ctx);
      const l = store.upsert(1, { name: 'Клиника Нур', contact: '@nur', service: 'bundle', niche: 'клиника', task: 'Хотим сайт и запись', deadline: '', budget: '', origin: 'site', temperature: 'hot', lang: 'ru', slots: [], chosenSlot: null, priceAsked: false, estimate });
      if (enrichmentLink) store.setEnrichment(l.id, { summary: [], productFamily: 'bundle', niche: 'клиника', intentScore: 80, builderLink: enrichmentLink });
      return l;
    };
    return { staged, lead, run: (leadId: number) => worker.run(task({ leadId }), ctx) };
  }

  it('prices the КП from the summary: every line, the discount, the total, the stages of the site, one title for the whole build', async () => {
    const r = rig();
    await r.run(r.lead(SUMMARY_RU).id);
    const p = r.staged[0]!.payload;
    expect(p.totalUsd).toBe(820);
    expect(p.what).toBe('Сайт + ИИ-администратор');
    expect((p.stages as { amountUsd: number }[]).map((s) => s.amountUsd)).toEqual([246, 328, 246]);
    expect(p.prepayUsd).toBe(246);
    const kp = p.kp as string;
    expect(kp).toContain('Сайты и лендинги: Сайт компании + Заявки в Telegram + Панель для правок + Второй язык | $510');
    expect(kp).toContain('| Скидка за набор | -$90 |');
    expect(kp).toContain('| Итого | $820 |');
    expect(kp).not.toMatch(/\$-/);
    expect(p.estimate as string).toContain('| Скидка за набор | -$90 |');
    expect(r.staged[0]!.summary).toContain('Цена взята из сметы конструктора');
    expect(r.staged[0]!.summary).toContain('По смете, без цены (в сумму не входит): Контент на автопилоте');
    expect(r.staged[0]!.summary).not.toContain('Внимание');
  });

  it('a lead with only the builder link (the estimate was cut or empty) is priced from the price list by the link; the card says so', async () => {
    const r = rig();
    await r.run(r.lead('', `/ru/builder?b=${CODE}`).id);
    expect(r.staged[0]!.payload.totalUsd).toBe(820);
    expect(r.staged[0]!.summary).toContain('по ссылке сборки');
  });

  it('a link that prices differently from the estimate is a warning on the card, the estimate stays the price', async () => {
    const r = rig();
    await r.run(r.lead(SUMMARY_RU.replace('$910 -> $820', '$900 -> $810').replace('Итого: $820', 'Итого: $810').replace('$510', '$500'), `/ru/builder?b=${CODE}`).id);
    expect(r.staged[0]!.payload.totalUsd).toBe(810);
    expect(r.staged[0]!.summary).toContain('по ссылке сборки каталог даёт $820, в смете клиента $810');
  });

  it('without any estimate the price is the old one direction', async () => {
    const r = rig();
    await r.run(r.lead('').id);
    expect(r.staged[0]!.payload.direction).toBe('site');
    expect(r.staged[0]!.payload.totalUsd).toBe(150);
    expect(r.staged[0]!.summary).not.toContain('Цена взята из сметы конструктора');
  });
});
