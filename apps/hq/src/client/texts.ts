import type { Button } from '@fir/core';
import { isCatalogueId, KIND_LABELS, PRODUCT_IDS, PRODUCTS, PUBLIC_PRICES, type CatalogueId } from './products.js';

export type Lang = 'ru' | 'en';

/** HTML parse mode: everything that is not ours (names, client or LLM text) goes through this. */
export const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Intake choices: the key travels in callback data, the label is what the person and the lead card see. */
/** Intake step 1: the seven products, the classics and «other». `bot` and `app` stay valid keys (old buttons) but are not offered. */
export const NEED_BUTTONS = ['admin', 'receptionist', 'automation', 'content', 'miniapp', 'agent', 'ai', 'site', 'other'] as const;
export const NEEDS = [...NEED_BUTTONS, 'bot', 'app'] as const;
export const DEADLINES = ['urgent', 'month', 'norush'] as const;
export const BUDGETS = ['lt300', 'mid', 'gt1000', 'unknown'] as const;
export type Need = (typeof NEEDS)[number];
export type Deadline = (typeof DEADLINES)[number];
export type Budget = (typeof BUDGETS)[number];

/** `service` of the lead (same values as the site form). */
export const SERVICE: Record<Need, string> = {
  site: 'web', bot: 'bots', app: 'app', automation: 'automation', other: 'other',
  admin: 'bots', receptionist: 'bots', content: 'other', miniapp: 'app', agent: 'bots', ai: 'automation',
};

/** The catalogue name of a chosen need in Russian (the lead's `product` field), empty for «other». */
export const productOf = (need: Need | undefined): string => (need && isCatalogueId(need) ? PRODUCTS[need].name.ru : '');

interface Texts {
  welcome(name: string): string;
  menu: { discuss: string; products: string; client: string; human: string; lang: string; demo: string };
  productsTitle: string;
  productsIntro: string;
  card: { forWhom: string; inside: string; pairs: string; demo: string; discuss: string; back: string };
  need: Record<Need, string>;
  needLabel: Record<Need, string>;
  deadline: Record<Deadline, string>;
  deadlineLabel: Record<Deadline, string>;
  budget: Record<Budget, string>;
  step1: string;
  step1Text: string;
  step2: string;
  step3: string;
  done(need: string, deadline: string, budget: string): string;
  doneNight: string;
  askClient: string;
  askQuestion: string;
  ticketAck(night: boolean): string;
  clientLeadAck(night: boolean): string;
  human(night: boolean): string;
  humanAlready: string;
  priceAnswer: string;
  night: string;
  fallback: string;
  textOnly: string;
  slow: string;
  slotPicked(slot: string): string;
  help: string;
  stale: string;
  priceNote: string;
  langSwitched: string;
}

/** Labels for every need key: the catalogue names for products, `extra` for site, other and the old bot and app keys. */
function needLabels(lang: 'ru' | 'en', extra: Record<'site' | 'other' | 'bot' | 'app', string>, emoji = true): Record<Need, string> {
  const out = { ...extra } as Record<string, string>;
  for (const id of PRODUCT_IDS) out[id] = emoji ? `${PRODUCTS[id].emoji} ${SHORT[lang][id]}` : PRODUCTS[id].name[lang];
  return out as Record<Need, string>;
}

/** Shorter button labels of the products (the full names are on the cards). */
const SHORT: Record<'ru' | 'en', Record<string, string>> = {
  ru: { admin: 'Бот-администратор', receptionist: 'ИИ-приёмщик заявок', automation: 'Автоматизация', content: 'Контент по подписке', miniapp: 'Mini App', agent: 'Личный агент', ai: 'ИИ в компанию' },
  en: { admin: 'Booking bot', receptionist: 'AI request handler', automation: 'Automation', content: 'Content subscription', miniapp: 'Mini App', agent: 'Personal agent', ai: 'AI for company' },
};

