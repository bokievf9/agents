/**
 * The minimal port of the site's builder link (`firtech/src/lib/builder.ts`, `encodeBuild` / `decodeBuild`): the receptionist fills the brief chunks of `?b=`
 * (`k.` kind, `p.` products, `g.` goals, `c.` channels, `d.` details, base64url `u.` examples and `w.` wish, `x.` extras) and the visitor opens the builder
 * with them preselected. Parts (`websites.landing.telegram`...) and the style chunks (`s.`, `y.`) are NOT produced here: they need the site's price catalogue;
 * on decode they are skipped. The order of chunks, the separators and the clean-up rules are the site's, tests hold fixtures produced by the site's own code.
 */

/** The 56 business kinds of the builder (`kindIds` in the site's `builder-catalog.ts`). */
export const BUILDER_KINDS = [
  'cafe', 'restaurant', 'coffee', 'bakery', 'delivery', 'catering',
  'barber', 'salon', 'nails', 'spa', 'cosmetology', 'dentist', 'clinic', 'fitness', 'yoga', 'massage',
  'shop', 'webshop', 'flowers', 'gifts', 'clothing', 'electronics', 'furniture', 'autoparts',
  'carservice', 'carwash', 'drycleaning', 'cleaning', 'repair', 'renovation', 'photo', 'events', 'printing',
  'tutor', 'languages', 'kidscenter', 'drivingschool', 'onlineschool',
  'realty', 'lawyers', 'accounting', 'insurance',
  'travel', 'hotel', 'guesthouse', 'tours',
  'services', 'logistics', 'wholesale', 'itservices', 'marketing', 'coworking',
  'pharmacy', 'vet', 'petshop',
  'other',
] as const;
export type BuilderKind = (typeof BUILDER_KINDS)[number];

/** Product ids of the builder (no hyphen: they travel as `p.adminbot-site`). */
export const BUILDER_PRODUCTS = ['adminbot', 'intake', 'automation', 'content', 'miniapp', 'agent', 'aiteam', 'site', 'bot', 'app'] as const;
export type BuilderProduct = (typeof BUILDER_PRODUCTS)[number];

export const BUILD_EXTRAS = ['support', 'seo', 'design'] as const;
export const BUILD_GOALS = ['leads', 'sales', 'booking', 'routine', 'brand'] as const;
export const BUILD_CHANNELS = ['instagram', 'telegram', 'search', 'word'] as const;
export const DETAIL_LANGS = ['ru', 'en', 'tj', 'uz'] as const;
export const DETAIL_ASSETS = ['logo', 'texts', 'photos', 'domain', 'hosting'] as const;
export const DETAIL_DEADLINES = ['asap', 'month', 'relaxed'] as const;
export const PAGES_RANGE = { min: 1, max: 20 } as const;
export const TEXT_LIMITS = { wish: 300, example: 100, examples: 2 } as const;

export type BuildGoal = (typeof BUILD_GOALS)[number];
export type BuildChannel = (typeof BUILD_CHANNELS)[number];
export type DetailLang = (typeof DETAIL_LANGS)[number];
export type DetailAsset = (typeof DETAIL_ASSETS)[number];
export type DetailDeadline = (typeof DETAIL_DEADLINES)[number];

export interface BuildDetails {
  pages?: number;
  langs?: DetailLang[];
  has?: DetailAsset[];
  examples?: string[];
  deadline?: DetailDeadline;
  wish?: string;
}

export interface Build {
  kind?: BuilderKind;
  products?: BuilderProduct[];
  extras: (typeof BUILD_EXTRAS)[number][];
  goals?: BuildGoal[];
  channels?: BuildChannel[];
  details?: BuildDetails;
}

const list = (ids: readonly string[] | undefined): string => (ids?.length ? ids.join('-') : '_');

