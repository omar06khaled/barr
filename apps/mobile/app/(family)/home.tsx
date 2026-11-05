import { Alert, View } from 'react-native';
import { router } from 'expo-router';
import { api } from '../../src/lib/api';
import { useI18n } from '../../src/lib/i18n';
import { useQuery } from '../../src/lib/useQuery';
import { Button, Card, Row, Screen, StatusPill, T } from '../../src/components/ui';

interface ParentRow { id: string; name: string; status: string; family_id: string; plan_code: string | null; sub_status: string | null; status_today: { status: 'checked' | 'pending' | 'no_contact' | 'alert'; lastContactAt: string | null; openEscalationId: string | null } }

function ParentCard({ p }: { p: ParentRow }) {
  const { t, lang } = useI18n();
  const doses = useQuery<{ items: any[] }>(`/parents/${p.id}/doses/today`, 30_000);
  const s = p.status_today;
  const getHelp = () =>
    Alert.alert(t('help.button'), t('help.confirm'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('common.continue'), style: 'destructive', onPress: async () => {
        const r = await api<{ id: string }>('/escalations', { method: 'POST', body: { parentId: p.id, severity: 'urgent' } });
        Alert.alert(t('help.button'), t('help.sent'));
        router.push({ pathname: '/escalation/[id]', params: { id: r.id } });
      } },
    ]);
  return (
    <Card>
      <T kind="heading" size="xl">{p.name}</T>
      <StatusPill status={s.status} large />
      <T>{t(`status.${s.status}_desc`, { name: p.name })}</T>
      {s.lastContactAt && <T size="sm">{t('timeline.arrived')}: {new Date(s.lastContactAt).toLocaleTimeString(lang === 'ar' ? 'ar-EG' : 'en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Cairo' })}</T>}
      {s.openEscalationId && <Button variant="danger" title={t('escalation.title')} onPress={() => router.push({ pathname: '/escalation/[id]', params: { id: s.openEscalationId! } })} />}
      {!!doses.data?.items.length && (
        <View style={{ gap: 4, marginTop: 8 }}>
          <T kind="bold">{t('doses.title')}</T>
          {doses.data.items.map((d) => (
            <T key={d.id} accessibilityLabel={`${d.name} ${t(`doses.${d.status}`)}`}>
              {d.status === 'confirmed' ? '✓' : d.status === 'missed' ? '✗' : '◷'} {new Date(d.scheduled_at).toLocaleTimeString(lang === 'ar' ? 'ar-EG' : 'en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Cairo' })} · {d.name} — {t(`doses.${d.status}`)}
            </T>
          ))}
        </View>
      )}
      <Row>
        <Button variant="secondary" title={t('timeline.title')} onPress={() => router.push({ pathname: '/(family)/timeline', params: { parentId: p.id } })} />
        <Button variant="secondary" title={t('concerns.raise')} onPress={() => router.push({ pathname: '/family/concern', params: { parentId: p.id } })} />
        <Button variant="secondary" title={t('family.carePlan')} onPress={() => router.push({ pathname: '/family/care-plan', params: { parentId: p.id } })} />
        <Button variant="secondary" title={t('family.careTeam')} onPress={() => router.push({ pathname: '/family/care-team', params: { parentId: p.id } })} />
        <Button variant="secondary" title={t('family.planPayment')} onPress={() => router.push({ pathname: '/family/plan', params: { parentId: p.id } })} />
      </Row>
      <Button variant="help" title={`⚠ ${t('help.button')}`} accessibilityHint={t('help.confirm')} onPress={getHelp} />
    </Card>
  );
}

export default function Home() {
  const { t } = useI18n();
  const parents = useQuery<{ items: ParentRow[] }>('/parents', 30_000);
  return (
    <Screen>
      <T kind="heading" size="xxl">{t('app.name')}</T>
      {parents.error && <T>⚠ {parents.error}</T>}
      {parents.data?.items.map((p) => <ParentCard key={p.id} p={p} />)}
      {parents.data && parents.data.items.length === 0 && (
        <Card tone="sand"><T kind="heading" size="lg">{t('app.tagline')}</T><Button title={t('family.addParent')} onPress={() => router.push('/family/add-parent')} /></Card>
      )}
      {!!parents.data?.items.length && <Button variant="secondary" title={t('family.addAnother')} onPress={() => router.push('/family/add-parent')} />}
    </Screen>
  );
}
