# Tasks (what is left to do)

Only open work lives here. When something is finished, **delete it from this file and add it to [progress.md](progress.md)** with the date and what was actually run. Never move an item to progress.md unless it was really done.

Legend: `[ ]` not started, `[~]` in progress, `[!]` blocked (say why). Order inside each section is priority order. Put your name in place of `@?` when you take a task.

Implementation deadline: 23 Oct 2026, 5:00 PM.

Last updated: 2026-10-19

---

## 0. Teacher brief v2 (due 23 Oct)

What and why: [requirements.md](requirements.md) (R1-R18, the decisions, and the **contracts**). How to work in this repo: [CONTRIBUTING.md](../CONTRIBUTING.md).

### How we split it

- Three workstreams, five tasks each, plus shared tasks:
  - **WS-A**: data, security and the queue. Backend.
  - **WS-B**: roles, dashboards, live board and reports. Mixed.
  - **WS-C**: extra-hours check-in and projects. UI-heavy; this is the demo story.
- One branch per workstream: `ws-a-data`, `ws-b-roles`, `ws-c-extrahours`. Open small PRs into `main`, and keep `npm run check` green before each merge. Rebase on `main` before opening a PR.
- **The contracts are in the code (S0, done 19 Oct).** Every v2 route is in `ROUTES` with its final roles, and every schema column exists. Each route calls a stub method in its service that answers `NOT_IMPLEMENTED` with its task id (search for `notBuilt_('B4')`, for example). Your job is to replace your own stubs. You should not need to edit `Code.gs` ROUTES, `Config.gs` SCHEMA_SRC or the load lists; `test/contracts.test.js` fails if a contract drifts.
- Need a contract changed? Open a PR that edits requirements.md section 4 and get all three people to agree.
- Test counts in README, TEST_PLAN and progress.md: whoever merges last on a given day updates them.
- Contact point between streams: A4 moves one read inside `Attend.rebuildSummary`, which C4 also relies on. Tell each other before touching it.

### Timeline

| Day | Work |
|---|---|
| Sun 19 / Mon 20 | A1, B1, C1 (S0 is done) |
| Tue 21 | Real lab data arrives (C5). A2, A3, B2, B3, C2, C3 |
| Wed 22 | A4, A5, B4, B5, C4. S1 docs, S2 demo and screenshots |
| Thu 23 | Demo by 5:00 PM |

### Shared (owner)

- [ ] **S1 Docs** (@?)
  - README: features, the four roles, a quick start, screenshots.
  - SECURITY.md: encryption, backups, archive, read-only HOD.
  - TEST_PLAN: the new flows.
  - `docs/` pages: architecture; attendance (both modes and the pipeline); data model; deployment; testing and Test Lab; site themes (pick one, what each changes, how to add one: `styles/themes/`, `src/ScriptsThemes.html`, the `uiTheme` setting).
  - Traceability: R1-R18 and FR-1 to FR-39 mapped to tests.
  - Copy screenshots from `.build/shots` into `docs/screens/`.
  - Add a `.gitattributes` (LF line endings).
  - This absorbs the old "Next up (docs)" list.
- [ ] **S2 Demo** (@? 22 Oct)
  - A demo script that follows R1-R18 in order: walk-in check-in, the live board from "home", booking + waitlist, project outcome, the register-number and system lookups, the HOD view, backup and encryption.
  - Refresh the e2e screenshots.

### WS-A Data, security and queue (@?)

- [ ] **A1 Register numbers** (R18)
  - Files: `Util.gs` (`U.parseRoll`), `UserService.gs` (`Users.onboard`, `Users.importStudents`, `Users.listStudents`/`students.list`).
  - Parse `^URK(\d{2})([A-Z]{2,4})(\d{3,5})$` into `{ joinYear: 2000+yy, gradYear: joinYear+4, dept, serial }`. Return `null` for other formats; `V.rollNo` still accepts them.
  - On onboarding and import, fill `joinYear`, and fill `department` when it is blank.
  - Add a `batch` (join year) filter to `students.list`.
  - Done when: `URK24CS1021` gives joinYear 2024, gradYear 2028, dept CS; a PhD-style number imports without parsed fields; the filter works.
  - Tests: `test/api.test.js` or a new `test/roll.test.js`.
