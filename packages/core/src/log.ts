/**
 * JSON-line logs to stdout. Never pass message bodies, names, contacts or tokens here:
 * use ids and counts only (client personal data must not reach the logs).
 */
export function log(level: 'info' | 'warn' | 'error', msg: string, extra: Record<string, unknown> = {}): void {
  const rec = { t: new Date().toISOString(), level, msg, ...extra };
  (level === 'error' ? console.error : console.log)(JSON.stringify(rec));
}

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
