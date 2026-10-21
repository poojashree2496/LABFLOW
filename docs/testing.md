# Testing and the Test Lab

Everything here runs on a laptop with no Google account. The tests load the **real** `src/*.gs` files, so they exercise the production code, but Google's services are replaced by fakes written for this project. They prove the logic. They do not prove how Google behaves; that list is in [TEST_PLAN.md](../TEST_PLAN.md) section B.

## Commands

| Command | What it runs |
|---|---|
| `npm install` | Dependencies (Node 18 or newer) |
| `npm run build` | Vendored libraries and compiled Tailwind into `src/Styles.html` |
| `npm run lint` | Syntax check of every `.gs` (as a plain V8 script) and every inline `<script>` in the `.html` files |
| `npm test` | All backend tests, `node --test test/*.test.js` |
| `npm run check` | `lint` then `test` (run this before every commit) |
| `npm run sim` | The scripted scenarios in `dev/scenarios.js` (27 of them) |
| `npm run dev` | The local server at `http://localhost:8787/` with the Test Lab at `/lab` |
| `npm run e2e`, `e2e:issue`, `e2e:projects`, `e2e:openlab`, `e2e:work`, `e2e:hod`, `e2e:reports`, `e2e:live`, `e2e:autoclose` | Playwright browser suites (need Chrome or Chromium; set `CHROMIUM_PATH` to use another browser). Screenshots go to `.build/shots` |

## How the backend tests work

- `test/harness.js` loads the `.gs` files in order into a Node `vm` context together with fakes of `SpreadsheetApp`, `CacheService`, `LockService`, `PropertiesService`, `Utilities`, `MailApp`/`GmailApp`, `DriveApp`, `DocumentApp`, `ScriptApp` and `Session`. The fake sheet enforces the real grid limits (a write wider than the sheet throws).
- `test/fixtures.js` `world()` builds a ready lab: admin, staff, faculty, HOD, students, a course, a timetable slot and a kiosk. The clock starts on Wed 2026-10-14 10:00 IST and moves only when a test calls `w.advance(ms)` or sets it. Helpers: `w.ok(email, action, payload)`, `w.err(...)`, `w.checkin(student)`, `w.eval(js)`.
- Tests go through `rpc` like a browser would, so role checks, rate limits and validation are exercised too.

## Test files

| File | Covers |
|---|---|
| `foundation` | Time, bytes, CSV safety, validators, the `Db` layer, locks, audit chain, settings |
| `access` | Identity, role matrix over every route, kiosk-only access, payload limits, last-admin rule, HOD read-only sweep |
| `api` | Hosted app sign-in and sessions, student import and disable |
| `attendance`, `checkin`, `scanning` | Both modes, replay and races, revocation, rescans, spot checks, corrections, 60-student rush, class representatives, events, live board basics |
| `openlab`, `work-selection` | Daily open-lab sessions and closing, project and system selection |
| `inventory`, `workflow-audit` | Loans, kits, bookings, waitlist, reports basics, recovery of interrupted returns and races |
| `projects`, `reports`, `hod` | Project lifecycle, report numbers and exports, department scope |
| `platform`, `jobs` | Onboarding, settings, themes, triggers, nightly and morning jobs, email, backups |
| `crypt`, `roll` | Mobile-number encryption and reveal, roll-number parsing |
| `archive` | Yearly archive |
| `contracts`, `dev-world` | Frozen schema/route contracts, Test Lab demo data |

[traceability.md](traceability.md) maps each requirement to the tests above.

## Scenarios

`dev/scenarios.js` replays the attacks from the SRS (section 15.4) and everyday flows step by step in a fresh world, with the expected and the actual outcome of each step. `npm run sim` prints them; the Test Lab runs them with the pipeline faults you have switched on.

## The Test Lab

Run `npm run dev` and open `http://localhost:8787/lab`. It runs the real server code against in-memory fakes:

- **Overview**: choose a preset (12, 30 or 60 students) and **Rebuild world** to reset the demo data. The Intel Unnati AI Lab preset is described in [unnati-demo.md](unnati-demo.md).
- **Stage (simulate a class)**: a kiosk and student phones side by side, with a QR relay and simulated GPS.
- **Verification pipeline**: switch an individual check off (fault injection) and watch the live trace to see which attack it let through.
- **Scenario runs**: run the scripted scenarios.
- **Site themes**: switch the theme live. **Data and mail**: look at the sheets and the emails that would have been sent.

The demo lives only in memory. Restarting the server discards it, and nothing is written to Google.

## What is not covered

Safari and Firefox, a real screen reader, real PDF output, real `LockService` contention, quotas and latency. See TEST_PLAN sections B and C.
