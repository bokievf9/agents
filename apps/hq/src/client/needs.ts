import { FLAGSHIP_OPTION_IDS, type BuilderKind, type DeliveryChannel, type FlagshipOptions, type SiteNeed } from './builder-link.js';
import { CLASSIC_IDS, PRODUCT_IDS, type CatalogueId } from './products.js';

/**
 * The ONE table that turns what a visitor says into a product of the builder (owner 2026-11-22: «салон + бот/администратор/запись» is the ИИ-администратор,
 * not a bare `bot`). The receptionist reads it before and after the model: an explicit rule beats the product the model guessed, the generic «бот» rule
 * only fills what is empty. Order matters: the narrower need comes first. `needs.test.ts` holds a fixture per row.
 */
export interface NeedRule {
  id: string;
  re: RegExp;
  product: CatalogueId;
}

/**
 * The flagships (owner 2026-11-22, `docs/products-contract.md` of the site): the whole company (departments, «как у вас») is `company`, a personal helper is `personal`.
 * `company` comes before `department` («ИИ-отдел», one department is `implementation`), the plural «отделы» and «вся компания» are the whole company.
 * Two guards against plain talk: «сайт как у вас» is a site, «для меня важно» is not a wish for a personal assistant.
 */
export const NEED_RULES: NeedRule[] = [
  { id: 'company', re: /вс[яюе]\s+компани|все\s+отделы|(?<![\p{L}])отделы(?![\p{L}])|(?<!(?:сайт|лендинг|дизайн)\s)как\s+у\s+(вас|fir\s?tech)(?!\s+(дела|жизнь))|компани[яию]\s+на\s+агентах|(?<![\p{L}])ии[- ]?компани|директор\s+из\s+(ии|ai)|whole\s+company|all\s+departments|like\s+yours|ai\s+company/iu, product: 'company' },
  { id: 'personal', re: /личн(ый|ого|ым)\s+(ассистент|помощник|ии)|персональн\w+\s+(ассистент|помощник|ии)|для\s+(себя|меня)(?![\p{L}])(?!\s+(важн|главн|удобн|принципиальн))|мне\s+лично|мо(й|его|им)\s+(личн\w+\s+)?ассистент|мо(й|его)\s+календар|мо[яй]\s+почт|(?<![\p{L}])(учёб|учеб)\p{L}*|personal\s+(ai|assistant|agent)|for\s+myself|my\s+own\s+assistant/iu, product: 'personal' },
  { id: 'department', re: /(?<![\p{L}])(ии|ai)[- ]?отдел|отдел из (ии|агент)|баз[ауыойе] знаний|knowledge base|ai department/iu, product: 'ai' },
  { id: 'miniapp', re: /mini ?app|мини-?апп|мини-?приложени|магазин (в|внутри) телеграм|каталог (в|внутри) телеграм/iu, product: 'miniapp' },
  { id: 'content', re: /контент|рилс|reels|посты|постов|соцсет|ведение (инстаграм|instagram)|content plan|social media/iu, product: 'content' },
  { id: 'automation', re: /автоматизац|таблиц|crm|отчёт(ы|ов)|отчет(ы|ов)|рассыл(к|ок)|интеграци|automation|spreadsheet|reports?\b/iu, product: 'automation' },
  { id: 'booking', re: /администратор|запис(ь|и|ывать|ывает|ываться|аться)|бронь|бронир|booking|appointment|reservation|\breceptionist\b|front desk/iu, product: 'admin' },
  { id: 'intake', re: /приём заявок|приема заявок|принимать заявки|обрабатывать заявки|менеджер заявок|заявк\w+ (ночью|вечером|в instagram|из instagram)|квалифицир|lead intake|lead manager|qualif/iu, product: 'receptionist' },
  { id: 'site', re: /(?<![\p{L}])(сайт|лендинг|landing)(?![\p{L}])|\bwebsite\b|web ?site/iu, product: 'site' },
];

/** Kinds that live on bookings: a generic «бот» for them means the ИИ-администратор. */
const BOOKING_KINDS: readonly BuilderKind[] = [
  'barber', 'salon', 'nails', 'spa', 'cosmetology', 'dentist', 'clinic', 'fitness', 'yoga', 'massage', 'carservice', 'carwash', 'vet', 'photo', 'tutor', 'languages',
];
/** Kinds that sell goods or food: a generic «бот» for them means a Mini App (catalogue, cart). */
const SHOP_KINDS: readonly BuilderKind[] = [
  'cafe', 'restaurant', 'coffee', 'bakery', 'delivery', 'catering', 'shop', 'webshop', 'flowers', 'gifts', 'clothing', 'electronics', 'furniture', 'autoparts', 'petshop',
];
const GENERIC_BOT = /(?<![\p{L}])(бот(а|у|ом|е|ы|ов)?|чат-?бот\w*|bot|chatbot|telegram[- ]bot)(?![\p{L}])/iu;

