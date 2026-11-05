import Constants from 'expo-constants';

/** CONFIG: API URL and app variant come from app.config.ts `extra` (set per build profile). */
const extra = (Constants.expoConfig?.extra ?? {}) as { apiUrl?: string; variant?: 'family' | 'field' };
export const API_URL = extra.apiUrl ?? 'http://localhost:4000';
export const APP_VARIANT: 'family' | 'field' = extra.variant ?? 'family';
