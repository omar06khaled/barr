import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Role } from '@barr/shared';
import { api, clearSession, loadSession, saveSession, setSignedOutHandler } from './api';
import { registerForPush } from './push';

export interface Me { id: string; roles: Role[]; firstName: string; displayName: string; language: 'ar' | 'en'; families: { family_id: string; whatsapp_opt_in: boolean }[]; staff: { role: Role; verified: boolean } | null; identities: string[] }
interface Auth { me: Me | null; ready: boolean; signIn: (tokens: { accessToken: string; refreshToken: string }) => Promise<void>; signOut: () => Promise<void>; reload: () => Promise<void> }
const Ctx = createContext<Auth>(null as unknown as Auth);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const reload = useCallback(async () => {
    try { setMe(await api<Me>('/me')); } catch { setMe(null); }
  }, []);
  useEffect(() => {
    setSignedOutHandler(() => setMe(null));
    loadSession().then(async (has) => { if (has) await reload(); setReady(true); });
  }, [reload]);
  const signIn = async (t: { accessToken: string; refreshToken: string }) => {
    await saveSession(t.accessToken, t.refreshToken);
    await reload();
    registerForPush().catch(() => {});
  };
  const signOut = async () => { await api('/auth/logout', { method: 'POST' }).catch(() => {}); await clearSession(); setMe(null); };
  return <Ctx.Provider value={{ me, ready, signIn, signOut, reload }}>{children}</Ctx.Provider>;
}
export const useAuth = () => useContext(Ctx);
export const isStaffUser = (me: Me | null) => !!me && me.roles.some((r) => r !== 'family');
