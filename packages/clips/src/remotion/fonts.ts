import { loadFont } from '@remotion/google-fonts/Inter';

// Inter has full Cyrillic. Loaded from Google Fonts at render time (needs network on first render).
export const { fontFamily } = loadFont('normal', { weights: ['500', '700', '800'], subsets: ['cyrillic', 'latin'] });
