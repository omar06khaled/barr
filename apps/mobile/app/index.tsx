import { Redirect } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';
import { isStaffUser, useAuth } from '../src/lib/auth';
import { APP_VARIANT } from '../src/lib/config';
import { colors } from '../src/theme';

/** Role-based entry: staff → field experience, family → family experience. */
export default function Index() {
  const { me, ready } = useAuth();
  if (!ready) return <View style={{ flex: 1, justifyContent: 'center', backgroundColor: colors.paper }}><ActivityIndicator color={colors.green900} /></View>;
  if (!me) return <Redirect href="/sign-in" />;
  if (isStaffUser(me)) return <Redirect href="/(field)/today" />;
  if (APP_VARIANT === 'field') return <Redirect href="/sign-in?notStaff=1" />;
  return <Redirect href="/(family)/home" />;
}
