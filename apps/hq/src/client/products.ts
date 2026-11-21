/**
 * The single product catalogue of the public channels (Telegram client bot and the website chat) and of the LLM prompt.
 * The seven products are what Fir Tech sells first («Что продаём» in COMPANY.md); the classics (site, bot, app) stay as
 * the plain ways to order. No dollar amount is typed here: every price is read from the site's price list at the moment
 * of use (`getPrices()` in @fir/core, firtech.pro/api/prices), see `priceOf` and `startingPrices`.
 */
import { companyPlan, getPrices, personalPlans, planOf, productNames, usd, type ProductKey } from '@fir/core';

export type PLang = 'ru' | 'en';
type L<T> = Record<PLang, T>;

/** The flagships first (the site's order, 2026-11-22), then the products by one job each. The retired `agent` is `personal` (see `PRODUCTS.agent` below). */
export const PRODUCT_IDS = ['personal', 'company', 'admin', 'receptionist', 'automation', 'content', 'miniapp', 'ai'] as const;
export const FLAGSHIP_IDS = ['personal', 'company'] as const;
export const CLASSIC_IDS = ['site', 'bot', 'app'] as const;
export type ProductId = (typeof PRODUCT_IDS)[number];
export type ClassicId = (typeof CLASSIC_IDS)[number];
export type CatalogueId = ProductId | ClassicId;

export type KindId =
  | 'barbershop' | 'salon' | 'clinic' | 'studio' | 'autoservice' | 'cafe' | 'delivery' | 'shop' | 'school' | 'realestate' | 'student' | 'company';

export interface Product {
  id: CatalogueId;
  emoji: string;
  name: L<string>;
  /** One line: what the client gets. */
  benefit: L<string>;
  /** Business kinds it fits first. */
  kinds: KindId[];
  inside: L<[string, string, string]>;
  /** Products that usually go together with this one. */
  pairs: CatalogueId[];
  /** How the visitor can see it working. */
  demo: L<string>;
}

export const KIND_LABELS: Record<KindId, L<string>> = {
  barbershop: { ru: 'барбершопы', en: 'barbershops' },
  salon: { ru: 'салоны красоты', en: 'beauty salons' },
  clinic: { ru: 'клиники и стоматологии', en: 'clinics and dental offices' },
  studio: { ru: 'студии и фитнес', en: 'studios and fitness clubs' },
  autoservice: { ru: 'автосервисы', en: 'car services' },
  cafe: { ru: 'кафе и рестораны', en: 'cafes and restaurants' },
  delivery: { ru: 'доставка', en: 'delivery businesses' },
  shop: { ru: 'магазины', en: 'shops' },
  school: { ru: 'школы, курсы, репетиторы', en: 'schools, courses and tutors' },
  realestate: { ru: 'недвижимость', en: 'real estate' },
  student: { ru: 'студенты', en: 'students' },
  company: { ru: 'компании с базой знаний и поддержкой', en: 'companies with a knowledge base and support' },
};

