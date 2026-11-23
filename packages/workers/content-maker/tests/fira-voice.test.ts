import { describe, expect, it } from 'vitest';
import { BRAND_FIRA_ASSET, FIRA_SIGNATURE, parseReel, signCaption, signCaptions } from '../src/index.js';

describe('Fira voice: caption signature and the brand slot', () => {
  it('signs once, at the end, hashtags untouched', () => {
    expect(FIRA_SIGNATURE).toBe('Фира · Fir Tech');
    expect(signCaption('Текст подписи.  ')).toBe(`Текст подписи.\n\n${FIRA_SIGNATURE}`);
    expect(signCaption(signCaption('Текст'))).toBe(`Текст\n\n${FIRA_SIGNATURE}`);
    const c = signCaptions({ instagram: { text: 'IG', hashtags: ['#a'] }, shorts: { title: 'T', text: 'S', hashtags: ['#b'] } });
    expect(c).toEqual({ instagram: { text: `IG\n\n${FIRA_SIGNATURE}`, hashtags: ['#a'] }, shorts: { title: 'T', text: `S\n\n${FIRA_SIGNATURE}`, hashtags: ['#b'] } });
  });

  it('the reel template carries the brand slot only when asked', () => {
    const text = 'Клип, 30 с: Т\nХук (первая секунда): Х\n\n1. Голос: раз\n   Субтитр: р\n\nCTA: firtech.pro';
    expect(parseReel(text)!.brand).toBeUndefined();
    expect(parseReel(text, { fira: true, asset: BRAND_FIRA_ASSET })!.brand).toEqual({ fira: true, asset: 'brand/fira' });
  });
});
