import { errMsg, log } from '@fir/core';
import type { Embedder } from '../stores.js';

/**
 * Real meaning for the knowledge search: Voyage embeddings (`POST /v1/embeddings`). `embed` is for documents (chunks), `embedQuery` for questions
 * (`input_type` differs). Batches of at most 128 texts, retries with backoff on 429 and 5xx, 15 s timeout per request. No key in the environment:
 * `voyageFromEnv` gives `null` and the caller keeps its default embedder. The adapter never logs texts or the key, only counts.
 */

export const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';
export const VOYAGE_DEFAULT_MODEL = 'voyage-3.5-lite';
export const VOYAGE_DIMS = 1024;
export const VOYAGE_BATCH = 128;

export interface VoyageOptions {
  apiKey: string;
  model?: string;
  fetch?: typeof fetch;
  /** Retries after the first try (default 3); the wait doubles from `backoffMs`. */
  retries?: number;
  backoffMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class VoyageEmbedder implements Embedder {
  readonly dims = VOYAGE_DIMS;
  readonly model: string;
  /** Running totals since start (numbers only). */
  readonly usage = { requests: 0, texts: 0, chars: 0, tokens: 0 };
  private readonly key: string;
  private readonly f: typeof fetch;
  private readonly retries: number;
  private readonly backoff: number;
  private readonly timeout: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(o: VoyageOptions) {
    this.key = o.apiKey;
    this.model = o.model || VOYAGE_DEFAULT_MODEL;
    this.f = o.fetch ?? fetch;
    this.retries = o.retries ?? 3;
    this.backoff = o.backoffMs ?? 500;
    this.timeout = o.timeoutMs ?? 15_000;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Chunks of the knowledge (`input_type: document`). */
  embed(texts: string[]): Promise<number[][]> {
    return this.run(texts, 'document');
  }

  /** Questions (`input_type: query`). */
  embedQuery(texts: string[]): Promise<number[][]> {
    return this.run(texts, 'query');
  }

  private async run(texts: string[], type: 'document' | 'query'): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += VOYAGE_BATCH) out.push(...(await this.batch(texts.slice(i, i + VOYAGE_BATCH), type)));
    if (type === 'document' && texts.length) {
      log('info', 'voyage embedded', { texts: texts.length, chars: texts.reduce((n, t) => n + t.length, 0), tokens: this.usage.tokens, model: this.model });
    }
    return out;
  }

  private async batch(texts: string[], type: 'document' | 'query'): Promise<number[][]> {
    let lastErr = 'unknown';
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt) await this.sleep(this.backoff * 2 ** (attempt - 1));
      try {
        const res = await this.f(VOYAGE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.key}` },
          body: JSON.stringify({ input: texts, model: this.model, input_type: type }),
          signal: AbortSignal.timeout(this.timeout),
        });
        if (res.status === 429 || res.status >= 500) {
          lastErr = `http ${res.status}`;
          continue;
        }
        if (!res.ok) throw new Error(`voyage: http ${res.status}`);
        const json = (await res.json()) as { data?: { index: number; embedding: number[] }[]; usage?: { total_tokens?: number } };
        const data = [...(json.data ?? [])].sort((a, b) => a.index - b.index);
        if (data.length !== texts.length) throw new Error(`voyage: got ${data.length} vectors for ${texts.length} texts`);
        this.usage.requests++;
        this.usage.texts += texts.length;
        this.usage.chars += texts.reduce((n, t) => n + t.length, 0);
        this.usage.tokens += json.usage?.total_tokens ?? 0;
        return data.map((d) => d.embedding);
      } catch (e) {
        // a client error (4xx other than 429) or a malformed answer is not retried; a timeout or a dropped connection is
        const m = errMsg(e);
        if (m.startsWith('voyage:')) throw e;
        lastErr = m;
      }
    }
    throw new Error(`voyage: failed after ${this.retries + 1} tries (${lastErr})`);
  }
}

let announced = false;
/** The Voyage embedder when `VOYAGE_API_KEY` is set, else `null` (logged once). `VOYAGE_MODEL` overrides the model. */
export function voyageFromEnv(env: Record<string, string | undefined> = process.env, o: Partial<VoyageOptions> = {}): VoyageEmbedder | null {
  const apiKey = env.VOYAGE_API_KEY?.trim();
  if (!apiKey) {
    if (!announced) log('info', 'fira embeddings off: VOYAGE_API_KEY not set, knowledge search by words');
    announced = true;
    return null;
  }
  const model = env.VOYAGE_MODEL?.trim() || VOYAGE_DEFAULT_MODEL;
  if (!announced) log('info', 'fira embeddings on', { provider: 'voyage', model });
  announced = true;
  return new VoyageEmbedder({ ...o, apiKey, model });
}
