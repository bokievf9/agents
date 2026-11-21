import { MockLlm } from '@fir/core';
import { meterLlm } from '@fir/hq';
import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/client/sanitize.js';
import { world } from './helpers.js';

const NOW = Date.UTC(2026, 10, 19, 7, 0);
const day = (t: number) => ({ now: () => t, tz: () => 'Asia/Tashkent' });

describe('the daily LLM counter survives a restart', () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { get: (k: string) => m.get(k), set: (k: string, v: string) => void m.set(k, v) };
  };

  it('a new limiter on the same store continues today\'s count; a new day starts from zero', () => {
    const store = mem();
    let t = NOW;
    const a = new RateLimiter(20, 3, () => t, () => 'Asia/Tashkent', store);
    a.llmUsed();
    a.llmUsed();
    const b = new RateLimiter(20, 3, () => t, () => 'Asia/Tashkent', store); // the deploy
    expect(b.llmToday).toBe(2);
    expect(b.llmAllowed()).toBe(true);
    b.llmUsed();
    expect(b.llmAllowed()).toBe(false);
    expect(new RateLimiter(20, 3, () => t, () => 'Asia/Tashkent', store).llmAllowed()).toBe(false);
    t += 86_400_000;
    expect(new RateLimiter(20, 3, () => t, () => 'Asia/Tashkent', store).llmAllowed()).toBe(true);
  });

  it('a damaged stored value counts as nothing; no store is the old in-memory behaviour', () => {
    const store = mem();
    store.set('llm_daily', '{nope');
    expect(new RateLimiter(20, 3, day(NOW).now, day(NOW).tz, store).llmToday).toBe(0);
    const plain = new RateLimiter(20, 1, day(NOW).now, day(NOW).tz);
    plain.llmUsed();
    expect(plain.llmAllowed()).toBe(false);
  });

  it('the hit windows are swept so that session ids do not pile up', () => {
    let t = NOW;
    const l = new RateLimiter(5, 0, () => t, () => 'UTC');
    for (let i = 0; i < 2100; i++) l.hit(`s${i}`);
    t += 2 * 3600_000;
    l.hit('new');
    expect((l as unknown as { hits: Map<unknown, unknown> }).hits.size).toBeLessThan(10);
  });
});

describe('client bot and web chat calls are metered', () => {
  it('calls under the client-bot agent land in costs with the real model, even over the department limit (a client is waiting)', async () => {
    const w = world();
    w.hq.ensureAgent({ id: 'sales-head', dept: 'sales', role: 'head', title: 'S', bossId: 'director', budgetUsdMonth: 0.001 });
    w.hq.ensureAgent({ id: 'client-bot', dept: 'sales', role: 'worker', title: 'Клиентский бот', bossId: 'sales-head' });
    const llm = meterLlm(new MockLlm(() => 'ответ', { inputTokens: 1_000_000, outputTokens: 0, model: 'claude-haiku-5-5' }), w.hq, { agentId: 'client-bot', urgent: true });
    expect(await llm.complete({ tier: 'haiku', system: 's', messages: [{ role: 'user', content: 'привет' }] })).toBe('ответ');
    expect(await llm.complete({ tier: 'haiku', system: 's', messages: [{ role: 'user', content: 'ещё' }] })).toBe('ответ'); // over the limit, still answers
    const row = w.hq.costSummary(0).find((c) => c.dept === 'sales')!;
    expect(row.usd).toBeCloseTo(0.2); // 2 calls x 1M input at $0.10
    expect(w.db.prepare("SELECT COUNT(*) c FROM costs WHERE agent_id = 'client-bot'").get()).toEqual({ c: 2 });
  });
});
