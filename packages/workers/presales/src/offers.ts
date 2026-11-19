import { getPrices, planOf, supportMonthly, usd, type ProductKey } from '@fir/core';

/**
 * The offers of a commercial proposal. Names, timelines and scope live here; the dollar amounts never do: they are read
 * from the site's price list (`getPrices()` in @fir/core, served by firtech.pro/api/prices) at the moment of use.
 * The model never writes a price: it writes `[цена]` and the template fills it from the price list.
 *
 * Timelines: site 7-10 days, bot 5-7, receptionist 7, mini app 14-21 are the owner's (COMPANY.md); the rest are
 * working estimates, the owner corrects them in the card before sending.
 */
export const DIRECTION_IDS = ['admin', 'receptionist', 'automation', 'content', 'miniapp', 'agent', 'implementation', 'site'] as const;
export type DirectionId = (typeof DIRECTION_IDS)[number];

export interface Offer {
  id: DirectionId;
  /** Name of the solution in the proposal (nominative). */
  title: string;
  /** Base (one-time or setup) price in USD, from the site's price list. */
  readonly fromUsd: number;
  /** Monthly fee in USD for subscriptions (content, personal agents), from the site's price list. */
  readonly monthlyUsd?: number;
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
  const d = planOf('dono');
  const p = planOf('polly');
  return { from: Math.min(d.setup, p.setup), monthly: Math.min(d.monthly, p.monthly) };
};
const content = () => {
  const c = planOf('content');
  return { from: c.setup, monthly: c.monthly };
};

const META: Record<DirectionId, Meta> = {
  admin: {
    id: 'admin', title: 'Telegram-бот-администратор', timeline: '5-7 рабочих дней',
    scope: [
      'Диалоги бота: приветствие, услуги, цены, ответы на частые вопросы',
      'Запись клиента: выбор услуги, даты и времени, подтверждение',
      'Напоминания клиентам о записи',
      'Уведомления владельцу о каждой новой заявке',
      'Админ-панель в Telegram: расписание, отмена и перенос записей',
      'Тестирование на ваших сценариях и запуск на ваш аккаунт',
    ],
  },
  receptionist: {
    id: 'receptionist', title: 'ИИ-приёмщик заявок', timeline: '7 рабочих дней',
    scope: [
      'Подключение каналов: Telegram, а также WhatsApp или Instagram по договорённости',
      'ИИ отвечает на типовые вопросы по вашему прайсу и описанию услуг',
      'Сбор заявки: имя, контакт, услуга, удобное время',
      'Передача готовой заявки владельцу или администратору',
      'Правила: на какие вопросы бот не отвечает и зовёт человека',
      'Настройка, тест на реальных диалогах и запуск',
    ],
  },
  automation: {
    id: 'automation', title: 'Автоматизация рутины', timeline: '5-10 рабочих дней',
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
    id: 'content', title: 'Контент-поддержка', timeline: 'первые материалы за 3-5 рабочих дней',
    scope: [
      'Контент-план на месяц под вашу нишу и аудиторию',
      'Тексты постов и сценарии коротких видео',
      'Оформление и подписи для публикации',
      'Согласование материалов с вами до выхода',
      'Корректировки по вашим замечаниям',
    ],
  },
  miniapp: {
    id: 'miniapp', title: 'Мини-приложение в Telegram', timeline: '14-21 рабочий день',
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
  agent: {
    id: 'agent', title: 'Личный ИИ-агент под вашу задачу', timeline: '10-14 рабочих дней',
    scope: [
      'Описание задачи агента и границ его работы',
      'Подключение к вашим данным и инструментам',
      'Сценарии и проверки: что агент делает сам, что согласует с вами',
      'Журнал действий агента',
      'Тест на реальных примерах',
      'Запуск и инструкция по работе',
    ],
  },
  implementation: {
    id: 'implementation', title: 'Внедрение ИИ в процессы', timeline: '14-21 рабочий день',
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
    id: 'site', title: 'Сайт', timeline: '7-10 рабочих дней',
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

const PRICE: Record<DirectionId, () => { from: number; monthly?: number }> = {
  admin: product('admin'),
  receptionist: product('intake'),
  automation: product('automation'),
  content,
  miniapp: product('miniapp'),
  agent: personal,
  implementation: product('aiteam'),
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
  [/агент/i, 'agent'],
  [/внедрен/i, 'implementation'],
  [/контент|smm|посты/i, 'content'],
  [/автоматиз|таблиц|crm|интеграц/i, 'automation'],
  [/сайт|лендинг|landing|интернет-магазин/i, 'site'],
  [/бот|запис|администратор/i, 'admin'],
];

export function guessDirection(parts: { source?: string; service?: string; text?: string }): DirectionId {
  if (parts.source && isDirectionId(parts.source)) return parts.source;
  const text = parts.text ?? '';
  for (const [re, id] of KEYWORDS) if (re.test(text)) return id;
  return (parts.service && SERVICE[parts.service]) || 'admin';
}
