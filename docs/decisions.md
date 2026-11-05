# Barr — decision record

Each entry: the choice, why (against PRD §4 scalability/maintainability), and what would make us revisit it.

## D1. Stack: TypeScript end to end, one pnpm monorepo
- `packages/shared` — zod schemas (shared client/server validation), business rules (status, timers, pricing, permissions, geofence, vitals), i18n (AR/EN incl. notification templates), design tokens, ReportGenerator.
- `backend` — Node 22 + Fastify 5 + `pg` (plain SQL), `apps/dashboard` — React 19 + Vite, `apps/mobile` — Expo SDK 58 (React Native 0.88).
- **Why:** one language and one set of types/validators across all three surfaces; business rules are pure functions tested once and reused by the API, the field app (instant geofence/vitals feedback) and the dashboard. Plain SQL keeps RLS, partial indexes and locking explicit and reviewable.
- **Revisit if:** query volume makes a query builder/ORM worth it (Kysely would fit without changing the schema).

## D2. Native apps: one Expo codebase, two store apps (Family, Field)
- `APP_VARIANT=family|field` in `app.config.ts` → separate bundle IDs (`app.barr.family`, `app.barr.field`), names, icons, permissions. Routing inside the app is role-based (staff → field screens, family → family screens).
- **Why:** families and staff are different audiences: the Field app needs camera + location permissions and staff-only sign-in, the Family app needs Sign in with Apple/Google and must not show staff tooling or ask for location. Two listings keep store review and permission prompts clean, while one codebase keeps maintenance at "one app". Expo/EAS gives OTA updates, TestFlight / Play internal tracks, and runs well on low-end Android (Hermes, new architecture).
- **Revisit if:** the two experiences diverge so much that shared code drops below ~50%.

## D3. Database: PostgreSQL 16 with row-level security
- Tables are owned by `barr_owner` (migrations). API and worker connect as `barr_app` (no BYPASSRLS). Every request runs in a transaction that sets `barr.user_id`/`barr.roles` (`Db.as`), jobs/webhooks set `barr.system` (`Db.system`). Policies call `barr_can_access_parent()` (family membership, pod coordinator, active staff assignment, on-call doctor during an open escalation, admin).
- Defence in depth: API capability checks (`can()` in shared) **and** RLS. A forgotten `WHERE` cannot leak another family's data; integration tests run as the RLS-bound role.
- Additional DB-level guarantees: unverified staff cannot be assigned to visits (trigger, F4); visit photos require photo consent (trigger, F15); pass-through charges are `at_cost` (check); closing an escalation requires a note (check); audit log is append-only for the app role.
- Every operational table carries `city_id` + `pod_id`; list/timeline/queue queries are indexed and paginated (keyset for the timeline).
- **Managed hosting:** any managed Postgres 14+ (RDS, Cloud SQL, Azure, Supabase…) in `DATA_REGION` (CONFIG). Nothing region-specific in code.

## D4. Job queue: Postgres-backed queue (own, ~150 lines) instead of Redis/BullMQ or pg-boss
- `jobs` table with `dedupe_key UNIQUE` (idempotent enqueue), `run_at`, retries with exponential backoff, dead-lettering, stale-lock reaping, `FOR UPDATE SKIP LOCKED` claiming (many workers safe). Cron specs enqueue one job per period (dedupe), and nightly jobs **fan out** per parent so each unit is small and retry-safe.
- **Why:** (1) `enqueue()` runs in the same transaction as the domain change — an escalation and its 2-min/15-min timers commit together or not at all; (2) the clock is injected, so the escalation/missed-dose/retry timers are tested deterministically to the second; (3) no extra infrastructure for a two-person team; (4) the dashboard "Jobs" view is a SQL query. At 100k visits/month we expect < 1M jobs/month — comfortably within Postgres.
- **Revisit if:** sustained > ~200 jobs/s; swap the `Worker` implementation (interface is small).

## D5. Auth
- Phone + SMS OTP (codes hashed, 10-min expiry, 5 attempts, 5 codes/hour/phone), Google and Apple ID tokens verified against JWKS. Accounts can link phone + Google/Apple. Unknown numbers self-register as **family only**; staff are created by an admin and must verify by phone.
- Access JWT (15 min) + rotating refresh tokens stored hashed; reuse of an old refresh token revokes the session. Every request checks the session row, so admin offboarding takes effect **immediately**.
- Phones stored E.164 (libphonenumber; Gulf + Egypt), encrypted (AES-256-GCM) with an HMAC blind index for lookup.

