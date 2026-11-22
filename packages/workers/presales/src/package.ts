import { DEPARTMENT_AGENTS, getPrices, planOf, teamPrice, type Prices, type TeamDepartment } from '@fir/core';
import { builderCodeIn } from './estimate.js';
import { COMPANY_DEFAULT, FLAGSHIP_OPTION_RU, flagshipOptionsIn, PERSONAL_DEFAULT, PERSONAL_LEVEL_RU, personalLevel, type PersonalLevel } from './flagships.js';
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
  /** Negative for the bundle discount of a builder estimate. */
  usd: number;
}
export interface PackageQuote {
  /** One-time total, USD, the sum of `lines`. */
  totalUsd: number;
  /** The monthly fee of a subscription package, USD; null when there is none. */
  monthlyUsd: number | null;
  /** The monthly fee with the client's own model key (an ИИ-команда); absent otherwise. */
  byokMonthlyUsd?: number;
  lines: PackageLine[];
  /** The stage template products of the builder's most expensive part (`site`, `bot`, `automation`, `app`); absent: the direction's own. */
  stageIds?: string[];
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

/** The Персональный ИИ plan of a build: the level its options give and that plan of the price list (the cheapest one when the site publishes none by id). */
export function personalPlanFor(text: string, p: Prices): { level: PersonalLevel; options: string[]; plan: { setup: number; monthly: number } } {
  const named = flagshipOptionsIn(builderCodeIn(text), 'personal');
  const options = named.length ? named : PERSONAL_DEFAULT;
  const level = personalLevel(options);
  const plans = [...(p.personalPlans ?? [])].sort((a, b) => a.setup - b.setup);
  const chosen = plans.find((x) => x.id === level) ?? plans[0];
  if (!chosen) throw new Error('prices: the list has no personalPlans');
  return { level, options, plan: { setup: chosen.setup, monthly: chosen.monthly } };
}

/** The department an ИИ-команда request names; sales when it names none. */
export function teamDepartmentIn(text: string): TeamDepartment {
  if (/маркетинг|marketing/i.test(text)) return 'marketing';
  if (/поддержк|сопровожден|support/i.test(text)) return 'support';
  if (/производств|production/i.test(text)) return 'production';
  if (/бэк-?офис|back-?office/i.test(text)) return 'backoffice';
  return 'sales';
}
const TEAM_DEPT_RU: Record<TeamDepartment, string> = { sales: 'Продажи', marketing: 'Маркетинг', support: 'Поддержка', production: 'Производство', backoffice: 'Бэк-офис' };

/** An ИИ-команда: the department's agents at the agent subscription minus the team discount (setup, monthly, own-key monthly). Without a published agent subscription the AI company plan is quoted. */
function teamPackage(title: string, text: string, p: Prices): PackageQuote {
  const dept = teamDepartmentIn(text);
  const t = teamPrice(dept, p);
  if (!t) return quotePackage('company', title, text, p);
  const n = DEPARTMENT_AGENTS[dept].length;
  const q: PackageQuote = { totalUsd: t.setup, monthlyUsd: t.monthly, lines: [{ label: `${title}: ИИ-команда «${TEAM_DEPT_RU[dept]}» (${n} ${n < 5 ? 'агента' : 'агентов'}, со скидкой за команду): настройка`, usd: t.setup }] };
  if (t.byokMonthly !== undefined) q.byokMonthlyUsd = t.byokMonthly;
  return q;
}

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
    // the turnkey department is an ИИ-команда of one department (sales unless the request names another); `company` only by its own direction
    case 'implementation': return teamPackage(title, text, p);
    case 'content': {
      const c = planOf('content', p);
      return { totalUsd: c.setup, monthlyUsd: c.monthly, lines: [{ label: `${title}: настройка каналов и контент-план`, usd: c.setup }] };
    }
    // a subscription: the plan of the level the build gives, one stage «Настройка» (the monthly fee is paid in advance and is not a stage); `agent` is the retired id of `personal`
    case 'personal':
    case 'agent': {
      const { level, plan } = personalPlanFor(text, p);
      return { totalUsd: plan.setup, monthlyUsd: plan.monthly, lines: [{ label: `${title}, уровень «${PERSONAL_LEVEL_RU[level]}»: настройка`, usd: plan.setup }] };
    }
    // the AI company: the plan is «from», the exact sum is fixed in the estimate; four stages and the monthly fee
    case 'company': {
      const plan = planOf('company', p);
      const options = flagshipOptionsIn(builderCodeIn(text), 'company');
      const parts = (options.length ? options : COMPANY_DEFAULT).map((o) => FLAGSHIP_OPTION_RU[o] ?? o).join(', ');
      return { totalUsd: plan.setup, monthlyUsd: plan.monthly, lines: [{ label: `${title} (${parts}): внедрение, от этой суммы, точная по смете`, usd: plan.setup }] };
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
