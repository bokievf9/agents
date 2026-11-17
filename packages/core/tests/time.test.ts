import { describe, expect, it } from 'vitest';
import { zonedParts, zonedToMs } from '../src/index.js';

describe('time', () => {
  it('round-trips a wall-clock time in a zone', () => {
    const ms = zonedToMs(2026, 11, 20, 11, 0, 'Asia/Tashkent');
    expect(ms).toBe(Date.UTC(2026, 10, 20, 6, 0));
    expect(zonedParts(ms, 'Asia/Tashkent')).toMatchObject({ d: 20, h: 11, mi: 0, dow: 5 });
  });
});
