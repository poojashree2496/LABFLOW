# Architecture

LABFLOW is one Google Apps Script project plus a static front end. Google Sheets is the database. There is no other server.

```
Browser (student phone, kiosk, staff PC)
   |  rpc(action, payload)                       one gateway for every call
   v
Code.gs  ROUTES table: role list, rate limit, payload size   <- identity and role checked here
   |
   v
Services (*.gs, one global object each)  <- they check ownership again (a student sees only their own rows)
   |
   v
Db.gs  (schema, typed rows, unique/cached columns, script lock)  ->  Google Sheets
   |
   +-- Audit.gs   hash-chained log of sensitive actions
   +-- Util.gs    time (IST), validators, CSV, Crypt (AES-256-GCM), Pipeline
```

## Two ways to serve the same UI

| | Apps Script web app | Hosted app |
|---|---|---|
| Page served by | `doGet` (HtmlService) | Static site built by `scripts/build-web.js` (Vercel config in `vercel.json`) |
| Identity | `Session.getActiveUser()` | Google sign-in: the page sends a Google ID token to `auth.google`, the server verifies it and returns a signed LABFLOW session |
| Calls | `google.script.run` -> `rpc` | `POST {action, payload, session}` as `text/plain` to the `/exec` URL -> `doPost` -> `rpc` |
| Why | Simplest. Needs both Karunya domains in one Workspace organisation | Works when `getActiveUser()` returns blank for the other domain; installable as a phone app |

Both run the same `src/Index.html` and the same `rpc`. A call without a valid session is refused even if the browser carries Google cookies for the owner, so a third-party page cannot act as the owner.

## The gateway (`src/Code.gs`)

`ROUTES` maps every action name to `{ roles, rl, max, fn }`. `rpc()` looks the action up (only own properties, so `constructor` or `__proto__` do not exist), resolves the caller, checks the role, applies the per-caller rate limit and the payload size cap, runs the handler, and always returns `{ ok: true, data }` or `{ ok: false, error: { code, message } }`. Unexpected errors are logged to `SystemLog` with a reference and never leak details. Setup functions (`setup*`) are not routes and call `ownerOnly_()`.

## Services

| File | Global | Responsibility |
|---|---|---|
| `Config.gs` | `Cfg`, `Settings` | Schema DSL (`SCHEMA_SRC`), settings catalogue with limits, property keys |
| `Db.gs` | `Db`, `Locks` | Typed row access over sheets, unique and cached columns, script lock, `insertMany` |
| `Util.gs` | `U`, `V`, `Crypt`, `Pipeline` | IST time, validators, CSV neutralisation, roll-number parser, encryption, ordered check pipelines |
| `AuthService.gs` | `Auth` | Identity, sessions for the hosted app, role and department scope |
| `UserService.gs` | `Users` | Accounts, profiles, onboarding, mobile numbers (sealed), student import |
| `DeviceCredentialService.gs` | `Creds`, `Tokens` | Device key registration, in-person approval, revocation |
| `SessionService.gs` | `Sessions` | Class, event, open-lab and research sessions, timetable materialisation |
| `CheckinService.gs` | `Checkin` | Mode A: kiosk QR + GPS |
| `AttendanceService.gs` | `Attend`, `Work` | Mode B scans, rescans, spot checks, corrections, summaries |
| `AssetService.gs`, `BookingService.gs` | `Assets`, `Kits`, `Groups`, `Loans`, `Booking`, `Requests` | Inventory, kits, loans, returns, time-slot bookings and waitlist |
| `ProjectService.gs` | `Projects` | Project lifecycle and outcomes |
| `LabService.gs`, `EventService.gs` | `Labs`, `Occupancy`, `Kiosks`, `Courses`, `Roster`, `Timetable`, `Events`, `ClassReps` | Labs, kiosks, courses, rosters, timetable, occupancy and live board, events and class representatives |
| `ReportService.gs` | `Reports` | Digest, monthly audit, custom range, session log, ERP export, CSV and PDF |
| `FlagService.gs` | `Flags` | Review queue for suspicious activity |
| `NotificationService.gs` | `Notify` | In-app notices and email digests with a quota reserve |
| `AuditService.gs` | `Audit`, `Syslog` | Append-only hash chain, checkpoints, anchors, verify |
| `BackupService.gs` | `Backup` | Nightly Drive copies with rotation; yearly archive |
| `TriggerService.gs` | `Triggers`, `Jobs` | The five time triggers and the jobs they run |
| `AdminService.gs` | `Admin`, `Dash` | Reconcile tools, system health, quota panel |
| `Setup.gs` | `Setup` | Create sheets, bootstrap admin, self test, sign-in configuration |
| `Vendor_P256.gs`, `Vendor_AES.gs` | | Bundled `@noble/curves` (ECDSA verify) and `@noble/ciphers` (AES-GCM) |

## Front end

`Index.html` pulls in `Styles.html` (compiled Tailwind plus theme CSS), `SharedComponents.html` (the `h()` DOM helper, `ui.*` widgets, `LF` namespace) and one `Scripts*.html` per role. Screens register themselves with `LF.register({ role, id, label, render })`. Nothing is written with `innerHTML`; text goes through `h()`.

## Background jobs

Five triggers, installed by `setupInstallTriggers` (it removes and recreates only its own, so it is safe to run twice):

| Handler | When | Does |
|---|---|---|
| `trg_tickSessions` | every 5 min | Open timetabled sessions, rescan windows, auto-close stale sessions (including the open-lab automatic sign-out), release no-show bookings, overstay alerts |
| `trg_sendEmails` | hourly | One email digest per person |
| `trg_nightly` | 01:00 | Create sessions for coming days, reconcile attendance and inventory, audit checkpoint, monthly audit on the 1st, encrypt any plain mobile numbers, nightly backup, yearly archive (July) |
| `trg_morning` | 08:00 | Overdue reminders, daily report, audit anchor email |
| `trg_evening` | 18:00 | Daily digest per lab to the incharges |

Every job takes the script lock with a short wait and skips if another run holds it, logs a `JobRuns` row, catches its own errors, and stops cleanly at 4.5 minutes of the 6-minute limit. A failing step never stops the steps after it.

## Local development

`dev/server.js` runs the real `.gs` files against in-memory fakes of the Apps Script services and serves the UI. `dev/world.js` seeds demo data; `dev/lab/` is the Test Lab; `dev/scenarios.js` is the scripted scenario run. See [testing.md](testing.md).
