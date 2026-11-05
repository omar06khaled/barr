import { useEffect, useState } from 'react';
import { FlatList, Image, Pressable, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { api } from '../../src/lib/api';
import { useI18n } from '../../src/lib/i18n';
import { useQuery } from '../../src/lib/useQuery';
import { Card, Chip, Row, Screen, T } from '../../src/components/ui';
import { colors } from '../../src/theme';

const FILTERS = ['all', 'visits', 'medicines', 'alerts', 'concerns'] as const;

/** F2: reverse-chronological feed with filters and cursor pagination. */
export default function Timeline() {
  const { t, lang } = useI18n();
  const params = useLocalSearchParams<{ parentId?: string }>();
  const parents = useQuery<{ items: { id: string; name: string }[] }>('/parents');
  const parentId = params.parentId ?? parents.data?.items[0]?.id;
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('all');
  const [items, setItems] = useState<any[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = async (reset: boolean) => {
    if (!parentId || loading) return;
    setLoading(true);
    try {
      const r = await api<{ items: any[]; nextCursor: string | null }>(`/parents/${parentId}/timeline?filter=${filter}&lang=${lang}&limit=20${!reset && cursor ? `&cursor=${cursor}` : ''}`);
      setItems(reset ? r.items : [...items, ...r.items]);
      setCursor(r.nextCursor);
    } finally { setLoading(false); }
  };
  useEffect(() => { void load(true); }, [parentId, filter, lang]);
  const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString(lang === 'ar' ? 'ar-EG' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Cairo' }) : '—');
  return (
    <Screen scroll={false} style={{ flex: 1 }}>
      <T kind="heading" size="xl">{t('timeline.title')}</T>
      <Row>{FILTERS.map((f) => <Chip key={f} label={t(`timeline.filters.${f}`)} selected={filter === f} onPress={() => setFilter(f)} />)}</Row>
      <FlatList
        data={items}
        keyExtractor={(x) => x.kind + x.id}
        onRefresh={() => load(true)}
        refreshing={loading && items.length === 0}
        onEndReached={() => cursor && load(false)}
        ListEmptyComponent={<T>{t('timeline.empty')}</T>}
        contentContainerStyle={{ gap: 12, paddingBottom: 80 }}
        renderItem={({ item }) => {
          if (item.kind === 'visit') return (
            <Card>
              <T kind="bold" size="lg">{t(`visitType.${item.type}`)}{item.status === 'missed' ? ` — ✗ ${t('doses.missed')}` : ''}</T>
              {item.staff && (
                <Pressable accessibilityRole="link" onPress={() => router.push({ pathname: '/family/staff', params: { parentId, staffId: item.staff.id } })}>
                  <Row>{item.staff.photoUrl && <Image source={{ uri: item.staff.photoUrl }} style={{ width: 36, height: 36, borderRadius: 18 }} accessibilityIgnoresInvertColors />}<T kind="bold" color={colors.green900}>{item.staff.firstName} ✓ {t('staff.verified')}</T></Row>
                </Pressable>
              )}
              <T size="sm">{t('timeline.arrived')} {time(item.arrivedAt)} · {t('timeline.left')} {time(item.leftAt)}{item.durationMin ? ` · ${t('timeline.duration', { min: item.durationMin })}` : ''}</T>
              {item.report && <T>{item.report}</T>}
              {item.photoUrls?.length > 0 && <Row>{item.photoUrls.map((u: string) => <Image key={u} source={{ uri: u }} style={{ width: 96, height: 96, borderRadius: 8 }} accessibilityLabel={t('timeline.photos')} />)}</Row>}
            </Card>
          );
          if (item.kind === 'dose') return <Card tone="sand"><T>{item.status === 'confirmed' ? '✓' : item.status === 'missed' ? '✗' : '–'} {item.medicine} ({item.dose}) · {time(item.at)} — {t(`doses.${item.status}`)}</T></Card>;
          if (item.kind === 'escalation') return (
            <Pressable onPress={() => router.push({ pathname: '/escalation/[id]', params: { id: item.id } })}><Card><T kind="bold">⚠ {t('escalation.title')} — {t(`escalation.status.${item.status}`)}</T><T size="sm">{time(item.at)}</T>{item.closing_note && <T>{item.closing_note}</T>}</Card></Pressable>
          );
          return <Card tone="sand"><T kind="bold">{item.ref} — {t(`concerns.status.${item.status}`)}</T><T size="sm">{time(item.at)}</T></Card>;
        }}
      />
      <View />
    </Screen>
  );
}
