import { describe, expect, it, vi } from 'vitest';
import { assumptionsFor, gapsOf, isBlocking, MAX_QUESTIONS, questionsFor, questionsMessage } from '../src/clarify.js';
import { siteSlots } from '../src/client/site-slots.js';

const lead = (o: Partial<{ niche: string; task: string; service: string; estimate: string }> = {}) => ({ niche: '', task: '', service: 'unknown', estimate: '', ...o });

describe('gaps of a cabinet lead', () => {
  it('names what is missing: scope, niche, goal, channel, always in that order', () => {
    expect(gapsOf(lead({ task: 'Хочу что-то для бизнеса' }))).toEqual(['scope', 'niche', 'goal', 'channel']);
    expect(gapsOf(lead({ service: 'bots', task: 'Нужен бот для записи клиентов в барбершоп, они пишут в Instagram', niche: 'барбершоп' }))).toEqual([]);
    expect(gapsOf(lead({ service: 'bots', task: 'Нужен бот для салона' }))).toEqual(['goal', 'channel']);
    // a chosen product counts as the scope; the words of the builder's estimate count as the niche, the goal and the channel
    expect(gapsOf(lead({ task: 'форма: bundle', estimate: 'Ниша: кафе\nЦели: заявки, запись клиентов\nКаналы: Telegram' }), { product: 'Бот-администратор' })).toEqual([]);
    expect(gapsOf(lead({ service: 'other' }), { message: 'ресторан, нужен приём заказов' })).toEqual(['scope', 'channel']);
  });

  it('only scope, or niche and goal together, hold the КП back; a missing channel alone never does', () => {
    expect(isBlocking(['channel'])).toBe(false);
    expect(isBlocking(['goal', 'channel'])).toBe(false);
    expect(isBlocking(['niche', 'channel'])).toBe(false);
    expect(isBlocking(['niche', 'goal'])).toBe(true);
    expect(isBlocking(['scope'])).toBe(true);
  });

  it('at most three questions, in the language of the lead; the message names the 24 hours and the assumptions', () => {
    const q = questionsFor(['scope', 'niche', 'goal', 'channel'], 'ru');
    expect(q).toHaveLength(MAX_QUESTIONS);
    expect(q[0]).toMatch(/Что именно вам нужно/);
    expect(questionsFor(['channel'], 'en')[0]).toMatch(/Where do clients write to you/);
    expect(questionsMessage('ru', 'Рустам', q)).toMatch(/^Здравствуйте, Рустам!.*вопросы:\n1\. .*\n2\. .*\n3\. /s);
    expect(questionsMessage('en', '', q.slice(0, 1))).toMatch(/^Hello! .*this question:\n1\. /s);
    expect(assumptionsFor(['scope', 'niche', 'goal', 'channel'])).toHaveLength(3);
  });
});

describe('the site\'s free slots for the call offer', () => {
  const NOW = Date.UTC(2026, 10, 22, 7, 0);
  const day = { timeZone: 'Asia/Dushanbe', days: [{ date: '2026-11-23', slots: ['2026-11-23T05:00:00.000Z', '2026-11-23T05:30:00.000Z'] }, { date: '2026-11-22', slots: ['2026-11-22T06:00:00.000Z'] }] };

  it('reads /api/slots, drops the past, sorts, caches for a minute', async () => {
    const fetcher = vi.fn(() => Promise.resolve(Response.json(day)));
    const slots = siteSlots('https://firtech.pro/', fetcher as unknown as typeof fetch, () => NOW);
    expect(await slots()).toEqual([Date.UTC(2026, 10, 23, 5, 0), Date.UTC(2026, 10, 23, 5, 30)]);
    await slots();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((fetcher.mock.calls[0] as unknown as [string])[0]).toBe('https://firtech.pro/api/slots');
  });

  it('an unreachable or broken site is an empty list, never an error', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await siteSlots('https://firtech.pro', (() => Promise.reject(new Error('down'))) as unknown as typeof fetch, () => NOW)()).toEqual([]);
      expect(await siteSlots('https://firtech.pro', (() => Promise.resolve(new Response('x', { status: 503 }))) as unknown as typeof fetch, () => NOW)()).toEqual([]);
      expect(await siteSlots('https://firtech.pro', (() => Promise.resolve(Response.json({ nonsense: true }))) as unknown as typeof fetch, () => NOW)()).toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
