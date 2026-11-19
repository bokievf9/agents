import { getPrices, planOf, type Prices } from '@fir/core';
import type { DirectionId } from './offers.js';

/**
 * The exact price of the package a client chose (owner decision 2026-11-19: the КП names one number, «от» stays in prospecting messages).
 * Everything comes from the site's price list (`getPrices()`): a site is the variant plus its add-ons of the catalogue, the other products
 * cost what the site prices their standard package at (`products`, itself the sum of that package's parts in the site's calculator),
 * a subscription is its setup plus the monthly fee. The package is read from the lead's words and the builder's summary; what they do
 * not say is the base variant, and the КП lists the lines so the owner and the client see exactly what the number covers.
 */
export interface PackageLine {
  label: string;
  usd: number;
}
export interface PackageQuote {
  /** One-time total, USD, the sum of `lines`. */
  totalUsd: number;
  /** The monthly fee of a subscription package, USD; null when there is none. */
  monthlyUsd: number | null;
  lines: PackageLine[];
}

const sum = (lines: PackageLine[]): number => lines.reduce((s, l) => s + l.usd, 0);
const one = (label: string, usd: number): PackageQuote => ({ totalUsd: usd, monthlyUsd: null, lines: [{ label, usd }] });

const SITE_VARIANTS: [string, RegExp, string][] = [
  ['shop', /интернет-?магазин|магазин|корзин|shop|e-?commerce/i, 'Интернет-магазин'],
  ['company', /сайт компании|корпоративн|многостраничн|несколько страниц|company site|multi-?page/i, 'Сайт компании'],
  ['landing', /^/, 'Лендинг'],
];
const SITE_ADDONS: [string, RegExp, string][] = [
  ['language', /втор\p{L}+ язык|двух языч|мультиязыч|на двух языках|англ\p{L}+ верси|english|bilingual|second language/iu, 'Второй язык'],
  ['telegram', /заявк\p{L}* (?:сразу )?(?:в|на) (?:telegram|телеграм)|уведомлен\p{L}* (?:в|о) (?:telegram|телеграм)|requests? (?:in|to) telegram/iu, 'Заявки в Telegram'],
  ['payments', /онлайн-?оплат|оплат\p{L}* (?:картой )?на сайте|эквайринг|приём? оплат|online payment|card payment/iu, 'Онлайн-оплата'],
  ['cms', /панел\p{L}+ для правок|cms|самостоятельно (?:меня|редактир)|меняете тексты|редактор содержим/iu, 'Панель для правок'],
];

/** Site: the catalogue variant plus the add-ons the text names; each is a line. */
function sitePackage(text: string, p: Prices): PackageQuote {
  const c = p.catalog.websites;
  const variant = SITE_VARIANTS.find(([, re]) => re.test(text))!;
  const lines: PackageLine[] = [{ label: variant[2], usd: c.variants[variant[0]]! }];
  for (const [id, re, label] of SITE_ADDONS) if (re.test(text) && c.addons[id] !== undefined) lines.push({ label, usd: c.addons[id]! });
  return { totalUsd: sum(lines), monthlyUsd: null, lines };
}

const POLLY = /polly|полли|поли(?![\p{L}])|языков\p{L}+ учител|учител\p{L}* язык|изуч\p{L}+ язык|language teacher/iu;

/**
 * The package of a direction and its exact price. `title` is the direction's name in the proposal (the single line of a product).
 * `text` is the lead's request, the niche and the builder's summary, lower or upper case as they came.
 */
export function quotePackage(id: DirectionId, title: string, text: string, p: Prices = getPrices()): PackageQuote {
  switch (id) {
    case 'site': return sitePackage(text, p);
    case 'admin': return one(title, p.products.admin!);
    case 'receptionist': return one(title, p.products.intake!);
    case 'automation': return one(title, p.products.automation!);
    case 'miniapp': return one(title, p.products.miniapp!);
    case 'implementation': return one(title, p.products.aiteam!);
    case 'content': {
      const c = planOf('content', p);
      return { totalUsd: c.setup, monthlyUsd: c.monthly, lines: [{ label: `${title}: настройка каналов и контент-план`, usd: c.setup }] };
    }
    case 'agent': {
      const plan = planOf(POLLY.test(text) ? 'polly' : 'dono', p);
      return { totalUsd: plan.setup, monthlyUsd: plan.monthly, lines: [{ label: `${title}: настройка`, usd: plan.setup }] };
    }
  }
}

/** the «Итого» or «Total» line from the builder's summary that the site sends with the lead; null when there is none. */
export function builderTotal(estimate: string): number | null {
  const m = /(?:итого|total)\s*:\s*\$\s?([\d\s,.]+)/i.exec(estimate);
  if (!m) return null;
  const n = Number(m[1]!.replace(/[\s,]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}
