import { describe, expect, it } from 'vitest';
import { AnthropicLlm, type LlmEnv, CACHE_READ_FACTOR, CLAUDE_MODELS, CLAUDE_OPUS, MODEL_PRICES, loadBaseConfig, loadLlmEnv, priceFor, usdFor } from '../src/index.js';

const base = { OWNER_TELEGRAM_ID: '1', TELEGRAM_BOT_TOKEN: 't' };

describe('LLM mode from the environment', () => {
  it('only ANTHROPIC_API_KEY: direct Anthropic', () => {
    const l = loadLlmEnv({ ANTHROPIC_API_KEY: 'sk-a' });
    expect(l).toMatchObject({ mode: 'direct', baseUrl: undefined, apiKey: 'sk-a', gatewayIgnored: false });
  });

  it('ANTHROPIC_API_KEY + LLM_BASE_URL without LLM_PROVIDER: direct wins, the gateway is ignored', () => {
    const l = loadLlmEnv({ ANTHROPIC_API_KEY: 'sk-a', LLM_BASE_URL: 'http://omniroute:20128', LLM_API_KEY: 'gw' });
    expect(l).toMatchObject({ mode: 'direct', baseUrl: undefined, apiKey: 'sk-a', gatewayIgnored: true });
    expect(loadBaseConfig({ ...base, ANTHROPIC_API_KEY: 'sk-a', LLM_BASE_URL: 'http://x' }).llm.baseUrl).toBeUndefined();
  });

  it('LLM_PROVIDER=gateway: the gateway with its own key, never the Anthropic key', () => {
    const l = loadLlmEnv({ ANTHROPIC_API_KEY: 'sk-a', LLM_BASE_URL: 'http://omniroute:20128', LLM_API_KEY: 'gw', LLM_PROVIDER: 'gateway' });
    expect(l).toMatchObject({ mode: 'gateway', baseUrl: 'http://omniroute:20128', apiKey: 'gw' });
    expect(loadLlmEnv({ ANTHROPIC_API_KEY: 'sk-a', LLM_BASE_URL: 'http://x', LLM_PROVIDER: 'gateway' }).mode).toBe('off');
  });

  it('without ANTHROPIC_API_KEY the old behaviour stays: gateway or off', () => {
    expect(loadLlmEnv({ LLM_BASE_URL: 'http://g', LLM_API_KEY: 'k' }).mode).toBe('gateway');
    expect(loadLlmEnv({}).mode).toBe('off');
  });
});

describe('models of the direct mode', () => {
  const direct: LlmEnv & { apiKey: string } = { baseUrl: undefined, apiKey: 'k', modelFast: undefined, modelSmart: undefined, timeoutMs: 1000, maxRetries: 0 };
  const models = (e: typeof direct): Record<string, string> => (new AnthropicLlm(e) as unknown as { models: Record<string, string> }).models;

  it('default to haiku-5-5 and sonnet-5-5, opus is claude-opus-5-5', () => {
    expect(models(direct)).toEqual({ haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5' });
    expect(CLAUDE_MODELS).toEqual({ haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5' });
    expect(CLAUDE_OPUS).toBe('claude-opus-5-5');
  });

  it('LLM_MODEL_* overrides work, a leftover gateway alias does not', () => {
    expect(models({ ...direct, modelFast: 'claude-haiku-4-5', modelSmart: 'auto' })).toEqual({ haiku: 'claude-haiku-4-5', sonnet: 'claude-sonnet-5-5' });
  });
});

describe('price table of the 5.5 generation', () => {
  it('has the owner prices per 1M tokens', () => {
    expect(MODEL_PRICES['claude-haiku-5-5']).toEqual({ in: 0.1, out: 0.5 });
    expect(MODEL_PRICES['claude-sonnet-5-5']).toEqual({ in: 2, out: 10 });
    expect(MODEL_PRICES['claude-opus-5-5']).toEqual({ in: 4, out: 20 });
    expect(priceFor('claude-sonnet-5-5-20261101')).toMatchObject({ source: 'table', price: { in: 2, out: 10 } });
    expect(priceFor('claude-haiku-4-5').price).toEqual({ in: 1, out: 5 });
  });

  it('charges cache reads at 10% of the input price', () => {
    expect(CACHE_READ_FACTOR).toBe(0.1);
    expect(usdFor({ in: 2, out: 10 }, 1_000_000, 100_000)).toBeCloseTo(3);
    // 1M input of which 900k from the cache: 100k full + 900k at 10%
    expect(usdFor({ in: 2, out: 10 }, 1_000_000, 0, 900_000)).toBeCloseTo(0.2 + 0.18);
  });
});
