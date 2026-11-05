import { useState } from 'react';
import { FlatList, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import * as Crypto from 'expo-crypto';
import { api } from '../../src/lib/api';
import { useAuth } from '../../src/lib/auth';
import { useI18n } from '../../src/lib/i18n';
import { useQuery } from '../../src/lib/useQuery';
import { Button, Card, Field, Screen, T } from '../../src/components/ui';
import { colors } from '../../src/theme';

/** F12: one thread per parent with the coordinator. Messages are idempotent via clientId. */
export default function Chat() {
  const { t, lang } = useI18n();
  const { me } = useAuth();
  const params = useLocalSearchParams<{ parentId?: string }>();
  const parents = useQuery<{ items: { id: string; name: string }[] }>('/parents');
  const parentId = params.parentId ?? parents.data?.items[0]?.id;
  const msgs = useQuery<{ items: any[] }>(parentId ? `/parents/${parentId}/messages` : null, 15_000);
  const [text, setText] = useState('');
  const send = async () => {
    if (!text.trim() || !parentId) return;
    await api(`/parents/${parentId}/messages`, { method: 'POST', body: { kind: 'text', body: text.trim(), clientId: Crypto.randomUUID() } });
    setText('');
    await msgs.reload();
  };
  return (
    <Screen scroll={false} style={{ flex: 1 }}>
      <T kind="heading" size="xl">{t('family.chat')}{parents.data?.items.find((p) => p.id === parentId) ? ` — ${parents.data.items.find((p) => p.id === parentId)!.name}` : ''}</T>
      <FlatList inverted data={msgs.data?.items ?? []} keyExtractor={(m) => m.id} contentContainerStyle={{ gap: 8 }} renderItem={({ item }) => {
        const mine = item.sender_id === me?.id;
        return (
          <View style={{ alignSelf: mine ? 'flex-end' : 'flex-start', maxWidth: '85%' }}>
            <Card tone={mine ? 'dark' : 'white'} style={{ padding: 10 }}>
              {!mine && <T size="sm" kind="bold">{item.sender_name}</T>}
              <T color={mine ? colors.paper : undefined}>{item.body}</T>
              <T size="xs" color={mine ? colors.mist : undefined}>{new Date(item.created_at).toLocaleTimeString(lang === 'ar' ? 'ar-EG' : 'en-GB', { hour: '2-digit', minute: '2-digit' })}</T>
            </Card>
          </View>
        );
      }} />
      <Field label={t('family.message')} value={text} onChangeText={setText} multiline />
      <Button title={t('family.send')} onPress={send} disabled={!text.trim()} />
    </Screen>
  );
}
