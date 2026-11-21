import { getPrices, type Prices } from '@fir/core';
import { z } from 'zod';
import type { DirectionId } from './offers.js';
import type { PackageLine, PackageQuote } from './package.js';

/**
 * The builder's estimate as the price of a КП (2026-11-22). The site's builder lets a visitor combine several products and extras into one quote, and the client
 * saw that quote: it is the price of the proposal, not the one direction `guessDirection` would pick from the words. Three inputs, in this order:
 *  1. the estimate JSON (`{"v":1,"lines":[{"label","usd"}],"discountUsd","totalUsd","monthlyUsd","onRequest"}`), the contract the builder may send in the lead's `estimate`;
 *  2. the builder's summary text (`leadSummary` of the site: a `name: detail (price, term)` line per part, then `Итого: price`), read line by line;
 *  3. the builder link (`?b=` code): HQ prices its parts and extras from the site's price list (`getPrices()`, the cached `GET /api/prices`) the way
 *     `quote()` of the site does (`firtech/src/lib/builder.ts`): a part is its variant plus add-ons, an extra is its price, a build with two or more lines gets the bundle discount,
 *     the monthly support stays apart.
 * A text or JSON that does not add up (the lines do not give the total, a cut text) is ignored, the next input is tried, and without any the old single-direction price stays.
 * The lead form is public, so the link (it cannot be forged) wins over the estimate; the estimate prices the КП only when there is no link, and a differing estimate is a warning on the card. The owner approves every КП (locked, level 0).
 */
export interface BuilderEstimate {
  quote: PackageQuote;
  source: 'json' | 'text' | 'link';
  /** The directions of the priced parts, the most expensive first. */
  directions: DirectionId[];
  /** Products of the build the site shows «по смете» (no price): not in the sum, the owner prices them apart. */
  onRequest: string[];
  /** The total of the client's own estimate (JSON or text), when a builder link is there and prices differently: the link wins, this is only for the warning. */
  estimateTotalUsd: number | null;
}

const num = (s: string): number => Number(s.replace(/[\s,]/g, ''));
const sum = (lines: PackageLine[]): number => lines.reduce((s, l) => s + l.usd, 0);
const round10 = (v: number): number => Math.round(v / 10) * 10;

/** A line of a part (`name: detail`) as a direction and as a stage template product (the site's template of the most expensive part). */
interface Kind { direction: DirectionId; stage: 'site' | 'bot' | 'automation' | 'app' }
export function kindOfLabel(label: string): Kind | null {
  if (/mini ?app|мини-?прилож/i.test(label)) return { direction: 'miniapp', stage: 'app' };
  if (/сайт|лендинг|интернет-?магазин|website|landing|shop|company/i.test(label)) return { direction: 'site', stage: 'site' };
  if (/автоматиз|automation|crm|связк|ии-ассистент|ai assistant|integration/i.test(label)) return { direction: /ассистент|assistant/i.test(label) ? 'implementation' : 'automation', stage: 'automation' };
  if (/приложен|прилож|\bapps?\b|ios|android|pwa|систем\p{L}* для команд|team system/iu.test(label)) return { direction: 'miniapp', stage: 'app' };
  if (/агент|бот|\bbots?\b|telegram|запис|заказ|консультант|администратор|менеджер заявок|booking|agent|lead manager/i.test(label)) {
    return { direction: /ии-ответ|ответы с помощью ии|ai answers|ai replies|консультант|менеджер заявок|lead manager/i.test(label) ? 'receptionist' : 'admin', stage: 'bot' };
  }
  return null;
}

interface Collected {
  lines: PackageLine[];
  discountUsd: number;
  totalUsd: number;
  monthlyUsd: number | null;
  onRequest: string[];
  kinds: { kind: Kind; usd: number }[];
}

