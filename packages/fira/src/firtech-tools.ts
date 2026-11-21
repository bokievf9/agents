import { fail, getPrices, okv, productName } from '@fir/core';
import type { FiraTool, ToolRegistry } from './tools.js';

/**
 * Stand-ins for the app tools the lead manager of Fir Tech asks for (`role-packs/lead-manager.md`): the price list, the builder link and the
 * call slots. The price list is real (`getPrices()`, the site's list or its bundled snapshot); the link and the slots are deterministic stubs.
 * At migration HQ passes its own: `builder_link` from `client/builder-link.ts`, `call_slots` from `client/site-slots.ts`.
 */

const PRICE_IDS = ['admin', 'intake', 'automation', 'miniapp', 'aiteam', 'site', 'app'] as const;

export const priceList: FiraTool = {
  def: {
    name: 'price_list',
    description: 'Цены с сайта в долларах США, «от N». Звать на любой вопрос о цене; называть только эти суммы и правило этапов.',
    input_schema: { type: 'object', properties: { products: { type: 'array', items: { type: 'string' }, description: 'id продуктов; пусто: все' } } },
  },
  run(input, ctx) {
    const p = getPrices();
    const want = Array.isArray(input.products) ? input.products.filter((x): x is string => typeof x === 'string') : [];
    const ids = PRICE_IDS.filter((id) => !want.length || want.includes(id));
    const lang = ctx.lang === 'en' ? 'en' : 'ru';
    return Promise.resolve(okv({
      currency: 'USD',
      items: ids.flatMap((id) => (p.products[id] !== undefined ? [{ id, name: productName(id, lang), from: p.products[id] }] : [])),
      stages: lang === 'ru'
        ? 'Оплата по этапам: каждый этап до его начала, последний до передачи доступов; точную цену и срок называем до старта, в смете.'
        : 'Payment by stages: each stage before it starts, the last before handover; the exact price and timing come before the start, in the estimate.',
    }));
  },
};

export const builderLink: FiraTool = {
  def: {
    name: 'builder_link',
    description: 'Ссылка на сборку проекта с уже заполненным тем, что рассказал собеседник. Первое предложение, когда бизнес, задача и продукт ясны.',
    input_schema: {
      type: 'object',
      properties: { products: { type: 'array', items: { type: 'string' } }, niche: { type: 'string' }, goals: { type: 'array', items: { type: 'string' } } },
      required: ['products'],
    },
  },
  run(input, ctx) {
    const products = Array.isArray(input.products) ? input.products.filter((x): x is string => typeof x === 'string' && /^[a-z]+$/.test(x)) : [];
    if (!products.length) return Promise.resolve(fail('invalid', 'products are required'));
    return Promise.resolve(okv({ url: `https://firtech.pro/${ctx.lang === 'en' ? 'en' : 'ru'}/builder?b=p.${products.join('-')}` }));
  },
};

export const callSlots: FiraTool = {
  def: {
    name: 'call_slots',
    description: 'Ближайшие окна для созвона (второе предложение после сборки). Пусто: предложить время самому.',
    input_schema: { type: 'object', properties: {} },
  },
  run() {
    return Promise.resolve(okv({ slots: [] as string[] }));
  },
};

export const FIRTECH_TOOLS: ToolRegistry = { price_list: priceList, builder_link: builderLink, call_slots: callSlots };
