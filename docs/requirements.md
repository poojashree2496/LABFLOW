# Requirements v2: the course teacher's brief

The course teacher's brief (19 Oct 2026) is restated below as numbered requirements. Under them: what LABFLOW already does, the decisions the team took, and the **contracts** (names every workstream codes against). Work items are in [tasks.md](tasks.md). The original SRS PDF in this folder is still valid; this brief adds to it.

Last updated: 2026-10-19

---

## 1. The brief

The goal is an **attendance-cum-asset tracking system** for lab use **during extra hours**. It starts in the **Intel Unnati AI Lab** and then rolls out across the department. It must run on Google Apps Script with Google Sheets as the database, at zero cost.

| # | Requirement |
|---|---|
| R1 | At any moment, show how many students are in the lab, **which systems** they are working on and **which projects** they are doing. |
| R2 | Staff can see this remotely (for example from home), as a live session view. |
| R3 | A student entering the lab scans a QR code; GPS confirms they are inside the lab region, and attendance is marked. |
| R4 | When the student leaves, they are signed out. |
| R5 | The lab assets (3D printers, drones, computers with graphics cards and more) are tracked. |
| R6 | Students reserve their spot on an asset through a **queue** based on timing. |
| R7 | Every use of an asset records **what the project is, its timeline and its outcome**. |
| R8 | Implement for the Intel Unnati AI Lab first, then for the rest of the department. |
| R9 | At any point in time, show how many students are using the lab. |
| R10 | Given a **register number**, show how many days and the total duration that student has used the lab. |
| R11 | Given a **system**, show how many people have used it and for what purpose. |
| R12 | Regular lab (for example Web Technology lab, every day at 11:00): students sign in and select the regular lab session; the course faculty sees **who is missing**. |
| R13 | Built in Google Apps Script with an HTML front end; all records in Google Sheets. |
| R14 | **Periodic backups**, using multiple spreadsheets, so no single sheet is overloaded. |
| R15 | **Mild encryption** of sensitive data, especially phone numbers (needed when assets are issued), plus validation on access. |
| R16 | Roles: **student** (signs in, sees their own hours); **coordinator** (sees all lab facilities, adds and removes facilities and students, sees current usage); **HOD** (sees all lab facilities and everything going on); **super admin** (manages every role). |
| R17 | An innovative, novel solution within these technical limits. |
| R18 | Register numbers have the form `URK` + 2-digit year + department + serial number, for example `URK24CS1021` (joined 2024, CSE, graduates 2028). |

## 2. Status (audited 19 Oct, updated 21 Oct)

Evidence is given by symbol; line numbers are only hints and will drift.

| # | Status | What exists | What is missing | Tasks |
|---|---|---|---|---|
| R1 | Done on local fakes | Live counts plus current student, system and project assignments on the Live board (`Occupancy.live`) | Deployment checks | Deployment |
| R2 | Done on local fakes | Live board lists current visitors; public counts and student system status remain anonymous | Deployment checks | Deployment |
| R3 | Done on local fakes | Kiosk QR + GPS geofence (`Checkin.STEPS_A`) for classes, research visits and bookings; walk-in entry to a daily open lab when nothing is booked (C2, docs/openlab.md) | Real door GPS verification | Deployment |
| R4 | Done on local fakes | Open-lab automatic OUT at closing, credited time and auto sign-out history; repeat missed exits feed `never_scans_out`. Class missed exits keep their existing policy. | Real trigger/runtime verification | Deployment |
| R5 | Done | Assets, categories (with a `workstation` flag), kits, loans and returns (AssetService.gs) | | |
| R6 | Done | Time-slot bookings with clash checks and no-show release; a taken slot can be waited for (`waitlist: true`): first come first served, promoted to a normal request and the student told when stock frees (cancel, reject, no-show release), position shown, ends when the slot starts (BookingService.gs) | | |
| R7 | Done on local fakes | Project lifecycle, outcome review and reports with supervisor/timeline/status/outcome/verified hours | Deployment checks | Deployment |
| R8 | Demo ready | Live site: the IBM Big Data Software CoE (DBMS Lab) with its real course (DBMSLAB, roster of 60), Wednesday timetable, kiosk and 36 assets. Test Lab: Intel Unnati AI Lab seed with marked placeholder systems/equipment, projects and current visits | Unnati location, hours and inventory; door GPS and opening hours for the CoE lab on the live site | C5, Deployment |
| R9 | Done | Same as R1 counts | | |
| R10 | Done on local fakes | Student report totals and per-lab hours/days/visits/automatic sign-outs; student home has a 90-day per-lab view | Deployment checks | Deployment |
| R11 | Done on local fakes | System report with checked-in people, visits, verified hours and project/booking purpose; reservation/loan context is separate | Deployment checks | Deployment |
| R12 | Done | Timetable sessions; faculty roster shows "Absent" / "Not arrived yet" (ScriptsFaculty.html) | | |
| R13 | Done | 37 sheets defined in `Cfg.SCHEMA_SRC` | | |
| R14 | Done | Nightly backup copies with rotation (30 daily + 12 monthly), manual backup and an admin panel (A3); yearly archive to a per-year spreadsheet, manual or automatic each July, with an admin panel (A4, built 21 Oct) | None | - |
| R15 | Done on local fakes | Role-checked RPC gateway, rate limits, hash-chained audit log. A2 done: `Users.mobile` is sealed with AES-256-GCM (`Crypt`), shown masked to everyone but its owner, revealed to a coordinator or super admin one student at a time with an audit entry | Run `setupEncryptMobiles` on the real sheet; deployment checks | Deployment |
| R16 | Done on local fakes | HOD role, department/shared-lab read scope, clarified labels, scoped dashboards/exports and full-route mutation refusal; student per-lab time. B2 done: coordinators import students, manage course rosters, and disable or re-enable a profile (never deleted; a disabled student cannot check in or book), audited as `staff` | Deployment checks | Deployment |
| R17 | Done | Device-bound signed QR, two check-in modes, tamper-evident audit chain, Test Lab with attack scenarios | Keep it in the pitch | S2 |
| R18 | Done on local fakes | `U.parseRoll`; join year and department filled on import and onboarding; batch filter on `students.list`; `V.rollNo` still accepts other formats | | A1 |

