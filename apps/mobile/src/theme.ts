import { colors, fontSize, minTouchTarget, radius, spacing, statusStyles } from '@barr/shared';
export { colors, fontSize, minTouchTarget, radius, spacing, statusStyles };

/** Font family names registered in app/_layout.tsx via expo-font. */
export const fontFamily = (lang: 'ar' | 'en', kind: 'heading' | 'body' | 'bold') =>
  lang === 'ar' ? (kind === 'body' ? 'IBMPlexSansArabic_400Regular' : 'IBMPlexSansArabic_600SemiBold') : kind === 'heading' ? 'Domine_700Bold' : kind === 'bold' ? 'NunitoSans_700Bold' : 'NunitoSans_400Regular';
