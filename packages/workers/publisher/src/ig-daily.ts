import { errMsg, log } from '@fir/core';
import { IgError, type IgApi } from './instagram.js';
import type { PublishStore } from './store.js';

const DAY = 86_400_000;
/** Long-lived user tokens live 60 days. */
export const TOKEN_DAYS = 60;
export const TOKEN_WARN_DAYS = 7;
export const TOKEN_EXPIRED_TEXT = 'Токен Instagram истёк: обновите в чеклисте (скрытое окно)';

export interface InstagramDailyOptions {
  api: IgApi;
  store: PublishStore;
  /** The HQ day (YYYY-MM-DD): the key of the once-a-day alerts. */
  day: () => string;
  now: () => number;
  /** `IG_TOKEN_ISSUED_AT`: the date the token was made (ISO). Enables the warning 7 days before it expires. */
  tokenIssuedAt?: string | undefined;
}

export interface InstagramDailyResult {
  /** Owner alerts (each at most once a day). */
  alerts: string[];
  /** The line for the morning header, with the first three new comments; empty when there are none. */
  commentsLine: string;
  newComments: number;
}

/** Days left of the token by its issue date, or null when the date is not set or unreadable. */
export function tokenDaysLeft(issuedAt: string | undefined, now: number): number | null {
  const t = issuedAt ? Date.parse(issuedAt) : NaN;
  return Number.isFinite(t) ? Math.ceil((t + TOKEN_DAYS * DAY - now) / DAY) : null;
}

/**
 * The morning Instagram run: token health (`GET /me?fields=id`; an expired token, code 190, alerts the owner once a day; the
 * warning 7 days ahead comes from `IG_TOKEN_ISSUED_AT`) and the comments digest of the media of the last 7 days (new ones go to
 * `pb_comments`, the first three into the header line). Replies are not made here yet.
 * TODO: answer comments through the Support head (rows have `replied = 0` until then).
 */
export class InstagramDaily {
  constructor(private readonly o: InstagramDailyOptions) {}

  async run(): Promise<InstagramDailyResult> {
    const { store } = this.o;
    const day = this.o.day();
    const alerts: string[] = [];
    const once = (key: string, text: string) => {
      if (store.igState(key) === day) return;
      store.setIgState(key, day);
      alerts.push(text);
    };
    let expired = false;
    try {
      await this.o.api.get('me', { fields: 'id' });
    } catch (e) {
      // core drops the error body of a GET, so code 190 shows up as the HTTP status of an invalid token (400/401/403)
      if (e instanceof IgError && [400, 401, 403].includes(e.status)) {
        expired = true;
        once('token_alert', TOKEN_EXPIRED_TEXT);
      } else log('warn', 'instagram: token check failed', { err: errMsg(e) });
    }
    const left = tokenDaysLeft(this.o.tokenIssuedAt, this.o.now());
    if (!expired && left !== null && left <= TOKEN_WARN_DAYS) once('token_warn', left <= 0 ? TOKEN_EXPIRED_TEXT : `Токен Instagram истекает через ${left} дн.: обновите в чеклисте (скрытое окно)`);
    if (expired) return { alerts, commentsLine: '', newComments: 0 };

    const fresh: { username: string; text: string }[] = [];
    const now = this.o.now();
    for (const m of store.instagramPublished(now - 7 * DAY, now + DAY)) {
      try {
        const r = await this.o.api.get(`${m.mediaId}/comments`, { fields: 'text,username,timestamp', limit: 50 });
        for (const c of (r.data as { id?: unknown; text?: unknown; username?: unknown; timestamp?: unknown }[] | undefined) ?? []) {
          if (typeof c.id !== 'string' || typeof c.text !== 'string') continue;
          const username = typeof c.username === 'string' ? c.username : 'unknown';
          if (store.addComment({ id: c.id, mediaId: m.mediaId, username, text: c.text, at: typeof c.timestamp === 'string' ? c.timestamp : '' })) fresh.push({ username, text: c.text.slice(0, 500) });
        }
      } catch (e) {
        log('warn', 'instagram: comments failed', { mediaId: m.mediaId, err: errMsg(e) });
      }
    }
    const commentsLine = fresh.length
      ? [`Комментарии в Instagram: ${fresh.length} ${fresh.length === 1 ? 'новый' : 'новых'}`, ...fresh.slice(0, 3).map((c) => `@${c.username}: ${c.text.replace(/\s+/g, ' ').slice(0, 120)}`)].join('\n')
      : '';
    return { alerts, commentsLine, newComments: fresh.length };
  }
}
