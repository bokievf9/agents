import { MockLlm } from '@fir/core';
import { describe, expect, it } from 'vitest';
import { carouselSchema, clipSchema, splitPlatforms } from '../src/format.js';
import { lintText } from '../src/lint.js';
import { OWNER, OffLlm, carouselJson, clipJson, setup } from './helpers.js';

describe('pack generation', () => {
  it('sends 3 clips and 1 carousel, one numbered message each, with approval buttons', async () => {
    const { head, messenger, store } = setup();
    await head.generatePack(true);
    const items = messenger.sent.filter((m) => m.buttons);
    expect(items).toHaveLength(4);
    expect(items.every((m) => m.chatId === OWNER && m.buttons![0]!.length === 3)).toBe(true);
    expect(items[0]!.text).toContain('материал 1 из 4');
    expect(items[3]!.text).toContain('материал 4 из 4');
    expect(items.filter((m) => m.text.includes('клип,'))).toHaveLength(3);
    expect(items.filter((m) => m.text.includes('карусель,'))).toHaveLength(1);
    expect(items[0]!.text).toContain('Instagram + TikTok + Shorts');
    expect(items[0]!.text).toContain('вт 24.11');
    expect(store.counts().proposed).toBe(4);
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
});
