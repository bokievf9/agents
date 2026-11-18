import { MockLlm } from '@fir/core';
import { describe, expect, it } from 'vitest';
import { detectLang, guessDeadline, guessNiche, hasMoney, isPriceQuestion, scoreLead } from '../src/text.js';
import { KIND_PRICE, KIND_REPLY, leadStoreFor, nextSlots, webLeadSchema } from '../src/worker.js';
import { NOW, setup, webLead } from './helpers.js';

describe('classification (LLM off)', () => {
  it('guesses niche and deadline from the text, scores by rules', () => {
    expect(guessNiche('нужен бот для барбершопа')).toBe('салон красоты / барбершоп');
    expect(guessNiche('hello')).toBe('');
    expect(guessDeadline('нужно за 2 недели')).toMatch(/2 недел/);
    expect(scoreLead({ niche: '', task: '', deadline: '', budget: '', priceAsked: false, chosenSlot: null })).toBe('cold');
    expect(scoreLead({ niche: 'x', task: 'y', deadline: 'срочно', budget: '', priceAsked: false, chosenSlot: null })).toBe('hot');
    expect(detectLang('Hello, I need a website')).toBe('en');
    expect(detectLang('Привет, нужен сайт')).toBe('ru');
    expect(isPriceQuestion('Сколько стоит сайт?')).toBe(true);
    expect(isPriceQuestion('Нужен сайт')).toBe(false);
    expect(hasMoney('цена 300 долларов')).toBe(true);
    expect(hasMoney('до пятницы')).toBe(false);
  });
});

describe('slots', () => {
  it('are the next two working days at 11:00 and 15:00 Tashkent, skipping weekends', () => {
    const [a, b] = nextSlots(NOW, 'Asia/Tashkent', ['11:00', '15:00']);
    expect(new Date(a).toISOString()).toBe('2026-11-19T06:00:00.000Z'); // Thu 11:00 +05
    expect(new Date(b).toISOString()).toBe('2026-11-20T10:00:00.000Z'); // Fri 15:00
    const fri = Date.UTC(2026, 10, 20, 7, 0);
    const [c, d] = nextSlots(fri, 'Asia/Tashkent', ['11:00', '15:00']);
    expect(new Date(c).toISOString()).toBe('2026-11-23T06:00:00.000Z'); // Mon
    expect(new Date(d).toISOString()).toBe('2026-11-24T10:00:00.000Z');
  });
});

describe('lead task (LLM off)', () => {
  it('makes a card, a temperature and a first reply with two slots, stages one approval', async () => {
    const r = setup();
    const res = await r.run(r.task());
    expect(res.ok).toBe(true);
    expect(res.result).toContain('Лид #1');
    expect(res.result).toContain('Контакт: @dilnoza');
    expect(res.result).toContain('Ниша: салон красоты / барбершоп');
    expect(res.result).toMatch(/ГОРЯЧИЙ|ТЁПЛЫЙ/);
    expect(res.result).toContain('связаться вручную');
    expect(r.staged).toHaveLength(1);
    const s = r.staged[0]!;
    expect(s.kind).toBe(KIND_REPLY);
    expect(s.payload).toMatchObject({ leadId: 1, contact: '@dilnoza' });
    expect(String(s.payload.text)).toContain('Здравствуйте, Dilnoza');
    expect(String(s.payload.text)).toContain('1)');
    expect(String(s.payload.text)).toContain('2)');
    expect(leadStoreFor(r.ctx).get(1)).toMatchObject({ niche: 'салон красоты / барбершоп', slots: expect.any(Array) });
  });

  it('English client gets an English reply; a slot picked in the form is taken as the call', async () => {
    const r = setup();
    const slot = new Date(Date.UTC(2026, 10, 19, 6, 0)).toISOString();
    await r.run(r.task(webLead({ locale: 'en', message: 'I need a website for my dental clinic', slot })));
    const text = String(r.staged[0]!.payload.text);
    expect(text).toMatch(/^Hello, Dilnoza/);
    expect(text).toContain('Noted the call');
    expect(leadStoreFor(r.ctx).get(1)!.chosenSlot).toBe(Date.parse(slot));
  });

  it('a price question adds a locked price draft with placeholders and a holding sentence in the reply', async () => {
    const r = setup();
    await r.run(r.task(webLead({ message: 'Сколько стоит бот для салона?' })));
    expect(r.staged.map((s) => s.kind)).toEqual([KIND_REPLY, KIND_PRICE]);
    expect(String(r.staged[0]!.payload.text)).toContain('Стоимость и сроки уточню');
    expect(String(r.staged[1]!.payload.text)).toMatch(/\[цена\]/);
    expect(leadStoreFor(r.ctx).get(1)!.priceAsked).toBe(true);
  });

  it('is idempotent per task: a rework reuses the lead row', async () => {
    const r = setup();
    const t = r.task();
    await r.run(t);
    await r.run({ ...t, meta: { ...t.meta, feedback: 'короче' } });
    expect(leadStoreFor(r.ctx).count()).toBe(1);
  });

  it('fails clearly on a task without a lead or with another action', async () => {
    const r = setup();
    expect((await r.run(r.task({ name: '' }))).ok).toBe(false);
    expect((await r.worker.run({ ...r.task(), meta: { action: 'x' } }, r.ctx)).ok).toBe(false);
  });
});