function finish(c: Collected, source: BuilderEstimate['source']): BuilderEstimate | null {
  const lines = c.lines.filter((l) => l.usd > 0);
  if (lines.length === 0 || !(c.totalUsd > 0)) return null;
  const all: PackageLine[] = [...lines, ...(c.discountUsd > 0 ? [{ label: 'Скидка за набор', usd: -c.discountUsd }] : [])];
  if (sum(all) !== c.totalUsd) return null;
  const ranked = [...c.kinds].sort((a, b) => b.usd - a.usd);
  const directions = [...new Set(ranked.map((k) => k.kind.direction))];
  const stageIds = [ranked[0]?.kind.stage ?? 'site'];
  return {
    quote: { totalUsd: c.totalUsd, monthlyUsd: c.monthlyUsd, lines: all, stageIds },
    source, directions, onRequest: c.onRequest, estimateTotalUsd: null,
  };
}

// ---- 1. the estimate JSON

const jsonSchema = z.object({
  v: z.number().optional(),
  lines: z.array(z.object({ label: z.string().trim().min(1).max(200), usd: z.number().positive().finite() })).min(1).max(30),
  discountUsd: z.number().nonnegative().finite().optional(),
  totalUsd: z.number().positive().finite(),
  monthlyUsd: z.number().positive().finite().nullable().optional(),
  onRequest: z.array(z.string().trim().min(1).max(80)).max(10).optional(),
});

export function parseEstimateJson(text: string): BuilderEstimate | null {
  const t = text.trim();
  if (!t.startsWith('{')) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(t);
  } catch {
    return null;
  }
  const r = jsonSchema.safeParse(raw);
  if (!r.success) return null;
  const d = r.data;
  const lines = d.lines.map((l) => ({ label: l.label, usd: l.usd }));
  return finish({
    lines, discountUsd: d.discountUsd ?? 0, totalUsd: d.totalUsd, monthlyUsd: d.monthlyUsd ?? null, onRequest: d.onRequest ?? [],
    kinds: lines.flatMap((l) => { const k = kindOfLabel(l.label); return k ? [{ kind: k, usd: l.usd }] : []; }),
  }, 'json');
}

// ---- 2. the summary text of the site

/** A dollar amount as the site prints it: a dollar sign, digits, thousands with commas. */
const AMT = String.raw`\$\s?(\d{1,3}(?:,\d{3})+|\d+)`;
const PART = new RegExp(String.raw`^(.+?):\s+(.+?)\s*\(${AMT}(?:,[^)]*)?\)\s*$`, 'u');
const EXTRA = new RegExp(String.raw`^([^:$()]+?)\s*\(${AMT}\)\s*$`, 'u');
const DISCOUNT = new RegExp(String.raw`^(?:скидк|discount|\d+%\s*off)[^:]*:\s*${AMT}\s*->\s*${AMT}\s*$`, 'iu');
const TOTAL = new RegExp(String.raw`^(?:итого|total)\s*:\s*${AMT}\s*$`, 'iu');
const MONTHLY = new RegExp(String.raw`^[^:$]{3,60}:\s*${AMT}\s*/\s*(?:мес|mo)(?![\p{L}])`, 'iu');
const ON_REQUEST = /^(?:по смете, без цены|on quote, no price)\s*:\s*(.+)$/iu;
/** Lines of the quote come first in the summary, up to and including «Итого»; the brief that follows is the client's words and is never read for money. */
export function parseEstimateText(text: string): BuilderEstimate | null {
  const rows = text.split('\n').map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const lines: PackageLine[] = [];
  const kinds: Collected['kinds'] = [];
  let discountFrom: number | null = null;
  let discountTo: number | null = null;
  let totalUsd: number | null = null;
  let monthlyUsd: number | null = null;
  const onRequest: string[] = [];
  let i = 0;
  for (; i < rows.length; i += 1) {
    const row = rows[i]!;
    const tot = TOTAL.exec(row);
    if (tot) {
      totalUsd = num(tot[1]!);
      i += 1;
      break;
    }
    const dis = DISCOUNT.exec(row);
    if (dis) {
      discountFrom = num(dis[1]!);
      discountTo = num(dis[2]!);
      continue;
    }
    const part = PART.exec(row);
    if (part) {
      const usd = num(part[3]!);
      const label = `${part[1]!.trim()}: ${part[2]!.trim()}`;
      lines.push({ label, usd });
      const k = kindOfLabel(label);
      if (k) kinds.push({ kind: k, usd });
      continue;
    }
    const extra = EXTRA.exec(row);
    if (extra) lines.push({ label: extra[1]!.trim(), usd: num(extra[2]!) });
  }
  if (totalUsd === null || lines.length === 0) return null;
  for (; i < rows.length; i += 1) {
    const row = rows[i]!;
    const m = MONTHLY.exec(row);
    if (m && monthlyUsd === null) monthlyUsd = num(m[1]!);
    const o = ON_REQUEST.exec(row);
    if (o) onRequest.push(...o[1]!.split(',').map((x) => x.trim()).filter(Boolean));
  }
  const discountUsd = discountFrom !== null ? discountFrom - totalUsd : 0;
  // the discount line says «from X to Y»: Y is the total, or the text was edited
  if (discountFrom !== null && (discountUsd <= 0 || discountTo !== totalUsd)) return null;
  return finish({ lines, discountUsd, totalUsd, monthlyUsd, onRequest, kinds }, 'text');
}

