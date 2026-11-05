/**
 * Demo seed (§13): one city, two pods, staff, 60 families, a month of visits with reports,
 * medicines + dose events, a few escalations/concerns, and today's schedule.
 * Run: pnpm db:seed   (uses MIGRATION_DATABASE_URL — owner role, bypasses RLS)
 * Sign in on dev with DEV_FIXED_OTP (e.g. 123456): admin +201000000001, coordinator +201000000002,
 * nurse +201000000003, doctor +201000000004, family +966500000001 … +966500000060.
 */
import pg from 'pg';
import { addDays, assessVital, defaultConfig, localParts, templateVisitReportGenerator, zonedTimeToUtc, type VisitType } from '@barr/shared';
import { loadEnv } from '../env';
import { FieldCrypto } from '../lib/crypto';
import { seedReference } from './reference';

const env = loadEnv();
const crypto = new FieldCrypto(env.FIELD_ENCRYPTION_KEY, env.BLIND_INDEX_KEY);
const TZ = 'Africa/Cairo';
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T,>(a: readonly T[]) => a[Math.floor(rnd() * a.length)]!;
const between = (a: number, b: number) => Math.round(a + rnd() * (b - a));

const NEIGHBORHOODS = { 'Zamalek & Dokki': ['Zamalek', 'Dokki', 'Agouza', 'Mohandessin'], 'Maadi & Heliopolis': ['Maadi', 'Heliopolis', 'Nasr City', 'Garden City'] } as const;
const CENTERS: Record<string, [number, number]> = { Zamalek: [30.0626, 31.2197], Dokki: [30.0385, 31.2123], Agouza: [30.0571, 31.2096], Mohandessin: [30.0553, 31.2001], Maadi: [29.9602, 31.2569], Heliopolis: [30.0911, 31.3225], 'Nasr City': [30.0566, 31.3301], 'Garden City': [30.0353, 31.2312] };
const MOTHERS = ['Fatma', 'Aisha', 'Nadia', 'Samira', 'Hoda', 'Laila', 'Mona', 'Soad', 'Zeinab', 'Magda', 'Karima', 'Wafaa'];
const FATHERS = ['Mahmoud', 'Hassan', 'Mostafa', 'Ibrahim', 'Adel', 'Sami', 'Fouad', 'Hamdy', 'Ahmed', 'Kamal'];
const CHILDREN = ['Sara', 'Omar', 'Yasmin', 'Karim', 'Nour', 'Tarek', 'Dina', 'Youssef', 'Rana', 'Hany'];

