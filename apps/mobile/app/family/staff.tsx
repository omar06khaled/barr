import { Image } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useI18n } from '../../src/lib/i18n';
import { useQuery } from '../../src/lib/useQuery';
import { Card, Screen, T } from '../../src/components/ui';

const LABEL: Record<string, string> = { id_checked: 'staff.idChecked', background_check: 'staff.background', reference_check: 'staff.reference', training: 'staff.training' };

/** F4: verified staff profile. No phone or ID numbers are ever shown to families. */
export default function StaffProfile() {
  const { t, lang } = useI18n();
  const { parentId, staffId } = useLocalSearchParams<{ parentId: string; staffId: string }>();
  const p = useQuery<any>(`/parents/${parentId}/staff/${staffId}`);
  if (!p.data) return <Screen><T>{t('common.loading')}</T></Screen>;
  const s = p.data;
  return (
    <Screen>
      {s.photoUrl && <Image source={{ uri: s.photoUrl }} style={{ width: 120, height: 120, borderRadius: 60, alignSelf: 'center' }} accessibilityLabel={s.firstName} />}
      <T kind="heading" size="xl" style={{ textAlign: 'center' }}>{s.firstName}</T>
      <T style={{ textAlign: 'center' }}>{s.role} · {s.languages.join(', ')}</T>
      <Card>
        <T kind="bold">{s.verified ? `✓ ${t('staff.verified')}` : '—'}</T>
        {s.verification.map((v: any) => <T key={v.item}>✓ {t(LABEL[v.item]!)} — {new Date(v.completed_on).toLocaleDateString(lang === 'ar' ? 'ar-EG' : 'en-GB')}</T>)}
        <T>{t('staff.visitsWithFamily', { count: s.visitsWithFamily })}</T>
      </Card>
    </Screen>
  );
}
