/** Fira, the brand turtle, as the voice of the captions: first person by rule 13 of the system prompt, signed «Фира · Fir Tech». */
export const FIRA_SIGNATURE = 'Фира · Fir Tech';

/** Appended to the system prompt when the Fira voice is switched off for a request. */
export const FIRA_OFF_NOTE = 'Правило 13 выключено для этого материала: подписи пишутся от «мы», подпись «Фира · Fir Tech» не нужна.';

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
