import type { Timeline } from './timing.js';

/** Everything the «Reel» composition needs; JSON-serialisable (it travels as Remotion input props). */
export type ReelProps = {
  hook: string;
  cta: string;
  scenes: { subtitle: string; voice: string; /** Path inside the public dir, null without voice. */ audio: string | null }[];
  ctaAudio: string | null;
  timeline: Timeline;
};
