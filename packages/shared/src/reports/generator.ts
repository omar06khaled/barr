import { translate, type Language } from '../i18n';
import type { Observations, VisitType } from '../schemas/visit';
import { assessVital, vitalUnits, type VitalKind } from '../domain/vitals';
import { defaultConfig } from '../config';

/**
 * PRD §9.3 ReportGenerator. V1 = deterministic templates. A future AI generator
 * implements the same interface; every stored report keeps `generator` + the full
 * structured input so outputs can be compared and audited without schema changes.
 */
export interface ReportGenerator<I, P = unknown> {
  readonly name: string; // e.g. "template_v1"
  generate(parentId: string, period: { from: string; to: string }, inputs: I): GeneratedReport<P>;
}
export interface GeneratedReport<P> { payload: P; text_ar: string; text_en: string; generator: string }

export interface VisitReportInput {
  parentName: string;
  staffName: string;
  visitType: VisitType;
  checkedInAt: string | null;
  checkedOutAt: string | null;
  observations: Observations;
  vitals: { kind: VitalKind; value: number }[];
  tasksDone: { code: string; label_en: string; label_ar: string }[];
  note: string;
  photoCount: number;
}

const fmtTime = (iso: string | null, lang: Language) =>
  iso ? new Intl.DateTimeFormat(lang === 'ar' ? 'ar-EG' : 'en-GB', { hour: '2-digit', minute: '2-digit', timeZone: defaultConfig.timezone }).format(new Date(iso)) : '—';

function obsLines(o: Observations, lang: Language): string[] {
  const t = (k: string, v?: Record<string, string | number>) => translate(lang, k, v);
  const yes = t('common.yes'), no = t('common.no');
  const L: string[] = [];
  if (o.mood !== undefined) L.push(`${t('obs.mood')}: ${o.mood}/5`);
  if (o.appetite) L.push(`${t('obs.appetite')}: ${t('obs.values.' + o.appetite)}`);
  if (o.sleep) L.push(`${t('obs.sleep')}: ${t('obs.values.' + o.sleep)}`);
  if (o.mobility) L.push(`${t('obs.mobility')}: ${t('obs.values.' + o.mobility)}`);
  if (o.pain) L.push(`${t('obs.pain')}: ${o.pain.score}/10${o.pain.score > 0 ? ` (${t('obs.painLoc.' + o.pain.location)})` : ''}`);
  if (o.skin) L.push(`${t('obs.skin')}: ${t('obs.values.' + o.skin)}`);
  if (o.hydration) L.push(`${t('obs.hydration')}: ${t('obs.values.' + o.hydration)}`);
  if (o.medicineAdherence) L.push(`${t('obs.medicineAdherence')}: ${t('obs.values.' + o.medicineAdherence)}`);
  if (o.cognitionChange !== undefined) L.push(`${t('obs.cognitionChange')}: ${o.cognitionChange ? yes : no}`);
  if (o.fallsSinceLastVisit !== undefined) L.push(`${t('obs.fallsSinceLastVisit')}: ${o.fallsSinceLastVisit}`);
  if (o.socialContact !== undefined) L.push(`${t('obs.socialContact')}: ${o.socialContact ? yes : no}`);
  if (o.homeSafety) {
    const bad = Object.entries(o.homeSafety).filter(([, ok]) => !ok).map(([k]) => t('obs.safety.' + k));
    L.push(`${t('obs.homeSafety')}: ${bad.length ? bad.join('، ') : t('obs.values.ok')}`);
  }
  return L;
}

export interface VisitReportPayload {
  visitType: VisitType;
  vitals: { kind: VitalKind; value: number; unit: string; outOfRange: boolean; critical: boolean }[];
  observations: Observations;
  flags: { outOfRangeVitals: boolean; criticalVitals: boolean; concerns: string[] };
  photoCount: number;
}

function renderVisit(i: VisitReportInput, payload: VisitReportPayload, lang: Language): string {
  const t = (k: string, v?: Record<string, string | number>) => translate(lang, k, v);
  const header = `${t('visitType.' + i.visitType)} — ${i.staffName}`;
  const times = `${t('timeline.arrived')} ${fmtTime(i.checkedInAt, lang)} · ${t('timeline.left')} ${fmtTime(i.checkedOutAt, lang)}`;
  const vit = payload.vitals.map((v) => `• ${t('vitals.' + v.kind)}: ${v.value} ${v.unit}${v.outOfRange ? ` — ${t('timeline.outOfRange')}` : ''}`);
  const obs = obsLines(i.observations, lang).map((l) => `• ${l}`);
  const tasks = i.tasksDone.map((x) => `• ${lang === 'ar' ? x.label_ar : x.label_en}`);
  const parts = [header, times];
  if (vit.length) parts.push(`${t('timeline.vitals')}:\n${vit.join('\n')}`);
  if (obs.length) parts.push(`${t('timeline.observations')}:\n${obs.join('\n')}`);
  if (tasks.length) parts.push(`${t('field.checklist')}:\n${tasks.join('\n')}`);
  if (i.note.trim()) parts.push(`${t('timeline.note')}: ${i.note.trim()}`);
  return parts.join('\n\n');
}

