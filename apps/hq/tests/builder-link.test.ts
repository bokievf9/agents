import { describe, expect, it } from 'vitest';
import {
  BUILDER_KINDS, buildFromText, builderPath, cleanBuild, decodeBuild, encodeBuild, kindFromText, type Build,
} from '../src/client/builder-link.js';

/**
 * The fixtures below are the output of the SITE's own `encodeBuild` / `decodeBuild` (`firtech/src/lib/builder.ts`, run with tsx on 2026-11-22), for the chunks this port
 * knows (kind, products, goals, channels, details, examples, wish, extras). The site's own round-trip test uses the same `full` shape (`firtech/tests/builder.test.mjs`).
 */
const FULL: Build = {
  extras: ['support', 'seo', 'design'],
  kind: 'dentist',
  products: ['adminbot', 'intake', 'automation', 'content', 'miniapp', 'agent', 'aiteam', 'site', 'bot', 'app'],
  goals: ['leads', 'sales', 'booking', 'routine', 'brand'],
  channels: ['instagram', 'telegram', 'search', 'word'],
  details: {
    pages: 20, langs: ['ru', 'en', 'tj', 'uz'], has: ['logo', 'texts', 'photos', 'domain', 'hosting'],
    examples: ['https://example.com/very/long/path/' + 'a'.repeat(60), 'кафе.tj/меню'], deadline: 'asap',
    wish: 'Нужен раздел с меню, доставкой по городу и оплатой картой. '.repeat(6).slice(0, 300),
  },
};
const FULL_CODE =
  'x.support-seo-design~k.dentist~p.adminbot-intake-automation-content-miniapp-agent-aiteam-site-bot-app~g.leads-sales-booking-routine-brand~c.instagram-telegram-search-word~d.20.ru-en-tj-uz.logo-texts-photos-domain-hosting.asap'
  + '~u.aHR0cHM6Ly9leGFtcGxlLmNvbS92ZXJ5L2xvbmcvcGF0aC9hYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE'
  + '~u.0LrQsNGE0LUudGov0LzQtdC90Y4'
  + '~w.0J3Rg9C20LXQvSDRgNCw0LfQtNC10Lsg0YEg0LzQtdC90Y4sINC00L7RgdGC0LDQstC60L7QuSDQv9C-INCz0L7RgNC-0LTRgyDQuCDQvtC_0LvQsNGC0L7QuSDQutCw0YDRgtC-0LkuINCd0YPQttC10L0g0YDQsNC30LTQtdC7INGBINC80LXQvdGOLCDQtNC-0YHRgtCw0LLQutC-0Lkg0L_QviDQs9C-0YDQvtC00YMg0Lgg0L7Qv9C70LDRgtC-0Lkg0LrQsNGA0YLQvtC5LiDQndGD0LbQtdC9INGA0LDQt9C00LXQuyDRgSDQvNC10L3Rjiwg0LTQvtGB0YLQsNCy0LrQvtC5INC_0L4g0LPQvtGA0L7QtNGDINC4INC-0L_Qu9Cw0YLQvtC5INC60LDRgNGC0L7QuS4g0J3Rg9C20LXQvSDRgNCw0LfQtNC10Lsg0YEg0LzQtdC90Y4sINC00L7RgdGC0LDQstC60L7QuSDQv9C-INCz0L7RgNC-0LTRgyDQuCDQvtC_0LvQsNGC0L7QuSDQutCw0YDRgtC-0LkuINCd0YPQttC10L0g0YDQsNC30LTQtdC7INGBINC80LXQvdGOLCDQtNC-0YHRgtCw0LLQutC-0Lkg0L_QviDQs9C-0YDQvtC00YMg0Lgg0L7Qv9C70LDRgtC-0Lkg0LrQsNGA0YLQvtC5LiDQndGD0LbQtdC9';

