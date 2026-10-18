# Progress (what has been done)

The record of finished work, newest first, and the current state of the project. Open work is in [tasks.md](tasks.md).

**Rules:** add an entry in the same commit as the change. Say what ran and the result. "Done" here means built and passing the automated tests on in-memory fakes of the Google services. Anything that needs a real Workspace is not done until it is listed under "Deployment results" with a date.

## Current state (2026-10-18)

- Latest local checks: **167 backend tests pass**, **27 of 27 scenarios pass**; lint passes. The browser suite passes **83 checks**, including the staff return improvements (Brave/Chromium against local fakes). See [workflow-audit.md](workflow-audit.md) for the earlier backend audit.
- Code is in `poojashree2496/LABFLOW` on `main`.
- Never run against a live Google account.
- The SRS is `docs/SRS - Real-Time Lab Monitoring & Attendance System (Team NULL).pdf`.

## Deployment results

None yet. Record each check from tasks.md section 1 here with date and outcome.

| Date | Check | Result |
|---|---|---|
| | | |

## What is built

**Foundation**
- Sheets data layer: schema creation, header-mismatch refusal, text-format columns, locks, idempotency keys, additive schema migration
- Settings stored in PropertiesService with validated ranges
- Hash-chained audit log with checkpoints (sheet, script property, emailed anchors)
- Single `rpc` gateway: role check, rate limit, payload size limit, error shapes

**Auth and roles**
- Fail-closed identity; both Karunya domains accepted in code
- Student, faculty, staff, admin, kiosk roles enforced on the server
- Privacy notice on first login (DPDP), mobile number, roll number taken from the email and locked
- Student verification by staff or admin; in-person approval for any second or replacement device

