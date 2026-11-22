import { getPrices, type Prices } from './prices.js';

/**
 * The one map of product names (owner 2026-11-22: the word «бот» is banned in the names of our AI products). Every client-facing text of the agents (the chat, the bot,
 * the instructions' product blocks, the КП, the estimate, the contract, the content directions) takes the name from here, never from a typed literal. The ids are the
 * site's (`adminbot`, `intake`, `aiteam`...), the catalogue ids of the chat (`admin`, `receptionist`, `ai`) and the price keys (`admin`, `intake`, `aiteam`) all resolve
 * to one entry. The live names win: when `GET /api/prices` carries `products.<id>.title` (a string, or `{ ru, en }`), `productName` returns it.
 */
export type NameLang = 'ru' | 'en';
export interface ProductNames {
  /** The canonical id (the site's builder id). */
  id: string;
  ru: string;
  en: string;
}

export const PRODUCT_NAMES: readonly ProductNames[] = [
  // the flagships first (the site's order, 2026-11-22); the old `agent` product is `personal` now (see ALIAS)
  { id: 'personal', ru: 'Персональный ИИ', en: 'Personal AI' },
  { id: 'company', ru: 'ИИ-компания', en: 'AI company' },
  { id: 'adminbot', ru: 'ИИ-администратор', en: 'AI booking assistant' },
  { id: 'intake', ru: 'ИИ-менеджер заявок', en: 'AI lead manager' },
  { id: 'automation', ru: 'Автоматизация процессов', en: 'Process automation' },
  { id: 'content', ru: 'Контент на автопилоте', en: 'Content on autopilot' },
  { id: 'miniapp', ru: 'Telegram Mini App', en: 'Telegram Mini App' },
  { id: 'aiteam', ru: 'ИИ-отдел под ключ', en: 'AI department turnkey' },
  // the classics are delivery formats, not AI products
  { id: 'site', ru: 'Сайт', en: 'Website' },
  { id: 'bot', ru: 'Telegram-бот', en: 'Telegram bot' },
  { id: 'app', ru: 'Приложение', en: 'App' },
] as const;

/** Every spelling of an id (builder, chat catalogue, price key, the site's new page ids) -> the canonical id. */
const ALIAS: Record<string, string> = {
  personal: 'personal', agent: 'personal', company: 'company',
  adminbot: 'adminbot', admin: 'adminbot',
  intake: 'intake', receptionist: 'intake',
  automation: 'automation', content: 'content', miniapp: 'miniapp',
  aiteam: 'aiteam', ai: 'aiteam', implementation: 'aiteam',
  site: 'site', bot: 'bot', app: 'app',
};

/** The lead form's service slugs (`websites`, `bots`, `apps`, `automation`, `ai`) in plain Russian, lower case, for notices and the Inbox; an unknown slug falls back to the product name (or the slug itself). */
const SERVICE_RU: Record<string, string> = { websites: 'сайт', bots: 'ИИ-агент в Telegram', apps: 'приложение', automation: 'автоматизация', ai: 'ИИ-агент' };
export const serviceName = (slug: string): string => SERVICE_RU[slug.trim().toLowerCase()] ?? productName(slug, 'ru');

export const canonicalProductId = (id: string): string | undefined => ALIAS[id];

const BY_ID = new Map(PRODUCT_NAMES.map((n) => [n.id, n]));

/** The live title of a product from the price list, when the site publishes one (`title` as a string for Russian, or `{ ru, en }`). */
function liveTitle(id: string, lang: NameLang, prices: Prices): string | undefined {
  const raw = (prices as { titles?: Record<string, { ru?: string; en?: string }> }).titles?.[id];
  const t = raw?.[lang]?.trim();
  return t ? t : undefined;
}

/** The display name of a product in a language; the live title of the price list first, then the built-in one. Unknown id: the id itself. */
export function productName(id: string, lang: NameLang, prices: Prices = getPrices()): string {
  const canon = ALIAS[id];
  if (!canon) return id;
  // the price list keys a product by its HQ key (`admin`, `intake`, `aiteam`) or the site id: any spelling of this product
  for (const [alias, c] of Object.entries(ALIAS)) {
    if (c !== canon) continue;
    const live = liveTitle(alias, lang, prices);
    if (live) return live;
  }
  return BY_ID.get(canon)![lang];
}

/** `{ ru, en }` of a product (for texts that carry both). */
export const productNames = (id: string, prices: Prices = getPrices()): { ru: string; en: string } => ({ ru: productName(id, 'ru', prices), en: productName(id, 'en', prices) });

/** The AI products in the order of the site (without the classics), as one list: «ИИ-администратор, ИИ-менеджер заявок, ...». */
export function productList(lang: NameLang, o: { classics?: boolean; prices?: Prices } = {}): string {
  const ids = PRODUCT_NAMES.filter((n) => o.classics || !['site', 'bot', 'app'].includes(n.id)).map((n) => n.id);
  return ids.map((id) => productName(id, lang, o.prices)).join(', ');
}
