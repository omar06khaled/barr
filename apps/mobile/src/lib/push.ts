import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { api } from './api';
import { APP_VARIANT } from './config';

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

export async function registerForPush() {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', { name: 'Barr', importance: Notifications.AndroidImportance.DEFAULT });
    // Escalations use a high-importance channel so they are never silent.
    await Notifications.setNotificationChannelAsync('escalations', { name: 'Urgent alerts', importance: Notifications.AndroidImportance.MAX, sound: 'default' });
  }
  const { status } = await Notifications.requestPermissionsAsync();
  if (status !== 'granted') return;
  const projectId = (Constants.expoConfig?.extra as any)?.eas?.projectId;
  const token = (await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined)).data;
  await api('/me/push-token', { method: 'PUT', body: { token, platform: Platform.OS === 'ios' ? 'ios' : 'android', app: APP_VARIANT } });
}
