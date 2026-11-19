import { DEFAULT_QUIET_HOURS, type Hq } from '@fir/hq';

/**
 * First start of the two clocks (see `DEFAULT_SETTINGS` in `@fir/hq`): the company's timezone from `TZ`, the owner's from `OWNER_TZ`,
 * and the owner's quiet hours. A value already in the database is never touched (the owner changes them through the Director),
 * so a server that already runs keeps its `tz` and only gains the owner clock and the quiet hours.
 */
export function seedTiming(hq: Hq, cfg: { tz: string; ownerTz: string }): void {
  const has = (key: string) => Boolean(hq.db.prepare('SELECT 1 FROM settings WHERE key = ?').get(key));
  if (!has('tz')) hq.setSetting('tz', cfg.tz);
  if (!has('owner_tz')) hq.setSetting('owner_tz', cfg.ownerTz);
  if (!has('quiet_hours')) hq.setSetting('quiet_hours', DEFAULT_QUIET_HOURS);
}
