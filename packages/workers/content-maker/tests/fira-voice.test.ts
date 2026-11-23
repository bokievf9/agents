import { describe, expect, it } from 'vitest';
import { BRAND_FIRA_ASSET, FIRA_SIGNATURE, firaVoiceOf, parseReel, signCaptions } from '../src/index.js';

describe('Fira voice: one switch, the brand slot', () => {
  it('signCaptions signs every platform caption once, hashtags untouched', () => {
    const c = signCaptions({ title: 't', captions: { instagram: { text: 'IG', hashtags: ['#a'] }, shorts: { title: 'T', text: 'S', hashtags: ['#b'] } } });
    expect(c.captions).toEqual({ instagram: { text: `IG\n${FIRA_SIGNATURE}`, hashtags: ['#a'] }, shorts: { title: 'T', text: `S\n${FIRA_SIGNATURE}`, hashtags: ['#b'] } });
    expect(signCaptions(c)).toEqual(c);
  });

  it('firaVoiceOf: the rules toggle (ctx.brand) and CONTENT_FIRA; no context means on', () => {
    expect(firaVoiceOf(undefined, undefined)).toBe(true);
    expect(firaVoiceOf({ firaVoice: true }, 'on')).toBe(true);
    expect(firaVoiceOf({ firaVoice: false }, 'on')).toBe(false);
    expect(firaVoiceOf({ firaVoice: true }, 'OFF')).toBe(false);
  });

  it('the reel template carries the brand slot only when asked, next to the bubble caption', () => {
    const text = 'Клип, 30 с: Т\nХук (первая секунда): Х\n\n1. Голос: раз\n   Субтитр: р\n\nCTA: firtech.pro\n\n== Instagram ==\nподпись';
    expect(parseReel(text)!.brand).toBeUndefined();
    expect(parseReel(text, { fira: true, asset: BRAND_FIRA_ASSET })).toMatchObject({ brand: { fira: true, asset: 'brand/fira' }, caption: 'подпись' });
  });
});