## D6. Offline field capture and sync
- Field app keeps an **outbox** in SQLite; each op (check-in, check-out, report, dose confirmation) gets a client UUID at capture time and carries the capture timestamp and GPS. `POST /field/sync` applies ops in order, each in its own transaction, recorded in `sync_ops` → retries never double-apply.
- Conflict policy: first accepted report wins; a different later report for the same visit is returned as `conflict` and shown to the staff member (never silently overwritten). Earliest check-in wins. Explicit check-out is authoritative over the report time.
- Photos are compressed on device, uploaded with short-lived signed PUT URLs before the report op, and never re-uploaded after partial progress (unit tested).
- Visit packages (template, consent, address, today's doses) are pre-cached when online so a visit works with no signal.
- No background location: location is read only at check-in/out (PRD §3.7).

## D7. Providers behind interfaces (switch by config)
| Interface | V1 adapter | Dev/test | Later |
| --- | --- | --- | --- |
| `PaymentProvider` | **PayTabs** (hosted page + tokenisation, recurring token charges, refunds, signed callbacks) | `FakePaymentProvider` | Tap Payments |
| `MessagingProvider` (WhatsApp) | **Meta Cloud API directly** (pre-approved templates `barr_<type>`, webhook signature check, delivery/read statuses) | `RecordingChannel` | BSP if needed |
| `SmsProvider` / `CallingProvider` | Twilio (SMS + voice call to on-call doctor) | `RecordingChannel` | local Egyptian provider |
| `PushProvider` | Expo Push | `RecordingChannel` | FCM/APNs direct |
| `StorageProvider` | S3-compatible (signed URLs ≤ 15 min, SSE) | local signed URLs | — |
- **Meta Cloud API directly** for WhatsApp: no BSP margin, templates managed in Meta Business Manager; the interface allows a BSP if approvals or support become a problem.
- Twilio is the only paid service selected by default for SMS/calls; **owner approval is required before enabling it** (PRD §0). Until then `console` adapters are used and the backend logs the message.

## D8. Notifications
- `notify()` writes one `notifications` row per recipient per channel (dedupe key → idempotent) and enqueues a send job. Delivery status is updated from provider webhooks. Families get push, plus WhatsApp only with recorded opt-in. Escalation types cannot be turned off; staff escalation pages fall back to SMS when push fails.
- Templates live in `packages/shared/i18n/notifications.ts` (AR + EN) and can be overridden from the dashboard (`notification_templates`).

## D9. Reports
- `ReportGenerator` interface (`generate(parentId, period, inputs) → {payload, text_ar, text_en, generator}`). V1 = `template_v1`, deterministic. Every report stores the generator name and the full structured input, so an AI generator can be added and compared later without schema changes.
- PDFs (invoices, monthly reports) are rendered from HTML by headless Chromium: it shapes Arabic and handles RTL correctly (PDFKit-style libraries do not).

## D10. Real-time
- F2/F3 require updates within a minute. V1: the visit-report push notification triggers a refetch, and the home/status screens poll every 30 s while visible (stateless servers, no sticky connections). Measured path: report is queryable immediately after sync.
- **Revisit if:** load from polling matters → add SSE backed by Postgres LISTEN/NOTIFY.

## D11. Analytics
- First-party `analytics_events` table (no third-party SDKs, no ad IDs). Events cover every §14 metric; the dashboard **Metrics** page computes them in SQL. Can be exported to a self-hosted PostHog/Plausible later.

## D12. Crash reporting
- Sentry React Native SDK, disabled until `EXPO_PUBLIC_SENTRY_DSN` is set; `sendDefaultPii: false`. (Sentry is a paid service above the free tier → owner decides; self-hosted Sentry/GlitchTip are drop-in.)

## D13. Health-data minimisation (§8)
- Stored: identity/contact (encrypted), address (encrypted) + home pin, language, carer preference, medicines + dose events, vitals, structured observations, short notes (length-limited), allergy flag + ≤ 300-char text, consented photos.
- Not stored: diagnoses, lab documents, prescription files, history narratives, ID images (verification is a dated checklist).
- The home pin (lat/lng) is kept unencrypted because the server computes the geofence and routes; it is only readable through RLS. Revisit after legal review.

## D14. Accessibility & colour
- Status is never colour-only: every status has a text label, an icon (✓ ◷ ⚠ …), and a distinct fill style (tinted / dashed outline / solid) with different luminance — readable for colour-blind users. Touch targets ≥ 44×44; dynamic type enabled (`allowFontScaling`, up to 2×); screen-reader labels on controls.

## D15. Fonts
- Latin: Domine (headings), Nunito Sans (body). Arabic: **IBM Plex Sans Arabic**. Bundled via `@expo-google-fonts/*` in the apps; Google Fonts in the dashboard.
