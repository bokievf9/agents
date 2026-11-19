import { z } from 'zod';

export type Platform = 'instagram' | 'tiktok' | 'shorts';
/** `clip` is the reel script. `profile` is the one-time page setup pack. */
export type ItemType = 'clip' | 'carousel' | 'post' | 'story' | 'profile';

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

const tags = (max: number) =>
  z
    .preprocess((v) => (typeof v === 'string' ? v.split(/[\s,]+/).filter(Boolean) : v), z.array(z.string().min(1).max(40)).min(1).max(max))
    .transform((a) => a.map((t) => (t.startsWith('#') ? t : `#${t.replace(/\s+/g, '')}`)));

/** A single static card: a short headline and one or two lines on the image, a caption with a call to action. */
export const postSchema = z
  .object({
    title: z.string().min(1).max(60),
    lines: z.array(z.string().min(1).max(90)).min(1).max(2),
    caption: z.string().min(300).max(900),
    hashtags: tags(5),
  })
  .superRefine((c, ctx) => {
    if (renderPost(c).length > MAX_TEXT) ctx.addIssue({ code: 'custom', message: `whole text must be under ${MAX_TEXT} characters, shorten it` });
  });
export type Post = z.output<typeof postSchema>;

/** 3-5 story frames, the last one is the call to action; `leads` says where the story sends the viewer. */
export const storySchema = z
  .object({
    title: z.string().min(1).max(60),
    frames: z.array(z.object({ title: z.string().min(1).max(50), line: z.string().min(1).max(90) })).min(3).max(5),
    leads: z.string().min(1).max(120),
  })
  .superRefine((c, ctx) => {
    if (!CTA_RE.test(`${c.frames.at(-1)!.title} ${c.frames.at(-1)!.line}`)) ctx.addIssue({ code: 'custom', message: 'the last frame must hold the call to action with @firtech_bot or firtech.pro' });
  });
export type Story = z.output<typeof storySchema>;

/** The page setup pack: bio, five highlights with cover headlines, pinned post ideas, link-in-bio, first-week order. */
export const profileSchema = z.object({
  bio: z.string().min(20).max(150),
  link: z.string().min(1).max(200),
  highlights: z.array(z.object({ name: z.string().min(1).max(16), cover: z.string().min(1).max(40) })).length(5),
  pinned: z.array(z.string().min(5).max(160)).length(3),
  week: z.array(z.string().min(5).max(160)).min(5).max(10),
});
export type Profile = z.output<typeof profileSchema>;

export const CTA_RE = /firtech\.pro|@firtech_bot/i;

export function renderPost(c: Post | z.input<typeof postSchema>): string {
  const p = c as Post;
  return [`Пост: ${p.title}`, 'На картинке:', ...p.lines.map((l) => `   ${l}`), '', '== Instagram ==', p.caption, p.hashtags.join(' ')].join('\n');
}

export function renderStory(c: Story | z.input<typeof storySchema>): string {
  const s = c as Story;
  const frames = s.frames.map((f, i) => `${i + 1}. ${f.title}\n   ${f.line}`).join('\n');
  return [`История, ${s.frames.length} кадров: ${s.title}`, '', frames, '', `Куда ведёт: ${s.leads}`].join('\n');
}

export function renderProfile(c: Profile | z.input<typeof profileSchema>): string {
  const p = c as Profile;
  return [
    `Профиль Instagram: настройка (био ${p.bio.length} знаков)`,
    `Био: ${p.bio}`,
    `Ссылка в шапке: ${p.link}`,
    '',
    'Актуальное (название, обложка 1080x1920):',
    ...p.highlights.map((h, i) => `${i + 1}. ${h.name}. Обложка: ${h.cover}`),
    '',
    'Закреплённые посты:',
    ...p.pinned.map((t, i) => `${i + 1}) ${t}`),
    '',
    'Порядок первой недели:',
    ...p.week.map((t, i) => `${i + 1}) ${t}`),
  ].join('\n');
}

type Captions = Clip['captions'] | Carousel['captions'];

function renderCaptions(c: Captions): string {
  const out: string[] = [`== ${PLATFORM_LABEL.instagram} ==`, c.instagram.text, c.instagram.hashtags.join(' ')];
  if (c.tiktok) out.push('', `== ${PLATFORM_LABEL.tiktok} ==`, c.tiktok.text, c.tiktok.hashtags.join(' '));
  if (c.shorts) out.push('', `== ${PLATFORM_LABEL.shorts} ==`, c.shorts.title, c.shorts.text, c.shorts.hashtags.join(' '));
  return out.join('\n');
}

/** The text the owner reads and edits. Platform captions sit under "== Platform ==" markers (display only; edits go through replacePart). */
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

/** Parts of an item the owner can edit one at a time: the script (clip) or slides (carousel), then each platform. */
export type PartId = 'script' | Platform;

export function editableParts(type: ItemType): PartId[] {
  if (type === 'clip') return ['script', 'instagram', 'tiktok', 'shorts'];
  if (type === 'story' || type === 'profile') return ['script'];
  return ['script', 'instagram'];
}

export function partLabel(type: ItemType, part: PartId): string {
  if (part !== 'script') return type === 'post' ? 'Подпись' : PLATFORM_LABEL[part];
  return { clip: 'Сценарий', carousel: 'Слайды', post: 'Картинка', story: 'Кадры', profile: 'Профиль' }[type];
}

const PLATFORM_ORDER: Platform[] = ['instagram', 'tiktok', 'shorts'];

/**
 * Swaps one part of the text (the body above the markers, or one platform's section) and rebuilds the
 * markers itself, so the owner never has to keep them intact. Marker lines inside the new text are dropped.
 * Returns null when the platform section does not exist in the text or the new part is empty.
 */
export function replacePart(text: string, part: PartId, replacement: string): string | null {
  const clean = replacement.replace(/^== (Instagram|TikTok|Shorts) ==[ \t]*\n?/gm, '').trim();
  if (!clean) return null;
  const { body, sections } = splitPlatforms(text);
  if (part === 'script') return joinParts(clean, sections);
  if (!(part in sections)) return null;
  return joinParts(body, { ...sections, [part]: clean });
}

function joinParts(body: string, sections: Partial<Record<Platform, string>>): string {
  const out = [body];
  for (const p of PLATFORM_ORDER) if (sections[p] !== undefined) out.push(`== ${PLATFORM_LABEL[p]} ==\n${sections[p]}`);
  return out.join('\n\n');
}

/** First line of the body without the type prefix: the item's short title. */
export function titleOf(text: string): string {
  const first = text.split('\n')[0] ?? '';
  return first.replace(/^(Клип|Карусель|Пост|История|Профиль Instagram)[^:]*:\s*/, '').trim() || first.trim();
}
