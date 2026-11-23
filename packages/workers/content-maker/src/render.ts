import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import satori from 'satori';
import { BRAND_FIRA_ASSET, type BrandSlot } from './fira-voice.js';
import { splitKit, type ItemType } from './format.js';

/**
 * PNG rendering without a browser: `satori` (layout to SVG) + `@resvg/resvg-js` (SVG to PNG), plain Node.
 * Brand tokens mirror firtech/src/app/globals.css (dark theme): background #0a0d0b, text white, lime accent #b5eb6a.
 * Fonts live in `assets/fonts` (Onest from @fontsource, Unbounded from the site; both OFL).
 */
export const BRAND = { bg: '#0a0d0b', fg: '#ffffff', muted: '#9ba79d', accent: '#b5eb6a', surface: '#111512' } as const;

export type FrameKind = 'post' | 'slide' | 'story' | 'cover' | 'banner';
/** One image: a headline, up to two body lines, a position mark («3/8») and the kind that sets the size. */
export interface Frame {
  kind: FrameKind;
  title: string;
  lines: string[];
  index?: number;
  total?: number;
  /** A picture under the frame as a data URI (JPEG or PNG), darkened so the text stays readable. Slides and posts only. */
  bg?: string;
  /** The brand slot: `fira` on and `src` (the PNG data URI) draw the turtle sticker in the bottom-right corner; absent: none. */
  brand?: BrandSlot;
}

export const SIZES: Record<FrameKind, { width: number; height: number }> = {
  post: { width: 1080, height: 1350 },
  slide: { width: 1080, height: 1350 },
  story: { width: 1080, height: 1920 },
  cover: { width: 1080, height: 1920 },
  banner: { width: 2560, height: 1440 },
};

/** The part of a YouTube banner every device shows (TV, desktop, phone): 1546x423 in the centre. Text stays inside it. */
export const BANNER_SAFE = { width: 1546, height: 423, x: (2560 - 1546) / 2, y: (1440 - 423) / 2 } as const;

type Font = { name: string; data: Buffer; weight: 400 | 700; style: 'normal' };
let fontCache: Font[] | null = null;
export const FONT_DIR = new URL('../assets/fonts/', import.meta.url).pathname;

/** Loads the font files once (they ship with the package). Throws when a file is missing. */
export function loadFonts(dir = FONT_DIR): Font[] {
  if (dir === FONT_DIR && fontCache) return fontCache;
  const f = (name: string, file: string, weight: 400 | 700): Font => ({ name, data: readFileSync(join(dir, file)), weight, style: 'normal' });
  const fonts = [
    f('Onest', 'onest-cyrillic-400-normal.woff', 400), f('OnestLatin', 'onest-latin-400-normal.woff', 400),
    f('Onest', 'onest-cyrillic-700-normal.woff', 700), f('OnestLatin', 'onest-latin-700-normal.woff', 700),
    f('Unbounded', 'Unbounded-Bold.ttf', 700),
  ];
  if (dir === FONT_DIR) fontCache = fonts;
  return fonts;
}

const FIRA_PX = 230;

type Node = { type: string; props: { style?: Record<string, unknown>; children?: unknown; [k: string]: unknown } };
const h = (type: string, style: Record<string, unknown>, children?: unknown): Node => ({ type, props: { style: { display: 'flex', ...style }, ...(children !== undefined ? { children } : {}) } });

/** YouTube banner: the headline, one line and the mark sit in the safe area; the rest is background shapes. */
function bannerTree(fr: Frame): Node {
  const { width, height } = SIZES.banner;
  const s = BANNER_SAFE;
  const size = fr.title.length > 28 ? 68 : fr.title.length > 16 ? 84 : 104;
  const dot = (x: number, y: number, d: number) => h('div', { position: 'absolute', left: x, top: y, width: d, height: d, borderRadius: d / 2, backgroundColor: BRAND.surface });
  return h('div', { width, height, backgroundColor: BRAND.bg, position: 'relative', fontFamily: 'Onest, OnestLatin', color: BRAND.fg }, [
    dot(-260, -300, 900), dot(1900, 900, 1000),
    h('div', { position: 'absolute', left: s.x, top: s.y, width: s.width, height: s.height, flexDirection: 'column', justifyContent: 'center' }, [
      h('div', { width: 120, height: 10, backgroundColor: BRAND.accent, marginBottom: 28 }),
      h('div', { fontFamily: 'Unbounded, Onest, OnestLatin', fontWeight: 700, fontSize: size, lineHeight: 1.12 }, fr.title),
      ...fr.lines.slice(0, 1).map((l) => h('div', { fontSize: 44, lineHeight: 1.3, color: BRAND.muted, marginTop: 24 }, l)),
    ]),
  ]);
}

