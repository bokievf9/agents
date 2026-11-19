import { DIRECTIONS, type Direction } from './directions.js';
import { PRODUCTS, TOPIC_NICHES } from './niches.js';

export const ANGLES = {
  how: 'как это работает: механика на одном конкретном примере',
  price: 'сколько стоит и что входит (цена только из справки)',
  before_after: 'было, стало: пример сценария, обязательно с подписью «Пример сценария», без цифр результата',
  demo: 'показ в работе на примерных данных, с подписью «Демо на примерных данных»',
  client_mistake: 'ошибка клиента: типичная ошибка владельца бизнеса в этой рутине и как её закрывает агент, без цифр результата',
  fact: 'цифра дня: один факт из справки (цена, срок или что входит) как главная мысль ролика, без выдуманной статистики',
} as const;
export type AngleId = keyof typeof ANGLES;

export interface Topic {
  /** Unique key for the history: `<direction>:<angle>` or `free:<slug>`. */
  key: string;
  directionId: Direction['id'] | null;
  text: string;
}

export const REPEAT_WINDOW_DAYS = 42; // six weeks
/**
 * Pool size: 8 directions x 6 angles = 48 topics. A pack is 7 clips plus a carousel every other week, so on
 * average 7.5 topics a week: 48 / 7.5 = 6.4 weeks before the first topic comes back, which covers the six-week
 * window (6 weeks use 45 topics). Raising CLIPS_PER_WEEK or CAROUSELS_PER_WEEK needs more angles or directions.
 */
const DAY = 86_400_000;

export const ALL_TOPICS: Topic[] = DIRECTIONS.flatMap((d) =>
  (Object.keys(ANGLES) as AngleId[]).map((a) => ({ key: `${d.id}:${a}`, directionId: d.id, text: `${d.name}: ${ANGLES[a]}` })),
);

export function freeTopic(text: string): Topic {
  const slug = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40);
  return { key: `free:${slug}`, directionId: null, text };
}

/** `used` maps topic key to the last time it was used (ms). */
export type History = Map<string, number>;

/**
 * Picks `count` topics: different directions inside one pack, never a key used within the last six weeks
 * (when everything is used up, falls back to the least recently used). Directions are taken in the order of
 * their last use, oldest first, so all eight rotate evenly.
 */
export function pickTopics(history: History, count: number, now: number, rng: () => number = Math.random): Topic[] {
  const lastKeyUse = (k: string) => history.get(k) ?? 0;
  const lastDirUse = (id: string) => Math.max(0, ...ALL_TOPICS.filter((t) => t.directionId === id).map((t) => lastKeyUse(t.key)));
  const fresh = (t: Topic) => now - lastKeyUse(t.key) >= REPEAT_WINDOW_DAYS * DAY;
  const dirs = DIRECTIONS.map((d) => d.id).sort((a, b) => lastDirUse(a) - lastDirUse(b) || (a < b ? -1 : 1));
  const picked: Topic[] = [];
  for (let i = 0; picked.length < count; i++) {
    const id = dirs[i % dirs.length]!;
    const own = ALL_TOPICS.filter((t) => t.directionId === id && !picked.includes(t));
    const pool = own.filter(fresh);
    if (pool.length > 0) picked.push(pool[Math.floor(rng() * pool.length)]!);
    else if (i >= dirs.length * 2 || own.length === 0) {
      // Everything is used up: least recently used key overall.
      const rest = ALL_TOPICS.filter((t) => !picked.includes(t)).sort((a, b) => lastKeyUse(a.key) - lastKeyUse(b.key));
      picked.push(rest[0]!);
    }
  }
  return picked;
}

// ---- posts and stories: a format over a product or a business niche ----
export const FORMATS = {
  scenario: 'кейс-сценарий «до и после»: придуманная ситуация, обязательно с подписью «Пример сценария», это не реальный клиент и без цифр результата',
  mistake: 'разбор ошибки: типичная ошибка владельца бизнеса в этой рутине и как её закрывает агент, без цифр результата',
  checklist: 'чеклист: 4-5 коротких пунктов, которые владелец проверит у себя за минуту, без цифр результата',
  faq: 'частый вопрос владельца и прямой ответ по механике, без цифр результата',
} as const;
export type FormatId = keyof typeof FORMATS;