function toBase64Url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): string | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return undefined;
  try {
    const bytes = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function keepKnown<T extends string>(raw: string, known: readonly T[]): T[] {
  const ids = raw.split('-').filter((id): id is T => (known as readonly string[]).includes(id));
  return [...new Set(ids)];
}

function oneOf<T extends string>(value: string, known: readonly T[]): T | undefined {
  return (known as readonly string[]).includes(value) ? (value as T) : undefined;
}

export function clampPages(value: number): number | undefined {
  if (!Number.isFinite(value) || value < PAGES_RANGE.min) return undefined;
  return Math.min(PAGES_RANGE.max, Math.round(value));
}

/** A short note: control characters go, 300 characters at most. */
export function cleanWish(text: string): string | undefined {
  // eslint-disable-next-line no-control-regex -- the site strips exactly these
  return text.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim().slice(0, TEXT_LIMITS.wish) || undefined;
}

/** A domain or a link, nothing else («cafe.tj», «https://cafe.tj/menu»), 100 characters at most. */
export function cleanExample(text: string): string | undefined {
  // eslint-disable-next-line no-control-regex -- the site strips exactly these
  const value = text.replace(/[\u0000-\u001f\u007f\s]/g, '').slice(0, TEXT_LIMITS.example);
  return /^(https?:\/\/)?[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)+([/?#]\S*)?$/u.test(value) ? value : undefined;
}

/** The value of `?b=`: chunks joined by `~`, in the site's order (extras, kind, products, goals, channels, details, examples, wish). */
export function encodeBuild(build: Build): string {
  const parts: string[] = [];
  if (build.extras.length) parts.push(`x.${build.extras.join('-')}`);
  if (build.kind) parts.push(`k.${build.kind}`);
  if (build.products?.length) parts.push(`p.${build.products.join('-')}`);
  if (build.goals?.length) parts.push(`g.${build.goals.join('-')}`);
  if (build.channels?.length) parts.push(`c.${build.channels.join('-')}`);
  const d = build.details;
  if (d && (d.pages || d.langs?.length || d.has?.length || d.deadline)) {
    parts.push(`d.${[d.pages ? String(d.pages) : '_', list(d.langs), list(d.has), d.deadline ?? '_'].join('.')}`);
  }
  for (const url of d?.examples ?? []) if (url) parts.push(`u.${toBase64Url(url)}`);
  if (d?.wish) parts.push(`w.${toBase64Url(d.wish)}`);
  return parts.join('~');
}

/** Reads a `?b=` value like the site does for the chunks this port knows; anything unknown is dropped. Null when nothing is left. */
export function decodeBuild(value: string | null | undefined): Build | null {
  if (!value) return null;
  const build: Build = { extras: [] };
  const details: BuildDetails = {};
  for (const chunk of value.slice(0, 2000).split('~')) {
    const [head = '', second = '', third = '', fourth = '', fifth = ''] = chunk.split('.');
    if (head === 'k') {
      const kind = oneOf(second, BUILDER_KINDS);
      if (kind) build.kind = kind;
    } else if (head === 'p') {
      const products = keepKnown(second, BUILDER_PRODUCTS);
      if (products.length) build.products = products;
    } else if (head === 'x') {
      build.extras = keepKnown(second, BUILD_EXTRAS);
    } else if (head === 'g') {
      const goals = keepKnown(second, BUILD_GOALS);
      if (goals.length) build.goals = goals;
    } else if (head === 'c') {
      const channels = keepKnown(second, BUILD_CHANNELS);
      if (channels.length) build.channels = channels;
    } else if (head === 'd') {
      const pages = clampPages(Number(second));
      if (pages) details.pages = pages;
      const langs = keepKnown(third, DETAIL_LANGS);
      if (langs.length) details.langs = langs;
      const has = keepKnown(fourth, DETAIL_ASSETS);
      if (has.length) details.has = has;
      const deadline = oneOf(fifth, DETAIL_DEADLINES);
      if (deadline) details.deadline = deadline;
    } else if (head === 'u' || head === 'w') {
      const text = fromBase64Url(chunk.slice(2));
      if (head === 'u') {
        const url = cleanExample(text ?? '');
        const examples = details.examples ?? [];
        if (url && examples.length < TEXT_LIMITS.examples && !examples.includes(url)) details.examples = [...examples, url];
      } else {
        const wish = cleanWish(text ?? '');
        if (wish) details.wish = wish;
      }
    }
  }
  if (Object.keys(details).length) build.details = details;
  const has = build.extras.length > 0 || build.kind || build.products || build.goals || build.channels || build.details;
  return has ? build : null;
}

/** Drops empty and invalid fields the way the site's `withDetails` does, so an untouched brief stays absent. */
export function cleanBuild(b: Build): Build {
  const out: Build = { extras: b.extras.filter((x) => (BUILD_EXTRAS as readonly string[]).includes(x)) };
  if (b.kind && (BUILDER_KINDS as readonly string[]).includes(b.kind)) out.kind = b.kind;
  const products = keepKnown((b.products ?? []).join('-'), BUILDER_PRODUCTS);
  if (products.length) out.products = products;
  const goals = keepKnown((b.goals ?? []).join('-'), BUILD_GOALS);
  if (goals.length) out.goals = goals;
  const channels = keepKnown((b.channels ?? []).join('-'), BUILD_CHANNELS);
  if (channels.length) out.channels = channels;
  const d = b.details;
  if (d) {
    const det: BuildDetails = {};
    const pages = d.pages !== undefined ? clampPages(d.pages) : undefined;
    if (pages) det.pages = pages;
    const langs = keepKnown((d.langs ?? []).join('-'), DETAIL_LANGS);
    if (langs.length) det.langs = langs;
    const has = keepKnown((d.has ?? []).join('-'), DETAIL_ASSETS);
    if (has.length) det.has = has;
    if (d.deadline && (DETAIL_DEADLINES as readonly string[]).includes(d.deadline)) det.deadline = d.deadline;
    const examples = (d.examples ?? []).map((x) => cleanExample(x)).filter((x): x is string => Boolean(x)).slice(0, TEXT_LIMITS.examples);
    if (examples.length) det.examples = [...new Set(examples)];
    const wish = d.wish ? cleanWish(d.wish) : undefined;
    if (wish) det.wish = wish;
    if (Object.keys(det).length) out.details = det;
  }
  return out;
}

/** The path the receptionist proposes: `/ru/builder?b=<code>`; with `origin` a full link. Empty brief: the bare builder page. */
export function builderPath(locale: 'ru' | 'en', build: Build, origin = ''): string {
  const code = encodeBuild(cleanBuild(build));
  return `${origin}/${locale}/builder${code ? `?b=${encodeURIComponent(code)}` : ''}`;
}

/** The builder code inside a text (a lead's estimate, a link a visitor pasted), or null. */
export function buildFromText(text: string): { code: string; build: Build } | null {
  const m = /builder(?:\/estimate)?\?b=([^\s)"'<>]+)/.exec(text);
  if (!m) return null;
  let code = m[1]!;
  try {
    code = decodeURIComponent(code);
  } catch {
    /* an undecodable escape: the raw value is tried */
  }
  const build = decodeBuild(code);
  return build ? { code, build } : null;
}

/** HQ catalogue id (the chat's product list) -> the builder's product id. `agent` and the classics keep their names. */
export const BUILDER_PRODUCT_OF: Record<string, BuilderProduct> = {
  admin: 'adminbot', receptionist: 'intake', automation: 'automation', content: 'content', miniapp: 'miniapp', agent: 'agent', ai: 'aiteam', site: 'site', bot: 'bot', app: 'app',
};

/** Words that name a builder kind. First match wins, so the narrower kinds come first. */
const KIND_WORDS: [BuilderKind, RegExp][] = [
  ['barber', /барбер|barber/i], ['nails', /маникюр|ногт|nail/i], ['cosmetology', /косметолог|cosmetolog/i], ['massage', /массаж|massage/i],
  ['spa', /(?<![\p{L}])спа(?![\p{L}])|\bspa\b|сауна|баня/iu], ['dentist', /стоматолог|зубн|dentist|dental/i], ['clinic', /клиник|медцентр|врач|clinic|doctor/i],
  ['yoga', /йог|yoga|пилатес|pilates/i], ['fitness', /фитнес|спортзал|тренажёр|тренажер|fitness|\bgym\b/i],
  ['salon', /салон|парикмах|красот|beauty|salon|hair/i],
  ['coffee', /кофейн|coffee ?shop/i], ['bakery', /пекарн|кондитер|bakery|pastry/i], ['catering', /кейтеринг|catering/i], ['restaurant', /ресторан|restaurant/i],
  ['delivery', /доставк|курьер|delivery|courier/i], ['cafe', /кафе|cafe|столов(ая|ой)/i],
  ['webshop', /интернет-магазин|онлайн-магазин|web ?shop|e-?commerce|online store/i], ['flowers', /цвет(ы|ов)|florist|flowers?/i], ['gifts', /подарк|gift/i], ['clothing', /одежд|clothing|fashion|бутик/i], ['electronics', /электроник|гаджет|electronics/i],
  ['furniture', /мебел|furniture/i], ['autoparts', /автозапчаст|запчаст|autoparts|car parts/i], ['petshop', /зоомагазин|pet ?shop/i],
  ['shop', /магазин|\bshop\b|\bstore\b/i],
  ['carwash', /автомойк|car ?wash/i], ['carservice', /автосервис|шиномонтаж|(?<![\p{L}])сто(?![\p{L}])|car service|garage/iu], ['drycleaning', /химчистк|прачечн|dry ?clean|laundry/i],
  ['cleaning', /клининг|уборк|cleaning/i], ['renovation', /ремонт квартир|ремонт и отделк|отделк|renovation/i], ['repair', /ремонт|мастер на час|repair/i],
  ['photo', /фотограф|фотостуди|photo/i], ['events', /мероприяти|свадьб|event|wedding/i], ['printing', /типограф|печать|printing/i],
  ['kidscenter', /детск(ий|ий центр|ие) (центр|сад|студи)|kids/i], ['drivingschool', /автошкол|driving school/i], ['onlineschool', /онлайн-школ|онлайн курс|online (school|course)/i],
  ['languages', /языковая школа|иностранн|английск|language school|english lessons/i], ['tutor', /репетитор|курс|школ|учебн|tutor|school|courses?\b/i],
  ['realty', /недвижим|риелтор|real estate|realtor/i], ['lawyers', /юрист|адвокат|lawyer|law firm/i], ['accounting', /бухгалтер|accounting/i], ['insurance', /страхов|insurance/i],
  ['hotel', /отель|гостиниц|hotel/i], ['guesthouse', /гостевой дом|хостел|guest ?house|hostel/i], ['tours', /экскурси|tours?\b/i], ['travel', /турагент|путешеств|travel/i],
  ['logistics', /логистик|грузоперевоз|logistics|freight/i], ['wholesale', /оптов|wholesale/i], ['itservices', /\bit[- ]?(услуг|компани|аутсорс)|it services|software/i],
  ['marketing', /маркетинг|рекламн|агентство|marketing|advertising agency/i], ['coworking', /коворкинг|coworking/i],
  ['pharmacy', /аптек|pharmacy/i], ['vet', /ветеринар|ветклиник|veterinar|\bvet\b/i],
  ['services', /услуг|компания|b2b|services/i],
];

/** The builder kind a business description names, or undefined. */
export function kindFromText(text: string): BuilderKind | undefined {
  return KIND_WORDS.find(([, re]) => re.test(text))?.[0];
}
