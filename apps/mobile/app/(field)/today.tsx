import { useEffect } from 'react';
import { Pressable } from 'react-native';
import { router } from 'expo-router';
import { api } from '../../src/lib/api';
import { cache } from '../../src/lib/outbox';
import { useI18n } from '../../src/lib/i18n';
import { useQuery } from '../../src/lib/useQuery';
import { Card, Screen, T } from '../../src/components/ui';
import { SyncBanner } from '../../src/components/SyncBanner';

/** Today's visits grouped by neighbourhood (route). Visit packages are pre-cached for offline use. */
export default function FieldToday() {
  const { t, lang } = useI18n();
  const q = useQuery<{ date: string; items: any[]; route: { neighborhood: string; visitIds: string[] }[] }>('/field/visits', 60_000);
  useEffect(() => {
    // Pre-fetch every visit package while online so the visit works with no signal.
    q.data?.items.forEach((v) => api(`/field/visits/${v.id}`).then((pkg) => cache.set(`visit:${v.id}`, pkg)).catch(() => {}));
    if (q.data) void cache.set('field:today', q.data);
  }, [q.data]);
  const data = q.data;
  const time = (iso: string) => new Date(iso).toLocaleTimeString(lang === 'ar' ? 'ar-EG' : 'en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Cairo' });
  const status = (v: any) => (v.status === 'completed' ? '✓' : v.status === 'in_progress' ? '◐' : '○');
  return (
    <Screen>
      <T kind="heading" size="xl">{t('field.todayVisits')}</T>
      <SyncBanner />
      {q.error && <T>⚠ {q.error}</T>}
      {data?.route.map((g) => (
        <Card key={g.neighborhood} tone="sand">
          <T kind="bold">{t('field.neighborhood')}: {g.neighborhood}</T>
          {g.visitIds.map((id) => {
            const v = data.items.find((x) => x.id === id)!;
            return (
              <Pressable key={id} accessibilityRole="button" accessibilityLabel={`${v.parent_name} ${time(v.scheduled_at)}`} onPress={() => router.push({ pathname: '/visit/[id]', params: { id } })} style={{ minHeight: 56, justifyContent: 'center' }}>
                <T kind="bold">{status(v)} {time(v.scheduled_at)} · {v.parent_name}</T>
                <T size="sm">{t(`visitType.${v.type}`)}{v.allergies_has ? ' · ⚠ allergy' : ''}{!v.photo_consent ? ' · 📷✗' : ''}</T>
              </Pressable>
            );
          })}
        </Card>
      ))}
      {data && data.items.length === 0 && <T>{t('timeline.empty')}</T>}
    </Screen>
  );
}
