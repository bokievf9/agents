import { allowedAmounts, detectText } from '@fir/core';
import type { GuardPolicy } from './spec.js';

/**
 * Guards of every Fira reply (the receptionist's `client/sanitize.ts` generalised for all agents; at migration HQ imports these and its own copy goes).
 * The model never names a price that is not on the price list, never promises a date, never sends markdown; stock phrases are flagged.
 * Prices of a company come from the caller (`allowed`): for Fir Tech it is the site price list (`allowedAmounts()`), for a client company its price chunks.
 */

const MONEY =
  /\$\s?\d|\d[\d\s.,]*\s?(\$|usd|eur|€|₽|₸|руб|долл|dollar|сум|сўм|тенге|сом|евро)|\d\s?(тыс|млн|млрд|mln|million|thousand)|\d(к|k)(?![а-яёa-z])|(^|[^а-яё])от\s+\d{2,}|\bfrom\s+\$?\d{2,}|бесплатн|free of charge|for free|скидк|discount|\bprice is\b|стоит\s+\d|costs?\s+\$?\d/i;

const DATE_PROMISE = new RegExp(
  [
    '\\d+\\s*(-|–|до)?\\s*\\d*\\s*(дн[еяи]|день|сут|недел|месяц|час(?!т)|рабоч)',
    '\\b\\d+\\s*(-|to)?\\s*\\d*\\s*(days?|weeks?|months?|hours?|business days?)\\b',
    '(^|[^а-яё])за\\s+(неделю|месяц|пару|день|сутки|час|выходные)',
    '(^|[^а-яё])к\\s+(понедельник|вторник|сред|четверг|пятниц|суббот|воскресен|завтр|концу|началу)',
    '(^|[^а-яё])(завтра|послезавтра|сегодня же)',
    '\\b(tomorrow|by (monday|tuesday|wednesday|thursday|friday|saturday|sunday|the end|next)|within (a|one|two|\\d+) (day|week|month))',
    '\\b\\d{1,2}\\.\\d{1,2}(\\.\\d{2,4})?\\b',
    '\\d{1,2}\\s+(январ|феврал|март|апрел|мая|июн|июл|август|сентябр|октябр|ноябр|декабр)',
  ].join('|'),
  'i',
);

/**
 * Terms the company has published (2026-11-25): the start 3 business days after the first payment, the estimate check within 1 business day, the coupon
 * of 30 days, the acceptance of 7 days. A reply may repeat them word for word; any other duration is still a promise the date guard drops.
 */
const PUBLISHED_TERMS = new RegExp(
  [
    '(через|в течение|в\\s+течени[ие])\\s+3\\s+рабочих\\s+дн(я|ей)(\\s+после\\s+(первого\\s+платежа|первой\\s+оплаты|оплаты\\s+первого\\s+этапа))?',
    'до\\s+1\\s+рабочего\\s+дня',
    '30\\s+дней\\s+(с|после)\\s+(создания|регистрации)',
    'приёмк[аиу]\\s+(занимает\\s+|длится\\s+)?7\\s+дней',
    '7\\s+дней\\s+на\\s+приёмку',
    '(within|in)\\s+3\\s+business\\s+days(\\s+(after|of)\\s+(the\\s+)?first\\s+payment)?',
    'within\\s+1\\s+business\\s+day',
    '30\\s+days\\s+(from|after)\\s+(you\\s+)?(create|creat|sign|regist)\\w*',
    '7\\s+days\\s+to\\s+accept',
  ].join('|'),
  'gi',
);

const DOLLAR = /\$\s?(\d[\d\s]*)(?:[.,]\d+)?/g;

export interface GuardContext {
  /** Dollar amounts that may be said (the company's price list). */
  allowed: Set<number>;
  lang: string;
}

export interface Guarded {
  text: string;
  /** Sentences dropped for a price or a date. */
  removed: number;
  /** Stock phrases and structures `text.detect` found (the app may ask for one rewrite). */
  flagged: string[];
}

const withoutListed = (s: string, ok: Set<number>): string => s.replace(DOLLAR, (m, n: string) => (ok.has(Number(n.replace(/\s/g, ''))) ? ' ' : m));

export const hasMoney = (s: string, ok: Set<number>): boolean => MONEY.test(withoutListed(s, ok));
export const hasDatePromise = (s: string): boolean => DATE_PROMISE.test(s.replace(PUBLISHED_TERMS, ' '));

/** Plain text: no markdown, no lists, no long dashes, no tags. */
export function plain(raw: string): string {
  return raw
    .replace(/\r/g, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\*\*|__|`/g, '')
    .replace(/^\s*#+\s*/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/\s+[—–]\s+/g, ', ')
    .replace(/<[^>]{1,40}>/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** Cut at a sentence end before `max` characters. */
export function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('? '), head.lastIndexOf('! '), head.lastIndexOf('\n'));
  return (end > max * 0.5 ? head.slice(0, end + 1) : `${head.slice(0, max - 1)}…`).trim();
}

export function applyGuards(raw: string, policy: GuardPolicy, ctx: GuardContext): Guarded {
  const text = plain(raw);
  let removed = 0;
  const lines: string[] = [];
  for (const line of text.split('\n')) {
    const sentences = line.split(/(?<=[.!?])\s+/);
    const kept = sentences.filter((s) => {
      const bad = (policy.prices && hasMoney(s, ctx.allowed)) || (policy.dates && hasDatePromise(s));
      if (bad) removed++;
      return !bad;
    });
    if (kept.length) lines.push(kept.join(' '));
  }
  let out = lines.join('\n').trim();
  if (removed > 0) out = `${out}${out ? ' ' : ''}${policy.note}`.trim();
  out = cut(out, policy.maxChars);
  let flagged: string[] = [];
  if (policy.stock && out.length >= 20) {
    const d = detectText(out, ctx.lang);
    flagged = [...d.slop.slice(0, 5).map((s) => s.find.replace(/\*$/, '')), ...d.structures.filter((x) => x.id !== 'uniform-length').slice(0, 2).map((x) => x.name)];
  }
  return { text: out, removed, flagged };
}

/** The guard context of Fir Tech (tenant 0): the site price list. */
export const firtechGuardContext = (lang: string): GuardContext => ({ allowed: allowedAmounts(), lang });
