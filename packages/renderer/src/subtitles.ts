export interface Word {
  text: string;
  /** Frame, relative to the scene start, at which the word starts being spoken. */
  startFrame: number;
}

export interface Phrase {
  text: string;
  startFrame: number;
  endFrame: number;
  words: Word[];
}

export const MAX_PHRASE_WORDS = 5;

/** Sentences, then commas or dashes inside long ones, then even pieces of at most `max` words. */
export function chunkPhrases(text: string, max = MAX_PHRASE_WORDS): string[] {
  const sentences = text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?…])\s+/).filter(Boolean);
  const out: string[] = [];
  for (const s of sentences) {
    const parts = s.split(/(?<=[,;:—–])\s+/).filter(Boolean);
    // glue tiny comma pieces to their neighbour so that «Да, но» does not become a phrase of its own
    const merged: string[] = [];
    for (const p of parts) {
      const prev = merged.at(-1);
      if (prev !== undefined && (prev.split(' ').length < 3 || p.split(' ').length < 2) && (prev + ' ' + p).split(' ').length <= max + 1) merged[merged.length - 1] = `${prev} ${p}`;
      else merged.push(p);
    }
    for (const p of merged) {
      const words = p.split(' ');
      const n = Math.max(1, Math.ceil(words.length / max));
      const size = Math.ceil(words.length / n);
      for (let i = 0; i < words.length; i += size) out.push(words.slice(i, i + size).join(' '));
    }
  }
  return out;
}

const weight = (w: string): number => Math.max(3, w.replace(/[^\p{L}\p{N}]/gu, '').length);

/**
 * Subtitle phrases timed proportionally to character count across the voice length (no speech recognition). The phrases
 * cover the whole voice: the first starts at 0 and the last ends at `voiceFrames`.
 */
export function timePhrases(text: string, voiceFrames: number, max = MAX_PHRASE_WORDS): Phrase[] {
  const chunks = chunkPhrases(text, max);
  const allWords = chunks.flatMap((c) => c.split(' '));
  const total = allWords.reduce((n, w) => n + weight(w), 0);
  if (total === 0) return [];
  let acc = 0;
  return chunks.map((chunk) => {
    const words: Word[] = chunk.split(' ').map((w) => {
      const startFrame = Math.round((acc / total) * voiceFrames);
      acc += weight(w);
      return { text: w, startFrame };
    });
    return { text: chunk, startFrame: words[0]!.startFrame, endFrame: Math.round((acc / total) * voiceFrames), words };
  });
}

/** The phrase on screen at a frame (the last one stays until the scene ends); null before the first. */
export function phraseAt(phrases: Phrase[], frame: number): Phrase | null {
  let cur: Phrase | null = null;
  for (const p of phrases) if (frame >= p.startFrame) cur = p;
  return cur;
}
