import { MockLlm } from '@fir/core';
import { describe, expect, it } from 'vitest';
import { builderLinkIn, deriveEnrichment, detectLang, enrichmentLines, guessDeadline, guessNiche, hasMoney, isPriceQuestion, scoreLead } from '../src/text.js';
import { parseEnrichment } from '../src/store.js';
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

describe('product in the lead', () => {
  it('is accepted by the schema, shown on the lead card and used in the reply context', async () => {
    const parsed = webLeadSchema.parse({ name: 'A', contact: '@abcde', product: 'Бот-администратор для услуг' });
    expect(parsed.product).toBe('Бот-администратор для услуг');
    expect(webLeadSchema.parse({ name: 'A', contact: '@abcde' }).product).toBe('');
    const r = setup();
    const res = await r.run(r.task(webLead({ product: 'Бот-администратор для услуг' })));
    expect(res.result).toContain('Продукт: Бот-администратор для услуг');
    expect(String(r.staged[0]!.summary)).toContain('Продукт: Бот-администратор для услуг');
    const none = setup();
    expect((await none.run(none.task())).result).not.toContain('Продукт:');
  });
});

describe('copy of a lead the site bot already sent', () => {
  it('the card says so when the site sets telegramSent; without the flag, or from the client bot, it does not', async () => {
    const r = setup();
    const copy = await r.run(r.task(webLead({ telegramSent: true })));
    expect(copy.result).toContain('копия: бот сайта тоже прислал');
    const plain = setup();
    expect((await plain.run(plain.task())).result).not.toContain('копия');
    const bot = setup();
    expect((await bot.run(bot.task(webLead({ telegramSent: true, chatId: 77 })))).result).not.toContain('копия');
    expect(webLeadSchema.parse({ name: 'A', contact: '@abcde', telegramSent: true }).telegramSent).toBe(true);
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


describe('what the client already has: domain and hosting', () => {
  it('an explicit answer (the bot\'s step 4) is stored; the site\'s scope sentence in the builder summary is read; no signal stays unknown', async () => {
    const asked = setup();
    await asked.run(asked.task(webLead({ hasDomain: true, hasHosting: false })));
    expect(leadStoreFor(asked.ctx).get(1)).toMatchObject({ hasDomain: true, hasHosting: false });
    const site = setup();
    await site.run(site.task(webLead({ estimate: 'Лендинг: одна страница\nИтого: $150\nДомен и хостинг у вас уже есть, используем их; платные сторонние сервисы' })));
    expect(leadStoreFor(site.ctx).get(1)).toMatchObject({ hasDomain: true, hasHosting: true, estimate: expect.stringContaining('Итого') });
    const none = setup();
    await none.run(none.task());
    expect(leadStoreFor(none.ctx).get(1)).toMatchObject({ hasDomain: null, hasHosting: null, estimate: '' });
    expect(webLeadSchema.parse({ name: 'A', contact: '@abcde', hasDomain: true }).hasDomain).toBe(true);
  });

  it('an old database gets the new columns without losing rows', () => {
    const r = setup();
    leadStoreFor(r.ctx);
    const cols = (r.ctx.db.prepare('PRAGMA table_info(li_leads)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['estimate', 'has_domain', 'has_hosting']));
  });
});

describe('enrichment of a lead (ИИ-менеджер заявок 2.0)', () => {
  const own = { summary: ['Бизнес: салон красоты; задача: вечерние заявки.', 'Подходит: Бот-администратор; каналы: instagram.', 'Предложено: сборку по ссылке.'], productFamily: 'admin', niche: 'салон красоты', intentScore: 64, builderLink: '/ru/builder?b=k.salon~p.adminbot' };

  it('the conversation\'s own enrichment is kept on the lead and printed on the card', async () => {
    const r = setup();
    const res = await r.run(r.task(webLead({ enrichment: own, handoff: true })));
    const lead = leadStoreFor(r.ctx).byTask(1)!;
    expect(lead.enrichment).toEqual(own);
    expect(res.result).toContain('Разговор:\n  Бизнес: салон красоты; задача: вечерние заявки.');
    expect(res.result).toContain('Семейство продукта: admin');
    expect(res.result).toContain('Намерение: 64/100');
    expect(res.result).toContain('Сборка, которую предложил приёмщик: /ru/builder?b=k.salon~p.adminbot');
    expect(String(r.staged[0]!.summary)).toContain('Намерение: 64/100');
  });

  it('a lead without one gets it derived: its first lines, the service as the family, the niche, an intent from the temperature, the link of its estimate', async () => {
    const r = setup();
    await r.run(r.task(webLead({ service: 'bots', message: 'Нужен бот для салона, срочно', estimate: 'Пакет: Бот\nСборка: https://firtech.pro/en/builder?b=k.salon~p.adminbot\nИтого: $300' })));
    const e = leadStoreFor(r.ctx).byTask(1)!.enrichment!;
    expect(e.summary).toEqual(['Нужен бот для салона, срочно', 'Пакет: Бот', 'Итого: $300']);
    expect(e).toMatchObject({ productFamily: 'bot', niche: 'салон красоты / барбершоп', builderLink: '/en/builder?b=k.salon~p.adminbot' });
    expect(e.intentScore).toBeGreaterThan(0);
    expect(deriveEnrichment({ message: '', estimate: '', service: 'unknown', product: '', niche: '', temperature: 'cold' })).toEqual({ summary: [], productFamily: '', niche: '', intentScore: 25, builderLink: '' });
    expect(builderLinkIn('see /ru/builder/estimate?b=k.cafe now')).toBe('/ru/builder/estimate?b=k.cafe');
    expect(enrichmentLines(null)).toEqual([]);
  });

  it('the schema bounds the enrichment; an older row without the column reads as null', () => {
    expect(webLeadSchema.safeParse({ name: 'A', contact: '@abcde', enrichment: { ...own, intentScore: 140 } }).success).toBe(false);
    expect(webLeadSchema.parse({ name: 'A', contact: '@abcde', enrichment: { intentScore: 5 } }).enrichment).toEqual({ summary: [], productFamily: '', niche: '', intentScore: 5, builderLink: '' });
    expect(parseEnrichment(null)).toBeNull();
    expect(parseEnrichment('not json')).toBeNull();
    expect(parseEnrichment(JSON.stringify({ intentScore: 500, summary: ['a', 'b', 'c', 'd'] }))).toMatchObject({ intentScore: 100, summary: ['a', 'b', 'c'] });
  });

  it('a clarifying question is a delivery that says so', async () => {
    const r = setup();
    await r.specs[KIND_REPLY]!.execute({ text: 'Вопрос 1', leadId: 1, contact: '@x', name: 'X', clarify: true }, {} as never);
    expect(r.delivered[0]).toMatchObject({ clarify: true, text: 'Вопрос 1' });
  });
});
