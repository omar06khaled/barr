import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { useFonts } from 'expo-font';
import { Domine_700Bold } from '@expo-google-fonts/domine';
import { NunitoSans_400Regular, NunitoSans_700Bold } from '@expo-google-fonts/nunito-sans';
import { IBMPlexSansArabic_400Regular, IBMPlexSansArabic_600SemiBold } from '@expo-google-fonts/ibm-plex-sans-arabic';
import * as Sentry from '@sentry/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider } from '../src/lib/auth';
import { I18nProvider } from '../src/lib/i18n';
import { colors } from '../src/theme';

// Crash reporting (M5). DSN is CONFIG; disabled when empty. No ad SDKs; PII scrubbing on.
Sentry.init({ dsn: process.env.EXPO_PUBLIC_SENTRY_DSN ?? '', enabled: !!process.env.EXPO_PUBLIC_SENTRY_DSN, sendDefaultPii: false });
SplashScreen.preventAutoHideAsync().catch(() => {});

function useNotificationRouting() {
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((r) => {
      const d = r.notification.request.content.data as Record<string, string>;
      if (d.escalationId) router.push({ pathname: '/escalation/[id]', params: { id: d.escalationId } });
      else if (d.parentId) router.push({ pathname: '/(family)/timeline', params: { parentId: d.parentId } });
    });
    return () => sub.remove();
  }, []);
}

function Root() {
  const [loaded] = useFonts({ Domine_700Bold, NunitoSans_400Regular, NunitoSans_700Bold, IBMPlexSansArabic_400Regular, IBMPlexSansArabic_600SemiBold });
  useNotificationRouting();
  useEffect(() => { if (loaded) SplashScreen.hideAsync().catch(() => {}); }, [loaded]);
  if (!loaded) return null;
  return (
    <SafeAreaProvider>
      <I18nProvider>
        <AuthProvider>
          <StatusBar style="dark" />
          <Stack screenOptions={{ headerStyle: { backgroundColor: colors.paper }, headerTintColor: colors.green900, contentStyle: { backgroundColor: colors.paper } }}>
            <Stack.Screen name="index" options={{ headerShown: false }} />
            <Stack.Screen name="sign-in" options={{ headerShown: false }} />
            <Stack.Screen name="(family)" options={{ headerShown: false }} />
            <Stack.Screen name="(field)" options={{ headerShown: false }} />
          </Stack>
        </AuthProvider>
      </I18nProvider>
    </SafeAreaProvider>
  );
}
export default Sentry.wrap(Root);
