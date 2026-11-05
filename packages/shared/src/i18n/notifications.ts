/**
 * Notification templates (F17). Every type exists in both languages. These are
 * defaults: the dashboard can override them (stored in `notification_templates`).
 * WhatsApp templates must also be pre-approved by Meta with the same names/params.
 */
export const NOTIFICATION_TYPES = [
  'visit_report_ready', 'daily_status', 'missed_dose', 'escalation_created', 'escalation_update', 'escalation_family_15min',
  'escalation_page_staff', 'concern_update', 'payment_succeeded', 'payment_failed', 'payment_paused', 'plan_changed_by_sibling',
  'monthly_report', 'chat_message', 'invite', 'no_show', 'visit_reminder', 'daily_route', 'otp',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Types the user cannot turn off. */
export const CRITICAL_TYPES: NotificationType[] = ['escalation_created', 'escalation_update', 'escalation_family_15min', 'escalation_page_staff', 'otp', 'payment_paused'];

type T = { en: string; ar: string };
export const notificationTemplates: Record<NotificationType, T> = {
  visit_report_ready: { en: '{{staff}} visited {{parent}} today. The visit report is ready in the Barr app.', ar: 'زار/ت {{staff}} {{parent}} اليوم. تقرير الزيارة جاهز في تطبيق بر.' },
  daily_status: { en: 'Today for {{parent}}: {{status}}.', ar: 'اليوم بالنسبة لـ {{parent}}: {{status}}.' },
  missed_dose: { en: '{{parent}} has not confirmed {{medicine}} due at {{time}}. Your coordinator is following up.', ar: 'لم يتم تأكيد تناول {{parent}} لدواء {{medicine}} المقرر الساعة {{time}}. المنسق يتابع الأمر.' },
  escalation_created: { en: 'We have received a request for help for {{parent}}. Our on-call doctor is being contacted now.', ar: 'استلمنا طلب مساعدة لـ {{parent}}. يتم التواصل مع الطبيب المناوب الآن.' },
  escalation_update: { en: 'Update for {{parent}}: {{update}}', ar: 'تحديث بخصوص {{parent}}: {{update}}' },
  escalation_family_15min: { en: 'About {{parent}}: our team is handling an alert that started at {{time}}. Current status: {{status}}. We will keep you updated.', ar: 'بخصوص {{parent}}: فريقنا يتعامل مع تنبيه بدأ الساعة {{time}}. الحالة الحالية: {{status}}. سنوافيك بالتحديثات.' },
  escalation_page_staff: { en: 'URGENT escalation for {{parent}} ({{trigger}}). Open the Barr field app to acknowledge.', ar: 'تصعيد عاجل لـ {{parent}} ({{trigger}}). افتح تطبيق بر للفريق للاستجابة.' },
  concern_update: { en: 'Your concern {{ref}} is now: {{status}}.', ar: 'حالة ملاحظتك {{ref}} الآن: {{status}}.' },
  payment_succeeded: { en: 'Payment received: {{amount}} for {{parent}}’s {{plan}} plan. Thank you.', ar: 'تم استلام الدفع: {{amount}} لباقة {{plan}} الخاصة بـ {{parent}}. شكرًا لك.' },
  payment_failed: { en: 'We could not take payment of {{amount}} for {{parent}}’s plan. We will try again on {{date}}. You can update your card in the app.', ar: 'تعذر تحصيل مبلغ {{amount}} لباقة {{parent}}. سنحاول مرة أخرى بتاريخ {{date}}. يمكنك تحديث بطاقتك من التطبيق.' },
  payment_paused: { en: 'Service for {{parent}} is paused because payment failed. Update your card in the app to resume. Your coordinator will contact you.', ar: 'تم إيقاف الخدمة مؤقتًا لـ {{parent}} بسبب تعذر الدفع. حدّث بطاقتك من التطبيق للاستئناف. سيتواصل معك المنسق.' },
  plan_changed_by_sibling: { en: '{{actor}} {{change}}.', ar: '{{actor}} {{change}}.' },
  monthly_report: { en: 'The monthly report for {{parent}} ({{month}}) is ready: {{link}}', ar: 'التقرير الشهري لـ {{parent}} ({{month}}) جاهز: {{link}}' },
  chat_message: { en: 'New message from {{sender}} about {{parent}}: {{preview}}', ar: 'رسالة جديدة من {{sender}} بخصوص {{parent}}: {{preview}}' },
  invite: { en: '{{actor}} invited you to follow {{parent}}’s care on Barr. Download the app and sign in with this number. Expires in 7 days.', ar: 'دعاك {{actor}} لمتابعة رعاية {{parent}} على بر. حمّل التطبيق وسجّل الدخول بهذا الرقم. تنتهي الدعوة خلال 7 أيام.' },
  no_show: { en: 'The {{visitType}} planned for {{parent}} at {{time}} did not start on time. Your coordinator is arranging it.', ar: '{{visitType}} المقررة لـ {{parent}} الساعة {{time}} لم تبدأ في موعدها. المنسق يرتب الأمر.' },
  visit_reminder: { en: 'Reminder: {{visitType}} with {{parent}} at {{time}}.', ar: 'تذكير: {{visitType}} مع {{parent}} الساعة {{time}}.' },
  daily_route: { en: 'Your route today: {{count}} visits in {{areas}}.', ar: 'مسارك اليوم: {{count}} زيارات في {{areas}}.' },
  otp: { en: 'Your Barr code is {{code}}. It expires in 10 minutes.', ar: 'رمز بر الخاص بك هو {{code}}. تنتهي صلاحيته خلال 10 دقائق.' },
};

export function renderTemplate(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => (vars[k] !== undefined ? String(vars[k]) : `{{${k}}}`));
}
