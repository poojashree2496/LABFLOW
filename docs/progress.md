# Progress (what has been done)

The record of finished work, newest first, and the current state of the project. Open work is in [tasks.md](tasks.md).

**Rules:** add an entry in the same commit as the change. Say what ran and the result. "Done" here means built and passing the automated tests on in-memory fakes of the Google services. Anything that needs a real Workspace is not done until it is listed under "Deployment results" with a date.

## Current state (2026-10-17)

- Automated tests at last update: **94 backend tests pass**, **35 browser checks pass** (real Chromium against the real server code, on fakes). Lint passes.
- Code is in `poojashree2496/LABFLOW` on `main`, up to the first release. Later doc-only commits (this file, tasks.md) are local until pushed.
- Never run against a live Google account.

## Deployment results

None yet. Record each check from tasks.md section 1 here with date and outcome.

| Date | Check | Result |
|---|---|---|
| | | |

## What is built

**Foundation**
- Sheets data layer: schema creation, header-mismatch refusal, text-format columns, locks, idempotency keys
- Settings with validated ranges
- Hash-chained audit log with checkpoints (sheet, script property, emailed anchors)
- Single `rpc` gateway: role check, rate limit, payload size limit, error shapes

**Auth and roles**
- Fail-closed identity; both Karunya domains accepted in code
- Student, faculty, staff, admin, kiosk roles enforced on the server

**Attendance**
- Device-bound ECDSA registration (real WebCrypto in browser, P-256 verified on server)
- Reverse QR: challenge, signature, HMAC token, expiry, single use, replay refusal, concurrent duplicates
- Kiosk scanning (USB scanner, camera, paste box)
- Rescans, spot checks, exit scans, "exit not scanned" handling
- Corrections, voids, admin approval of old corrections
- In-person approval for any second or replacement device
- Live roster; student history including open sessions

**Sessions and timetable**
- Sessions across labs, open/close/cancel, auto-close job
- Timetable with faculty and lab conflict detection and admin override
- Labs, courses, rosters, faculty-course mapping, research visit approval

**Inventory and bookings**
- Assets, categories, kits, CSV import, condition checks, history
- Issue/return with idempotency, reservations, overdue handling, reconciliation
- Advance bookings with capacity check and staff approval

**Reports and jobs**
- Daily, monthly, student and faculty reports as CSV and PDF, formula-injection safe
- Four time-driven jobs and a daily email digest

**UI**
- Student, faculty, staff, admin and kiosk screens; light/dark; no horizontal scroll at 390 px
- Loading, empty and error states; working search and filters

**Docs**
- README, SECURITY, TEST_PLAN, docs/tasks.md, docs/progress.md

## Log

| Date | What changed | What ran |
|---|---|---|
| 2026-10-17 | Split tracking into `docs/tasks.md` (to do) and `docs/progress.md` (done); removed root `PROGRESS.md` | docs only, no code change |
| 2026-10-14 | Added rate-limit test (94 backend tests total) | `npm run check`: 94 pass |
| 2026-10-14 | Frontend for all roles, kiosk, dev server, browser E2E, README/SECURITY/TEST_PLAN; device-swap approval; student history for open sessions; faculty roster label fix | `npm run check` 94 pass; `npm run e2e` 35 pass |
| 2026-10-14 | Backend: data layer, auth, attendance, sessions, inventory, bookings, reports, triggers | backend tests |