const RU: Texts = {
  welcome: (name) =>
    `<b>Fir Tech</b>\nЗдравствуйте${name ? `, ${esc(name)}` : ''}. Строим бота-администратора для записи, ИИ-приёмщика заявок, автоматизацию, Mini Apps, личных агентов и внедряем ИИ в компании.\n\n` +
    'Наши собственные боты работают каждый день: Dono ведёт учёбу студента, Polly учит языкам. Этот чат тоже наша работа: так выглядит ИИ-приёмщик заявок.\n\nЧем помочь?',
  menu: { discuss: '💬 Обсудить проект', products: '🧩 Продукты', client: '🧾 Я уже клиент', human: '👤 Позвать человека', lang: '🇬🇧 English', demo: '🧪 Попробовать демо' },
  productsTitle: '<b>Продукты Fir Tech</b>',
  productsIntro: 'Выберите, что интересно: расскажу, для кого это и что внутри.',
  card: { forWhom: 'Для кого', inside: 'Что внутри', pairs: 'Обычно берут вместе с', demo: 'Посмотреть', discuss: '💬 Обсудить', back: '← Все продукты' },
  need: needLabels('ru', { site: '🌐 Сайт', other: '✏️ Другое', bot: '🤖 Telegram-бот', app: '📱 Приложение' }),
  needLabel: needLabels('ru', { site: 'сайт', other: 'другое', bot: 'Telegram-бот', app: 'приложение' }, false),
  deadline: { urgent: '⚡ Срочно', month: '📅 В этом месяце', norush: '🕊 Не горит' },
  deadlineLabel: { urgent: 'срочно', month: 'в этом месяце', norush: 'не горит' },
  budget: { lt300: 'до $300', mid: '$300–1000', gt1000: '$1000+', unknown: 'Пока не знаю' },
  step1: '<b>Новый проект · 1 из 3</b>\nЧто нужно сделать?\n\nВыберите вариант или опишите задачу своими словами.',
  step1Text: '<b>Новый проект · 1 из 3</b>\nОпишите задачу одним сообщением: что за бизнес и что должно получиться.',
  step2: '<b>Новый проект · 2 из 3</b>\nКогда нужно запустить?',
  step3: '<b>Новый проект · 3 из 3</b>\nНа какой бюджет ориентируетесь?\n\nЭто поможет предложить подходящее решение, а не самое дорогое.',
  done: (need, deadline, budget) =>
    `<b>Готово, заявка принята</b>\nЗадача: ${esc(need)}\nСрок: ${esc(deadline)}\nБюджет: ${esc(budget)}\n\nМы вернёмся с предложением в течение рабочего дня. Ответ придёт сюда, в этот чат.`,
  doneNight: 'Сейчас у нас ночь, поэтому ответ придёт утром.',
  askClient: '<b>Вы уже с нами</b>\nНапишите название компании или номер счёта, например FT-2026-001.',
  askQuestion: 'Спасибо. Теперь опишите вопрос одним сообщением.',
  ticketAck: (night) => `<b>Приняли</b>\nОтветим в течение часа в рабочее время.${night ? ' Сейчас ночь, поэтому ответ придёт утром.' : ''}`,
  clientLeadAck: (night) => `<b>Приняли</b>\nПередали команде, ответим здесь в течение рабочего дня.${night ? ' Сейчас ночь, поэтому ответ придёт утром.' : ''}`,
  human: (night) =>
    `<b>Зову человека</b>\n${night ? 'Сейчас ночь, команда ответит утром, здесь же.' : 'Ответим здесь же, обычно в течение часа в рабочее время.'} Пока можно писать дальше: всё передам.`,
  humanAlready: 'Человек уже в курсе и ответит здесь. Всё, что вы пишете, я передаю.',
  priceAnswer:
    '<b>Про стоимость</b>\nСчитаем под задачу: многое зависит от того, что именно должно уметь решение. Ответьте на три коротких вопроса, и мы вернёмся с предложением и ценой в течение рабочего дня.',
  night: '<b>Сообщение у команды</b>\nСейчас у нас ночь, человек ответит утром, здесь же. Если хотите, оставьте заявку: это три коротких вопроса.',
  fallback: '<b>Передал команде</b>\nОтвечу точнее, когда уточню у коллег. Ответ придёт сюда, в этот чат.',
  textOnly: 'Пока читаю только текст. Напишите, пожалуйста, словами.',
  slow: 'Сообщений много, я передал разговор команде. Человек ответит здесь.',
  slotPicked: (slot) => `<b>Записал звонок</b>\n${esc(slot)}. Подтвердим время здесь, в этом чате.`,
  help:
    '<b>Что умеет этот бот</b>\n/start: начало и меню\n/demo: демо бота-администратора для салона\n/audit &lt;сайт&gt;: бесплатный аудит за 24 часа\n/human: позвать человека\n/lang: English\n\nМожно просто написать вопрос: отвечу сразу или передам команде.',
  stale: 'Уже неактуально',
  priceNote: 'Стоимость и сроки назовём после короткого разговора с командой.',
  langSwitched: 'Русский',
};

