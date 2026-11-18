import { FPS } from './schema';

export const HOOK_SECONDS = 1.6;
export const GAP_SECONDS = 0.3;
export const END_CARD_SECONDS = 2.2;
export const MAX_WORDS_PER_LINE = 4;

export interface Segment {
  kind: 'scene' | 'cta';
  /** Index in the script scenes; -1 for the CTA. */
  index: number;
  startFrame: number;
  durationFrames: number;
  /** Frames the voice itself lasts (audio starts at startFrame). */
  voiceFrames: number;
}

export interface Timeline {
  fps: number;
  segments: Segment[];
  /** Frame where the end card begins (the CTA segment). */
  endCardFrame: number;
  totalFrames: number;
}

/** Scene durations in seconds (voice lengths) to frames: each scene lasts its voice plus a short gap; the CTA segment is at least the end-card length. */
export function buildTimeline(sceneSeconds: number[], ctaSeconds: number, fps = FPS): Timeline {
  const segments: Segment[] = [];
  let cursor = 0;
  const push = (kind: Segment['kind'], index: number, voiceSec: number, minSec: number) => {
    const voiceFrames = Math.max(1, Math.ceil(voiceSec * fps));
    const durationFrames = Math.max(voiceFrames + Math.round(GAP_SECONDS * fps), Math.round(minSec * fps));
    segments.push({ kind, index, startFrame: cursor, durationFrames, voiceFrames });
    cursor += durationFrames;
  };
  sceneSeconds.forEach((s, i) => push('scene', i, s, 0));
  const endCardFrame = cursor;
  push('cta', -1, ctaSeconds, END_CARD_SECONDS);
  return { fps, segments, endCardFrame, totalFrames: cursor };
}

export interface WordTiming {
  word: string;
  /** Frame (relative to the segment start) at which the word starts being spoken. */
  startFrame: number;
}

/** Words of a line with start frames, spread across the voice length in proportion to word length (a floor of 3 chars per word). */
export function wordTimings(text: string, voiceFrames: number): WordTiming[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const weights = words.map((w) => Math.max(3, w.replace(/[^\p{L}\p{N}]/gu, '').length));
  const total = weights.reduce((a, b) => a + b, 0);
  let acc = 0;
  return words.map((word, i) => {
    const startFrame = Math.round((acc / total) * voiceFrames);
    acc += weights[i]!;
    return { word, startFrame };
  });
}

/** Splits a subtitle into display lines of at most `max` words, keeping each word's timing. */
export function chunkLines(words: WordTiming[], max = MAX_WORDS_PER_LINE): WordTiming[][] {
  const n = Math.max(1, Math.ceil(words.length / max));
  const size = Math.ceil(words.length / n);
  const lines: WordTiming[][] = [];
  for (let i = 0; i < words.length; i += size) lines.push(words.slice(i, i + size));
  return lines;
}

/** Music volume at a frame: low under the voice, smooth ramps over `ramp` frames, a bit louder on the end card; fades out in the last second. */
export function musicVolume(frame: number, t: Timeline, base = 0.12, ducked = 0.07): number {
  const ramp = 8;
  let voiced = 0;
  for (const s of t.segments) {
    const a = s.startFrame;
    const b = s.startFrame + s.voiceFrames;
    const inside = Math.min(1, Math.max(0, Math.min(frame - a + ramp, b + ramp - frame) / ramp));
    voiced = Math.max(voiced, inside);
  }
  const v = base - (base - ducked) * voiced;
  const fade = Math.min(1, Math.max(0, (t.totalFrames - frame) / t.fps));
  return v * fade;
}
