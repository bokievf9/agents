import { describe, expect, it } from 'vitest';
import { haveFlags, parseHave } from '../src/client/texts.js';

describe('step 4: domain and hosting', () => {
  it('reads free text with a «нет» for each word separately', () => {
    expect(parseHave('домен есть, хостинга нет')).toBe('domain');
    expect(parseHave('хостинг есть, домена нет')).toBe('hosting');
    expect(parseHave('есть домен и хостинг')).toBe('both');
    expect(parseHave('домен и хостинг есть')).toBe('both');
    expect(parseHave('нет домена и нет хостинга')).toBe('none');
    expect(parseHave('нет')).toBe('none');
    expect(parseHave('оба есть')).toBe('both');
    expect(parseHave('не знаю')).toBe('unknown');
    expect(parseHave('что это?')).toBe('unknown');
    expect(parseHave('I have a domain but no hosting')).toBe('domain');
  });

  it('turns a choice into the lead flags; unknown stays null', () => {
    expect(haveFlags('both')).toEqual({ hasDomain: true, hasHosting: true });
    expect(haveFlags('domain')).toEqual({ hasDomain: true, hasHosting: false });
    expect(haveFlags('none')).toEqual({ hasDomain: false, hasHosting: false });
    expect(haveFlags('unknown')).toEqual({ hasDomain: null, hasHosting: null });
  });
});
