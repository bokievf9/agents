/**
 * Fira as the brand face of the content (one source since the merge of `fira-brand-assets` and `marketing-chat`, 2026-11-24).
 * Captions: in her first person by rule 13 of the system prompt; the signature line «Фира · Fir Tech» is added ONCE, here, by code (neither rule 13
 * nor the owner's rules block asks the model to write it). On/off: `ctx.brand.firaVoice` of the worker's context (the «Голос Фиры» line of the
 * marketing rules, default on) and the env switch `CONTENT_FIRA=off`; off sends `FIRA_OFF_NOTE` to the model and signs nothing.
 * Pictures: the render templates carry the same `BrandSlot` (`Frame.brand`, `ReelScript.brand`): `fira` on/off, `asset` the key, `src` the PNG data URI.
 */
export const FIRA_SIGNATURE = 'Фира · Fir Tech';
/** The asset key of Fira in the render templates (`packages/renderer/assets/fira/`). */
export const BRAND_FIRA_ASSET = 'brand/fira';

/** Appended to the system prompt when the Fira voice is switched off for a request. */
export const FIRA_OFF_NOTE = 'Правило 13 выключено для этого материала: подписи пишутся от «мы», подпись «Фира · Fir Tech» не нужна.';

/** The brand slot of a render template. Absent or `fira: false`: no sticker. */
export interface BrandSlot {
  fira?: boolean;
  /** The asset key; default `BRAND_FIRA_ASSET`. */
  asset?: string;
  /** The resolved sticker (PNG data URI) of one frame; filled by `renderItem`. */
  src?: string;
}

/** Fira's voice in the captions: the rules' toggle (absent context: on) and the env switch `CONTENT_FIRA` (default on). */
export function firaVoiceOf(brand: { firaVoice: boolean } | undefined, env: string | undefined = process.env.CONTENT_FIRA): boolean {
  return (env ?? 'on').toLowerCase() !== 'off' && (brand?.firaVoice ?? true);
}

/** The caption with the signature as its last line; hashtags stay where they are (they are a separate field). Idempotent. */
export function signCaption(text: string): string {
  const t = text.trimEnd();
  return t.endsWith(FIRA_SIGNATURE) ? t : `${t}\n${FIRA_SIGNATURE}`;
}

type WithCaptions = { captions: { instagram: { text: string }; tiktok?: { text: string } | undefined; shorts?: { text: string } | undefined } };

/** Signs every platform caption of a clip or a carousel; the other fields are untouched. */
export function signCaptions<T extends WithCaptions>(c: T): T {
  const { instagram, tiktok, shorts } = c.captions;
  return { ...c, captions: { ...c.captions, instagram: { ...instagram, text: signCaption(instagram.text) }, ...(tiktok ? { tiktok: { ...tiktok, text: signCaption(tiktok.text) } } : {}), ...(shorts ? { shorts: { ...shorts, text: signCaption(shorts.text) } } : {}) } };
}
