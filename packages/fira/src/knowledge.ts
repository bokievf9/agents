import { createHash } from 'node:crypto';
import type { Embedder } from './stores.js';

/**
 * Knowledge helpers that do not depend on the store: chunking imported text, a deterministic embedder for tests and evals, and the scoring
 * of the hybrid search (words and meaning). The Supabase adapter does the same scoring in SQL (`sql/fira-schema.sql`, `fira_match_chunks`).
 */

const norm = (s: string): string => s.toLowerCase().replace(/ё/g, 'е');
/** Words of 3+ letters, cut to a 5-letter stem (Russian endings), as the playground's search did. */
export const stems = (s: string): string[] => (norm(s).match(/[\p{L}\p{N}]{3,}/gu) ?? []).map((w) => w.slice(0, 5));

/**
 * Splits text into chunks of about `size` characters at paragraph and sentence ends, with `overlap` characters carried into the next chunk.
 * Empty text gives no chunks. Deterministic.
 */
export function chunkText(text: string, o: { size?: number; overlap?: number } = {}): string[] {
  const size = o.size ?? 800;
  const overlap = Math.min(o.overlap ?? 100, Math.floor(size / 2));
  const parts = text.replace(/\r/g, '').split(/\n{2,}|(?<=[.!?])\s+/).map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const out: string[] = [];
  let cur = '';
  for (const p of parts) {
    if (cur && cur.length + p.length + 1 > size) {
      out.push(cur);
      const tail = cur.slice(-overlap);
      cur = overlap > 0 ? `${tail.slice(tail.indexOf(' ') + 1)} ${p}` : p;
    } else cur = cur ? `${cur} ${p}` : p;
    while (cur.length > size * 1.5) {
      out.push(cur.slice(0, size));
      cur = cur.slice(size - overlap);
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Share of the query's stems found in the text (0..1). */
export function wordScore(query: string, text: string): number {
  const want = [...new Set(stems(query))];
  if (!want.length) return 0;
  const have = new Set(stems(text));
  return want.filter((w) => have.has(w)).length / want.length;
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** The hybrid score: half words, half meaning; the source of the hit is the half that carried it. */
export function hybrid(words: number, meaning: number): { score: number; via: 'words' | 'meaning' | 'both' } {
  const m = Math.max(0, meaning);
  const score = 0.5 * words + 0.5 * m;
  const via = words >= 0.3 && m >= 0.3 ? 'both' : words >= m ? 'words' : 'meaning';
  return { score, via };
}

/** Below this the hit is noise. */
export const MIN_SCORE = 0.2;

/**
 * Deterministic test embedder: character trigrams of the stems hashed into `dims` buckets. Close spellings land close; no network, no model.
 * Not for production (no real meaning), only to exercise the «meaning» path in tests and evals.
 */
export class HashEmbedder implements Embedder {
  constructor(readonly dims = 256) {}

  embed(texts: string[]): Promise<number[][]> {
    return Promise.resolve(
      texts.map((t) => {
        const v = new Array<number>(this.dims).fill(0);
        for (const w of stems(t)) {
          const padded = ` ${w} `;
          for (let i = 0; i + 3 <= padded.length; i++) {
            const h = createHash('sha1').update(padded.slice(i, i + 3)).digest();
            v[h.readUInt32BE(0) % this.dims]! += 1;
          }
        }
        return v;
      }),
    );
  }
}
