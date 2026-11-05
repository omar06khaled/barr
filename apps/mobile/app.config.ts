import type { ExpoConfig } from 'expo/config';

/**
 * One codebase, two store apps (docs/decisions.md D2):
 *   APP_VARIANT=family → "Barr" (app.barr.family)        — for families abroad
 *   APP_VARIANT=field  → "Barr Field" (app.barr.field)   — for coordinators, nurses, doctors, caregivers
 * Role-based routing inside the app decides what each signed-in user sees.
 */
const variant = (process.env.APP_VARIANT ?? 'family') as 'family' | 'field';
const field = variant === 'field';

const config: ExpoConfig = {
  name: field ? 'Barr Field' : 'Barr',
  slug: field ? 'barr-field' : 'barr',
  scheme: field ? 'barrfield' : 'barr',
  version: '0.1.0',
  orientation: 'portrait',
  icon: field ? './assets/icon-field.png' : './assets/icon.png',
  userInterfaceStyle: 'light',
  ios: {
    bundleIdentifier: field ? 'app.barr.field' : 'app.barr.family',
    supportsTablet: false,
    usesAppleSignIn: !field,
    infoPlist: {
      NSLocationWhenInUseUsageDescription: 'Barr uses your location only at check-in and check-out to confirm a visit at the home. / يستخدم بر موقعك فقط عند تسجيل الوصول والمغادرة لتأكيد الزيارة.',
      NSCameraUsageDescription: 'Take visit photos when the family has given consent. / التقاط صور الزيارة عند وجود موافقة.',
      NSPhotoLibraryUsageDescription: 'Attach photos to a concern or chat. / إرفاق صور بملاحظة أو محادثة.',
      CFBundleAllowMixedLocalizations: true,
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: field ? 'app.barr.field' : 'app.barr.family',
    adaptiveIcon: { foregroundImage: field ? './assets/icon-field.png' : './assets/icon.png', backgroundColor: '#183B35' },
    // No background location: no continuous tracking (PRD §3.7, F5).
    permissions: field ? ['ACCESS_FINE_LOCATION', 'ACCESS_COARSE_LOCATION', 'CAMERA'] : [],
    blockedPermissions: ['ACCESS_BACKGROUND_LOCATION'],
  },
  locales: { ar: './locales/ar.json', en: './locales/en.json' },
  plugins: [
    'expo-router',
    ['expo-splash-screen', { image: './assets/splash.png', imageWidth: 200, resizeMode: 'contain', backgroundColor: '#183B35' }],
    'expo-secure-store',
    'expo-sqlite',
    'expo-localization',
    'expo-font',
    ['expo-notifications', { color: '#183B35' }],
    ...(field ? [['expo-location', { locationWhenInUsePermission: 'Barr uses your location only at check-in and check-out.' }] as [string, any], ['expo-image-picker', { cameraPermission: 'Take visit photos when the family has given consent.' }] as [string, any]] : []),
    ...(!field ? ['expo-apple-authentication' as const] : []),
    ['@sentry/react-native/expo', { organization: process.env.SENTRY_ORG ?? '', project: process.env.SENTRY_PROJECT ?? '' }],
  ] as ExpoConfig['plugins'],
  extra: {
    variant,
    apiUrl: process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000',
    helpLine: process.env.EXPO_PUBLIC_HELP_LINE ?? '', // owner provides the Barr phone number
    google: { iosClientId: process.env.GOOGLE_IOS_CLIENT_ID, androidClientId: process.env.GOOGLE_ANDROID_CLIENT_ID, webClientId: process.env.GOOGLE_WEB_CLIENT_ID },
    eas: { projectId: field ? process.env.EAS_PROJECT_ID_FIELD : process.env.EAS_PROJECT_ID_FAMILY },
  },
  experiments: { typedRoutes: false },
};
export default config;
