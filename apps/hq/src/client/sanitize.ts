import { allowedAmounts, planOf, zonedParts } from '@fir/core';

export const MAX_ANSWER = 600;

/** Money in any form: amounts with a currency, «от 300», «5к», free-of-charge and discount promises. */
const MONEY =
  /\$\s?\d|\d[\d\s.,]*\s?(\$|usd|eur|€|₽|₸|руб|долл|dollar|сум|сўм|тенге|сом|евро)|\d\s?(тыс|млн|млрд|mln|million|thousand)|\d(к|k)(?![а-яёa-z])|(^|[^а-яё])от\s+\d{2,}|\bfrom\s+\$?\d{2,}|бесплатн|free of charge|for free|скидк|discount|\bprice is\b|стоит\s+\d|costs?\s+\$?\d/i;

/** A promise of a date or a duration: «за 3 дня», «к пятнице», «до 25 ноября», «within a week», «by Friday». */
const DATE_PROMISE = new RegExp(
  [
    '\\d+\\s*(-|–|до)?\\s*\\d*\\s*(дн[еяи]|день|сут|недел|месяц|час(?!т)|рабоч)',
    '\\b\\d+\\s*(-|to)?\\s*\\d*\\s*(days?|weeks?|months?|hours?|business days?)\\b',
    '(^|[^а-яё])за\\s+(неделю|месяц|пару|день|сутки|час|выходные)',
    '(^|[^а-яё])к\\s+(понедельник|вторник|сред|четверг|пятниц|суббот|воскресен|завтр|концу|началу)',
    '(^|[^а-яё])(до|к)\\s+\\d{1,2}(\\s|[.])',
    '(^|[^а-яё])(завтра|послезавтра|сегодня же)',
    '\\b(tomorrow|by (monday|tuesday|wednesday|thursday|friday|saturday|sunday|the end|next)|within (a|one|two|\\d+) (day|week|month))',
    '\\b\\d{1,2}\\.\\d{1,2}(\\.\\d{2,4})?\\b',
    '\\d{1,2}\\s+(январ|феврал|март|апрел|мая|июн|июл|август|сентябр|октябр|ноябр|декабр)',
    '\\b(january|february|march|april|may|june|july|august|september|october|november|december)\\s+\\d',
  ].join('|'),
  'i',
);

/** A dollar amount: «$N», «$ 1 500». */
const DOLLAR = /\$\s?(\d[\d\s]*)(?:[.,]\d+)?/g;

/**
 * Dollar amounts a sentence may carry: those of the site price list (`getPrices()`, the single source of the studio's
 * prices). A sentence about Dono or Polly may carry only that agent's own plan amounts, so Dono with another agent's or a stale amount goes.
 * Whether the amount belongs to the product named next to it is the prompt's job; here an amount that is on no price
 * list is a made-up price.
 */
function amountsAllowedIn(sentence: string): Set<number> {
  const agents = (['dono', 'polly'] as const).filter((id) => new RegExp(`\\b${id}\\b`, 'i').test(sentence));
  if (agents.length === 0) return allowedAmounts();
  const s = new Set<number>();
  for (const id of agents) {
    const p = planOf(id);
    s.add(p.setup);
    s.add(p.monthly);
  }
  return s;
}

/** Price-list dollar amounts are removed before the money check; anything else with money in it stays a violation. */
const withoutListedPrices = (s: string): string => {
  const ok = amountsAllowedIn(s);
  return s.replace(DOLLAR, (m, n: string) => (ok.has(Number(n.replace(/\s/g, ''))) ? ' ' : m));
};

export const hasMoneyOrDate = (s: string): boolean => {
  const rest = withoutListedPrices(s);
  return MONEY.test(rest) || DATE_PROMISE.test(rest);
};

export interface Sanitized {
  text: string;
  /** Sentences dropped for a price or a date promise. */
  removed: number;
}

/**
 * Every LLM answer to a client goes through this before it is sent: sentences with a price or a date promise are
 * dropped (the owner names prices and dates, never the model) and replaced by one honest note, markdown is stripped,
 * long dashes become commas, and the result is cut to `max` characters at a sentence end. Texts the owner approved
 * are delivered by the heads as they are and never come here.
 */