- [ ] **A2 Phone encryption** (R15)
  - Files: `Util.gs` (`Crypt`), `Setup.gs` (`PII_KEY` in `Setup.initialise`, `Setup.selfTest` round trip), `UserService.gs` (`Users.me`, `Users.updateProfile`, `Users.onboard`), `Code.gs` (`setupEncryptMobiles` global, protected by `ownerOnly_`), `TriggerService.gs` (nightly sweep step), `ScriptsStaff.html` (loan desk reveal), `test/harness.js`.
  - `Crypt.seal`: random IV (hash of `Utilities.getUuid()`); keystream block i = HMAC(encKey, IV || i); tag = HMAC(macKey, `enc1|IV|ct`) cut to 16 bytes.
    - Keys come from HMAC(`PII_KEY`, `'enc'`) and HMAC(`PII_KEY`, `'mac'`).
    - Stored form: `enc1:<b64u iv>:<b64u ct>:<b64u tag>`.
    - `Crypt.open` checks the tag with `U.safeEq` before decrypting.
  - `Users.me` returns the user's own number in full; every other output gives `Crypt.mask` (`••••••1021`). `profileIncomplete` still works.
  - `users.revealMobile`: staff or admin, one user per call. Rate-limit it, and `Audit.log` action `pii.reveal`.
  - Loan desk: show the borrower's masked number, with a Reveal button.
  - Migration and nightly sweep: encrypt any value without the `enc1:` prefix. Running it twice changes nothing.
  - Harness: `computeHmacSha256Signature` must accept byte arrays (it passes them straight to Node now).
  - Done when: the sheet never holds a plain number; tampering with one character of a sealed value fails to open; the reveal is audited.
  - Tests: new `test/crypt.test.js`, and update `test/platform.test.js` mobile expectations.
- [ ] **A3 Nightly backup** (R14)
  - Files: `BackupService.gs` (`Backup.nightly`, `Backup.list`, `Backup.now`), `TriggerService.gs` (`Jobs.nightly` step), `Code.gs` (`system.backup`, `system.backups`), `ScriptsAdmin.html` (backup panel in Audit & system > System health), `test/harness.js` DriveApp fake.
  - Copy the spreadsheet with `DriveApp.getFileById(id).makeCopy(name, folder)` into `Setup.folder(<new PROP key>, 'LABFLOW Backups')`. Name it `LABFLOW backup YYYY-MM-DD`.
  - Rotation: keep 30 daily copies and the first copy of each month for 12 months; `setTrashed(true)` the rest.
  - `Audit.log` each manual backup. Write a JobRuns row for the nightly one.
  - Fakes needed: `makeCopy`, `folder.getFiles()` iterator, `getName`, `getDateCreated`, `setTrashed`.
  - Done when: 45 simulated nights leave 30 daily copies plus the monthly ones; a manual backup appears in the list.
  - Tests: `test/jobs.test.js`.
