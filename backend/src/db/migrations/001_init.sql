-- Barr V1 schema. Every operational record carries city_id + pod_id (PRD §4.2).
-- Phone numbers and addresses are encrypted at the application layer (AES-256-GCM, *_enc columns);
-- *_hash columns are HMAC blind indexes for lookup.
create extension if not exists pgcrypto;
set local check_function_bodies = off; -- helper functions reference tables defined later in this file

-- ── Session context helpers for row-level security ──────────────────────────
create or replace function barr_uid() returns uuid language sql stable as
$$ select nullif(current_setting('barr.user_id', true), '')::uuid $$;
create or replace function barr_is_system() returns boolean language sql stable as
$$ select coalesce(current_setting('barr.system', true), '') = 'on' $$;
create or replace function barr_has_role(r text) returns boolean language sql stable as
$$ select position(',' || r || ',' in coalesce(current_setting('barr.roles', true), '')) > 0 $$;

create table cities (
  id uuid primary key default gen_random_uuid(),
  name_en text not null, name_ar text not null,
  timezone text not null default 'Africa/Cairo',
  created_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  phone_enc text, phone_hash text unique,
  email text,
  display_name text not null default '',
  first_name text not null default '',
  photo_key text,
  language text not null default 'ar' check (language in ('ar','en')),
  roles text[] not null default '{family}',
  phone_verified_at timestamptz,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table pods (
  id uuid primary key default gen_random_uuid(),
  city_id uuid not null references cities(id),
  name text not null,
  coordinator_user_id uuid references users(id),
  neighborhoods text[] not null default '{}',
  created_at timestamptz not null default now()
);
create index on pods (coordinator_user_id);

create table auth_identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  provider text not null check (provider in ('google','apple')),
  subject text not null,
  email text,
  created_at timestamptz not null default now(),
  unique (provider, subject)
);

create table otp_codes (
  id uuid primary key default gen_random_uuid(),
  phone_hash text not null,
  code_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index on otp_codes (phone_hash, created_at desc);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  refresh_hash text not null unique,
  device_name text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_reason text
);
create index on sessions (user_id) where revoked_at is null;

create table push_tokens (
  user_id uuid not null references users(id) on delete cascade,
  token text not null,
  platform text not null check (platform in ('ios','android','web')),
  app text not null default 'family' check (app in ('family','field')),
  updated_at timestamptz not null default now(),
  primary key (user_id, token)
);

create table families (id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now());

create table family_members (
  family_id uuid not null references families(id),
  user_id uuid not null references users(id),
  joined_at timestamptz not null default now(),
  invited_by uuid references users(id),
  removed_at timestamptz,
  whatsapp_opt_in boolean not null default false,
  chat_whatsapp_mirror boolean not null default false,
  primary key (family_id, user_id)
);
create index on family_members (user_id) where removed_at is null;

create table family_invites (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id),
  phone_hash text not null,
  phone_enc text not null,
  invited_by uuid not null references users(id),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references users(id),
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index on family_invites (phone_hash) where accepted_at is null and revoked_at is null;