const EN: Texts = {
  welcome: (name) =>
    `<b>Fir Tech</b>\nHello${name ? `, ${esc(name)}` : ''}. We build a booking assistant bot, an AI request handler, automation, Mini Apps and personal agents, and bring AI into companies.\n\n` +
    'Our own bots work every day: Dono runs a student’s studies, Polly teaches languages. This chat is our work too: this is what an AI request handler looks like.\n\nHow can we help?',
  menu: { discuss: '💬 Discuss a project', products: '🧩 Products', client: '🧾 I am a client', human: '👤 Talk to a person', lang: '🇷🇺 Русский', demo: '🧪 Try the demo' },
  productsTitle: '<b>Fir Tech products</b>',
  productsIntro: 'Pick what interests you: I will tell you who it is for and what is inside.',
  card: { forWhom: 'Who it is for', inside: 'What is inside', pairs: 'Usually taken together with', demo: 'See it', discuss: '💬 Discuss', back: '← All products' },
  need: needLabels('en', { site: '🌐 Website', other: '✏️ Something else', bot: '🤖 Telegram bot', app: '📱 App' }),
  needLabel: needLabels('en', { site: 'website', other: 'something else', bot: 'Telegram bot', app: 'app' }, false),
  deadline: { urgent: '⚡ Urgent', month: '📅 This month', norush: '🕊 No rush' },
  deadlineLabel: { urgent: 'urgent', month: 'this month', norush: 'no rush' },
  budget: { lt300: 'under $300', mid: '$300–1000', gt1000: '$1000+', unknown: 'Not sure yet' },
  step1: '<b>New project · 1 of 3</b>\nWhat do you need?\n\nPick an option or describe the task in your own words.',
  step1Text: '<b>New project · 1 of 3</b>\nDescribe the task in one message: what the business is and what should come out of it.',
  step2: '<b>New project · 2 of 3</b>\nWhen do you need it live?',
  step3: '<b>New project · 3 of 3</b>\nWhat budget do you have in mind?\n\nIt helps us suggest the right solution, not the most expensive one.',
  done: (need, deadline, budget) =>
    `<b>Done, request received</b>\nTask: ${esc(need)}\nTiming: ${esc(deadline)}\nBudget: ${esc(budget)}\n\nWe will come back with a proposal within one working day. The answer will arrive here, in this chat.`,
  doneNight: 'It is night here now, so the answer will come in the morning.',
  askClient: '<b>Welcome back</b>\nPlease send your company name or invoice number, for example FT-2026-001.',
  askQuestion: 'Thank you. Now describe your question in one message.',
  ticketAck: (night) => `<b>Got it</b>\nWe will answer within an hour during working hours.${night ? ' It is night here now, so the answer will come in the morning.' : ''}`,
  clientLeadAck: (night) => `<b>Got it</b>\nPassed to the team, we will answer here within one working day.${night ? ' It is night here now, so the answer will come in the morning.' : ''}`,
  human: (night) =>
    `<b>Calling a person</b>\n${night ? 'It is night here, the team will answer in the morning, right here.' : 'We will answer right here, usually within an hour during working hours.'} Feel free to keep writing: I pass everything on.`,
  humanAlready: 'A person already knows and will answer here. I pass on everything you write.',
  priceAnswer:
    '<b>About the price</b>\nWe price each task separately: a lot depends on what exactly the solution should do. Answer three short questions and we will come back with a proposal and a price within one working day.',
  night: '<b>Message is with the team</b>\nIt is night here now, a person will answer in the morning, right here. If you like, leave a request: it is three short questions.',
  fallback: '<b>Passed to the team</b>\nI will answer more precisely once I check with my colleagues. The answer will arrive here, in this chat.',
  textOnly: 'For now I only read text. Please write it in words.',
  slow: 'That is a lot of messages, so I passed the conversation to the team. A person will answer here.',
  slotPicked: (slot) => `<b>Call noted</b>\n${esc(slot)}. We will confirm the time here, in this chat.`,
  help:
    '<b>What this bot does</b>\n/start: start and menu\n/demo: demo of the booking bot for a salon\n/audit &lt;site&gt;: free audit within 24 hours\n/human: talk to a person\n/lang: Русский\n\nYou can also just type a question: I answer right away or pass it to the team.',
  stale: 'No longer relevant',
  priceNote: 'We will name the price and timing after a short talk with the team.',
  langSwitched: 'English',
};