function tree(fr: Frame): Node {
  if (fr.kind === 'banner') return bannerTree(fr);
  const { width, height } = SIZES[fr.kind];
  const story = height > width * 1.5;
  const pad = 88;
  const titleSize = fr.title.length > 40 ? 64 : fr.title.length > 24 ? 76 : 92;
  const mark = fr.index && fr.total ? `${fr.index}/${fr.total}` : '';
  const under: Node[] = fr.bg
    ? [
        { type: 'img', props: { src: fr.bg, width, height, style: { position: 'absolute', left: 0, top: 0, width, height, objectFit: 'cover' } } },
        h('div', { position: 'absolute', left: 0, top: 0, width, height, backgroundColor: 'rgba(10,13,11,0.82)' }),
      ]
    : [];
  return h('div', { width, height, backgroundColor: BRAND.bg, position: 'relative', flexDirection: 'column', justifyContent: 'space-between', padding: story ? `${pad + 120}px ${pad}px ${pad + 160}px` : `${pad}px`, fontFamily: 'Onest, OnestLatin', color: BRAND.fg }, [
    ...under,
    ...(fr.brand?.fira && fr.brand.src ? [{ type: 'img', props: { src: fr.brand.src, width: FIRA_PX, height: FIRA_PX, style: { position: 'absolute', right: 56, bottom: story ? 260 : 150, width: FIRA_PX, height: FIRA_PX } } } as Node] : []),
    h('div', { flexDirection: 'column' }, [
      h('div', { width: 120, height: 10, backgroundColor: BRAND.accent, marginBottom: 56 }),
      h('div', { fontFamily: 'Unbounded, Onest, OnestLatin', fontWeight: 700, fontSize: titleSize, lineHeight: 1.12, color: BRAND.fg }, fr.title),
      ...fr.lines.map((l) => h('div', { fontFamily: 'Onest, OnestLatin', fontSize: 46, lineHeight: 1.35, color: BRAND.fg, marginTop: 36 }, l)),
    ]),
    h('div', { justifyContent: 'space-between', alignItems: 'center' }, [
      h('div', { alignItems: 'center' }, [
        h('div', { width: 22, height: 22, borderRadius: 11, backgroundColor: BRAND.accent, marginRight: 16 }),
        h('div', { fontFamily: 'Unbounded', fontWeight: 700, fontSize: 36, color: BRAND.fg }, 'fir.tech'),
      ]),
      h('div', { fontFamily: 'Onest, OnestLatin', fontSize: 36, color: BRAND.muted }, mark),
    ]),
  ]);
}

/** One frame to a PNG buffer of exactly the size of its kind. */
export async function renderFrame(fr: Frame, fonts: Font[] = loadFonts()): Promise<Buffer> {
  const { width, height } = SIZES[fr.kind];
  const svg = await satori(tree(fr) as never, { width, height, fonts });
  return Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: width }, font: { loadSystemFonts: false } }).render().asPng());
}

// ---- frames from the item text (the text is what the owner approved and may have edited) ----
const lineRe = /^\s{2,}(.+)$/;

/** Numbered blocks «1. title» with indented lines under them (carousel slides, story frames). */
function numbered(text: string): { title: string; lines: string[] }[] {
  const out: { title: string; lines: string[] }[] = [];
  for (const raw of text.split('\n')) {
    const m = /^(\d+)\.\s+(.+)$/.exec(raw);
    if (m) out.push({ title: m[2]!.trim(), lines: [] });
    else if (out.length && lineRe.test(raw)) out.at(-1)!.lines.push(lineRe.exec(raw)![1]!.trim());
    else if (out.length && raw.trim() === '') break; // the first blank line after the list ends it
  }
  return out;
}

