import type { BotCommand } from '@fir/core';

/**
 * The one list of the owner's commands. `/help`, the bot menu (`setMyCommands`, at most 20 entries), the handlers the bot
 * registers and the Director's passthrough routes are all made from it, so a command cannot be in the help and dead in the
 * code, or alive in the code and missing from the help (tests: `commands.test.ts`). Everything is in Russian.
 */
export type CommandRoute = 'director' | 'sales' | 'support' | 'production' | 'backoffice' | 'marketing';
export type CommandGroup = 'daily' | 'more' | 'sales' | 'support' | 'production' | 'backoffice' | 'marketing' | 'system';

export interface CommandSpec {
  name: string;
  /** Who runs it: the Director itself or a head (the Director passes the text through as it is). */
  route: CommandRoute;
  group: CommandGroup;
  /** Arguments as they are written in the help, plain text (`<id>`); escaped when the HTML is built. */
  args?: string;
  /** What it does, one short Russian phrase for `/help`. */
  help: string;
  /** Present: the command is in the bot menu (Telegram shows it with this description). At most 20 such commands. */
  menu?: string;
}

export const MENU_LIMIT = 20;

export const COMMANDS: CommandSpec[] = [
  { name: 'start', route: 'director', group: 'system', help: 'меню и кнопки внизу', menu: 'Меню и кнопки внизу' },
  { name: 'help', route: 'director', group: 'system', help: 'все команды', menu: 'Все команды и подсказки' },
  { name: 'status', route: 'director', group: 'daily', help: 'кто чем занят, что ждёт вас (кнопки ведут в отделы)', menu: 'Сводка: кто чем занят, что ждёт вас' },
  { name: 'tasks', route: 'director', group: 'daily', args: '[отдел]', help: 'задачи по страницам, у каждой карточка с действиями', menu: 'Задачи по страницам, с действиями' },
  { name: 'approve', route: 'director', group: 'daily', help: 'пачка на одобрение карточками (сама приходит утром по вашему времени)', menu: 'Одобрения: карточки с кнопками' },
  { name: 'depts', route: 'director', group: 'daily', help: 'отделы, пауза и возобновление кнопкой', menu: 'Отделы: пауза, задачи отдела' },
  { name: 'retry', route: 'director', group: 'daily', args: '<id>', help: 'повторить застрявшую задачу (или 🔁 в карточке задачи)', menu: '<id> повторить застрявшую задачу' },
  { name: 'desk', route: 'director', group: 'daily', help: 'я за столом: всё копится на сайте firtech.pro/admin', menu: 'Я за столом: всё на сайт firtech.pro/admin' },
  { name: 'away', route: 'director', group: 'daily', help: 'я в пути: всё в Telegram', menu: 'Я в пути: всё в Telegram' },
  { name: 'costs', route: 'director', group: 'more', help: 'расходы за месяц по отделам', menu: 'Расходы за месяц по отделам' },
  { name: 'org', route: 'director', group: 'more', help: 'оргструктура и доверие', menu: 'Оргструктура и доверие' },
  { name: 'workers', route: 'director', group: 'more', help: '19 исполнителей и что запускает каждого: рутина, команда или событие', menu: 'Исполнители и что их запускает' },
  { name: 'level', route: 'director', group: 'more', args: '[<тип|агент> <0|1>]', help: 'уровни доверия: 0 жду кнопку, 1 делаю сам и отчитываюсь', menu: '<тип|агент> <0|1>: уровень доверия' },
  { name: 'pause', route: 'director', group: 'more', args: '<отдел>', help: 'поставить отдел на паузу' },
  { name: 'resume', route: 'director', group: 'more', args: '<отдел>', help: 'вернуть отдел в работу' },
  { name: 'kp', route: 'sales', group: 'sales', args: '<лид или описание>', help: 'КП по лиду вручную (по готовому лиду оно делается само: КП, договор и счёт 50% одной цепочкой)', menu: 'Продажи: КП по лиду; /reply ответ бизнесу' },
  { name: 'reply', route: 'director', group: 'sales', args: '<id>', help: 'бизнес ответил на сообщение Разведчика (номер из карточки)' },
  { name: 'referral', route: 'sales', group: 'sales', args: '<клиент> -> <новый лид>', help: 'записать рекомендацию' },
  { name: 'referrals', route: 'sales', group: 'sales', help: 'рекомендации и выплаты, которые ждут оплаты' },
  { name: 'ticket', route: 'support', group: 'support', args: '<клиент>: <вопрос>', help: 'тикет клиента' },
  { name: 'tickets', route: 'support', group: 'support', help: 'открытые тикеты', menu: 'Сопровождение: тикеты, /invoices счета' },
  { name: 'client', route: 'support', group: 'support', args: 'Имя | контакт | продукт | тариф | с даты', help: 'записать клиента' },
  { name: 'clients', route: 'support', group: 'support', help: 'список клиентов' },
  { name: 'invoice', route: 'support', group: 'support', args: '<клиент> <сумма USD> <за что> [new]', help: 'счёт вручную (по КП он делается сам)' },
  { name: 'invoices', route: 'support', group: 'support', help: 'неоплаченные счета и подписки' },
  { name: 'sub', route: 'support', group: 'support', args: '<клиент> <сумма> <month|year> <способ> <дата>', help: 'подписка на сопровождение' },
  { name: 'onboard', route: 'support', group: 'support', args: '<клиент> [: продукт]', help: 'онбординг нового клиента' },
  { name: 'paid', route: 'support', group: 'support', args: '<номер счёта>', help: 'счёт оплачен: стартует проект, онбординг и выплата рекомендателю' },
  { name: 'project', route: 'production', group: 'production', args: '<клиент>: <что делаем>', help: 'проект вручную (по КП он стартует сам после оплаты)', menu: 'Производство: проект из КП' },
  { name: 'pstatus', route: 'production', group: 'production', args: '<проект>', help: 'черновик статуса клиенту' },
  { name: 'target', route: 'production', group: 'production', args: '<проект> <куда деплоим>', help: 'цель деплоя проекта' },
  { name: 'mdone', route: 'production', group: 'production', args: '<проект> <этап>', help: 'закрыть этап проекта' },
  { name: 'doc', route: 'backoffice', group: 'backoffice', args: '<тип> <клиент>', help: 'документ клиенту: договор, оферта, политика, акт', menu: 'Бэк-офис: документ клиенту, /kb поиск' },
  { name: 'lesson', route: 'backoffice', group: 'backoffice', args: '<проект>: <урок>', help: 'записать урок из проекта' },
  { name: 'kb', route: 'backoffice', group: 'backoffice', args: '<запрос>', help: 'поиск по базе знаний' },
  { name: 'playbook', route: 'backoffice', group: 'backoffice', args: '<роль>', help: 'правила роли из плейбука (контент-мейкер, публикатор, трендвотчер, seo, аналитик, продажи, строитель рендера)' },
  { name: 'profile', route: 'marketing', group: 'marketing', args: '[youtube|tiktok|instagram]', help: 'старт-кит профилей Instagram, YouTube, TikTok (один раз; без аргумента все три)', menu: 'Маркетинг: старт-кит профилей' },
  { name: 'article', route: 'marketing', group: 'marketing', args: '[ниша]', help: 'статья в блог сайта' },
  { name: 'render', route: 'marketing', group: 'marketing', args: '<id>', help: 'собрать видео рилса заново' },
  { name: 'builders', route: 'director', group: 'system', help: 'задачи строителям (Claude Code)', menu: 'Задачи строителям (Claude Code)' },
  { name: 'builder', route: 'director', group: 'system', args: '<id>', help: 'передать задачу строителю' },
  { name: 'topics', route: 'director', group: 'system', help: 'создать темы в группе HQ' },
  { name: 'drill', route: 'director', group: 'system', args: '[отдел|report|clear]', help: 'учения: проверить все отделы', menu: 'Учения: проверить все отделы' },
  { name: 'skip', route: 'director', group: 'system', help: 'отменить ожидание правки' },
];

