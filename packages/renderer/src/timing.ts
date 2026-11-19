import { FPS } from './brand.js';

/** Seconds the hook fills the screen at the start. */
export const HOOK_SECONDS = 2.5;
/** Pause after the voice of a scene ends. */
export const VOICE_PAD_SECONDS = 0.4;
/** The CTA card never lasts less than this, and never less than its voice plus the pad. */
export const CTA_MIN_SECONDS = 3;
export const MIN_TOTAL_SECONDS = 15;
export const MAX_TOTAL_SECONDS = 40;

export interface SceneInput {
  /** Length of the scene's WAV; null when there is no voice (no TTS). */
  voiceSec: number | null;
}

export interface Segment {
  kind: 'scene' | 'cta';
  index: number;
  startFrame: number;
  durationFrames: number;
  /** Frames the voice lasts from the segment start (0 without voice). */
  voiceFrames: number;
}

export interface Timeline {
  fps: number;
  segments: Segment[];
  hookFrames: number;
  totalFrames: number;
}

/**
 * Scene duration = max(voice length + 0.4 s, the script's seconds for the scene), where the script's seconds are
 * `durationSec` minus the CTA card, spread evenly over the scenes. The CTA card follows. A reel shorter than 15 s is
 * stretched by its last scene; one longer than 40 s is left as the voice dictates (the content-maker caps scripts at 40 s).
 */
export function buildTimeline(scenes: SceneInput[], ctaVoiceSec: number | null, durationSec: number, fps = FPS): Timeline {
  const ctaSec = Math.max(CTA_MIN_SECONDS, ctaVoiceSec === null ? 0 : ctaVoiceSec + VOICE_PAD_SECONDS);
  const perScene = Math.max(1.5, (durationSec - ctaSec) / Math.max(1, scenes.length));
  const segments: Segment[] = [];
  let cursor = 0;
  const push = (kind: Segment['kind'], index: number, voiceSec: number | null, sec: number) => {
    const durationFrames = Math.round(sec * fps);
    segments.push({ kind, index, startFrame: cursor, durationFrames, voiceFrames: voiceSec === null ? 0 : Math.ceil(voiceSec * fps) });
    cursor += durationFrames;
  };
  scenes.forEach((s, i) => push('scene', i, s.voiceSec, Math.max(s.voiceSec === null ? 0 : s.voiceSec + VOICE_PAD_SECONDS, perScene)));
  push('cta', -1, ctaVoiceSec, ctaSec);
  const missing = Math.round(MIN_TOTAL_SECONDS * fps) - cursor;
  if (missing > 0) {
    const last = segments[segments.length - 2];
    if (last) {
      last.durationFrames += missing;
      segments[segments.length - 1]!.startFrame += missing;
      cursor += missing;
    }
  }
  return { fps, segments, hookFrames: Math.round(HOOK_SECONDS * fps), totalFrames: cursor };
}

/** Rough speaking time for a text when there is no voice file (sample renders, previews): ~14 characters per second. */
export function estimateVoiceSec(text: string): number {
  return Math.max(1, text.replace(/\s+/g, ' ').trim().length / 14);
}