// ---- 3. the builder link

/** Russian names of the site's dictionary (`ru.ts`: `services.items`, `estimator.catalog`, `extras.items`): only labels, never a price. */
const SERVICE_RU: Record<string, string> = { websites: 'Сайты и лендинги', bots: 'Агенты в Telegram', apps: 'Приложения', automation: 'Автоматизация и ИИ' };
const VARIANT_RU: Record<string, Record<string, string>> = {
  websites: { landing: 'Лендинг', company: 'Сайт компании', shop: 'Интернет-магазин' },
  bots: { faq: 'Бот-консультант', booking: 'Запись и заказы', miniapp: 'Telegram Mini App' },
  apps: { pwa: 'Веб-приложение', internal: 'Система для команды', mobile: 'iOS и Android' },
  automation: { integration: 'Связка двух сервисов', crm: 'Настройка CRM', assistant: 'ИИ-ассистент' },
};
const ADDON_RU: Record<string, Record<string, string>> = {
  websites: { language: 'Второй язык', telegram: 'Заявки в Telegram', payments: 'Онлайн-оплата', cms: 'Панель для правок' },
  bots: { payments: 'Оплата в боте', broadcasts: 'Рассылки', admin: 'Админ-панель', ai: 'Ответы с помощью ИИ' },
  apps: { accounts: 'Личный кабинет', payments: 'Онлайн-оплата', push: 'Push-уведомления', admin: 'Админ-панель' },
  automation: { sheets: 'Отчёты в Google Таблицах', alerts: 'Уведомления в Telegram', training: 'Обучение сотрудников', support: 'Поддержка 3 месяца' },
};
const EXTRA_RU: Record<string, string> = { seo: 'Карты, SEO и аналитика', design: 'Дизайн и фирменный стиль', rescue: 'Доработка чужих проектов', crm: 'CRM под ключ', internal: 'Внутренняя система', support: 'Поддержка по подписке' };
/** The extras a build takes, in the site's order (`buildExtras`). */
const BUILD_EXTRAS = ['support', 'seo', 'design', 'rescue', 'crm', 'internal'] as const;
const SERVICES = ['websites', 'bots', 'apps', 'automation'] as const;
/** The products of the build that have no price in the site (`productCatalog[...].priced === false`). */
const UNPRICED_PRODUCTS = ['content', 'agent'];
const PRODUCT_IDS = ['adminbot', 'intake', 'automation', 'content', 'miniapp', 'agent', 'aiteam', 'site', 'bot', 'app'];
const PRODUCT_RU: Record<string, string> = {
  adminbot: 'ИИ-администратор', intake: 'ИИ-менеджер заявок', automation: 'Автоматизация процессов', content: 'Контент на автопилоте', miniapp: 'Telegram Mini App',
  agent: 'Персональный ИИ-ассистент', aiteam: 'ИИ-отдел под ключ', site: 'Сайт', bot: 'Telegram-бот', app: 'Приложение',
};

const keep = (list: string, known: readonly string[]): string[] => [...new Set(list.split('-').filter((x) => known.includes(x)))];

/** The `?b=` code of a builder link or a bare code found in a text; the part `b=` stops at the first character a code does not have. */
export function builderCodeIn(text: string): string | null {
  const m = /[?&]b=([\w.~%-]{1,2000})/.exec(text);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return m[1]!;
  }
}