/** The images of an item. Empty when the text has no recognisable structure (an owner's edit broke it). */
export function framesOf(type: ItemType, text: string): Frame[] {
  const body = text.split(/^== (?:Instagram|TikTok|Shorts) ==\s*$/m)[0]!;
  if (type === 'post') {
    const title = /^Пост:\s*(.+)$/m.exec(body)?.[1]?.trim();
    const at = body.indexOf('На картинке:');
    const lines = at >= 0 ? body.slice(at).split('\n').slice(1).map((l) => l.trim()).filter(Boolean) : [];
    return title ? [{ kind: 'post', title, lines: lines.slice(0, 2) }] : [];
  }
  if (type === 'carousel') {
    const slides = numbered(body);
    const cta = /^CTA:\s*(.+)$/m.exec(body)?.[1]?.trim();
    const all = [...slides, ...(slides.length && cta ? [{ title: 'Дальше', lines: [cta] }] : [])];
    return all.map((s, i) => ({ kind: 'slide' as const, title: s.title, lines: s.lines.slice(0, 2), index: i + 1, total: all.length }));
  }
  if (type === 'story') {
    const frames = numbered(body);
    return frames.map((s, i) => ({ kind: 'story' as const, title: s.title, lines: s.lines.slice(0, 1), index: i + 1, total: frames.length }));
  }
  if (type === 'profile') {
    const kit = splitKit(text);
    const out: Frame[] = [];
    for (const m of (kit.instagram ?? '').matchAll(/^\d+\.\s+(.+?)\.\s+Обложка:\s*(.+)$/gm)) out.push({ kind: 'cover', title: m[2]!.trim(), lines: [m[1]!.trim()] });
    const covers = out.map((f, i) => ({ ...f, index: i + 1, total: out.length }));
    const title = /^Баннер, заголовок:\s*(.+)$/m.exec(kit.youtube ?? '')?.[1]?.trim();
    const sub = /^Баннер, строка:\s*(.+)$/m.exec(kit.youtube ?? '')?.[1]?.trim();
    return [...covers, ...(title ? [{ kind: 'banner' as const, title, lines: sub ? [sub] : [] }] : [])];
  }
  return [];
}

/** The stored background of an item (`<dir>/<itemId>/bg.jpg` or `.png`, put there when it was drafted) as a data URI; undefined when there is none. */
export function backgroundOf(dir: string, itemId: number): string | undefined {
  for (const [ext, mime] of [['jpg', 'image/jpeg'], ['png', 'image/png']] as const) {
    const file = join(dir, String(itemId), `bg.${ext}`);
    if (existsSync(file)) return `data:${mime};base64,${readFileSync(file).toString('base64')}`;
  }
  return undefined;
}

/** Where the turtle PNG files live: `FIRA_ASSETS_DIR`, else the renderer package next door in the monorepo. */
export const FIRA_ASSETS_DIR = process.env.FIRA_ASSETS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'renderer', 'assets', 'fira');

/** Which turtle file a frame gets, or null: the post and the first and last slides of a carousel carry her, the middle slides and stories do not. */
export function firaFileFor(type: ItemType, index: number, total: number): string | null {
  if (type === 'post') return 'happy-base.png';
  if (type === 'carousel') return index === 0 ? 'thinking-glasses.png' : index === total - 1 ? 'happy-base.png' : null;
  return null;
}

/** The sticker as a data URI, or undefined when it is off or the file is missing. */
export function firaDataUri(file: string | null, dir: string = FIRA_ASSETS_DIR): string | undefined {
  if (!file || !existsSync(join(dir, file))) return undefined;
  return `data:image/png;base64,${readFileSync(join(dir, file)).toString('base64')}`;
}

/** Renders an item's images into `<dir>/<itemId>/<n>.png`; returns the file paths in order. Slides and posts get the item's stored background under the frame. */
/** `opts.brand`: the brand slot of the item (default Fira on); a frame that carries her gets the slot with its sticker file. */
export async function renderItem(dir: string, itemId: number, type: ItemType, text: string, opts: { brand?: BrandSlot } = {}): Promise<string[]> {
  const bg = type === 'carousel' || type === 'post' ? backgroundOf(dir, itemId) : undefined;
  const all = framesOf(type, text);
  const frames = all.map((f, i) => {
    const src = opts.brand?.fira === false ? undefined : firaDataUri(firaFileFor(type, i, all.length));
    return { ...f, ...(bg && (f.kind === 'slide' || f.kind === 'post') ? { bg } : {}), ...(src ? { brand: { ...opts.brand, fira: true, asset: opts.brand?.asset ?? BRAND_FIRA_ASSET, src } } : {}) };
  });
  if (frames.length === 0) return [];
  const fonts = loadFonts();
  const files: string[] = [];
  for (const [i, f] of frames.entries()) {
    // start kit: `profile-<platform>/<itemId>/…`, other items `<itemId>/<n>.png`
    const out = type === 'profile' ? join(dir, f.kind === 'banner' ? 'profile-youtube' : 'profile-instagram', String(itemId)) : join(dir, String(itemId));
    mkdirSync(out, { recursive: true });
    const path = join(out, f.kind === 'banner' ? 'banner.png' : `${i + 1}.png`);
    writeFileSync(path, await renderFrame(f, fonts));
    files.push(path);
  }
  return files;
}

/** Width and height from a PNG header (for checks). */
export function pngSize(buf: Buffer): { width: number; height: number } {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
