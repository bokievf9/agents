import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createLlm, MockLlm, OffLlm, tryComplete, tryJson } from '../src/index.js';

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
