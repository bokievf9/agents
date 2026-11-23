/** Fira, the brand turtle, as a sticker on reels and (through the content-maker) on post and carousel images. Pure data, safe for the Remotion bundle. */
export const FIRA_EMOTIONS = ['idle', 'happy', 'thinking', 'listening'] as const;
export const FIRA_ACCESSORIES = ['base', 'glasses', 'headphones', 'laptop'] as const;
export type FiraEmotion = (typeof FIRA_EMOTIONS)[number];
export type FiraAccessory = (typeof FIRA_ACCESSORIES)[number];
export type FiraPosition = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';

/** The `brand.fira` field of a reel: `true` is the default sticker, an object overrides parts of it, `false` or absent: none. */
export interface FiraSticker {
  emotion?: FiraEmotion;
  accessory?: FiraAccessory;
  position?: FiraPosition;
  /** Width and height in px of the 1080 px wide frame. */
  size?: number;
  /** The speech bubble text (the first line of the caption); empty or absent: no bubble. */
  bubble?: string;
}
export type FiraBrand = boolean | FiraSticker;

export const FIRA_DEFAULT = { emotion: 'happy', accessory: 'base', position: 'top-right', size: 300 } as const satisfies Required<Omit<FiraSticker, 'bubble'>>;
export const FIRA_PNG_SIZE = 1024;
/** `fira/<emotion>-<accessory>.png`: the same path in `assets/` and inside the Remotion public dir. */
export const firaFile = (emotion: FiraEmotion, accessory: FiraAccessory): string => `fira/${emotion}-${accessory}.png`;
export const FIRA_MANIFEST: readonly string[] = FIRA_EMOTIONS.flatMap((e) => FIRA_ACCESSORIES.map((a) => firaFile(e, a)));

export interface ResolvedFira extends Required<Omit<FiraSticker, 'bubble'>> {
  bubble: string;
  file: string;
}

/** Fills the defaults of `brand.fira`; null when the sticker is off. */
export function resolveFira(brand: FiraBrand | undefined): ResolvedFira | null {
  if (!brand) return null;
  const o: FiraSticker = brand === true ? {} : brand;
  const emotion = o.emotion && FIRA_EMOTIONS.includes(o.emotion) ? o.emotion : FIRA_DEFAULT.emotion;
  const accessory = o.accessory && FIRA_ACCESSORIES.includes(o.accessory) ? o.accessory : FIRA_DEFAULT.accessory;
  const size = o.size && o.size >= 80 && o.size <= 700 ? Math.round(o.size) : FIRA_DEFAULT.size;
  return { emotion, accessory, position: o.position ?? FIRA_DEFAULT.position, size, bubble: shortBubble(o.bubble ?? ''), file: firaFile(emotion, accessory) };
}

/** The first non-empty line of a caption, cut to what fits a bubble (about 70 characters, at a word boundary). */
export function shortBubble(text: string, max = 70): string {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 30 ? cut.lastIndexOf(' ') : cut.length).replace(/[,;:\s]+$/, '')}…`;
}
