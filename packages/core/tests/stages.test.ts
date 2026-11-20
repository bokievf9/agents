import { afterEach, describe, expect, it } from 'vitest';
import { FALLBACK_PRICES, isSmallPlan, parsePrices, parseStages, setPrices, smallProjectMaxUsd, stagesFor, templateFor } from '../src/index.js';

const sum = (s: { amountUsd: number }[]) => s.reduce((a, x) => a + x.amountUsd, 0);
const shares = (s: { share: number }[]) => s.map((x) => x.share);

afterEach(() => setPrices(FALLBACK_PRICES));

describe('stagesFor: templates by product', () => {
  it('site 30/40/30, bot 30/40/30, automation 20/50/30, app 25 x4', () => {
    expect(shares(stagesFor(1000, ['site']))).toEqual([30, 40, 30]);
    expect(shares(stagesFor(1000, ['admin']))).toEqual([30, 40, 30]);
    expect(shares(stagesFor(1000, ['receptionist']))).toEqual([30, 40, 30]);
    expect(shares(stagesFor(1000, ['automation']))).toEqual([20, 50, 30]);
    expect(shares(stagesFor(1000, ['implementation']))).toEqual([20, 50, 30]);
    expect(shares(stagesFor(1000, ['miniapp']))).toEqual([25, 25, 25, 25]);
    expect(stagesFor(1000, ['site']).map((s) => s.id)).toEqual(['structure', 'pages', 'launch']);
    expect(stagesFor(1000, ['app']).map((s) => s.no)).toEqual([1, 2, 3, 4]);
    expect(stagesFor(1000, ['site']).map((s) => s.amountUsd)).toEqual([300, 400, 300]);
  });

  it('a mixed bundle takes the template of the most expensive part and the shares apply to the whole total', () => {
    const s = stagesFor(1300, ['site', 'miniapp']); // the mini app (the standard package) costs more than a site start
    expect(shares(s)).toEqual([25, 25, 25, 25]);
    expect(sum(s)).toBe(1300);
    expect(shares(stagesFor(900, ['admin', 'site']))).toEqual(shares(stagesFor(900, [templateFor(['admin', 'site']).id === 'bot' ? 'admin' : 'site'])));
  });

  it('an unknown product falls back to the site template', () => {
    expect(shares(stagesFor(600, ['something-new']))).toEqual([30, 40, 30]);
    expect(shares(stagesFor(600, []))).toEqual([30, 40, 30]);
  });
});

describe('stagesFor: small projects, subscriptions, rounding', () => {
  it('under 300 USD: two stages 50/50, any product; 300 and above: the template', () => {
    expect(smallProjectMaxUsd()).toBe(300);
    const s = stagesFor(290, ['admin']);
    expect(s.map((x) => [x.id, x.share, x.amountUsd])).toEqual([['start', 50, 145], ['launch', 50, 145]]);
    expect(isSmallPlan(s)).toBe(true);
    expect(isSmallPlan(stagesFor(300, ['admin']))).toBe(false);
    expect(shares(stagesFor(299, ['automation']))).toEqual([50, 50]);
    expect(shares(stagesFor(300, ['automation']))).toEqual([20, 50, 30]);
  });

  it('whole dollars; the last stage absorbs the rounding so the sum equals the total', () => {
    for (const total of [301, 333, 777, 1001, 1999, 289, 299]) {
      for (const id of ['site', 'automation', 'miniapp', 'admin']) {
        const s = stagesFor(total, [id]);
        expect(sum(s), `${total} ${id}`).toBe(total);
        for (const x of s.slice(0, -1)) expect(Number.isInteger(x.amountUsd)).toBe(true);
      }
    }
    expect(stagesFor(333, ['site']).map((x) => x.amountUsd)).toEqual([100, 133, 100]);
    expect(stagesFor(289, ['admin']).map((x) => x.amountUsd)).toEqual([145, 144]);
  });

  it('a subscription has the one setup stage', () => {
    const s = stagesFor(90, ['content']);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ no: 1, id: 'setup', share: 100, amountUsd: 90 });
    expect(stagesFor(150, ['agent'])).toHaveLength(1);
  });

  it('a zero or broken total gives zero amounts, never NaN', () => {
    expect(sum(stagesFor(0, ['site']))).toBe(0);
    expect(sum(stagesFor(Number.NaN, ['site']))).toBe(0);
  });
});

describe('the templates come from the price list', () => {
  it('the site\'s own templates and threshold win over the built-in copy', () => {
    const custom = parsePrices({
      ...FALLBACK_PRICES, smallProjectMaxUsd: 500,
      stages: [{ id: 'site', title: { ru: 'Сайт', en: 'Site' }, products: ['site'], shares: [{ id: 'a', title: { ru: 'А', en: 'A' }, share: 60 }, { id: 'b', title: { ru: 'Б', en: 'B' }, share: 40 }] }],
    })!;
    setPrices(custom);
    expect(shares(stagesFor(400, ['site']))).toEqual([50, 50]); // under the site's own threshold, the built-in small template
    expect(shares(stagesFor(500, ['site']))).toEqual([60, 40]);
    expect(stagesFor(500, ['site']).map((s) => s.amountUsd)).toEqual([300, 200]);
  });

  it('a price list without stages (the site not deployed yet) uses the built-in copy', () => {
    const { stages: _s, smallProjectMaxUsd: _m, ...rest } = FALLBACK_PRICES;
    setPrices(parsePrices(rest)!);
    expect(shares(stagesFor(1000, ['miniapp']))).toEqual([25, 25, 25, 25]);
    expect(smallProjectMaxUsd()).toBe(300);
  });

  it('the bundled snapshot carries the templates of the contract', () => {
    expect(FALLBACK_PRICES.stages?.map((t) => t.id)).toEqual(['site', 'bot', 'automation', 'app', 'small']);
    expect(FALLBACK_PRICES.smallProjectMaxUsd).toBe(300);
  });
});

describe('parseStages', () => {
  it('reads what stagesFor wrote and refuses anything else', () => {
    const s = stagesFor(1000, ['site']);
    expect(parseStages(JSON.parse(JSON.stringify(s)))).toEqual(s);
    expect(parseStages(undefined)).toBeNull();
    expect(parseStages([])).toBeNull();
    expect(parseStages([{ no: 1 }])).toBeNull();
  });
});
