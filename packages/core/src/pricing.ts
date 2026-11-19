/** USD per million tokens. */
export interface Price {
  in: number;
  out: number;
}

/** Prices by model name prefix (the longest matching prefix wins). */
export type PriceTable = Record<string, Price>;

/**
 * Known list prices, USD per 1M tokens (Anthropic). Check against the current price list: a wrong row only skews the
 * report. The owner's own rows (`prices` table, `setPrice`) beat these.
 */
export const MODEL_PRICES: PriceTable = {
  'claude-haiku': { in: 1, out: 5 },
  'claude-sonnet': { in: 3, out: 15 },
  'claude-opus': { in: 5, out: 25 },
};

/**
 * A model the table does not know (the gateway resolved a tier to something new, or answered with the alias `auto`).
 * Counted at this estimate instead of $0, so that limits still trigger and `/costs` never says "free" about a model
 * nobody checked. Set the real price with `setPrice` (or `setPrice('model', 0, 0)` for a free one).
 */
export const UNKNOWN_MODEL_PRICE: Price = { in: 1, out: 4 };

/** Models that the gateway marks free (OpenRouter-style `:free` suffix, `/free` routes). */
const FREE = /(:free$|\/free$|-free$)/i;

export type PriceSource = 'override' | 'table' | 'free' | 'unknown';

const longest = (table: PriceTable, model: string): Price | undefined =>
  Object.entries(table)
    .filter(([prefix]) => prefix !== '' && model.startsWith(prefix))
    .sort((a, b) => b[0].length - a[0].length)[0]?.[1];

/** The price of a model: the owner's rows, then the built-in table, then free markers, then the unknown-model estimate. */
export function priceFor(model: string, overrides: PriceTable = {}): { price: Price; source: PriceSource } {
  const o = longest(overrides, model);
  if (o) return { price: o, source: 'override' };
  const t = longest(MODEL_PRICES, model);
  if (t) return { price: t, source: 'table' };
  if (FREE.test(model)) return { price: { in: 0, out: 0 }, source: 'free' };
  return { price: UNKNOWN_MODEL_PRICE, source: 'unknown' };
}

export const usdFor = (price: Price, inputTokens: number, outputTokens: number): number => (inputTokens * price.in + outputTokens * price.out) / 1_000_000;
