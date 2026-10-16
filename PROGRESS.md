# Progress

## Done
- Data layer on Sheets with schema, locks, idempotency; settings, audit chain with checkpoints.
- Auth (fail-closed), roles, rate limits, payload limits, one `rpc` gateway.
- Device-bound ECDSA reverse-QR attendance, kiosk scanning, rescans, spot checks, exits, corrections with approval, device-swap approval.
- Sessions, timetable with conflict detection, labs, courses, rosters.
- Inventory, kits, loans, reservations, bookings, research visits, reconciliation.
- Reports (CSV, PDF), four time-driven jobs, email digest.
- Student, faculty, staff, admin and kiosk UIs; light/dark; mobile layout.
- 94 backend tests and 35 browser checks pass on fakes.
- README, SECURITY, TEST_PLAN.

## Not done / needs you
- Deploy and run the checks in TEST_PLAN section B (identity for both domains first).
- No `Setup.benchmarkScans`; no frontend unit tests; no Safari/Firefox E2E.
- Optional hardening: WebAuthn if the UI can be served from your own origin; `EMAIL_TRANSPORT=mail` to drop the broad Gmail scope.