**Check-in, both versions from the SRS**
- Version A (the specification's flow): the lab kiosk shows a QR that rotates every 5-10 s; the student's phone camera opens the app with the code; the code is checked the moment the page opens and the student gets a 2-minute pass; one GPS reading is checked against the lab geofence with the reported accuracy allowed for. Coordinates are never stored (FR-7 to FR-17, FR-31).
- Version B: device-bound ECDSA key (WebCrypto in the browser, P-256 verified on the server); the phone re-signs a server nonce every 3 s; the QR is a link that the teacher's, lab staff's, class rep's or coordinator's phone opens, or the kiosk scanner reads (USB scanner, camera, paste box).
- Check-in mode per lab (A, B or both), with a default in Settings.
- Both modes run as traced verification pipelines (ordered named steps; the replay check and the write run inside the lock). Expiry, single use, replay refusal, concurrent duplicates.
- Rescans, spot checks, exit scans, "exit not scanned" handling; corrections, voids, admin approval of old corrections.
- Entry reasons with timetable prefill. Self-work sessions behind workstation bookings. Research visits open on arrival. Timetabled classes open by themselves.
- Flags for review: impossible GPS accuracy, identical readings, impossible travel between labs, replayed or stale codes, two students on one phone, desktop device registration, frequent manual check-ins, repeated missing exits.
- Live roster and live occupancy on every dashboard; student history including open sessions.

**People and events**
- Class representatives: session operator, scan classmates (session-only, roster-only, never themselves, tagged).
- Events: registration list or open to all, lunch break excluded from hours, capacity warning, coordinator rights that expire, guests.

**Sessions and timetable**
- Sessions across labs, open/close/cancel, auto-close job
- Timetable with faculty and lab conflict detection and admin override
- Labs (with geofence and lab hours, overstay alerts at closing), courses, rosters, faculty-course mapping

**Inventory and bookings**
- Assets, categories, kits, CSV import, condition checks, history
- Issue/return with idempotency, reservations, overdue handling, reconciliation
- Equipment requests need an active check-in (FR-21) and are filled on the issue screen; students see availability without checking in
- Advance bookings with capacity check and staff approval; workstation no-show released after 15 minutes, used slots counted

**Reports and jobs**
- Evening per-lab digest with PDF to lab incharges, monthly audit on the 1st to the HOD, custom range, session log, ERP export with fixed columns, PDF from a Docs template; CSV formula-injection safe
- Four time-driven jobs; admin quota-usage panel

**UI**
- Screens for every role, including the kiosk display / scanner / split view, the phone scanner with photo, flags review, events, class reps and lab geofence editing. Light/dark; no horizontal scroll at 390 px; loading, empty and error states.
- Ten site themes, chosen by the administrator in Settings > Appearance and applied to every user, the kiosks and the sign-in screen. Each one changes the layout as well as the look: Karunya (the default), neo-brutalism, pixel art, wabi-sabi, cybercore, maximal library, scrapbook, post-internet, luxury type and bohemian. Only the active theme's fonts load. No theme may restyle a QR code or the camera preview.

**Hosted app**
- Google sign-in, signed LABFLOW sessions and a JSON API to the Apps Script backend, served as an installable app from Vercel.

**Test Lab (`npm run dev`, then /lab; local only)**
- Seeded department world and a simulated clock; trigger jobs on demand.
- Pipeline fault injection with live step traces.
- 27 scripted scenarios: the class rush and every SRS 15.4 attack.
- Stage with the kiosk and two phones side by side, a QR relay and simulated GPS.
- A site-theme switcher with a live preview as any role, and data/mail/audit browsers.

**Docs**
- README, SECURITY, TEST_PLAN, docs/tasks.md, docs/progress.md, the SRS PDF

## Log

| Date | What changed | What ran |
|---|---|---|
| 2026-10-18 | Fixed stale equipment issue context: changing lab/borrower detaches the prior request; the preselected borrower loads bookings; old student, booking, equipment and kit responses cannot replace newer selections. Added the focused `e2e:issue` command. | `npm run check`: lint and 167 backend tests passed. `CHROMIUM_PATH=… npm run e2e:issue` with isolated Brave: 7 checks passed. `git diff --check`: passed. |
| 2026-10-18 | Improved the staff return screen with live per-item and whole-loan balances, local quantity validation, disabled consumption for individually tracked equipment, a return-all shortcut, and frozen payloads for retry after uncertain submission outcomes. Added eight browser checks and tracking-mode assertions in the inventory test. | `npm run check`: lint and 167 backend tests passed. `npm run sim`: 27/27 passed. `CHROMIUM_PATH=… npm run e2e` with Brave: 83 passed, 0 failed; mobile return form visually inspected. `git diff --check`: passed. |
| 2026-10-18 | Merged the critical workflow audit with the Test Lab seed and QR fixes; reran the browser suite the audit could not run | `npm run check`: lint passed; 167 tests passed. `npm run sim`: 27/27 passed. `npm run e2e`: 75 passed |
| 2026-10-17 | Critical workflow audit: locked scan authorization/freshness checks, named-asset booking protection, pre-write fulfilment validation, issue rollback for linked requests, durable return recovery, serialized device rejection/revocation, registration expiry recheck, current-entry correction validation and booking retry at limits; 29 regression cases. Details in [workflow-audit.md](workflow-audit.md). | `npm run check`: lint passed; 167 tests passed. `npm run sim`: 27/27 passed. `git diff --check`: passed. Browser suite could not start: missing `playwright-core`. |
| 2026-10-17 | Expanded the local Test Lab seed with live attendance, a pending student and research request, equipment request, flagged check-in, spot check, current/overdue loans, booking states and workshop registrations; made historical GPS sample points deterministic; documented the demo and added a seed regression test | `npm run check`: lint passed; 138 tests passed |
| 2026-10-17 | Verify button on the admin Students table; `setupBenchmarkScans` editor wrapper; merged root `PROGRESS.md` into these two files and corrected the counts; SRS PDF into `docs/` | `npm run check`: 137 pass; `npm run e2e`: 74 pass |
| 2026-10-17 | Split tracking into `docs/tasks.md` (to do) and `docs/progress.md` (done) | docs only, no code change |
| 2026-10-17 | Ten site themes; every theme checked in the browser; Test Lab theme switcher | `npm run check`: 136 pass; `npm run e2e`: 74 pass |
| 2026-10-16 | Version A kiosk QR + GPS check-in, both modes as pipelines, events, class reps, flags, equipment requests, SRS reports, Test Lab, hosted app on Vercel | `npm run check`, `npm run sim`: 27 of 27, `npm run e2e` |
| 2026-10-14 | Frontend for all roles, kiosk, dev server, browser E2E, README/SECURITY/TEST_PLAN; device-swap approval; student history for open sessions | `npm run check`: 94 pass; `npm run e2e`: 35 pass |
| 2026-10-14 | Backend: data layer, auth, attendance, sessions, inventory, bookings, reports, triggers | backend tests |
