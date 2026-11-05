/** Operations-dashboard strings (both languages). */
export const dashboardStrings = {
  en: {
    nav: { today: 'Today', families: 'Families', schedule: 'Schedule', staff: 'Staff', payments: 'Payments', helpline: 'Help line', settings: 'Settings', audit: 'Audit log', jobs: 'Jobs', metrics: 'Metrics' },
    login: { title: 'Barr operations', phone: 'Staff mobile number', send: 'Send code', code: 'Code', verify: 'Sign in', staffOnly: 'Staff only. Accounts are created by an admin.' },
    today: {
      openEscalations: 'Open escalations', none: 'None right now', age: 'Age', overdueConcerns: 'Concerns (overdue first)', missedDoses: 'Missed doses today', noContact: 'No contact today',
      visits: 'Visits today', onCall: 'On call now', tasks: 'Open tasks', ack: 'Acknowledge', decide: 'Record decision', close: 'Close', closeNote: 'Closing note (required)', followUp: 'Add follow-up', familyTold: 'Family told', notYet: 'not yet',
      overdue: 'Overdue', safety: 'Safety', due: 'Due', status: 'Status', parent: 'Parent', urgent: 'Urgent', nonUrgent: 'Non-urgent',
    },
    families: { search: 'Search name or area', plan: 'Plan', payment: 'Payment', pod: 'Pod', churn: 'Churn risk', members: 'Members', status: 'Status', open: 'Open' },
    family: { parent: 'Parent', members: 'Family members', subscription: 'Subscription', visits: 'Recent visits', meds: 'Medicines', escalations: 'Escalations', concerns: 'Concerns', carePlans: 'Care plans', consents: 'Consent', careTeam: 'Care team', address: 'Address', phone: 'Phone', publishPlan: 'Publish care plan (JSON)', customPrice: 'Set price', addVisit: 'Schedule visit', resolve: 'Resolve', resolution: 'Resolution note' },
    schedule: { date: 'Date', staff: 'Staff', unassigned: 'Unassigned', reassign: 'Reassign', route: 'Route by neighbourhood', override: 'Override check-in', reason: 'Reason' },
    staff: { add: 'Add staff member', role: 'Role', verified: 'Verified', notVerified: 'Not verified — cannot be assigned', deactivate: 'Offboard (revoke sessions now)', perf: 'Last 30 days', onTime: 'On time', completion: 'Completion', reportDelay: 'Report delay', rota: 'On-call rota', addShift: 'Add shift' },
    payments: { subscriptions: 'Subscriptions', failures: 'Failures and retries', recent: 'Recent payments', passThrough: 'Pass-through charges (at cost)', refunds: 'Refunds', revenue: 'Revenue (31 days) by currency', refund: 'Refund', amount: 'Amount (minor units)', reason: 'Reason' },
    helpline: { log: 'Log a call', caller: 'Caller name', summary: 'What happened', parent: 'Parent', convert: 'Convert to escalation now', recent: 'Recent calls', escalate: 'Escalate' },
    settings: { config: 'CONFIG values', prices: 'Plan prices', templates: 'Notification templates', checklists: 'Checklist templates', cities: 'Cities and pods', save: 'Save' },
    common: { loading: 'Loading…', error: 'Something went wrong', save: 'Save', cancel: 'Cancel', signOut: 'Sign out', language: 'العربية', refresh: 'Refresh', yes: 'Yes', no: 'No', retry: 'Retry' },
  },
  ar: {
    nav: { today: 'اليوم', families: 'العائلات', schedule: 'الجدول', staff: 'الفريق', payments: 'المدفوعات', helpline: 'خط المساعدة', settings: 'الإعدادات', audit: 'سجل التدقيق', jobs: 'المهام الآلية', metrics: 'المؤشرات' },
    login: { title: 'عمليات بر', phone: 'رقم جوال الموظف', send: 'إرسال الرمز', code: 'الرمز', verify: 'دخول', staffOnly: 'للفريق فقط. الحسابات يُنشئها المسؤول.' },
    today: {
      openEscalations: 'حالات التصعيد المفتوحة', none: 'لا يوجد الآن', age: 'المدة', overdueConcerns: 'الملاحظات (المتأخرة أولًا)', missedDoses: 'جرعات فائتة اليوم', noContact: 'بدون تواصل اليوم',
      visits: 'زيارات اليوم', onCall: 'المناوب الآن', tasks: 'المهام المفتوحة', ack: 'استجابة', decide: 'تسجيل القرار', close: 'إغلاق', closeNote: 'ملاحظة الإغلاق (مطلوبة)', followUp: 'إضافة متابعة', familyTold: 'تم إبلاغ العائلة', notYet: 'ليس بعد',
      overdue: 'متأخرة', safety: 'سلامة', due: 'الموعد', status: 'الحالة', parent: 'الوالد/ة', urgent: 'عاجل', nonUrgent: 'غير عاجل',
    },
    families: { search: 'ابحث بالاسم أو المنطقة', plan: 'الباقة', payment: 'الدفع', pod: 'المجموعة', churn: 'خطر الانسحاب', members: 'الأفراد', status: 'الحالة', open: 'فتح' },
    family: { parent: 'الوالد/ة', members: 'أفراد العائلة', subscription: 'الاشتراك', visits: 'الزيارات الأخيرة', meds: 'الأدوية', escalations: 'التصعيد', concerns: 'الملاحظات', carePlans: 'خطط الرعاية', consents: 'الموافقات', careTeam: 'فريق الرعاية', address: 'العنوان', phone: 'الهاتف', publishPlan: 'نشر خطة الرعاية (JSON)', customPrice: 'تحديد السعر', addVisit: 'جدولة زيارة', resolve: 'حل', resolution: 'ملاحظة الحل' },
    schedule: { date: 'التاريخ', staff: 'الموظف', unassigned: 'غير مُسند', reassign: 'إعادة الإسناد', route: 'المسار حسب الحي', override: 'استثناء تسجيل الوصول', reason: 'السبب' },
    staff: { add: 'إضافة موظف', role: 'الدور', verified: 'موثّق', notVerified: 'غير موثّق — لا يمكن إسناده', deactivate: 'إنهاء الخدمة (إلغاء الجلسات فورًا)', perf: 'آخر 30 يومًا', onTime: 'في الموعد', completion: 'الإنجاز', reportDelay: 'تأخر التقرير', rota: 'جدول المناوبة', addShift: 'إضافة مناوبة' },
    payments: { subscriptions: 'الاشتراكات', failures: 'الإخفاقات وإعادة المحاولة', recent: 'المدفوعات الأخيرة', passThrough: 'التكاليف المحوّلة (بسعر التكلفة)', refunds: 'المبالغ المستردة', revenue: 'الإيرادات (31 يومًا) حسب العملة', refund: 'استرداد', amount: 'المبلغ (بالوحدة الصغرى)', reason: 'السبب' },
    helpline: { log: 'تسجيل مكالمة', caller: 'اسم المتصل', summary: 'ماذا حدث', parent: 'الوالد/ة', convert: 'تحويل إلى تصعيد الآن', recent: 'المكالمات الأخيرة', escalate: 'تصعيد' },
    settings: { config: 'قيم الإعدادات', prices: 'أسعار الباقات', templates: 'قوالب الإشعارات', checklists: 'قوالب قوائم المهام', cities: 'المدن والمجموعات', save: 'حفظ' },
    common: { loading: 'جارٍ التحميل…', error: 'حدث خطأ', save: 'حفظ', cancel: 'إلغاء', signOut: 'خروج', language: 'English', refresh: 'تحديث', yes: 'نعم', no: 'لا', retry: 'إعادة' },
  },
} as const;
export type DashboardStrings = (typeof dashboardStrings)['en'];
