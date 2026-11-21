import { describe, expect, it } from 'vitest';
import { world } from './helpers.js';

describe('morning summary: LLM usage', () => {
  it('shows «LLM за вчера: N вызовов, $X» (counts and money only) and nothing when there were no calls', () => {
    const w = world();
    expect(w.director.morningSummary()).not.toContain('LLM за вчера');
    w.hq.recordCost({ agentId: 'content-maker', model: 'claude-sonnet-5-5', inputTokens: 1_000_000, outputTokens: 100_000 });
    w.hq.recordCost({ agentId: 'content-maker', model: 'claude-haiku-5-5', inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(w.director.morningSummary()).toContain('LLM за вчера: 2 вызовов, $3.60.');
  });
});
