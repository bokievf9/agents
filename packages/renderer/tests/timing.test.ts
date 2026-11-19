import { describe, expect, it } from 'vitest';
import { buildTimeline, estimateVoiceSec, MIN_TOTAL_SECONDS } from '../src/timing.js';
import { chunkPhrases, phraseAt, timePhrases } from '../src/subtitles.js';
import { wavSeconds } from '../src/wav.js';
import { speakable } from '../src/tts.js';

const sec = (frames: number) => frames / 30;

describe('scene timing from WAV lengths', () => {
  it('scene = max(voice + 0.4 s, the script seconds per scene), CTA after the scenes', () => {
    // 28 s script, CTA voice 2.0 s -> CTA card 3 s (min), 25 s over 4 scenes = 6.25 s each
    const t = buildTimeline([{ voiceSec: 3 }, { voiceSec: 7.1 }, { voiceSec: 5 }, { voiceSec: 6 }], 2, 28);
    const d = t.segments.map((s) => sec(s.durationFrames));
    expect(d[0]).toBeCloseTo(6.25, 1); // script seconds win over 3.4
    expect(d[1]).toBeCloseTo(7.5, 1); // voice 7.1 + 0.4 wins
    expect(d[2]).toBeCloseTo(6.25, 1);
    expect(d[4]).toBeCloseTo(3, 1);
    expect(t.segments.map((s) => s.kind)).toEqual(['scene', 'scene', 'scene', 'scene', 'cta']);
    expect(t.segments[1]!.startFrame).toBe(t.segments[0]!.durationFrames);
    expect(t.totalFrames).toBe(t.segments.reduce((n, s) => n + s.durationFrames, 0));
    expect(t.segments[1]!.voiceFrames).toBe(Math.ceil(7.1 * 30));
  });
  it('a long CTA voice stretches the CTA card to voice + 0.4 s', () => {
    const t = buildTimeline([{ voiceSec: 4 }, { voiceSec: 4 }], 5, 20);
    expect(sec(t.segments.at(-1)!.durationFrames)).toBeCloseTo(5.4, 1);
  });
  it('without voice the script seconds rule; short reels are stretched to 15 s', () => {
    const t = buildTimeline([{ voiceSec: null }, { voiceSec: null }], null, 8);
    expect(sec(t.totalFrames)).toBeCloseTo(MIN_TOTAL_SECONDS, 1);
    expect(t.segments[0]!.voiceFrames).toBe(0);
  });
  it('a 28 s script with short voices lands near 28 s', () => {
    const t = buildTimeline(Array.from({ length: 5 }, () => ({ voiceSec: 3 })), 2, 28);
    expect(sec(t.totalFrames)).toBeCloseTo(28, 0);
  });
  it('estimates speaking time from text length', () => {
    expect(estimateVoiceSec('a'.repeat(140))).toBeCloseTo(10, 5);
    expect(estimateVoiceSec('')).toBe(1);
  });
});

describe('subtitle chunking', () => {
  it('splits by sentences and keeps phrases within 5 words', () => {
    const c = chunkPhrases('Клиент пишет в два часа ночи. Вы спите, а заявка остывает.');
    expect(c.length).toBeGreaterThanOrEqual(3);
    expect(c.every((p) => p.split(' ').length <= 5)).toBe(true);
    expect(c.join(' ')).toBe('Клиент пишет в два часа ночи. Вы спите, а заявка остывает.');
  });
  it('does not leave a one-word phrase after a comma', () => {
    const c = chunkPhrases('Да, но это работает.');
    expect(c).toEqual(['Да, но это работает.']);
  });
  it('times phrases across the voice length in proportion to characters', () => {
    const p = timePhrases('Привет мир. Это длинная вторая фраза здесь.', 300);
    expect(p[0]!.startFrame).toBe(0);
    expect(p.at(-1)!.endFrame).toBe(300);
    for (let i = 1; i < p.length; i++) expect(p[i]!.startFrame).toBe(p[i - 1]!.endFrame);
    expect(p[1]!.endFrame - p[1]!.startFrame).toBeGreaterThan(p[0]!.endFrame - p[0]!.startFrame);
    expect(phraseAt(p, 0)).toBe(p[0]);
    expect(phraseAt(p, 299)).toBe(p.at(-1));
  });
  it('returns nothing for empty text', () => {
    expect(timePhrases('  ', 100)).toEqual([]);
  });
});

describe('wav and speech text', () => {
  const wav = (seconds: number, dataSize?: number) => {
    const rate = 22050 * 2;
    const n = Math.round(seconds * rate);
    const b = Buffer.alloc(44 + n);
    b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16);
    b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(22050, 24); b.writeUInt32LE(rate, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
    b.write('data', 36); b.writeUInt32LE(dataSize ?? n, 40);
    return b;
  };
  it('reads the length from the header, also with a streaming data size', () => {
    expect(wavSeconds(wav(3.5))).toBeCloseTo(3.5, 3);
    expect(wavSeconds(wav(2, 0xffffffff))).toBeCloseTo(2, 3);
    expect(() => wavSeconds(Buffer.from('nope'))).toThrow('not a WAV');
  });
  it('spells out the handle and the domain', () => {
    expect(speakable('Пишите @firtech_bot или на firtech.pro #боты')).toBe('Пишите бот фир тек или на фир тек точка про боты');
  });
});
