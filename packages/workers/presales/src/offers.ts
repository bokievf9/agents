import { getPrices, personalPlans, planOf, productName, supportMonthly, teamPrice, usd, type ProductKey } from '@fir/core';
import { builderCodeIn } from './estimate.js';

/**
 * The offers of a commercial proposal. Names, timelines and scope live here; the dollar amounts never do: they are read
 * from the site's price list (`getPrices()` in @fir/core, served by firtech.pro/api/prices) at the moment of use.
 * The model never writes a price: it writes `[цена]` and the template fills it from the price list.
 *
 * Timelines: site 7-10 days, bot 5-7, receptionist 7, mini app 14-21 are the owner's (COMPANY.md); the rest are
 * working estimates, the owner corrects them in the card before sending.
 */
/** The flagships first (2026-11-22). `agent` is the retired direction of the personal assistants: stored packs and leads keep it, it is offered as `personal`. */
export const DIRECTION_IDS = ['personal', 'company', 'admin', 'receptionist', 'automation', 'content', 'miniapp', 'implementation', 'site', 'agent'] as const;
export type DirectionId = (typeof DIRECTION_IDS)[number];

export interface Offer {
  id: DirectionId;
  /** Name of the solution in the proposal (nominative). */
  title: string;
  /** Base (one-time or setup) price in USD, from the site's price list. */
  readonly fromUsd: number;
  /** Monthly fee in USD for subscriptions (content, personal agents), from the site's price list. */
  readonly monthlyUsd?: number;
  /** The flagship whose exact sum is fixed in the estimate (the plan is «from»). */
  byQuote?: boolean;
  /** Timeline text for the proposal. */
  timeline: string;
  /** Default scope (used when the model's scope is missing or breaks the rules), 5-8 bullets. */
  scope: string[];
}

/** Monthly support after launch, USD (the site's price list). */
export const supportMonthlyUsd = (): number => supportMonthly();

type Meta = Omit<Offer, 'fromUsd' | 'monthlyUsd'>;
const product = (key: ProductKey) => () => ({ from: getPrices().products[key]! });
const priced = (m: Meta, price: () => { from: number; monthly?: number }): Offer => ({
  ...m,
  get fromUsd() {
    return price().from;
  },
  get monthlyUsd() {
    return price().monthly;
  },
});
const personal = () => {
  const first = personalPlans()[0];
  return { from: first?.setup ?? 0, monthly: first?.monthly };
};
const company = () => {
  const c = planOf('company');
  return { from: c.setup, monthly: c.monthly };
};
const content = () => {
  const c = planOf('content');
  return { from: c.setup, monthly: c.monthly };
};

