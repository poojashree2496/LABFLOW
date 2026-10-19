# LABFLOW test plan and results

Latest local run (2026-10-19): `npm run check` passed 276 backend tests and `npm run sim` passed 27/27 scenarios. Brave/Chromium passed 85 general browser checks, 33 focused issue checks, 27 project checks, 15 open-lab checks, 23 work-selection checks, 15 automatic sign-out checks, 26 live-board checks and 17 report checks. All services remain in-memory fakes; see [workflow audit](docs/workflow-audit.md) for the backend fixes and their limits.

## A. What actually ran

| Suite | Command | Result |
|---|---|---|
| Syntax lint of every `.gs` (as plain V8 scripts) and every inline `<script>` in `.html` | `npm run lint` | all files ok |
| Backend and Test Lab seed: foundation (16), access (16), attendance (31), checkin (21), scanning (9), inventory (21), jobs (33), platform (14), api (7), dev-world (3), workflow-audit (29), contracts (3), projects (14), openlab (16), work-selection (19), reports (16), hod (8) | `npm test` | **276 pass, 0 fail** |
| Scripted local scenarios | `npm run sim` | **27 of 27 pass** |
| Browser E2E (Playwright, Brave/Chromium) | `npm run e2e` with `CHROMIUM_PATH` | **85 pass, 0 fail** |
| Focused issue E2E (Playwright, Brave/Chromium) | `npm run e2e:issue` with `CHROMIUM_PATH` | **33 pass, 0 fail** |
| Focused project E2E (Playwright, Brave/Chromium) | `npm run e2e:projects` with `CHROMIUM_PATH` | **27 pass, 0 fail** |
| Focused open-lab E2E (Playwright, Brave/Chromium) | `npm run e2e:openlab` with `CHROMIUM_PATH` | **15 pass, 0 fail** |
| Focused reports E2E (Playwright, Brave/Chromium) | `npm run e2e:reports` with `CHROMIUM_PATH` | **17 pass, 0 fail** |
| Focused live-board E2E (Playwright, Brave/Chromium) | `npm run e2e:live` with `CHROMIUM_PATH` | **26 pass, 0 fail** |
| Focused automatic sign-out E2E (Playwright, Brave/Chromium) | `npm run e2e:autoclose` with `CHROMIUM_PATH` | **15 pass, 0 fail** |
| Focused work-selection E2E (Playwright, Brave/Chromium) | `npm run e2e:work` with `CHROMIUM_PATH` | **23 pass, 0 fail** |

How the backend tests work: `test/harness.js` loads the real `src/*.gs` files into a Node `vm` with hand-written fakes of SpreadsheetApp, CacheService, LockService, PropertiesService, Utilities, MailApp/GmailApp, DriveApp, ScriptApp and Session. The fakes are as faithful as I could make them, but they are my interpretation of Google's behaviour.

What the backend tests cover: schema creation and mismatch refusal; role routing and denial for each role; unauthenticated and wrong-domain refusal; kiosk-only access; rate limit; payload size limit; registration challenge and in-person approval for second/replacement devices; QR validity (bad signature, tampered token, expired, wrong lab, wrong session, wrong student, revoked credential, replay, concurrent duplicate); exit handling (missing class exits only credit verified presence; open labs credit to automatic closing); rescans and spot checks; corrections, voids and admin approval of old corrections; student history including an open session; timetable conflict detection; loans, kits, reservations, idempotent issue/return and reconciliation; booking capacity; audit chain tamper, truncation and head rewrite; the four trigger handlers, their minimum intervals and the email digest/transport switch; CSV formula neutralisation.

What the E2E covers (browser against the real server code on fakes): student device registration with real WebCrypto and server-side P-256 verification, key-storage compatibility check, faculty opens session, QR render and countdown, kiosk accept and replay refusal, student phone confirmation, live roster, spot check, exit scan, advance booking, research-visit approval, staff issue and return, booking approval, all 14 admin pages load, no horizontal scroll at 390 px (using `scrollWidth`), a student calling an admin action is denied by the server, no unlabeled controls on the admin page, no console errors. Every site theme (10) is switched on in turn: student (390 px phone), faculty, admin, kiosk and the hosted sign-in screen must render with no sideways scroll, and the kiosk QR and every element above it must carry no transform, filter, blend mode, clip or opacity, so no theme can make the code unscannable.

Focused issue coverage includes detaching requests after lab/borrower changes; delayed booking, equipment and kit responses; missing and extra request quantities; strict numeric and combined-stock validation; multi-unit and oversized kits; the 390 px phone layout; early booking collection and exact reserved units; booking-end due dates; opening an issued loan directly for return; and identical retries after a server-committed checkout loses its confirmation. A definite refusal allows correction, while an earlier uncertain outcome keeps the original payload frozen.

Project coverage includes creation, group leadership and membership, scoped reads and denied writes, active supervisors, valid timelines, safe result links, supervisor/coordinator decisions, outcome submission, stale-review refusal, acceptance, audited notifications and idempotent retries. The focused browser suite also checks navigation and layout at 390 px, literal rendering of HTML-like titles, and a server-committed creation whose confirmation is lost. HOD reads are tested with a supplied scope; the real shared scope helper is still task B3. See [Projects](docs/projects.md).