export function sanitizeAnswer(raw: string, note: string, max = MAX_ANSWER): Sanitized {
  const plain = raw
    .replace(/\r/g, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\*\*|__|`/g, '')
    .replace(/^\s*#+\s*/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/\s+[—–]\s+/g, ', ')
    .replace(/<[^>]{1,40}>/g, '');
  let removed = 0;
  const lines: string[] = [];
  for (const line of plain.split(/\n+/)) {
    const kept = line
      .split(/(?<=[.!?…])\s+/)
      .filter((s) => {
        if (!s.trim()) return false;
        if (hasMoneyOrDate(s)) {
          removed++;
          return false;
        }
        return true;
      })
      .join(' ')
      .replace(/[ \t]+/g, ' ')
      .trim();
    if (kept) lines.push(kept);
  }
  let text = lines.join('\n');
  if (removed > 0) text = text ? `${text}\n${note}` : note;
  if (text.length > max) {
    const cut = text.slice(0, max);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('.\n'), cut.lastIndexOf('?\n'));
    text = end > max / 3 ? cut.slice(0, end + 1) : `${cut.slice(0, max - 1).trimEnd()}…`;
  }
  return { text: text.trim(), removed };
}

/** «22:00-08:00» in the company timezone; an empty or broken window means never quiet. */
export function inWindow(at: number, tz: string, window: string): boolean {
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(window.trim());
  if (!m) return false;
  const p = zonedParts(at, tz);
  const cur = p.h * 60 + p.mi;
  const from = Number(m[1]) * 60 + Number(m[2]);
  const to = Number(m[3]) * 60 + Number(m[4]);
  if (from === to) return false;
  return from < to ? cur >= from && cur < to : cur >= from || cur < to;
}

const URL_RE = /(https?:\/\/|www\.|t\.me\/|@\w{4,}\b)\S*/gi;

/** A message that is only links (or @mentions) with no words around them. */
export function linksOnly(text: string): boolean {
  if (!text.match(URL_RE)) return false;
  return text.replace(URL_RE, '').replace(/[\s\p{P}\p{S}]/gu, '').length < 3;
}

/**
 * Per-chat limit (messages per sliding hour) and a global daily cap on LLM calls. The hourly windows are in memory (a
 * restart forgets them, which only makes the bot more generous for a moment); the daily call counter is kept in `store`
 * (HQ settings) so that a deploy does not reset it. Counts only, never texts.
 */
export interface CounterStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

const COUNTER_KEY = 'llm_daily';
const HITS_SWEEP_AT = 2000;

export class RateLimiter {
  private readonly hits = new Map<number | string, number[]>();
  private readonly warned = new Set<number | string>();
  private day = '';
  private llmCalls = 0;
  private loaded = false;

  constructor(
    private readonly perHour: number,
    private readonly dailyCap: number,
    private readonly now: () => number,
    private readonly tz: () => string,
    private readonly store?: CounterStore,
  ) {}

  /** 'ok', 'warn' (first message over the limit: answer once) or 'drop' (stay silent). */
  hit(chatId: number | string): 'ok' | 'warn' | 'drop' {
    const t = this.now();
    const list = (this.hits.get(chatId) ?? []).filter((x) => x > t - 3600_000);
    list.push(t);
    this.hits.set(chatId, list);
    // every chat or session id stays in the map: sweep the ones that have gone quiet for an hour
    if (this.hits.size > HITS_SWEEP_AT) {
      for (const [k, v] of this.hits) if ((v.at(-1) ?? 0) <= t - 3600_000) {
        this.hits.delete(k);
        this.warned.delete(k);
      }
    }
    if (list.length <= this.perHour) {
      this.warned.delete(chatId);
      return 'ok';
    }
    if (this.warned.has(chatId)) return 'drop';
    this.warned.add(chatId);
    return 'warn';
  }

  private today(): string {
    const p = zonedParts(this.now(), this.tz());
    return `${p.y}-${p.mo}-${p.d}`;
  }

  /** Rolls the day over and, once, restores today's count from the store (a restart or deploy in the middle of the day). */
  private sync(): void {
    const today = this.today();
    if (!this.loaded) {
      this.loaded = true;
      try {
        const saved = JSON.parse(this.store?.get(COUNTER_KEY) ?? 'null') as { day?: unknown; n?: unknown } | null;
        if (saved && saved.day === today && typeof saved.n === 'number' && saved.n >= 0) {
          this.day = today;
          this.llmCalls = saved.n;
        }
      } catch {
        // a damaged value counts as no value
      }
    }
    if (today !== this.day) {
      this.day = today;
      this.llmCalls = 0;
      this.save();
    }
  }

  private save(): void {
    try {
      this.store?.set(COUNTER_KEY, JSON.stringify({ day: this.day, n: this.llmCalls }));
    } catch {
      // the counter is a safety net, never a reason to fail an answer
    }
  }

  llmAllowed(): boolean {
    this.sync();
    return this.llmCalls < this.dailyCap;
  }

  llmUsed(): void {
    this.sync();
    this.llmCalls++;
    this.save();
  }

  get llmToday(): number {
    this.llmAllowed();
    return this.llmCalls;
  }
}
