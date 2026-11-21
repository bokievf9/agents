import type { BuilderKind, DeliveryChannel, SiteNeed } from './builder-link.js';
import type { CatalogueId } from './products.js';

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

export const NEED_RULES: NeedRule[] = [
  { id: 'department', re: /(?<![\p{L}])(ии|ai)[- ]?отдел|отдел из (ии|агент)|баз[ауыойе] знаний|knowledge base|ai department/iu, product: 'ai' },
  { id: 'miniapp', re: /mini ?app|мини-?апп|мини-?приложени|магазин (в|внутри) телеграм|каталог (в|внутри) телеграм/iu, product: 'miniapp' },
  { id: 'content', re: /контент|рилс|reels|посты|постов|соцсет|ведение (инстаграм|instagram)|content plan|social media/iu, product: 'content' },
  { id: 'automation', re: /автоматизац|таблиц|crm|отчёт(ы|ов)|отчет(ы|ов)|рассылк|интеграци|automation|spreadsheet|reports?\b/iu, product: 'automation' },
  { id: 'assistant', re: /личн(ый|ого) (ассистент|помощник)|персональн\w+ (ассистент|помощник)|personal (assistant|agent)/iu, product: 'agent' },
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
