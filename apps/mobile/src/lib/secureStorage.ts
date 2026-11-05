import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

/** Keychain/Keystore on devices. The web build is only a developer preview and falls back to localStorage. */
const web = Platform.OS === 'web';
export const secureStorage = {
  get: async (k: string) => (web ? globalThis.localStorage?.getItem(k) ?? null : SecureStore.getItemAsync(k)),
  set: async (k: string, v: string) => (web ? globalThis.localStorage?.setItem(k, v) : SecureStore.setItemAsync(k, v)),
  del: async (k: string) => (web ? globalThis.localStorage?.removeItem(k) : SecureStore.deleteItemAsync(k)),
};
