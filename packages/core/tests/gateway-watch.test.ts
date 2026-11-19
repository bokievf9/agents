import { describe, expect, it } from 'vitest';
import { GatewayWatch, isOutage, MockLlm, type LlmClient } from '../src/index.js';

const req = { tier: 'haiku' as const, system: 's', messages: [{ role: 'user' as const, content: 'u' }] };
const http = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

function fixture(script: (n: number) => Error | string) {
  const clock = { t: 0 };
  const events: string[] = [];
  let n = 0;
  const inner: LlmClient = new MockLlm(() => {
    const r = script(++n);
    if (typeof r === 'string') return r;
    throw r;
  });
  const llm = new GatewayWatch(inner, { now: () => clock.t, onDown: () => void events.push('down'), onUp: () => void events.push('up') });
  const call = (advance = 0) => {
    clock.t += advance;
    return llm.complete(req).catch(() => 'failed');
  };
  return { clock, events, call, llm };
}

describe('gateway watch', () => {
  it('classifies outages: connection, timeout, 5xx, 429; not 400, 401 or a refusal', () => {
    expect(isOutage(http(502))).toBe(true);
    expect(isOutage(http(429))).toBe(true);
    expect(isOutage(http(400))).toBe(false);
    expect(isOutage(http(401))).toBe(false);
    expect(isOutage(Object.assign(new Error('Connection error.'), { name: 'APIConnectionError' }))).toBe(true);
    expect(isOutage(new Error('connect ECONNREFUSED 10.0.0.2:20128'))).toBe(true);
    expect(isOutage(new Error('LLM refused'))).toBe(false);
  });

  it('tells the owner once after 60 s of failures, and once when it recovers', async () => {
    const { call, events } = fixture((n) => (n <= 4 ? http(503) : 'ok'));
    await call();
    expect(events).toEqual([]);
    await call(30_000); // 30 s in
    expect(events).toEqual([]);
    await call(31_000); // 61 s
    expect(events).toEqual(['down']);
    await call(20_000);
    expect(events).toEqual(['down']); // not repeated
    expect(await call(1000)).toBe('ok');
    expect(events).toEqual(['down', 'up']);
    expect(await call(1000)).toBe('ok');
    expect(events).toEqual(['down', 'up']);
  });

  it('a short blip is silent, also on recovery; a bad request is not an outage', async () => {
    const a = fixture((n) => (n === 1 ? http(502) : 'ok'));
    await a.call();
    await a.call(5000);
    expect(a.events).toEqual([]);
    const b = fixture(() => http(400));
    await b.call();
    await b.call(120_000);
    expect(b.events).toEqual([]);
  });

  it('one long failing call (the SDK retries for a minute) counts from the start of the call', async () => {
    const clock = { t: 0 };
    const events: string[] = [];
    const slowFail: LlmClient = { enabled: true, complete: async () => { clock.t += 90_000; throw http(504); } };
    const llm = new GatewayWatch(slowFail, { now: () => clock.t, onDown: () => void events.push('down'), onUp: () => void events.push('up') });
    await llm.complete(req).catch(() => undefined);
    expect(events).toEqual(['down']);
    expect(llm.enabled).toBe(true);
  });

  it('keeps completeDetailed only when the inner client has it', () => {
    const plain = new GatewayWatch(new MockLlm(() => 'x'), { onDown: () => undefined, onUp: () => undefined });
    expect(plain.completeDetailed).toBeUndefined();
    const detailed = new GatewayWatch(new MockLlm(() => 'x', { inputTokens: 1, outputTokens: 1, model: 'm' }), { onDown: () => undefined, onUp: () => undefined });
    expect(detailed.completeDetailed).toBeDefined();
  });
});
