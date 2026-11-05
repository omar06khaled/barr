import { useLocalSearchParams } from 'expo-router';
import { api } from '../../src/lib/api';
import { useAuth } from '../../src/lib/auth';
import { useI18n } from '../../src/lib/i18n';
import { useQuery } from '../../src/lib/useQuery';
import { Button, Card, Screen, T } from '../../src/components/ui';

/** F10: current care plan + agreement acceptance (who/when/which version); previous versions viewable. */
export default function CarePlan() {
  const { t, lang } = useI18n();
  const { me } = useAuth();
  const { parentId } = useLocalSearchParams<{ parentId: string }>();
  const plans = useQuery<{ items: any[] }>(`/parents/${parentId}/care-plans`);
  const pick = (x: { en: string; ar: string }) => (lang === 'ar' ? x.ar : x.en);
  return (
    <Screen>
      <T kind="heading" size="xl">{t('family.carePlan')}</T>
      {plans.data?.items.map((p) => {
        const mine = p.acceptances.find((a: any) => a.user_id === me?.id);
        return (
          <Card key={p.id} tone={p.status === 'published' ? 'white' : 'sand'}>
            <T kind="bold" size="lg">{t('family.version')} {p.version} {p.status === 'published' ? `(${t('family.current')})` : ''}</T>
            <T kind="bold">{t('family.visitsPlan')}</T>
            {p.content.visitRules?.map((r: any, i: number) => <T key={i}>• {t(`visitType.${r.type}`)} — {r.freq} {r.time}</T>)}
            {!!p.content.goals?.length && <><T kind="bold">{t('family.goals')}</T>{p.content.goals.map((g: any, i: number) => <T key={i}>• {pick(g)}</T>)}</>}
            {!!p.content.included?.length && <><T kind="bold">{t('family.included')}</T>{p.content.included.map((g: any, i: number) => <T key={i}>• {pick(g)}</T>)}</>}
            {!!p.content.notIncluded?.length && <><T kind="bold">{t('family.notIncluded')}</T>{p.content.notIncluded.map((g: any, i: number) => <T key={i}>• {pick(g)}</T>)}</>}
            {p.acceptances.map((a: any) => <T key={a.user_id} size="sm">✓ {t('family.accepted')}: {a.first_name || '—'} · {new Date(a.accepted_at).toLocaleDateString(lang === 'ar' ? 'ar-EG' : 'en-GB')}</T>)}
            {p.status === 'published' && !mine && <Button title={t('family.accept')} onPress={() => api(`/care-plans/${p.id}/accept`, { method: 'POST' }).then(plans.reload)} />}
          </Card>
        );
      })}
    </Screen>
  );
}
