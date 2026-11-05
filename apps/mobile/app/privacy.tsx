import { useLocalSearchParams } from 'expo-router';
import { useI18n } from '../src/lib/i18n';
import { Card, Screen, T } from '../src/components/ui';

/** Placeholder privacy policy and terms (owner provides final text). */
export default function Privacy() {
  const { t } = useI18n();
  const { doc } = useLocalSearchParams<{ doc?: string }>();
  return (
    <Screen>
      <T kind="heading" size="xl">{doc === 'terms' ? t('privacy.terms') : t('privacy.title')}</T>
      <Card><T>{t('privacy.placeholder')}</T><T>{t('plans.notInsurance')}</T></Card>
    </Screen>
  );
}
