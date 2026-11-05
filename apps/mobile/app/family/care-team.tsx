import { useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { api } from '../../src/lib/api';
import { useI18n } from '../../src/lib/i18n';
import { useQuery } from '../../src/lib/useQuery';
import { Button, Card, Field, Screen, T } from '../../src/components/ui';

/** F13: everyone who has cared for the parent + request a replacement. */
export default function CareTeam() {
  const { t, lang } = useI18n();
  const { parentId } = useLocalSearchParams<{ parentId: string }>();
  const team = useQuery<{ items: any[] }>(`/parents/${parentId}/care-team`);
  const [reason, setReason] = useState('');
  const [target, setTarget] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const d = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(lang === 'ar' ? 'ar-EG' : 'en-GB') : '—');
  return (
    <Screen>
      <T kind="heading" size="xl">{t('family.careTeam')}</T>
      {team.data?.items.map((m) => (
        <Card key={m.user_id + m.started_at} tone={m.ended_at ? 'sand' : 'white'}>
          <T kind="bold">{m.first_name} · {m.role}</T>
          <T size="sm">{d(m.started_at)} → {m.ended_at ? d(m.ended_at) : t('family.current')} · {t('staff.visitsWithFamily', { count: m.visits })}</T>
          <Button variant="secondary" title={t('staff.verified')} onPress={() => router.push({ pathname: '/family/staff', params: { parentId, staffId: m.user_id } })} />
          {!m.ended_at && m.role !== 'coordinator' && <Button variant="secondary" title={t('family.requestReplacement')} onPress={() => setTarget(m.user_id)} />}
        </Card>
      ))}
      {target && !done && (
        <Card>
          <Field label={t('family.reason')} value={reason} onChangeText={setReason} multiline />
          <Button title={t('family.requestReplacement')} disabled={reason.trim().length < 3} onPress={async () => { await api(`/parents/${parentId}/replacement-requests`, { method: 'POST', body: { staffUserId: target, reason } }); setDone(true); }} />
        </Card>
      )}
      {done && <Card><T kind="bold">✓ {t('family.submitted', { ref: '' })}</T></Card>}
    </Screen>
  );
}
