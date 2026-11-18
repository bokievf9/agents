import { MockLlm } from '@fir/core';
import { describe, expect, it } from 'vitest';
import { ContentMakerWorker, pickTrends, type TrendHint } from '../src/index.js';
import { clipJson, promptsDir, setup } from './helpers.js';

const hints: TrendHint[] = [
  { hook: 'Хук про салоны', format: 'клип', why: 'растёт', direction: 'admin' },
  { hook: 'Хук про Telegram', format: 'карусель', why: 'много сохранений', direction: 'miniapp' },
  { hook: 'Общий хук', format: 'клип', why: 'вирусный' },
];

describe('trends provider', () => {
  it('pickTrends: the topic direction first, at most two', () => {
    expect(pickTrends(hints, 'miniapp').map((h) => h.hook)).toEqual(['Хук про Telegram', 'Хук про салоны']);
    expect(pickTrends(hints, null).map((h) => h.hook)).toEqual(['Хук про салоны', 'Хук про Telegram']);
    expect(pickTrends([], 'admin')).toEqual([]);
  });

  it('with a provider the prompt carries the trends and the no-copy rule; the default has none', async () => {
    const seen: string[] = [];
    const llm = new MockLlm((r) => (seen.push(r.messages[0]!.content), clipJson()));
    const withTrends = setup({ llm });
    const worker = new ContentMakerWorker({ promptsDir, rng: () => 0.1, trends: () => hints });
    await worker.run(withTrends.task({ action: 'topic', topic: 'бот-администратор для барбершопа' }), withTrends.ctx);
    expect(seen[0]).toContain('Свежие тренды ниши');
    expect(seen[0]).toContain('не копируй чужие тексты');
    expect(seen[0]).toContain('Хук про Telegram');
    seen.length = 0;
    const plain = setup({ llm });
    await plain.worker.run(plain.task({ action: 'topic', topic: 'бот-администратор для барбершопа' }), plain.ctx);
    expect(seen[0]).not.toContain('Свежие тренды');
  });

  it('a failing provider does not stop generation', async () => {
    const t = setup();
    const worker = new ContentMakerWorker({ promptsDir, rng: () => 0.1, trends: () => { throw new Error('boom'); } });
    expect((await worker.run(t.task({ action: 'topic', topic: 'тема' }), t.ctx)).ok).toBe(true);
  });
});
