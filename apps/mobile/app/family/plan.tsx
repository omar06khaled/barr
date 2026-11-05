import { useState } from 'react';
import { Alert } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { formatMoney, type Currency } from '@barr/shared';
import { api, ApiError } from '../../src/lib/api';
import { API_URL } from '../../src/lib/config';
import { useI18n } from '../../src/lib/i18n';
import { useQuery } from '../../src/lib/useQuery';
import { Button, Card, Chip, Row, Screen, T } from '../../src/components/ui';

/** F9: plan selection, prepaid card payment via provider's hosted page (no raw card data in the app). */
export default function Plan() {
  const { t, lang } = useI18n();
  const { parentId, onboarding } = useLocalSearchParams<{ parentId: string; onboarding?: string }>();
  const plans = useQuery<{ items: { code: string; prices: { currency: Currency; amount: number }[] }[] }>('/plans');
  const sub = useQuery<any>(`/parents/${parentId}/subscription`);
  const invoices = useQuery<{ items: any[] }>(`/parents/${parentId}/invoices`);
  const [currency, setCurrency] = useState<Currency>('SAR');
  const [busy, setBusy] = useState<string | null>(null);
  const pay = async (planCode: string) => {
    setBusy(planCode);
    try {
      const r = await api<{ redirectUrl: string }>('/subscriptions', { method: 'POST', body: { parentId, planCode, currency } });
      await WebBrowser.openAuthSessionAsync(r.redirectUrl, `${API_URL}/v1/payments/return`);
      await sub.reload();
      router.push({ pathname: '/family/assessment', params: { parentId } });
    } catch (e) { Alert.alert('⚠', e instanceof ApiError ? e.code : 'error'); } finally { setBusy(null); }
  };
  const s = sub.data;
  return (
    <Screen>
      <T kind="heading" size="xl">{t('family.choosePlan')}</T>
      <Card tone="sand"><T>{t('plans.prepaid')}</T><T>{t('plans.notInsurance')}</T></Card>
      {s && s.status !== 'pending_payment' ? (
        <Card>
          <T kind="bold" size="lg">{t(`plans.${s.plan_code}.name`)} — {s.status}</T>
          <T>{t('family.card')}: •••• {s.card_last4 ?? '—'} {s.card_brand ?? ''}</T>
          <T>{t('family.renews')}: {s.current_period_end ? new Date(s.current_period_end).toLocaleDateString(lang === 'ar' ? 'ar-EG' : 'en-GB') : '—'}</T>
          {s.next_plan_code && <T>→ {t(`plans.${s.next_plan_code}.name`)}</T>}
          <Row>{['visit', 'plus', 'caregiver'].filter((c) => c !== s.plan_code).map((c) => <Button key={c} variant="secondary" title={`${t('family.changePlan')}: ${t(`plans.${c}.name`)}`} onPress={() => api(`/subscriptions/${s.id}/plan`, { method: 'POST', body: { planCode: c } }).then(sub.reload).catch((e) => Alert.alert('⚠', e.code))} />)}</Row>
          {(s.status === 'past_due' || s.status === 'paused') && <Button title={t('family.updateCard')} onPress={async () => { const r = await api<{ redirectUrl: string }>(`/subscriptions/${s.id}/payment-method`, { method: 'POST' }); await WebBrowser.openAuthSessionAsync(r.redirectUrl); sub.reload(); }} />}
          {s.status !== 'cancel_at_period_end' && <Button variant="danger" title={t('family.cancelPlan')} onPress={() => Alert.alert(t('family.cancelPlan'), t('family.cancelConfirm'), [{ text: t('common.cancel'), style: 'cancel' }, { text: t('common.continue'), style: 'destructive', onPress: () => api(`/subscriptions/${s.id}/cancel`, { method: 'POST' }).then(sub.reload) }])} />}
        </Card>
      ) : (
        <>
          <Row><T kind="bold">{t('family.currency')}</T>{(['SAR', 'AED', 'USD'] as Currency[]).map((c) => <Chip key={c} label={c} selected={currency === c} onPress={() => setCurrency(c)} />)}</Row>
          {plans.data?.items.map((p) => {
            const price = p.prices.find((x) => x.currency === currency);
            return (
              <Card key={p.code}>
                <T kind="heading" size="lg">{t(`plans.${p.code}.name`)}</T>
                <T>{t(`plans.${p.code}.desc`)}</T>
                <T kind="bold" size="lg">{price ? `${formatMoney({ amount: price.amount, currency }, lang)} ${t('family.perMonth')}` : '—'}</T>
                <Button title={t('family.payNow')} onPress={() => pay(p.code)} loading={busy === p.code} disabled={!price && p.code !== 'caregiver'} />
              </Card>
            );
          })}
        </>
      )}
      {!!invoices.data?.items.length && (
        <Card>
          <T kind="bold">{t('family.invoices')}</T>
          {invoices.data.items.map((i) => (
            <Row key={i.id} style={{ justifyContent: 'space-between' }}>
              <T>{i.number} · {formatMoney({ amount: i.total, currency: i.currency }, lang)} · {i.status}</T>
              <Button variant="secondary" title={t('family.downloadPdf')} onPress={() => WebBrowser.openBrowserAsync(`${API_URL}/v1/invoices/${i.id}/pdf?lang=${lang}`)} />
            </Row>
          ))}
        </Card>
      )}
      {onboarding && s?.status === 'active' && <Button title={t('family.bookAssessment')} onPress={() => router.push({ pathname: '/family/assessment', params: { parentId } })} />}
    </Screen>
  );
}
