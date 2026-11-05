# Store submission checklist (M5)

Status legend: ✅ done in repo · ⏳ needs owner input/accounts · 🔲 to do once builds run

## Both apps
- ✅ App icons + splash (`apps/mobile/assets`, placeholders in brand colours — replace with final artwork)
- ✅ Bundle IDs: `app.barr.family`, `app.barr.field`
- ✅ In-app account deletion (family app → Account → Delete my account) — required by Apple 5.1.1(v) and Google Play
- ✅ Privacy policy + terms screens (placeholder text) — ⏳ final text and public URLs for the listings
- ✅ Permission strings in Arabic and English (location only at check-in/out; camera for consented visit photos)
- ✅ No background location; no ad SDKs; no tracking → App Privacy "Data not used to track you"
- ✅ Crash reporting wired (Sentry), off until DSN provided — ⏳ decide Sentry vs self-hosted
- ✅ EAS build profiles: `family-preview`, `field-preview` (internal distribution), `*-production` (store)
- ⏳ Apple Developer account, App Store Connect app records (`ascAppId` in `eas.json`)
- ⏳ Google Play Console, internal testing track, upload key
- ⏳ EAS project IDs (`EAS_PROJECT_ID_FAMILY`, `EAS_PROJECT_ID_FIELD`) for push credentials
- 🔲 `eas build --profile family-preview --platform all` → TestFlight + Play internal testing
- 🔲 Store listing text (AR + EN), screenshots (6.7" iPhone, Android phone), category: Medical? → **use "Lifestyle" or "Health & Fitness"**; Barr is a care service, not a medical device and not insurance
- 🔲 Data safety form (Play) / App Privacy (Apple): phone number, name, approximate location (staff check-in only), photos (consented), health info limited to vitals/medicine adherence

## Family app specifics
- ✅ Sign in with Apple offered on iOS whenever Google is offered (Guideline 4.8)
- ✅ Payments are for a real-world service → external payment (PayTabs hosted page) is allowed; no in-app purchase needed (Guideline 3.1.3(e) / Play "physical services")
- ⏳ Google OAuth client IDs (iOS, Android, web)

## Field app specifics
- ✅ Staff-only sign-in (no self-registration); reviewer demo account needed → ⏳ create a review staff account with a fixed number
- 🔲 "Unlisted" / private distribution may be preferable on iOS (Apple Business Manager) — owner decision
