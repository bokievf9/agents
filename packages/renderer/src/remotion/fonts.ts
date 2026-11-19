import { continueRender, delayRender, staticFile } from 'remotion';

/** Brand fonts from the bundle's `fonts/` folder (copied from the content-maker assets). No network fonts. */
const faces: [family: string, file: string, weight: string, range?: string][] = [
  ['Onest', 'onest-latin-400-normal.woff', '400', 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'],
  ['Onest', 'onest-cyrillic-400-normal.woff', '400', 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116'],
  ['Onest', 'onest-latin-700-normal.woff', '700', 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'],
  ['Onest', 'onest-cyrillic-700-normal.woff', '700', 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116'],
  ['Unbounded', 'Unbounded-Bold.ttf', '700'],
];

export const FONT_BODY = 'Onest, sans-serif';
export const FONT_TITLE = 'Unbounded, Onest, sans-serif';

let started = false;
export function loadBrandFonts(): void {
  if (started || typeof document === 'undefined') return;
  started = true;
  const handle = delayRender('brand fonts');
  Promise.all(
    faces.map(async ([family, file, weight, range]) => {
      const f = new FontFace(family, `url(${staticFile(`fonts/${file}`)})`, { weight, ...(range ? { unicodeRange: range } : {}) });
      document.fonts.add(await f.load());
    }),
  )
    .then(() => continueRender(handle))
    .catch((e) => {
      console.error('font load failed', e);
      continueRender(handle);
    });
}
