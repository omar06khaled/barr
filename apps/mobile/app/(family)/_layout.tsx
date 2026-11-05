import { Tabs } from 'expo-router';
import { Text } from 'react-native';
import { useI18n } from '../../src/lib/i18n';
import { colors } from '../../src/theme';

const icon = (glyph: string) => ({ color }: { color: any }) => <Text style={{ color, fontSize: 20 }}>{glyph}</Text>;
export default function FamilyTabs() {
  const { t } = useI18n();
  return (
    <Tabs screenOptions={{ headerShown: false, tabBarActiveTintColor: colors.green900, tabBarInactiveTintColor: '#6b736f', tabBarStyle: { backgroundColor: colors.paper, minHeight: 60 }, tabBarLabelStyle: { fontSize: 13 } }}>
      <Tabs.Screen name="home" options={{ title: t('common.today'), tabBarIcon: icon('⌂') }} />
      <Tabs.Screen name="timeline" options={{ title: t('timeline.title'), tabBarIcon: icon('☰') }} />
      <Tabs.Screen name="chat" options={{ title: t('family.chat'), tabBarIcon: icon('✉') }} />
      <Tabs.Screen name="account" options={{ title: t('family.account'), tabBarIcon: icon('⚙') }} />
    </Tabs>
  );
}
