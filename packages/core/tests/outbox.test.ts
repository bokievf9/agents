import { describe, expect, it } from 'vitest';
import { MemoryMessenger, OutboxMessenger, type Messenger } from '../src/index.js';

class TgError extends Error {
  constructor(readonly error_code: number, msg: string, readonly parameters: { retry_after?: number } = {}) {
    super(msg);
  }
}

function fixture(failures: unknown[], opts: { minGapMs?: number } = {}) {
  const inner = new MemoryMessenger();
  const queue = [...failures];
  const origSend = inner.sendMessage.bind(inner);
  inner.sendMessage = (...a: Parameters<Messenger['sendMessage']>) => {
    const f = queue.shift();
    return f ? Promise.reject(f) : origSend(...a);
  };
  const clock = { t: 1_000_000 };
  const sleeps: number[] = [];
  const out = new OutboxMessenger(inner, {
    minGapMs: opts.minGapMs ?? 0,
    sleep: (ms) => { sleeps.push(ms); clock.t += ms; return Promise.resolve(); },
    now: () => clock.t,
  });
  return { inner, out, sleeps, clock };
}

describe('OutboxMessenger', () => {
  it('retries a 429 after the retry_after Telegram names, and the send resolves with the message id', async () => {
    const { inner, out, sleeps } = fixture([new TgError(429, 'Too Many Requests: retry after 7', { retry_after: 7 })]);
    const id = await out.sendMessage(1, 'card', [[{ text: 'ok', data: 'ap:1:a' }]]);
    expect(id).toBeGreaterThan(0);
    expect(inner.sent).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(7000);
  });

  it('retries a 5xx with backoff at most three times, then throws', async () => {
    const e = new TgError(502, 'Bad Gateway');
    const { inner, out, sleeps } = fixture([e, e, e, e]);
    await expect(out.sendMessage(1, 'x')).rejects.toBe(e);
    expect(sleeps).toEqual([1000, 2000, 4000]);
    expect(inner.sent).toHaveLength(0);
    const ok = fixture([e, e]);
    await ok.out.sendMessage(1, 'x');
    expect(ok.inner.sent).toHaveLength(1);
  });

  it('does not retry a 400 or a plain error', async () => {
    const { out, sleeps } = fixture([new TgError(400, 'Bad Request')]);
    await expect(out.sendMessage(1, 'x')).rejects.toThrow('Bad Request');
    expect(sleeps).toEqual([]);
  });

  it('keeps at least minGapMs between two sends of a batch, in order, even when sent concurrently', async () => {
    const { inner, out, sleeps, clock } = fixture([], { minGapMs: 1100 });
    const stamps: number[] = [];
    const orig = inner.sendMessage.bind(inner);
    inner.sendMessage = (...a: Parameters<Messenger['sendMessage']>) => { stamps.push(clock.t); return orig(...a); };
    await Promise.all(['a', 'b', 'c'].map((t) => out.sendMessage(1, t)));
    expect(inner.sent.map((m) => m.text)).toEqual(['a', 'b', 'c']);
    expect(stamps[1]! - stamps[0]!).toBeGreaterThanOrEqual(1100);
    expect(stamps[2]! - stamps[1]!).toBeGreaterThanOrEqual(1100);
    expect(sleeps.length).toBeGreaterThanOrEqual(2);
  });

  it('a failed send does not block the queue behind it; media methods exist only when the inner has them', async () => {
    const { inner, out } = fixture([new TgError(400, 'nope')]);
    const results = await Promise.allSettled([out.sendMessage(1, 'bad'), out.sendMessage(1, 'good')]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled']);
    expect(inner.sent.map((m) => m.text)).toEqual(['good']);
    await out.sendVideo!(1, '/a.mp4', 'cap');
    expect(inner.videos).toHaveLength(1);
    const bare = new OutboxMessenger({ send: async () => undefined, sendMessage: async () => 1, edit: async () => undefined, editButtons: async () => undefined });
    expect(bare.sendVideo).toBeUndefined();
  });
});
