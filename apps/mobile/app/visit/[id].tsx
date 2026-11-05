import { useEffect, useState } from 'react';
import { Alert, Image, Linking, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import * as Location from 'expo-location';
import * as ImagePicker from 'expo-image-picker';
import Constants from 'expo-constants';
import {
  assessVital, checkInDecision, defaultConfig, HOME_SAFETY_ITEMS, type ChecklistTemplate, type Observations, type VitalKind,
} from '@barr/shared';
import { api, ApiError } from '../../src/lib/api';
import { cache, capture, compressPhoto } from '../../src/lib/outbox';
import { useI18n } from '../../src/lib/i18n';
import { Button, Card, Chip, Field, Row, Screen, T } from '../../src/components/ui';
import { SyncBanner } from '../../src/components/SyncBanner';
import { colors, statusStyles } from '../../src/theme';

interface Pkg {
  visit: { id: string; type: string; status: string; scheduledAt: string; checkedInAt: string | null; overrideActive: boolean };
  parent: { id: string; name: string; address: string; neighborhood: string; location: { lat: number; lng: number }; allergies: { has: boolean; text: string }; mobilityNotes: string; emergencyContacts: { name: string; phone: string }[] };
  template: ChecklistTemplate | null;
  consent: Record<string, boolean>;
  doses: { id: string; scheduled_at: string; status: string; name: string }[];
  checkInRadiusM: number;
  maxPhotos: number;
}
interface LocalState { checkedInAt: string | null; obs: Observations; vitals: Partial<Record<VitalKind, string>>; tasks: string[]; note: string; photos: string[]; doses: Record<string, 'confirmed' | 'skipped'>; submitted: boolean }
const empty: LocalState = { checkedInAt: null, obs: {}, vitals: {}, tasks: [], note: '', photos: [], doses: {}, submitted: false };
const HELP_LINE = ((Constants.expoConfig?.extra as any)?.helpLine as string | undefined) ?? '';

export default function Visit() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, lang } = useI18n();
  const [pkg, setPkg] = useState<Pkg | null>(null);
  const [st, setSt] = useState<LocalState>(empty);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Cache-first: works with no signal if the package was pre-fetched on the Today screen.
  useEffect(() => {
    (async () => {
      const cached = await cache.get<Pkg>(`visit:${id}`);
      if (cached) setPkg(cached);
      const saved = await cache.get<LocalState>(`visitState:${id}`);
      if (saved) setSt(saved);
      try { const fresh = await api<Pkg>(`/field/visits/${id}`); setPkg(fresh); await cache.set(`visit:${id}`, fresh); } catch { /* offline: use cache */ }
    })();
  }, [id]);
  // Persist in-progress work so an app restart mid-visit loses nothing.
  const update = (patch: Partial<LocalState>) => setSt((s) => { const n = { ...s, ...patch }; void cache.set(`visitState:${id}`, n); return n; });

  if (!pkg) return <Screen><T>{t('common.loading')}</T></Screen>;
  const tpl = pkg.template;
  const photosAllowed = !!tpl?.photos && pkg.consent.photos === true;
  const checkedIn = st.checkedInAt ?? pkg.visit.checkedInAt;

  const checkIn = async () => {
    setBusy(true); setMsg(null);
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      let loc: { lat: number; lng: number; accuracyM?: number } | null = null;
      if (perm.status === 'granted') {
        const p = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
        loc = { lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: p.coords.accuracy ?? undefined };
      }
      // Immediate, clear feedback; the server re-checks (and is authoritative).
      const d = checkInDecision({ staff: loc, home: pkg.parent.location, radiusM: pkg.checkInRadiusM, adminOverrideReason: pkg.visit.overrideActive ? 'override' : null });
      if (!d.allowed) { setMsg(d.reason === 'no_location' ? t('field.noLocation') : t('field.tooFar', { distance: Math.round(d.distanceM), radius: pkg.checkInRadiusM })); return; }
      const at = new Date().toISOString();
      await capture('check_in', { visitId: id, capturedAt: at, location: loc, offline: false });
      update({ checkedInAt: at });
    } finally { setBusy(false); }
  };

  const addPhoto = async () => {
    if (st.photos.length >= Math.min(pkg.maxPhotos, defaultConfig.maxPhotosPerVisit)) return;
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return;
    const r = await ImagePicker.launchCameraAsync({ quality: 0.8 });
    if (r.canceled || !r.assets[0]) return;
    update({ photos: [...st.photos, await compressPhoto(r.assets[0].uri)] });
  };

  const assessed = (tpl?.vitals ?? []).map((k) => ({ kind: k, raw: st.vitals[k] ?? '', a: st.vitals[k] ? assessVital(k, Number(st.vitals[k]), defaultConfig.vitalsCritical) : null }));
  const invalid = assessed.some((x) => x.a && !x.a.plausible);

  const submit = async () => {
    setBusy(true);
    try {
      const now = new Date().toISOString();
      for (const [doseId, status] of Object.entries(st.doses)) {
        await capture('dose_confirm', { doseId, status, capturedAt: now, method: pkg.visit.type === 'caregiver_shift' ? 'caregiver' : 'nurse', note: status === 'skipped' ? st.note || 'skipped during visit' : undefined });
      }
      await capture('report', {
        visitId: id, submittedAt: now, offline: false, observations: st.obs,
        vitals: assessed.filter((x) => x.a).map((x) => ({ kind: x.kind, value: Number(x.raw), recordedAt: now })),
        tasksDone: st.tasks, note: st.note, photoKeys: [],
      }, st.photos.map((localUri) => ({ localUri })));
      await capture('check_out', { visitId: id, capturedAt: now, location: null, offline: false });
      update({ submitted: true });
      router.back();
    } finally { setBusy(false); }
  };

  const escalate = async () => {
    try {
      await api('/escalations', { method: 'POST', body: { parentId: pkg.parent.id, severity: 'urgent', note: st.note || undefined } });
      Alert.alert(t('field.escalate'), t('help.sent'));
    } catch (e) {
      if (e instanceof ApiError && e.code === 'network' && HELP_LINE) {
        Alert.alert(t('common.offline'), HELP_LINE, [{ text: t('common.cancel'), style: 'cancel' }, { text: '📞', onPress: () => Linking.openURL(`tel:${HELP_LINE}`) }]);
      } else Alert.alert('⚠', e instanceof ApiError ? e.code : 'error');
    }
  };

  const o = st.obs;
  const setObs = (patch: Observations) => update({ obs: { ...o, ...patch } });
  const asked = (k: string) => tpl?.observations.includes(k as any);
  const tri = (k: 'appetite' | 'sleep') => asked(k) && (
    <View key={k}><T kind="bold">{t(`obs.${k}`)}</T><Row>{(['poor', 'normal', 'good'] as const).map((v) => <Chip key={v} label={t(`obs.values.${v}`)} selected={o[k] === v} onPress={() => setObs({ [k]: v })} />)}</Row></View>
  );
  const okc = (k: 'skin' | 'hydration' | 'medicineAdherence') => asked(k) && (
    <View key={k}><T kind="bold">{t(`obs.${k}`)}</T><Row>{(['ok', 'concern'] as const).map((v) => <Chip key={v} label={t(`obs.values.${v}`)} selected={o[k] === v} onPress={() => setObs({ [k]: v })} />)}</Row></View>
  );
  const yn = (k: 'cognitionChange' | 'socialContact') => asked(k) && (
    <View key={k}><T kind="bold">{t(`obs.${k}`)}</T><Row><Chip label={t('common.yes')} selected={o[k] === true} onPress={() => setObs({ [k]: true })} /><Chip label={t('common.no')} selected={o[k] === false} onPress={() => setObs({ [k]: false })} /></Row></View>
  );

  return (
    <Screen>
      <SyncBanner />
      <T kind="heading" size="xl">{pkg.parent.name}</T>
      <T>{t(`visitType.${pkg.visit.type}`)} · {pkg.parent.address}</T>
      {pkg.parent.allergies.has && <Card tone="sand"><T kind="bold" color={statusStyles.no_contact.fg}>⚠ {t('family.allergies')}: {pkg.parent.allergies.text}</T></Card>}
      {!!pkg.parent.mobilityNotes && <T size="sm">{t('family.mobility')}: {pkg.parent.mobilityNotes}</T>}

      {!checkedIn ? (
        <Card>
          <Button title={`📍 ${t('field.startVisit')}`} onPress={checkIn} loading={busy} />
          {msg && <T kind="bold" color={statusStyles.alert.bg}>⚠ {msg}</T>}
        </Card>
      ) : st.submitted ? (
        <Card><T kind="bold">✓ {t('common.synced')}</T></Card>
      ) : (
        <>
          <Card>
            <T kind="bold">✓ {t('timeline.arrived')} {new Date(checkedIn).toLocaleTimeString(lang === 'ar' ? 'ar-EG' : 'en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Cairo' })}</T>
            {!!tpl?.tasks.length && <><T kind="heading" size="lg">{t('field.checklist')}</T>
              <Row>{tpl.tasks.map((x) => <Chip key={x.code} label={lang === 'ar' ? x.label_ar : x.label_en} selected={st.tasks.includes(x.code)} onPress={() => update({ tasks: st.tasks.includes(x.code) ? st.tasks.filter((c) => c !== x.code) : [...st.tasks, x.code] })} />)}</Row></>}
          </Card>

          {!!tpl?.vitals.length && (
            <Card>
              <T kind="heading" size="lg">{t('timeline.vitals')}</T>
              {assessed.map(({ kind, raw, a }) => (
                <View key={kind} style={{ gap: 2 }}>
                  <Field label={t(`vitals.${kind}`)} value={raw} onChangeText={(v) => update({ vitals: { ...st.vitals, [kind]: v.replace(',', '.') } })} keyboardType="decimal-pad" />
                  {a && !a.plausible && <T kind="bold" color={statusStyles.alert.bg}>✗ {t('common.retry')} — {raw}?</T>}
                  {a?.critical ? <T kind="bold" color={statusStyles.alert.bg}>⚠ {t('timeline.outOfRange')} — {t('escalation.title')}</T> : a?.outOfRange ? <T kind="bold" color={statusStyles.no_contact.fg}>◷ {t('timeline.outOfRange')}</T> : null}
                </View>
              ))}
            </Card>
          )}

          <Card>
            <T kind="heading" size="lg">{t('timeline.observations')}</T>
            {asked('mood') && <View><T kind="bold">{t('obs.mood')}</T><Row>{[1, 2, 3, 4, 5].map((v) => <Chip key={v} label={String(v)} selected={o.mood === v} onPress={() => setObs({ mood: v })} />)}</Row></View>}
            {tri('appetite')}{tri('sleep')}
            {asked('mobility') && <View><T kind="bold">{t('obs.mobility')}</T><Row>{(['independent', 'with_aid', 'assisted', 'bedbound'] as const).map((v) => <Chip key={v} label={t(`obs.values.${v}`)} selected={o.mobility === v} onPress={() => setObs({ mobility: v })} />)}</Row></View>}
            {asked('pain') && <View><T kind="bold">{t('obs.pain')} (0–10)</T><Row>{[0, 2, 4, 6, 8, 10].map((v) => <Chip key={v} label={String(v)} selected={o.pain?.score === v} onPress={() => setObs({ pain: { score: v, location: o.pain?.location ?? 'none' } })} />)}</Row>
              {!!o.pain?.score && <Row>{(['head', 'chest', 'abdomen', 'back', 'joints', 'legs', 'other'] as const).map((l) => <Chip key={l} label={t(`obs.painLoc.${l}`)} selected={o.pain?.location === l} onPress={() => setObs({ pain: { score: o.pain!.score, location: l } })} />)}</Row>}</View>}
            {okc('skin')}{okc('hydration')}{okc('medicineAdherence')}
            {yn('cognitionChange')}{yn('socialContact')}
            {asked('fallsSinceLastVisit') && <View><T kind="bold">{t('obs.fallsSinceLastVisit')}</T><Row>{[0, 1, 2, 3].map((v) => <Chip key={v} label={v === 3 ? '3+' : String(v)} selected={o.fallsSinceLastVisit === v} onPress={() => setObs({ fallsSinceLastVisit: v })} />)}</Row></View>}
            {asked('homeSafety') && <View><T kind="bold">{t('obs.homeSafety')}</T><Row>{HOME_SAFETY_ITEMS.map((k) => <Chip key={k} label={t(`obs.safety.${k}`)} selected={o.homeSafety?.[k] === true} onPress={() => setObs({ homeSafety: { ...(o.homeSafety ?? {}), [k]: !(o.homeSafety?.[k] === true) } })} />)}</Row></View>}
          </Card>

          {!!pkg.doses.length && (
            <Card>
              <T kind="heading" size="lg">{t('doses.title')}</T>
              {pkg.doses.filter((d) => d.status !== 'confirmed').map((d) => (
                <Row key={d.id}>
                  <T>{new Date(d.scheduled_at).toLocaleTimeString(lang === 'ar' ? 'ar-EG' : 'en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Cairo' })} {d.name}</T>
                  <Chip label={`✓ ${t('doses.confirmed')}`} selected={st.doses[d.id] === 'confirmed'} onPress={() => update({ doses: { ...st.doses, [d.id]: 'confirmed' } })} />
                  <Chip label={t('doses.skipped')} selected={st.doses[d.id] === 'skipped'} onPress={() => update({ doses: { ...st.doses, [d.id]: 'skipped' } })} />
                </Row>
              ))}
            </Card>
          )}

          <Card>
            <T kind="heading" size="lg">{t('timeline.photos')}</T>
            {photosAllowed ? (
              <>
                <Row>{st.photos.map((u) => <Image key={u} source={{ uri: u }} style={{ width: 80, height: 80, borderRadius: 8 }} accessibilityLabel={t('timeline.photos')} />)}</Row>
                <Button variant="secondary" title={`📷 ${t('field.addPhoto')} (${st.photos.length}/${pkg.maxPhotos})`} onPress={addPhoto} disabled={st.photos.length >= pkg.maxPhotos} />
              </>
            ) : <T>{t('field.photoNoConsent')}</T>}
            <Field label={t('timeline.note')} value={st.note} onChangeText={(v) => update({ note: v })} multiline maxLength={2000} />
          </Card>

          <Button title={`✓ ${t('field.endVisit')}`} onPress={submit} disabled={invalid} loading={busy} />
        </>
      )}
      <Button variant="danger" title={`⚠ ${t('field.escalate')}`} onPress={escalate} />
      {pkg.parent.emergencyContacts.map((c) => <Button key={c.phone} variant="secondary" title={`📞 ${c.name}`} onPress={() => Linking.openURL(`tel:${c.phone}`)} />)}
      <View style={{ height: 1, backgroundColor: colors.border }} />
    </Screen>
  );
}