/** What a «бот» means for this kind of business (the old `p.bot` is only a delivery channel on the site now). */
export function productOfBot(kind: BuilderKind | undefined): CatalogueId {
  if (kind && BOOKING_KINDS.includes(kind)) return 'admin';
  if (kind && SHOP_KINDS.includes(kind)) return 'miniapp';
  return 'receptionist';
}

/** The product a message asks for: an explicit need (`explicit: true`) or the generic «бот» resolved by the business kind. null: nothing said. */
export function productOfNeed(text: string, kind?: BuilderKind): { product: CatalogueId; explicit: boolean; rule: string } | null {
  for (const r of NEED_RULES) {
    if (!r.re.test(text)) continue;
    // «не хочу сайт» is about the site need, not a wish for a site
    if (r.id === 'site' && siteNeedOf(text) === 'no') continue;
    return { product: r.product, explicit: true, rule: r.id };
  }
  if (GENERIC_BOT.test(text)) return { product: productOfBot(kind), explicit: false, rule: 'bot' };
  return null;
}

/** Products in the catalogue's own order (the builder's `p.` chunk order too): known ids only, no repeats. */
export function inCatalogueOrder(ids: readonly CatalogueId[]): CatalogueId[] {
  const order: readonly CatalogueId[] = [...PRODUCT_IDS, ...CLASSIC_IDS];
  return order.filter((id) => ids.includes(id));
}

