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
