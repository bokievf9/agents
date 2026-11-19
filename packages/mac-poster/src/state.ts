import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { addDays } from './week.js';

/**
 * `state.json`: posts per day (the daily cap), the day each item was last tried (one try per item per day), items whose
 * result is unknown after «Поделиться» was pressed (never retried by itself: a double post is worse than a missed one),
 * and the Instagram username read after `login`.
 */
export interface State {
  posted: Record<string, number>;
  attempts: Record<string, string>;
  stuck: Record<string, string>;
  username?: string;
}

export const emptyState = (): State => ({ posted: {}, attempts: {}, stuck: {} });

export function loadState(file: string): State {
  if (!existsSync(file)) return emptyState();
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as Partial<State>;
    return { posted: j.posted ?? {}, attempts: j.attempts ?? {}, stuck: j.stuck ?? {}, ...(j.username ? { username: j.username } : {}) };
  } catch {
    return emptyState();
  }
}

/** Written atomically (temp file, rename), mode 600. Days older than 30 are dropped. */
export function saveState(file: string, s: State, today: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const cutoff = addDays(today, -30);
  const pruned: State = {
    ...s,
    posted: Object.fromEntries(Object.entries(s.posted).filter(([d]) => d >= cutoff)),
    attempts: Object.fromEntries(Object.entries(s.attempts).filter(([, d]) => d >= cutoff)),
  };
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(pruned, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** How many more posts today allows under the cap. */
export const leftToday = (s: State, today: string, cap: number): number => Math.max(0, cap - (s.posted[today] ?? 0));

export function recordPost(s: State, today: string): void {
  s.posted[today] = (s.posted[today] ?? 0) + 1;
}

export function recordAttempt(s: State, id: string | number, today: string): void {
  s.attempts[String(id)] = today;
}

/** Tried today already, or stuck after «Поделиться»: leave it for the owner. */
export const shouldSkip = (s: State, id: string | number, today: string): boolean => s.attempts[String(id)] === today || String(id) in s.stuck;

export function markStuck(s: State, id: string | number, reason: string): void {
  s.stuck[String(id)] = reason;
}
