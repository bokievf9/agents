import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import satori from 'satori';
import type { ItemType } from './format.js';

/**
 * PNG rendering without a browser: `satori` (layout to SVG) + `@resvg/resvg-js` (SVG to PNG), plain Node.
 * Brand tokens mirror firtech/src/app/globals.css (dark theme): background #0a0d0b, text white, lime accent #b5eb6a.
 * Fonts live in `assets/fonts` (Onest from @fontsource, Unbounded from the site; both OFL).
 */
export const BRAND = { bg: '#0a0d0b', fg: '#ffffff', muted: '#9ba79d', accent: '#b5eb6a', surface: '#111512' } as const;

export type FrameKind = 'post' | 'slide' | 'story' | 'cover';
/** One image: a headline, up to two body lines, a position mark («3/8») and the kind that sets the size. */
export interface Frame {
  kind: FrameKind;
  title: string;
  lines: string[];
  index?: number;
  total?: number;
}

export const SIZES: Record<FrameKind, { width: number; height: number }> = {
  post: { width: 1080, height: 1350 },
  slide: { width: 1080, height: 1350 },
  story: { width: 1080, height: 1920 },
  cover: { width: 1080, height: 1920 },
};

type Font = { name: string; data: Buffer; weight: 400 | 700; style: 'normal' };
let fontCache: Font[] | null = null;
const FONT_DIR = new URL('../assets/fonts/', import.meta.url).pathname;

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

type Node = { type: string; props: { style?: Record<string, unknown>; children?: unknown } };
const h = (type: string, style: Record<string, unknown>, children?: unknown): Node => ({ type, props: { style: { display: 'flex', ...style }, ...(children !== undefined ? { children } : {}) } });

function tree(fr: Frame): Node {
  const { width, height } = SIZES[fr.kind];
  const story = height > width * 1.5;
  const pad = 88;
  const titleSize = fr.title.length > 40 ? 64 : fr.title.length > 24 ? 76 : 92;
  const mark = fr.index && fr.total ? `${fr.index}/${fr.total}` : '';
  return h('div', { width, height, backgroundColor: BRAND.bg, flexDirection: 'column', justifyContent: 'space-between', padding: story ? `${pad + 120}px ${pad}px ${pad + 160}px` : `${pad}px`, fontFamily: 'Onest, OnestLatin', color: BRAND.fg }, [
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
    const out: Frame[] = [];
    for (const m of body.matchAll(/^\d+\.\s+(.+?)\.\s+Обложка:\s*(.+)$/gm)) out.push({ kind: 'cover', title: m[2]!.trim(), lines: [m[1]!.trim()] });
    return out.map((f, i) => ({ ...f, index: i + 1, total: out.length }));
  }
  return [];
}

/** Renders an item's images into `<dir>/<itemId>/<n>.png`; returns the file paths in order. */
export async function renderItem(dir: string, itemId: number, type: ItemType, text: string): Promise<string[]> {
  const frames = framesOf(type, text);
  if (frames.length === 0) return [];
  const out = join(dir, String(itemId));
  mkdirSync(out, { recursive: true });
  const fonts = loadFonts();
  const files: string[] = [];
  for (const [i, f] of frames.entries()) {
    const path = join(out, `${i + 1}.png`);
    writeFileSync(path, await renderFrame(f, fonts));
    files.push(path);
  }
  return files;
}

/** Width and height from a PNG header (for checks). */
export function pngSize(buf: Buffer): { width: number; height: number } {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