/** Prices a builder code as the site's `quote(decodeBuild(code))`: parts in the order websites, bots, apps, automation, then the extras, the bundle discount from two lines, support apart. */
export function priceBuilderCode(code: string, p: Prices = getPrices()): BuilderEstimate | null {
  const lines: PackageLine[] = [];
  const kinds: Collected['kinds'] = [];
  const parts = new Map<string, { variant: string; addons: string[] }>();
  let extras: string[] = [];
  let products: string[] = [];
  for (const chunk of code.slice(0, 4000).split('~')) {
    const [head = '', second = '', third = ''] = chunk.split('.');
    if (head === 'x') extras = keep(second, BUILD_EXTRAS);
    else if (head === 'p') products = keep(second, PRODUCT_IDS);
    else if ((SERVICES as readonly string[]).includes(head)) {
      const cat = p.catalog[head as (typeof SERVICES)[number]];
      if (Object.hasOwn(cat.variants, second)) parts.set(head, { variant: second, addons: keep(third, Object.keys(cat.addons)) });
    }
  }
  for (const slug of SERVICES) {
    const part = parts.get(slug);
    if (!part) continue;
    const cat = p.catalog[slug];
    const usd = (cat.variants[part.variant] ?? 0) + part.addons.reduce((s, a) => s + (cat.addons[a] ?? 0), 0);
    const names = [VARIANT_RU[slug]?.[part.variant] ?? part.variant, ...part.addons.map((a) => ADDON_RU[slug]?.[a] ?? a)];
    lines.push({ label: `${SERVICE_RU[slug]}: ${names.join(' + ')}`, usd });
    const stage = slug === 'websites' ? 'site' : slug === 'apps' || part.variant === 'miniapp' ? 'app' : slug === 'automation' ? 'automation' : 'bot';
    const direction: DirectionId = slug === 'websites' ? 'site' : slug === 'apps' ? 'miniapp' : slug === 'automation' ? (part.variant === 'assistant' ? 'implementation' : 'automation')
      : part.variant === 'miniapp' ? 'miniapp' : part.variant === 'booking' ? 'admin' : part.addons.includes('ai') ? 'receptionist' : 'admin';
    kinds.push({ kind: { direction, stage }, usd });
  }
  let monthlyUsd: number | null = null;
  for (const id of BUILD_EXTRAS) {
    if (!extras.includes(id)) continue;
    const e = p.extraPrice[id];
    if (!e || e.from === null || e.from === undefined) continue;
    if (e.monthly) monthlyUsd = (monthlyUsd ?? 0) + e.from;
    else lines.push({ label: EXTRA_RU[id] ?? id, usd: e.from });
  }
  const subtotal = sum(lines);
  const discountUsd = lines.length >= 2 ? round10((subtotal * (p.bundleDiscountPercent ?? 10)) / 100) : 0;
  const onRequest = products.filter((id) => UNPRICED_PRODUCTS.includes(id)).map((id) => PRODUCT_RU[id] ?? id);
  return finish({ lines, discountUsd, totalUsd: subtotal - discountUsd, monthlyUsd, onRequest, kinds }, 'link');
}

/** The lead's own estimate, else its link: JSON, summary text, then the builder code in the estimate, the client's words or the link the site sent. Null: no builder estimate at all. */
export function builderEstimate(input: { estimate?: string | undefined; request?: string | undefined; link?: string | undefined }, p: Prices = getPrices()): BuilderEstimate | null {
  const estimate = input.estimate ?? '';
  const code = builderCodeIn(estimate) ?? builderCodeIn(input.request ?? '') ?? builderCodeIn(input.link ?? '');
  const own = parseEstimateJson(estimate) ?? parseEstimateText(estimate);
  const linked = code ? priceBuilderCode(code, p) : null;
  // the link cannot be forged, so it wins; the estimate is used only when there is no link (or it prices nothing)
  if (linked) return { ...linked, estimateTotalUsd: own && own.quote.totalUsd !== linked.quote.totalUsd ? own.quote.totalUsd : null };
  return own;
}
