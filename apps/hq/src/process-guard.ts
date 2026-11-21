import { errMsg, log } from '@fir/core';

/**
 * The process-level safety nets of HQ (audit 2026-11-22). Small and testable on their own: `index.ts` wires them to `process` and to the bots.
 */

const TEN_MIN = 10 * 60_000;

/**
 * P-28: a promise somebody forgot to catch no longer takes the whole HQ down. Every unhandled rejection is an `error` line in the log (the message only,
 * never client data: callers log ids and counts) and the owner hears about it at most once per `everyMs` (10 minutes), with the count of the window.
 * The process keeps running. Returns the handler (tests call it directly).
 */
export function installRejectionGuard(
  proc: { on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown },
  alert: (text: string) => Promise<void> | void,
  o: { now: () => number; everyMs?: number },
): (reason: unknown) => void {
  const every = o.everyMs ?? TEN_MIN;
  let lastAlertAt = Number.NEGATIVE_INFINITY;
  let unreported = 0;
  const handler = (reason: unknown): void => {
    unreported++;
    log('error', 'unhandled rejection', { err: errMsg(reason), count: unreported });
    const t = o.now();
    if (t - lastAlertAt < every) return;
    lastAlertAt = t;
    const n = unreported;
    unreported = 0;
    try {
      void Promise.resolve(alert(`HQ: необработанная ошибка в фоне (${n} за последние ${Math.round(every / 60_000)} мин). Процесс работает дальше, подробности в логе hq («unhandled rejection»).`)).catch(() => undefined);
    } catch {
      /* the alert itself must never throw into the handler */
    }
  };
  proc.on('unhandledRejection', handler);
  return handler;
}

export interface KeepPollingOptions {
  /** Restarts before giving up (default 3). */
  attempts?: number;
  /** Pause before restart n: `pauseMs * n` (default 15 s). */
  pauseMs?: number;
  /** A run that lasted this long counts as healthy: the attempt counter starts again (default 10 minutes). */
  healthyMs?: number;
  now: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** A restart is about to happen (attempt n of `attempts`). */
  onRestart?: (attempt: number, err: unknown) => void;
  /** Every attempt failed: the app exits so the container restarts. */
  onGiveUp: (err: unknown) => Promise<void> | void;
}

/**
 * P-05: long polling of a bot that crashed is started again after a pause, up to `attempts` times in a row; then `onGiveUp` (HQ exits with 1 and the
 * container restarts). A clean stop (the promise resolves: SIGTERM) ends the loop. Resolves when the loop is over.
 */
export async function keepPolling(start: () => Promise<void>, o: KeepPollingOptions): Promise<void> {
  const attempts = o.attempts ?? 3;
  const pause = o.pauseMs ?? 15_000;
  const healthy = o.healthyMs ?? TEN_MIN;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref()));
  let failed = 0;
  for (;;) {
    const began = o.now();
    try {
      await start();
      return;
    } catch (e) {
      if (o.now() - began >= healthy) failed = 0;
      failed++;
      if (failed > attempts) {
        await o.onGiveUp(e);
        return;
      }
      o.onRestart?.(failed, e);
      await sleep(pause * failed);
    }
  }
}
