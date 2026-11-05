# Mobile E2E flows (Maestro)

These encode the three §13 end-to-end journeys. They need a device/simulator, so they are **not run in CI yet**
(CI runs the backend integration tests that cover the same flows at the API level, plus mobile typecheck,
outbox unit tests and JS bundling for iOS and Android).

```bash
maestro test apps/mobile/e2e
```
