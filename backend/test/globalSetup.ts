import pg from 'pg';
import { migrate } from '../src/db/migrate';

const ADMIN = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
export const TEST_DB = 'barr_test';

/** Fresh test database per run, migrated by the owner role; tests connect as the RLS-bound app role. */
export default async function setup() {
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`do $$ begin
    if not exists (select 1 from pg_roles where rolname='barr_owner') then create role barr_owner login password 'barr_owner'; end if;
    if not exists (select 1 from pg_roles where rolname='barr_app') then create role barr_app login password 'barr_app' nosuperuser nobypassrls; end if;
  end $$`);
  await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid <> pg_backend_pid()`, [TEST_DB]);
  await admin.query(`drop database if exists ${TEST_DB}`);
  await admin.query(`create database ${TEST_DB} owner barr_owner`);
  await admin.end();
  const dbAdmin = new pg.Client({ connectionString: ADMIN.replace(/\/[^/]+$/, `/${TEST_DB}`) });
  await dbAdmin.connect();
  await dbAdmin.query('create extension if not exists pgcrypto');
  await dbAdmin.end();
  const host = new URL(ADMIN).host;
  await migrate(`postgres://barr_owner:barr_owner@${host}/${TEST_DB}`, () => {});
}
