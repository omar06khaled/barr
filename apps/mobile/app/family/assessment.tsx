import { useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { api, ApiError } from '../../src/lib/api';
import { useI18n } from '../../src/lib/i18n';
import { useQuery } from '../../src/lib/useQuery';
import { Button, Card, Screen, T } from '../../src/components/ui';

/** F1 last step: book the home assessment from the coordinator's calendar. */
export default function Assessment() {
  const { t, lang } = useI18n();
  const { parentId } = useLocalSearchParams<{ parentId: string }>();
  const slots = useQuery<{ items: { id: string; starts_at: string }[] }>(`/parents/${parentId}/assessment-slots`);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const book = async (slotId: string) => {
    try { const r = await api<{ startsAt: string }>('/assessments', { method: 'POST', body: { parentId, slotId } }); setDone(r.startsAt); } catch (e) { setErr(e instanceof ApiError ? e.code : 'error'); slots.reload(); }
  };
  const fmt = (iso: string) => new Date(iso).toLocaleString(lang === 'ar' ? 'ar-EG' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Cairo' });
  return (
    <Screen>
      <T kind="heading" size="xl">{t('family.bookAssessment')}</T>
      {done ? (
        <Card><T kind="bold" size="lg">✓ {t('family.booked')}</T><T>{fmt(done)}</T><Button title={t('common.continue')} onPress={() => router.replace('/(family)/home')} /></Card>
      ) : (
        <>
          {slots.data?.items.length === 0 && <T>{t('family.noSlots')}</T>}
          {slots.data?.items.map((s) => <Button key={s.id} variant="secondary" title={fmt(s.starts_at)} onPress={() => book(s.id)} />)}
          {err && <T>⚠ {err}</T>}
        </>
      )}
    </Screen>
  );
}