## 3. Decisions (agreed 19 Oct)

**Roles**
- The `staff` role is shown as **Coordinator**. On top of what staff can do today, it can import, add and disable students and change rosters.
- The `admin` role is shown as **Super admin** and keeps sole control of users and roles.
- New `hod` role: **read-only** and department-scoped. Labs and users get a `department` column; an HOD sees the labs of their own department plus labs with no department. CSE is the only department in the first year, under one HOD.
- Faculty stay as they are (course faculty see who is missing).
- The existing event "coordinator" (the person who runs an event) is renamed **Event lead** in the UI so it does not clash. Stored column names and values do not change.
- The stored role ids stay `staff` and `admin`; only labels change.

**Projects**
- A student or group leader creates a project and names a faculty supervisor. The supervisor (or a coordinator) approves it.
- A pending project can be picked at check-in straight away.
- At the end, the student records the outcome (text plus an optional link), and the supervisor can mark it accepted.

**Extra hours: open lab**
- Every lab with opening hours gets an **Open lab** session (type `openlab`, open to all students) from `openTime` to `closeTime` each day.
- At check-in (QR + GPS) the student picks a **project** and, optionally, a **system**. If they booked a system it is preselected and required. A system that someone inside is using shows as busy. "Own laptop / no system" is allowed.
- At open-lab close, anyone still inside is **signed out automatically**. The visit counts up to the closing time and is marked **auto sign-out**, and repeat offenders feed the existing `never_scans_out` flag.
- Regular classes keep today's behaviour: a missing exit scan stays "exit not scanned" for the faculty to review.

**Live board**
- Faculty, coordinator, HOD and super admin see each student inside each lab, with system, project and time since check-in.
- Students and kiosks keep the head count only.

**Queue**
- Students book time slots as they do today. If the slot is taken, they can join a first-come **waitlist** for it.
- When the booking holding the slot is cancelled, rejected or released as a no-show, the next student is promoted automatically and notified. Students see their position ("#2").
- A waitlist entry expires when its slot starts.

**Register numbers**
- `URK24CS1021` = `URK` + join year `24` + department `CS` + serial `1021`. When a number matches, the join year and department are filled in automatically.
- Other formats (PG, PhD, lateral entry) are still accepted, without the parsed fields.
- Graduation year = join year + 4. This is an assumption that holds for B.Tech only.

**Backups and archive**
- A nightly job copies the whole spreadsheet into a Drive folder "LABFLOW Backups". It keeps the last 30 daily copies and the first copy of each month for 12 months; older copies are moved to the bin.
- A yearly archive keeps the live sheet small. The academic year runs 1 June to 31 May, and the start month is a setting. The super admin runs it manually, and it also runs automatically each July for anything older than the previous academic year.
- **What moves** to a per-year spreadsheet "LABFLOW Archive YYYY-YY": AttendanceEvents of closed sessions, RescanWindows, SpotChecks, Redemptions, AssetEvents of returned loans (plan and complete rows move together), SystemLog, JobRuns, and Notifications that have been read.
- **What stays live**: Sessions, AttendanceSummaries, Loans, LoanItems and AuditEvents. Student history, totals and most reports keep working.
- An archived session refuses corrections and reconciles (error `ARCHIVED`). Reports that need event-level rows from an archived range say so instead of showing short numbers.
- Rows are copied and verified before they are deleted from the live sheet, under the script lock. A run stops at its time budget and carries on next time; running a year twice copies nothing twice.
- A backup of the day is made before any archive run. The nightly automatic run in July needs that backup to exist and does nothing without it.
- Known limits: the scoped-HOD audit view cannot map audit rows about archived scans, an asset's history shows fewer events for archived loans, and visit counts for archived sessions are shown as unavailable.

