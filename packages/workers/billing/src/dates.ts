import { zonedParts } from '@fir/core';

/** Local calendar date `YYYY-MM-DD` of a moment in the HQ timezone. */
export function dateStr(ms: number, tz: string): string {
  const p = zonedParts(ms, tz);
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

const utc = (s: string): number => {
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
};

export const isDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(utc(s)) && new Date(utc(s)).toISOString().startsWith(s);

/** `b - a` in whole calendar days. */
export const diffDays = (a: string, b: string): number => Math.round((utc(b) - utc(a)) / 86_400_000);

export function addDays(s: string, n: number): string {
  return new Date(utc(s) + n * 86_400_000).toISOString().slice(0, 10);
}

/** Adds calendar months, clamping the day (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(s: string, n: number): string {
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

export const ruDate = (s: string): string => `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}`;
