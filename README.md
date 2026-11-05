# Barr

Monthly care subscription for elderly parents in Egypt, bought by their children abroad. One backend, three surfaces:

| Surface | Path | Tech |
| --- | --- | --- |
| Family app (iOS + Android) | `apps/mobile` (`APP_VARIANT=family`) | Expo SDK 58 / React Native |
| Field app (iOS + Android) | `apps/mobile` (`APP_VARIANT=field`) | same codebase, role-based |
| Operations dashboard (web) | `apps/dashboard` | React + Vite |
| API + job worker | `backend` | Node 22, Fastify, PostgreSQL 16 (RLS), Postgres job queue |
| Shared types, rules, i18n, tokens | `packages/shared` | TypeScript + zod |

Why these choices: [`docs/decisions.md`](docs/decisions.md). Product spec: the PRD (v1).

## Quick start (local)

Requirements: Node 22, pnpm 10, PostgreSQL 16 (or `docker compose up -d`), Chromium for PDFs.

```bash
docker compose up -d        # Postgres + MinIO (optional if you have Postgres)
pnpm setup                  # roles + databases + migrations + demo seed (60 families)
```

Then, in separate terminals:

```bash
DEV_FIXED_OTP=123456 pnpm dev:backend     # API on :4000
DEV_FIXED_OTP=123456 pnpm dev:worker      # job queue (timers, reminders, renewals…)
pnpm dev:dashboard                        # http://localhost:5173
pnpm dev:mobile                           # Expo (family);  APP_VARIANT=field pnpm dev:mobile for the field app
```

Demo sign-in (code `123456` with `DEV_FIXED_OTP`): admin `+201000000001`, coordinators `+201000000002/3`,
nurses `+201000000010..13`, caregivers `+201000000020..22`, on-call doctors `+201000000030/31`,
families `+966500000001 … +966500000060`.

Environment variables: [`.env.example`](.env.example). Environments dev/staging/prod are the same image with different env
(EAS profiles `development` / `preview` / `production` for the apps; `backend/Dockerfile` runs the API, the worker
(`pnpm worker`) and migrations (`pnpm migrate`) from one image).

## Tests

```bash
pnpm typecheck                              # all packages incl. mobile
pnpm --filter @barr/shared test             # business rules (31)
pnpm --filter @barr/backend test            # integration vs real Postgres, RLS role, fake clock (40)
pnpm --filter @barr/mobile test             # offline outbox (3)
```

Backend integration tests need a Postgres superuser URL in `TEST_ADMIN_DATABASE_URL`
(default `postgres://postgres:postgres@localhost:5432/postgres`); they create `barr_test` fresh each run.

What the integration tests cover (PRD §13): offline visit sync → family timeline (idempotent retries, conflicts,
capture-time timestamps); escalation **2-minute** acknowledge/backup paging + phone call and **15-minute** family
notification, driven by the job queue with a fake clock; missed-dose flow (60 min → coordinator, 3 h → family);
subscribe → webhook → renewal → failed renewal retries day 1/3/7 → pause → card update; cancel at period end;
refunds; pass-through charges (next invoice + immediate); sibling invite + equal-access changes with notifications;
consent blocking photos (API and DB trigger); geofence block + admin override; unverified staff blocked; RLS isolation;
staff offboarding revokes sessions immediately; daily status amber + task at 18:00; no-show; care-plan versioning +
14-day visit generation; concerns deadlines/safety/reopen; monthly report; help line → escalation.

Mobile E2E journeys are written as Maestro flows in `apps/mobile/e2e` (need a device/simulator; not run in CI yet).

## Build status against the milestones

| Milestone | State |
| --- | --- |
| M0 Foundation | Done in code: monorepo, decision record, CI, env-driven config, auth (phone OTP, Google, Apple, linking), roles + RLS, AR/EN + RTL, tokens, audit log. Not yet done: running on physical iOS/Android devices (needs Apple/Google developer accounts + EAS project). |
| M1 Proof of care | Done: F1, F2, F5, F6, F15, report generator v1, push. |
| M2 Safety and trust | Done: F3, F4, F7, F8 (timers tested), F10, F18. |
| M3 Money | Done against the fake provider; PayTabs adapter written to their PT2 API but **not yet run against the PayTabs sandbox** (needs merchant credentials). |
| M4 Operations | Done: F11–F14, F16 dashboard pages, F17 (WhatsApp via Meta Cloud API adapter, templates editable), all §10 automations, metrics page. WhatsApp templates still need Meta approval. |
| M5 Store-ready | Partly: account deletion, privacy/terms placeholders, icons/splash, Sentry wiring, EAS profiles for TestFlight / Play internal. Store listings, real builds and the store checklist need the owner's developer accounts — see [`docs/store-checklist.md`](docs/store-checklist.md). |

Owner inputs still needed (PRD §16): `DATA_REGION`, legal review of health-data scope, PayTabs credentials, WhatsApp
Business account + template approvals, Apple/Google developer accounts, privacy/terms text, final SAR/AED prices and
Caregiver price rules, the Barr help-line number, and approval for paid services (Twilio for SMS/calls, Sentry).
