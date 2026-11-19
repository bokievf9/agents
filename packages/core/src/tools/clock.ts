import { zonedParts } from '../time.js';
import { dayIn } from './result.js';

export interface Zoned {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  /** 0 Sunday .. 6 Saturday. */
  dow: number;
  /** `YYYY-MM-DD`. */
  date: string;
  tz: string;
}

export interface Clock {
  /** Epoch ms of the company clock (tests freeze it). */
  now(): number;
  /** Wall clock in `tz` (default: the company's). Throws nothing: an unknown zone falls back to the company zone. */
  zoned(tz?: string): Zoned;
  /** ISO week of a day (`YYYY-MM-DD`, default today in the company zone): `2026-W47`, Monday and Sunday. */
  week(date?: string): { week: string; from: string; to: string };
}

const validZone = (tz: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** ISO 8601 week of a calendar date. */
export function isoWeek(date: string): { week: string; from: string; to: string } {
  const t = Date.parse(`${date}T00:00:00Z`);
  const dow = (new Date(t).getUTCDay() + 6) % 7; // Monday 0
  const monday = t - dow * 86_400_000;
  const thursday = monday + 3 * 86_400_000;
  const year = new Date(thursday).getUTCFullYear();
  const jan4 = Date.UTC(year, 0, 4);
  const week1Monday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * 86_400_000;
  const n = Math.round((monday - week1Monday) / (7 * 86_400_000)) + 1;
  const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { week: `${year}-W${String(n).padStart(2, '0')}`, from: ymd(monday), to: ymd(monday + 6 * 86_400_000) };
}

export function createClock(now: () => number, companyTz: string): Clock {
  return {
    now,
    zoned: (tz) => {
      const zone = tz && validZone(tz) ? tz : companyTz;
      const t = now();
      return { ...zonedParts(t, zone), date: dayIn(t, zone), tz: zone };
    },
    week: (date) => isoWeek(date && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ? date : dayIn(now(), companyTz)),
  };
}