interface FormatTopic extends Topic {
  format: FormatId;
  subject: string;
  kind: 'product' | 'niche';
}

const subjects: { id: string; kind: 'product' | 'niche'; label: string }[] = [
  ...PRODUCTS.map((p) => ({ id: p.id, kind: 'product' as const, label: p.name })),
  ...TOPIC_NICHES.map((n) => ({ id: n.id, kind: 'niche' as const, label: `ниша «${n.name}» (что в её рутине берёт на себя бот или агент)` })),
];

/** 4 formats x (10 products + 55 niches) = 260 topics: eight a week come back after about 32 weeks. */
export const FORMAT_TOPICS: FormatTopic[] = subjects.flatMap((sub) =>
  (Object.keys(FORMATS) as FormatId[]).map((f) => ({ key: `fmt:${f}:${sub.id}`, directionId: null, text: `${sub.label}. Формат: ${FORMATS[f]}`, format: f, subject: sub.id, kind: sub.kind })),
);

/**
 * Topics for posts and stories: products and niches alternate, formats rotate inside the pack, the least recently used
 * key goes first (a topic never used counts as the oldest), one subject at most once per pack.
 */
export function pickFormatTopics(history: History, count: number, rng: () => number = Math.random): Topic[] {
  const picked: FormatTopic[] = [];
  for (let i = 0; i < count; i++) {
    const want = i % 2 === 0 ? 'product' : 'niche';
    const used = (f: FormatId) => picked.filter((p) => p.format === f).length;
    const rest = FORMAT_TOPICS.filter((t) => !picked.some((p) => p.subject === t.subject)).map((t) => ({ t, r: rng() }));
    rest.sort((a, b) => used(a.t.format) - used(b.t.format) || (history.get(a.t.key) ?? 0) - (history.get(b.t.key) ?? 0) || a.r - b.r);
    picked.push((rest.find((x) => x.t.kind === want) ?? rest[0]!).t);
  }
  return picked;
}

// ---- blog: the «ИИ для бизнеса» line and the 60-day window ----
export const ARTICLE_WINDOW_DAYS = 60;

/**
 * Evergreen themes of the «ИИ для бизнеса» line, used when Trend Scout has nothing current. A plain-language explainer of one AI
 * capability and how a small business in the CIS (salon, shop, delivery, clinic) can apply it this month. Four articles a week
 * use the 60-day window up with about 34 of them, so the list is longer than that.
 */
