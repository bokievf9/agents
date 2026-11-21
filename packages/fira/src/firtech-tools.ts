import { fail, getPrices, okv, productName, type LlmToolDef } from '@fir/core';
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

/** The enums of `record_brief` the app knows (HQ passes the builder's kinds, products, channels, goals and deadlines). */
export interface BriefEnums {
  kinds?: readonly string[];
  products?: readonly string[];
  channels?: readonly string[];
  goals?: readonly string[];
  timelines?: readonly string[];
}

const strOf = (description: string, values?: readonly string[]) => ({ type: 'string', description, ...(values?.length ? { enum: [...values] } : {}) });
const listOf = (description: string, values?: readonly string[]) => ({ type: 'array', description, items: values?.length ? { type: 'string', enum: [...values] } : { type: 'string' } });

/**
 * `record_brief`: the lead manager reports what the visitor said about himself (the old JSON `extract` of the receptionist as a native tool). The app
 * merges it into its own state; nothing here is shown to the visitor. Only the visitor's own words: empty when he did not say it.
 */
export function recordBriefDef(e: BriefEnums = {}): LlmToolDef {
  return {
    name: 'record_brief',
    description: 'Записать, что собеседник сам рассказал о себе (бизнес, боль, продукт, каналы, цели, срок, бюджет). Звать на каждом ходу, где он сказал что-то новое; только его слова, пустое не заполнять.',
    input_schema: {
      type: 'object',
      properties: {
        kind: strOf('вид бизнеса', e.kinds),
        niche: { type: 'string', description: 'бизнес его словами, коротко' },
        pain: { type: 'string', description: 'что мешает или теряется, его словами' },
        product: strOf('подходящий продукт', e.products),
        channels: listOf('где пишут его клиенты', e.channels),
        goals: listOf('цели', e.goals),
        timeline: strOf('срок', e.timelines),
        budget: { type: 'string', description: 'бюджет, только если назвал сам' },
        intent: { type: 'string', enum: ['qualify', 'price', 'builder', 'call', 'support', 'other'], description: 'чего он хочет сейчас' },
        ready: { type: 'boolean', description: 'true, когда бизнес, боль и продукт ясны' },
      },
    },
  };
}

export const recordBrief: FiraTool = {
  def: recordBriefDef(),
  run() {
    return Promise.resolve(okv({ saved: true }));
  },
};

/** Niche pages of the site that show the demo of a field (the stand-in of `demo_link`; HQ gives the lead's draft agent of the playground first). */
export const DEMO_PAGE_KINDS = ['salon', 'barber', 'clinic', 'dentist', 'cafe', 'restaurant', 'delivery', 'shop', 'webshop', 'carservice', 'onlineschool', 'tutor', 'languages'] as const;

export const demoLinkDef: LlmToolDef = {
  name: 'demo_link',
  description: 'Ссылка на демо: черновой агент на площадке Fir Tech под нишу собеседника или страница решения его ниши с демо. Для холодного собеседника, который сомневается, что это работает.',
  input_schema: { type: 'object', properties: { kind: { type: 'string', description: 'вид бизнеса, если известен' } } },
};

export const demoLink: FiraTool = {
  def: demoLinkDef,
  run(input, ctx) {
    const kind = typeof input.kind === 'string' && (DEMO_PAGE_KINDS as readonly string[]).includes(input.kind) ? input.kind : '';
    const lang = ctx.lang === 'en' ? 'en' : 'ru';
    return Promise.resolve(okv({ url: kind ? `https://firtech.pro/${lang}/solutions/${kind}` : `https://firtech.pro/${lang}#demo`, draft: false }));
  },
};

export const FIRTECH_TOOLS: ToolRegistry = { price_list: priceList, builder_link: builderLink, call_slots: callSlots, record_brief: recordBrief, demo_link: demoLink };
