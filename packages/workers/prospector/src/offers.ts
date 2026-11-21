import { getPrices, productName, usd, type ProductKey } from '@fir/core';

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

/** `product`: the id in the one map of product names (`@fir/core` `product-names.ts`); the name is read at the moment of use, the live title of the price list first. */
const offer = (id: OfferId, product: string, key: ProductKey): Offer => ({
  id,
  get title() {
    return productName(product, 'ru');
  },
  get fromUsd() {
    return getPrices().products[key]!;
  },
});

export const OFFERS: Record<OfferId, Offer> = {
  admin: offer('admin', 'adminbot', 'admin'),
  receptionist: offer('receptionist', 'intake', 'intake'),
  miniapp: offer('miniapp', 'miniapp', 'miniapp'),
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
