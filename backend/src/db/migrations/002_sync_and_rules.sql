-- Offline sync idempotency: each client op id is processed exactly once.
create table sync_ops (
  op_id uuid primary key,
  user_id uuid not null references users(id),
  kind text not null,
  status text not null check (status in ('applied','rejected','conflict')),
  result jsonb not null default '{}',
  received_at timestamptz not null default now()
);

-- Plan change takes effect at the next renewal (prepaid month already charged).
alter table subscriptions add column next_plan_code text references plans(code);
alter table subscriptions add column last_provider_ref text;

-- F4: staff cannot be assigned to visits until every verification item is complete.
create or replace function visits_require_verified_staff() returns trigger language plpgsql as $$
begin
  if new.staff_user_id is not null and (tg_op = 'INSERT' or new.staff_user_id is distinct from old.staff_user_id) then
    if not staff_is_verified(new.staff_user_id) then
      raise exception 'staff_not_verified' using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
create trigger visits_verified_staff before insert or update of staff_user_id on visits
  for each row execute function visits_require_verified_staff();

-- F15: a visit with photos requires photo consent (latest consent record for the parent).
create or replace function parent_has_photo_consent(pid uuid) returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select granted from consents where parent_id = pid and type = 'photos' order by recorded_at desc limit 1), false)
$$;
create or replace function visit_photos_require_consent() returns trigger language plpgsql as $$
begin
  if not parent_has_photo_consent(new.parent_id) then
    raise exception 'no_photo_consent' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger visit_photos_consent before insert on visit_photos for each row execute function visit_photos_require_consent();

-- Pass-through charges are always at cost (F9) — enforced by check constraint in 001.

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'barr_app') then
    execute 'grant select, insert, update, delete on sync_ops to barr_app';
  end if;
end $$;