/** Template generator for visit reports (F6). Free-text notes are passed through as written (no translation in V1). */
export const templateVisitReportGenerator: ReportGenerator<VisitReportInput, VisitReportPayload> = {
  name: 'template_v1',
  generate(_parentId, _period, i) {
    const vitals = i.vitals.map((v) => {
      const a = assessVital(v.kind, v.value, defaultConfig.vitalsCritical);
      return { kind: v.kind, value: v.value, unit: vitalUnits[v.kind], outOfRange: a.outOfRange, critical: a.critical };
    });
    const concerns = Object.entries(i.observations)
      .filter(([k, v]) => v === 'concern' || (k === 'cognitionChange' && v === true) || (k === 'fallsSinceLastVisit' && typeof v === 'number' && v > 0) || (k === 'pain' && typeof v === 'object' && v && 'score' in v && (v as { score: number }).score >= 7))
      .map(([k]) => k);
    const payload: VisitReportPayload = {
      visitType: i.visitType,
      vitals,
      observations: i.observations,
      flags: { outOfRangeVitals: vitals.some((v) => v.outOfRange), criticalVitals: vitals.some((v) => v.critical), concerns },
      photoCount: i.photoCount,
    };
    return { payload, text_en: renderVisit(i, payload, 'en'), text_ar: renderVisit(i, payload, 'ar'), generator: 'template_v1' };
  },
};

export interface MonthlyReportInput {
  parentName: string;
  month: string; // YYYY-MM
  visitsPlanned: number;
  visitsCompleted: number;
  vitalsSeries: { kind: VitalKind; points: { at: string; value: number }[] }[];
  dosesDue: number;
  dosesConfirmed: number;
  escalations: number;
  concernsRaised: number;
  concernsResolved: number;
  carerChanges: number;
}
export interface MonthlyReportPayload extends MonthlyReportInput { adherence: number | null; completionRate: number | null; vitalsSummary: { kind: VitalKind; min: number; max: number; avg: number; n: number }[] }

const pct = (x: number | null, lang: Language) => (x == null ? '—' : new Intl.NumberFormat(lang === 'ar' ? 'ar-EG' : 'en-US', { style: 'percent' }).format(x));

export const templateMonthlyReportGenerator: ReportGenerator<MonthlyReportInput, MonthlyReportPayload> = {
  name: 'template_v1',
  generate(_parentId, _period, i) {
    const vitalsSummary = i.vitalsSeries.filter((s) => s.points.length).map((s) => {
      const v = s.points.map((p) => p.value);
      return { kind: s.kind, min: Math.min(...v), max: Math.max(...v), avg: Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10, n: v.length };
    });
    const payload: MonthlyReportPayload = {
      ...i,
      adherence: i.dosesDue ? i.dosesConfirmed / i.dosesDue : null,
      completionRate: i.visitsPlanned ? i.visitsCompleted / i.visitsPlanned : null,
      vitalsSummary,
    };
    const render = (lang: Language) => {
      const ar = lang === 'ar';
      const lines = [
        ar ? `التقرير الشهري — ${i.parentName} — ${i.month}` : `Monthly report — ${i.parentName} — ${i.month}`,
        ar ? `الزيارات: ${i.visitsCompleted} من ${i.visitsPlanned} (${pct(payload.completionRate, lang)})` : `Visits: ${i.visitsCompleted} of ${i.visitsPlanned} (${pct(payload.completionRate, lang)})`,
        ar ? `الالتزام بالأدوية: ${pct(payload.adherence, lang)}` : `Medicine adherence: ${pct(payload.adherence, lang)}`,
        ...vitalsSummary.map((s) => `${translate(lang, 'vitals.' + s.kind)}: ${ar ? 'متوسط' : 'avg'} ${s.avg} (${s.min}–${s.max}) ${vitalUnits[s.kind]}`),
        ar ? `حالات التصعيد: ${i.escalations}` : `Escalations: ${i.escalations}`,
        ar ? `الملاحظات: ${i.concernsRaised} (تم حل ${i.concernsResolved})` : `Concerns: ${i.concernsRaised} (${i.concernsResolved} resolved)`,
        ar ? `تغييرات مقدمي الرعاية: ${i.carerChanges}` : `Carer changes: ${i.carerChanges}`,
      ];
      return lines.join('\n');
    };
    return { payload, text_en: render('en'), text_ar: render('ar'), generator: 'template_v1' };
  },
};