**Encryption**
- `Users.mobile` is encrypted at rest with **AES-256-GCM**, a vetted authenticated cipher (the audited `@noble/ciphers` bundle in `Vendor_AES.gs`; no homemade cipher). The key is HMAC-SHA256(`PII_KEY`, `'enc'`), where `PII_KEY` is a script property created by `Setup.initialise`; it is never in the sheet and is never regenerated, because that would make stored values unreadable. Each value has a fresh random 96-bit nonce, and the field name (`Users.mobile`) is bound in as additional authenticated data. Stored form: `enc1:<nonce>:<ciphertext>:<tag>` (base64url). A value that was changed in any character, sealed for another field, or opened with another key fails with `INTEGRITY`.
- Shown masked everywhere (`••••••1021`). A student sees their own number in full.
- The coordinator and super admin can reveal one number at a time (rate-limited; every reveal is in the audit log). The loan desk shows the masked number with a reveal button.
- Everyone still gives a number at first login (`requireMobile`).
- An idempotent migration encrypts existing plain numbers.

**Lab data**
- Until the real details arrive on 21 Oct, the Intel Unnati AI Lab uses placeholders: about 30 GPU workstations, 2 3D printers, 2 drones and dev boards, with placeholder building, room and GPS. Every placeholder is marked as one in the seed.

## 4. Contracts

These names are frozen so the three workstreams can work in parallel. **Change them only through a pull request that edits this section and that all three people agree to.** Task S0 puts all of them into the code before anyone else starts.

**Schema additions.** Append these at the end of each table, in exactly this order (`Config.gs` DSL):

| Table | Appended columns |
|---|---|
| Labs | `department openLab:b` |
| Users | `department` |
| StudentProfiles | `joinYear:n` |
| Categories | `workstation:b` |
| Sessions | `archivedAt:n checkinMode` (checkinMode added 21 Oct: the mode the faculty chose at opening) |
| AttendanceEvents | `projectId assetId` |
| Reservations | `projectId waitlistedAt:n` |

New table (`U.id('project')` gives ids starting `PRJ`):

```
Projects: projectId title description ownerStudentId groupId supervisorFacultyId labId startDate endDate status outcome outcomeLink outcomeAt:n approvedBy approvedAt:n createdAt:n updatedAt:n
```

**Enum values**

| Where | New value | Meaning |
|---|---|---|
| Session type and entry reason | `openlab` | The daily extra-hours session |
| AttendanceEvents.type | `WORK` | Records a project or system change during a visit. No effect on attendance. |
| AttendanceEvents.method | `auto` | Automatic sign-out at open-lab close |
| Reservations.status | `waitlisted` | Waiting for a taken slot; holds nothing |
| Projects.status | `pending`, `active`, `completed`, `rejected`, `archived` | |
| Roles | `hod` | Read-only, department-scoped |

**New routes** (in `ROUTES`, `src/Code.gs`)

| Action | Roles | Owner |
|---|---|---|
| `projects.create` | student | C1 |
| `projects.mine` | student | C1 |
| `projects.get` | student, faculty, staff, admin, hod | C1 |
| `projects.list` | faculty, staff, admin, hod | C1 |
| `projects.decide` | faculty, staff, admin | C1 |
| `projects.outcome` | student, faculty | C1 |
| `attend.setWork` | student | C3 |
| `labs.live` | faculty, staff, admin, hod | B4 |
| `systems.status` | user | B4 (students see free/busy only) |
| `users.revealMobile` | staff, admin | A2 |
| `students.status` | staff, admin | B2 |
| `dash.hod` | hod, admin | B3 |
| `system.backup` | admin | A3 |
| `system.backups` | admin | A3 |
| `system.archive` | admin | A4 |

New report types: `systemUsage` (staff, admin, hod) and `projects` (faculty, staff, admin, hod). The `student` report gains a totals block: total hours, distinct days and auto sign-outs.

`system.status`, `system.quota` and `settings.get` stay admin-only (`test/access.test.js` enforces this). The HOD does not get them.

**Shared helpers**

| Helper | File | Owner | Purpose |
|---|---|---|---|
| `U.parseRoll(roll)` | Util.gs | A1 | `{ joinYear, gradYear, dept, serial }` or `null` |
| `Crypt.seal(text, field)` / `Crypt.open(sealed, field)` / `Crypt.mask(text)` | Util.gs | A2 | Encrypt, decrypt, mask. `Crypt.reveal(stored, field)` reads a value that may still be plain (before the migration) |
| `Projects.usableBy(studentId, projectId)` | ProjectService.gs | C1 | True if the student owns the project or is in its group, and it is pending or active |
| `Auth.canView(ctx)` | AuthService.gs | B1 | admin, staff or hod. Use for reads only. |
| `Auth.labScope(ctx)` | AuthService.gs | B3 | Lab ids this account may see (all labs, except for an HOD) |

**New files:** `src/BackupService.gs` (global `Backup`) and `src/ProjectService.gs` (global `Projects`). Both go into `test/harness.js` `LOAD_ORDER` and `.clasp.json.example` `filePushOrder`.
