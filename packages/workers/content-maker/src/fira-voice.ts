/**
 * Fira as the brand face of the content (2026-11-24): when the marketing rules say so (`brand.firaVoice` of the worker's context, default ON in the
 * rules), captions speak in her first person (the rules block in the system prompt says how) and end with her short signature. The hashtags stay
 * as they are. `BRAND_FIRA_ASSET` is the asset slot the render templates name (`Frame.brand`, `ReelScript.brand`); the renderer draws it.
 */
export const FIRA_SIGNATURE = 'Фира · Fir Tech';
/** The asset key of Fira in the render templates (`packages/renderer/assets/fira/`, drawn by the renderer side). */
export const BRAND_FIRA_ASSET = 'brand/fira';

/** The brand slot of a render template: Fira on the frame or in the reel. Absent or `fira: false`: no sticker. */
export interface BrandSlot {
  fira?: boolean;
  /** The asset key; default `BRAND_FIRA_ASSET`. */
  asset?: string;
}

/** The caption with Fira's signature as its last line (once: a caption that already ends with it is left alone). */
export function signCaption(text: string, signature = FIRA_SIGNATURE): string {
  const t = text.trimEnd();
  if (!t || t.endsWith(signature)) return t;
  return `${t}\n\n${signature}`;
}

/** Every platform caption of a clip or a carousel signed. */
export function signCaptions<T extends { instagram: { text: string }; tiktok?: { text: string } | undefined; shorts?: { text: string } | undefined }>(c: T, signature = FIRA_SIGNATURE): T {
  return {
    ...c,
    instagram: { ...c.instagram, text: signCaption(c.instagram.text, signature) },
    ...(c.tiktok ? { tiktok: { ...c.tiktok, text: signCaption(c.tiktok.text, signature) } } : {}),
    ...(c.shorts ? { shorts: { ...c.shorts, text: signCaption(c.shorts.text, signature) } } : {}),
  };
}