describe('builder link: the site\'s encoding, ported', () => {
  it('every field of the brief encodes exactly like the site and survives the round trip (the site\'s long-text and 20-page limits included)', () => {
    expect(encodeBuild(FULL)).toBe(FULL_CODE);
    expect(decodeBuild(FULL_CODE)).toEqual(FULL);
  });

  it('small builds: the chunk order and the separators are the site\'s', () => {
    expect(encodeBuild({ extras: ['seo'], kind: 'cafe', products: ['miniapp'] })).toBe('x.seo~k.cafe~p.miniapp');
    expect(encodeBuild({ extras: [], kind: 'salon', products: ['adminbot', 'intake'], goals: ['booking', 'leads'], channels: ['instagram', 'telegram'], details: { pages: 5, langs: ['ru', 'en'], has: ['logo', 'texts'], deadline: 'month', examples: ['https://example.com/menu', 'кафе.tj/меню'], wish: 'Нужна запись онлайн ~ с точками - и ~тильдами. Привет' } }))
      .toBe('k.salon~p.adminbot-intake~g.booking-leads~c.instagram-telegram~d.5.ru-en.logo-texts.month~u.aHR0cHM6Ly9leGFtcGxlLmNvbS9tZW51~u.0LrQsNGE0LUudGov0LzQtdC90Y4~w.0J3Rg9C20L3QsCDQt9Cw0L_QuNGB0Ywg0L7QvdC70LDQudC9IH4g0YEg0YLQvtGH0LrQsNC80LggLSDQuCB-0YLQuNC70YzQtNCw0LzQuC4g0J_RgNC40LLQtdGC');
    expect(encodeBuild({ extras: [], details: { deadline: 'month', wish: 'Тест ~ с . точками - и ~тильдами' } })).toBe('d._._._.month~w.0KLQtdGB0YIgfiDRgSAuINGC0L7Rh9C60LDQvNC4IC0g0LggftGC0LjQu9GM0LTQsNC80Lg');
    expect(encodeBuild({ extras: [] })).toBe('');
  });

  it('decode drops what the site drops (unknown ids, bad text chunks, a page count above 20) and skips the chunks it does not know', () => {
    expect(decodeBuild('k.salon~p.adminbot-hack-intake~g.leads-hack~c.tiktok~d.999.ru-xx.logo-cash.never~u.!!!~w.%%%~z.1')).toEqual({
      extras: [], kind: 'salon', products: ['adminbot', 'intake'], goals: ['leads'], details: { pages: 20, langs: ['ru'], has: ['logo'] },
    });
    // a part chunk and the style chunks belong to the site's catalogue: skipped here, the rest is kept
    expect(decodeBuild('websites.landing.telegram~s.minimal.coral.light.soft~k.cafe')).toEqual({ extras: [], kind: 'cafe' });
    expect(decodeBuild('')).toBeNull();
    expect(decodeBuild('z.1~websites.constructor')).toBeNull();
    // a text chunk that is not a link is dropped
    expect(decodeBuild(encodeBuild({ extras: [], details: { examples: ['<script>'] } }))).toBeNull();
  });

  it('the link the receptionist sends: /<locale>/builder?b=<code>, a bare builder page for an empty brief, full with an origin', () => {
    expect(builderPath('ru', { extras: [], kind: 'salon', products: ['adminbot'], goals: ['booking'] })).toBe('/ru/builder?b=k.salon~p.adminbot~g.booking');
    expect(builderPath('en', { extras: [] })).toBe('/en/builder');
    expect(builderPath('en', { extras: [], kind: 'cafe' }, 'https://firtech.pro')).toBe('https://firtech.pro/en/builder?b=k.cafe');
    // a value outside the lists never reaches the link
    expect(builderPath('ru', { extras: [], kind: 'hacker' as never, products: ['adminbot', 'nope' as never], channels: ['tiktok' as never] })).toBe('/ru/builder?b=p.adminbot');
    expect(cleanBuild({ extras: [], details: { pages: 99, deadline: 'never' as never, examples: ['not a link'] } })).toEqual({ extras: [], details: { pages: 20 } });
  });

  it('a builder link inside a text (a lead\'s estimate) is found and decoded; the estimate page too', () => {
    const t = 'Сборка: https://firtech.pro/ru/builder?b=k.salon~p.adminbot-intake~g.booking). Итого';
    expect(buildFromText(t)).toEqual({ code: 'k.salon~p.adminbot-intake~g.booking', build: { extras: [], kind: 'salon', products: ['adminbot', 'intake'], goals: ['booking'] } });
    expect(buildFromText('https://firtech.pro/en/builder/estimate?b=k.cafe%7Ep.miniapp')?.build).toEqual({ extras: [], kind: 'cafe', products: ['miniapp'] });
    expect(buildFromText('no link here')).toBeNull();
  });

  it('kinds: the list is the site\'s 56 and business words map to them', () => {
    expect(BUILDER_KINDS).toHaveLength(56);
    expect(new Set(BUILDER_KINDS).size).toBe(56);
    const cases: [string, string][] = [['барбершоп на Чиланзаре', 'barber'], ['у нас салон красоты', 'salon'], ['стоматология', 'dentist'], ['маленькая клиника', 'clinic'], ['интернет-магазин одежды', 'webshop'], ['магазин цветов', 'flowers'],
      ['кафе', 'cafe'], ['доставка суши', 'delivery'], ['автосервис', 'carservice'], ['репетитор по математике', 'tutor'], ['a dental clinic', 'dentist'], ['coffee shop', 'coffee'], ['yoga studio', 'yoga'], ['real estate agency', 'realty']];
    for (const [text, kind] of cases) expect(kindFromText(text), text).toBe(kind);
    expect(kindFromText('делаю что-то непонятное')).toBeUndefined();
  });
});
