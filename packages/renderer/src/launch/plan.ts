import { FPS } from '../brand.js';
import { PRODUCT_IDS, type Lang, type VoId } from './copy.js';

/** Pure (no node imports): the Remotion bundle and the tests both load it. */
export type Variant = 'film' | 'teaser';
export type BeatKind = 'hook' | 'problem' | 'product' | 'office' | 'cta';
export interface Beat {
  id: VoId;
  kind: BeatKind;
  /** Voice line id (the teaser's last beat has its own, shorter line). */
  vo: VoId;
  start: number;
  dur: number;
}

/** Frames a new beat's whip-in lasts; the beat's sequence starts this early so the outgoing one leaves while it arrives. */
export const WHIP = 6;
/** Where the voice starts inside a beat (after the whip and the first pop). */
export const VOICE_OFFSET: Record<BeatKind, number> = { hook: 10, problem: 12, product: 14, office: 14, cta: 22 };
/** Silence kept after the voice of a beat. */
export const VOICE_TAIL = 8;
/** Frame (from the beat start) where a product mock reaches its key moment; the «tap» sound sits on it. */
export const KEY_FRAME = 34;

const seq = (items: Omit<Beat, 'start'>[]): Beat[] => {
  let t = 0;
  return items.map((b) => {
    const beat = { ...b, start: t };
    t += b.dur;
    return beat;
  });
};
const B = (id: VoId, kind: BeatKind, dur: number, vo: VoId = id): Omit<Beat, 'start'> => ({ id, kind, vo, dur });

/** 38 s: hook 0-3, problem 3-8, seven product beats 8-28, the office 28-33, CTA 33-38 (30 fps). */
const FILM: Beat[] = seq([
  B('hook', 'hook', 90),
  B('problem', 'problem', 150),
  ...PRODUCT_IDS.map((p, i) => B(p, 'product', i === PRODUCT_IDS.length - 1 ? 84 : 86)),
  B('office', 'office', 150),
  B('cta', 'cta', 150),
]);
/** 15 s: hook 3 s, three product beats of 3 s, CTA 3 s. */
const TEASER: Beat[] = seq([
  B('hook', 'hook', 90),
  B('bot', 'product', 90),
  B('intake', 'product', 90),
  B('department', 'product', 90),
  B('cta', 'cta', 90, 'teaser-cta'),
]);

export const beatsOf = (v: Variant): Beat[] => (v === 'film' ? FILM : TEASER);
export const totalFramesOf = (v: Variant): number => beatsOf(v).reduce((n, b) => n + b.dur, 0);
export const FILM_FRAMES = totalFramesOf('film');
export const TEASER_FRAMES = totalFramesOf('teaser');

/** Frames the voice of a beat may take (from its voice start to the end of the beat minus the tail). */
export const voiceRoom = (b: Beat): number => b.dur - VOICE_OFFSET[b.kind] - VOICE_TAIL;

export interface LaunchVoice {
  /** Path inside the public dir. */
  src: string;
  frames: number;
}
export type LaunchProps = {
  lang: Lang;
  /** Voice line per beat vo id (what the captions show). */
  vo: Record<string, string>;
  /** Voice files per beat id; empty without TTS. */
  voice: Record<string, LaunchVoice>;
  /** Sound effects on. */
  sfx: boolean;
  /** A licensed track, path inside the public dir (`music/<file>`); null: no music. */
  musicPath: string | null;
  /** Linear volume of the music before ducking. */
  musicVolume: number;
  captions: boolean;
};

// ---- sound effects -------------------------------------------------------------------------------------------------

