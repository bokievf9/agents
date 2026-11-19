import { zonedParts, zonedToMs } from '@fir/core';

/** ISO weeks (`2026-W47`, Monday first) on the company's clock, for the workplace's content calendar and weekly numbers. */
const DAY = 86_400_000;
export const WEEK_RE = /^(\d{4})-W(0[1-9]|[1-4]\d|5[0-3])$/;
const ymd = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** ISO week label of a `YYYY-MM-DD` date. */
export function isoWeekOf(date: string): string {
  const t = Date.parse(`${date}T00:00:00Z`);
  const dow = (new Date(t).getUTCDay() + 6) % 7; // Monday = 0
  const thursday = t - dow * DAY + 3 * DAY;
  const year = new Date(thursday).getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const week = Math.floor((thursday - jan1) / (7 * DAY)) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** Monday and Sunday (`YYYY-MM-DD`) of an ISO week label; null when the label is not a real week. */
export function weekRange(week: string): { from: string; to: string } | null {
  const m = WEEK_RE.exec(week);
  if (!m) return null;
  const year = Number(m[1]);
  const n = Number(m[2]);
  const jan4 = Date.UTC(year, 0, 4);
  const mondayOfWeek1 = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY;
  const from = mondayOfWeek1 + (n - 1) * 7 * DAY;
  const out = { from: ymd(from), to: ymd(from + 6 * DAY) };
  return isoWeekOf(out.from) === week ? out : null;
}

export const shiftWeek = (week: string, by: number): string => isoWeekOf(ymd(Date.parse(`${weekRange(week)!.from}T00:00:00Z`) + by * 7 * DAY));

/** Today's date (`YYYY-MM-DD`) on the clock `tz`. */
export function todayIn(now: number, tz: string): string {
  const p = zonedParts(now, tz);
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** Epoch ms window [from, to) of a week on the clock `tz`. */
export function weekWindow(week: string, tz: string): { fromMs: number; toMs: number } | null {
  const r = weekRange(week);
  if (!r) return null;
  const at = (date: string, plusDays: number) => {
    const t = new Date(Date.parse(`${date}T00:00:00Z`) + plusDays * DAY);
    return zonedToMs(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), 0, 0, tz);
  };
  return { fromMs: at(r.from, 0), toMs: at(r.from, 7) };
}
