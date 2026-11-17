import { Cron } from 'croner';
import { errMsg, log } from './log.js';

/** Cron job in the agent's own timezone (from env TZ); an error in a job is logged, never fatal. */
export function schedule(name: string, pattern: string, tz: string, job: () => Promise<void> | void): Cron {
  return new Cron(pattern, { timezone: tz, name, protect: true }, async () => {
    try {
      await job();
    } catch (e) {
      log('error', 'scheduled job failed', { job: name, err: errMsg(e) });
    }
  });
}
