import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps, type TextStyle, type ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { DailyStatusCode } from '@barr/shared';
import { colors, fontFamily, fontSize, minTouchTarget, radius, spacing, statusStyles } from '../theme';
import { useI18n } from '../lib/i18n';

/** Text respects dynamic type (allowFontScaling) and switches font family for Arabic. */
export function T({ children, kind = 'body', style, size = 'md', color, ...rest }: { children: ReactNode; kind?: 'heading' | 'body' | 'bold'; size?: keyof typeof fontSize; style?: TextStyle; color?: string; accessibilityLabel?: string; numberOfLines?: number }) {
  const { lang } = useI18n();
  return <Text allowFontScaling maxFontSizeMultiplier={2} style={[{ fontFamily: fontFamily(lang, kind), fontSize: fontSize[size], color: color ?? (kind === 'heading' ? colors.green900 : colors.inkBody), textAlign: 'auto', writingDirection: lang === 'ar' ? 'rtl' : 'ltr' }, style]} {...rest}>{children}</Text>;
}

export function Screen({ children, scroll = true, style }: { children: ReactNode; scroll?: boolean; style?: ViewStyle }) {
  const body = <View style={[{ padding: spacing.lg, gap: spacing.md }, style]}>{children}</View>;
  return <SafeAreaView style={{ flex: 1, backgroundColor: colors.paper }} edges={['top', 'left', 'right']}>{scroll ? <ScrollView contentContainerStyle={{ paddingBottom: 48 }}>{body}</ScrollView> : body}</SafeAreaView>;
}

export function Card({ children, style, tone = 'white' }: { children: ReactNode; style?: ViewStyle; tone?: 'white' | 'sand' | 'dark' }) {
  return <View style={[styles.card, tone === 'sand' && { backgroundColor: colors.sand }, tone === 'dark' && { backgroundColor: colors.green900, borderColor: colors.green900 }, style]}>{children}</View>;
}

export function Button({ title, onPress, variant = 'primary', disabled, loading, accessibilityHint, style }: { title: string; onPress: () => void; variant?: 'primary' | 'secondary' | 'danger' | 'help'; disabled?: boolean; loading?: boolean; accessibilityHint?: string; style?: ViewStyle }) {
  const bg = { primary: colors.green900, secondary: 'transparent', danger: statusStyles.alert.bg, help: statusStyles.alert.bg }[variant];
  const fg = variant === 'secondary' ? colors.green900 : colors.white;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityHint={accessibilityHint} accessibilityState={{ disabled: !!disabled || !!loading }} disabled={disabled || loading} onPress={onPress}
      style={({ pressed }) => [styles.button, { backgroundColor: bg, borderColor: variant === 'secondary' ? colors.green900 : bg, opacity: disabled ? 0.5 : pressed ? 0.85 : 1 }, variant === 'help' && { minHeight: 64 }, style]}>
      {loading ? <ActivityIndicator color={fg} /> : <T kind="bold" size={variant === 'help' ? 'lg' : 'md'} color={fg}>{title}</T>}
    </Pressable>
  );
}

/** F3 status: icon + label + distinct fill; never colour alone. */
export function StatusPill({ status, large }: { status: DailyStatusCode; large?: boolean }) {
  const { t } = useI18n();
  const s = statusStyles[status];
  const label = t(`status.${status}`);
  return (
    <View accessible accessibilityRole="text" accessibilityLabel={label} style={[styles.pill, { backgroundColor: s.bg, borderColor: s.border, borderStyle: s.fill === 'outlined' ? 'dashed' : 'solid' }, large && { paddingVertical: 10, paddingHorizontal: 16 }]}>
      <T kind="bold" size={large ? 'lg' : 'sm'} color={s.fg}>{s.icon}  {label}</T>
    </View>
  );
}

export function Field(props: TextInputProps & { label: string }) {
  const { lang } = useI18n();
  return (
    <View style={{ gap: 4 }}>
      <T size="sm" kind="bold">{props.label}</T>
      <TextInput accessibilityLabel={props.label} placeholderTextColor="#7B837F" {...props} style={[styles.input, { fontFamily: fontFamily(lang, 'body'), textAlign: lang === 'ar' && props.keyboardType !== 'phone-pad' && props.keyboardType !== 'number-pad' ? 'right' : 'left' }, props.style]} />
    </View>
  );
}

export function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress} style={[styles.chip, selected && { backgroundColor: colors.green900, borderColor: colors.green900 }]}>
      <T kind={selected ? 'bold' : 'body'} size="sm" color={selected ? colors.white : colors.green900}>{selected ? '✓ ' : ''}{label}</T>
    </Pressable>
  );
}

export function Row({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' }, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.white, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: spacing.lg, gap: spacing.sm },
  button: { minHeight: minTouchTarget, minWidth: minTouchTarget, borderRadius: radius.md, borderWidth: 2, paddingHorizontal: spacing.lg, alignItems: 'center', justifyContent: 'center' },
  pill: { alignSelf: 'flex-start', borderWidth: 2, borderRadius: radius.pill, paddingVertical: 4, paddingHorizontal: 12 },
  input: { minHeight: minTouchTarget, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.white, paddingHorizontal: spacing.md, fontSize: fontSize.md, color: colors.inkBody },
  chip: { minHeight: minTouchTarget, borderWidth: 2, borderColor: colors.border, borderRadius: radius.pill, paddingHorizontal: spacing.md, justifyContent: 'center' },
});
