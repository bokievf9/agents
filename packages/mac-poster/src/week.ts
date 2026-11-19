/** `YYYY-MM-DD` of the Mac's local clock (the owner's Mac runs on Kuala Lumpur time). */
export function localDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export const isDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/** ISO week `YYYY-Www` of a calendar date (the week HQ's `GET /admin/content?week=` takes). */
export function isoWeek(date: string): string {
  if (!isDate(date)) throw new Error(`bad date: ${date}`);
  const d = new Date(`${date}T00:00:00Z`);
  const dow = d.getUTCDay() || 7; // Monday 1 .. Sunday 7
  d.setUTCDate(d.getUTCDate() + 4 - dow); // the Thursday of this week decides the year
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** The date `days` before/after `date`. */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** The weeks to fetch for a run on `date`: the previous one too, so overdue items are picked up. */
export const weeksFor = (date: string): string[] => [...new Set([isoWeek(addDays(date, -7)), isoWeek(date)])];
