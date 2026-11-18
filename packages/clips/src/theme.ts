/** Fir Tech brand tokens: concrete, calm, no hype. */
export interface Theme {
  bg: string;
  surface: string;
  text: string;
  muted: string;
  accent: string;
  accentText: string;
}

export const THEMES: Record<'dark' | 'light', Theme> = {
  dark: { bg: '#0E1411', surface: '#18211C', text: '#F3F5F2', muted: '#8FA096', accent: '#4ADE80', accentText: '#07130B' },
  light: { bg: '#F4F5F2', surface: '#FFFFFF', text: '#101713', muted: '#5C6B62', accent: '#15803D', accentText: '#FFFFFF' },
};