export const PRODUCTS: Record<CatalogueId, Product> = {
  admin: {
    id: 'admin', emoji: '🤖',
    /** From the one map of product names (`@fir/core` `product-names.ts`), the live title of the price list first. */
    get name() {
      return productNames('admin');
    },
    benefit: {
      ru: 'Клиенты сами записываются в Telegram, получают напоминания и оставляют отзывы, а вы не сидите на телефоне.',
      en: 'Clients book in Telegram on their own, get reminders and leave reviews, and you stay off the phone.',
    },
    kinds: ['barbershop', 'salon', 'clinic', 'studio', 'autoservice'],
    inside: {
      ru: ['Запись на услугу: выбор мастера, дня и времени', 'Напоминания до визита и перенос в один клик', 'Сбор отзывов после визита и уведомления вам'],
      en: ['Booking: pick the specialist, day and time', 'Reminders before the visit and one-tap rescheduling', 'Reviews collected after the visit and alerts to you'],
    },
    pairs: ['content', 'receptionist'],
    demo: { ru: 'Покажем рабочего ИИ-администратора под вашу нишу на звонке.', en: 'We will show a working AI booking assistant for your niche on a call.' },
  },
  receptionist: {
    id: 'receptionist', emoji: '💬',
    /** From the one map of product names (`@fir/core` `product-names.ts`), the live title of the price list first. */
    get name() {
      return productNames('receptionist');
    },
    benefit: {
      ru: 'Отвечает на обращения днём и ночью, задаёт нужные вопросы и передаёт вам готовую заявку.',
      en: 'Answers requests day and night, asks the right questions and hands you a ready lead.',
    },
    kinds: ['school', 'realestate', 'clinic', 'company'],
    inside: {
      ru: ['Ответы на частые вопросы по вашим материалам', 'Короткая анкета и карточка заявки в Telegram', 'Передача человеку, когда нужен он'],
      en: ['Answers to common questions from your materials', 'A short intake and a lead card in Telegram', 'Handover to a person when one is needed'],
    },
    pairs: ['admin', 'automation'],
    demo: { ru: 'Этот чат и есть демо: вы уже разговариваете с ним.', en: 'This very chat is the demo: you are already talking to one.' },
  },
  automation: {
    id: 'automation', emoji: '⚙️',
    /** From the one map of product names (`@fir/core` `product-names.ts`), the live title of the price list first. */
    get name() {
      return productNames('automation');
    },
    benefit: {
      ru: 'Заявки, таблицы, отчёты и рассылки идут сами, без ручного копирования.',
      en: 'Leads, spreadsheets, reports and mailings run by themselves, with no manual copying.',
    },
    kinds: ['shop', 'delivery', 'autoservice', 'realestate'],
    inside: {
      ru: ['Связка Google Sheets, CRM и мессенджеров', 'Автоматические отчёты и уведомления', 'Рассылки и напоминания клиентам'],
      en: ['Google Sheets, CRM and messengers connected', 'Automatic reports and notifications', 'Mailings and reminders to clients'],
    },
    pairs: ['receptionist', 'ai'],
    demo: { ru: 'Покажем, как выглядит ваш процесс до и после, на звонке.', en: 'We will show your process before and after on a call.' },
  },
  content: {
    id: 'content', emoji: '🎬',
    /** From the one map of product names (`@fir/core` `product-names.ts`), the live title of the price list first. */
    get name() {
      return productNames('content');
    },
    benefit: {
      ru: 'Посты, карточки и ролики выходят регулярно, вы только утверждаете.',
      en: 'Posts, cards and short videos go out regularly, you only approve them.',
    },
    kinds: ['barbershop', 'salon', 'cafe', 'shop', 'studio'],
    inside: {
      ru: ['Контент-план под ваш бизнес', 'Готовые посты, карточки и короткие ролики', 'Утверждение в Telegram, публикация по расписанию'],
      en: ['A content plan for your business', 'Ready posts, cards and short videos', 'Approval in Telegram, publishing on schedule'],
    },
    pairs: ['admin', 'miniapp'],
    demo: { ru: 'Покажем примеры контента для вашей ниши.', en: 'We will show content samples for your niche.' },
  },
  miniapp: {
    id: 'miniapp', emoji: '📱',
    /** From the one map of product names (`@fir/core` `product-names.ts`), the live title of the price list first. */
    get name() {
      return productNames('miniapp');
    },
    benefit: {
      ru: 'Магазин, запись или программа лояльности прямо внутри Telegram, без установки приложения.',
      en: 'A shop, booking or loyalty programme right inside Telegram, with no app to install.',
    },
    kinds: ['shop', 'cafe', 'delivery', 'studio'],
    inside: {
      ru: ['Каталог, корзина и оформление заказа', 'Запись и личный кабинет клиента', 'Баллы, карты лояльности и уведомления'],
      en: ['Catalogue, cart and checkout', 'Booking and a client account', 'Points, loyalty cards and notifications'],
    },
    pairs: ['automation', 'content'],
    demo: { ru: 'Покажем прототип мини-приложения на звонке.', en: 'We will show a mini app prototype on a call.' },
  },
  personal: {
    id: 'personal', emoji: '🧠',
    /** From the one map of product names (`@fir/core` `product-names.ts`), the live title of the price list first. */
    get name() {
      return productNames('personal');
    },
    benefit: {
      ru: 'Ваш личный ИИ в Telegram: собирает утреннюю сводку, разбирает почту, помнит обещания и находит время на дела. Работает на вас одного.',
      en: 'Your own AI in Telegram: builds a morning summary, sorts the mail, remembers promises and finds time for your tasks. It works for you alone.',
    },
    kinds: ['student', 'company', 'cafe'],
    inside: {
      ru: ['Почта, календарь и задачи в одном плане дня', 'Голос и долгая память, если нужны', 'Подключаем только те сервисы, которые вам нужны'],
      en: ['Mail, calendar and tasks in one plan of the day', 'Voice and a long memory when you want them', 'Only the services you need are connected'],
    },
    pairs: ['company'],
    demo: { ru: 'Покажем демо Персонального ИИ на примере владельца кофейни: во вкладке «Персональный ИИ» в чате.', en: 'We will show the Personal AI demo on a coffee shop owner: the “Personal AI” tab in the chat.' },
  },
  company: {
    id: 'company', emoji: '🏛️',
    /** From the one map of product names (`@fir/core` `product-names.ts`), the live title of the price list first. */
    get name() {
      return productNames('company');
    },
    benefit: {
      ru: 'Компания на агентах, как у Fir Tech: Директор и отделы из ИИ работают на ваших данных, а вы управляете из Пульта.',
      en: 'A company of agents like Fir Tech\'s own: a Director and AI departments work on your data, and you run it from a control panel.',
    },
    kinds: ['company', 'realestate', 'clinic'],
    inside: {
      ru: ['Карта компании и Директор', 'Отделы на ваших данных: продажи, маркетинг, поддержка, производство, бэк-офис', 'Пульт, база знаний, каналы и обучение команды'],
      en: ['A company map and a Director', 'Departments on your data: sales, marketing, support, production, back office', 'A control panel, a knowledge base, channels and team training'],
    },
    pairs: ['personal', 'ai'],
    demo: { ru: 'Покажем, как устроена наша собственная компания на агентах, на звонке.', en: 'We will show how our own company of agents is built, on a call.' },
  },
  ai: {
    id: 'ai', emoji: '🏢',
    /** From the one map of product names (`@fir/core` `product-names.ts`), the live title of the price list first. */
    get name() {
      return productNames('ai');
    },
    benefit: {
      ru: 'ИИ отвечает по вашим документам и базе знаний, команда меньше тратит время на поиск и рутину.',
      en: 'AI answers from your documents and knowledge base, and the team spends less time searching and on routine.',
    },
    kinds: ['company', 'realestate', 'clinic'],
    inside: {
      ru: ['База знаний и ответы по документам', 'Помощник для сотрудников в Telegram или на сайте', 'Обучение команды и безопасные правила работы'],
      en: ['A knowledge base and answers from documents', 'A helper for staff in Telegram or on the site', 'Team training and safe working rules'],
    },
    pairs: ['automation', 'receptionist'],
    demo: { ru: 'Покажем ответы по примеру ваших документов на звонке.', en: 'We will show answers over a sample of your documents on a call.' },
  },
  site: {
    id: 'site', emoji: '🌐',
    /** From the one map of product names (`@fir/core` `product-names.ts`), the live title of the price list first. */
    get name() {
      return productNames('site');
    },
    benefit: {
      ru: 'Лендинг или сайт компании, который показывает ваши услуги и приводит заявки.',
      en: 'A landing page or company site that shows your services and brings in requests.',
    },
    kinds: ['barbershop', 'salon', 'clinic', 'school', 'shop'],
    inside: {
      ru: ['Дизайн и вёрстка под ваш бренд', 'Форма заявки со связью в Telegram', 'Русская и английская версии'],
      en: ['Design and build for your brand', 'A request form wired to Telegram', 'Russian and English versions'],
    },
    pairs: ['receptionist', 'admin'],
    demo: { ru: 'Наш сайт firtech.pro сделан так же.', en: 'Our own site firtech.pro is built the same way.' },
  },
  bot: {
    id: 'bot', emoji: '🤖',
    /** From the one map of product names (`@fir/core` `product-names.ts`), the live title of the price list first. */
    get name() {
      return productNames('bot');
    },
    benefit: { ru: 'Бот под любой сценарий, если готовые продукты не подходят.', en: 'A bot for any scenario when the ready products do not fit.' },
    kinds: [],
    inside: {
      ru: ['Сценарий под вашу задачу', 'Админка и уведомления вам', 'Запуск и сопровождение'],
      en: ['A scenario for your task', 'An admin view and alerts to you', 'Launch and support'],
    },
    pairs: ['admin', 'receptionist'],
    demo: { ru: 'Этот чат тоже наша работа.', en: 'This chat is our work too.' },
  },
  app: {
    id: 'app', emoji: '📲',
    /** From the one map of product names (`@fir/core` `product-names.ts`), the live title of the price list first. */
    get name() {
      return productNames('app');
    },
    benefit: { ru: 'Веб-приложение или мобильное приложение под ваш процесс.', en: 'A web or mobile app for your process.' },
    kinds: [],
    inside: {
      ru: ['Макет и разработка', 'Личный кабинет и роли', 'Запуск и сопровождение'],
      en: ['Design and development', 'Accounts and roles', 'Launch and support'],
    },
    pairs: ['miniapp', 'automation'],
    demo: { ru: 'Для небольших задач часто хватает Mini App.', en: 'For smaller tasks a Mini App is often enough.' },
  },
};

