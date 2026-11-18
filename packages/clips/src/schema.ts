import { z } from 'zod';

export const FPS = 30;
export const WIDTH = 1080;
export const HEIGHT = 1920;

const scene = z.object({
  voice: z.string().min(1).max(300),
  subtitle: z.string().min(1).max(120),
  /** Optional screenshot or image: a path, absolute or relative to the script file. Letterboxed. */
  image: z.string().min(1).optional(),
});

/** What the renderer needs. Compatible with the content-maker clip (extra fields such as captions are kept, not used). */
export const ClipScript = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
  title: z.string().min(1).max(120),
  hook: z.string().min(1).max(120),
  scenes: z.array(scene).min(1).max(12),
  cta: z.string().min(1).max(160),
  theme: z.enum(['dark', 'light']).default('dark'),
  /** Optional background music file; ducked under the voice. No music by default. */
  music: z.string().min(1).optional(),
  /** Voice name: an edge-tts voice, or a macOS `say` voice with the fallback. */
  voice: z.string().min(1).optional(),
  captions: z.unknown().optional(),
});
export type ClipScript = z.output<typeof ClipScript>;
export type ClipScriptInput = z.input<typeof ClipScript>;

/** The part of a content-maker clip (`@fir/worker-content-maker` `Clip`) the adapter reads. */
export interface ContentMakerClip {
  title: string;
  hook: string;
  durationSec?: number;
  scenes: { voice: string; subtitle: string }[];
  cta: string;
  captions?: unknown;
}

export function slugify(s: string): string {
  const map: Record<string, string> = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm',
    н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch',
    ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  };
  const out = [...s.toLowerCase()].map((c) => map[c] ?? c).join('').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return out || 'clip';
}

/** Content-maker clip item to a render script. */
export function fromContentMaker(clip: ContentMakerClip, opts: { theme?: 'dark' | 'light'; slug?: string } = {}): ClipScript {
  return ClipScript.parse({
    slug: opts.slug ?? slugify(clip.title),
    title: clip.title,
    hook: clip.hook,
    scenes: clip.scenes.map((s) => ({ voice: s.voice, subtitle: s.subtitle })),
    cta: clip.cta,
    theme: opts.theme ?? 'dark',
    captions: clip.captions,
  });
}