create table parents (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id),
  city_id uuid not null references cities(id),
  pod_id uuid not null references pods(id),
  name text not null,
  gender text not null check (gender in ('female','male')),
  birth_year int,
  phone_enc text,
  address_enc text not null,
  neighborhood text not null default '',
  lat double precision not null,
  lng double precision not null,
  language text not null default 'ar' check (language in ('ar','en')),
  carer_preference text not null check (carer_preference in ('female','male','any')),
  emergency_contacts_enc text,
  known_medicines jsonb not null default '[]',
  allergies_has boolean not null default false,
  allergies_text text not null default '' check (length(allergies_text) <= 300),
  mobility_notes text not null default '' check (length(mobility_notes) <= 500),
  photo_key text,
  status text not null default 'onboarding' check (status in ('onboarding','active','paused','cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  purge_after timestamptz
);
create index on parents (family_id);
create index on parents (pod_id, status);
create index on parents (city_id);

-- Staff (verification is a checklist with dates: §8 — no ID document images).
create table staff (
  user_id uuid primary key references users(id),
  role text not null check (role in ('coordinator','nurse','doctor','caregiver','oncall_doctor','admin')),
  languages text[] not null default '{ar}',
  gender text check (gender in ('female','male')),
  city_id uuid references cities(id),
  pod_id uuid references pods(id),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create table staff_verifications (
  user_id uuid not null references staff(user_id),
  item text not null check (item in ('id_checked','background_check','reference_check','training')),
  completed_on date not null,
  verified_by uuid not null references users(id),
  primary key (user_id, item)
);
create or replace function staff_is_verified(uid uuid) returns boolean language sql stable as
$$ select count(*) = 4 from staff_verifications where user_id = uid $$;

-- Who cares / has cared for each parent (F13 continuity + RLS for assigned staff).
create table staff_assignments (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid not null references parents(id),
  user_id uuid not null references users(id),
  role text not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  end_reason text
);
create index on staff_assignments (user_id) where ended_at is null;
create index on staff_assignments (parent_id);

create table oncall_rota (
  id uuid primary key default gen_random_uuid(),
  city_id uuid not null references cities(id),
  user_id uuid not null references users(id),
  tier text not null check (tier in ('primary','backup')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  check (ends_at > starts_at)
);
create index on oncall_rota (city_id, tier, starts_at, ends_at);

-- Can the current session see this parent? (section 5 roles; enforced by RLS)
create or replace function barr_can_access_parent(pid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select barr_is_system() or barr_has_role('admin')
  or exists (select 1 from parents p join family_members fm on fm.family_id = p.family_id
             where p.id = pid and fm.user_id = barr_uid() and fm.removed_at is null)
  or exists (select 1 from parents p join pods po on po.id = p.pod_id where p.id = pid and po.coordinator_user_id = barr_uid())
  or exists (select 1 from staff_assignments sa where sa.parent_id = pid and sa.user_id = barr_uid() and sa.ended_at is null)
  or (barr_has_role('oncall_doctor') and exists (select 1 from escalations e where e.parent_id = pid and e.status <> 'closed'))
$$;

create table consents (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid not null references parents(id),
  city_id uuid not null, pod_id uuid not null,
  type text not null check (type in ('visits','photos','share_updates')),
  granted boolean not null,
  shared_with uuid[] not null default '{}',
  recorded_by uuid not null references users(id),
  document_ref text not null,
  recorded_at timestamptz not null default now()
);
create index on consents (parent_id, type, recorded_at desc);

-- Plans & money (amounts in minor units).
create table plans (
  code text primary key check (code in ('visit','plus','caregiver')),
  name_en text not null, name_ar text not null,
  inclusions jsonb not null default '{}',
  active boolean not null default true
);
create table plan_prices (
  plan_code text not null references plans(code),
  currency text not null check (currency in ('USD','SAR','AED')),
  amount int not null check (amount > 0),
  primary key (plan_code, currency)
);

create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid not null references parents(id),
  family_id uuid not null references families(id),
  city_id uuid not null, pod_id uuid not null,
  plan_code text not null references plans(code),
  currency text not null check (currency in ('USD','SAR','AED')),
  custom_amount int,
  founding_family boolean not null default false,
  provider text not null,
  payment_token_enc text,
  card_last4 text, card_brand text,
  status text not null check (status in ('pending_payment','active','past_due','paused','cancel_at_period_end','cancelled')),
  current_period_start timestamptz,
  current_period_end timestamptz,
  failed_attempts int not null default 0,
  first_failure_at timestamptz,
  next_retry_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index subscriptions_one_live_per_parent on subscriptions (parent_id) where status <> 'cancelled';
create index on subscriptions (status, current_period_end);

create table invoices (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  family_id uuid not null references families(id),
  parent_id uuid not null references parents(id),
  city_id uuid not null, pod_id uuid not null,
  subscription_id uuid references subscriptions(id),
  currency text not null,
  lines jsonb not null,
  total int not null,
  status text not null check (status in ('issued','paid','void','failed')),
  period_start timestamptz, period_end timestamptz,
  issued_at timestamptz not null default now(),
  paid_at timestamptz,
  pdf_key text
);
create index on invoices (parent_id, issued_at desc);
create sequence invoice_seq;

create table payments (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid references subscriptions(id),
  invoice_id uuid references invoices(id),
  parent_id uuid not null references parents(id),
  provider text not null,
  provider_ref text,
  amount int not null,
  currency text not null,
  kind text not null check (kind in ('initial','renewal','retry','pass_through')),
  status text not null check (status in ('pending','succeeded','failed','refunded','partially_refunded')),
  failure_reason text,
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on payments (status, created_at desc);
create index on payments (provider, provider_ref);

create table refunds (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references payments(id),
  amount int not null check (amount > 0),
  reason text not null,
  issued_by uuid not null references users(id),
  provider_ref text,
  status text not null check (status in ('pending','succeeded','failed')),
  created_at timestamptz not null default now()
);

create table pass_through_charges (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid not null references parents(id),
  family_id uuid not null references families(id),
  city_id uuid not null, pod_id uuid not null,
  category text not null check (category in ('medicine','lab','ambulance','other')),
  description text not null,
  amount int not null check (amount > 0),
  currency text not null,
  at_cost boolean not null default true check (at_cost),
  handling_fee int check (handling_fee is null or handling_fee >= 0),
  receipt_key text not null,
  recorded_by uuid not null references users(id),
  invoice_id uuid references invoices(id),
  created_at timestamptz not null default now()
);
create index on pass_through_charges (parent_id) where invoice_id is null;

create table webhook_events (
  provider text not null,
  event_id text not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  primary key (provider, event_id)
);

-- Care plans (versioned) and agreement acceptance (F10).
create table care_plans (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid not null references parents(id),
  version int not null,
  status text not null check (status in ('draft','published','superseded')),
  content jsonb not null,
  published_by uuid references users(id),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  unique (parent_id, version)
);
create table agreement_acceptances (
  care_plan_id uuid not null references care_plans(id),
  parent_id uuid not null references parents(id),
  version int not null,
  user_id uuid not null references users(id),
  accepted_at timestamptz not null default now(),
  primary key (care_plan_id, user_id)
);

create table checklist_templates (
  id uuid primary key default gen_random_uuid(),
  visit_type text not null,
  version int not null,
  definition jsonb not null,
  active boolean not null default true,
  updated_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (visit_type, version)
);

create table assessment_slots (
  id uuid primary key default gen_random_uuid(),
  pod_id uuid not null references pods(id),
  coordinator_user_id uuid not null references users(id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  booked_parent_id uuid references parents(id),
  booked_at timestamptz
);
create index on assessment_slots (pod_id, starts_at) where booked_parent_id is null;

create table visits (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid not null references parents(id),
  city_id uuid not null, pod_id uuid not null,
  type text not null check (type in ('assessment','coordinator','nurse','doctor','caregiver_shift')),
  staff_user_id uuid references users(id),
  scheduled_at timestamptz not null,
  duration_min int not null default 60,
  status text not null default 'scheduled' check (status in ('scheduled','in_progress','completed','missed','cancelled')),
  source text not null default 'manual' check (source in ('care_plan','manual','assessment')),
  care_plan_id uuid references care_plans(id),
  rule_key text,
  template_id uuid references checklist_templates(id),
  checked_in_at timestamptz, check_in_lat double precision, check_in_lng double precision, check_in_accuracy_m real, check_in_distance_m real,
  check_in_override_reason text, check_in_override_by uuid references users(id),
  checked_out_at timestamptz, check_out_lat double precision, check_out_lng double precision,
  offline_captured boolean not null default false,
  submitted_at timestamptz,
  synced_at timestamptz,
  no_show_flagged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index visits_rule_key on visits (parent_id, rule_key) where rule_key is not null;
create index on visits (parent_id, scheduled_at desc);
create index on visits (staff_user_id, scheduled_at);
create index on visits (pod_id, scheduled_at);
create index on visits (status, scheduled_at);

create table visit_observations (
  visit_id uuid primary key references visits(id),
  parent_id uuid not null references parents(id),
  schema_version int not null default 1,
  data jsonb not null,
  tasks_done text[] not null default '{}',
  recorded_by uuid not null references users(id),
  recorded_at timestamptz not null
);
create table vital_readings (
  id uuid primary key default gen_random_uuid(),
  visit_id uuid references visits(id),
  parent_id uuid not null references parents(id),
  kind text not null check (kind in ('bp_systolic','bp_diastolic','pulse','glucose','temperature','spo2','weight')),
  value numeric(6,2) not null,
  out_of_range boolean not null default false,
  critical boolean not null default false,
  recorded_at timestamptz not null,
  recorded_by uuid not null references users(id)
);
create index on vital_readings (parent_id, kind, recorded_at);
create table visit_photos (
  id uuid primary key default gen_random_uuid(),
  visit_id uuid not null references visits(id),
  parent_id uuid not null references parents(id),
  storage_key text not null unique,
  created_at timestamptz not null default now()
);
create table visit_notes (
  visit_id uuid primary key references visits(id),
  parent_id uuid not null references parents(id),
  note text not null check (length(note) <= 2000),
  author_id uuid not null references users(id),
  created_at timestamptz not null default now()
);

create table medications (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid not null references parents(id),
  name text not null, dose_text text not null,
  times_of_day text[] not null,
  start_date date not null, end_date date,
  instructions text not null default '',
  active boolean not null default true,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now()
);
create index on medications (parent_id) where active;

create table dose_events (
  id uuid primary key default gen_random_uuid(),
  medication_id uuid not null references medications(id),
  parent_id uuid not null references parents(id),
  city_id uuid not null, pod_id uuid not null,
  scheduled_at timestamptz not null,
  status text not null default 'scheduled' check (status in ('scheduled','confirmed','missed','skipped')),
  confirmed_at timestamptz,
  confirmed_by uuid references users(id),
  method text,
  note text,
  coordinator_alerted_at timestamptz,
  family_notified_at timestamptz,
  unique (medication_id, scheduled_at)
);
create index on dose_events (parent_id, scheduled_at);
create index on dose_events (status, scheduled_at);

create table escalations (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid not null references parents(id),
  city_id uuid not null, pod_id uuid not null,
  trigger text not null check (trigger in ('family_help','staff','helpline_call','critical_vitals','caregiver_no_show')),
  severity text not null check (severity in ('urgent','non_urgent')),
  status text not null default 'open' check (status in ('open','acknowledged','in_progress','closed')),
  created_by uuid references users(id),
  source_ref text,
  note text,
  created_at timestamptz not null,
  acknowledged_at timestamptz, acknowledged_by uuid references users(id),
  backup_paged_at timestamptz,
  call_placed_at timestamptz,
  family_notified_at timestamptz,
  decision text check (decision in ('phone_advice','nurse_dispatched','ambulance_called','hospital_transfer')),
  decision_by uuid references users(id), decision_at timestamptz,
  closed_at timestamptz, closed_by uuid references users(id), closing_note text,
  check (status <> 'closed' or (closing_note is not null and length(closing_note) >= 3))
);
create index on escalations (status, created_at) where status <> 'closed';
create index on escalations (parent_id, created_at desc);
create table escalation_events (
  id uuid primary key default gen_random_uuid(),
  escalation_id uuid not null references escalations(id),
  parent_id uuid not null references parents(id),
  at timestamptz not null,
  kind text not null,
  actor_user_id uuid references users(id),
  data jsonb not null default '{}',
  visible_to_family boolean not null default true
);
create index on escalation_events (escalation_id, at);

create sequence concern_seq;
create table concerns (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique,
  parent_id uuid not null references parents(id),
  family_id uuid not null references families(id),
  city_id uuid not null, pod_id uuid not null,
  raised_by uuid not null references users(id),
  category text not null,
  urgency text not null check (urgency in ('urgent','normal')),
  safety_flag boolean not null default false,
  text text not null,
  photo_key text,
  owner_user_id uuid references users(id),
  deadline timestamptz not null,
  status text not null default 'open' check (status in ('open','in_progress','resolved')),
  resolution text,
  first_reply_at timestamptz,
  resolved_at timestamptz,
  reopened_count int not null default 0,
  overdue_notified_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null default now()
);
create index on concerns (status, deadline) where status <> 'resolved';
create index on concerns (parent_id, created_at desc);

create table chat_threads (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid not null unique references parents(id),
  created_at timestamptz not null default now()
);
create table chat_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references chat_threads(id),
  parent_id uuid not null references parents(id),
  sender_id uuid not null references users(id),
  kind text not null check (kind in ('text','photo','voice')),
  body text not null default '' check (length(body) <= 4000),
  media_key text,
  client_id uuid unique,
  created_at timestamptz not null default now()
);
create index on chat_messages (thread_id, created_at desc);
create table chat_reads (
  thread_id uuid not null references chat_threads(id),
  user_id uuid not null references users(id),
  last_read_at timestamptz not null,
  primary key (thread_id, user_id)
);

create table reports (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('visit','monthly')),
  parent_id uuid not null references parents(id),
  visit_id uuid unique references visits(id),
  period_start date not null, period_end date not null,
  generator text not null,
  structured_input jsonb not null,
  structured_payload jsonb not null,
  rendered_ar text not null,
  rendered_en text not null,
  pdf_ref text,
  created_at timestamptz not null default now()
);
create unique index reports_monthly_unique on reports (parent_id, period_start) where type = 'monthly';
create index on reports (parent_id, created_at desc);

create table replacement_requests (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid not null references parents(id),
  city_id uuid not null, pod_id uuid not null,
  requested_by uuid not null references users(id),
  staff_user_id uuid references users(id),
  reason text not null,
  target_at timestamptz not null,
  resolved_at timestamptz,
  new_staff_user_id uuid references users(id),
  created_at timestamptz not null default now()
);

create table helpline_calls (
  id uuid primary key default gen_random_uuid(),
  parent_id uuid references parents(id),
  city_id uuid, pod_id uuid,
  caller_name text not null,
  caller_phone_enc text,
  summary text not null,
  logged_by uuid not null references users(id),
  escalation_id uuid references escalations(id),
  created_at timestamptz not null default now()
);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  parent_id uuid references parents(id),
  city_id uuid, pod_id uuid,
  assignee_user_id uuid references users(id),
  title text not null,
  ref_type text, ref_id uuid,
  due_at timestamptz,
  status text not null default 'open' check (status in ('open','done','cancelled')),
  dedupe_key text unique,
  created_at timestamptz not null default now(),
  done_at timestamptz, done_by uuid references users(id)
);
create index on tasks (assignee_user_id, status);
create index on tasks (pod_id, status, due_at);

create table notifications (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  channel text not null check (channel in ('push','whatsapp','sms')),
  language text not null,
  recipient_user_id uuid references users(id),
  parent_id uuid references parents(id),
  vars jsonb not null default '{}',
  body text not null,
  status text not null default 'queued' check (status in ('queued','sent','delivered','read','failed','skipped')),
  provider_ref text,
  error text,
  dedupe_key text unique,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  updated_at timestamptz not null default now()
);
create index on notifications (recipient_user_id, created_at desc);
create index on notifications (provider_ref);
create table notification_prefs (
  user_id uuid not null references users(id) on delete cascade,
  type text not null,
  enabled boolean not null,
  primary key (user_id, type)
);
create table notification_templates (
  type text not null, language text not null,
  body text not null,
  whatsapp_template_name text,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now(),
  primary key (type, language)
);

create table settings (
  key text primary key,
  value jsonb not null,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);

create table audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor_user_id uuid,
  action text not null,
  entity_type text not null,
  entity_id text,
  parent_id uuid,
  before jsonb, after jsonb,
  meta jsonb not null default '{}'
);
create index on audit_log (at desc);
create index on audit_log (parent_id, at desc);
create index on audit_log (actor_user_id, at desc);

-- Job queue (§10): idempotent via dedupe_key, retryable, visible in the dashboard.
create table jobs (
  id bigserial primary key,
  name text not null,
  payload jsonb not null default '{}',
  run_at timestamptz not null,
  status text not null default 'queued' check (status in ('queued','running','done','failed','dead')),
  attempts int not null default 0,
  max_attempts int not null default 5,
  last_error text,
  dedupe_key text unique,
  locked_by text, locked_at timestamptz,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index jobs_due on jobs (run_at) where status in ('queued','failed');
create index on jobs (name, created_at desc);

create table analytics_events (
  id bigserial primary key,
  at timestamptz not null default now(),
  user_id uuid,
  parent_id uuid,
  name text not null,
  props jsonb not null default '{}'
);
create index on analytics_events (name, at);

create table parent_flags (
  parent_id uuid primary key references parents(id),
  churn_risk boolean not null default false,
  reasons text[] not null default '{}',
  computed_at timestamptz not null
);

-- ── Row-level security: every parent-scoped table ──────────────────────────
do $$
declare t text;
begin
  foreach t in array array['consents','subscriptions','invoices','payments','pass_through_charges','care_plans','agreement_acceptances',
    'visits','visit_observations','vital_readings','visit_photos','visit_notes','medications','dose_events','escalations','escalation_events',
    'concerns','chat_messages','reports','replacement_requests','staff_assignments','parent_flags']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy parent_scope on %I using (barr_can_access_parent(parent_id)) with check (barr_can_access_parent(parent_id))', t);
  end loop;
end $$;

alter table parents enable row level security;
create or replace function barr_is_family_member(fid uuid) returns boolean language sql stable security definer set search_path = public as
$$ select exists (select 1 from family_members fm where fm.family_id = fid and fm.user_id = barr_uid() and fm.removed_at is null) $$;
-- USING checks family membership on the row itself too, so INSERT ... RETURNING works for the new row.
create policy parent_scope on parents
  using (barr_is_family_member(family_id) or barr_can_access_parent(id))
  with check (barr_is_system() or barr_has_role('admin') or barr_is_family_member(family_id));

alter table chat_threads enable row level security;
create policy parent_scope on chat_threads using (barr_can_access_parent(parent_id)) with check (barr_can_access_parent(parent_id));

-- Audit log: append-only for app; readable by admins/system only.
alter table audit_log enable row level security;
create policy audit_insert on audit_log for insert with check (true);
create policy audit_read on audit_log for select using (barr_is_system() or barr_has_role('admin'));

-- Runtime role. Tables are owned by the migration role (which bypasses RLS so the
-- security-definer helper above can read freely); the API/worker connect as barr_app,
-- which IS subject to RLS. See infra/setup.sh.
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'barr_app') then
    execute 'grant usage on schema public to barr_app';
    execute 'grant select, insert, update, delete on all tables in schema public to barr_app';
    execute 'grant usage, select on all sequences in schema public to barr_app';
    execute 'revoke update, delete on audit_log from barr_app';
    execute 'alter default privileges in schema public grant select, insert, update, delete on tables to barr_app';
    execute 'alter default privileges in schema public grant usage, select on sequences to barr_app';
  end if;
end $$;
