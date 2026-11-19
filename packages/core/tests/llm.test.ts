import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createServer } from 'node:http';
import { createLlm, MockLlm, OffLlm, parseUsage, tryComplete, tryJson } from '../src/index.js';

const noKey = { baseUrl: undefined, apiKey: undefined, modelFast: undefined, modelSmart: undefined, timeoutMs: 1000, maxRetries: 0 };

describe('llm', () => {
  it('without a key is honestly off and falls back to null', async () => {
    const llm = createLlm(noKey);
    expect(llm).toBeInstanceOf(OffLlm);
    expect(llm.enabled).toBe(false);
    expect(await tryComplete(llm, { tier: 'haiku', system: 's', messages: [{ role: 'user', content: 'x' }] })).toBeNull();
  });

  it('tryComplete returns the mock answer and null on errors', async () => {
    const ok = new MockLlm(() => 'hello');
    expect(await tryComplete(ok, { tier: 'sonnet', system: 's', messages: [{ role: 'user', content: 'x' }] })).toBe('hello');
    const bad = new MockLlm(() => { throw new Error('down'); });
    expect(await tryComplete(bad, { tier: 'sonnet', system: 's', messages: [{ role: 'user', content: 'x' }] })).toBeNull();
  });

  const req = { tier: 'haiku' as const, system: 's', messages: [{ role: 'user' as const, content: 'x' }] };
  const schema = z.object({ niche: z.string() });

  it('tryJson retries on garbage and accepts fenced JSON', async () => {
    const llm = new MockLlm((_r, n) => (n === 1 ? 'sorry, no' : n === 2 ? '{"niche": 5}' : 'Here:\n```json\n{"niche":"cafe"}\n```'));
    expect(await tryJson(llm, req, schema)).toEqual({ niche: 'cafe' });
    expect(llm.calls).toHaveLength(3);
    expect(llm.calls[2]?.messages.at(-1)?.content).toContain('invalid');
  });

  it('tryJson gives null when the model keeps failing or is off', async () => {
    expect(await tryJson(new MockLlm(() => 'nope'), req, schema, 2)).toBeNull();
    expect(await tryJson(createLlm(noKey), req, schema)).toBeNull();
  });
});

describe('usage', () => {
  const req = { tier: 'haiku' as const, system: 's', messages: [{ role: 'user' as const, content: 'x' }] };

  it('parses Anthropic-format usage and the model that answered', () => {
    expect(parseUsage({ model: 'glm-4.6', usage: { input_tokens: 120, output_tokens: 30 } }, 'auto')).toEqual({ inputTokens: 120, outputTokens: 30, model: 'glm-4.6' });
    expect(parseUsage({ usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 95 } }, 'auto')).toEqual({ inputTokens: 100, outputTokens: 1, model: 'auto' });
  });

  it('gives null when the provider reports nothing usable', () => {
    expect(parseUsage({ model: 'x' })).toBeNull();
    expect(parseUsage({ usage: { input_tokens: 'a' } })).toBeNull();
    expect(parseUsage({ usage: { input_tokens: 0, output_tokens: 0 } })).toBeNull();
    expect(parseUsage(null)).toBeNull();
  });

  it('the gateway client returns text and usage; complete stays text-only', async () => {
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        id: 'm1', type: 'message', role: 'assistant', model: 'kimi-k2', stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'text', text: ' hi ' }], usage: { input_tokens: 42, output_tokens: 7 },
      }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = (server.address() as { port: number }).port;
      const llm = createLlm({ ...noKey, baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k' });
      expect(await llm.complete(req)).toBe('hi');
      expect(await llm.completeDetailed!(req)).toEqual({ text: 'hi', usage: { inputTokens: 42, outputTokens: 7, model: 'kimi-k2' } });
    } finally {
      server.close();
    }
  });

  it('MockLlm reports usage only when given', async () => {
    expect(new MockLlm(() => 'a').completeDetailed).toBeUndefined();
    const m = new MockLlm(() => 'a', { inputTokens: 1, outputTokens: 2, model: 'x' });
    expect(await m.completeDetailed!(req)).toEqual({ text: 'a', usage: { inputTokens: 1, outputTokens: 2, model: 'x' } });
    expect(m.calls).toHaveLength(1);
  });
});

describe('usage and prices', () => {
  it('parseUsage reads Anthropic and OpenAI style usage with the resolved model', async () => {
    const { parseUsage, priceFor, usdFor } = await import('../src/index.js');
    expect(parseUsage({ model: 'gemini-2.5-flash', usage: { input_tokens: 10, output_tokens: 5 } })).toEqual({ inputTokens: 10, outputTokens: 5, model: 'gemini-2.5-flash' });
    expect(parseUsage({ model: 'x', usage: { prompt_tokens: 7, completion_tokens: 3 } })).toEqual({ inputTokens: 7, outputTokens: 3, model: 'x' });
    expect(parseUsage({ usage: { input_tokens: 0, output_tokens: 0 } })).toBeNull();
    expect(priceFor('claude-sonnet-5-5').source).toBe('table');
    expect(priceFor('glm-4.6').source).toBe('unknown');
    expect(priceFor('qwen3:free')).toMatchObject({ source: 'free', price: { in: 0, out: 0 } });
    expect(priceFor('claude-sonnet-5-5', { 'claude-sonnet-5': { in: 1, out: 2 } }).source).toBe('override');
    expect(usdFor({ in: 3, out: 15 }, 1_000_000, 100_000)).toBeCloseTo(4.5);
  });
});
