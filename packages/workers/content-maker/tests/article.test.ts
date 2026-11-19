import { describe, expect, it } from 'vitest';
import { AI_TOPICS, ARTICLE_KIND, approveArticle, articleLineOn, articleSchema, contentIssues, contentSchema, faqItems, isAiAsk, slugFromTitle, storeFor, toPublicArticle, uniqueSlug, wordCount } from '../src/index.js';
import { articleLlm, contentOf, enJson, ruJson } from './article-helpers.js';
import { setup } from './helpers.js';

describe('article schema (the site format)', () => {
  it('a valid article parses and passes the site rules in both languages', () => {
    const a = articleSchema.parse({ slug: 'bot-dlya-barber', niche: 'barber', ru: contentOf('ru'), en: contentOf('en') });
    expect(contentIssues(a.ru, 'ru')).toEqual([]);
    expect(contentIssues(a.en, 'en')).toEqual([]);
    expect(wordCount(a.ru)).toBeGreaterThanOrEqual(700);
    expect(faqItems(a.ru)).toBe(3);
    expect(a.ru.description.length).toBeGreaterThanOrEqual(120);
    expect(a.ru.description.length).toBeLessThanOrEqual(160);
  });

  it('rejects a bad slug, a short description and unknown block types', () => {
    expect(articleSchema.safeParse({ slug: 'Bad Slug', niche: 'barber', ru: contentOf('ru'), en: contentOf('en') }).success).toBe(false);
    expect(contentSchema.safeParse(contentOf('ru', { description: 'коротко' })).success).toBe(false);
    expect(contentSchema.safeParse({ ...contentOf('ru'), blocks: [...contentOf('ru').blocks, { type: 'image', src: 'x' }] }).success).toBe(false);
  });

  it('flags long dashes, dollar amounts, percents, AI tells, a wrong FAQ and a missing cta', () => {
    const base = contentOf('ru');
    const withText = (extra: string) => contentSchema.parse({ ...base, blocks: [...base.blocks, { type: 'p', text: extra }] });
    expect(contentIssues(withText('Бот — это удобно'), 'ru')).toContain('ru: длинное тире');
    expect(contentIssues(withText('Бот стоит $250'), 'ru').some((i) => i.includes('доллар'))).toBe(true);
    expect(contentIssues(withText('Рост на 30%'), 'ru').some((i) => i.includes('процент'))).toBe(true);
    expect(contentIssues(withText('Это не бот, а помощник.'), 'ru').length).toBeGreaterThan(0);
    const noCta = contentSchema.parse({ ...base, blocks: base.blocks.filter((b) => b.type !== 'cta') });
    expect(contentIssues(noCta, 'ru').some((i) => i.includes('cta'))).toBe(true);
    const noFaq = contentSchema.parse({ ...base, blocks: base.blocks.slice(0, -2) });
    expect(contentIssues(noFaq, 'ru').some((i) => i.includes('3 вопроса'))).toBe(true);
    const short = contentSchema.parse({ ...base, blocks: [base.blocks[0]!, ...base.blocks.slice(2)] });
    expect(wordCount(short)).toBeLessThan(wordCount(contentSchema.parse(base)));
  });

  it('slugs are ASCII kebab-case from the English title, unique with a numeric suffix', () => {
    expect(slugFromTitle('How a Booking Bot Works: Where to Start!')).toBe('how-a-booking-bot-works-where-to-start');
    expect(slugFromTitle('Café "Bot" для записи')).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(slugFromTitle('Бот')).toBe('ai-article');
    expect(slugFromTitle('x'.repeat(100)).length).toBeLessThanOrEqual(60);
    const taken = new Set(['a-b', 'a-b-2']);
    expect(uniqueSlug('a-b', (s) => taken.has(s))).toBe('a-b-3');
    expect(uniqueSlug('a-b', () => false)).toBe('a-b');
  });

  it('the line follows the weekday: Mon, Wed, Fri, Sun AI, Tue, Thu, Sat niche; «ии» asks for the AI line', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(articleLineOn)).toEqual(['ai', 'niche', 'ai', 'niche', 'ai', 'niche', 'ai']);
    expect(isAiAsk('ИИ')).toBe(true);
    expect(isAiAsk('ai for business')).toBe(true);
    expect(isAiAsk('барбершоп')).toBe(false);
  });
});

