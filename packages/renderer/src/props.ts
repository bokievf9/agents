import type { FiraBrand } from './fira-spec.js';
import type { SfxCue } from './sfx.js';
import type { Timeline } from './timing.js';

/** Everything the «Reel» composition needs; JSON-serialisable (it travels as Remotion input props). */
export type ReelProps = {
  hook: string;
  cta: string;
  scenes: { subtitle: string; voice: string; /** Path inside the public dir, null without voice. */ audio: string | null }[];
  ctaAudio: string | null;
  timeline: Timeline;
  /** Sound effects under the voice (`planSfx`); absent or empty: none. */
  sfx?: SfxCue[];
  /** Brand layer. `fira`: the turtle sticker (see `fira-spec.ts`); absent or false: none. `buildProps` turns it on by default for Fir Tech's own channels. */
  brand?: { fira?: FiraBrand };
};
