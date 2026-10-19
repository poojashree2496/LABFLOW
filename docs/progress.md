# Progress (what has been done)

The record of finished work, newest first, and the current state of the project. Open work is in [tasks.md](tasks.md).

**Rules:** add an entry in the same commit as the change. Say what ran and the result. "Done" here means built and passing the automated tests on in-memory fakes of the Google services. Anything that needs a real Workspace is not done until it is listed under "Deployment results" with a date.

## Current state (2026-10-19)

- Latest local checks: **252 backend tests pass**, **27 of 27 scenarios pass**; lint passes. The general browser suite passes **85 checks**, the focused issue suite **33**, the project suite **27**, the open-lab suite **15**, work-selection **23**, automatic sign-out **15**, and live-board **26** (Brave/Chromium against local fakes). See [workflow-audit.md](workflow-audit.md) for the earlier backend audit.
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
- Intel Unnati AI Lab demo in every preset: 30 marked placeholder systems, sample equipment/projects and three live system assignments; confirmed lab data still pending.
- Daily opt-in open labs, pending-project/system selection, mid-visit work changes and automatic sign-out at closing with resumable recovery and repeated missed-exit flags.
- Lab-wide live board with current student/project/system assignments, workstation availability, filters and automatic refresh; HOD scope remains B3.
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
- README, SECURITY, TEST_PLAN, CONTRIBUTING, docs/requirements.md (teacher brief v2), docs/tasks.md, docs/progress.md, the SRS PDF

## Log

