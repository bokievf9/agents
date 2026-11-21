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
  // older generations (generic prefixes)
  'claude-haiku': { in: 1, out: 5 },
  'claude-sonnet': { in: 3, out: 15 },
  'claude-opus': { in: 5, out: 25 },
  // the 5.5 generation used in direct mode (owner's price list 2026-11-22); the longest prefix wins, and these rows are
  // seeded into the `prices` table next to the generic ones, so an older database gets them too
  'claude-haiku-5-5': { in: 0.1, out: 0.5 },
  'claude-sonnet-5-5': { in: 2, out: 10 },
  'claude-opus-5-5': { in: 4, out: 20 },
};

/** Prompt-cache reads are billed at about 10% of the input price. */
export const CACHE_READ_FACTOR = 0.1;

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

/** Cost of a call. `cacheReadTokens` (a part of `inputTokens`) is charged at `CACHE_READ_FACTOR` of the input price. */
export const usdFor = (price: Price, inputTokens: number, outputTokens: number, cacheReadTokens = 0): number => {
  const cached = Math.min(Math.max(cacheReadTokens, 0), inputTokens);
  return ((inputTokens - cached) * price.in + cached * price.in * CACHE_READ_FACTOR + outputTokens * price.out) / 1_000_000;
};