/** A negation right before a need word: «не нужен сайт», «без сайта», «убери рассылки», «don't need a website». */
const NEGATED_BEFORE = /(?:не\s+(?:нуж\p{L}*|надо|хоч\p{L}+|требу\p{L}+|делайте|делаем|берём|берем)|без|убер\p{L}+|откаж\p{L}+(?:\s+от)?|(?:no need for|don'?t need|do not need|don'?t want|do not want|without|drop|remove|skip))\s+(?:(?:мне|нам|нужен|нужна|нужно|нужны|ни|а|a|an|the|any|our|my|свой|свою|наш\p{L}*)\s+){0,2}$/iu;
/** A negation right after it: «сайт не нужен», «администратор нам не нужен». */
const NEGATED_AFTER = /^\s*(?:мне\s+|нам\s+)?не\s+(?:нуж\p{L}*|надо|хочу|требу\p{L}+)|^\s+(?:is not|isn'?t) needed/iu;
/** «только администратор», «just a website»: this need replaces what was listed. */
const ONLY_BEFORE = /(?:только|лишь|just|only)\s+(?:(?:нужен|нужна|нужно|нужны|a|an|the|один|одну|одного|наш\p{L}*)\s+){0,2}$/iu;

export interface NeedChange {
  /** Explicit needs the visitor named (positive), in the table's order. */
  add: CatalogueId[];
  /** Products the visitor dropped («не нужен сайт», «у нас уже есть сайт»). */
  remove: CatalogueId[];
  /** «только X»: the named needs replace the list. */
  only: boolean;
  /** A bare «бот», resolved by the kind of business; only when nothing explicit was named. */
  generic?: CatalogueId;
}

/**
 * What one message does to the list of products: the table's explicit needs add (every row that matches, not just the first), a negated need removes,
 * «только X» replaces, a bare «бот» is the fallback. The receptionist keeps a LIST per dialogue (owner 2026-11-22: the builder allows several products).
 */
export function needChange(text: string, kind?: BuilderKind): NeedChange {
  const site = siteNeedOf(text);
  const add: CatalogueId[] = [];
  const remove: CatalogueId[] = [];
  let only = false;
  for (const r of NEED_RULES) {
    if (r.id === 'site' && (site === 'no' || site === 'have')) {
      remove.push('site');
      continue;
    }
    let positive = false;
    let negative = false;
    for (const m of text.matchAll(new RegExp(r.re.source, r.re.flags.includes('g') ? r.re.flags : `${r.re.flags}g`))) {
      const at = m.index ?? 0;
      const before = text.slice(Math.max(0, at - 40), at);
      const after = text.slice(at + m[0].length, at + m[0].length + 30);
      if (NEGATED_BEFORE.test(before) || NEGATED_AFTER.test(after)) negative = true;
      else {
        positive = true;
        if (ONLY_BEFORE.test(before)) only = true;
      }
    }
    if (positive) add.push(r.product);
    else if (negative) remove.push(r.product);
  }
  const explicit = [...new Set(add)];
  const out: NeedChange = { add: inCatalogueOrder(explicit), remove: inCatalogueOrder([...new Set(remove)].filter((x) => !explicit.includes(x))), only };
  if (!out.add.length && GENERIC_BOT.test(text) && !/(?:не\s+нуж\p{L}*|без|don'?t need|without)\s+(?:\S+\s+)?(?:бот|bot|чат)/iu.test(text)) out.generic = productOfBot(kind);
  return out;
}

const NO_SITE = /(не\s+(нужен|нужно|нужна|надо|хочу|требуется)|без|обойд[её]мся без|не\s+делайте|не\s+делаем)\s+(мне\s+|нам\s+|нужен\s+)?(сайт|сайта|лендинг\w*)|(сайт|сайта)\s+(мне\s+|нам\s+)?не\s+(нужен|нужно|надо|хочу)|только\s+(агент|ассистент|ии|бот)\w*|no (need for a )?(web)?site|(don'?t|do not) (want|need) (a )?(web)?site|without (a )?(web)?site|(agent|bot) only|only (the |an? )?(agent|bot)/iu;
const HAVE_SITE = /(у (меня|нас) (уже )?есть|уже есть|есть свой)\s+(свой\s+)?(сайт|лендинг)|(i|we) (already )?have (a |our )?(web)?site|already (got|have) (a |our )?(web)?site/iu;

/** Does the visitor need a site for the agent: `no` («не хочу сайт, только агент»), `have` («сайт уже есть»), else undefined. */
export function siteNeedOf(text: string): SiteNeed | undefined {
  if (NO_SITE.test(text)) return 'no';
  if (HAVE_SITE.test(text)) return 'have';
  return undefined;
}

/** The delivery a no-site agent gets: the Fir Tech playground (the builder's `l.playground`). */
export const NO_SITE_DELIVERY: DeliveryChannel[] = ['playground'];

/** «Что вы делаете», «какие продукты»: the only questions the whole product list answers. */
export const asksCatalogue = (text: string): boolean =>
  /что вы делаете|чем (вы )?занимаетесь|какие (у вас )?(продукты|услуги|решения)|что (вы )?(предлагаете|продаёте|продаете|умеете|можете)|ваши (продукты|услуги)|what do you (do|offer|sell)|what (products|services) do you|which products|your (products|services)/iu.test(text);

/** Words that name an option of a flagship (the `f.` chunk of the builder link): the services a Персональный ИИ connects and the departments and parts of an ИИ-компания. */
const OPTION_WORDS: Record<'personal' | 'company', [string, RegExp][]> = {
  personal: [
    ['mail', /почт|e-?mail|\bmail\b|письм|inbox/iu], ['calendar', /календар|calendar|расписани|встреч/iu], ['tasks', /задач|дела\b|напоминани|tasks?\b|to-?do|reminders?/iu],
    ['study', /учёб|учеб|студент|moodle|дедлайн|study|lessons?\b|language/iu], ['notes', /заметк|notes?\b/iu], ['messengers', /мессенджер|whatsapp|ватсап|messengers?/iu],
    ['voice', /голос|voice|голосов/iu], ['memory', /памят|помни|memory|remember/iu],
  ],
  company: [
    ['sales', /продаж|sales/iu], ['marketing', /маркетинг|marketing/iu], ['support', /поддержк|support/iu], ['production', /производств|production|delivery of work/iu],
    ['backoffice', /бэк-?офис|бухгалтер|финанс|back[- ]?office|accounting/iu],
    ['pult', /пульт|control (panel|room)|dashboard/iu], ['knowledge', /баз[аыуе] знаний|knowledge base/iu], ['channels', /канал|channels?\b/iu], ['training', /обучени|training/iu],
  ],
};

/** The options of a flagship the visitor named in a message, in the site's order of ids. Only the product asked about (the others are never touched). */
export function flagshipOptionsOf(text: string, products: readonly string[]): FlagshipOptions {
  const out: FlagshipOptions = {};
  for (const id of ['personal', 'company'] as const) {
    if (!products.includes(id)) continue;
    const hit = OPTION_WORDS[id].filter(([, re]) => re.test(text)).map(([o]) => o);
    const picked = FLAGSHIP_OPTION_IDS[id].filter((o) => hit.includes(o));
    if (picked.length) out[id] = picked;
  }
  return out;
}
