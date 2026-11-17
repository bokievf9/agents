import { zonedParts, zonedToMs } from '@fir/core';

/**
 * FSRS-4.5 (free spaced repetition scheduler), default weights, own implementation: four grades,
 * stability S (days until recall drops to 90 percent) and difficulty D (1..10) per card.
 */
export type Grade = 1 | 2 | 3 | 4; // again, hard, good, easy

export interface Memory {
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
}

const W = [0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031, 1.6474, 0.1367, 1.0461, 2.1072, 0.0793, 0.3246, 1.587, 0.2272, 2.8755] as const;
const w = (i: number): number => W[i]!;
const DECAY = -0.5;
const FACTOR = 19 / 81;
const clampD = (d: number): number => Math.min(10, Math.max(1, d));
export const DAY_MS = 86_400_000;
/** "Again" brings the card back in the same session, not tomorrow. */
export const RELEARN_MS = 10 * 60_000;

/** Probability of recall after `days` with stability `s`. */
export function retrievability(days: number, s: number): number {
  return (1 + (FACTOR * days) / s) ** DECAY;
}

/** Days until recall falls to `retention` (0.9 gives exactly S). */
export function intervalDays(s: number, retention = 0.9): number {
  return Math.max(1, Math.round((s / FACTOR) * (retention ** (1 / DECAY) - 1)));
}

const initD = (g: Grade): number => clampD(w(4) - w(5) * (g - 3));

/** New memory state after a review. `elapsedDays`: days since the previous review (ignored for a new card). */
export function review(prev: Memory | null, grade: Grade, elapsedDays: number): Memory {
  if (!prev || prev.reps === 0) {
    return { stability: w(grade - 1), difficulty: initD(grade), reps: 1, lapses: grade === 1 ? 1 : 0 };
  }
  const { stability: s, difficulty: d } = prev;
  const r = retrievability(Math.max(0, elapsedDays), s);
  const dNext = clampD(w(7) * initD(3) + (1 - w(7)) * (d - w(6) * (grade - 3)));
  let sNext: number;
  if (grade === 1) {
    sNext = Math.min(s, w(11) * d ** -w(12) * ((s + 1) ** w(13) - 1) * Math.exp(w(14) * (1 - r)));
  } else {
    const hard = grade === 2 ? w(15) : 1;
    const easy = grade === 4 ? w(16) : 1;
    sNext = s * (1 + Math.exp(w(8)) * (11 - d) * s ** -w(9) * (Math.exp(w(10) * (1 - r)) - 1) * hard * easy);
  }
  return { stability: Math.max(0.01, sNext), difficulty: dNext, reps: prev.reps + 1, lapses: prev.lapses + (grade === 1 ? 1 : 0) };
}

/** When the card is due: "Again" in ten minutes, otherwise the start of the local day `intervalDays` ahead. */
export function dueAt(mem: Memory, grade: Grade, now: number, tz: string): number {
  if (grade === 1) return now + RELEARN_MS;
  const p = zonedParts(now, tz);
  const day = new Date(Date.UTC(p.y, p.mo - 1, p.d + intervalDays(mem.stability)));
  return zonedToMs(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), 0, 0, tz);
}
