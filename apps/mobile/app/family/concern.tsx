import { useState } from 'react';
import { Switch } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { CONCERN_CATEGORIES } from '@barr/shared';
import { api, ApiError } from '../../src/lib/api';
import { useI18n } from '../../src/lib/i18n';
import { useQuery } from '../../src/lib/useQuery';
import { Button, Card, Chip, Field, Row, Screen, T } from '../../src/components/ui';

/** F11: raise a concern; shows reference, status and reply deadline; reopen within 7 days. */
export default function Concern() {
  const { t, lang } = useI18n();
  const { parentId } = useLocalSearchParams<{ parentId: string }>();
  const list = useQuery<{ items: any[] }>(`/parents/${parentId}/concerns`);
  const [category, setCategory] = useState<(typeof CONCERN_CATEGORIES)[number]>('care_quality');
  const [urgent, setUrgent] = useState(false);
  const [text, setText] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const submit = async () => {
    try { const r = await api<{ ref: string }>('/concerns', { method: 'POST', body: { parentId, category, urgency: urgent ? 'urgent' : 'normal', text } }); setText(''); setMsg(t('family.submitted', { ref: r.ref })); list.reload(); }
    catch (e) { setMsg(e instanceof ApiError ? e.code : 'error'); }
  };
  const fmt = (iso: string) => new Date(iso).toLocaleString(lang === 'ar' ? 'ar-EG' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Cairo' });
  return (
    <Screen>
      <T kind="heading" size="xl">{t('concerns.raise')}</T>
      <Card>
        <T kind="bold">{t('family.category')}</T>
        <Row>{CONCERN_CATEGORIES.map((c) => <Chip key={c} label={c.replace('_', ' ')} selected={category === c} onPress={() => setCategory(c)} />)}</Row>
        <Row style={{ justifyContent: 'space-between' }}><T>{t('family.urgent')}</T><Switch accessibilityLabel={t('family.urgent')} value={urgent} onValueChange={setUrgent} /></Row>
        <Field label={t('family.details')} value={text} onChangeText={setText} multiline maxLength={2000} />
        <Button title={t('common.submit')} onPress={submit} disabled={text.trim().length < 3} />
        {msg && <T kind="bold">{msg}</T>}
      </Card>
      {list.data?.items.map((c) => (
        <Card key={c.id} tone="sand">
          <T kind="bold">{c.ref} · {t(`concerns.status.${c.status}`)}{c.safety_flag ? ' · ⚠' : ''}</T>
          <T>{c.text}</T>
          {c.status !== 'resolved' ? <T size="sm">{t('concerns.deadline', { time: fmt(c.deadline) })}</T> : <T size="sm">✓ {c.resolution}</T>}
          {c.status === 'resolved' && <Button variant="secondary" title={t('concerns.reopen')} onPress={() => api(`/concerns/${c.id}/reopen`, { method: 'POST', body: { reason: 'Reopened from app' } }).then(list.reload).catch((e) => setMsg(e.code))} />}
        </Card>
      ))}
    </Screen>
  );
}
