#!/usr/bin/env bash
# One-command local setup: Postgres roles + databases, migrations, demo seed.
# Requires a running Postgres 14+ reachable with ADMIN_DATABASE_URL (superuser).
set -euo pipefail
ADMIN_URL="${ADMIN_DATABASE_URL:-postgres://postgres:postgres@localhost:5432/postgres}"
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 <<'SQL'
do $$ begin
  if not exists (select 1 from pg_roles where rolname='barr_owner') then create role barr_owner login password 'barr_owner'; end if;
  if not exists (select 1 from pg_roles where rolname='barr_app') then create role barr_app login password 'barr_app' nosuperuser nobypassrls; end if;
end $$;
SQL
for db in barr barr_test; do
  if ! psql "$ADMIN_URL" -tAc "select 1 from pg_database where datname='$db'" | grep -q 1; then
    psql "$ADMIN_URL" -c "create database $db owner barr_owner"
  fi
  psql "${ADMIN_URL%/*}/$db" -c "create extension if not exists pgcrypto" >/dev/null
done
pnpm install
pnpm --filter @barr/backend migrate
pnpm --filter @barr/backend seed
echo "Done. Start: pnpm dev:backend | pnpm dev:worker | pnpm dev:dashboard | pnpm dev:mobile"
