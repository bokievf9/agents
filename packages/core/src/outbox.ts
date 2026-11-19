import { errMsg, log } from './log.js';
import type { Button, EditOptions, Messenger, SendOptions } from './messenger.js';

export interface OutboxOptions {
  /** Pause between two sends, so a batch of cards stays under Telegram's flood limits (default 1100 ms). */
  minGapMs?: number;
  /** Retries after the first failure (429 and 5xx/network only; default 3). */
  maxRetries?: number;
  /** Backoff base for 5xx and network errors: base, 2x base, 4x base (default 1000 ms). */
  backoffMs?: number;
  /** Tests inject these. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** How long to wait before retrying this error, or null when it is not worth retrying (a 400, a blocked bot, a bug). */
export function retryDelayMs(e: unknown, attempt: number, backoffMs: number): number | null {
  const err = e as { error_code?: unknown; parameters?: { retry_after?: unknown }; name?: unknown } | null;
  const code = typeof err?.error_code === 'number' ? err.error_code : undefined;
  if (code === 429) {
    const ra = Number(err?.parameters?.retry_after);
    return (Number.isFinite(ra) && ra > 0 ? ra : 1) * 1000 + 100;
  }
  if ((code !== undefined && code >= 500) || err?.name === 'HttpError') return backoffMs * 2 ** attempt;
  return null;
}

/**
 * One door for everything sent to Telegram: sends go out one at a time with a gap between them, and a 429 (waits the
 * `retry_after` Telegram names) or a 5xx/network error (backoff, up to `maxRetries`) is retried instead of aborting the
 * caller's batch. Edits only get the retry (they are rarely in bursts and a button press must not queue behind a batch).
 * A send resolves only after Telegram confirmed it, so callers record "sent" strictly after success.
 */
export class OutboxMessenger implements Messenger {
  private tail: Promise<unknown> = Promise.resolve();
  private lastSendAt = 0;
  private readonly minGapMs: number;
  private readonly maxRetries: number;
  private readonly backoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  readonly sendVideo?: Messenger['sendVideo'];
  readonly sendPhotos?: Messenger['sendPhotos'];
  readonly sendDocument?: Messenger['sendDocument'];

  constructor(private readonly inner: Messenger, o: OutboxOptions = {}) {
    this.minGapMs = o.minGapMs ?? 1100;
    this.maxRetries = o.maxRetries ?? 3;
    this.backoffMs = o.backoffMs ?? 1000;
    this.sleep = o.sleep ?? realSleep;
    this.now = o.now ?? Date.now;
    const i = inner;
    if (i.sendVideo) this.sendVideo = (c, f, cap, b) => this.queued('sendVideo', () => i.sendVideo!(c, f, cap, b));
    if (i.sendPhotos) this.sendPhotos = (c, f, cap) => this.queued('sendPhotos', () => i.sendPhotos!(c, f, cap));
    if (i.sendDocument) this.sendDocument = (c, f, cap) => this.queued('sendDocument', () => i.sendDocument!(c, f, cap));
  }

  private async withRetry<T>(what: string, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        const wait = attempt < this.maxRetries ? retryDelayMs(e, attempt, this.backoffMs) : null;
        if (wait === null) throw e;
        log('warn', 'telegram send retried', { what, attempt: attempt + 1, waitMs: wait, err: errMsg(e).slice(0, 120) });
        await this.sleep(wait);
      }
    }
  }

  private queued<T>(what: string, fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const gap = this.lastSendAt + this.minGapMs - this.now();
      if (gap > 0) await this.sleep(gap);
      try {
        return await this.withRetry(what, fn);
      } finally {
        this.lastSendAt = this.now();
      }
    };
    const p = this.tail.then(run, run);
    this.tail = p.catch(() => undefined);
    return p;
  }

  send(chatId: number, text: string, buttons?: Button[][], opts?: SendOptions): Promise<void> {
    return this.queued('send', () => this.inner.send(chatId, text, buttons, opts));
  }

  sendMessage(chatId: number, text: string, buttons?: Button[][], opts?: SendOptions): Promise<number> {
    return this.queued('sendMessage', () => this.inner.sendMessage(chatId, text, buttons, opts));
  }

  edit(chatId: number, messageId: number, text: string, opts?: EditOptions): Promise<void> {
    return this.withRetry('edit', () => this.inner.edit(chatId, messageId, text, opts));
  }

  editButtons(chatId: number, messageId: number, buttons: Button[][] | null): Promise<void> {
    return this.withRetry('editButtons', () => this.inner.editButtons(chatId, messageId, buttons));
  }
}