const META_BY_ID: Record<Exclude<DirectionId, 'agent'>, Meta> = {
  admin: {
    id: 'admin', get title() { return productName('adminbot', 'ru'); }, timeline: '5-7 рабочих дней',
    scope: [
      'Диалоги агента: приветствие, услуги, цены, ответы на частые вопросы',
      'Запись клиента: выбор услуги, даты и времени, подтверждение',
      'Напоминания клиентам о записи',
      'Уведомления владельцу о каждой новой заявке',
      'Панель управления: расписание, отмена и перенос записей',
      'Тестирование на ваших сценариях и запуск на ваш аккаунт',
    ],
  },
  receptionist: {
    id: 'receptionist', get title() { return productName('intake', 'ru'); }, timeline: '7 рабочих дней',
    scope: [
      'Подключение каналов: Telegram, а также WhatsApp или Instagram по договорённости',
      'ИИ отвечает на типовые вопросы по вашему прайсу и описанию услуг',
      'Сбор заявки: имя, контакт, услуга, удобное время',
      'Передача готовой заявки владельцу или администратору',
      'Правила: на какие вопросы агент не отвечает и зовёт человека',
      'Настройка, тест на реальных диалогах и запуск',
    ],
  },
  automation: {
    id: 'automation', get title() { return productName('automation', 'ru'); }, timeline: '5-10 рабочих дней',
    scope: [
      'Разбор вашего процесса и список шагов, которые автоматизируем',
      'Подключение источников данных: формы, таблицы, мессенджеры',
      'Автоматические действия: уведомления, переносы данных, отчёты',
      'Обработка ошибок и уведомление, если что-то пошло не так',
      'Тест на реальных данных',
      'Короткая инструкция по работе',
    ],
  },
  content: {
    id: 'content', get title() { return productName('content', 'ru'); }, timeline: 'первые материалы за 3-5 рабочих дней',
    scope: [
      'Контент-план на месяц под вашу нишу и аудиторию',
      'Тексты постов и сценарии коротких видео',
      'Оформление и подписи для публикации',
      'Согласование материалов с вами до выхода',
      'Корректировки по вашим замечаниям',
    ],
  },
  miniapp: {
    id: 'miniapp', get title() { return productName('miniapp', 'ru'); }, timeline: '14-21 рабочий день',
    scope: [
      'Каталог или список услуг с карточками и фото',
      'Корзина или оформление заявки внутри Telegram',
      'Оплата или передача заказа владельцу по согласованной схеме',
      'Админка: добавление и изменение позиций без разработчика',
      'Уведомления владельцу о новых заказах',
      'Дизайн в стиле вашего бренда',
      'Тестирование на телефонах и запуск',
    ],
  },
  personal: {
    id: 'personal', get title() { return productName('personal', 'ru'); }, timeline: '5-7 рабочих дней',
    scope: [
      'Разбор вашего дня: какие сервисы подключаем (почта, календарь, задачи, учёба, заметки, мессенджеры)',
      'Подключение выбранных сервисов к вашему личному ИИ в Telegram',
      'Утренняя сводка: письма, встречи, дела и сроки на день',
      'Обещания и поручения: ИИ помнит, что вы пообещали, и напоминает',
      'Правила: что ИИ делает сам, что согласует с вами, чего не делает никогда',
      'Тест на ваших реальных делах, запуск и инструкция',
    ],
  },
  company: {
    id: 'company', get title() { return productName('company', 'ru'); }, timeline: '4-6 недель, четыре этапа', byQuote: true,
    scope: [
      'Карта компании: процессы, роли, источники данных, и Директор из ИИ',
      'Первые отделы на ваших данных (продажи, маркетинг, поддержка, производство или бэк-офис по выбору)',
      'Пульт владельца: задачи, одобрения, отчёты и журнал в одном месте',
      'База знаний компании и каналы клиентов',
      'Уровни доверия: что агенты делают сами, что только после вашего одобрения',
      'Обучение команды, тестовый период и запуск',
    ],
  },
  implementation: {
    id: 'implementation', get title() { return productName('aiteam', 'ru'); }, timeline: '14-21 рабочий день',
    scope: [
      'Аудит процессов и список точек для ИИ',
      'План внедрения по приоритетам',
      'Настройка выбранных инструментов под ваши процессы',
      'Обучение сотрудников работе с ними',
      'Тестовый период с разбором результатов',
      'Итоговый отчёт и рекомендации',
    ],
  },
  site: {
    id: 'site', get title() { return productName('site', 'ru'); }, timeline: '7-10 рабочих дней',
    scope: [
      'Структура и дизайн под вашу нишу, адаптация под телефон',
      'Тексты и блоки: услуги, цены, отзывы, контакты',
      'Форма заявки с уведомлением в Telegram',
      'Базовая SEO-настройка и скорость загрузки',
      'Подключение домена и хостинга',
      'Правки по вашим замечаниям и запуск',
    ],
  },
};

// the retired `agent` direction is the personal AI under its old id (stored packs and leads still carry it)
const META: Record<DirectionId, Meta> = {
  ...META_BY_ID,
  agent: { id: 'agent', get title() { return productName('personal', 'ru'); }, timeline: META_BY_ID.personal.timeline, scope: META_BY_ID.personal.scope },
};

const PRICE: Record<DirectionId, () => { from: number; monthly?: number }> = {
  personal,
  company,
  admin: product('admin'),
  receptionist: product('intake'),
  automation: product('automation'),
  content,
  miniapp: product('miniapp'),
  agent: personal,
  implementation: () => {
    const t = teamPrice('sales');
    return t ? { from: t.setup, monthly: t.monthly } : company();
  },
  site: product('site'),
};

