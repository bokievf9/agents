import { schedule } from '@fir/core';
import type { Cron } from 'croner';
import type { Hq } from './hq.js';

/** Starts a cron job per enabled routine (in its own clock: the company's or the owner's); each firing creates a task through `hq.runRoutine`. */
export function startRoutines(hq: Hq): Cron[] {
  return hq.routines().filter((r) => r.enabled).map((r) => schedule(`routine:${r.name}`, r.cron, hq.routineTz(r), () => void hq.runRoutine(r.name)));
}
