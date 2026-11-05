import { useState } from 'react';
import { Switch } from 'react-native';
import { router } from 'expo-router';
import * as Location from 'expo-location';
import { api, ApiError } from '../../src/lib/api';
import { useI18n } from '../../src/lib/i18n';
import { Button, Card, Chip, Field, Row, Screen, T } from '../../src/components/ui';

/** F1 step 1: parent profile. Every edit is audited server-side. */
export default function AddParent() {
  const { t, lang } = useI18n();
  const [f, setF] = useState({ name: '', gender: 'female' as 'female' | 'male', address: '', neighborhood: '', lat: '', lng: '', phone: '', eName: '', ePhone: '', meds: '', allergiesHas: false, allergiesText: '', mobility: '', pref: 'same_as_parent', language: lang });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (v: any) => setF({ ...f, [k]: v });
  const locate = async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return;
    const p = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
    setF({ ...f, lat: p.coords.latitude.toFixed(6), lng: p.coords.longitude.toFixed(6) });
  };
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ id: string }>('/parents', { method: 'POST', body: {
        name: f.name, gender: f.gender, address: f.address, neighborhood: f.neighborhood || undefined, location: { lat: Number(f.lat), lng: Number(f.lng) }, language: f.language,
        phone: f.phone || undefined, carerGenderPreference: f.pref, emergencyContacts: f.eName ? [{ name: f.eName, phone: f.ePhone, relation: 'emergency' }] : [],
        knownMedicines: f.meds.split(/[,،]/).map((x) => x.trim()).filter(Boolean), allergies: { has: f.allergiesHas, text: f.allergiesText }, mobilityNotes: f.mobility,
      } });
      router.replace({ pathname: '/family/plan', params: { parentId: r.id, onboarding: '1' } });
    } catch (e) { setErr(e instanceof ApiError ? `${e.code} ${e.details ? JSON.stringify(e.details.fieldErrors ?? '') : ''}` : 'error'); } finally { setBusy(false); }
  };
  const ok = f.name && f.address.length > 3 && f.lat && f.lng;
  return (
    <Screen>
      <T kind="heading" size="xl">{t('family.addParent').replace('+ ', '')}</T>
      <Card>
        <Field label={t('family.parentName')} value={f.name} onChangeText={set('name')} />
        <Row><Chip label={t('family.mother')} selected={f.gender === 'female'} onPress={() => set('gender')('female')} /><Chip label={t('family.father')} selected={f.gender === 'male'} onPress={() => set('gender')('male')} /></Row>
        <Field label={t('family.address')} value={f.address} onChangeText={set('address')} multiline />
        <Field label={t('family.neighborhood')} value={f.neighborhood} onChangeText={set('neighborhood')} />
        <T size="sm">{t('family.pinHelp')}</T>
        <Button variant="secondary" title={`📍 ${t('family.useMyLocation')}`} onPress={locate} />
        <Row><Field label={t('family.lat')} value={f.lat} onChangeText={set('lat')} keyboardType="numbers-and-punctuation" style={{ minWidth: 140 }} /><Field label={t('family.lng')} value={f.lng} onChangeText={set('lng')} keyboardType="numbers-and-punctuation" style={{ minWidth: 140 }} /></Row>
        <Field label={t('family.parentPhone')} value={f.phone} onChangeText={set('phone')} keyboardType="phone-pad" />
        <T kind="bold">{t('common.language')}</T>
        <Row><Chip label="العربية" selected={f.language === 'ar'} onPress={() => set('language')('ar')} /><Chip label="English" selected={f.language === 'en'} onPress={() => set('language')('en')} /></Row>
      </Card>
      <Card>
        <T kind="bold">{t('family.carerPref')}</T>
        <Row>{(['same_as_parent', 'female', 'male', 'any'] as const).map((p) => <Chip key={p} label={t(`family.${p === 'same_as_parent' ? 'sameAsParent' : p}`)} selected={f.pref === p} onPress={() => set('pref')(p)} />)}</Row>
        <T kind="bold">{t('family.emergency')}</T>
        <Field label={t('family.emergencyName')} value={f.eName} onChangeText={set('eName')} />
        <Field label={t('family.emergencyPhone')} value={f.ePhone} onChangeText={set('ePhone')} keyboardType="phone-pad" />
        <Field label={t('family.medicines')} value={f.meds} onChangeText={set('meds')} />
        <Row style={{ justifyContent: 'space-between' }}><T>{t('family.allergies')}</T><Switch accessibilityLabel={t('family.allergies')} value={f.allergiesHas} onValueChange={set('allergiesHas')} /></Row>
        {f.allergiesHas && <Field label={t('family.allergyText')} value={f.allergiesText} onChangeText={set('allergiesText')} maxLength={300} />}
        <Field label={t('family.mobility')} value={f.mobility} onChangeText={set('mobility')} maxLength={500} multiline />
      </Card>
      {err && <T kind="bold">⚠ {err}</T>}
      <Button title={t('common.continue')} onPress={save} disabled={!ok} loading={busy} />
    </Screen>
  );
}
