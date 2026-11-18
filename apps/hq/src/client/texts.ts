import type { Button } from '@fir/core';

export type Lang = 'ru' | 'en';

/** HTML parse mode: everything that is not ours (names, client or LLM text) goes through this. */
export const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Intake choices: the key travels in callback data, the label is what the person and the lead card see. */
export const NEEDS = ['site', 'bot', 'app', 'automation', 'other'] as const;
export const DEADLINES = ['urgent', 'month', 'norush'] as const;
export const BUDGETS = ['lt300', 'mid', 'gt1000', 'unknown'] as const;
export type Need = (typeof NEEDS)[number];
export type Deadline = (typeof DEADLINES)[number];
export type Budget = (typeof BUDGETS)[number];

/** `service` of the lead (same values as the site form). */
export const SERVICE: Record<Need, string> = { site: 'web', bot: 'bots', app: 'app', automation: 'automation', other: 'other' };

interface Texts {
  welcome(name: string): string;
  menu: { discuss: string; client: string; human: string; lang: string };
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

const RU: Texts = {
  welcome: (name) =>
    `<b>Fir Tech</b>\nЗдравствуйте${name ? `, ${esc(name)}` : ''}. Мы делаем сайты, Telegram-ботов, приложения и автоматизацию для бизнеса.\n\n` +
    'Наши собственные боты работают каждый день: Dono ведёт учёбу студента, Polly учит языкам. Этот чат тоже наша работа: так выглядит ИИ-приёмщик заявок.\n\nЧем помочь?',
  menu: { discuss: '💬 Обсудить проект', client: '🧾 Я уже клиент', human: '👤 Позвать человека', lang: '🇬🇧 English' },
  need: { site: '🌐 Сайт', bot: '🤖 Telegram-бот', app: '📱 Приложение', automation: '⚙️ Автоматизация', other: '✏️ Другое' },
  needLabel: { site: 'сайт', bot: 'Telegram-бот', app: 'приложение', automation: 'автоматизация', other: 'другое' },
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
    '<b>Что умеет этот бот</b>\n/start: начало и меню\n/human: позвать человека\n/lang: English\n\nМожно просто написать вопрос: отвечу сразу или передам команде.',
  stale: 'Уже неактуально',
  priceNote: 'Стоимость и сроки назовём после короткого разговора с командой.',
  langSwitched: 'Русский',
};

const EN: Texts = {
  welcome: (name) =>
    `<b>Fir Tech</b>\nHello${name ? `, ${esc(name)}` : ''}. We build websites, Telegram bots, apps and automation for businesses.\n\n` +
    'Our own bots work every day: Dono runs a student’s studies, Polly teaches languages. This chat is our work too: this is what an AI request handler looks like.\n\nHow can we help?',
  menu: { discuss: '💬 Discuss a project', client: '🧾 I am a client', human: '👤 Talk to a person', lang: '🇷🇺 Русский' },
  need: { site: '🌐 Website', bot: '🤖 Telegram bot', app: '📱 App', automation: '⚙️ Automation', other: '✏️ Something else' },
  needLabel: { site: 'website', bot: 'Telegram bot', app: 'app', automation: 'automation', other: 'something else' },
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
    '<b>What this bot does</b>\n/start: start and menu\n/human: talk to a person\n/lang: Русский\n\nYou can also just type a question: I answer right away or pass it to the team.',
  stale: 'No longer relevant',
  priceNote: 'We will name the price and timing after a short talk with the team.',
  langSwitched: 'English',
};

export const T: Record<Lang, Texts> = { ru: RU, en: EN };

export const menuButtons = (lang: Lang): Button[][] => {
  const m = T[lang].menu;
  return [
    [{ text: m.discuss, data: 'm:discuss' }, { text: m.client, data: 'm:client' }],
    [{ text: m.human, data: 'm:human' }, { text: m.lang, data: 'm:lang' }],
  ];
};

export const needButtons = (lang: Lang): Button[][] => {
  const n = T[lang].need;
  return [
    [{ text: n.site, data: 'n:site' }, { text: n.bot, data: 'n:bot' }],
    [{ text: n.app, data: 'n:app' }, { text: n.automation, data: 'n:automation' }],
    [{ text: n.other, data: 'n:other' }],
  ];
};

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
    { command: 'human', description: 'Позвать человека' },
    { command: 'lang', description: 'English' },
    { command: 'help', description: 'Что умеет бот' },
  ],
  en: [
    { command: 'start', description: 'Start and menu' },
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
