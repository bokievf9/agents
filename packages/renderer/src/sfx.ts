import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Timeline } from './timing.js';

/**
 * The sound layer of a reel: three short effects from `assets/sfx` (rendered from the earshot bank, see `assets/sfx/CREDITS.md`):
 * a whoosh on every change of scene, a soft pop when a scene's text appears and a hit on the final card. They sit 14 dB under the voice
 * and no two of them start closer than 250 ms to each other. A render job with `sfx: false` (or `RENDER_SFX=off`) has none.
 */
export const SFX_GAIN_DB = -14;
/** Linear volume for `<Audio volume>`: the files are normalised to a -1 dBFS peak, so this is the level under the voice. */
export const SFX_VOLUME = 10 ** (SFX_GAIN_DB / 20);
/** Minimum distance between the starts of two effects, in seconds. */
export const SFX_MIN_GAP_SECONDS = 0.25;

export type SfxKind = 'whoosh' | 'pop' | 'hit';
export interface SfxSound {
  /** File in `assets/sfx`, also `sfx/<file>` inside the Remotion bundle. */
  file: string;
  seconds: number;
  /** Seconds from the start of the file to its loudest moment: the effect is placed so that moment lands on the picture's event. */
  peakSec: number;
}
/** earshot ids: whoosh_fast/whip, ui_pop/soft, cut_hit/kick. */
export const SFX: Record<SfxKind, SfxSound> = {
  whoosh: { file: 'whoosh_fast_whip.wav', seconds: 0.91, peakSec: 0.116 },
  pop: { file: 'ui_pop_soft.wav', seconds: 0.18, peakSec: 0.042 },
  hit: { file: 'cut_hit_kick.wav', seconds: 0.325, peakSec: 0.013 },
};

export interface SfxCue {
  kind: SfxKind;
  file: string;
  startFrame: number;
  durationFrames: number;
  volume: number;
}

export const SFX_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'sfx');

/** True when every effect the layer uses is on disk (a checkout without the assets renders without sound effects instead of failing). */
export const sfxAvailable = (dir: string = SFX_DIR): boolean => Object.values(SFX).every((s) => existsSync(join(dir, s.file)));

/** Copies the effects into a public dir (the bundle serves them as `sfx/*`). */
export function prepareSfx(publicDir: string, dir: string = SFX_DIR): void {
  const dst = join(publicDir, 'sfx');
  mkdirSync(dst, { recursive: true });
  for (const s of Object.values(SFX)) if (existsSync(join(dir, s.file))) copyFileSync(join(dir, s.file), join(dst, s.file));
}

/**
 * Where the effects go for a timeline: a whoosh into the first scene text and into every later scene (its loudest moment on the cut), a pop
 * just after each text appears (the hook included), a hit on the final card. Conflicts are settled by priority (hit, whoosh, pop): a cue that
 * would start within 250 ms of an accepted one is dropped. Cues are returned in time order.
 */
export function planSfx(timeline: Timeline): SfxCue[] {
  const { fps, segments, hookFrames, totalFrames } = timeline;
  const minGap = Math.ceil(SFX_MIN_GAP_SECONDS * fps);
  const ahead = (k: SfxKind) => Math.round(SFX[k].peakSec * fps);
  const cands: { kind: SfxKind; at: number; rank: number }[] = [];
  const cta = segments.find((s) => s.kind === 'cta');
  if (cta) cands.push({ kind: 'hit', at: cta.startFrame - ahead('hit'), rank: 0 });
  const scenes = segments.filter((s) => s.kind === 'scene');
  const cuts = scenes.map((s, i) => (i === 0 ? hookFrames : s.startFrame));
  for (const cut of cuts) {
    cands.push({ kind: 'whoosh', at: cut - ahead('whoosh'), rank: 1 });
    cands.push({ kind: 'pop', at: cut + 5, rank: 2 });
  }
  // the hook's words spring in from frame 4
  cands.push({ kind: 'pop', at: 4, rank: 2 });
  const taken: SfxCue[] = [];
  for (const c of cands.sort((a, b) => a.rank - b.rank || a.at - b.at)) {
    const start = Math.max(0, c.at);
    if (start >= totalFrames - 2) continue;
    if (taken.some((t) => Math.abs(t.startFrame - start) < minGap)) continue;
    const frames = Math.min(Math.ceil(SFX[c.kind].seconds * fps), totalFrames - start);
    taken.push({ kind: c.kind, file: SFX[c.kind].file, startFrame: start, durationFrames: frames, volume: SFX_VOLUME });
  }
  return taken.sort((a, b) => a.startFrame - b.startFrame);
}