export const T: Record<Lang, Texts> = { ru: RU, en: EN };

export const menuButtons = (lang: Lang): Button[][] => {
  const m = T[lang].menu;
  return [
    [{ text: m.discuss, data: 'm:discuss' }, { text: m.products, data: 'm:products' }],
    [{ text: m.client, data: 'm:client' }, { text: m.human, data: 'm:human' }],
    [{ text: m.demo, data: 'm:demo' }],
    [{ text: m.lang, data: 'm:lang' }],
  ];
};

export const needButtons = (lang: Lang): Button[][] => {
  const n = T[lang].need;
  const btns = NEED_BUTTONS.map((k) => ({ text: n[k], data: `n:${k}` }));
  const rows: Button[][] = [];
  for (let i = 0; i < btns.length; i += 2) rows.push(btns.slice(i, i + 2));
  return rows;
};

/** The product list: one button per product, then the classic site. */
export const productListButtons = (lang: Lang): Button[][] => [
  ...[...PRODUCT_IDS, 'site' as const].map((id) => [{ text: `${PRODUCTS[id].emoji} ${PRODUCTS[id].name[lang]}`, data: `p:${id}` }]),
];

export const productListHtml = (lang: Lang): string => `${T[lang].productsTitle}
${T[lang].productsIntro}`;

export const productCardButtons = (lang: Lang, id: CatalogueId): Button[][] => [
  [{ text: T[lang].card.discuss, data: `pd:${id}` }, { text: T[lang].card.back, data: 'm:products' }],
];

/** A product card: benefit, for whom, what is inside, the usual pairing and how to see it. */
export function productCardHtml(lang: Lang, id: CatalogueId): string {
  const p = PRODUCTS[id];
  const c = T[lang].card;
  const whom = p.kinds.map((k) => KIND_LABELS[k][lang]).join(', ');
  const pair = p.pairs.map((i) => PRODUCTS[i].name[lang]).join(', ');
  return [
    `<b>${p.emoji} ${esc(p.name[lang])}</b>`,
    esc(p.benefit[lang]),
    ...(whom ? [`\n<b>${c.forWhom}:</b> ${esc(whom)}`] : []),
    `\n<b>${c.inside}:</b>\n${p.inside[lang].map((x) => `• ${esc(x)}`).join('\n')}`,
    `\n<b>${c.pairs}:</b> ${esc(pair)}`,
    `${esc(p.demo[lang])}${id === 'agent' ? ` ${esc(PUBLIC_PRICES[lang])}` : ''}`,
  ].join('\n');
}

export const deadlineButtons = (lang: Lang): Button[][] => [DEADLINES.map((k) => ({ text: T[lang].deadline[k], data: `d:${k}` }))];