- [ ] **A4 Yearly archive** (R14)
  - Files: `BackupService.gs` (`Backup.archiveYear`), `Setup.gs` (extract `Setup.ensureSchema(ss, tables)` from `Setup.initialise`), `AttendanceService.gs` (`Attend.rebuildSummary`, `Attend.correct`, `Attend.decideCorrection`), `AdminService.gs` (reconcileSession), `ReportService.gs`, `TriggerService.gs`, `Code.gs` (`system.archive`), `ScriptsAdmin.html`, `test/harness.js` (`deleteRows` on FakeSheet).
  - Archive spreadsheet per academic year, `LABFLOW Archive 2025-26`. Keep its ids in one script property (JSON map).
  - The move runs under `Locks.with`: copy, verify the counts, then delete from the live sheet, in chunks that stop at the job deadline and resume next run.
    - Archive whole sessions only, and skip any session with a pending correction.
    - AssetEvents plan and complete rows move together.
  - Move the existing-summary read in `Attend.rebuildSummary` inside the lock. Today it reads `__row` outside the lock and writes inside it; deleting rows in between would overwrite the wrong row.
  - Set `Sessions.archivedAt`. `Attend.correct`, `Attend.decideCorrection` and `system.reconcileSession` refuse it with `ARCHIVED`.
  - Reports that read events (`_digest`, `_erp`, `_session`) say "archived" for those sessions.
  - Auto-run in July using a JobRuns marker, plus the academic-year start-month setting (default June).
  - Done when: after archiving, student history and totals are unchanged, the live AttendanceEvents row count drops, the archive holds the rows, a correction on an archived session is refused, and the audit chain still verifies.
  - Tests: new `test/archive.test.js`.
- [ ] **A5 Waitlist** (R6)
  - Files: `BookingService.gs` (`Booking.request`, `Booking.cancel`, `Booking.decide`, `Booking.expireStale`, `Booking.mine`, new `Booking._promote`), `NotificationService.gs` (reuse `Notify.toStudent`), `ScriptsStudent.html` (the "Join waitlist" button and position).
  - In `Booking.request` with `waitlist: true`: when `_checkCapacity` or `_checkAssetExclusive` throws `NOT_AVAILABLE`, insert the booking as `waitlisted` with `waitlistedAt`. It is not counted in `_holds`. It does count toward the active-booking limit, which stops spamming.
  - `Booking._promote(labId, resourceType, resourceId, startAt, endAt)`: first-come by `waitlistedAt`. Re-run the capacity checks, excluding the booking's own id. Promote to `pending` (or `approved`, following the normal flow) and notify the student. Call it after cancel, after reject, and after the no-show release in `expireStale`, inside `Locks.with`.
  - `Booking.mine` shows the position (`#2`). A waitlisted entry expires when its slot starts.
  - Done when: two students wait for a taken 3D printer slot; cancelling promotes the first and notifies them; the second becomes `#1`.
  - Tests: `test/inventory.test.js`.

### WS-B Roles, dashboards, live board and reports (@?)

- [ ] **B1 Roles** (R16)
  - Files: `AuthService.gs` (`Auth.canView`), every read handler with `has('admin') || has('staff')`, `UserService.gs` (`Users.upsertUser` role cap 4 -> 5; `Dash.admin` role counts), `Scripts.html` (`ROLE_LABEL`: Coordinator, Super admin, HOD), `ScriptsThemes.html` (its copy of the labels), `ScriptsFaculty.html` / `ScriptsStudent.html` (text "coordinator" -> "Event lead"), `ScriptsAdmin.html` (role checkboxes, filters, badges).
  - Add `hod` to the roles of the read-only routes. The full list is in the role audit summary below this section.
  - In handlers, switch **reads only** to `Auth.canView(ctx)`.
  - `system.status`, `system.quota` and `settings.get` stay admin-only.
  - Done when: a HOD account can open every read view, and is refused every write. Test the refusal as a sweep over all routes, not a hand-picked list.
  - Tests: `test/access.test.js`.
- [ ] **B2 Coordinator manages students** (R16)
  - Files: `Code.gs` (`students.import`, `roster.import`, `roster.remove` -> staff + admin), `UserService.gs` (`Users.importStudents` audit role `ctx.roles[0]`; new `Users.setStudentStatus` for `students.status`), `LabService.gs` (`Roster.import` audit role), `ScriptsStaff.html` (reuse the admin import and roster views, the way `ScriptsAdmin.html` `reuse()` shares staff views).
  - "Remove a student" means disable the profile (`status: 'disabled'`), never delete it. Disabled students cannot check in.
  - Done when: a coordinator imports a CSV, adds a student to a course, and disables one; each action is audited with role `staff`.
  - Tests: `test/api.test.js`.
