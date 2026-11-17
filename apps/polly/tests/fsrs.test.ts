import { describe, expect, it } from 'vitest';
import { dueAt, intervalDays, retrievability, review, RELEARN_MS, type Memory } from '../src/fsrs.js';

const first = (g: 1 | 2 | 3 | 4): Memory => review(null, g, 0);

describe('FSRS schedule', () => {
  it('starts stability by grade and orders them', () => {
    expect(first(1).stability).toBeCloseTo(0.4872, 3);
    expect(first(3).stability).toBeCloseTo(3.7145, 3);
    expect(first(4).stability).toBeCloseTo(13.8206, 3);
    expect(first(1).stability).toBeLessThan(first(2).stability);
    expect(first(2).stability).toBeLessThan(first(3).stability);
    expect(first(3).stability).toBeLessThan(first(4).stability);
    expect(first(4).difficulty).toBeLessThan(first(3).difficulty);
  });

  it('recall is 90 percent at one stability and the interval equals stability', () => {
    expect(retrievability(5, 5)).toBeCloseTo(0.9, 3);
    expect(intervalDays(4)).toBe(4);
    expect(intervalDays(0.2)).toBe(1);
  });

  it('grows the interval on successful reviews and shrinks it after a lapse', () => {
    let m = first(3);
    const intervals: number[] = [];
    for (let i = 0; i < 4; i++) {
      intervals.push(intervalDays(m.stability));
      m = review(m, 3, intervalDays(m.stability));
    }
    for (let i = 1; i < intervals.length; i++) expect(intervals[i]!).toBeGreaterThan(intervals[i - 1]!);
    const lapsed = review(m, 1, intervalDays(m.stability));
    expect(lapsed.stability).toBeLessThan(m.stability);
    expect(lapsed.lapses).toBe(1);
    expect(lapsed.difficulty).toBeGreaterThan(m.difficulty);
  });

  it('easy grows more than good, hard less, and reviewing late grows more than on time', () => {
    const m = first(3);
    const t = intervalDays(m.stability);
    expect(review(m, 2, t).stability).toBeLessThan(review(m, 3, t).stability);
    expect(review(m, 3, t).stability).toBeLessThan(review(m, 4, t).stability);
    expect(review(m, 3, t * 3).stability).toBeGreaterThan(review(m, 3, t).stability);
  });

  it('puts a card due at the start of a local day, or in ten minutes after "again"', () => {
    const now = Date.UTC(2026, 10, 18, 14, 0); // 19:00 Tashkent
    const m = first(3); // 3.7 days -> 4
    const due = dueAt(m, 3, now, 'Asia/Tashkent');
    expect(new Date(due).toISOString()).toBe('2026-11-21T19:00:00.000Z'); // 00:00 of Nov 22 in Tashkent
    expect(dueAt(first(1), 1, now, 'Asia/Tashkent')).toBe(now + RELEARN_MS);
  });
});
