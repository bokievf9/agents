import { getPrices, usd, type ProductKey } from '@fir/core';

/**
 * The three offers Prospector sells first. Names live here; the dollar amounts come from the site's price list
 * (`getPrices()` in @fir/core, firtech.pro/api/prices), read at the moment of use. The owner approves prices (level 0).
 */
export type OfferId = 'admin' | 'receptionist' | 'miniapp';

export interface Offer {
  id: OfferId;
  title: string;
  readonly fromUsd: number;
}

const offer = (id: OfferId, title: string, key: ProductKey): Offer => ({
  id,
  title,
  get fromUsd() {
    return getPrices().products[key]!;
  },
});

export const OFFERS: Record<OfferId, Offer> = {
  admin: offer('admin', 'бот-администратор в Telegram', 'admin'),
  receptionist: offer('receptionist', 'ИИ-приёмщик заявок', 'intake'),
  miniapp: offer('miniapp', 'мини-приложение в Telegram', 'miniapp'),
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
  return `от ${usd(offer.fromUsd)}`;
}