- [ ] **B3 Department scope and HOD views** (R16)
  - Files: `LabService.gs` (`Labs.upsert` takes `department`), `UserService.gs` (`department` on users), `AuthService.gs` (`Auth.labScope`), `AdminService.gs` (`Dash.hod`, built from `Dash.admin` + `Dash.staff`, filtered by scope), new HOD views in `ScriptsAdmin.html` or a new `ScriptsHod.html` (if new: add it to `FRONTEND_FILES` and `Index.html`).
  - HOD views: overview, labs and facilities (read-only asset list), live board (B4), reports.
  - A placeholder HOD "Overview" (live occupancy only) sits at the end of `ScriptsAdmin.html`; replace it.
  - Done when: a CSE HOD sees CSE labs and labs without a department, and does not see an ECE lab.
  - Tests: `test/access.test.js` or a new `test/hod.test.js`.
- [ ] **B4 Live board and systems** (R1, R2, R9)
  - Files: `LabService.gs` (`labs.live`, `systems.status`), `AssetService.gs` (`Categories.workstation` editing), `Scripts.html` or `ScriptsStaff.html` (a Live view, auto-refresh every `occupancyRefreshSeconds`), registered for faculty, staff, admin and hod.
  - `labs.live`: for each lab in scope, each student inside, with name, register number, session, system, project and since-when.
    - Build it from `Attend.studentState` and the latest IN or WORK event carrying `assetId` and `projectId`. `Jobs.overstay` already loops over the students inside.
    - Do not put names into the cached `labs.occupancy` payload; every user can read that one.
  - `systems.status`: each workstation is free, busy (someone inside on it) or booked (a held booking now). Students get free/busy only.
  - Done when: two students check in on two systems; the board shows both with their projects; one checks out and disappears.
  - Tests: `test/checkin.test.js`.
- [ ] **B5 Reports** (R10, R11, R7)
  - Files: `ReportService.gs` (`Reports._student`, new `Reports._systemUsage`, new `Reports._projects`, `Reports.TYPES`), `Scripts.html` (`LF.ui.reports` asset picker), the views' report lists, `ScriptsStudent.html` (days and hours per lab on the student home).
  - Student report: add a totals block with total hours, distinct days, visits and auto sign-outs. The lookup by register number already works.
  - `systemUsage` for one asset: distinct people, visits, hours, and a table of who used it, when and for what (project title or booking purpose). Sources: `AttendanceEvents.assetId`, Reservations, LoanItems.
  - `projects`: each project with owner, supervisor, timeline, status, outcome and hours logged.
  - Done when: the three reports run, give the expected numbers on a seeded world, and export to CSV.
  - Tests: `test/platform.test.js` or a new `test/reports.test.js`.

### WS-C Extra-hours check-in and projects (@?)

- [ ] **C1 Projects** (R7)
  - Files: `ProjectService.gs` (all `projects.*` handlers, `Projects.usableBy`), `NotificationService.gs` (the supervisor is notified on create; the student on decide), `ScriptsStudent.html` (My projects: create, list, submit outcome), `ScriptsFaculty.html` (Project approvals, accept outcome).
  - A group project uses the existing `Groups` (`groupId`). Only the group leader creates it.
  - Audit log entries for create, decide and outcome.
  - Done when: a student creates a project, uses it while pending, the supervisor approves it, and the student submits an outcome that the supervisor accepts.
  - Tests: new `test/projects.test.js`.
