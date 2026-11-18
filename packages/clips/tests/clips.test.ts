import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ClipScript, fromContentMaker, slugify } from '../src/schema';
import { buildTimeline, chunkLines, musicVolume, wordTimings } from '../src/timing';

const item = {
  title: 'ИИ-приёмщик, от $300',
  hook: 'Клиент пишет в 2 ночи',
  durationSec: 30,
  scenes: [
    { voice: 'Раз два три', subtitle: 'Раз' },
    { voice: 'Четыре пять', subtitle: 'Два' },
  ],
  cta: 'Ссылка: firtech.pro',
  captions: { instagram: { text: 'x', hashtags: ['#a', '#b'] } },
};

describe('schema', () => {
  it('parses the sample script', () => {
    const raw = JSON.parse(readFileSync(new URL('../samples/receptionist.json', import.meta.url), 'utf8'));
    const s = ClipScript.parse(raw);
    expect(s.scenes.length).toBeGreaterThanOrEqual(4);
    expect(s.theme).toBe('dark');
  });
  it('rejects empty scenes and bad slugs', () => {
    expect(ClipScript.safeParse({ title: 't', hook: 'h', scenes: [], cta: 'c' }).success).toBe(false);
    expect(ClipScript.safeParse({ slug: 'Bad Slug', title: 't', hook: 'h', scenes: [{ voice: 'v', subtitle: 's' }], cta: 'c' }).success).toBe(false);
  });
  it('adapts a content-maker clip', () => {
    const s = fromContentMaker(item);
    expect(s.slug).toBe('ii-priemschik-ot-300');
    expect(s.scenes).toEqual(item.scenes);
    expect(s.captions).toBeDefined();
  });
  it('slugify handles cyrillic and empty input', () => {
    expect(slugify('Щи и борщ!')).toBe('schi-i-borsch');
    expect(slugify('!!!')).toBe('clip');
  });
});

describe('timing', () => {
  it('lays segments back to back with a gap and an end card', () => {
    const t = buildTimeline([2, 3], 1, 30);
    expect(t.segments.map((s) => [s.startFrame, s.durationFrames])).toEqual([
      [0, 69],
      [69, 99],
      [168, 66],
    ]);
    expect(t.endCardFrame).toBe(168);
    expect(t.totalFrames).toBe(234);
  });
  it('spreads words over the voice by length', () => {
    const w = wordTimings('аа бббббб вв', 100);
    expect(w[0]!.startFrame).toBe(0);
    expect(w[1]!.startFrame).toBeGreaterThan(w[0]!.startFrame);
    expect(w[2]!.startFrame).toBeLessThan(100);
  });
  it('chunks lines evenly', () => {
    const lines = chunkLines(wordTimings('a1 b2 c3 d4 e5', 50), 4);
    expect(lines.map((l) => l.length)).toEqual([3, 2]);
  });
  it('ducks music under the voice and fades at the end', () => {
    const t = buildTimeline([2], 1, 30);
    expect(musicVolume(30, t)).toBeCloseTo(0.07);
    expect(musicVolume(t.totalFrames, t)).toBe(0);
    expect(musicVolume(t.totalFrames - 1, t, 0.12, 0.07)).toBeLessThan(0.01);
  });
});