/**
 * The retired `agent` (the old «Персональный ИИ-ассистент») answers as `personal`: a button of an old chat message (`p:agent`) and a stored state still resolve. It is an alias,
 * not a member of `PRODUCT_IDS`, so no list or prompt shows it twice.
 */
(PRODUCTS as Record<string, Product>).agent = PRODUCTS.personal;
export const isCatalogueId = (s: string): s is CatalogueId => Object.prototype.hasOwnProperty.call(PRODUCTS, s);
/** `agent` -> `personal`; any other id as it is. */
export const currentId = <T extends string>(id: T): T | 'personal' => (id === 'agent' ? 'personal' : id);
export const isProductId = (s: string): s is ProductId => (PRODUCT_IDS as readonly string[]).includes(s);

const PRICE_KEY: Partial<Record<CatalogueId, ProductKey>> = {
  admin: 'admin', receptionist: 'intake', automation: 'automation', miniapp: 'miniapp', ai: 'aiteam', site: 'site', bot: 'bot', app: 'app',
};

/** «$N 490»: thousands with a space, as the owner writes the flagship prices. */
export const usdSpaced = (n: number): string => `$${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}`;

/** The public price of a product, from the site's price list: «от $N», «от $N + $M/мес»; the flagships by their plans. */
export function priceOf(id: CatalogueId, lang: PLang): string {
  const month = lang === 'ru' ? '/мес' : '/month';
  const from = lang === 'ru' ? 'от' : 'from';
  if (id === 'content') {
    const c = planOf('content');
    return `${from} ${usd(c.setup)} + ${usd(c.monthly)}${month}`;
  }
  if (id === 'personal' || (id as string) === 'agent') return personalPrice(lang);
  if (id === 'company') return companyPrice(lang);
  const key = PRICE_KEY[id];
  return `${from} ${usd(key ? getPrices().products[key]! : 0)}`;
}

