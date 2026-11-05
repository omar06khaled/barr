import { router } from 'expo-router';
import { useAuth } from '../../src/lib/auth';
import { useI18n } from '../../src/lib/i18n';
import { Button, Card, Chip, Row, Screen, T } from '../../src/components/ui';

export default function FieldAccount() {
  const { t, lang, setLang } = useI18n();
  const { me, signOut } = useAuth();
  return (
    <Screen>
      <T kind="heading" size="xl">{me?.firstName}</T>
      <T>{me?.staff?.role} · {me?.staff?.verified ? `✓ ${t('staff.verified')}` : '✗'}</T>
      <Card>
        <Row><Chip label="العربية" selected={lang === 'ar'} onPress={() => setLang('ar')} /><Chip label="English" selected={lang === 'en'} onPress={() => setLang('en')} /></Row>
        <Button variant="secondary" title={t('privacy.title')} onPress={() => router.push('/privacy')} />
        <Button variant="secondary" title={t('common.signOut')} onPress={async () => { await signOut(); router.replace('/sign-in'); }} />
      </Card>
    </Screen>
  );
}