export const budgetButtons = (lang: Lang): Button[][] => {
  const b = T[lang].budget;
  return [
    [{ text: b.lt300, data: 'b:lt300' }, { text: b.mid, data: 'b:mid' }],
    [{ text: b.gt1000, data: 'b:gt1000' }, { text: b.unknown, data: 'b:unknown' }],
  ];
};

/** Bot menu commands (setMyCommands) and the profile texts (setMyDescription, setMyShortDescription). */
export const COMMANDS: Record<Lang, { command: string; description: string }[]> = {
  ru: [
    { command: 'start', description: 'Начало и меню' },
    { command: 'demo', description: 'Демо: бот-администратор для салона' },
    { command: 'audit', description: 'Бесплатный аудит сайта за 24 часа' },
    { command: 'human', description: 'Позвать человека' },
    { command: 'lang', description: 'English' },
    { command: 'help', description: 'Что умеет бот' },
  ],
  en: [
    { command: 'start', description: 'Start and menu' },
    { command: 'demo', description: 'Demo: booking bot for a salon' },
    { command: 'audit', description: 'Free site audit within 24 hours' },
    { command: 'human', description: 'Talk to a person' },
    { command: 'lang', description: 'Русский' },
    { command: 'help', description: 'What this bot does' },
  ],
};

export const OWNER_COMMANDS = [
  { command: 'chats', description: 'Последние разговоры' },
  { command: 'reply', description: '<chatId> текст: ответить клиенту' },
  { command: 'mute', description: '<chatId>: бот молчит в чате' },
  { command: 'resume', description: '<chatId>: бот снова отвечает' },
  { command: 'help', description: 'Команды владельца' },
];

export const PROFILE: Record<Lang, { short: string; description: string }> = {
  ru: {
    short: 'Fir Tech: сайты, Telegram-боты, приложения и автоматизация. Расскажите о задаче, ответим в течение рабочего дня.',
    description:
      'Здесь можно обсудить проект с Fir Tech: сайт, Telegram-бот, приложение или автоматизацию. Три коротких вопроса, и команда вернётся с предложением в течение рабочего дня.\n\nЭтот бот тоже наша работа: так выглядит ИИ-приёмщик заявок для вашего бизнеса.',
  },
  en: {
    short: 'Fir Tech: websites, Telegram bots, apps and automation. Tell us about your task, we answer within one working day.',
    description:
      'Discuss a project with Fir Tech: a website, a Telegram bot, an app or automation. Three short questions, and the team comes back with a proposal within one working day.\n\nThis bot is our work too: this is what an AI request handler for your business looks like.',
  },
};

/** Texts of the demo entry and the free audit command (the demo itself lives in `demo.ts`). */
export const X: Record<Lang, { auditUsage: string; auditOk: string; auditDup: string; auditBusy: string; auditOff: string }> = {
  ru: {
    auditUsage: 'Пришлите адрес сайта после команды, например: /audit example.com. Я разберу его и вернусь с пятью находками в течение 24 часов.',
    auditOk: '<b>Принял</b>\nРазберём сайт и пришлём пять находок и что исправить, в течение 24 часов. Ответ придёт сюда.',
    auditDup: 'Аудит для вас уже в работе, повторно не нужен: результат придёт в течение 24 часов.',
    auditBusy: 'Сегодня очень много заявок на аудит. Попробуйте чуть позже или напишите команде через /human.',
    auditOff: 'Аудит сейчас недоступен. Напишите нам через /human, сделаем вручную.',
  },
  en: {
    auditUsage: 'Send a site address after the command, for example: /audit example.com. We will review it and come back with five findings within 24 hours.',
    auditOk: '<b>Got it</b>\nWe will review the site and send five findings and what to fix within 24 hours. The answer will arrive here.',
    auditDup: 'Your audit is already in progress, no need to ask again: the result arrives within 24 hours.',
    auditBusy: 'A lot of audit requests today. Please try again a bit later or write to the team with /human.',
    auditOff: 'The audit is unavailable right now. Write to us with /human and we will do it by hand.',
  },
};
