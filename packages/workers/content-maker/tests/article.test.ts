import { describe, expect, it } from 'vitest';
import { ARTICLE_KIND, articleSchema, articleTargetPath, builderInstruction, contentIssues, contentSchema, faqItems, storeFor, wordCount } from '../src/index.js';
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

  it('the builder instruction names the file path, the index and the niche link', () => {
    const a = articleSchema.parse({ slug: 'bot-dlya-barber', niche: 'barber', ru: contentOf('ru'), en: contentOf('en') });
    const text = builderInstruction(a, '2026-11-24');
    expect(articleTargetPath(a.slug)).toBe('src/content/blog/bot-dlya-barber.ts');
    expect(text).toContain('src/content/blog/bot-dlya-barber.ts');
    expect(text).toContain('src/content/blog/index.ts');
    expect(text).toContain('/ru/solutions/barber');
    expect(text).toContain("date: '2026-11-24'");
  });
});

describe('article generation', () => {
  it('picks an uncovered niche, writes RU then EN, stores the row and stages an `article` approval', async () => {
    const { worker, ctx, task, staged } = setup({ llm: articleLlm() });
    const res = await worker.run(task({ action: 'article' }), ctx);
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
    await worker.run(task({ action: 'article' }), ctx);
    await worker.run(task({ action: 'article' }), ctx);
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

  it('LLM off: no row, an error', async () => {
    const { worker, ctx, task } = setup({ llm: new (await import('./helpers.js')).OffLlm() });
    const res = await worker.run(task({ action: 'article' }), ctx);
    expect(res.ok).toBe(false);
    expect(storeFor(ctx).articles()).toHaveLength(0);
  });
});
