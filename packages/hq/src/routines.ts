import { schedule } from '@fir/core';
import { Cron } from 'croner';
import type { Hq } from './hq.js';

/** Starts a cron job per enabled routine (in its own clock: the company's or the owner's); each firing creates a task through `hq.runRoutine`. */
export function startRoutines(hq: Hq): Cron[] {
  return hq.routines().filter((r) => r.enabled).map((r) => schedule(`routine:${r.name}`, r.cron, hq.routineTz(r), () => void hq.runRoutine(r.name)));
}

/** A routine whose time passed while HQ was down is caught up only within this window (older ones wait for their next time). */
export const CATCH_UP_WINDOW_MS = 72 * 3_600_000;

/**
 * P-26: at start, every enabled routine that ran before (`last_run_at` set) but whose latest scheduled time (within the window) is newer than that last
 * run is fired once now: the backup, the morning summary or the weekly pack are not lost to a night restart. A routine that never ran (new, or after
 * a fresh start) is not caught up; a routine still busy with its previous task is skipped by `runRoutine` itself. Returns the names that were fired.
 */
export function catchUpRoutines(hq: Hq): string[] {
  const now = hq.now();
  const fired: string[] = [];
  for (const r of hq.routines()) {
    if (!r.enabled || r.lastRunAt === null) continue;
    let due: number | undefined;
    try {
      due = new Cron(r.cron, { timezone: hq.routineTz(r), paused: true }).previousRuns(1, new Date(now))[0]?.getTime();
    } catch {
      continue; // a cron that does not parse is not ours to fix here
    }
    if (due === undefined || due > now || due < now - CATCH_UP_WINDOW_MS || r.lastRunAt >= due) continue;
    if (hq.runRoutine(r.name)) {
      fired.push(r.name);
      hq.log('routine', 'routine_caught_up', 'routine', r.name, `missed ${new Date(due).toISOString()}`);
    }
  }
  return fired;
}
