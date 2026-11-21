import { describe, expect, it } from 'vitest';
import { canonicalProductId, FALLBACK_PRICES, parsePrices, PRODUCT_NAMES, productList, productName, productNames } from '../src/index.js';

describe('the map of product names', () => {
  it('the owner\'s names, RU and EN, under every spelling of the id', () => {
    expect(productName('adminbot', 'ru')).toBe('ИИ-администратор');
    expect(productName('admin', 'en')).toBe('AI booking assistant');
    expect(productName('intake', 'ru')).toBe('ИИ-менеджер заявок');
    expect(productName('receptionist', 'en')).toBe('AI lead manager');
    expect(productNames('automation')).toEqual({ ru: 'Автоматизация процессов', en: 'Process automation' });
    expect(productName('content', 'ru')).toBe('Контент на автопилоте');
    expect(productName('miniapp', 'en')).toBe('Telegram Mini App');
    expect(productName('personal', 'ru')).toBe('Персональный ИИ');
    expect(productName('personal', 'en')).toBe('Personal AI');
    expect(productName('company', 'ru')).toBe('ИИ-компания');
    expect(productName('company', 'en')).toBe('AI company');
    // the retired `agent` is a synonym of `personal`
    expect(productName('agent', 'ru')).toBe('Персональный ИИ');
    expect(canonicalProductId('agent')).toBe('personal');
    for (const id of ['aiteam', 'ai', 'implementation']) expect(productName(id, 'ru')).toBe('ИИ-отдел под ключ');
    expect(productName('aiteam', 'en')).toBe('AI department turnkey');
    expect(productName('unknown-id', 'ru')).toBe('unknown-id');
    expect(canonicalProductId('receptionist')).toBe('intake');
    expect(PRODUCT_NAMES.map((n) => n.id)).toEqual(['personal', 'company', 'adminbot', 'intake', 'automation', 'content', 'miniapp', 'aiteam', 'site', 'bot', 'app']);
  });

  it('no AI product name carries the word «бот»; the classics (delivery formats) may', () => {
    for (const n of PRODUCT_NAMES.filter((x) => !['site', 'bot', 'app'].includes(x.id))) expect(`${n.ru} ${n.en}`, n.id).not.toMatch(/бот|\bbot\b/i);
    expect(productList('ru')).toBe('Персональный ИИ, ИИ-компания, ИИ-администратор, ИИ-менеджер заявок, Автоматизация процессов, Контент на автопилоте, Telegram Mini App, ИИ-отдел под ключ');
    expect(productList('en', { classics: true })).toMatch(/Website, Telegram bot, App$/);
  });

  it('the live title of the price list wins, as a string (Russian) or as { ru, en }, and survives the normalised copy', () => {
    const raw = JSON.parse(JSON.stringify(FALLBACK_PRICES)) as Record<string, unknown>;
    const products = { ...(raw.products as Record<string, unknown>), receptionist: { kind: 'from', from: 150, title: { ru: 'ИИ-менеджер заявок Pro', en: 'AI lead manager Pro' } }, admin: { kind: 'from', from: 100, title: 'ИИ-администратор для записи' } };
    const parsed = parsePrices({ ...raw, products })!;
    expect(productName('receptionist', 'ru', parsed)).toBe('ИИ-менеджер заявок Pro');
    expect(productName('intake', 'en', parsed)).toBe('AI lead manager Pro');
    expect(productName('adminbot', 'ru', parsed)).toBe('ИИ-администратор для записи');
    expect(productName('adminbot', 'en', parsed)).toBe('AI booking assistant');
    const again = parsePrices(JSON.parse(JSON.stringify(parsed)))!;
    expect(productName('intake', 'ru', again)).toBe('ИИ-менеджер заявок Pro');
  });
});
