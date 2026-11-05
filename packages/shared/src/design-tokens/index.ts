/**
 * Barr design tokens (PRD §11). Used by the mobile app and the dashboard.
 *
 * Accessibility note: status is NEVER conveyed by colour alone. Every status
 * has a text label and a distinct icon/shape, and the three status styles also
 * differ in luminance and fill style (tinted / outlined / solid) so they stay
 * distinguishable for colour-blind users (red-green CVD in particular).
 */
export const colors = {
  green900: '#183B35',
  paper: '#F7F3EC',
  sand: '#ECE6DA',
  saffron: '#D9A441',
  saffronInk: '#8A5D0B',
  inkBody: '#4A5550',
  mist: '#C9D8D2',
  white: '#FFFFFF',
  black: '#111111',
  border: '#D6CFC1',
  focus: '#1A5FB4',
} as const;

export type DailyStatusCode = 'checked' | 'pending' | 'no_contact' | 'alert';

/** Status styles: label + icon + shape are mandatory; colour is a secondary cue. */
export const statusStyles: Record<
  DailyStatusCode,
  { icon: string; shape: 'circle' | 'clock' | 'triangle'; fill: 'tinted' | 'outlined' | 'solid'; bg: string; fg: string; border: string }
> = {
  // Light tinted fill, dark text, check mark in a circle.
  checked: { icon: '✓', shape: 'circle', fill: 'tinted', bg: '#DCEFE4', fg: '#14402C', border: '#2E7D57' },
  // Neutral: before the no-contact cut-off with no contact yet. Dashed outline, hourglass.
  pending: { icon: '…', shape: 'circle', fill: 'outlined', bg: '#F7F3EC', fg: '#4A5550', border: '#8C948F' },
  // Outlined, mid amber, clock icon.
  no_contact: { icon: '◷', shape: 'clock', fill: 'outlined', bg: '#FFF6E0', fg: '#5C3B00', border: '#B07A12' },
  // Solid dark red with white text, warning triangle. Highest contrast/weight.
  alert: { icon: '⚠', shape: 'triangle', fill: 'solid', bg: '#9E1B1B', fg: '#FFFFFF', border: '#6B0F0F' },
};

export const fonts = {
  latinHeading: 'Domine',
  latinBody: 'Nunito Sans',
  arabic: 'IBM Plex Sans Arabic',
} as const;

export const fontFor = (lang: 'ar' | 'en', kind: 'heading' | 'body') =>
  lang === 'ar' ? fonts.arabic : kind === 'heading' ? fonts.latinHeading : fonts.latinBody;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 6, md: 10, lg: 16, pill: 999 } as const;
export const fontSize = { xs: 12, sm: 14, md: 16, lg: 20, xl: 24, xxl: 32 } as const;
/** PRD §4.3: minimum touch target 44×44. */
export const minTouchTarget = 44;

/** CSS custom properties for the web dashboard. */
export const cssVariables = (): string =>
  `:root{${Object.entries(colors)
    .map(([k, v]) => `--barr-${k.replace(/[A-Z0-9]+/g, (m) => '-' + m.toLowerCase())}:${v};`)
    .join('')}}`;
