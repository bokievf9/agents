/**
 * Service directions and prices. Mirror of ../../firtech/src/lib/directions.ts (prices) and the content plan
 * (pillars). Keep in sync by hand: a price change there means a change here. The model never invents prices:
 * it gets the line from this table and the lint flags any other dollar amount.
 */
export type DirectionId = 'admin' | 'receptionist' | 'automation' | 'content' | 'miniapp' | 'agent' | 'implementation' | 'training';

export interface Direction {
  id: DirectionId;
  name: string;
  /** Content-plan pillar letter (A, R, Z, C, M), 'D' for the Dono/Polly line, 'X' for the rest. */
  pillar: string;
  from: number;
  unit?: 'month' | 'person';
  supportMonthly?: number;
  team?: number;
  summary: string;
}

export const DIRECTIONS: Direction[] = [
  { id: 'admin', name: 'Бот-администратор', pillar: 'A', from: 250, summary: 'запись, перенос и напоминание за день и за час, просьба об отзыве; салоны, барбершопы, стоматологии, автосервисы' },
  { id: 'receptionist', name: 'ИИ-приёмщик заявок', pillar: 'R', from: 300, supportMonthly: 25, summary: 'отвечает в Telegram, WhatsApp и Instagram в любое время, задаёт уточняющие вопросы, передаёт менеджеру готовую карточку заявки; учебные центры, магазины' },
  { id: 'automation', name: 'Автоматизация рутины', pillar: 'Z', from: 150, summary: 'Google Sheets, CRM, мессенджеры, отчёты и рассылки по расписанию; кафе и доставка' },
  { id: 'content', name: 'Контент по подписке', pillar: 'C', from: 60, unit: 'month', summary: 'посты, карточки и ролики выходят по плану, владелец только утверждает; наш собственный конвейер как живая демонстрация' },
  { id: 'miniapp', name: 'Telegram Mini App', pillar: 'M', from: 500, summary: 'каталог, корзина, запись и лояльность в одном окне Telegram, без установки и регистрации' },
  { id: 'agent', name: 'Личный ИИ-агент (Dono и Polly)', pillar: 'D', from: 400, summary: 'Dono: личный ассистент студента (дедлайны, календарь, напоминания). Polly: учитель языка. Оба готовые продукты Fir Tech; показ только на примерных данных' },
  { id: 'implementation', name: 'Внедрение ИИ под ключ', pillar: 'X', from: 800, summary: 'разбор процессов компании и подключение агентов к её инструментам' },
  { id: 'training', name: 'Обучение работе с ИИ', pillar: 'X', from: 150, unit: 'person', team: 400, summary: 'практикум для сотрудников: как ставить задачи ИИ-агентам и проверять результат' },
];

export function priceLine(d: Direction): string {
  const unit = d.unit === 'month' ? ' в месяц' : d.unit === 'person' ? ' за человека' : '';
  const extra = [d.supportMonthly ? `сопровождение от $${d.supportMonthly} в месяц` : '', d.team ? `команда от $${d.team}` : ''].filter(Boolean);
  return `от $${d.from}${unit}${extra.length ? ` (${extra.join(', ')})` : ''}`;
}

export function allowedPrices(): Set<number> {
  const s = new Set<number>();
  for (const d of DIRECTIONS) for (const n of [d.from, d.supportMonthly, d.team]) if (n) s.add(n);
  return s;
}
