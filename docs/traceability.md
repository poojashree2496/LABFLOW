# Traceability

Which tests cover which requirement. "R" numbers are the course teacher's brief of 19 Oct ([requirements.md](requirements.md) section 1). "FR" numbers are the functional requirements in the SRS PDF in this folder. A test is named by file and the start of its title; `npm test` runs them all. "Not covered" means nothing automated reaches it, usually because it needs a real Google deployment ([TEST_PLAN.md](../TEST_PLAN.md) section B).

## Brief (R1 to R18)

| # | Requirement | Backend tests | Browser and other | Not covered |
|---|---|---|---|---|
| R1 | Live count, systems, projects | `checkin`: live board (people, projects, systems, entry times; departure frees a system); `work-selection`: busy systems, mid-visit changes | `e2e:live`, `e2e:work` | Deployment |
| R2 | Remote live view | `checkin`: live board roles and anonymous responses; `access`: HOD reads | `e2e:live`, `e2e:hod` | Deployment |
| R3 | QR plus GPS check-in | `checkin`: happy path, geofence; `openlab`: verified walk-in | `e2e`, `e2e:openlab` | Real GPS at the door, camera in the iframe |
| R4 | Sign-out | `jobs`: open-lab closure (9 cases); `attendance`: automatic OUT; `checkin`: minimum gap | `e2e:autoclose` | Real trigger runs |
| R5 | Asset tracking | `inventory`: individual and counted assets, loans, kits, returns; `work-selection`: workstation flags | `e2e:issue` | |
| R6 | Queue by time | `inventory`: advance booking, capacity, waitlist (2 cases), no-show release | `e2e` (advance booking) | |
| R7 | Project, timeline, outcome | `projects` (14 cases); `reports`: project and system time | `e2e:projects` | |
| R8 | Intel Unnati AI Lab first | `dev-world`: Unnati seed in all three presets, visits close and reopen | Test Lab; live site runs the IBM CoE (DBMS) lab | Unnati location, hours, inventory (C5) |
| R9 | Students using the lab now | `checkin`: occupancy moves on IN and OUT | | |
| R10 | Register number: days and hours | `reports`: student totals, per-lab hours, re-entry, voids | `e2e:reports` | |
| R11 | System: people and purpose | `reports`: work changes partition system and project time; report roles | `e2e:reports` | |
| R12 | Regular lab: who is missing | `attendance`: happy path, summaries; `archive`: roster counts attended and absent | `e2e` (faculty live roster) | |
| R13 | Apps Script, HTML, Sheets | `foundation`: `Db` layer; `jobs`: `Setup.initialise`; `contracts`: schema and routes | | Real Sheets latency |
| R14 | Backups and archive | `jobs`: backup (7 cases); `archive` (8 cases) | | Real Drive copy and rotation |
| R15 | Encryption, access validation | `crypt` (11 cases); `access` (identity, role matrix, rate limit) | | Run `setupEncryptMobiles` on the real sheet |
| R16 | Roles | `access`: roles, role matrix, HOD read-only sweep; `hod` (4 cases); `api`: coordinator import, disable | `e2e:hod` | |
| R17 | Novel solution | `attendance`, `scanning`: device-signed QR, replay and relay controls | `npm run sim` (27 scenarios), Test Lab | Live relay and device-compromise limits are stated in SECURITY.md, not tested away |
| R18 | Register number format | `roll` (4 cases) | | |

## Functional requirements (FR-1 to FR-39)

| FR | Requirement | Where it is tested |
|---|---|---|
| 1 | Only the two Karunya domains | `access`: identity fails closed, wrong domain refused; both domains accepted |
| 2 | First login collects name, roll, email, mobile | `platform`: onboarding (FR-2, FR-3) |
| 3 | Roll number taken from email, locked, unique | `platform`: onboarding; `foundation`: unique columns; `roll` |
| 4 | Four roles | `access`: roles and labels; role matrix |
| 5 | Every server function checks the role | `access`: permission table, role matrix, unknown actions, `include()` whitelist |
| 6 | Only a super admin changes roles, audited | `access`: last administrator, role changes audited, bootstrap admin |
| 7 | Rotating kiosk QR | `checkin`: kiosk display (FR-7) |
| 8 | Scan opens the web app with the token | `checkin`: happy path |
| 9 | Token checked at open; two minutes to finish | `checkin`: happy path, code age and pass expiry |
| 10 | Token used once per student | `checkin`: one code serves the class (FR-10); `attendance`: 60-student rush |
| 11, 12 | Haversine geofence with accuracy allowance | `checkin`: geofence (FR-11/12) |
| 13 | One entry reason | `checkin`: entry reason must match the session |
| 14 | Course pre-filled from the timetable | `openlab`: class prefill; `jobs`: sessions follow the timetable |
| 15 | Check-out with a minimum gap | `checkin`: minimum gap (FR-15) |
| 16 | Live occupancy | `checkin`: happy path (occupancy up and down) |
| 17 | Missing exit is "unverified exit" | `attendance`: missing exit scan does not award a full session; `reports`: missing exit stays unverified |
| 18 | Multiple labs | `attendance`: opening one session never touches another; `checkin`: wrong lab, impossible travel; `hod` |
| 19 | Inventory catalogue | `inventory`: asset types, import |
| 20 | Availability visible without check-in | `platform`: catalogue is open to all (FR-20) |
| 21 | Request needs active check-in | `platform`: equipment requests (FR-21) |
| 22 | Issue and return handshake | `inventory`: idempotent issue, bulk return; `workflow-audit` |
| 23 | Overdue tracking and reminders | `inventory`: overdue reminders; limits and overdue block |
| 24 | Kits and group issue | `inventory`: kits, group loans, kit booking |
| 25 | Workstation booking, 15-minute no-show | `platform`: workstation slots (FR-25); `checkin`: research visit via booking; `inventory`: advance booking, waitlist |
| 26 | Serial numbers and counted consumables | `inventory`: individual vs quantity; bulk return with consumed and damaged |
| 27 | Reused token rejected | `attendance`: replay, replay after cache wipe, double submit race |
| 28 | Writes under a lock | `foundation`: locks; `attendance`: 60-student rush; `inventory`: lock contention fails closed |
| 29 | Impossible travel | `checkin`: impossible travel (FR-29) |
| 30 | Mock-location heuristics | `checkin`: mock-location (FR-30) |
| 31 | No raw coordinates stored | `checkin`: geofence test asserts none stored |
| 32 | Hash-chained audit log | `foundation`: audit (4 cases); `jobs`: tamper, truncation, head rewrite; `attendance`: chain stays valid |
| 33 | Kiosk account can only display QR codes | `access`: kiosk accounts only reach kiosk routes; `attendance`: revoked kiosk |
| 34 | Daily digest | `platform`: reports (FR-34), scheduled digest with PDF; `jobs`: morning job |
| 35 | Monthly audit | `platform`: monthly audit on the 1st to the HOD; `openlab`: monthly audit buckets |
| 36 | Custom range export | `platform`: reports (FR-36) |
| 37 | Session log | `platform`: reports (FR-37) |
| 38 | PDF via Docs template | `inventory`: reports PDF path; `reports`: sectioned reports use the PDF exporter; `platform`: digest with PDF (fake `DocumentApp` only) |
| 39 | ERP export | `platform`: reports (FR-39) |

FR-34 to FR-39 produce real PDFs only on a deployment; the tests use a fake `DocumentApp`.

## Keeping this current

When a test file or a requirement changes, edit the row. A requirement with no row, or a row whose test no longer exists, is a documentation bug.
