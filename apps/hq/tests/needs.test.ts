import { describe, expect, it } from 'vitest';
import { BUILDER_PRODUCTS, buildFromText, builderPath, decodeBuild, encodeBuild } from '../src/client/builder-link.js';
import { asksCatalogue, NEED_RULES, NO_SITE_DELIVERY, productOfBot, productOfNeed, siteNeedOf } from '../src/client/needs.js';
import { BUILDER_PRODUCT_OF } from '../src/client/builder-link.js';
import { isCatalogueId } from '../src/client/products.js';

/** The ONE table of need -> product (`needs.ts`): a fixture per row, the generic «бот» by kind, the site need and the `l.`/`z.` chunks of the builder link. */
describe('need -> product table', () => {
  const rows: [string, string | undefined, string][] = [
    ['Нужен ии-отдел для компании', undefined, 'ai'],
    ['хотим базу знаний для сотрудников', undefined, 'ai'],
    ['нужен мини-апп с каталогом', undefined, 'miniapp'],
    ['Telegram Mini App для магазина', 'shop', 'miniapp'],
    ['нужен контент для Instagram', 'salon', 'content'],
    ['делайте рилс и посты', undefined, 'content'],
    ['автоматизация таблиц и отчётов', undefined, 'automation'],
    ['связать CRM и рассылки', undefined, 'automation'],
    ['нужен личный ассистент', undefined, 'agent'],
    ['нужен администратор для записи клиентов', 'salon', 'admin'],
    ['клиенты должны записываться онлайн', 'barber', 'admin'],
    ['нужна бронь столиков', 'restaurant', 'admin'],
    ['нужен приём заявок ночью', undefined, 'receptionist'],
    ['квалифицировать входящие заявки', undefined, 'receptionist'],
    ['нужен сайт для студии', undefined, 'site'],
    ['need a landing page', undefined, 'site'],
  ];
  it.each(rows)('«%s» (%s) -> %s', (text, kind, product) => {
    expect(productOfNeed(text, kind as never)).toMatchObject({ product, explicit: true });
  });

  it('every row of the table names a catalogue product the builder knows, and has a fixture above', () => {
    for (const r of NEED_RULES) {
      expect(isCatalogueId(r.product), r.id).toBe(true);
      expect(BUILDER_PRODUCTS as readonly string[], r.id).toContain(BUILDER_PRODUCT_OF[r.product]);
      expect(rows.some(([, , p]) => p === r.product), r.id).toBe(true);
    }
  });

  it('a generic «бот» is resolved by the kind of business: bookings -> ИИ-администратор, goods and food -> Mini App, else the ИИ-менеджер заявок; never `bot`', () => {
    expect(productOfBot('salon')).toBe('admin');
    expect(productOfBot('dentist')).toBe('admin');
    expect(productOfBot('cafe')).toBe('miniapp');
    expect(productOfBot('webshop')).toBe('miniapp');
    expect(productOfBot('lawyers')).toBe('receptionist');
    expect(productOfBot(undefined)).toBe('receptionist');
    expect(productOfNeed('хочу бота для салона', 'salon')).toEqual({ product: 'admin', explicit: false, rule: 'bot' });
    expect(productOfNeed('chatbot please', undefined)).toMatchObject({ product: 'receptionist', explicit: false });
    expect(productOfNeed('привет, как дела', 'salon')).toBeNull();
  });

  it('«не хочу сайт» is a site need, not a wish for a site', () => {
    for (const t of ['не хочу сайт, только агент', 'сайт мне не нужен', 'без сайта', 'I don\'t want a website', 'agent only']) {
      expect(siteNeedOf(t), t).toBe('no');
      expect(productOfNeed(t)?.product, t).not.toBe('site');
    }
    expect(siteNeedOf('у нас уже есть сайт')).toBe('have');
    expect(siteNeedOf('we already have a website')).toBe('have');
    expect(siteNeedOf('нужен сайт')).toBeUndefined();
  });

  it('the whole product list answers only «что вы делаете» and its kin', () => {
    for (const t of ['что вы делаете?', 'Какие у вас продукты', 'what do you offer', 'чем вы занимаетесь']) expect(asksCatalogue(t), t).toBe(true);
    for (const t of ['хочу бота для салона', 'сколько стоит', 'нужен сайт']) expect(asksCatalogue(t), t).toBe(false);
  });
});

describe('builder link: where the agent lives (l.) and whether it gets a site (z.)', () => {
  it('the chunks follow the site\'s order (k, p, g, c, l, z, d) and round-trip', () => {
    const b = { extras: [], kind: 'salon' as const, products: ['adminbot' as const], channels: ['instagram' as const], delivery: [...NO_SITE_DELIVERY], siteNeed: 'no' as const, details: { deadline: 'asap' as const } };
    expect(encodeBuild(b)).toBe('k.salon~p.adminbot~c.instagram~l.playground~z.no~d._._._.asap');
    expect(decodeBuild(encodeBuild(b))).toEqual(b);
    expect(builderPath('ru', { extras: [], kind: 'salon', products: ['adminbot'], delivery: ['playground'], siteNeed: 'no' })).toBe('/ru/builder?b=k.salon~p.adminbot~l.playground~z.no');
    // an empty delivery is a choice too: l.none; unknown values are dropped
    expect(encodeBuild({ extras: [], products: ['intake'], delivery: [] })).toBe('p.intake~l.none');
    expect(decodeBuild('p.intake~l.none~z.maybe~l.fax')).toMatchObject({ products: ['intake'], delivery: [] });
    expect(decodeBuild('l.telegram-playground-fax~z.have')).toEqual({ extras: [], delivery: ['telegram', 'playground'], siteNeed: 'have' });
    expect(buildFromText('Моя сборка: /ru/builder?b=k.salon~p.adminbot~l.playground~z.no')?.build).toMatchObject({ delivery: ['playground'], siteNeed: 'no' });
  });
});
