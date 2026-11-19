import { allowedAmounts, getPrices, planOf, supportMonthly, type ProductKey } from '@fir/core';

/**
 * Service directions of the content plan (pillars). Names and summaries live here; every dollar amount comes from the
 * site's price list (`getPrices()` in @fir/core, firtech.pro/api/prices) at the moment of use. The model never invents
 * prices: it gets the line built by `priceLine` and the lint flags any amount that is not in the price list.
 */
export type DirectionId = 'admin' | 'receptionist' | 'automation' | 'content' | 'miniapp' | 'agent' | 'implementation' | 'site';

export interface Direction {
  id: DirectionId;
  name: string;
  /** Content-plan pillar letter (A, R, Z, C, M), 'D' for the Dono/Polly line, 'X' for the rest. */
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
  make({ id: 'admin', name: 'Бот-администратор', pillar: 'A', summary: 'запись, перенос и напоминание за день и за час, просьба об отзыве; салоны, барбершопы, стоматологии, автосервисы' }, product('admin')),
  make(
    { id: 'receptionist', name: 'ИИ-приёмщик заявок', pillar: 'R', summary: 'отвечает в Telegram, WhatsApp и Instagram в любое время, задаёт уточняющие вопросы, передаёт менеджеру готовую карточку заявки; учебные центры, магазины' },
    product('intake'),
    true,
  ),
  make({ id: 'automation', name: 'Автоматизация рутины', pillar: 'Z', summary: 'Google Sheets, CRM, мессенджеры, отчёты и рассылки по расписанию; кафе и доставка' }, product('automation')),
  make(
    { id: 'content', name: 'Контент по подписке', pillar: 'C', summary: 'посты, карточки и ролики выходят по плану, владелец только утверждает; наш собственный конвейер как живая демонстрация' },
    () => {
      const c = planOf('content');
      return { from: c.setup, monthly: c.monthly };
    },
  ),
  make({ id: 'miniapp', name: 'Telegram Mini App', pillar: 'M', summary: 'каталог, корзина, запись и лояльность в одном окне Telegram, без установки и регистрации' }, product('miniapp')),
  make(
    { id: 'agent', name: 'Личный ИИ-агент (Dono и Polly)', pillar: 'D', summary: 'Dono: личный ассистент студента (дедлайны, календарь, напоминания). Polly: учитель языка. Оба готовые продукты Fir Tech; показ только на примерных данных' },
    () => {
      const d = planOf('dono');
      const p = planOf('polly');
      return { from: Math.min(d.setup, p.setup), monthly: Math.min(d.monthly, p.monthly) };
    },
  ),
  make({ id: 'implementation', name: 'Внедрение ИИ под ключ', pillar: 'X', summary: 'разбор процессов компании и подключение агентов к её инструментам' }, product('aiteam')),
  make({ id: 'site', name: 'Сайт под ключ', pillar: 'X', summary: 'лендинг или сайт компании с формой заявки в Telegram, русская и английская версии; магазины, студии, клиники' }, product('site')),
];

export function priceLine(d: Direction): string {
  const extra = d.supportMonthly ? ` (сопровождение от $${d.supportMonthly} в месяц)` : '';
  return `от $${d.from}${d.monthly ? ` + $${d.monthly} в месяц` : ''}${extra}`;
}

/** Every dollar amount a text may contain: the whole site price list, not only these directions. */
export function allowedPrices(): Set<number> {
  return allowedAmounts();
}
