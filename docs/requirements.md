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

## 2. Status before v2 work (audit of `main` on 19 Oct)

Evidence is given by symbol; line numbers are only hints and will drift.

| # | Status | What exists | What is missing | Tasks |
|---|---|---|---|---|
| R1 | Partial | Live head count per lab and session (`Occupancy.lab`, LabService.gs ~63) | Each student's system and project | C3, B4 |
| R2 | Partial | `labs.occupancy` is open to every signed-in user (Code.gs ~61) | A board listing the students inside | B4 |
| R3 | Done for classes, research visits and bookings | Kiosk QR + GPS geofence (`Checkin.STEPS_A`) | Walk-in check-in when nothing is booked | C2 |
| R4 | Partial | Exit scan exists; a missed exit becomes "exit not scanned" and repeat offenders get a `never_scans_out` flag (FlagService.gs ~99) | Automatic sign-out at closing | C4 |
| R5 | Done | Assets, categories, kits, loans and returns (AssetService.gs) | A flag marking which assets are workstations | S0, B4 |
| R6 | Partial | Time-slot bookings with clash checks and no-show release (BookingService.gs) | A waitlist for a taken slot | A5 |
| R7 | Missing | A booking stores only `purpose` | Projects with timeline and outcome | C1, C3 |
| R8 | Partial | The demo data has an "IoT Lab" | Intel Unnati AI Lab data | C5 |
| R9 | Done | Same as R1 counts | | |
| R10 | Partial | Student report found by roll number, minutes per session (`Reports._student`) | Total hours and distinct days | B5 |
| R11 | Partial | Asset usage report counts loans and units (`Reports._assetUsage`) | Distinct people and purposes per system | B5 |
| R12 | Done | Timetable sessions; faculty roster shows "Absent" / "Not arrived yet" (ScriptsFaculty.html) | | |
| R13 | Done | 37 sheets defined in `Cfg.SCHEMA_SRC` | | |
| R14 | Missing | Nothing | Nightly backup copies and a yearly archive spreadsheet | A3, A4 |
| R15 | Partial | Role-checked RPC gateway, rate limits, hash-chained audit log | `Users.mobile` is plain text | A2 |
| R16 | Partial | student, faculty, staff, admin, kiosk; students already see their own verified minutes (`Attend.myHistory` totals) | HOD role; coordinator managing students; new labels | B1, B2, B3 |
| R17 | Done | Device-bound signed QR, two check-in modes, tamper-evident audit chain, Test Lab with attack scenarios | Keep it in the pitch | S2 |
| R18 | Partial | `V.rollNo` accepts any 3-20 characters | Parsing the join year and department | A1 |

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
- Rows are copied and verified before they are deleted from the live sheet, under the script lock.

**Encryption**
- `Users.mobile` is encrypted at rest: HMAC-SHA256 in counter mode for the keystream, plus an HMAC tag over the ciphertext (encrypt-then-MAC). The key is the script property `PII_KEY`; it is never in the sheet. Stored values start with `enc1:`.
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
| Sessions | `archivedAt:n` |
| AttendanceEvents | `projectId assetId` |
| Reservations | `projectId waitlistedAt:n` |

New table, id prefix `proj`:

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
| `Crypt.seal(text)` / `Crypt.open(sealed)` / `Crypt.mask(text)` | Util.gs | A2 | Encrypt, decrypt, mask |
| `Projects.usableBy(studentId, projectId)` | ProjectService.gs | C1 | True if the student owns the project or is in its group, and it is pending or active |
| `Auth.canView(ctx)` | AuthService.gs | B1 | admin, staff or hod. Use for reads only. |
| `Auth.labScope(ctx)` | AuthService.gs | B3 | Lab ids this account may see (all labs, except for an HOD) |

**New files:** `src/BackupService.gs` (global `Backup`) and `src/ProjectService.gs` (global `Projects`). Both go into `test/harness.js` `LOAD_ORDER` and `.clasp.json.example` `filePushOrder`.
