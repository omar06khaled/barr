import type { Sql } from './pool';
import type { ChecklistTemplate } from '@barr/shared';

/** Reference data: plans, default prices (CONFIG — editable in dashboard), checklist templates. Idempotent. */
export async function seedReference(c: Sql) {
  const plans = [
    ['visit', 'Visit', 'زيارة', { coordinatorVisit: 'every_2_weeks', doctorVideoCall: 'monthly', refills: true, line247: true, app: true }],
    ['plus', 'Plus', 'بلس', { includes: 'visit', nurseVisit: 'weekly', homeDoctorVisit: 'monthly', homeLabs: 'quarterly' }],
    ['caregiver', 'Caregiver', 'مرافق', { includes: 'plus', caregiver: 'day_or_live_in', supervision: 'weekly', pricing: 'per_family' }],
  ] as const;
  for (const [code, en, ar, inc] of plans) {
    await c.query(`insert into plans (code, name_en, name_ar, inclusions) values ($1,$2,$3,$4) on conflict (code) do nothing`, [code, en, ar, inc]);
  }
  // Default prices in minor units. USD per PRD; SAR/AED are placeholders until the owner sets final prices.
  const prices: [string, string, number][] = [
    ['visit', 'USD', 5900], ['visit', 'SAR', 22100], ['visit', 'AED', 21700],
    ['plus', 'USD', 14900], ['plus', 'SAR', 55900], ['plus', 'AED', 54700],
  ];
  for (const [p, cur, amt] of prices) await c.query(`insert into plan_prices (plan_code, currency, amount) values ($1,$2,$3) on conflict do nothing`, [p, cur, amt]);

  const t = (visitType: ChecklistTemplate['visitType'], observations: ChecklistTemplate['observations'], vitals: ChecklistTemplate['vitals'], tasks: ChecklistTemplate['tasks'], photos = true): ChecklistTemplate => ({ visitType, version: 1, observations, vitals, tasks, photos });
  const allObs: ChecklistTemplate['observations'] = ['mood', 'appetite', 'sleep', 'mobility', 'pain', 'skin', 'hydration', 'homeSafety', 'cognitionChange', 'fallsSinceLastVisit', 'medicineAdherence', 'socialContact'];
  const templates = [
    t('assessment', allObs, ['bp_systolic', 'bp_diastolic', 'pulse', 'glucose', 'temperature', 'spo2', 'weight'], [
      { code: 'consent_recorded', label_en: 'Consent recorded', label_ar: 'تسجيل الموافقة' },
      { code: 'home_safety_review', label_en: 'Home safety reviewed', label_ar: 'مراجعة سلامة المنزل' },
      { code: 'medicines_listed', label_en: 'Medicines listed', label_ar: 'تسجيل الأدوية' },
    ]),
    t('coordinator', ['mood', 'appetite', 'sleep', 'mobility', 'homeSafety', 'medicineAdherence', 'socialContact', 'fallsSinceLastVisit'], ['bp_systolic', 'bp_diastolic', 'pulse'], [
      { code: 'meds_stock_checked', label_en: 'Medicine stock checked', label_ar: 'مراجعة مخزون الأدوية' },
      { code: 'refills_ordered', label_en: 'Refills ordered', label_ar: 'طلب إعادة صرف الأدوية' },
    ]),
    t('nurse', ['mood', 'appetite', 'pain', 'skin', 'hydration', 'mobility', 'medicineAdherence', 'fallsSinceLastVisit'], ['bp_systolic', 'bp_diastolic', 'pulse', 'glucose', 'temperature', 'spo2'], [
      { code: 'meds_reviewed', label_en: 'Medicines reviewed', label_ar: 'مراجعة الأدوية' },
      { code: 'wound_care', label_en: 'Wound / skin care', label_ar: 'العناية بالجروح / الجلد' },
    ]),
    t('doctor', ['mood', 'pain', 'mobility', 'cognitionChange', 'medicineAdherence'], ['bp_systolic', 'bp_diastolic', 'pulse', 'glucose', 'temperature', 'spo2', 'weight'], [
      { code: 'examination', label_en: 'Examination done', label_ar: 'تم الفحص' },
      { code: 'plan_reviewed', label_en: 'Care plan reviewed', label_ar: 'مراجعة خطة الرعاية' },
    ]),
    t('caregiver_shift', ['mood', 'appetite', 'sleep', 'hydration', 'socialContact'], [], [
      { code: 'meals', label_en: 'Meals served', label_ar: 'تقديم الوجبات' },
      { code: 'hygiene', label_en: 'Personal hygiene', label_ar: 'العناية الشخصية' },
      { code: 'walk', label_en: 'Short walk / exercise', label_ar: 'مشي قصير / تمرين' },
    ], false),
  ];
  for (const tpl of templates) await c.query(`insert into checklist_templates (visit_type, version, definition) values ($1,1,$2) on conflict do nothing`, [tpl.visitType, tpl]);
}
