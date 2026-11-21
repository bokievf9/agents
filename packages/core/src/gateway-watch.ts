import { errMsg, log } from './log.js';
import type { LlmChatRequest, LlmClient, LlmRequest, LlmResult, LlmTurn } from './llm.js';

/** Is this error the gateway being away (connection, timeout, 5xx, 429) rather than a bad request or a refusal? */
export function isOutage(e: unknown): boolean {
  const err = e as { status?: unknown; name?: unknown; code?: unknown } | null;
  const status = typeof err?.status === 'number' ? err.status : undefined;
  if (status !== undefined) return status >= 500 || status === 429;
  const name = typeof err?.name === 'string' ? err.name : '';
  if (/Connection|Timeout|Abort/i.test(name)) return true;
  return /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed|socket hang up|timed out/i.test(errMsg(e));
}

export interface GatewayWatchOptions {
  /** How long the gateway must keep failing before the owner is told (default 60 s). */
  thresholdMs?: number;
  now?: () => number;
  /** Called once when the outage passed the threshold. */
  onDown: () => void | Promise<void>;
  /** Called once when a call succeeds again after `onDown`. */
  onUp: () => void | Promise<void>;
}

/**
 * Watches the model gateway through the calls the company makes anyway. An outage (connection errors, timeouts, 5xx, 429)
 * that lasts longer than the threshold, counted from the start of the first failing call, is reported once; the first call
 * that works afterwards reports the recovery once. Bad requests and refusals are not outages and change nothing.
 */
export class GatewayWatch implements LlmClient {
  private downSince: number | null = null;
  private reported = false;
  private readonly thresholdMs: number;
  private readonly now: () => number;
  readonly completeDetailed?: (req: LlmRequest) => Promise<LlmResult>;
  readonly chat?: (req: LlmChatRequest) => Promise<LlmTurn>;

  constructor(private readonly inner: LlmClient, private readonly o: GatewayWatchOptions) {
    this.thresholdMs = o.thresholdMs ?? 60_000;
    this.now = o.now ?? Date.now;
    if (inner.completeDetailed) this.completeDetailed = (req) => this.watch(() => inner.completeDetailed!(req));
    if (inner.chat) this.chat = (req) => this.watch(() => inner.chat!(req));
  }

  get enabled(): boolean {
    return this.inner.enabled;
  }

  complete(req: LlmRequest): Promise<string> {
    return this.watch(() => this.inner.complete(req));
  }

  get down(): boolean {
    return this.reported;
  }

  private async watch<T>(call: () => Promise<T>): Promise<T> {
    const started = this.now();
    try {
      const r = await call();
      this.up();
      return r;
    } catch (e) {
      if (isOutage(e)) this.failed(started);
      throw e;
    }
  }

  private failed(started: number): void {
    this.downSince ??= started;
    if (!this.reported && this.now() - this.downSince >= this.thresholdMs) {
      this.reported = true;
      void Promise.resolve(this.o.onDown()).catch((e) => log('warn', 'gateway down notice failed', { err: errMsg(e) }));
    }
  }

  private up(): void {
    const wasReported = this.reported;
    this.downSince = null;
    this.reported = false;
    if (wasReported) void Promise.resolve(this.o.onUp()).catch((e) => log('warn', 'gateway up notice failed', { err: errMsg(e) }));
  }
}
