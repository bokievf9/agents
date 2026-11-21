/** On-screen text and voice lines of the launch film. Content only from the site facts; the only number is «24/7». */
export type Lang = 'ru' | 'en';

export const PRODUCT_IDS = ['bot', 'intake', 'automation', 'content', 'miniapp', 'agent', 'department'] as const;
export type ProductId = (typeof PRODUCT_IDS)[number];
/** Every id that can carry a voice line (one section of `scripts/launch-<lang>.txt` each). */
export const VO_IDS = ['hook', 'problem', ...PRODUCT_IDS, 'office', 'cta', 'teaser-cta'] as const;
export type VoId = (typeof VO_IDS)[number];

export interface LaunchCopy {
  hook: { big: string; l1: string; l2: string };
  problem: { chat: string; unread: string; lines: [string, string, string] };
  title: Record<ProductId, string>;
  ui: {
    bot: { name: string; ask: string; reply: string; slots: [string, string, string]; done: string };
    intake: { head: string; fields: [string, string][]; sent: string };
    automation: { nodes: [string, string, string] };
    content: { week: string; published: string };
    miniapp: { app: string; items: [string, string, string]; button: string; toast: string; inside: string };
    agent: { name: string; tasks: [string, string, string, string]; done: string };
    department: { boss: string; roles: [string, string, string, string] };
  };
  office: { title: string; label: string };
  cta: { button: string; url: string; chips: [string, string, string, string] };
  vo: Record<VoId, string>;
}

export const COPY: Record<Lang, LaunchCopy> = {
  ru: {
    hook: { big: '24/7', l1: 'ИИ-агенты', l2: 'вместо сотрудника' },
    problem: { chat: 'Здравствуйте! Можно записаться?', unread: 'Без ответа', lines: ['Заявка пришла ночью.', 'Ответа нет.', 'Клиент ушёл.'] },
    title: { bot: 'ИИ-администратор', intake: 'ИИ-менеджер заявок', automation: 'Автоматизация процессов', content: 'Контент на автопилоте', miniapp: 'Telegram Mini App', agent: 'Персональный ИИ-ассистент', department: 'ИИ-отдел под ключ' },
    ui: {
      bot: { name: 'Администратор', ask: 'Хочу записаться на завтра', reply: 'Есть свободное время. Выберите:', slots: ['Утро', 'День', 'Вечер'], done: 'Записал вас' },
      intake: { head: 'Новая заявка', fields: [['Имя', 'Анна'], ['Задача', 'Сайт для студии'], ['Контакт', '@anna']], sent: 'Менеджер получил заявку' },
      automation: { nodes: ['Заявка', 'Таблица', 'Сообщение в Telegram'] },
      content: { week: 'План на неделю', published: 'Опубликовано' },
      miniapp: { app: 'Каталог', items: ['Товар', 'Товар', 'Товар'], button: 'Заказать', toast: 'Заказ принят', inside: 'внутри Telegram' },
      agent: { name: 'Личный агент', tasks: ['Почта', 'Календарь', 'Напоминания', 'Отчёт'], done: 'готово' },
      department: { boss: 'Директор', roles: ['Маркетинг', 'Заявки', 'Поддержка', 'Отчёты'] },
    },
    office: { title: 'Живой офис', label: 'наш собственный офис' },
    cta: { button: 'Собрать в конструкторе', url: 'firtech.pro', chips: ['Цена сразу', 'Согласования в Telegram', 'Гарантия на первом этапе', 'Оплата в USDT'] },
    vo: {
      hook: 'ИИ-агенты вместо сотрудника.',
      problem: 'Заявка ночью. Ответа нет. Клиент ушёл.',
      bot: 'Бот записывает клиентов.',
      intake: 'Заявки ведёт ИИ-менеджер.',
      automation: 'Автоматизация берёт рутину.',
      content: 'Контент на автопилоте.',
      miniapp: 'Mini App в Telegram.',
      agent: 'Почта, календарь, напоминания.',
      department: 'Целый отдел из ИИ-агентов.',
      office: 'Наш собственный офис. Согласования приходят в Telegram.',
      cta: 'Собери в конструкторе. Гарантия на первом этапе.',
      'teaser-cta': 'Собери в конструкторе.',
    },
  },
  en: {
    hook: { big: '24/7', l1: 'AI agents', l2: 'instead of an employee' },
    problem: { chat: 'Hi! Can I book a visit?', unread: 'No reply', lines: ['A request came in at night.', 'No answer.', 'The client left.'] },
    title: { bot: 'Admin bot', intake: 'AI lead intake', automation: 'Automation', content: 'Content on autopilot', miniapp: 'Mini App', agent: 'Personal agent', department: 'A department of AI agents' },
    ui: {
      bot: { name: 'Administrator', ask: 'I want to book for tomorrow', reply: 'There is free time. Pick one:', slots: ['Morning', 'Day', 'Evening'], done: 'You are booked' },
      intake: { head: 'New request', fields: [['Name', 'Anna'], ['Task', 'Website for a studio'], ['Contact', '@anna']], sent: 'The manager got the request' },
      automation: { nodes: ['Request', 'Spreadsheet', 'Telegram message'] },
      content: { week: 'Plan for the week', published: 'Published' },
      miniapp: { app: 'Catalog', items: ['Item', 'Item', 'Item'], button: 'Order', toast: 'Order accepted', inside: 'inside Telegram' },
      agent: { name: 'Personal agent', tasks: ['Mail', 'Calendar', 'Reminders', 'Report'], done: 'done' },
      department: { boss: 'Director', roles: ['Marketing', 'Requests', 'Support', 'Reports'] },
    },
    office: { title: 'The live office', label: 'our own office' },
    cta: { button: 'Build it in the builder', url: 'firtech.pro', chips: ['Instant price', 'Approvals in Telegram', 'First-stage guarantee', 'Pay in USDT'] },
    vo: {
      hook: 'AI agents instead of an employee.',
      problem: 'A request at night. No answer. The client left.',
      bot: 'The bot books your clients.',
      intake: 'The intake collects requests.',
      automation: 'Automation takes the routine.',
      content: 'Content on autopilot.',
      miniapp: 'A Mini App in Telegram.',
      agent: 'Mail, calendar, reminders.',
      department: 'A whole department of AI agents.',
      office: 'Our own office. Approvals come to Telegram.',
      cta: 'Build it in the builder. A first-stage guarantee.',
      'teaser-cta': 'Build it in the builder.',
    },
  },
};

/** Text as the voice should say it (Piper stumbles on «24/7», «ИИ», latin brand words). */
export function launchSpeakable(text: string, lang: Lang): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (lang === 'ru')
    return t
      .replace(/24\/7/g, 'двадцать четыре на семь')
      .replace(/ИИ-?/g, 'и-и ')
      .replace(/Mini App/gi, 'мини эп')
      .replace(/Telegram/gi, 'телеграм')
      .replace(/USDT/g, 'ю эс ди ти')
      .replace(/firtech\.pro/gi, 'фир тек точка про')
      .replace(/\s+/g, ' ');
  return t.replace(/24\/7/g, 'twenty-four seven').replace(/firtech\.pro/gi, 'fir tech dot pro');
}

/** `# id` sections of a script file (`scripts/launch-<lang>.txt`) into id to line. */
export function parseLaunchScript(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let id: string | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const m = /^#\s*([\w-]+)\s*$/.exec(line);
    if (m) {
      id = m[1]!;
      out[id] = '';
    } else if (id && line) out[id] = out[id] ? `${out[id]} ${line}` : line;
  }
  return out;
}