describe('with an LLM (mock)', () => {
  it('uses model extraction, retries garbage, and drops a draft that names money or misses the slots', async () => {
    let extract = 0;
    const llm = new MockLlm((req) => {
      if (req.tier === 'haiku') {
        extract++;
        return extract === 1 ? 'не знаю' : '{"niche":"стоматология","task":"бот для записи","deadline":"до конца месяца"}';
      }
      return 'Здравствуйте! Сделаем за 300 долларов.';
    });
    const r = setup({ llm });
    await r.run(r.task(webLead({ message: 'Мы стоматология, нужен бот записи' })));
    expect(extract).toBe(2);
    expect(leadStoreFor(r.ctx).get(1)).toMatchObject({ niche: 'стоматология', task: 'бот для записи' });
    expect(String(r.staged[0]!.payload.text)).not.toContain('300');
  });

  it('keeps a valid model reply that has both slots inside', async () => {
    const llm = new MockLlm((req) => {
      if (req.tier === 'haiku') return '{"niche":"салон","task":"бот","deadline":""}';
      const lines = req.system.split('\n').filter((l) => /^[12]\) /.test(l));
      return `Здравствуйте, Dilnoza! Спасибо, поняли задачу: бот для салона.\n${lines.join('\n')}`;
    });
    const r = setup({ llm });
    await r.run(r.task());
    const text = String(r.staged[0]!.payload.text);
    expect(text).toContain('поняли задачу');
    expect(text).toContain('1) ');
    expect(text).toContain('2) ');
  });

  it('a price draft without placeholders or with money falls back to the template', async () => {
    const llm = new MockLlm((req) => (req.tier === 'haiku' ? 'x' : 'Это стоит 300 долларов.'));
    const r = setup({ llm });
    await r.run(r.task(webLead({ message: 'Сколько стоит?' })));
    expect(String(r.staged[1]!.payload.text)).toContain('[цена]');
  });
});

describe('approval kinds', () => {
  it('the reply starts at REPLY_LEVEL (default 1), prices are locked at 0', () => {
    expect(setup().specs[KIND_REPLY]).toMatchObject({ initialLevel: 1 });
    expect(setup({ replyLevel: 0 }).specs[KIND_REPLY]).toMatchObject({ initialLevel: 0 });
    expect(setup().specs[KIND_PRICE]).toMatchObject({ initialLevel: 0, locked: true });
  });

  it('delivers an approved reply; a price with a placeholder never goes out, a filled one does and is remembered', async () => {
    const r = setup();
    await r.run(r.task(webLead({ message: 'Сколько стоит?' })));
    await r.specs[KIND_REPLY]!.execute(r.staged[0]!.payload, 1);
    expect(r.delivered).toHaveLength(1);
    await expect(r.specs[KIND_PRICE]!.execute(r.staged[1]!.payload, 2)).rejects.toThrow(/placeholder/);
    expect(r.delivered).toHaveLength(1);
    await r.specs[KIND_PRICE]!.execute({ ...r.staged[1]!.payload, text: 'Бот для салона: от $300, срок 2 недели.' }, 2);
    expect(r.delivered.at(-1)).toMatchObject({ kind: KIND_PRICE, contact: '@dilnoza' });
    expect(leadStoreFor(r.ctx).get(1)!.priceApproved).toBe(true);
  });
});

describe('form schema', () => {
  it('requires name and contact, fills defaults', () => {
    expect(webLeadSchema.safeParse({ name: '', contact: 'abc' }).success).toBe(false);
    expect(webLeadSchema.parse({ name: 'A', contact: '@abc' })).toMatchObject({ service: 'unknown', locale: 'ru', message: '' });
  });
});