/** Персональный ИИ: «от N + M/мес» (the cheapest level), or an empty string when the site has not published the plans. */
export function personalPrice(lang: PLang): string {
  const first = personalPlans()[0];
  if (!first) return '';
  const month = lang === 'ru' ? '/мес' : '/month';
  return `${lang === 'ru' ? 'от' : 'from'} ${usdSpaced(first.setup)} + ${usdSpaced(first.monthly)}${month}`;
}

/** ИИ-компания: «от N + M/мес, точно по смете». */
export function companyPrice(lang: PLang): string {
  const c = companyPlan();
  if (!c) return '';
  const month = lang === 'ru' ? '/мес' : '/month';
  return `${lang === 'ru' ? 'от' : 'from'} ${usdSpaced(c.setup)} + ${usdSpaced(c.monthly)}${month}${lang === 'ru' ? ', точно по смете' : ', the exact sum by quote'}`;
}

/** The levels of Персональный ИИ, for the card: «Старт N + M/мес, Плюс N + M/мес, Максимум N + M/мес» (ids as the site names them). */
export function personalLevels(lang: PLang): string {
  const names: Record<string, L<string>> = { basic: { ru: 'Старт', en: 'Start' }, plus: { ru: 'Плюс', en: 'Plus' }, max: { ru: 'Максимум', en: 'Max' } };
  const month = lang === 'ru' ? '/мес' : '/month';
  return personalPlans().map((p) => `${names[p.id]?.[lang] ?? p.id} ${usdSpaced(p.setup)} + ${usdSpaced(p.monthly)}${month}`).join(', ');
}

/** One line with the starting price of every product that is for sale, the flagships first: for the answer to a direct question about prices. */
export function startingPrices(lang: PLang): string {
  const ids: CatalogueId[] = [...PRODUCT_IDS, ...CLASSIC_IDS];
  const list = ids.map((id) => ({ id, price: priceOf(id, lang) })).filter((x) => x.price).map((x) => `${PRODUCTS[x.id].name[lang]} ${x.price}`).join('; ');
  // no closing full stop: the callers add theirs
  return lang === 'ru' ? `Цены на сайте, в долларах: ${list}` : `Prices as on the site, in USD: ${list}`;
}

