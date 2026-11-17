import { describe, expect, it } from 'vitest';
import { createLlm, MockLlm, OffLlm, tryComplete } from '../src/index.js';

describe('llm', () => {
  it('without a key is honestly off and falls back to null', async () => {
    const llm = createLlm(undefined);
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
});