export const COMMAND_NAMES: string[] = COMMANDS.map((c) => c.name);

/** Commands a head runs: `route` tells which head (the Director registers them in `director.commands` / the passthrough hooks). */
export const routedTo = (route: CommandRoute): string[] => COMMANDS.filter((c) => c.route === route).map((c) => c.name);

/** The bot menu: the commands with a description, in this order, at most 20. */
export const DIRECTOR_MENU: BotCommand[] = COMMANDS.filter((c) => c.menu).map((c) => ({ command: c.name, description: c.menu! }));

const GROUP_TITLE: Record<'daily' | 'more' | 'sales' | 'support' | 'work' | 'system', string> = {
  daily: 'Каждый день', more: 'Ещё', sales: 'Продажи', support: 'Сопровождение', work: 'Производство, документы, маркетинг', system: 'Служебные',
};
const htmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const line = (c: CommandSpec) => `/${c.name}${c.args ? ` ${htmlEsc(c.args)}` : ''}: ${htmlEsc(c.help)}`;

/** The text of `/help` (Telegram HTML), made from the command list: nothing to forget, nothing dead. */
export function helpHtml(): string {
  const by = (...g: CommandGroup[]) => COMMANDS.filter((c) => g.includes(c.group) && c.name !== 'start' && c.name !== 'help');
  const section = (key: keyof typeof GROUP_TITLE, list: CommandSpec[]) => (list.length ? ['', `<b>${GROUP_TITLE[key]}</b>`, ...list.map(line)] : []);
  return [
    '🆘 <b>Директор Fir Tech</b>',
    'Пишите задачу обычным текстом: передам отделу и буду править одно сообщение по ходу работы (взял, делает, ждёт вас, готово). Кнопки внизу: одобрения, задачи, статус, отделы, помощь.',
    'Куда что приходит: ответы, карточки на одобрение и «живые» сообщения о задачах здесь, в личке. Отчёты отделов и сводки в группе HQ по темам.',
    'Ваше время (Куала-Лумпур): сводка, пачка на одобрение, недельный дайджест и тихие часы. Рынок и клиенты (Душанбе): часы клиентского бота, слоты звонков, время публикаций.',
    ...section('daily', by('daily')),
    ...section('more', by('more')),
    ...section('sales', by('sales')),
    ...section('support', by('support')),
    ...section('work', by('production', 'backoffice', 'marketing')),
    ...section('system', by('system')),
    '',
    '<i>Статусы на сайте офиса: работает, ждёт (ответ за вами), застрял (/retry), спит (ночь или тихие часы), офлайн.</i>',
  ].join('\n');
}