/** Business niche the visitor mentions, the product that usually fits it, and the words for the hint. */
interface Kind { id: KindId; re: RegExp; product: ProductId; hint: L<string> }
const KINDS: Kind[] = [
  { id: 'barbershop', re: /барбер|barber/i, product: 'admin', hint: { ru: 'барбершопа', en: 'a barbershop' } },
  { id: 'salon', re: /салон|маникюр|парикмах|ногт|beauty|salon|nails?\b|hair/i, product: 'admin', hint: { ru: 'салона красоты', en: 'a beauty salon' } },
  { id: 'clinic', re: /клиник|стоматолог|врач|медцентр|clinic|dental|dentist|doctor/i, product: 'admin', hint: { ru: 'клиники', en: 'a clinic' } },
  { id: 'studio', re: /студи[яию]|фитнес|йог|спортзал|studio|fitness|\bgym\b|yoga/i, product: 'admin', hint: { ru: 'студии или фитнеса', en: 'a studio or fitness club' } },
  { id: 'autoservice', re: /автосервис|автомойк|шиномонтаж|car service|garage|car wash/i, product: 'admin', hint: { ru: 'автосервиса', en: 'a car service' } },
  { id: 'delivery', re: /доставк|курьер|delivery|courier/i, product: 'miniapp', hint: { ru: 'доставки', en: 'a delivery business' } },
  { id: 'cafe', re: /кафе|ресторан|кофейн|пекарн|cafe|restaurant|coffee|bakery/i, product: 'miniapp', hint: { ru: 'кафе', en: 'a cafe' } },
  { id: 'shop', re: /магазин|одежд|e-?commerce|\bshop\b|\bstore\b/i, product: 'miniapp', hint: { ru: 'магазина', en: 'a shop' } },
  { id: 'school', re: /школ|курс[ыаов]?\b|репетитор|учебн|academy|school|courses?\b|tutor/i, product: 'receptionist', hint: { ru: 'школы или курсов', en: 'a school or courses' } },
  { id: 'realestate', re: /недвижим|риелтор|real estate|realtor/i, product: 'receptionist', hint: { ru: 'недвижимости', en: 'real estate' } },
  { id: 'student', re: /студент|универ|student|university/i, product: 'personal', hint: { ru: 'студента', en: 'a student' } },
  { id: 'company', re: /база знаний|knowledge base|служб[аыу] поддержки|support team|документ/i, product: 'ai', hint: { ru: 'компании с базой знаний', en: 'a company with a knowledge base' } },
];

export function detectKind(text: string): Kind | undefined {
  return KINDS.find((k) => k.re.test(text));
}

const names = (lang: PLang, ids: CatalogueId[]): string => ids.map((i) => `«${PRODUCTS[i].name[lang]}»`).join(', ');

/** One line for a visitor who mentioned a niche: the typical product and what it is usually paired with. Empty when no niche is recognised. */
export function nicheHint(lang: PLang, text: string): string {
  const k = detectKind(text);
  if (!k) return '';
  const p = PRODUCTS[k.product];
  const pair = names(lang, p.pairs);
  return lang === 'ru'
    ? `Для ${k.hint.ru} обычно подходит «${p.name.ru}». Часто добавляют: ${pair}.`
    : `For ${k.hint.en} we usually suggest “${p.name.en}”. Often paired with: ${pair}.`;
}

/** The catalogue as plain text for the LLM prompt (prices from the site's price list). */
export function catalogueText(lang: PLang): string {
  const head = lang === 'ru' ? 'Продукты Fir Tech (говори о них именно так, ничего не добавляй от себя)' : 'Fir Tech products (describe them exactly like this, add nothing of your own)';
  const lines = PRODUCT_IDS.map((id) => {
    const p = PRODUCTS[id];
    const whom = p.kinds.map((k) => KIND_LABELS[k][lang]).join(', ');
    const pair = names(lang, p.pairs);
    return lang === 'ru'
      ? `- ${p.name.ru} (${priceOf(id, lang)}): ${p.benefit.ru} Для: ${whom}. Внутри: ${p.inside.ru.join('; ')}. Обычно вместе с: ${pair}.`
      : `- ${p.name.en} (${priceOf(id, lang)}): ${p.benefit.en} For: ${whom}. Inside: ${p.inside.en.join('; ')}. Usually together with: ${pair}.`;
  });
  const classics = lang === 'ru' ? `Классика: ${CLASSIC_IDS.map((i) => PRODUCTS[i].name.ru).join(', ')}.` : `Classics: ${CLASSIC_IDS.map((i) => PRODUCTS[i].name.en).join(', ')}.`;
  const price =
    lang === 'ru'
      ? `Цены (USD, те же, что на сайте): ${startingPrices(lang)}. Называй только эти суммы и только как «от $N», точную цену и срок называет команда в смете.`
      : `Prices (USD, the same as on the site): ${startingPrices(lang)}. State only these amounts and only as "from $N"; the team names the exact price and timing in the estimate.`;
  return [head, ...lines, classics, price].join('\n');
}
