import { describe, expect, it } from 'vitest';
import { DIRECTIONS } from '../src/directions.js';
import { ALL_TOPICS, REPEAT_WINDOW_DAYS, pickTopics, type History } from '../src/topics.js';
import { NOW, setup } from './helpers.js';

const DAY = 86_400_000;

describe('topic rotation', () => {
  it('has 8 directions and a pool of topics', () => {
    expect(DIRECTIONS).toHaveLength(8);
    expect(ALL_TOPICS.length).toBe(32);
  });

  it('uses different directions inside one pack', () => {
    const t = pickTopics(new Map(), 4, NOW, () => 0.3);
    expect(new Set(t.map((x) => x.directionId)).size).toBe(4);
  });

  it('never repeats a topic within 6 weeks over a simulated run', () => {
    const history: History = new Map();
    let now = NOW;
    const seen: { key: string; at: number }[] = [];
    let seed = 3;
    const rng = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    for (let week = 0; week < 8; week++) {
      for (const t of pickTopics(history, 4, now, rng)) {
        const prev = seen.filter((s) => s.key === t.key).at(-1);
        if (prev) expect(now - prev.at).toBeGreaterThanOrEqual(REPEAT_WINDOW_DAYS * DAY);
        history.set(t.key, now);
        seen.push({ key: t.key, at: now });
      }
      now += 7 * DAY;
    }
  });

  it('falls back to the least recently used when everything is fresh in history', () => {
    const history: History = new Map(ALL_TOPICS.map((t, i) => [t.key, NOW - i * 1000]));
    const t = pickTopics(history, 2, NOW, () => 0);
    expect(t).toHaveLength(2);
  });

  it('records topics of a pack in the SQLite history', async () => {
    const { head, store } = setup();
    await head.generatePack(true);
    expect(store.history().size).toBe(4);
  });
});
