import type { BrandSlot } from './fira-voice.js';

/** The reel script as the video renderer reads it: parsed from the approved item text (the owner may have edited it). */
export interface ReelScene {
  /** What the voice says. */
  voice: string;
  /** The short on-screen line of the scene. */
  subtitle: string;
}

export interface ReelScript {
  title: string;
  hook: string;
  durationSec: number;
  scenes: ReelScene[];
  cta: string;
  /** `ru` when the voice text is mostly Cyrillic, else `en`. */
  lang: 'ru' | 'en';
  /** The brand slot (`brand/fira`): Fira's sticker in the reel when the renderer draws it; absent: none. */
  brand?: BrandSlot;
  /** First line of the Instagram caption (the speech bubble of the Fira sticker); absent when the text has no caption. */
  caption?: string;
}

const CYR = /\p{Script=Cyrillic}/gu;
const LAT = /\p{Script=Latin}/gu;

export function detectLang(text: string): 'ru' | 'en' {
  const cyr = text.match(CYR)?.length ?? 0;
  const lat = text.match(LAT)?.length ?? 0;
  return cyr >= lat ? 'ru' : 'en';
}

/**
 * Parses the text `renderClip` produces («Клип, 30 с: title», «Хук (...): ...», numbered «Голос»/«Субтитр» pairs, «CTA:»).
 * Returns null when no scene can be read (an edit broke the structure): the item then has no video, only the text.
 */
export function parseReel(text: string, brand?: BrandSlot): ReelScript | null {
  const body = text.split(/^== (?:Instagram|TikTok|Shorts) ==\s*$/m)[0]!;
  const head = /^Клип(?:,\s*(\d+)\s*с)?:\s*(.+)$/m.exec(body);
  const hook = /^Хук[^:\n]*:\s*(.+)$/m.exec(body)?.[1]?.trim() ?? '';
  const cta = /^CTA:\s*(.+)$/m.exec(body)?.[1]?.trim() ?? '';
  const scenes: ReelScene[] = [];
  for (const m of body.matchAll(/^\d+\.\s*Голос:\s*(.+)\n\s+Субтитр:\s*(.+)$/gm)) scenes.push({ voice: m[1]!.trim(), subtitle: m[2]!.trim() });
  if (scenes.length === 0) return null;
  const title = head?.[2]?.trim() ?? '';
  const all = [hook, ...scenes.map((s) => s.voice)].join(' ');
  const caption = /^== Instagram ==\s*\n\s*(.+)$/m.exec(text)?.[1]?.trim();
  return { title, hook: hook || title, durationSec: head?.[1] ? Number(head[1]) : 30, scenes, cta, lang: detectLang(all), ...(caption ? { caption } : {}), ...(brand ? { brand } : {}) };
}
