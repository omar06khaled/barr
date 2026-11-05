import type { Dictionary } from './en';

export const ar: Dictionary = {
  app: { name: 'بر', tagline: 'رعاية لوالديك، ودليل كل يوم' },
  common: {
    continue: 'متابعة', cancel: 'إلغاء', save: 'حفظ', submit: 'إرسال', back: 'رجوع', loading: 'جارٍ التحميل…', retry: 'حاول مرة أخرى',
    offline: 'أنت غير متصل. ستتم مزامنة التغييرات عند عودة الاتصال.', synced: 'تمت مزامنة كل التغييرات', pendingSync: '{{count}} تغيير بانتظار المزامنة',
    language: 'اللغة', arabic: 'العربية', english: 'English', signOut: 'تسجيل الخروج', yes: 'نعم', no: 'لا', none: 'لا يوجد', today: 'اليوم',
  },
  auth: {
    title: 'تسجيل الدخول إلى بر', phone: 'رقم الجوال', sendCode: 'إرسال الرمز', code: 'رمز من 6 أرقام', verify: 'تحقق',
    google: 'المتابعة باستخدام Google', apple: 'المتابعة باستخدام Apple', invalidPhone: 'يرجى إدخال رقم جوال صحيح مع رمز الدولة.',
    invalidCode: 'الرمز غير صحيح أو انتهت صلاحيته.', staffNotice: 'حسابات الفريق تُنشأ من قبل بر. تواصل مع المسؤول إذا لم تتمكن من الدخول.',
  },
  status: {
    checked: 'تمت الاطمئنان اليوم', pending: 'لم يتم الاطمئنان بعد اليوم', no_contact: 'لا يوجد تواصل بعد', alert: 'تنبيه مفتوح',
    checked_desc: 'شخص من بر رأى {{name}} أو تحدث معه اليوم.',
    pending_desc: 'من المتوقع زيارة أو اطمئنان لاحقًا اليوم.',
    no_contact_desc: 'لم تُسجَّل أي زيارة أو اطمئنان اليوم. طُلب من المنسق المتابعة.',
    alert_desc: 'هناك حالة تصعيد مفتوحة وفريقنا يتعامل معها.',
  },
  timeline: {
    title: 'السجل', filters: { all: 'الكل', visits: 'الزيارات', medicines: 'الأدوية', alerts: 'التنبيهات', concerns: 'الملاحظات' },
    arrived: 'الوصول', left: 'المغادرة', duration: '{{min}} دقيقة', vitals: 'المؤشرات الحيوية', observations: 'الملاحظات', note: 'ملاحظة', photos: 'الصور', empty: 'لا يوجد شيء بعد.',
    outOfRange: 'خارج المعدل المعتاد',
  },
  visitType: { assessment: 'تقييم منزلي', coordinator: 'زيارة المنسق', nurse: 'زيارة تمريض', doctor: 'زيارة طبيب', caregiver_shift: 'نوبة مرافق' },
  vitals: { bp_systolic: 'ضغط الدم (الانقباضي)', bp_diastolic: 'ضغط الدم (الانبساطي)', pulse: 'النبض', glucose: 'سكر الدم', temperature: 'الحرارة', spo2: 'نسبة الأكسجين', weight: 'الوزن' },
  obs: {
    mood: 'المزاج', appetite: 'الشهية', sleep: 'النوم', mobility: 'الحركة', pain: 'الألم', skin: 'الجلد / مناطق الضغط', hydration: 'شرب السوائل',
    homeSafety: 'سلامة المنزل', cognitionChange: 'تغير في الذاكرة أو التفكير', fallsSinceLastVisit: 'السقوط منذ آخر زيارة',
    medicineAdherence: 'تناول الأدوية كما هو مخطط', socialContact: 'تواصل اجتماعي',
    values: {
      poor: 'ضعيف', normal: 'طبيعي', good: 'جيد', ok: 'جيد', concern: 'يحتاج انتباه', independent: 'مستقل', with_aid: 'بمساعدة أداة مشي',
      assisted: 'يحتاج مساعدة', bedbound: 'ملازم للفراش',
    },
    painLoc: { none: 'لا يوجد', head: 'الرأس', chest: 'الصدر', abdomen: 'البطن', back: 'الظهر', joints: 'المفاصل', legs: 'الساقين', other: 'أخرى' },
    safety: { rugs_secured: 'السجاد مثبت', lighting_ok: 'الإضاءة جيدة', bathroom_rails: 'مقابض الحمام', clear_walkways: 'الممرات خالية', gas_checked: 'تم فحص الغاز', emergency_numbers_visible: 'أرقام الطوارئ ظاهرة' },
  },
  doses: { title: 'أدوية اليوم', confirmed: 'تم تناوله', missed: 'فائت', scheduled: 'موعده', skipped: 'تم تخطيه' },
  help: { button: 'اطلب المساعدة الآن', confirm: 'سننبه الطبيب المناوب والمنسق فورًا. هل تريد المتابعة؟', sent: 'المساعدة في الطريق. ستظهر التحديثات هنا.' },
  escalation: {
    title: 'تصعيد', status: { open: 'تم الإبلاغ', acknowledged: 'الطبيب يستجيب', in_progress: 'قيد المعالجة', closed: 'مغلق' },
    decision: { phone_advice: 'تم تقديم نصيحة بالهاتف', nurse_dispatched: 'تم إرسال ممرض/ة إلى المنزل', ambulance_called: 'تم طلب الإسعاف', hospital_transfer: 'النقل إلى المستشفى' },
    costsNote: 'بر لا تدفع تكاليف المستشفى أو الإسعاف. أي تكلفة تدفعها بر نيابة عنك تظهر لك بسعر التكلفة.',
  },
  staff: { verified: 'موثّق', idChecked: 'تم التحقق من الهوية الوطنية', background: 'تم الفحص الأمني', reference: 'تم التحقق من المراجع', training: 'أكمل التدريب', visitsWithFamily: '{{count}} زيارة مع عائلتك' },
  plans: {
    visit: { name: 'زيارة', desc: 'زيارة منسق كل أسبوعين، مكالمة فيديو شهرية مع طبيب، تجديد الأدوية، خط 24/7، التطبيق' },
    plus: { name: 'بلس', desc: 'باقة زيارة + زيارة تمريض أسبوعية، زيارة طبيب منزلية شهرية، تحاليل منزلية كل 3 أشهر' },
    caregiver: { name: 'مرافق', desc: 'باقة بلس + مرافق نهاري أو مقيم بإشراف أسبوعي (السعر يُحدد لعائلتك)' },
    prepaid: 'يُدفع شهريًا مقدمًا. يمكنك الإلغاء في أي وقت؛ ويسري الإلغاء في نهاية الشهر المدفوع.',
    notInsurance: 'بر خدمة رعاية وليست تأمينًا. الأدوية والتحاليل والإسعاف تُحتسب بسعر التكلفة ومفصّلة.',
  },
  concerns: { title: 'الملاحظات والشكاوى', raise: 'أرسل ملاحظة', deadline: 'سنرد قبل {{time}}', status: { open: 'مفتوحة', in_progress: 'قيد المتابعة', resolved: 'تم الحل' }, reopen: 'إعادة فتح' },
  privacy: { title: 'سياسة الخصوصية', terms: 'شروط الخدمة', placeholder: 'سيتم توفير النص النهائي من بر. هذا نص مؤقت.', deleteAccount: 'حذف حسابي', deleteConfirm: 'سيؤدي هذا إلى حذف بياناتك الشخصية من بر. تُحفظ سجلات رعاية والدك/والدتك وفق سياسة الاحتفاظ. هل تريد المتابعة؟' },
  family: {
    addParent: '+ أضف والدك/والدتك', addAnother: '+ أضف والدًا آخر', carePlan: 'خطة الرعاية', careTeam: 'فريق الرعاية', planPayment: 'الباقة والدفع', chat: 'المحادثة', account: 'الحساب',
    parentName: 'اسم الوالد/ة', mother: 'الأم', father: 'الأب', address: 'عنوان المنزل', neighborhood: 'الحي', pinHelp: 'حدد موقع المنزل على الخريطة ليتمكن الفريق من تسجيل الوصول.', useMyLocation: 'استخدم موقعي الحالي (إذا كنت في المنزل)', lat: 'خط العرض', lng: 'خط الطول',
    parentPhone: 'هاتف الوالد/ة (اختياري)', emergency: 'جهة اتصال للطوارئ في مصر', emergencyName: 'الاسم', emergencyPhone: 'الهاتف', medicines: 'الأدوية المعروفة (افصل بفاصلة)', allergies: 'هل توجد حساسية؟', allergyText: 'تفاصيل الحساسية', mobility: 'ملاحظات الحركة',
    carerPref: 'تفضيل جنس مقدم الرعاية', sameAsParent: 'نفس جنس الوالد/ة (افتراضي)', female: 'أنثى', male: 'ذكر', any: 'أي',
    choosePlan: 'اختر الباقة', currency: 'العملة', payNow: 'ادفع بأمان', perMonth: '/ شهريًا', paid: 'تم الدفع. شكرًا لك!', bookAssessment: 'احجز التقييم المنزلي', noSlots: 'لا توجد مواعيد متاحة الآن — سيتصل بك المنسق.',
    booked: 'تم حجز التقييم', cancelPlan: 'إلغاء الباقة', cancelConfirm: 'يسري الإلغاء في نهاية الشهر المدفوع. هل تريد المتابعة؟', changePlan: 'تغيير الباقة من الشهر القادم', updateCard: 'تحديث البطاقة', card: 'البطاقة', invoices: 'الفواتير', downloadPdf: 'تنزيل PDF', status: 'الحالة', renews: 'التجديد',
    accept: 'أوافق على خطة الرعاية', accepted: 'تمت الموافقة', version: 'الإصدار', previous: 'الإصدارات السابقة', goals: 'الأهداف', included: 'يشمل', notIncluded: 'لا يشمل', visitsPlan: 'جدول الزيارات',
    requestReplacement: 'طلب استبدال', reason: 'السبب', current: 'حالي', inviteSibling: 'دعوة فرد من العائلة', invitePhone: 'رقم جواله', inviteSent: 'تم إرسال الدعوة. تنتهي خلال 7 أيام.', members: 'أفراد العائلة', whatsapp: 'استلام التحديثات عبر واتساب',
    category: 'الفئة', urgent: 'عاجل', details: 'التفاصيل', submitted: 'تم الإرسال. الرقم المرجعي {{ref}}.', message: 'رسالة', send: 'إرسال', monthly: 'التقارير الشهرية',
  },
  field: {
    todayVisits: 'زيارات اليوم', startVisit: 'بدء الزيارة (تسجيل الوصول)', endVisit: 'إنهاء الزيارة (تسجيل المغادرة)', tooFar: 'أنت على بعد {{distance}} م من المنزل. اقترب لمسافة {{radius}} م لتسجيل الوصول، أو اطلب استثناء من المسؤول.',
    noLocation: 'تعذر قراءة موقعك. فعّل الموقع لتسجيل الوصول.', escalate: 'تصعيد', checklist: 'قائمة المهام', addPhoto: 'إضافة صورة', photoNoConsent: 'الصور غير مفعلة لهذا الشخص (لا توجد موافقة).',
    route: 'المسار', neighborhood: 'الحي',
  },
};
