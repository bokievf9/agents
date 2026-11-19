import { existsSync, readFileSync } from 'node:fs';
import { openDb } from '@fir/core';
import { describe, expect, it } from 'vitest';
import { csvRecords, parseCsv } from '../src/csv.js';
import { offerFor, priceLabel } from '../src/offers.js';
import { nicheRank, ProspectStore } from '../src/store.js';
import { CSV, DAY, T0 } from './helpers.js';

const fresh = () => new ProspectStore(openDb(':memory:'), () => T0);

describe('csv', () => {
  it('handles BOM, quotes, commas, doubled quotes and CRLF', () => {
    const rows = parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n\r\n1,2');
    expect(rows).toEqual([['a', 'b'], ['x, y', 'say "hi"'], ['1', '2']]);
    expect(csvRecords('a,b\n1,2')).toEqual([{ a: '1', b: '2' }]);
  });
});

describe('import', () => {
  it('loads rows as new and dedupes by name + city, ignoring case and spacing', () => {
    const s = fresh();
    const res = s.importCsv(CSV);
    expect(res).toEqual({ added: 5, duplicates: 1, invalid: 1 });
    expect(s.stats().byStatus.new).toBe(5);
    expect(s.get(1)).toMatchObject({ extId: 'P001', name: 'Кафе Ромашка', city: 'Ташкент', status: 'new', phone: '+998900000001' });
  });

  it('is safe to run twice', () => {
    const s = fresh();
    s.importCsv(CSV);
    expect(s.importCsv(CSV)).toEqual({ added: 0, duplicates: 6, invalid: 1 });
    expect(s.stats().total).toBe(5);
  });

  it('keeps the same name in another city', () => {
    const s = fresh();
    s.importCsv(CSV);
    expect(s.importCsv('название,город,ниша\nCambridge,Ташкент,Учебные центры').added).toBe(1);
  });

  const real = new URL('../../../../../docs/prospects-2026-11.csv', import.meta.url).pathname;
  it.skipIf(!existsSync(real))('imports the real base of 100 businesses', () => {
    const s = fresh();
    expect(s.importCsv(readFileSync(real, 'utf8'))).toMatchObject({ added: 100, invalid: 0 });
    expect(s.stats().byNiche).toHaveLength(4);
  });
});

describe('batch selection by niche priority', () => {
  it('orders learning centres, shops, beauty/dental, food; CSV order inside a niche', () => {
    const s = fresh();
    s.importCsv(CSV);
    expect(s.pickNew(10).map((p) => p.extId)).toEqual(['P003', 'P005', 'P002', 'P004', 'P001']);
    expect(s.pickNew(2).map((p) => p.extId)).toEqual(['P003', 'P005']);
  });

  it('ranks reserve niches after the main four and unknown last', () => {
    expect([nicheRank('Учебные центры'), nicheRank('Магазины'), nicheRank('Салоны'), nicheRank('Доставка еды и кафе')]).toEqual([0, 1, 2, 3]);
    expect(nicheRank('Автосервисы')).toBeGreaterThan(3);
    expect(nicheRank('Что-то иное')).toBeGreaterThan(nicheRank('Недвижимость'));
  });

  it('never picks prospects that already moved on', () => {
    const s = fresh();
    s.importCsv(CSV);
    s.transition(3, 'proposed');
    expect(s.pickNew(1)[0]!.extId).toBe('P005');
  });
});

describe('status machine', () => {
  it('walks new -> proposed -> sent -> replied and stamps dates', () => {
    const s = fresh();
    s.importCsv(CSV);
    expect(s.transition(1, 'proposed').proposedAt).toBe(T0);
    expect(s.transition(1, 'sent').sentAt).toBe(T0);
    expect(s.transition(1, 'replied').repliedAt).toBe(T0);
  });

  it('rejects illegal jumps', () => {
    const s = fresh();
    s.importCsv(CSV);
    expect(() => s.transition(1, 'sent')).toThrow(/Illegal/);
    expect(() => s.transition(1, 'replied')).toThrow(/Illegal/);
    s.transition(1, 'proposed');
    s.transition(1, 'skipped');
    expect(() => s.transition(1, 'sent')).toThrow(/Illegal/);
    expect(() => s.transition(99, 'proposed')).toThrow(/No prospect/);
  });

  it('allows a late reply after no_reply', () => {
    const s = fresh();
    s.importCsv(CSV);
    for (const to of ['proposed', 'sent', 'no_reply', 'replied'] as const) s.transition(1, to);
    expect(s.get(1)!.status).toBe('replied');
  });
});

describe('follow-up timing', () => {
  it('is due 3 days after sent, then 7 days after sent, then closes as no_reply after 10', () => {
    const s = fresh();
    s.importCsv(CSV);
    s.transition(1, 'proposed');
    s.transition(1, 'sent');
    expect(s.dueFollowups(T0 + 3 * DAY - 1)).toHaveLength(0);
    expect(s.dueFollowups(T0 + 3 * DAY).map((p) => p.id)).toEqual([1]);
    s.bumpFollowups(1);
    expect(s.dueFollowups(T0 + 6 * DAY)).toHaveLength(0);
    expect(s.dueFollowups(T0 + 7 * DAY).map((p) => p.id)).toEqual([1]);
    s.bumpFollowups(1);
    expect(s.dueFollowups(T0 + 30 * DAY)).toHaveLength(0);
    expect(s.expireNoReply(T0 + 9 * DAY)).toBe(0);
    expect(s.expireNoReply(T0 + 10 * DAY)).toBe(1);
    expect(s.get(1)!.status).toBe('no_reply');
  });

  it('ignores replied and unsent prospects', () => {
    const s = fresh();
    s.importCsv(CSV);
    s.transition(1, 'proposed');
    s.transition(2, 'proposed');
    s.transition(2, 'sent');
    s.transition(2, 'replied');
    expect(s.dueFollowups(T0 + 40 * DAY)).toHaveLength(0);
  });
});

describe('stats and find', () => {
  it('counts the funnel by status and niche', () => {
    const s = fresh();
    s.importCsv(CSV);
    s.transition(3, 'proposed');
    s.transition(3, 'sent');
    const st = s.stats();
    expect(st.total).toBe(5);
    expect(st.byStatus).toMatchObject({ new: 4, sent: 1 });
    expect(st.byNiche[0]).toMatchObject({ niche: 'Учебные центры и репетиторы', total: 2 });
    expect(st.byNiche[0]!.byStatus.sent).toBe(1);
  });

  it('finds by Cyrillic text in any case, by city and by phone', () => {
    const s = fresh();
    s.importCsv(CSV);
    expect(s.find('РОМАШКА').map((p) => p.extId)).toEqual(['P001']);
    expect(s.find('бишкек').map((p) => p.extId)).toEqual(['P003']);
    expect(s.find('909924939')).toHaveLength(1);
    expect(s.find('   ')).toEqual([]);
  });
});

describe('offers', () => {
  it('maps the offer text to a direction price from directions.ts', () => {
    expect(priceLabel(offerFor('Бот-администратор: запись'))).toBe('от $290');
    expect(priceLabel(offerFor('Бот-заказ и бронь в Telegram; ИИ-приёмщик'))).toBe('от $290');
    expect(priceLabel(offerFor('ИИ-приёмщик заявок из директа + Telegram Mini App'))).toBe('от $220');
    expect(priceLabel(offerFor('Telegram Mini App: каталог; сайт как основа'))).toBe('от $660');
    expect(priceLabel(offerFor(''))).toBe('от $290');
  });
});
