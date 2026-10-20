# Tasks (what is left to do)

Only open work lives here. When something is finished, **delete it from this file and add it to [progress.md](progress.md)** with the date and what was actually run. Never move an item to progress.md unless it was really done.

Legend: `[ ]` not started, `[~]` in progress, `[!]` blocked (say why). Order inside each section is priority order. Put your name in place of `@?` when you take a task.

Implementation deadline: 23 Oct 2026, 5:00 PM.

Last updated: 2026-10-21

---

## 0. Teacher brief v2 (due 23 Oct)

What and why: [requirements.md](requirements.md) (R1-R18, the decisions, and the **contracts**). How to work in this repo: [CONTRIBUTING.md](../CONTRIBUTING.md).

### How we split it

- Three workstreams, five tasks each, plus shared tasks:
  - **WS-A**: data, security and the queue. Backend.
  - **WS-B**: roles, dashboards, live board and reports. Mixed.
  - **WS-C**: extra-hours check-in and projects. UI-heavy; this is the demo story.
- One branch per workstream: `ws-a-data`, `ws-b-roles`, `ws-c-extrahours`. Open small PRs into `main`, and keep `npm run check` green before each merge. Rebase on `main` before opening a PR.
- **The contracts are in the code (S0, done 19 Oct).** Every v2 route is in `ROUTES` with its final roles, and every schema column exists. Unfinished routes call a stub method in their service that answers `NOT_IMPLEMENTED` with its task id (search for `notBuilt_('B4')`, for example). Replace only your own stubs. C1 projects, C2 daily open lab, C3 project/system selection and C4 automatic sign-out are implemented; see docs/projects.md, docs/openlab.md, docs/work-selection.md and the progress log. You should not need to edit `Code.gs` ROUTES, `Config.gs` SCHEMA_SRC or the load lists; `test/contracts.test.js` fails if a contract drifts.
- Need a contract changed? Open a PR that edits requirements.md section 4 and get all three people to agree.
- Test counts in README, TEST_PLAN and progress.md: whoever merges last on a given day updates them.
- A4 moves one read inside `Attend.rebuildSummary`. Automatic open-lab closure already calls it under an outer script lock; preserve that recovery path.

### Timeline

| Day | Work |
|---|---|
| Sun 19 / Mon 20 | A1, B1, C1 (S0 is done) |
| Tue 21 | Real lab data arrives (C5). A2, A3, B2, B3, C2, C3 |
| Wed 22 | A4, A5, B4, B5, C4. S1 docs, S2 demo and screenshots |
| Thu 23 | Demo by 5:00 PM |

### Shared (owner)

- [ ] **S1 Docs** (@?)
  - README: features, the five role dashboards, a quick start, screenshots.
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

- [ ] **A4 Yearly archive** (R14)
  - Files: `BackupService.gs` (`Backup.archiveYear`), `Setup.gs` (extract `Setup.ensureSchema(ss, tables)` from `Setup.initialise`), `AttendanceService.gs` (`Attend.rebuildSummary`, `Attend.correct`, `Attend.decideCorrection`), `AdminService.gs` (reconcileSession), `ReportService.gs`, `TriggerService.gs`, `Code.gs` (`system.archive`), `ScriptsAdmin.html`, `test/harness.js` (`deleteRows` on FakeSheet).
  - Archive spreadsheet per academic year, `LABFLOW Archive 2025-26`. Keep its ids in one script property (JSON map).
  - The move runs under `Locks.with`: copy, verify the counts, then delete from the live sheet, in chunks that stop at the job deadline and resume next run.
    - Archive whole sessions only, and skip any session with a pending correction or a pending `JobRuns` `openlabClose` journal; retain those journals until closure recovery completes.
    - AssetEvents plan and complete rows move together.
  - Move the existing-summary read in `Attend.rebuildSummary` inside the lock. Today it reads `__row` outside the lock and writes inside it; deleting rows in between would overwrite the wrong row.
  - Set `Sessions.archivedAt`. `Attend.correct`, `Attend.decideCorrection` and `system.reconcileSession` refuse it with `ARCHIVED`.
  - Reports that read events (`_digest`, `_erp`, `_session`) say "archived" for those sessions.
  - Auto-run in July using a JobRuns marker, plus the academic-year start-month setting (default June).
  - Done when: after archiving, student history and totals are unchanged, the live AttendanceEvents row count drops, the archive holds the rows, a correction on an archived session is refused, and the audit chain still verifies.
  - Tests: new `test/archive.test.js`.
### WS-B Roles, dashboards, live board and reports (@?)

### WS-C Extra-hours check-in and projects (@?)

- [ ] **C5 Confirm Intel Unnati AI Lab data** (R8, real inputs expected 21 Oct)
  - The demo seed is implemented; see [Unnati demo](unnati-demo.md). It has 30 marked demo workstations, sample equipment/projects and current visits in every preset.
  - Replace the placeholder building, room, synthetic GPS/radius, capacity, hours and inventory with confirmed details in `dev/world.js`; update seed assertions and the demo notes.
  - Verify the real geofence at the lab door during deployment. No real location or asset list has been supplied yet.

HOD read/write policy and department scoping are implemented; see [HOD access](hod-access.md).

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
