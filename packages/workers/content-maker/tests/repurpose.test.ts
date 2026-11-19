import { MockLlm } from '@fir/core';
import { describe, expect, it } from 'vitest';
import { approveArticle, storeFor } from '../src/index.js';
import { articleLlm } from './article-helpers.js';
import { carouselJson, setup } from './helpers.js';

async function approved(n: number) {
  const w = setup({ llm: articleLlm() });
  for (let i = 0; i < n; i++) {
    await w.worker.run(w.task({ action: 'article', line: 'niche' }), w.ctx);
    approveArticle(storeFor(w.ctx), storeFor(w.ctx).articles()[i]!.id, '2026-11-19');
  }
  return w;
}

describe('repurposing an approved article into the weekly pack', () => {
  it('the next pack gets one reel and one carousel per article, tagged with its slug, in place of ordinary ones', async () => {
    const w = await approved(2);
    const store = storeFor(w.ctx);
    expect(store.queuedArticles()).toHaveLength(2);
    const specs = (await w.worker.plan(w.task({ action: 'pack' }), w.ctx))!;
    expect(specs).toHaveLength(17); // the pack does not grow: article items take ordinary slots
    const items = specs.map((s) => store.item(Number(s.meta.itemId))!);
    const mine = items.filter((i) => i.sourceSlug);
    expect(mine.map((i) => i.type).sort()).toEqual(['carousel', 'carousel', 'clip', 'clip']);
    expect(new Set(mine.map((i) => i.sourceSlug)).size).toBe(2);
    expect(mine.every((i) => i.topicKey === `article:${i.sourceSlug}`)).toBe(true);
    expect(specs.filter((s) => s.title.includes('(из статьи)'))).toHaveLength(4);
    expect(store.queuedArticles()).toHaveLength(0); // taken once
    expect(store.itemsOfSlug(mine[0]!.sourceSlug!)).toHaveLength(2);
  });

  it('more articles than free slots wait for the next pack; extra carousels are capped at two', async () => {
    const w = await approved(3);
    const store = storeFor(w.ctx);
    const specs = (await w.worker.plan(w.task({ action: 'pack' }), w.ctx))!;
    const items = specs.map((s) => store.item(Number(s.meta.itemId))!);
    expect(items.filter((i) => i.sourceSlug && i.type === 'carousel')).toHaveLength(2);
    expect(store.queuedArticles()).toHaveLength(1);
  });

  it('the generated item gets the article structure in its prompt and the slug in its summary', async () => {
    const w = await approved(1);
    const mock = new MockLlm(() => carouselJson());
    const w2 = { ...w, ctx: { ...w.ctx, llm: mock } };
    const specs = (await w.worker.plan(w.task({ action: 'pack' }), w2.ctx))!;
    const itemId = specs.map((s) => storeFor(w.ctx).item(Number(s.meta.itemId))!).find((i) => i.sourceSlug && i.type === 'carousel')!.id;
    const res = await w.worker.run(w.task({ action: 'item', itemId }), w2.ctx);
    expect(res.ok).toBe(true);
    const prompt = mock.calls.at(-1)!.messages[0]!.content;
    expect(prompt).toContain('Разделы статьи (h2):');
    expect(prompt).toContain('С чего начать');
    expect(w.staged.at(-1)!.summary).toContain('Из статьи: ');
  });
});
