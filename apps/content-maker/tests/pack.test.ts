import { MockLlm } from '@fir/core';
import { describe, expect, it } from 'vitest';
import { carouselSchema, clipSchema, replacePart, splitPlatforms } from '../src/format.js';
import { DEFAULT_CADENCE, buildPackPlan, hasCarousel, isoWeek } from '../src/head.js';
import { lintText } from '../src/lint.js';
import { OWNER, OffLlm, carouselJson, clipJson, setup } from './helpers.js';

describe('pack generation', () => {
  it('sends 7 clips and 1 carousel (even ISO week), one numbered message each, with approval buttons', async () => {
    const { head, messenger, store } = setup();
    await head.generatePack(true);
    const items = messenger.sent.filter((m) => m.buttons);
    expect(items).toHaveLength(8);
    expect(items.every((m) => m.chatId === OWNER && m.buttons![0]!.length === 3)).toBe(true);
    expect(items[0]!.text).toContain('материал 1 из 8');
    expect(items[7]!.text).toContain('материал 8 из 8');
    expect(items.filter((m) => m.text.includes('клип,'))).toHaveLength(7);
    expect(items.filter((m) => m.text.includes('карусель,'))).toHaveLength(1);
    expect(items[0]!.text).toContain('Instagram + TikTok + Shorts');
    expect(items[0]!.text).toContain('пн 23.11');
    expect(items[7]!.text).toContain('вс 29.11');
    expect(items[3]!.text).toContain('карусель,'); // Wednesday, next to the Wednesday clip
    expect(store.counts().proposed).toBe(8);
  });

  it('scheduled run is skipped when the week already has a pack', async () => {
    const { head, messenger } = setup();
    await head.generatePack();
    const n = messenger.sent.length;
    await head.generatePack();
    expect(messenger.sent).toHaveLength(n);
  });

  it('tells the owner when the LLM is off and creates nothing', async () => {
    const { head, messenger } = setup({ llm: new OffLlm() });
    await head.generatePack(true);
    expect(messenger.sent).toHaveLength(1);
    expect(messenger.sent[0]!.text).toContain('LLM off');
  });

  it('survives a model that returns garbage for one item', async () => {
    let n = 0;
    const llm = new MockLlm((r) => {
      const content = r.messages[0]!.content;
      if (content.includes('Составь карусель')) return 'не json';
      n++;
      return clipJson();
    });
    const { head, messenger, store } = setup({ llm });
    await head.generatePack(true);
    expect(n).toBeGreaterThan(0);
    expect(store.counts().failed).toBe(1);
    expect(messenger.sent.some((m) => m.text.includes('не получился'))).toBe(true);
  });

  it('schemas: tolerant hashtags, duration bounds, slide counts', () => {
    const ok = clipSchema.safeParse({ ...JSON.parse(clipJson()), captions: { ...JSON.parse(clipJson()).captions, instagram: { text: 'a', hashtags: 'x y' } } });
    expect(ok.success && ok.data.captions.instagram.hashtags).toEqual(['#x', '#y']);
    expect(clipSchema.safeParse(JSON.parse(clipJson({ durationSec: 55 }))).success).toBe(false);
    expect(carouselSchema.safeParse({ ...JSON.parse(carouselJson()), slides: [{ title: 'a', lines: ['b'] }] }).success).toBe(false);
  });

  it('lint flags banned constructs, foreign prices and a missing firtech.pro', () => {
    expect(lintText('Это не бот, это сотрудник. firtech.pro')).toContain('оборот «это не X»');
    expect(lintText('Бот за $99. firtech.pro').some((i) => i.startsWith('цена не из справки'))).toBe(true);
    expect(lintText('Бот от $250. firtech.pro')).toEqual([]);
    expect(lintText('Просто текст')).toContain('нет firtech.pro в призыве');
  });

  it('splits platform sections of an approved text', () => {
    const { body, sections } = splitPlatforms('Тело\n\n== Instagram ==\nig\n#a\n\n== Shorts ==\nsh');
    expect(body).toBe('Тело');
    expect(sections).toEqual({ instagram: 'ig\n#a', shorts: 'sh' });
  });

  it('replacePart swaps one section and rebuilds the markers', () => {
    const t = 'Тело\n\n== Instagram ==\nig\n\n== TikTok ==\ntt';
    expect(replacePart(t, 'tiktok', 'новый')).toBe('Тело\n\n== Instagram ==\nig\n\n== TikTok ==\nновый');
    expect(replacePart(t, 'shorts', 'x')).toBeNull();
    expect(replacePart(t, 'script', 'Новое тело')).toBe('Новое тело\n\n== Instagram ==\nig\n\n== TikTok ==\ntt');
  });
});

describe('cadence', () => {
  it('ISO week numbers', () => {
    expect(isoWeek('2026-11-23')).toBe(48);
    expect(isoWeek('2026-11-30')).toBe(49);
    expect(isoWeek('2026-01-01')).toBe(1);
    expect(isoWeek('2027-01-01')).toBe(53);
  });

  it('carousel every other week at 0.5, every week at 1, never at 0', () => {
    const weeks = Array.from({ length: 8 }, (_, i) => 40 + i);
    expect(weeks.map((w) => hasCarousel(w, 0.5))).toEqual([true, false, true, false, true, false, true, false]);
    expect(weeks.every((w) => hasCarousel(w, 1))).toBe(true);
    expect(weeks.some((w) => hasCarousel(w, 0))).toBe(false);
  });

  it('default plan: one clip every day Mon-Sun, carousel on Wednesday in an even week', () => {
    const even = buildPackPlan('2026-11-23');
    expect(even.filter((p) => p.type === 'clip').map((p) => p.day)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(even).toHaveLength(8);
    expect(buildPackPlan('2026-11-30')).toHaveLength(7);
    expect(DEFAULT_CADENCE).toEqual({ clipsPerWeek: 7, carouselsPerWeek: 0.5 });
  });

  it('fewer clips are spread over the week; the carousel takes a free day', () => {
    const plan = buildPackPlan('2026-11-23', { clipsPerWeek: 3, carouselsPerWeek: 1 });
    expect(plan.filter((p) => p.type === 'clip').map((p) => p.day)).toEqual([0, 2, 4]);
    expect(plan.find((p) => p.type === 'carousel')!.day).toBe(3);
  });

  it('config of the head limits the pack', async () => {
    const { head, store } = setup();
    (head as unknown as { d: { cfg: Record<string, number> } }).d.cfg.clipsPerWeek = 3;
    (head as unknown as { d: { cfg: Record<string, number> } }).d.cfg.carouselsPerWeek = 0;
    await head.generatePack(true);
    expect(store.counts().proposed).toBe(3);
  });
});
