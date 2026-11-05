import { useState } from 'react';
import { Alert } from 'react-native';
import { ESCALATION_DECISIONS } from '@barr/shared';
import { api, ApiError } from '../../src/lib/api';
import { useAuth } from '../../src/lib/auth';
import { useI18n } from '../../src/lib/i18n';
import { useQuery } from '../../src/lib/useQuery';
import { Button, Card, Field, Row, Screen, T } from '../../src/components/ui';

/** On-call doctor / coordinator: acknowledge (within 2 min), record decision, follow up, close with note. */
export default function FieldEscalations() {
  const { t, lang } = useI18n();
  const { me } = useAuth();
  const q = useQuery<{ items: any[] }>('/field/escalations', 10_000);
  const canAck = me?.roles.some((r) => ['doctor', 'oncall_doctor', 'admin'].includes(r));
  const [notes, setNotes] = useState<Record<string, string>>({});
  const act = async (id: string, path: string, body?: unknown) => { try { await api(`/escalations/${id}/${path}`, { method: 'POST', body }); q.reload(); } catch (e) { Alert.alert('⚠', e instanceof ApiError ? e.code : 'error'); } };
  if (q.error === 'role_required') return <Screen><T>—</T></Screen>;
  return (
    <Screen>
      <T kind="heading" size="xl">{t('escalation.title')}</T>
      {q.data?.items.length === 0 && <T>✓ {t('timeline.empty')}</T>}
      {q.data?.items.map((e) => {
        const ageMin = Math.floor((Date.now() - new Date(e.created_at).getTime()) / 60000);
        return (
          <Card key={e.id}>
            <T kind="bold" size="lg">⚠ {e.parent_name} · {e.severity === 'urgent' ? '‼' : ''} {e.trigger}</T>
            <T>{t(`escalation.status.${e.status}`)} · {ageMin} min{e.note ? ` · ${e.note}` : ''}</T>
            {canAck && !e.acknowledged_at && <Button title="✓ Acknowledge" onPress={() => act(e.id, 'acknowledge')} />}
            {canAck && <Row>{ESCALATION_DECISIONS.map((d) => <Button key={d} variant="secondary" title={t(`escalation.decision.${d}`)} onPress={() => act(e.id, 'decision', { decision: d })} />)}</Row>}
            <Field label={t('timeline.note')} value={notes[e.id] ?? ''} onChangeText={(v) => setNotes({ ...notes, [e.id]: v })} multiline />
            <Row>
              <Button variant="secondary" title="+ follow-up" disabled={(notes[e.id] ?? '').length < 2} onPress={() => act(e.id, 'follow-up', { note: notes[e.id], visibleToFamily: true })} />
              <Button variant="danger" title="Close" disabled={(notes[e.id] ?? '').length < 3} onPress={() => act(e.id, 'close', { note: notes[e.id] })} />
            </Row>
            <T size="xs">{new Date(e.created_at).toLocaleString(lang === 'ar' ? 'ar-EG' : 'en-GB', { timeZone: 'Africa/Cairo' })}</T>
          </Card>
        );
      })}
    </Screen>
  );
}