- [ ] **C2 Open lab session** (R3, R8)
  - Files: `SessionService.gs` (new `Sessions.materializeOpenLab(date)`, `Sessions._labConflicts`, `Sessions.open`, `Sessions._systemOpen`, `Sessions.autoOpenDue`, `Sessions.listForStudent`), `AttendanceService.gs` (`Attend.reasonOf`), `CheckinService.gs` (the sort map in `Checkin.options`), `TriggerService.gs` (`Jobs.nightly` materialize, `Jobs.tickSessions`), `ReportService.gs` (bucket openlab separately).
  - One session per lab per day where `Labs.openLab` is set and the lab has opening hours. Use `slotKey 'open|labId|date'`, `openToAll: true` and `rescanMode: 'off'`. `Sessions.selfWorkFor` is the closest model.
  - The one-open-session rule must exempt `openlab` in all three places (today they test `type !== 'research'`), or timetabled classes will silently fail to auto-open.
  - Show it in the student's Today list only while it is open.
  - Done when: at 15:00 a student with no booking checks in to Open lab; at 10:00 the timetabled class still auto-opens beside it.
  - Tests: `test/checkin.test.js`, `test/platform.test.js`.
- [ ] **C3 Check-in with project and system** (R1, R7)
  - Files: `CheckinService.gs` (`Checkin.options` returns the student's usable projects and the free systems; a new step after `target` in `Checkin.STEPS_A`, re-checked inside the lock), `AttendanceService.gs` (`Attend._record` writes `projectId` and `assetId`; new `Attend.setWork` writes a `WORK` event; `Attend._compute` ignores `WORK`), `ScriptsStudent.html` (project and system pickers in `LF.kioskCheckin`; a "Change system / project" button while inside, which covers Version B).
  - A booked system is preselected and required. A system that someone inside is using cannot be picked. "Own laptop" is allowed.
  - Done when: a check-in stores the project and system; a busy system is refused; `attend.setWork` switches the system mid-visit; attendance minutes are unchanged by WORK events.
  - Tests: `test/checkin.test.js`, `test/scanning.test.js` (Version B).
- [ ] **C4 Automatic sign-out** (R4)
  - Files: `SessionService.gs` (`Sessions._closeInternal` for `openlab` only), `AttendanceService.gs` (`Attend._compute` credits an `OUT` with `method: 'auto'` up to the closing time and adds an `auto_out` flag to the summary), `FlagService.gs` (auto sign-outs count toward `never_scans_out`).
  - Classes are unchanged ("exit not scanned").
  - Done when: a student still inside at 19:00 gets an auto `OUT`; their visit counts to 19:00 with the `auto_out` flag; a class student who forgets still shows "exit not scanned".
  - Tests: `test/attendance.test.js`, `test/jobs.test.js`.
- [ ] **C5 Intel Unnati AI Lab data** (R8)
  - Files: `dev/world.js` (seed), `dev/scenarios.js` (if a scenario names the lab), `test/dev-world.test.js`.
  - Placeholders now: code `UNNATI`, name "Intel Unnati AI Lab", about 30 GPU workstations (category marked `workstation`), 2 3D printers, 2 drones, dev boards, open-lab hours, a few projects. Mark placeholder values clearly.
  - **21 Oct:** replace them with the real building, room, GPS and asset list.
  - Done when: the Test Lab shows the lab with live students on systems.

### Role audit summary (for B1)

The routes a HOD needs read access to, with their current roles in `src/Code.gs`. Also extend the handler checks shown.

| Route(s) | Roles today | Handler check to extend |
|---|---|---|
| `dash.admin`, `dash.staff`, `activity.feed` | admin / staff+admin | none |
| `sessions.day`, `sessions.get` | faculty, staff, admin | `Sessions.listForDay`, `Sessions.get` |
| `attend.roster` | user | staff or `canOperate` |
| `attend.studentEvents`, `flags.list`, `events.list`, `classreps.list` | faculty, staff, admin | each handler |
| `students.list`, `courses.list`, `timetable.list`, `facultycourses.list`, `roster.list` | faculty, staff, admin | each handler |
| `assets.list` | faculty, staff, admin | `valueInr` only for admin/staff |
| `assets.history`, `loans.list`, `booking.list`, `equipment.list` | staff, admin | none |
| `reports.run`, `reports.csv`, `reports.pdf` | student, faculty, staff, admin | `Reports.run` access rules (`audit`, `erp` stay admin-only) |
| `audit.list`, `users.list`, `kiosks.list` | admin | none |

The HOD passes every `'user'` route. Make sure write handlers behind `'user'` (for example `sessions.open`, `scan.submit`, `attend.openRescan`) refuse a HOD-only account.

### Where to start reading

| Area | Symbols |
|---|---|
| Check-in (A) | `Checkin.options`, `Checkin._resolveTarget`, `Checkin.STEPS_A`, `LF.kioskCheckin` |
| Device QR (B) | `Attend.challenge`, `Attend.STEPS_B`, `Attend._record`, `Attend._compute` |
| Sessions | `Sessions.materialize`, `Sessions.selfWorkFor`, `Sessions._systemOpen`, `Sessions.autoCloseStale` |
| Bookings | `Booking.request`, `Booking._checkCapacity`, `Booking.expireStale` |
| Occupancy | `Occupancy.lab`, `Jobs.overstay` |
| Data layer | `Db.insert`, `Db.update`, `Db.putRow`, `Setup.initialise`, `Setup.folder` |
| Jobs | `Jobs.nightly`, `Jobs.step`, `Jobs.run` |
| Roles | `Auth._contextForEmail`, `rpc` in `Code.gs`, `Users.upsertUser`, `ROLE_LABEL` |
| Reports | `Reports.run`, `Reports._student`, `Reports._assetUsage` |

---

## 1. Deployment checks (need a real Google Workspace, so none are done)

Do these first. Write the date and result next to each when you finish it. TEST_PLAN section B has the detail.

- [ ] **Identity for both domains.** Open the web app as an ordinary user from `karunya.edu` and from `karunya.edu.in`. Highest risk: if the second domain is a separate Workspace, its users will be refused. See README "Authentication".
- [ ] Run `setupInitialise`, `setupBootstrapAdmin`, `setupSelfTest`; read the real timings (P-256 verify, sheet write, lock).
- [ ] Run `setupInstallTriggers`; confirm all four triggers ran after a day.
- [ ] Version A on a phone: GPS and camera inside the HtmlService iframe; the geofence check at the real lab door.
- [ ] Device key survives closing the browser (Android Chrome and iPhone Safari).
- [ ] Kiosk with a USB scanner; kiosk with camera mode in Chrome.
- [ ] 30 students scanning within 2 minutes (latency, lock contention). Re-measure after the workflow audit's additional authorization checks; earlier operation counts predate them. Run `setupBenchmarkScans` from the editor (uses a throwaway spreadsheet) and trim the locked section if the 9 AM rush is slow.
- [ ] One day of email digests and one PDF report (quotas).
- [ ] Audit anchor email arrives and is kept by someone other than the script owner.
- [ ] Screen-reader pass (NVDA or VoiceOver) on the student and kiosk flows.
- [ ] Physical dry run: a rescan, a spot check, and a deliberate relay attempt.
- [ ] v2: a nightly backup lands in Drive and rotation trashes old copies (A3).
- [ ] v2: `setupEncryptMobiles` on the real sheet, then confirm no plain numbers remain (A2).
- [ ] v2: GPS geofence at the Intel Unnati AI Lab door with the real coordinates (C5).

## 2. Next up (docs)

Folded into **S1** above.

## 3. Build (after the demo)

- [ ] Benchmark return recovery with a large AssetEvents ledger; consider indexing pending return plans to avoid scanning the complete ledger under the lock on each inventory mutation.
- [ ] Theme CSS ships for all ten themes on every page load (Styles.html is about 270 KB). Split it per theme if load time on the campus network is a problem.
- [ ] Frontend unit tests (the UI is covered only by the browser flow).
- [ ] Run the browser flow in Safari and Firefox.
- [ ] Hardening: WebAuthn, only if the UI can be served from an origin you own.
- [ ] Hardening: set `EMAIL_TRANSPORT=mail` and drop the broad Gmail scope from `appsscript.json`.
- [ ] Department rollout: scope the generic lists (not only the HOD views) by `Auth.labScope` once a second department joins.

## 4. Backlog / ideas

Add ideas here before they become tasks.

-
