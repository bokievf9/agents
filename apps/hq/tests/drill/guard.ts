import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from 'vitest';

export interface LogLine { level: string; msg: string; [k: string]: unknown }

/**
 * Captures the JSON logger (`console.log` / `console.error`) and unhandled rejections for one test file.
 * Lines logged while a test runs are checked with `errors()`; lines logged in `beforeAll` (world set-up) are checked once in `afterAll`.
 * A test that provokes an error line on purpose reads and removes it with `expectErrors()`.
 */
export function useGuard() {
  const lines: LogLine[] = [];
  const rejections: unknown[] = [];
  let mark = 0;
  const onRej = (e: unknown) => void rejections.push(e);
  const grab = (a: unknown[]) => {
    try {
      const rec = JSON.parse(String(a[0])) as LogLine;
      if (rec && typeof rec.level === 'string') lines.push(rec);
    } catch { /* not a log line */ }
  };
  beforeAll(() => {
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => grab(a));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => grab(a));
    process.on('unhandledRejection', onRej);
  });
  beforeEach(() => { mark = lines.length; });
  afterEach(() => { /* the lines stay for afterAll */ });
  afterAll(() => {
    process.off('unhandledRejection', onRej);
    vi.restoreAllMocks();
  });
  const api = {
    lines,
    rejections,
    /** Error lines logged since the current test started. */
    errors: (): LogLine[] => lines.slice(mark).filter((l) => l.level === 'error'),
    /** The error lines a test provoked on purpose: returns them and removes them from the capture. */
    expectErrors: (): LogLine[] => {
      const e = lines.slice(mark).filter((l) => l.level === 'error');
      for (const l of e) lines.splice(lines.indexOf(l), 1);
      return e;
    },
    /** Which of the needles (names, contacts, texts) appear anywhere in the captured log lines. */
    leaks: (needles: string[]): string[] => {
      const all = JSON.stringify(lines);
      return needles.filter((n) => n && all.includes(n));
    },
  };
  return api;
}
export { expect };
