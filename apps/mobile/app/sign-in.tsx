import { useState } from 'react';
import { Platform, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Google from 'expo-auth-session/providers/google';
import * as WebBrowser from 'expo-web-browser';
import Constants from 'expo-constants';
import { toE164 } from '@barr/shared';
import { api, ApiError } from '../src/lib/api';
import { useAuth } from '../src/lib/auth';
import { useI18n } from '../src/lib/i18n';
import { APP_VARIANT } from '../src/lib/config';
import { Button, Card, Chip, Field, Row, Screen, T } from '../src/components/ui';

WebBrowser.maybeCompleteAuthSession();
const g = ((Constants.expoConfig?.extra as any)?.google ?? {}) as { iosClientId?: string; androidClientId?: string; webClientId?: string };

export default function SignIn() {
  const { t, lang, setLang } = useI18n();
  const { signIn } = useAuth();
  const params = useLocalSearchParams<{ notStaff?: string }>();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [err, setErr] = useState<string | null>(params.notStaff ? t('auth.staffNotice') : null);
  const [busy, setBusy] = useState(false);
  const [, , promptGoogle] = Google.useIdTokenAuthRequest({ iosClientId: g.iosClientId, androidClientId: g.androidClientId, webClientId: g.webClientId });
  const field = APP_VARIANT === 'field';

  const done = async (tokens: any) => { await signIn(tokens); router.replace('/'); };
  const send = async () => {
    const e164 = toE164(phone, 'SA');
    if (!e164) { setErr(t('auth.invalidPhone')); return; }
    setBusy(true); setErr(null);
    try { await api('/auth/otp/request', { method: 'POST', body: { phone: e164 } }); setPhone(e164); setStep('code'); } catch (e) { setErr(e instanceof ApiError ? e.code : 'error'); } finally { setBusy(false); }
  };
  const verify = async () => {
    setBusy(true); setErr(null);
    try { await done(await api('/auth/otp/verify', { method: 'POST', body: { phone, code } })); } catch { setErr(t('auth.invalidCode')); } finally { setBusy(false); }
  };
  const google = async () => {
    const r = await promptGoogle();
    if (r.type === 'success' && r.params.id_token) await done(await api('/auth/oauth', { method: 'POST', body: { provider: 'google', idToken: r.params.id_token } }));
  };
  const apple = async () => {
    try {
      const cred = await AppleAuthentication.signInAsync({ requestedScopes: [AppleAuthentication.AppleAuthenticationScope.EMAIL] });
      if (cred.identityToken) await done(await api('/auth/oauth', { method: 'POST', body: { provider: 'apple', idToken: cred.identityToken } }));
    } catch (e: any) { if (e?.code !== 'ERR_REQUEST_CANCELED') setErr('apple_sign_in_failed'); }
  };

  return (
    <Screen>
      <Row style={{ justifyContent: 'flex-end' }}>
        <Chip label="العربية" selected={lang === 'ar'} onPress={() => setLang('ar')} />
        <Chip label="English" selected={lang === 'en'} onPress={() => setLang('en')} />
      </Row>
      <View style={{ marginTop: 40, gap: 8 }}>
        <T kind="heading" size="xxl">{t('app.name')}</T>
        <T size="lg">{t('app.tagline')}</T>
      </View>
      <Card>
        <T kind="heading" size="lg">{t('auth.title')}</T>
        {step === 'phone' ? (
          <>
            <Field label={t('auth.phone')} value={phone} onChangeText={setPhone} keyboardType="phone-pad" autoComplete="tel" textContentType="telephoneNumber" placeholder="+966 5x xxx xxxx" testID="phone" />
            <Button title={t('auth.sendCode')} onPress={send} loading={busy} disabled={phone.length < 8} />
          </>
        ) : (
          <>
            <Field label={t('auth.code')} value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={6} autoComplete="sms-otp" textContentType="oneTimeCode" testID="code" />
            <Button title={t('auth.verify')} onPress={verify} loading={busy} disabled={code.length !== 6} />
            <Button variant="secondary" title={t('common.back')} onPress={() => setStep('phone')} />
          </>
        )}
        {err && <T kind="bold" color="#9E1B1B" accessibilityLabel={err}>⚠ {err}</T>}
      </Card>
      {!field && (
        <View style={{ gap: 8 }}>
          <Button variant="secondary" title={t('auth.google')} onPress={google} />
          {/* Apple sign-in is required on iOS when Google is offered. */}
          {Platform.OS === 'ios' && <AppleAuthentication.AppleAuthenticationButton buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE} buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK} cornerRadius={10} style={{ height: 48 }} onPress={apple} />}
        </View>
      )}
      {field && <T size="sm">{t('auth.staffNotice')}</T>}
      <Row><Button variant="secondary" title={t('privacy.title')} onPress={() => router.push('/privacy')} /><Button variant="secondary" title={t('privacy.terms')} onPress={() => router.push('/privacy?doc=terms')} /></Row>
    </Screen>
  );
}
