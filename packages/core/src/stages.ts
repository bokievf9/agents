import { getPrices, type Prices } from './prices.js';
import { DEFAULT_SMALL_PROJECT_MAX_USD, DEFAULT_STAGE_TEMPLATES, type PaymentStage, type StageTemplate } from './stage-templates.js';

/**
 * Payment by stages (owner decision 2026-11-21): a one-time project is split into stages from the price list's templates; each stage is
 * paid BEFORE it starts and the last one before handover. A total under `smallProjectMaxUsd` is two stages 50/50. Mixed bundles use the
 * template of the most expensive part and the shares apply to the whole one-time total. Subscriptions (content, agents) have one stage:
 * the setup, before the start (the monthly fee is paid in advance and is not a stage). Pure: read the templates from `getPrices()`.
 */
export const SUBSCRIPTION_PRODUCTS = ['content', 'agent'];

/** HQ key of a site product id (the same mapping as the price list's). */
const HQ_KEY: Record<string, string> = { receptionist: 'intake', implementation: 'aiteam' };

export const stageTemplates = (p: Prices = getPrices()): StageTemplate[] => (p.stages && p.stages.length ? p.stages : DEFAULT_STAGE_TEMPLATES);
export const smallProjectMaxUsd = (p: Prices = getPrices()): number => p.smallProjectMaxUsd ?? DEFAULT_SMALL_PROJECT_MAX_USD;

/** What a product costs in the list (its standard package, else a catalogue variant); 0 when unknown. */
function priceOfProduct(id: string, p: Prices): number {
  const direct = p.products[HQ_KEY[id] ?? id];
  if (direct !== undefined) return direct;
  for (const c of Object.values(p.catalog)) if (c.variants[id] !== undefined) return c.variants[id]!;
  return 0;
}

/** The template for a set of products: the one that serves the most expensive part; the site template when nothing is known. */
export function templateFor(productIds: string[], p: Prices = getPrices()): StageTemplate {
  const all = stageTemplates(p).filter((t) => t.products.length > 0);
  const ranked = productIds
    .map((id) => ({ id, price: priceOfProduct(id, p), tpl: all.find((t) => t.products.includes(id)) }))
    .filter((x): x is { id: string; price: number; tpl: StageTemplate } => x.tpl !== undefined)
    .sort((a, b) => b.price - a.price);
  return ranked[0]?.tpl ?? all.find((t) => t.id === 'site') ?? DEFAULT_STAGE_TEMPLATES[0]!;
}

/** The two-stage template of a small project. */
export const smallTemplate = (p: Prices = getPrices()): StageTemplate => stageTemplates(p).find((t) => t.id === 'small') ?? DEFAULT_STAGE_TEMPLATES.find((t) => t.id === 'small')!;

const SETUP: StageTemplate = { id: 'setup', title: { ru: 'Настройка', en: 'Setup' }, products: SUBSCRIPTION_PRODUCTS, shares: [{ id: 'setup', title: { ru: 'Настройка', en: 'Setup' }, share: 100 }] };

/**
 * The stages of a project: whole-USD amounts, the last takes the rounding so the sum equals the total. `productIds` are the parts of the
 * package (HQ directions or catalogue ids); only subscription ids give the single setup stage.
 */
export function stagesFor(totalUsd: number, productIds: string[], p: Prices = getPrices()): PaymentStage[] {
  const total = Number.isFinite(totalUsd) && totalUsd > 0 ? totalUsd : 0;
  const subscription = productIds.length > 0 && productIds.every((id) => SUBSCRIPTION_PRODUCTS.includes(id));
  const tpl = subscription ? SETUP : total < smallProjectMaxUsd(p) ? smallTemplate(p) : templateFor(productIds, p);
  let paid = 0;
  return tpl.shares.map((s, i) => {
    const last = i === tpl.shares.length - 1;
    const amountUsd = last ? total - paid : Math.round((total * s.share) / 100);
    paid += amountUsd;
    return { no: i + 1, id: s.id, title: s.title, share: s.share, amountUsd };
  });
}

/** Stages from a stored payload (`[{no,id,title,share,amountUsd}]`); null when it is not one. */
export function parseStages(raw: unknown): PaymentStage[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: PaymentStage[] = [];
  for (const x of raw) {
    const o = x as Partial<PaymentStage> | null;
    const title = o?.title as { ru?: unknown; en?: unknown } | undefined;
    if (!o || typeof o.no !== 'number' || typeof o.id !== 'string' || typeof o.share !== 'number' || typeof o.amountUsd !== 'number' || typeof title?.ru !== 'string' || typeof title.en !== 'string') return null;
    out.push({ no: o.no, id: o.id, title: { ru: title.ru, en: title.en }, share: o.share, amountUsd: o.amountUsd });
  }
  return out;
}

/** True for the two-stage 50/50 plan of a small project. */
export const isSmallPlan = (stages: PaymentStage[]): boolean => stages.length === 2 && stages[0]!.id === 'start';
