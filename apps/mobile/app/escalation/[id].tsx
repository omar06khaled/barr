import { useLocalSearchParams } from 'expo-router';
import { useI18n } from '../../src/lib/i18n';
import { useQuery } from '../../src/lib/useQuery';
import { Card, Screen, StatusPill, T } from '../../src/components/ui';

/** F8 step 6: live escalation card (polls every 10 s) with family-visible timeline. */
export default function EscalationCard() {
  const { t, lang } = useI18n();
  const { id } = useLocalSearchParams<{ id: string }>();
  const e = useQuery<any>(`/escalations/${id}`, 10_000);
  if (!e.data) return <Screen><T>{t('common.loading')}</T></Screen>;
  const x = e.data;
  const time = (iso: string) => new Date(iso).toLocaleTimeString(lang === 'ar' ? 'ar-EG' : 'en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Cairo' });
  const label = (ev: any) => {
    if (ev.kind === 'decision') return t(`escalation.decision.${ev.data.decision}`);
    if (ev.kind === 'follow_up' || ev.kind === 'closed') return ev.data.note;
    if (ev.kind === 'acknowledged') return t('escalation.status.acknowledged');
    if (ev.kind === 'created') return t('escalation.status.open');
    if (ev.kind === 'family_notified') return '✉';
    return ev.kind;
  };
  return (
    <Screen>
      <T kind="heading" size="xl">{t('escalation.title')}</T>
      <StatusPill status={x.status === 'closed' ? 'checked' : 'alert'} large />
      <T kind="bold" size="lg">{t(`escalation.status.${x.status}`)}</T>
      <Card>
        {x.events.map((ev: any, i: number) => <T key={i}>{time(ev.at)} — {label(ev)}</T>)}
      </Card>
      <Card tone="sand"><T size="sm">{t('escalation.costsNote')}</T></Card>
    </Screen>
  );
}
