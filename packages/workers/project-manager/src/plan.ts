import { zonedParts, zonedToMs } from '@fir/core';
import { type MilestoneKind, type Product } from './store.js';

export const PRODUCT_RU: Record<Product, string> = { site: 'сайт', bot: 'Telegram-бот', app: 'приложение', automation: 'автоматизация' };

export const MILESTONE_RU: Record<MilestoneKind, string> = {
  brief: 'Бриф', prototype: 'Прототип', delivery: 'Сдача', payment: 'Оплата',
};

/** Calendar days from the start to each milestone, by product. Targets only; the owner may move them. */
const OFFSETS: Record<Product, Record<MilestoneKind, number>> = {
  site: { brief: 2, prototype: 7, delivery: 14, payment: 16 },
  bot: { brief: 2, prototype: 6, delivery: 12, payment: 14 },
  app: { brief: 3, prototype: 14, delivery: 30, payment: 33 },
  automation: { brief: 2, prototype: 5, delivery: 10, payment: 12 },
};

/** The product type from free text; `site` when nothing matches. */
export function guessProduct(text: string): Product {
  const t = text.toLowerCase();
  if (/бот|telegram|телеграм/.test(t)) return 'bot';
  if (/приложени|app|ios|android/.test(t)) return 'app';
  if (/автоматиз|интеграц|crm|парсер|скрипт/.test(t)) return 'automation';
  return 'site';
}

export interface PlannedMilestone {
  kind: MilestoneKind;
  title: string;
  dueAt: number;
}

/** Milestones with target dates (end of the local day) counted from `startMs`. */
export function planMilestones(product: Product, startMs: number, tz: string): PlannedMilestone[] {
  const p = zonedParts(startMs, tz);
  return (Object.keys(OFFSETS[product]) as MilestoneKind[]).map((kind) => {
    const d = new Date(Date.UTC(p.y, p.mo - 1, p.d + OFFSETS[product][kind]));
    return { kind, title: MILESTONE_RU[kind], dueAt: zonedToMs(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 23, 59, tz) };
  });
}

export function fmtDate(ms: number, tz: string): string {
  const p = zonedParts(ms, tz);
  return `${String(p.d).padStart(2, '0')}.${String(p.mo).padStart(2, '0')}`;
}