| Date | What changed | What ran |
|---|---|---|
| 2026-10-19 | B4 screen complete: shared Live board for faculty/staff/admin/HOD, lab and register/name/project/system search, current visits and workstation statuses, automatic refresh, preserved phone table scrolling, safe text rendering and clearing old identities when refresh is refused. Existing dashboard landing pages and session roster remain separate. HOD access awaits B3 scope and shows a clear pending-configuration message. | `npm run check`: lint and 252 backend tests passed. `npm run sim`: 27/27 in the backend slice. Isolated Brave: general 85/85 and new `npm run e2e:live` 26/26. Phone screenshot visually inspected; `git diff --check`: passed. |
| 2026-10-19 | B4 backend: scoped current-visitor snapshots with effective project/system assignments, anonymous workstation availability, reservation holds and unavailable equipment, and read-time recovery of overdue open-lab closure. No names enter the public occupancy cache. HOD reads fail closed until B3 provides department scope. Board screen remains in progress. | `npm run check`: lint and 252 backend tests passed (nine new live-board cases). `npm run sim`: 27/27. `git diff --check`: passed. |
| 2026-10-19 | C5 demo seed: added Intel Unnati AI Lab as a fourth lab in every preset, 30 individually tracked workstations, two printers, two drones, six development boards, three pending/active projects and three checked-in students on separate systems. Synthetic GPS is selectable in the Test Lab; all unconfirmed values are marked as placeholders. Real location, hours and asset confirmation remains in C5. | `npm run check`: lint and 243 backend tests passed, including all presets and next-day visit recovery. `npm run sim`: 27/27. Isolated Brave general suite: 84/84. Additional browser inspection verified student phone layout, placeholder settings and Unnati simulated GPS; screenshots visually inspected. `git diff --check`: passed. |
| 2026-10-19 | C4 complete: automatic open-lab exits at scheduled closing (or actual early manual close), credited time and auto sign-out history badges/totals/details, combined repeated missed-exit flags and workstation release. Pending close journals recover partial writes even after the session is closed; classes retain existing exit policy. Archive coordination documented without changing `Attend.rebuildSummary`. | `npm run check`: lint and 241 backend tests passed (22 new closing cases). `npm run sim`: 27/27. Isolated Brave: general 84/84, open-lab 15/15, work-selection 23/23 and new `npm run e2e:autoclose` 15/15. Phone screenshot visually inspected; `git diff --check`: passed. |
| 2026-10-19 | C3 complete: pending-project and workstation pickers at open-lab kiosk entry, exact booked-system requirements, append-only versioned/idempotent WORK changes while inside, current work on Today, device-QR booked-system assignment followed by project selection after entry, and workstation category configuration. Rechecks busy systems and project eligibility under the write lock; only selected workstation bookings count as used. Automatic sign-out remains C4; live board remains B4. | `npm run check`: lint and 219 backend tests passed (19 new work-selection cases). `npm run sim`: 27/27. Isolated Brave: general 84/84, open-lab 15/15, new `npm run e2e:work` 23/23 including interrupted entry/work confirmations. Phone screenshot visually inspected; `git diff --check`: passed. |
| 2026-10-19 | C2 screens complete: lab editor opt-in and availability badge, explicit walk-in entry reason and Today guidance, updated scanner text, and daily open-lab integration notes. Automatic sign-out and project/system selection remain C4/C3. | `npm run check`: lint and 200 backend tests passed (16 open-lab cases). `npm run sim`: 27/27 in the backend slice. Isolated Brave: general suite 84/84; new `npm run e2e:openlab` 15/15 including real server entry/exit and closing-time refusal using the shared Test Lab clock. Phone screenshot visually inspected; `git diff --check`: passed. |
| 2026-10-19 | Isolated open-lab auto-opening failures so regular timetable sessions still open; reports the failure count and logs its cause. | `npm run check`: lint and 200 backend tests passed, including a simulated open-lab failure during the session tick. |
| 2026-10-19 | C2 backend: opt-in daily open-lab sessions with valid hours, idempotent nightly materialization, trigger and arrival-based opening, roster-free walk-in entry, separate openlab reasons/report bucket, class/event coexistence and fresh entry-hour checks for both QR modes. Scheduled hours refresh before opening; active sessions retain their original schedule. Configuration screen and check-in labels remain open; automatic sign-out remains C4. | `npm run check`: lint and 199 backend tests passed (15 open-lab cases). `npm run sim`: 27/27. `git diff --check`: passed. |
| 2026-10-19 | C1 screens complete: shared student, faculty, coordinator and super-admin project views, group-leader creation, timelines, approval/rejection, outcome submission and version-checked acceptance. Preserves uncertain creation payloads across retries and editor close/reopen while the page remains loaded. Added project integration notes; pending-project check-in integration remains C3 and HOD scope remains B3. | `npm run check`: lint and 184 backend tests passed. `npm run sim`: 27/27 (backend slice). Isolated Brave: `npm run e2e` 84/84, `npm run e2e:issue` 33/33, `npm run e2e:projects` 27/27. Phone screenshot visually inspected; `git diff --check`: passed. |
| 2026-10-19 | C1 backend: project creation, scoped lists/details, supervisor/coordinator decisions, versioned outcome submission and supervisor acceptance; active-group leader checks, pending-project eligibility, audited actions and notifications. Optional client-generated project ids make creation retries idempotent. HOD project reads depend on B3 department scope and fail closed until it is implemented. Student/faculty screens remain open. | `npm run check`: lint and 184 backend tests passed (14 project cases). `npm run sim`: 27/27. `git diff --check`: passed. |
| 2026-10-19 | S0: v2 contracts in code. Appended the agreed schema columns and the Projects table, `hod` role, `openlab` type, `PRJ` id prefix; every v2 route with its final roles, each handler a stub that answers `NOT_IMPLEMENTED` with its task id; new `ProjectService.gs` and `BackupService.gs` in both load orders; `Auth.canView`; HOD label and a placeholder HOD overview; HOD account in the test and dev worlds; `test/contracts.test.js` guards the contracts. | `npm run check`: lint and 170 backend tests passed. `npm run sim`: 27/27. `npm run e2e`: 83 passed. HOD page opened in Chrome via the dev server: renders the overview with live occupancy. |
| 2026-10-19 | Captured the course teacher's v2 brief as R1-R18 with status, decisions and frozen contracts (docs/requirements.md); split the work into WS-A/B/C plus shared tasks (docs/tasks.md); added CONTRIBUTING.md. Docs only. | `npm run check`: lint and 167 backend tests passed (no code changed). |
| 2026-10-18 | Preserved the complete issue payload while submitting or confirming an uncertain outcome; freezes editing until confirmation, retains the original request key across retries, and allows correction after a definite refusal. Refreshes collection guidance while the idle form remains open. | `npm run check`: lint and 167 backend tests passed. `npm run sim`: 27/27 passed. Isolated Brave: `npm run e2e` 83/83, `npm run e2e:issue` 33/33, including a real server-committed issue with interrupted confirmation and no duplicate loan. `git diff --check`: passed. |
| 2026-10-18 | Added booking collection details from the server-defined early-collection window, checklist validation for reserved resources and exact named units, booking-end due dates, and a success action opening the new loan for return. | `npm run check`: lint and 167 backend tests passed, including the collection-window assertion. `CHROMIUM_PATH=… npm run e2e:issue`: 26 checks passed with isolated Brave. `git diff --check`: passed. |
| 2026-10-18 | Added a live issue checklist for equipment requests and kits, strict quantity/combined-stock validation, extra-item warnings, separate picks for multiple individually tracked kit units, and a safe limit for oversized kits. | `npm run check`: lint and 167 backend tests passed. `CHROMIUM_PATH=… npm run e2e:issue`: 19 checks passed with isolated Brave, including phone layout and real kit checkout on fakes; checklist screenshot visually inspected. `git diff --check`: passed. |
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
