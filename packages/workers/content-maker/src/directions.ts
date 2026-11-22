import { allowedAmounts, companyPlan, getPrices, personalPlans, planOf, productName, supportMonthly, teamPrice, type ProductKey } from '@fir/core';

/**
 * Service directions of the content plan (pillars). Names and summaries live here; every dollar amount comes from the
 * site's price list (`getPrices()` in @fir/core, firtech.pro/api/prices) at the moment of use. The model never invents
 * prices: it gets the line built by `priceLine` and the lint flags any amount that is not in the price list.
 */
export type DirectionId = 'admin' | 'receptionist' | 'automation' | 'content' | 'miniapp' | 'agent' | 'implementation' | 'site';

export interface Direction {
  id: DirectionId;
  name: string;
  /** Content-plan pillar letter (A, R, Z, C, M), 'D' for the Персональный ИИ line (direction id `agent`, the site's `personal`), 'X' for the rest. */
  pillar: string;
  /** Starting (setup) price in USD, from the price list. */
  readonly from: number;
  /** Monthly fee in USD (subscriptions), from the price list. */
  readonly monthly?: number;
  /** Monthly support after launch, USD, from the price list. */
  readonly supportMonthly?: number;
  summary: string;
}

type Meta = Omit<Direction, 'from' | 'monthly' | 'supportMonthly'>;
const make = (m: Meta, price: () => { from: number; monthly?: number }, support = false): Direction => ({
  ...m,
  get from() {
    return price().from;
  },
  get monthly() {
    return price().monthly;
  },
  get supportMonthly() {
    return support ? supportMonthly() : undefined;
  },
});
const product = (key: ProductKey) => () => ({ from: getPrices().products[key]! });

export const DIRECTIONS: Direction[] = [
  make({ id: 'admin', name: '', pillar: 'A', summary: 'запись, перенос и напоминание за день и за час, просьба об отзыве; салоны, барбершопы, стоматологии, автосервисы' }, product('admin')),
  make(
    { id: 'receptionist', name: '', pillar: 'R', summary: 'отвечает в Telegram, WhatsApp и Instagram в любое время, задаёт уточняющие вопросы, передаёт менеджеру готовую карточку заявки; учебные центры, магазины' },
    product('intake'),
    true,
  ),
  make({ id: 'automation', name: '', pillar: 'Z', summary: 'Google Sheets, CRM, мессенджеры, отчёты и рассылки по расписанию; кафе и доставка' }, product('automation')),
  make(
    { id: 'content', name: '', pillar: 'C', summary: 'посты, карточки и ролики выходят по плану, владелец только утверждает; наш собственный конвейер как живая демонстрация' },
    () => {
      const c = planOf('content');
      return { from: c.setup, monthly: c.monthly };
    },
  ),
  make({ id: 'miniapp', name: '', pillar: 'M', summary: 'каталог, корзина, запись и лояльность в одном окне Telegram, без установки и регистрации' }, product('miniapp')),
  make(
    { id: 'agent', name: '', pillar: 'D', summary: 'Персональный ИИ: личный помощник владельца в Telegram, утренняя сводка, почта, календарь, задачи и обещания, три уровня по числу подключённых сервисов; свои Dono и Polly у основателя как живые кейсы, показ только на примерных данных' },
    () => {
      const first = personalPlans()[0];
      return { from: first?.setup ?? 0, monthly: first?.monthly };
    },
  ),
  make({ id: 'implementation', name: '', pillar: 'X', summary: 'разбор процессов компании и подключение агентов к её инструментам' }, () => {
    const t = teamPrice('sales');
    return t ? { from: t.setup, monthly: t.monthly } : { from: companyPlan()?.setup ?? 0, monthly: companyPlan()?.monthly };
  }),
  make({ id: 'site', name: '', pillar: 'X', summary: 'лендинг или сайт компании с формой заявки в Telegram, русская и английская версии; магазины, студии, клиники' }, product('site')),
];

/** The names come from the one map of product names (`@fir/core`), read at the moment of use (the live title of the price list first). */
const NAME_OF: Record<DirectionId, string> = { admin: 'adminbot', receptionist: 'intake', automation: 'automation', content: 'content', miniapp: 'miniapp', agent: 'agent', implementation: 'aiteam', site: 'site' };
for (const d of DIRECTIONS) Object.defineProperty(d, 'name', { get: () => productName(NAME_OF[d.id], 'ru'), enumerable: true, configurable: true });

export function priceLine(d: Direction): string {
  const extra = d.supportMonthly ? ` (сопровождение от $${d.supportMonthly} в месяц)` : '';
  return `от $${d.from}${d.monthly ? ` + $${d.monthly} в месяц` : ''}${extra}`;
}

/** Every dollar amount a text may contain: the whole site price list, not only these directions. */
export function allowedPrices(): Set<number> {
  return allowedAmounts();
}
