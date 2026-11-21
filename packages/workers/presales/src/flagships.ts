import type { Prices } from '@fir/core';

/** The flagships' options and levels of the builder (`f.<product>.<ids>`, the site's contract): shared by the package, the estimate and the documents. */
/** The Персональный ИИ levels by the build (the site's contract): up to two services `basic`; three or four services, or a voice, `plus`; five and more services, or a long memory, `max`. */
export type PersonalLevel = 'basic' | 'plus' | 'max';
export const PERSONAL_LEVEL_RU: Record<PersonalLevel, string> = { basic: 'Старт', plus: 'Плюс', max: 'Максимум' };
export const PERSONAL_SERVICES = ['mail', 'calendar', 'tasks', 'study', 'notes', 'messengers'];
/** The services a Персональный ИИ takes when the build names none. */
export const PERSONAL_DEFAULT = ['mail', 'calendar'];
export function personalLevel(options: readonly string[]): PersonalLevel {
  const services = options.filter((o) => PERSONAL_SERVICES.includes(o)).length;
  if (services >= 5 || options.includes('memory')) return 'max';
  if (services >= 3 || options.includes('voice')) return 'plus';
  return 'basic';
}

/** Russian names of the flagship options of the builder (`f.<product>.<ids>`): only labels, never a price. */
export const FLAGSHIP_OPTION_RU: Record<string, string> = {
  mail: 'Почта', calendar: 'Календарь', tasks: 'Задачи', study: 'Учёба', notes: 'Заметки', messengers: 'Мессенджеры', voice: 'Голос', memory: 'Долгая память',
  sales: 'Продажи', marketing: 'Маркетинг', support: 'Поддержка', production: 'Производство', backoffice: 'Бэк-офис',
  pult: 'Пульт', knowledge: 'База знаний', channels: 'Каналы', training: 'Обучение команды',
};
/** The company options in the order of the site; with none named the company takes sales, the control panel, the knowledge base and training. */
export const COMPANY_OPTION_ORDER = ['sales', 'marketing', 'support', 'production', 'backoffice', 'pult', 'knowledge', 'channels', 'training'];
export const COMPANY_DEFAULT = ['sales', 'pult', 'knowledge', 'training'];
export const PERSONAL_OPTION_ORDER = [...PERSONAL_SERVICES, 'voice', 'memory'];

/** The options of one flagship in a builder code (`f.personal.mail-calendar-voice`), in the site's order; empty when the code names none. */
export function flagshipOptionsIn(code: string | null, product: 'personal' | 'company'): string[] {
  if (!code) return [];
  const chunk = code.split('~').find((c) => c.startsWith(`f.${product}.`));
  if (!chunk) return [];
  const ids = chunk.split('.')[2]?.split('-') ?? [];
  return (product === 'personal' ? PERSONAL_OPTION_ORDER : COMPANY_OPTION_ORDER).filter((o) => ids.includes(o));
}

/** «Персональный ИИ (Почта, Календарь, Голос; Плюс: цена плана)»: the flagship line of a builder estimate, «по смете», outside the one-time total. */
export function flagshipLine(product: 'personal' | 'company', title: string, options: readonly string[], p: Prices): string {
  const money = (n: number) => `$${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}`;
  if (product === 'personal') {
    const picked = options.length ? options : PERSONAL_DEFAULT;
    const level = personalLevel(picked);
    const plan = (p.personalPlans ?? []).find((x) => x.id === level);
    return `${title} (${picked.map((o) => FLAGSHIP_OPTION_RU[o] ?? o).join(', ')}${plan ? `; ${PERSONAL_LEVEL_RU[level]}: ${money(plan.setup)} + ${money(plan.monthly)}/мес` : ''})`;
  }
  const picked = options.length ? options : COMPANY_DEFAULT;
  const c = p.companyPlan;
  return `${title} (${picked.map((o) => FLAGSHIP_OPTION_RU[o] ?? o).join(', ')}${c ? `; от ${money(c.setup)} + ${money(c.monthly)}/мес, точная сумма по смете` : ''})`;
}

