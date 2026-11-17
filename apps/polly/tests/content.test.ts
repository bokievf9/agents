import { describe, expect, it } from 'vitest';
import { content } from './helpers.js';

describe('content (zh)', () => {
  it('has at least 300 words by topic and 14 lessons', () => {
    expect(content.words.size).toBeGreaterThanOrEqual(300);
    expect(content.topics.length).toBeGreaterThanOrEqual(8);
    expect(content.lessons).toHaveLength(14);
  });

  it('gives every word hanzi, pinyin with tone marks (or a neutral syllable) and a Russian translation', () => {
    for (const w of content.words.values()) {
      expect(w.h).toMatch(/\p{Script=Han}/u);
      expect(w.p).toMatch(/^[\p{L} ]+$/u);
      expect(w.r).toMatch(/[А-Яа-яЁё]|Alipay|WeChat/);
    }
  });

  it('covers the six situations and gives each lesson 3 new words, a dialogue and 3 questions', () => {
    const situations = new Set(content.lessons.map((l) => l.situation));
    for (const s of ['taxi', 'cafe', 'acquaintance', 'shop', 'hotel', 'road']) expect(situations.has(s as never)).toBe(true);
    const seen = new Set<string>();
    for (const l of content.lessons) {
      expect(l.words).toHaveLength(3);
      for (const h of l.words) {
        expect(seen.has(h)).toBe(false);
        seen.add(h);
        expect(content.words.get(h)?.e?.p).toBeTruthy();
      }
      expect(l.dialog.lines.length).toBeGreaterThanOrEqual(4);
      expect(l.quiz).toHaveLength(3);
      expect(l.dialog.lines.some((x) => x.card)).toBe(true);
    }
  });

  it('keeps the tone drill and the placement test consistent', () => {
    for (const set of content.tones) for (const i of set.items) expect(set.forms[i.tone - 1]).toBeTruthy();
    expect(content.placement.words).toHaveLength(10);
    expect(content.placement.phrases).toHaveLength(3);
    expect(content.placement.pinyin).toHaveLength(3);
  });

  it('uses no long dashes in copy', () => {
    const all = JSON.stringify([...content.words.values(), content.lessons]);
    expect(all).not.toMatch(/[—–]/);
  });
});
