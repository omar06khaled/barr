import { View } from 'react-native';
import { useOutbox } from '../lib/outbox';
import { useI18n } from '../lib/i18n';
import { colors, statusStyles } from '../theme';
import { T, Button } from './ui';

/** Always shows whether captured work is safely synced. */
export function SyncBanner() {
  const { pending, online, problems, syncNow } = useOutbox();
  const { t } = useI18n();
  if (online && pending === 0 && problems.length === 0) return null;
  return (
    <View accessibilityLiveRegion="polite" style={{ padding: 12, borderRadius: 10, borderWidth: 2, borderStyle: 'dashed', borderColor: statusStyles.no_contact.border, backgroundColor: statusStyles.no_contact.bg, gap: 6 }}>
      {!online && <T kind="bold" color={statusStyles.no_contact.fg}>◷ {t('common.offline')}</T>}
      {pending > 0 && <T color={statusStyles.no_contact.fg}>{t('common.pendingSync', { count: pending })}</T>}
      {problems.map((p) => <T key={p.opId} color={colors.black}>⚠ {p.kind}: {p.lastError}</T>)}
      {online && pending > 0 && <Button variant="secondary" title={t('common.retry')} onPress={() => void syncNow()} />}
    </View>
  );
}