const AI_THEMES: [string, string][] = [
  ['assistant-24-7', 'ИИ-ассистент в мессенджере отвечает клиентам ночью и в выходные'],
  ['voice-messages', 'Голосовые сообщения клиентов: ИИ превращает их в текст и заявку'],
  ['photo-requests', 'Клиент присылает фото, а ИИ понимает, что ему нужно: ремонт, меню, заказ'],
  ['faq-from-chats', 'Как собрать базу ответов из старой переписки и не писать её вручную'],
  ['booking-reminders', 'Умные напоминания о записи, которые снижают неявки'],
  ['review-replies', 'Ответы на отзывы на картах и в соцсетях: черновик от ИИ, решение за владельцем'],
  ['product-cards', 'Описания товаров для магазина за вечер вместо месяца'],
  ['menu-translate', 'Перевод меню и прайса на русский, узбекский, таджикский и английский'],
  ['daily-report', 'Утренняя сводка владельцу: что произошло вчера, одним сообщением'],
  ['lead-scoring', 'Какие заявки горячие: ИИ расставляет приоритет входящим'],
  ['follow-up', 'Дожим без навязчивости: ИИ напоминает клиенту о незакрытой заявке'],
  ['invoices-docs', 'Счета, акты и договоры из шаблона за минуту'],
  ['inventory-alerts', 'Остатки на складе: ИИ предупреждает, что заканчивается ходовой товар'],
  ['staff-onboarding', 'Обучение нового сотрудника: ИИ-наставник отвечает на вопросы по регламенту'],
  ['social-posts', 'Контент-план и посты для соцсетей: что отдать ИИ, а что оставить себе'],
  ['short-video', 'Короткие видео для Instagram и Reels без съёмочной группы'],
  ['google-maps', 'Карточка на картах: ИИ помогает с описанием, ответами и обновлениями'],
  ['price-questions', 'Вопрос «сколько стоит»: как бот отвечает точно и не придумывает цены'],
  ['no-show', 'Неявки и отмены: как ИИ заполняет освободившиеся окна'],
  ['call-notes', 'Расшифровка звонков: ИИ записывает, о чём договорились с клиентом'],
  ['email-sorting', 'Входящая почта и заявки: ИИ сортирует и готовит ответы'],
  ['table-data', 'Таблица продаж: задайте вопрос обычными словами и получите ответ'],
  ['ai-agents', 'ИИ-агент и чат-бот: в чём разница и что нужно малому бизнесу'],
  ['privacy', 'Данные клиентов и ИИ: что можно отправлять в модель, а что нельзя'],
  ['mistakes', 'Почему ИИ иногда ошибается и как построить проверку человеком'],
  ['start-small', 'С какой одной задачи начать внедрение ИИ в маленьком бизнесе'],
  ['measure', 'Как понять, что ИИ окупается: что считать за месяц без сложной аналитики'],
  ['local-language', 'ИИ и местные языки: что уже работает в узбекском, таджикском и казахском'],
  ['payments-bot', 'Приём оплаты в чате: от ссылки на оплату до подтверждения'],
  ['catalog-search', 'Поиск по каталогу обычными словами: «что-нибудь недорогое на подарок»'],
  ['delivery-status', 'Статус заказа без звонков: бот сообщает, где курьер'],
  ['clinic-intake', 'Предварительная запись в клинику: ИИ собирает жалобы и подбирает врача, не ставя диагноз'],
  ['loyalty', 'Программа лояльности без приложения: баллы и напоминания в мессенджере'],
  ['seasonal', 'Сезонные акции: ИИ готовит рассылку и текст под ваш сезон'],
  ['competitor-watch', 'Мониторинг конкурентов: ИИ следит за ценами и новостями'],
  ['vision-checks', 'Проверка по фото: чеки, документы, состояние товара'],
  ['agents-team', 'Команда из нескольких ИИ-помощников: кто чем занимается'],
  ['ai-search', 'Как клиенты ищут вас через ИИ-поиск и что поправить на сайте'],
  ['small-model-cost', 'Почему ИИ в бизнесе дешевле, чем кажется: из чего складываются расходы'],
  ['human-handoff', 'Когда бот зовёт человека: как настроить передачу диалога менеджеру'],
];

export const AI_TOPICS: Topic[] = AI_THEMES.map(([id, text]) => ({ key: `ai:${id}`, directionId: null, text }));

/** `used` maps a topic key to the last time it was used (ms). */
export function freshWindowMs(days = ARTICLE_WINDOW_DAYS): number {
  return days * DAY;
}

/**
 * A topic of the «ИИ для бизнеса» line that was not used in the last 60 days; when all are used the least recently used one.
 * `rng` breaks ties among never-used topics.
 */
export function pickAiTopic(used: Map<string, number>, now: number, rng: () => number = Math.random): Topic {
  const age = (t: Topic) => used.get(t.key) ?? 0;
  const fresh = AI_TOPICS.filter((t) => now - age(t) >= freshWindowMs());
  if (fresh.length > 0) {
    const never = fresh.filter((t) => age(t) === 0);
    const pool = never.length > 0 ? never : fresh.sort((a, b) => age(a) - age(b)).slice(0, 5);
    return pool[Math.floor(rng() * pool.length)]!;
  }
  return [...AI_TOPICS].sort((a, b) => age(a) - age(b))[0]!;
}
