import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { dashboardStrings, translate, type DashboardStrings, type Language } from '@barr/shared';

interface I18n { lang: Language; s: DashboardStrings; t: (key: string, vars?: Record<string, string | number>) => string; toggle: () => void }
const Ctx = createContext<I18n>(null as unknown as I18n);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Language>(() => { try { return (localStorage.getItem('barr.lang') as Language) || 'en'; } catch { return 'en'; } });
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    try { localStorage.setItem('barr.lang', lang); } catch { /* ignore */ }
  }, [lang]);
  const value: I18n = { lang, s: dashboardStrings[lang] as DashboardStrings, t: (k, v) => translate(lang, k, v), toggle: () => setLang(lang === 'ar' ? 'en' : 'ar') };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
export const useI18n = () => useContext(Ctx);
