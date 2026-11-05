import { useState } from 'react';
import { Alert, Switch } from 'react-native';
import { router } from 'expo-router';
import { api, ApiError } from '../../src/lib/api';
import { useAuth } from '../../src/lib/auth';
import { useI18n } from '../../src/lib/i18n';
import { useQuery } from '../../src/lib/useQuery';
import { Button, Card, Chip, Field, Row, Screen, T } from '../../src/components/ui';

export default function Account() {
  const { t, lang, setLang } = useI18n();
  const { me, signOut, reload } = useAuth();
  const familyId = me?.families[0]?.family_id;
  const members = useQuery<{ members: any[]; invites: any[] }>(familyId ? `/families/${familyId}/members` : null);
  const [phone, setPhone] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const invite = async () => {
    try { await api(`/families/${familyId}/invites`, { method: 'POST', body: { phone } }); setPhone(''); setMsg(t('family.inviteSent')); members.reload(); }
    catch (e) { setMsg(e instanceof ApiError ? e.code : 'error'); }
  };
  const whatsapp = async (optIn: boolean) => { await api('/me/whatsapp', { method: 'PUT', body: { familyId, optIn } }); await reload(); };
  const del = () => Alert.alert(t('privacy.deleteAccount'), t('privacy.deleteConfirm'), [
    { text: t('common.cancel'), style: 'cancel' },
    { text: t('privacy.deleteAccount'), style: 'destructive', onPress: async () => { await api('/me', { method: 'DELETE' }); await signOut(); router.replace('/sign-in'); } },
  ]);
  return (
    <Screen>
      <T kind="heading" size="xl">{t('family.account')}</T>
      <Card>
        <T kind="bold">{t('common.language')}</T>
        <Row><Chip label="العربية" selected={lang === 'ar'} onPress={() => setLang('ar')} /><Chip label="English" selected={lang === 'en'} onPress={() => setLang('en')} /></Row>
        {familyId && <Row style={{ justifyContent: 'space-between' }}><T>{t('family.whatsapp')}</T><Switch accessibilityLabel={t('family.whatsapp')} value={!!me?.families[0]?.whatsapp_opt_in} onValueChange={whatsapp} /></Row>}
      </Card>
      {familyId && (
        <Card>
          <T kind="bold">{t('family.members')}</T>
          {members.data?.members.map((m) => <T key={m.id}>• {m.first_name || m.display_name || '—'}</T>)}
          <Field label={t('family.invitePhone')} value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
          <Button title={t('family.inviteSibling')} onPress={invite} disabled={phone.length < 8} />
          {msg && <T>{msg}</T>}
        </Card>
      )}
      <Card>
        <Button variant="secondary" title={t('privacy.title')} onPress={() => router.push('/privacy')} />
        <Button variant="secondary" title={t('privacy.terms')} onPress={() => router.push('/privacy?doc=terms')} />
        <Button variant="secondary" title={t('common.signOut')} onPress={async () => { await signOut(); router.replace('/sign-in'); }} />
        <Button variant="danger" title={t('privacy.deleteAccount')} onPress={del} />
      </Card>
    </Screen>
  );
}
