import { Tabs } from 'expo-router';
import { Text } from 'react-native';
import { useI18n } from '../../src/lib/i18n';
import { colors } from '../../src/theme';

const icon = (glyph: string) => ({ color }: { color: any }) => <Text style={{ color, fontSize: 20 }}>{glyph}</Text>;
export default function FieldTabs() {
  const { t } = useI18n();
  return (
    <Tabs screenOptions={{ headerShown: false, tabBarActiveTintColor: colors.green900, tabBarStyle: { backgroundColor: colors.paper, minHeight: 60 }, tabBarLabelStyle: { fontSize: 13 } }}>
      <Tabs.Screen name="today" options={{ title: t('field.todayVisits'), tabBarIcon: icon('⌂') }} />
      <Tabs.Screen name="escalations" options={{ title: t('escalation.title'), tabBarIcon: icon('⚠') }} />
      <Tabs.Screen name="tasks" options={{ title: '✓', tabBarIcon: icon('☑') }} />
      <Tabs.Screen name="account" options={{ title: t('family.account'), tabBarIcon: icon('⚙') }} />
    </Tabs>
  );
}
