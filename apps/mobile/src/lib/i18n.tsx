import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { I18nManager } from 'react-native';
import * as Localization from 'expo-localization';
import { secureStorage } from './secureStorage';
import * as Updates from 'expo-updates';
import { translate, type Language } from '@barr/shared';

interface I18n { lang: Language; rtl: boolean; t: (k: string, v?: Record<string, string | number>) => string; setLang: (l: Language) => Promise<void> }
const Ctx = createContext<I18n>(null as unknown as I18n);

/** Arabic (RTL) and English everywhere. Switching direction needs a reload on native (I18nManager). */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Language>(() => (Localization.getLocales()[0]?.languageCode === 'en' ? 'en' : 'ar'));
  useEffect(() => { secureStorage.get('barr.lang').then((l) => l && setLangState(l as Language)); }, []);
  const setLang = async (l: Language) => {
    await secureStorage.set('barr.lang', l);
    setLangState(l);
    const wantRtl = l === 'ar';
    if (I18nManager.isRTL !== wantRtl) {
      I18nManager.allowRTL(wantRtl);
      I18nManager.forceRTL(wantRtl);
      try { await Updates.reloadAsync(); } catch { /* dev client: user restarts */ }
    }
  };
  return <Ctx.Provider value={{ lang, rtl: lang === 'ar', t: (k, v) => translate(lang, k, v), setLang }}>{children}</Ctx.Provider>;
}
export const useI18n = () => useContext(Ctx);