async function main() {
  const pool = new pg.Pool({ connectionString: env.MIGRATION_DATABASE_URL, max: 4 });
  const c = await pool.connect();
  try {
    if ((await c.query(`select count(*)::int n from parents`)).rows[0].n > 0) { console.log('Database already has data; skipping seed.'); return; }
    await c.query('begin');
    await seedReference(c as any);
    const now = new Date();
    const today = localParts(now, TZ).date;
    const city = (await c.query(`insert into cities (name_en, name_ar) values ('Cairo','القاهرة') returning id`)).rows[0].id;
    const user = async (phone: string, first: string, roles: string[], lang = 'ar') =>
      (await c.query(`insert into users (phone_enc, phone_hash, first_name, display_name, roles, language, phone_verified_at) values ($1,$2,$3,$3,$4,$5,now()) returning id`, [crypto.encrypt(phone), crypto.blindIndex(phone), first, roles, lang])).rows[0].id as string;
    const admin = await user('+201000000001', 'Omar', ['admin'], 'en');
    const staff: { id: string; role: string; pod?: string }[] = [];
    const addStaff = async (phone: string, first: string, role: string, gender: string, pod: string | null) => {
      const id = await user(phone, first, role === 'oncall_doctor' ? ['doctor', 'oncall_doctor'] : [role]);
      await c.query(`insert into staff (user_id, role, gender, languages, city_id, pod_id) values ($1,$2,$3,'{ar,en}',$4,$5)`, [id, role, gender, city, pod]);
      for (const item of ['id_checked', 'background_check', 'reference_check', 'training']) await c.query(`insert into staff_verifications (user_id, item, completed_on, verified_by) values ($1,$2,$3,$4)`, [id, item, addDays(today, -60), admin]);
      staff.push({ id, role, pod: pod ?? undefined });
      return id;
    };
    await c.query(`insert into staff (user_id, role, gender, languages, city_id) values ($1,'admin','male','{ar,en}',$2)`, [admin, city]);
    const pods: { id: string; name: string; coordinator: string; hoods: readonly string[] }[] = [];
    let n = 2;
    for (const [name, hoods] of Object.entries(NEIGHBORHOODS)) {
      const coord = await user(`+20100000000${n++}`.slice(0, 13), pods.length ? 'Heba' : 'Mariam', ['coordinator']);
      const pod = (await c.query(`insert into pods (city_id, name, coordinator_user_id, neighborhoods) values ($1,$2,$3,$4) returning id`, [city, name, coord, hoods])).rows[0].id;
      await c.query(`insert into staff (user_id, role, gender, languages, city_id, pod_id) values ($1,'coordinator','female','{ar,en}',$2,$3)`, [coord, city, pod]);
      for (const item of ['id_checked', 'background_check', 'reference_check', 'training']) await c.query(`insert into staff_verifications (user_id, item, completed_on, verified_by) values ($1,$2,$3,$4)`, [coord, item, addDays(today, -60), admin]);
      staff.push({ id: coord, role: 'coordinator', pod });
      pods.push({ id: pod, name, coordinator: coord, hoods });
    }
    // Phones: coordinators +201000000002/3; nurses 0000010+, caregivers 0000020+, doctors 0000030+
    const nurses = [await addStaff('+201000000010', 'Mona', 'nurse', 'female', pods[0]!.id), await addStaff('+201000000011', 'Rasha', 'nurse', 'female', pods[0]!.id), await addStaff('+201000000012', 'Amira', 'nurse', 'female', pods[1]!.id), await addStaff('+201000000013', 'Khaled', 'nurse', 'male', pods[1]!.id)];
    const caregivers = [await addStaff('+201000000020', 'Hanan', 'caregiver', 'female', pods[0]!.id), await addStaff('+201000000021', 'Safaa', 'caregiver', 'female', pods[1]!.id), await addStaff('+201000000022', 'Mohamed', 'caregiver', 'male', pods[0]!.id)];
    const doctor = await addStaff('+201000000030', 'Dr. Sherif', 'oncall_doctor', 'male', null);
    const backup = await addStaff('+201000000031', 'Dr. Ola', 'oncall_doctor', 'female', null);
    await c.query(`insert into oncall_rota (city_id, user_id, tier, starts_at, ends_at) values ($1,$2,'primary',$4,$5), ($1,$3,'backup',$4,$5)`, [city, doctor, backup, addDays(today, -1), addDays(today, 30)]);

    let famCount = 0;
    for (let i = 1; i <= 60; i++) {
      const pod = pods[i % 2]!;
      const hood = pick(pod.hoods);
      const [lat, lng] = CENTERS[hood]!;
      const gender = rnd() < 0.65 ? 'female' : 'male';
      const pname = `${gender === 'female' ? pick(MOTHERS) : pick(FATHERS)} ${String.fromCharCode(65 + (i % 26))}.`;
      const childPhone = `+9665000000${String(i).padStart(2, '0')}`;
      const child = await user(childPhone, pick(CHILDREN), ['family']);
      const fam = (await c.query(`insert into families default values returning id`)).rows[0].id;
      await c.query(`insert into family_members (family_id, user_id, whatsapp_opt_in) values ($1,$2,$3)`, [fam, child, rnd() < 0.7]);
      if (i % 3 === 0) { const sib = await user(`+9715000000${String(i).padStart(2, '0')}`, pick(CHILDREN), ['family']); await c.query(`insert into family_members (family_id, user_id, invited_by) values ($1,$2,$3)`, [fam, sib, child]); }
      const plan = i % 10 === 0 ? 'caregiver' : i % 3 === 0 ? 'plus' : 'visit';
      const status = i === 57 ? 'paused' : i > 58 ? 'onboarding' : 'active';
      const p = (await c.query(
        `insert into parents (family_id, city_id, pod_id, name, gender, birth_year, address_enc, neighborhood, lat, lng, language, carer_preference, emergency_contacts_enc, known_medicines, allergies_has, allergies_text, mobility_notes, status, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ar',$11,$12,$13,$14,$15,$16,$17,$18) returning id`,
        [fam, city, pod.id, pname, gender, between(1938, 1955), crypto.encrypt(`${between(1, 80)} Street ${i}, ${hood}, Cairo`), hood, lat + (rnd() - 0.5) * 0.01, lng + (rnd() - 0.5) * 0.01,
          gender, crypto.encrypt(JSON.stringify([{ name: 'Neighbour', phone: '+20101234' + String(i).padStart(4, '0'), relation: 'neighbour' }])), JSON.stringify(['Amlodipine']), i % 7 === 0, i % 7 === 0 ? 'Penicillin' : '', pick(['Independent', 'Uses a cane', 'Walker indoors', 'Needs help with stairs']), status, new Date(now.getTime() - 40 * 86_400_000)],
      )).rows[0].id;
      await c.query(`insert into chat_threads (parent_id) values ($1)`, [p]);
      for (const t of ['visits', 'photos', 'share_updates']) await c.query(`insert into consents (parent_id, city_id, pod_id, type, granted, recorded_by, document_ref, recorded_at) values ($1,$2,$3,$4,$5,$6,$7,$8)`, [p, city, pod.id, t, t !== 'photos' || i % 5 !== 0, pod.coordinator, `consent_doc/${p}/signed.pdf`, new Date(now.getTime() - 35 * 86_400_000)]);
      if (status === 'onboarding') continue;
      famCount++;
      const currency = pick(['USD', 'SAR', 'AED'] as const);
      const subStatus = status === 'paused' ? 'paused' : 'active';
      await c.query(`insert into subscriptions (parent_id, family_id, city_id, pod_id, plan_code, currency, custom_amount, provider, payment_token_enc, card_last4, card_brand, status, current_period_start, current_period_end, created_at)
        values ($1,$2,$3,$4,$5,$6,$7,'fake',$8,$9,$10,$11,$12,$13,$14)`, [p, fam, city, pod.id, plan, currency, plan === 'caregiver' ? 42000 : null, crypto.encrypt('tok_demo'), String(between(1000, 9999)), pick(['visa', 'mada', 'mastercard']), subStatus, new Date(now.getTime() - 10 * 86_400_000), new Date(now.getTime() + 20 * 86_400_000), new Date(now.getTime() - 40 * 86_400_000)]);
      const nurse = nurses[(i % 2) + (pod === pods[1] ? 2 : 0)]!;
      const caregiver = plan === 'caregiver' ? caregivers[i % caregivers.length]! : null;
      await c.query(`insert into staff_assignments (parent_id, user_id, role, started_at) values ($1,$2,'coordinator',$3)`, [p, pod.coordinator, new Date(now.getTime() - 35 * 86_400_000)]);
      if (plan !== 'visit') await c.query(`insert into staff_assignments (parent_id, user_id, role, started_at) values ($1,$2,'nurse',$3)`, [p, nurse, new Date(now.getTime() - 35 * 86_400_000)]);
      if (caregiver) await c.query(`insert into staff_assignments (parent_id, user_id, role, started_at) values ($1,$2,'caregiver',$3)`, [p, caregiver, new Date(now.getTime() - 35 * 86_400_000)]);
      const rules = [
        { type: 'coordinator', freq: 'biweekly', weekday: i % 6, anchorDate: addDays(today, -35), time: `${between(9, 16)}:00`.padStart(5, '0'), durationMin: 60, staffUserId: pod.coordinator },
        ...(plan !== 'visit' ? [{ type: 'nurse', freq: 'weekly', weekdays: [(i + 2) % 7], time: `${between(9, 17)}:30`.padStart(5, '0'), durationMin: 45, staffUserId: nurse }] : []),
        ...(caregiver ? [{ type: 'caregiver_shift', freq: 'daily', time: '08:00', durationMin: 480, staffUserId: caregiver }] : []),
      ];
      const cp = (await c.query(`insert into care_plans (parent_id, version, status, content, published_by, published_at) values ($1,1,'published',$2,$3,$4) returning id`, [p, { visitRules: rules, goals: [{ en: 'Stay independent and safe at home', ar: 'البقاء مستقلًا وآمنًا في المنزل' }], included: [], notIncluded: [{ en: 'Hospital and ambulance costs', ar: 'تكاليف المستشفى والإسعاف' }], carerPreferences: { gender, languages: ['ar'] } }, pod.coordinator, new Date(now.getTime() - 34 * 86_400_000)])).rows[0].id;
      await c.query(`insert into agreement_acceptances (care_plan_id, parent_id, version, user_id, accepted_at) values ($1,$2,1,$3,$4)`, [cp, p, child, new Date(now.getTime() - 33 * 86_400_000)]);
      const med = (await c.query(`insert into medications (parent_id, name, dose_text, times_of_day, start_date, instructions, created_by) values ($1,'Amlodipine','5 mg','{08:00,20:00}',$2,'After food',$3) returning id`, [p, addDays(today, -30), nurse])).rows[0].id;

      // A month of visits: past = completed (a few missed), today/future = scheduled.
      const { planVisits } = await import('@barr/shared');
      const planned = planVisits(rules as any, addDays(today, -30), 44, TZ);
      for (const v of planned) {
        const rule = rules[v.ruleIndex]!;
        const past = v.scheduledAt.getTime() < now.getTime() - 3 * 3_600_000;
        const missed = past && rnd() < 0.03;
        const checkIn = new Date(v.scheduledAt.getTime() + between(-5, 20) * 60_000);
        const checkOut = new Date(checkIn.getTime() + v.durationMin * 60_000);
        const vid = (await c.query(
          `insert into visits (parent_id, city_id, pod_id, type, staff_user_id, scheduled_at, duration_min, status, source, care_plan_id, rule_key, checked_in_at, check_in_lat, check_in_lng, check_in_distance_m, checked_out_at, submitted_at, synced_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,'care_plan',$9,$10,$11,$12,$13,$14,$15,$16,$16) returning id`,
          [p, city, pod.id, v.type, rule.staffUserId, v.scheduledAt, v.durationMin, past ? (missed ? 'missed' : 'completed') : 'scheduled', cp, `${cp}:${v.ruleIndex}:${v.scheduledAt.toISOString()}`,
            past && !missed ? checkIn : null, past && !missed ? lat : null, past && !missed ? lng : null, past && !missed ? between(5, 80) : null, past && !missed ? checkOut : null, past && !missed ? new Date(checkOut.getTime() + between(1, 30) * 60_000) : null],
        )).rows[0].id;
        if (!past) {
          await c.query(`insert into jobs (name, payload, run_at, dedupe_key) values ('visit.no_show_check', $1, $2, $3) on conflict do nothing`, [{ visitId: vid, scheduledAt: v.scheduledAt.toISOString() }, new Date(v.scheduledAt.getTime() + 30 * 60_000), `visit.no_show:${vid}:${v.scheduledAt.toISOString()}`]);
          continue;
        }
        if (missed) continue;
        const obs = { mood: between(3, 5), appetite: pick(['normal', 'good', 'good', 'poor']), sleep: pick(['normal', 'good', 'poor']), mobility: pick(['independent', 'with_aid']), hydration: pick(['ok', 'ok', 'ok', 'concern']), medicineAdherence: 'ok', socialContact: rnd() < 0.8, fallsSinceLastVisit: rnd() < 0.05 ? 1 : 0 };
        const vitals = v.type === 'caregiver_shift' ? [] : [{ kind: 'bp_systolic' as const, value: between(115, 158) }, { kind: 'bp_diastolic' as const, value: between(70, 92) }, { kind: 'pulse' as const, value: between(62, 96) }];
        const input = { parentName: pname, staffName: '', visitType: v.type as VisitType, checkedInAt: checkIn.toISOString(), checkedOutAt: checkOut.toISOString(), observations: obs as any, vitals, tasksDone: [], note: pick(['', 'Good day, chatted about grandchildren.', 'Reminded about water intake.', 'Walked around the block together.']), photoCount: 0 };
        const rep = templateVisitReportGenerator.generate(p, { from: today, to: today }, input);
        await c.query(`insert into visit_observations (visit_id, parent_id, data, recorded_by, recorded_at) values ($1,$2,$3,$4,$5)`, [vid, p, obs, rule.staffUserId, checkOut]);
        for (const x of vitals) { const a = assessVital(x.kind, x.value, defaultConfig.vitalsCritical); await c.query(`insert into vital_readings (visit_id, parent_id, kind, value, out_of_range, critical, recorded_at, recorded_by) values ($1,$2,$3,$4,$5,$6,$7,$8)`, [vid, p, x.kind, x.value, a.outOfRange, a.critical, checkIn, rule.staffUserId]); }
        if (input.note) await c.query(`insert into visit_notes (visit_id, parent_id, note, author_id) values ($1,$2,$3,$4)`, [vid, p, input.note, rule.staffUserId]);
        await c.query(`insert into reports (type, parent_id, visit_id, period_start, period_end, generator, structured_input, structured_payload, rendered_ar, rendered_en) values ('visit',$1,$2,$3,$3,$4,$5,$6,$7,$8)`, [p, vid, checkIn.toISOString().slice(0, 10), rep.generator, input, rep.payload, rep.text_ar, rep.text_en]);
      }
      // Dose events for the past 30 days + today (some missed).
      for (let dd = -30; dd <= 0; dd++) {
        const date = addDays(today, dd);
        for (const t of ['08:00', '20:00']) {
          const at = zonedTimeToUtc(date, t, TZ);
          if (at > now) { await c.query(`insert into dose_events (medication_id, parent_id, city_id, pod_id, scheduled_at) values ($1,$2,$3,$4,$5)`, [med, p, city, pod.id, at]); continue; }
          const ok = rnd() > 0.06;
          await c.query(`insert into dose_events (medication_id, parent_id, city_id, pod_id, scheduled_at, status, confirmed_at, confirmed_by, method, coordinator_alerted_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [med, p, city, pod.id, at, ok ? 'confirmed' : 'missed', ok ? new Date(at.getTime() + between(0, 40) * 60_000) : null, ok ? caregiver ?? nurse : null, ok ? (caregiver ? 'caregiver' : 'parent_phone') : null, ok ? null : new Date(at.getTime() + 3_600_000)]);
        }
      }
      if (i % 12 === 0) {
        const at = new Date(now.getTime() - between(2, 25) * 86_400_000);
        await c.query(`insert into escalations (parent_id, city_id, pod_id, trigger, severity, status, created_by, created_at, acknowledged_at, acknowledged_by, family_notified_at, decision, decision_by, decision_at, closed_at, closed_by, closing_note)
          values ($1,$2,$3,'family_help','urgent','closed',$4,$5,$6,$7,$5,'nurse_dispatched',$7,$6,$8,$9,'Nurse visited; minor fall, no injury. Rails installed.')`, [p, city, pod.id, child, at, new Date(at.getTime() + 70_000), doctor, new Date(at.getTime() + 3 * 3_600_000), pod.coordinator]);
      }
      if (i % 9 === 0) {
        const at = new Date(now.getTime() - between(0, 3) * 3_600_000);
        await c.query(`insert into concerns (ref, parent_id, family_id, city_id, pod_id, raised_by, category, urgency, safety_flag, text, owner_user_id, deadline, created_at) values ($1,$2,$3,$4,$5,$6,'schedule','normal',false,'The nurse came an hour late last week.',$7,$8,$9)`,
          [`C-DEMO-${i}`, p, fam, city, pod.id, child, pod.coordinator, new Date(at.getTime() + (i === 18 ? -1 : 24) * 3_600_000), at]);
      }
    }
    // Open escalation for the demo "Today" page.
    const demoParent = (await c.query(`select id, city_id, pod_id from parents where status='active' order by created_at limit 1`)).rows[0];
    await c.query(`insert into escalations (parent_id, city_id, pod_id, trigger, severity, status, created_at, note) values ($1,$2,$3,'helpline_call','urgent','open',$4,'Neighbour called: dizziness')`, [demoParent.id, demoParent.city_id, demoParent.pod_id, new Date(now.getTime() - 4 * 60_000)]);
    // Assessment slots for the next week.
    for (const pod of pods) for (let dd = 1; dd <= 7; dd++) for (const t of ['10:00', '14:00']) await c.query(`insert into assessment_slots (pod_id, coordinator_user_id, starts_at, ends_at) values ($1,$2,$3,$4)`, [pod.id, pod.coordinator, zonedTimeToUtc(addDays(today, dd), t, TZ), new Date(zonedTimeToUtc(addDays(today, dd), t, TZ).getTime() + 3_600_000)]);
    await c.query('commit');
    console.log(`Seeded: 1 city, ${pods.length} pods, ${staff.length + 1} staff, 60 families (${famCount} subscribed).`);
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