describe('article generation', () => {
  it('picks an uncovered niche, writes RU then EN, stores the row and stages an `article` approval', async () => {
    const { worker, ctx, task, staged } = setup({ llm: articleLlm() });
    const res = await worker.run(task({ action: 'article', line: 'niche' }), ctx);
    expect(res.ok).toBe(true);
    expect(staged).toHaveLength(1);
    expect(staged[0]!.kind).toBe(ARTICLE_KIND);
    const row = storeFor(ctx).articles()[0]!;
    expect(row).toMatchObject({ status: 'proposed', slug: 'bot-dlya-barber' });
    const json = JSON.parse(row.json) as { ru: { title: string }; en: { title: string }; niche: string };
    expect(json.ru.title).toBeTruthy();
    expect(json.en.title).toBeTruthy();
    expect(staged[0]!.payload).toMatchObject({ articleId: row.id });
    expect(String(staged[0]!.payload.text).length).toBeLessThan(900);
    expect(staged[0]!.summary).toContain('Разделы:');
    expect(storeFor(ctx).coveredNiches().has(json.niche)).toBe(true);
  });

  it('a second run takes another niche; a named niche is honoured; an unknown one is refused', async () => {
    const { worker, ctx, task } = setup({ llm: articleLlm() });
    await worker.run(task({ action: 'article', line: 'niche' }), ctx);
    await worker.run(task({ action: 'article', line: 'niche' }), ctx);
    const niches = storeFor(ctx).articles().map((a) => a.niche);
    expect(new Set(niches).size).toBe(2);
    const named = await worker.run(task({ action: 'article', niche: 'стоматология' }), ctx);
    expect(named.ok).toBe(true);
    expect(storeFor(ctx).articles().at(-1)!.niche).toBe('dentist');
    const bad = await worker.run(task({ action: 'article', niche: 'космос' }), ctx);
    expect(bad.ok).toBe(false);
  });

  it('feedback reworks the same row and hands the model the remark', async () => {
    const llm = articleLlm();
    const { worker, ctx, task, staged } = setup({ llm });
    await worker.run(task({ action: 'article', niche: 'barber' }), ctx);
    const id = storeFor(ctx).articles()[0]!.id;
    const res = await worker.run(task({ action: 'article', articleId: id, feedback: 'добавь про напоминания' }), ctx);
    expect(res.ok).toBe(true);
    expect(storeFor(ctx).articles()).toHaveLength(1);
    expect(staged).toHaveLength(2);
    expect(llm.calls.some((c) => c.messages[0]!.content.includes('добавь про напоминания'))).toBe(true);
  });

  it('repairs once; a model that keeps failing marks the row failed and frees the niche', async () => {
    const { worker, ctx, task } = setup({ llm: articleLlm(() => ruJson({ description: 'коротко' }), enJson) });
    const res = await worker.run(task({ action: 'article', niche: 'barber' }), ctx);
    expect(res.ok).toBe(false);
    const row = storeFor(ctx).articles()[0]!;
    expect(row.status).toBe('failed');
    expect(storeFor(ctx).coveredNiches().has('barber')).toBe(false);
  });

  it('an AI-line article picks an unused evergreen theme, uses the AI prompts and records the topic (60-day window)', async () => {
    const llm = articleLlm();
    const { worker, ctx, task, staged } = setup({ llm });
    const res = await worker.run(task({ action: 'article', line: 'ai' }), ctx);
    expect(res.ok).toBe(true);
    const row = storeFor(ctx).articles()[0]!;
    expect(row).toMatchObject({ line: 'ai', niche: 'ai', status: 'proposed' });
    expect(AI_TOPICS.map((t) => t.key)).toContain(row.topicKey);
    expect(llm.calls[0]!.messages[0]!.content).toContain('ИИ для бизнеса');
    expect(staged[0]!.summary).toContain('ИИ для бизнеса');
    // the next AI article takes another theme
    await worker.run(task({ action: 'article', line: 'ai' }), ctx);
    const keys = storeFor(ctx).articles().map((a) => a.topicKey);
    expect(new Set(keys).size).toBe(2);
    // all themes used within 60 days: the least recently used one comes back
    for (let i = 0; i < AI_TOPICS.length; i++) await worker.run(task({ action: 'article', line: 'ai', ...{} }), ctx);
    expect(storeFor(ctx).articles().length).toBeGreaterThan(AI_TOPICS.length);
  });

  it('without a line the weekday decides (Wednesday: AI); a niche asked by name wins', async () => {
    const { worker, ctx, task } = setup({ llm: articleLlm() });
    await worker.run(task({ action: 'article' }), ctx);
    expect(storeFor(ctx).articles()[0]!.line).toBe('ai');
    await worker.run(task({ action: 'article', niche: 'барбершоп' }), ctx);
    expect(storeFor(ctx).articles()[1]).toMatchObject({ line: 'niche', niche: 'barber' });
    await worker.run(task({ action: 'article', niche: 'ии' }), ctx);
    expect(storeFor(ctx).articles()[2]!.line).toBe('ai');
  });

  it('a niche used in the last 60 days is not taken again; a routine run stops while three cards wait', async () => {
    const { worker, ctx, task } = setup({ llm: articleLlm() });
    for (let i = 0; i < 3; i++) await worker.run(task({ action: 'article', line: 'niche' }), ctx);
    const niches = storeFor(ctx).articles().map((a) => a.niche);
    expect(new Set(niches).size).toBe(3);
    const routine = { ...task({ action: 'article', line: 'niche' }), creator: 'routine' as const };
    const res = await worker.run(routine, ctx);
    expect(res.ok).toBe(true);
    expect(res.result).toContain('Три статьи');
    expect(storeFor(ctx).articles()).toHaveLength(3);
  });

  it('approval publishes: published, date, a slug from the English title, unique, the public shape of the site', async () => {
    const { worker, ctx, task } = setup({ llm: articleLlm() });
    await worker.run(task({ action: 'article', line: 'niche', niche: 'barber' }), ctx);
    await worker.run(task({ action: 'article', line: 'niche', niche: 'salon' }), ctx);
    const store = storeFor(ctx);
    const [a, b] = store.articles();
    const first = approveArticle(store, a!.id, '2026-11-19');
    const second = approveArticle(store, b!.id, '2026-11-20');
    expect(first).toMatchObject({ status: 'approved', published: true, date: '2026-11-19', slug: 'a-booking-bot-for-your-business-where-to-start', packQueued: true });
    expect(second.slug).toBe('a-booking-bot-for-your-business-where-to-start-2');
    expect(approveArticle(store, a!.id, '2026-12-01').date).toBe('2026-11-19'); // idempotent
    expect(store.publishedArticles().map((r) => r.id)).toEqual([b!.id, a!.id]); // newest first
    const pub = toPublicArticle(store.articleBySlug(first.slug)!)!;
    expect(Object.keys(pub).sort()).toEqual(['date', 'en', 'published', 'ru', 'slug']);
    expect(pub).toMatchObject({ published: true, date: '2026-11-19' });
    expect(Object.keys(pub.ru).sort()).toEqual(['blocks', 'description', 'title']);
    expect(articleSchema.safeParse({ ...pub, niche: 'barber' }).success).toBe(true);
    expect(toPublicArticle({ slug: 'x', json: '{}', date: '2026-11-19', published: true })).toBeNull();
    expect(toPublicArticle({ slug: 'x', json: JSON.stringify(pub), date: null, published: false })).toBeNull();
  });

  it('LLM off: no row, an error', async () => {
    const { worker, ctx, task } = setup({ llm: new (await import('./helpers.js')).OffLlm() });
    const res = await worker.run(task({ action: 'article', line: 'niche' }), ctx);
    expect(res.ok).toBe(false);
    expect(storeFor(ctx).articles()).toHaveLength(0);
  });
});
