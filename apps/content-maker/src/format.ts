import { z } from 'zod';

export type Platform = 'instagram' | 'tiktok' | 'shorts';
export type ItemType = 'clip' | 'carousel';

export const PLATFORM_LABEL: Record<Platform, string> = { instagram: 'Instagram', tiktok: 'TikTok', shorts: 'Shorts' };
export const MAX_TEXT = 3500; // Telegram caps a message at 4096; the queue adds a header

const hashtags = z
  .preprocess((v) => (typeof v === 'string' ? v.split(/[\s,]+/).filter(Boolean) : v), z.array(z.string().min(1).max(40)).min(2).max(10))
  .transform((a) => a.map((t) => (t.startsWith('#') ? t : `#${t.replace(/\s+/g, '')}`)));

const caption = z.object({ text: z.string().min(1).max(350), hashtags });
const shortsCaption = z.object({ title: z.string().min(1).max(95), text: z.string().min(1).max(300), hashtags });

const captions = z.object({ instagram: caption, tiktok: caption.optional(), shorts: shortsCaption.optional() });

export const clipSchema = z
  .object({
    title: z.string().min(1).max(80),
    hook: z.string().min(1).max(90),
    durationSec: z.coerce.number().min(20).max(40),
    scenes: z.array(z.object({ voice: z.string().min(1).max(150), subtitle: z.string().min(1).max(70) })).min(4).max(7),
    cta: z.string().min(1).max(120),
    captions: captions.extend({ tiktok: caption, shorts: shortsCaption }),
  })
  .superRefine((c, ctx) => {
    if (renderClip(c).length > MAX_TEXT) ctx.addIssue({ code: 'custom', message: `whole text must be under ${MAX_TEXT} characters, shorten it` });
  });
export type Clip = z.output<typeof clipSchema>;

export const carouselSchema = z
  .object({
    title: z.string().min(1).max(80),
    slides: z.array(z.object({ title: z.string().min(1).max(60), lines: z.array(z.string().min(1).max(110)).min(1).max(2) })).min(6).max(8),
    cta: z.string().min(1).max(120),
    captions,
  })
  .superRefine((c, ctx) => {
    if (renderCarousel(c).length > MAX_TEXT) ctx.addIssue({ code: 'custom', message: `whole text must be under ${MAX_TEXT} characters, shorten it` });
  });
export type Carousel = z.output<typeof carouselSchema>;

type Captions = Clip['captions'] | Carousel['captions'];

function renderCaptions(c: Captions): string {
  const out: string[] = [`== ${PLATFORM_LABEL.instagram} ==`, c.instagram.text, c.instagram.hashtags.join(' ')];
  if (c.tiktok) out.push('', `== ${PLATFORM_LABEL.tiktok} ==`, c.tiktok.text, c.tiktok.hashtags.join(' '));
  if (c.shorts) out.push('', `== ${PLATFORM_LABEL.shorts} ==`, c.shorts.title, c.shorts.text, c.shorts.hashtags.join(' '));
  return out.join('\n');
}

/** The text the owner reads and edits. Platform captions sit under "== Platform ==" markers (see splitPlatforms). */
export function renderClip(c: Clip | z.input<typeof clipSchema>): string {
  const parsed = c as Clip;
  const scenes = parsed.scenes.map((s, i) => `${i + 1}. Голос: ${s.voice}\n   Субтитр: ${s.subtitle}`).join('\n');
  return [
    `Клип, ${parsed.durationSec} с: ${parsed.title}`,
    `Хук (первая секунда): ${parsed.hook}`,
    '',
    scenes,
    '',
    `CTA: ${parsed.cta}`,
    '',
    renderCaptions(parsed.captions),
  ].join('\n');
}

export function renderCarousel(c: Carousel | z.input<typeof carouselSchema>): string {
  const parsed = c as Carousel;
  const slides = parsed.slides.map((s, i) => `${i + 1}. ${s.title}\n${s.lines.map((l) => `   ${l}`).join('\n')}`).join('\n');
  return [`Карусель, ${parsed.slides.length} слайдов: ${parsed.title}`, '', slides, '', `CTA: ${parsed.cta}`, '', renderCaptions(parsed.captions)].join('\n');
}

const MARKER = /^== (Instagram|TikTok|Shorts) ==\s*$/gm;
const BY_LABEL: Record<string, Platform> = { Instagram: 'instagram', TikTok: 'tiktok', Shorts: 'shorts' };

/**
 * Splits an approved text into the shared body and per-platform caption sections. If the owner's edit broke
 * the markers, `sections` is empty and the caller uses the whole text for every platform.
 */
export function splitPlatforms(text: string): { body: string; sections: Partial<Record<Platform, string>> } {
  const marks = [...text.matchAll(MARKER)];
  if (marks.length === 0) return { body: text.trim(), sections: {} };
  const sections: Partial<Record<Platform, string>> = {};
  marks.forEach((m, i) => {
    const end = marks[i + 1]?.index ?? text.length;
    sections[BY_LABEL[m[1]!]!] = text.slice(m.index + m[0].length, end).trim();
  });
  return { body: text.slice(0, marks[0]!.index).trim(), sections };
}

/** First line of the body without the type prefix: the item's short title. */
export function titleOf(text: string): string {
  const first = text.split('\n')[0] ?? '';
  return first.replace(/^(Клип|Карусель)[^:]*:\s*/, '').trim() || first.trim();
}
