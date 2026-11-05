export const en = {
  app: { name: 'Barr', tagline: 'Care for your parent, proof every day' },
  common: {
    continue: 'Continue', cancel: 'Cancel', save: 'Save', submit: 'Submit', back: 'Back', loading: 'Loading…', retry: 'Try again',
    offline: 'You are offline. Changes will sync when you reconnect.', synced: 'All changes synced', pendingSync: '{{count}} change(s) waiting to sync',
    language: 'Language', arabic: 'العربية', english: 'English', signOut: 'Sign out', yes: 'Yes', no: 'No', none: 'None', today: 'Today',
  },
  auth: {
    title: 'Sign in to Barr', phone: 'Mobile number', sendCode: 'Send code', code: '6-digit code', verify: 'Verify',
    google: 'Continue with Google', apple: 'Continue with Apple', invalidPhone: 'Please enter a valid mobile number with country code.',
    invalidCode: 'That code is not right or has expired.', staffNotice: 'Staff accounts are created by Barr. Ask your admin if you cannot sign in.',
  },
  status: {
    checked: 'Checked on today', pending: 'Not checked on yet today', no_contact: 'No contact yet', alert: 'Alert open',
    checked_desc: 'Someone from Barr saw or spoke to {{name}} today.',
    pending_desc: 'A visit or check-in is expected later today.',
    no_contact_desc: 'No visit or check-in has been recorded today. Your coordinator has been asked to follow up.',
    alert_desc: 'An escalation is open and our team is handling it.',
  },
  timeline: {
    title: 'Timeline', filters: { all: 'All', visits: 'Visits', medicines: 'Medicines', alerts: 'Alerts', concerns: 'Concerns' },
    arrived: 'Arrived', left: 'Left', duration: '{{min}} min', vitals: 'Vitals', observations: 'Observations', note: 'Note', photos: 'Photos', empty: 'Nothing here yet.',
    outOfRange: 'Outside usual range',
  },
  visitType: { assessment: 'Home assessment', coordinator: 'Coordinator visit', nurse: 'Nurse visit', doctor: 'Doctor visit', caregiver_shift: 'Caregiver shift' },
  vitals: { bp_systolic: 'Blood pressure (systolic)', bp_diastolic: 'Blood pressure (diastolic)', pulse: 'Pulse', glucose: 'Blood glucose', temperature: 'Temperature', spo2: 'Oxygen saturation', weight: 'Weight' },
  obs: {
    mood: 'Mood', appetite: 'Appetite', sleep: 'Sleep', mobility: 'Mobility', pain: 'Pain', skin: 'Skin / pressure areas', hydration: 'Hydration',
    homeSafety: 'Home safety', cognitionChange: 'Change in memory or thinking', fallsSinceLastVisit: 'Falls since last visit',
    medicineAdherence: 'Medicines taken as planned', socialContact: 'Had social contact',
    values: {
      poor: 'Poor', normal: 'Normal', good: 'Good', ok: 'OK', concern: 'Needs attention', independent: 'Independent', with_aid: 'With a walking aid',
      assisted: 'Needs help', bedbound: 'Bed-bound',
    },
    painLoc: { none: 'none', head: 'head', chest: 'chest', abdomen: 'abdomen', back: 'back', joints: 'joints', legs: 'legs', other: 'other' },
    safety: { rugs_secured: 'Rugs secured', lighting_ok: 'Lighting OK', bathroom_rails: 'Bathroom rails', clear_walkways: 'Walkways clear', gas_checked: 'Gas checked', emergency_numbers_visible: 'Emergency numbers visible' },
  },
  doses: { title: "Today's medicines", confirmed: 'Taken', missed: 'Missed', scheduled: 'Due', skipped: 'Skipped' },
  help: { button: 'Get help now', confirm: 'We will alert the on-call doctor and your coordinator right away. Continue?', sent: 'Help is on the way. You will see updates here.' },
  escalation: {
    title: 'Escalation', status: { open: 'Raised', acknowledged: 'Doctor responding', in_progress: 'Being handled', closed: 'Closed' },
    decision: { phone_advice: 'Advice given by phone', nurse_dispatched: 'Nurse sent to the home', ambulance_called: 'Ambulance called', hospital_transfer: 'Transfer to hospital' },
    costsNote: 'Barr does not pay for hospital or ambulance costs. Any cost Barr pays on your behalf is shown to you at cost.',
  },
  staff: { verified: 'Verified', idChecked: 'National ID checked', background: 'Background check done', reference: 'Reference checked', training: 'Training completed', visitsWithFamily: '{{count}} visits with your family' },
  plans: {
    visit: { name: 'Visit', desc: 'Coordinator visit every 2 weeks, monthly doctor video call, refills, 24/7 line, app' },
    plus: { name: 'Plus', desc: 'Visit plan + weekly nurse visit, monthly home doctor visit, quarterly home labs' },
    caregiver: { name: 'Caregiver', desc: 'Plus plan + day or live-in caregiver, supervised weekly (price set for your family)' },
    prepaid: 'Charged monthly in advance. Cancel any time; cancellation takes effect at the end of the paid month.',
    notInsurance: 'Barr is a care service, not insurance. Medicines, labs and ambulances are billed at cost and itemised.',
  },
  concerns: { title: 'Concerns', raise: 'Raise a concern', deadline: 'We will reply by {{time}}', status: { open: 'Open', in_progress: 'In progress', resolved: 'Resolved' }, reopen: 'Reopen' },
  privacy: { title: 'Privacy policy', terms: 'Terms of service', placeholder: 'The final text will be provided by Barr. This is placeholder text.', deleteAccount: 'Delete my account', deleteConfirm: 'This removes your personal details from Barr. Your parent’s care records are kept as required by our retention policy. Continue?' },
  field: {
    todayVisits: "Today's visits", startVisit: 'Start visit (check in)', endVisit: 'Finish visit (check out)', tooFar: 'You are {{distance}} m from the home. Move within {{radius}} m to check in, or ask an admin to override.',
    noLocation: 'We could not read your location. Turn on location to check in.', escalate: 'Escalate', checklist: 'Checklist', addPhoto: 'Add photo', photoNoConsent: 'Photos are turned off for this person (no consent).',
    route: 'Route', neighborhood: 'Neighbourhood',
  },
} as const;

type Widen<T> = { [K in keyof T]: T[K] extends string ? string : Widen<T[K]> };
export type Dictionary = Widen<typeof en>;