export const OFFERS = Object.fromEntries(DIRECTION_IDS.map((id) => [id, priced(META[id], PRICE[id])])) as Record<DirectionId, Offer>;

export const isDirectionId = (v: string): v is DirectionId => (DIRECTION_IDS as readonly string[]).includes(v);

/** «от $N», «от $N + $M в месяц» (setup plus a monthly fee), the amounts from the price list. */
export function priceLabel(o: Offer): string {
  return `от ${usd(o.fromUsd)}${o.monthlyUsd ? ` + ${usd(o.monthlyUsd)} в месяц` : ''}`;
}

/** The form's `service` field (and the lead's source) to a direction. `source` is the direction id itself. */
const SERVICE: Record<string, DirectionId> = { bots: 'admin', websites: 'site', ai: 'receptionist', automation: 'automation' };

const KEYWORDS: [RegExp, DirectionId][] = [
  [/mini ?app|мини-?прилож/i, 'miniapp'],
  [/приём?щик|приемщик|ии-?(ассистент|менеджер)|whatsapp|instagram/i, 'receptionist'],
  [/вся компани|всю компани|все отделы|ии-?компани|компани\p{L}* на агентах|директор из ии|whole company|ai company/iu, 'company'],
  [/персональн\p{L}* ии|личн\p{L}* (ассистент|помощник|ии)|для себя|personal ai/iu, 'personal'],
  [/агент/i, 'personal'],
  [/внедрен/i, 'implementation'],
  [/контент|smm|посты/i, 'content'],
  [/автоматиз|таблиц|crm|интеграц/i, 'automation'],
  [/сайт|лендинг|landing|интернет-магазин/i, 'site'],
  [/бот|запис|администратор/i, 'admin'],
];

export function guessDirection(parts: { source?: string; service?: string; text?: string }): DirectionId {
  // a Персональный ИИ lead from the site (`service: 'personal'`): never a business direction, whatever words its summary holds
  if (parts.service === 'personal') return 'personal';
  if (parts.source && isDirectionId(parts.source)) return parts.source === 'agent' ? 'personal' : parts.source;
  const text = parts.text ?? '';
  // a build that names only a flagship (`p.personal`, `p.company`): the link in the text says it (an old `p.agent` is `personal`)
  const products = (builderCodeIn(text) ?? '').split('~').find((c) => c.startsWith('p.'))?.slice(2).split('-') ?? [];
  const flagship = products.find((x) => x === 'company') ?? products.find((x) => x === 'personal' || x === 'agent');
  if (flagship && products.every((x) => ['personal', 'company', 'agent'].includes(x))) return flagship === 'company' ? 'company' : 'personal';
  for (const [re, id] of KEYWORDS) if (re.test(text)) return id;
  return (parts.service && SERVICE[parts.service]) || 'admin';
}

/**
 * The offer of a several-product build: the most expensive part gives the id (documents, stages), the title names every part (`Сайт + ИИ-администратор`),
 * the timeline lists each direction's own, the scope takes the first bullets of each direction (5-8 in all). One direction: that offer as it is.
 */
export function bundleOffer(directions: DirectionId[], fallback: Offer): Offer {
  const offers = directions.map((d) => OFFERS[d]);
  if (offers.length === 0) return fallback;
  if (offers.length === 1) return offers[0]!;
  const first = offers[0]!;
  const per = Math.max(2, Math.floor(8 / offers.length));
  const scope = offers.flatMap((o) => o.scope.slice(0, per)).slice(0, 8);
  return {
    id: first.id,
    title: offers.map((o) => o.title).join(' + '),
    fromUsd: first.fromUsd,
    ...(first.monthlyUsd !== undefined ? { monthlyUsd: first.monthlyUsd } : {}),
    timeline: offers.map((o) => `${o.title}: ${o.timeline}`).join('; '),
    scope: scope.length >= 5 ? scope : first.scope,
  };
}
