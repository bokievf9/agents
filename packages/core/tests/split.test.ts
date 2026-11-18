import { describe, expect, it } from 'vitest';
import { splitForTelegram } from '../src/bot.js';

describe('splitForTelegram', () => {
  it('keeps short texts whole and splits long ones at newlines under the limit', () => {
    expect(splitForTelegram('привет')).toEqual(['привет']);
    const line = 'строка '.repeat(50).trim(); // ~350 chars
    const text = Array.from({ length: 30 }, (_, i) => `${i} ${line}`).join('\n'); // ~10.5k chars
    const parts = splitForTelegram(text);
    expect(parts.length).toBeGreaterThan(2);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(4000);
    expect(parts.join('\n')).toBe(text);
  });
  it('cuts hard when there is no newline', () => {
    const parts = splitForTelegram('x'.repeat(9000));
    expect(parts.map((p) => p.length)).toEqual([4000, 4000, 1000]);
  });
});
