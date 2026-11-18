/**
 * Offers and USD prices. Prices live in ../../firtech/src/lib/directions.ts (`directionPrices`); this is a copy
 * of the three that Prospector sells first. Keep it in sync by hand, the owner approves prices (level 0).
 */
export type OfferId = 'admin' | 'receptionist' | 'miniapp';

export interface Offer {
  id: OfferId;
  title: string;
  fromUsd: number;
}

export const OFFERS: Record<OfferId, Offer> = {
  admin: { id: 'admin', title: 'бот-администратор в Telegram', fromUsd: 250 },
  receptionist: { id: 'receptionist', title: 'ИИ-приёмщик заявок', fromUsd: 300 },
  miniapp: { id: 'miniapp', title: 'мини-приложение в Telegram', fromUsd: 500 },
};

const KEYWORDS: [RegExp, OfferId][] = [
  [/бот-/i, 'admin'],
  [/приём?щик|приемщик/i, 'receptionist'],
  [/mini app/i, 'miniapp'],
];

/** The CSV column "что предложить" to the first-named offer (earliest mention wins; default: admin bot). */
export function offerFor(text: string): Offer {
  let best: { at: number; id: OfferId } | null = null;
  for (const [re, id] of KEYWORDS) {
    const at = text.search(re);
    if (at >= 0 && (!best || at < best.at)) best = { at, id };
  }
  return OFFERS[best?.id ?? 'admin'];
}

export function priceLabel(offer: Offer): string {
  return `от $${offer.fromUsd}`;
}