Open-lab coverage includes opt-in lab settings, required opening hours, daily idempotent sessions, exact opening/closing entry gates in both QR modes, roster-free walk-ins, class/event coexistence, class prefill, delayed triggers, configuration changes and a separate monthly report bucket. Browser checks exercise settings, QR/GPS entry and exit, 390 px layout, late-entry refusal and disabling walk-ins. Automatic sign-out coverage includes exact/delayed closing, early manual closure, mixed/three automatic missed exits, last-minute entries, workstation release and interruptions before/after event, session, audit, summary, flag and completion writes. The focused browser suite checks credited time, automatic-exit badges/totals/details and phone layout. See [Daily open lab](docs/openlab.md).

Project/system selection coverage includes pending projects, group/owner/lab checks, required projects at open-lab kiosk entry, workstation flags, busy/reserved systems, exact named bookings, mid-visit WORK events, unchanged attendance minutes and exit gaps, stale visit/version rejection, idempotent updates, VOID derivation, and both QR modes. Browser cases exercise category editing, project/system entry, unavailable choices, lost-response recovery, booked-system preselection and 390 px layout. See [Project and system selection](docs/work-selection.md).

Unnati demo seed checks run all three presets: marked placeholder inventory, individually tracked workstation categories, distinct current system/project claims, valid pending/active projects and entry times before the initial clock. The seeded visits are also closed and reopened through the production attendance workflow. Browser inspection verified the student phone layout, admin placeholder labels and simulated Unnati GPS selection. See [Unnati demo](docs/unnati-demo.md).

Live-board coverage includes effective current visits, WORK/VOID changes, departures and delayed automatic closing, workstation/booking status, unavailable assets, role denial, HOD scope and anonymous public responses. Browser checks cover shared navigation, lab/search filters, automatic refresh, safe literal rendering, phone layout and table-scroll preservation, error recovery and clearing previous identities after a refused refresh. HOD still depends on B3; see [Live board](docs/live-board.md).

Report coverage includes verified-time partitioning across work changes, re-entry/day counts, voids, breaks, missing exits/rescans, automatic close, overnight clipping, contextual reservations/loans, historical summary fallback, faculty scope and CSV/PDF export. Browser checks cover lab/system selection, stale asset responses, student lookup/totals, supervised projects, safe text rendering, CSV downloads and student home/report screens at phone width. See [Reports](docs/reports.md).

## B. NOT tested: needs a real Workspace deployment

Run these after deploying; each is a pass/fail check.

| # | Check | How | Why it matters |
|---|---|---|---|
| 1 | Identity for both domains | Open the app as an ordinary user from `karunya.edu` and from `karunya.edu.in` | `getActiveUser()` may be blank for users outside the deployer's Workspace domain. See README. **Highest risk.** |
| 2 | `setupInitialise`, `setupBootstrapAdmin`, `setupSelfTest` | Run from editor, read the output | Real sheet latency, lock time, P-256 verify time on the real runtime |
| 3 | Triggers | `setupInstallTriggers`, then check the Triggers page after a day | Handlers named `trg_*` should work; confirm they ran (admin "Audit & system" > health) |
| 4 | Key persistence in the HtmlService iframe | Register on an Android Chrome phone and an iPhone Safari; close the browser, reopen, generate a QR | IndexedDB in the sandboxed iframe may be partitioned or evicted |
| 5 | Camera/scanner | Kiosk with a USB scanner; kiosk with camera mode in Chrome | `getUserMedia` inside the iframe needs the camera permission policy to allow it |
| 6 | Real scan latency | 30 students scanning within 2 minutes | Lock contention, `rpc` latency (each call is hundreds of ms in Apps Script) |
| 7 | Quotas | One day of email digests plus a PDF report | MailApp/Gmail daily limits, Drive and Docs quotas |
| 8 | Audit anchors | Confirm the anchor email arrives and is archived by someone other than the owner | Required for the audit chain to mean anything |
| 9 | Colour, fonts, layout on real phones | Visual check of each site theme the department might pick; scan the kiosk QR with a real phone under each | Google Fonts load from CDN; only the active theme's fonts are fetched |
| 10 | Accessibility with a screen reader | NVDA or VoiceOver pass through the student and kiosk flows | Automated check covers only unlabeled controls |
| 11 | Physical controls dry run | A real session with a rescan, a spot check and a deliberate relay attempt | Measures whether the controls catch what the design claims |

## C. Known gaps in automated coverage

The staff return flow now also checks individually tracked consumption is disabled; excess, negative, fractional and incomplete numbers are refused locally; live remaining balances; a 390 px phone layout; a server-committed return whose confirmation is interrupted; retry with the identical payload and request key; and return-all after a partial return.

- No frontend unit tests; the UI is covered only by the E2E flow. Admin pages are checked for loading, not for every form.
- The E2E uses Chromium only. Safari/Firefox are untested.
- PDF report generation is exercised against the fake DocumentApp/DriveApp, so real PDF output has not been seen.
- No load test, and no test of the real `LockService` timeout behaviour.
