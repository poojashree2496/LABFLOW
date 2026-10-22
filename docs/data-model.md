# Data model

All data lives in one Google Sheets file, "LABFLOW Database", created by `setupInitialise`. There are **39 sheets**. The single source of truth for every column is `Cfg.SCHEMA_SRC` in `src/Config.gs`; this page explains what the tables are for. [requirements.md](requirements.md) section 4 lists the columns added for the v2 work.

## How tables are defined

Each table is a line in `SCHEMA_SRC`: space-separated column names, each `name[:type[:flags]]`.

| Part | Values |
|---|---|
| type | `s` text (default), `n` number, `b` boolean, `j` JSON |
| flags | `u` unique, `c` cached for fast lookup (`u:c` gives both) |
| first column | Primary key, always unique and cached |

Text and JSON columns are stored as plain text, so roll numbers keep leading zeros and a value starting with `=` is not a formula. Ids are made by `U.id('kind')` (for example `PRJ...` for projects).

Schema changes are **additive**. `setupInitialise` creates missing sheets, adds missing columns at the end of an older sheet, and refuses (`SCHEMA_MISMATCH`) anything else rather than "fixing" data. That is why new columns are always appended.

## Tables

**People and access**

| Table | Holds |
|---|---|
| `Users` | One row per account: email, roles (up to five), status, department, `mobile` (sealed, see [SECURITY.md](../SECURITY.md)), consent |
| `StudentProfiles` | Roll number, name, department, section, year, join year, photo file id, verification status |
| `FacultyProfiles` | Faculty name, department, employee code |
| `DeviceCredentials` | Registered phone public keys, their status, approvals and revocations |
| `Kiosks` | Kiosk accounts, each bound to one lab |

**Labs and teaching**

| Table | Holds |
|---|---|
| `Labs` | Lab code, room, capacity, GPS and radius, opening hours, check-in mode, department, open-lab flag |
| `Courses`, `FacultyCourses`, `Rosters`, `ClassReps` | Courses, who teaches them, who is enrolled, class representatives |
| `Timetable` | Weekly slots that materialise into sessions |
| `Events`, `EventGuests` | Workshops and events, with their lead, break times and guests |
| `Projects` | Student and group projects: supervisor, timeline, status, outcome |

**Attendance**

| Table | Holds |
|---|---|
| `Sessions` | Every class, event, open-lab day and research visit; `archivedAt` is set after the yearly archive |
| `AttendanceEvents` | Append-only log of scans, corrections, voids and work changes |
| `AttendanceSummaries` | One derived row per student per session; rebuildable |
| `RescanWindows`, `SpotChecks` | Rescan windows and photo spot checks |
| `Redemptions` | Used QR nonces; the source of truth for "used once" |
| `Flags` | Review queue for suspicious activity |
| `PresencePings` | Location reports: from the phone app every few minutes (tier 3) and the random checks of an open page (tier 1). Distance to the lab, accuracy and a keyed reading hash; never coordinates |
| `BioChecks` | Fingerprint checks of the phone app: when each was delivered and answered, and the outcome. A row with student `*` is a check the faculty sent to the whole class |

**Assets and bookings**

| Table | Holds |
|---|---|
| `Categories`, `Assets` | Equipment types (individually tracked or counted) and units; `Categories.workstation` marks systems students can claim |
| `Kits`, `KitComponents` | Kits and what is in them |
| `Groups`, `GroupMembers` | Student groups that borrow or book together |
| `Loans`, `LoanItems`, `AssetEvents` | Issues and returns, per-item quantities, and the stock ledger |
| `Reservations`, `EquipmentRequests` | Time-slot bookings (with waitlist) and requests made while checked in |

**Platform**

| Table | Holds |
|---|---|
| `Notifications` | In-app notices and their email status |
| `AuditEvents`, `AuditCheckpoints` | Hash-chained log of sensitive actions, and its checkpoints |
| `SystemLog` | Errors and warnings with a reference id |
| `JobRuns` | One row per background run, plus markers such as `archiveAuto:2028` |

## Settings and secrets are not in the sheet

Settings (`Cfg.SETTINGS`, 49 values with limits, edited under Admin > Settings) live in script properties as `cfg.<key>`. Secrets live in script properties too: the QR secret, the session secret, the Google client id, `PII_KEY`, and the folder and spreadsheet ids used by backups and archives. A copy of the spreadsheet therefore contains no key.

## Size and the archive

A spreadsheet is limited to 10 million cells and gets slower as it fills, mostly from `AttendanceEvents`, `SystemLog`, `JobRuns`, `Notifications`, `Redemptions` and `AssetEvents`. Each July the nightly job moves finished academic years into a spreadsheet "LABFLOW Archive YYYY-YY"; `Sessions`, `AttendanceSummaries`, `Loans`, `LoanItems` and `AuditEvents` stay live. Details: [requirements.md](requirements.md) (R14).
