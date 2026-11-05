import { en, type Dictionary } from './en';
import { ar } from './ar';
import { renderTemplate } from './notifications';

export { en, ar, type Dictionary };
export * from './notifications';
export const dictionaries = { en, ar } as const;
export type Language = 'ar' | 'en';
export const isRtl = (lang: Language) => lang === 'ar';

/** Lookup "a.b.c" in a dictionary with {{var}} interpolation. Falls back to English, then the key. */
export function translate(lang: Language, key: string, vars: Record<string, string | number> = {}): string {
  const get = (d: unknown) => key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), d);
  const v = get(dictionaries[lang]) ?? get(en);
  return typeof v === 'string' ? renderTemplate(v, vars) : key;
}