export type LaunchSfxKind = 'whoosh' | 'pop' | 'tap' | 'kick' | 'punch' | 'riser' | 'mallet';
/** earshot ids: whoosh_fast/whip, ui_pop/soft, ui_pop/step, cut_hit/kick, cut_hit/punch, riser/dark, mallet/glock. `peak` = seconds to the loudest moment (at playback rate 1). */
export const LAUNCH_SFX: Record<LaunchSfxKind, { file: string; seconds: number; peak: number; db: number; rate: number; rank: number }> = {
  kick: { file: 'cut_hit_kick.wav', seconds: 0.325, peak: 0.013, db: -12, rate: 1, rank: 0 },
  punch: { file: 'cut_hit_punch.wav', seconds: 0.282, peak: 0.05, db: -12, rate: 1, rank: 0 },
  mallet: { file: 'mallet_glock.wav', seconds: 0.412, peak: 0.01, db: -16, rate: 1, rank: 1 },
  riser: { file: 'riser_dark.wav', seconds: 0.951, peak: 0.698, db: -18, rate: 0.5, rank: 9 },
  whoosh: { file: 'whoosh_fast_whip.wav', seconds: 0.91, peak: 0.116, db: -14, rate: 1, rank: 2 },
  tap: { file: 'ui_pop_step.wav', seconds: 0.187, peak: 0.045, db: -14, rate: 1, rank: 3 },
  pop: { file: 'ui_pop_soft.wav', seconds: 0.18, peak: 0.042, db: -14, rate: 1, rank: 4 },
};
export const SFX_MIN_GAP_FRAMES = 8; // 250 ms at 30 fps

export interface LaunchCue {
  kind: LaunchSfxKind;
  file: string;
  startFrame: number;
  durationFrames: number;
  volume: number;
  rate: number;
}

const lin = (db: number) => 10 ** (db / 20);

/**
 * Placement per the earshot launch rules: a whoosh peaks on the cut (2 frames after it, so the picture leads), the tap or pop of
 * a text or UI event sits on the frame it appears, a kick or punch lands on the beat hits (cold open, the office reveal, the CTA),
 * a riser (half speed) peaks 6 frames before the CTA hit, leaving a short stop-down, and a mallet rings on the logo. Cues within
 * 250 ms of an accepted one are dropped by rank (hits first); the riser is exempt.
 */
export function planLaunchSfx(variant: Variant, fps = FPS): LaunchCue[] {
  const beats = beatsOf(variant);
  const want: { kind: LaunchSfxKind; at: number }[] = []; // `at` = frame where the loudest moment lands
  const cta = beats.find((b) => b.kind === 'cta')!;
  beats.forEach((b, i) => {
    if (i > 0) want.push({ kind: 'whoosh', at: b.start + 2 });
    if (b.kind === 'hook') {
      want.push({ kind: 'kick', at: 0 }, { kind: 'pop', at: 10 });
    } else if (b.kind === 'problem') {
      want.push({ kind: 'pop', at: b.start + 8 }, { kind: 'tap', at: b.start + 40 }, { kind: 'punch', at: b.start + 72 });
    } else if (b.kind === 'product') {
      want.push({ kind: 'pop', at: b.start + 8 }, { kind: 'tap', at: b.start + KEY_FRAME });
    } else if (b.kind === 'office') {
      want.push({ kind: 'punch', at: b.start + 1 }, { kind: 'pop', at: b.start + 36 });
    } else {
      want.push({ kind: 'kick', at: b.start + 1 }, { kind: 'mallet', at: b.start + 18 }, { kind: 'pop', at: b.start + 40 });
    }
  });
  want.push({ kind: 'riser', at: cta.start - 6 });
  const total = totalFramesOf(variant);
  const taken: LaunchCue[] = [];
  for (const w of want.sort((a, b) => LAUNCH_SFX[a.kind].rank - LAUNCH_SFX[b.kind].rank || a.at - b.at)) {
    const s = LAUNCH_SFX[w.kind];
    const start = Math.max(0, w.at - Math.round((s.peak / s.rate) * fps));
    if (start >= total - 2) continue;
    if (w.kind !== 'riser' && taken.some((t) => t.kind !== 'riser' && Math.abs(t.startFrame - start) < SFX_MIN_GAP_FRAMES)) continue;
    const frames = Math.min(Math.ceil((s.seconds / s.rate) * fps), total - start);
    taken.push({ kind: w.kind, file: s.file, startFrame: start, durationFrames: frames, volume: lin(s.db), rate: s.rate });
  }
  return taken.sort((a, b) => a.startFrame - b.startFrame);
}

/** Linear music volume at a frame: fade in and out, 45 % under the voice (a 6-frame ramp each side). */
export function musicGain(frame: number, total: number, voice: [number, number][], base: number): number {
  let g = Math.min(1, frame / 15, Math.max(0, (total - frame) / 24));
  let duck = 1;
  for (const [a, b] of voice) {
    const k = Math.min(1, Math.max(0, Math.min(frame - (a - 6), b + 6 - frame) / 6));
    duck = Math.min(duck, 1 - 0.55 * k);
  }
  g *= duck;
  return Math.max(0, base * g);
}
