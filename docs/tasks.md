# Tasks (what is left to do)

Only open work lives here. When something is finished, **delete it from this file and add it to [progress.md](progress.md)** with the date and what was actually run. Never move an item to progress.md unless it was really done.

Legend: `[ ]` not started, `[~]` in progress, `[!]` blocked (say why). Order inside each section is priority order. Put your name in place of `@?` when you take a task.

Implementation deadline: 23 Oct 2026, 5:00 PM.

Last updated: 2026-10-22

---

## 0. Teacher brief v2 (due 23 Oct)

What and why: [requirements.md](requirements.md) (R1-R18, the decisions, and the **contracts**). How to work in this repo: [CONTRIBUTING.md](../CONTRIBUTING.md).

### How we split it

- Three workstreams, five tasks each, plus shared tasks:
  - **WS-A**: data, security and the queue. Backend.
  - **WS-B**: roles, dashboards, live board and reports. Mixed.
  - **WS-C**: extra-hours check-in and projects. UI-heavy; this is the demo story.
- One branch per workstream: `ws-a-data`, `ws-b-roles`, `ws-c-extrahours`. Open small PRs into `main`, and keep `npm run check` green before each merge. Rebase on `main` before opening a PR.
- **The contracts are in the code (S0, done 19 Oct).** Every v2 route is in `ROUTES` and every schema column exists; all A, B and C1-C4 stubs are now replaced (no `notBuilt_` calls remain). `test/contracts.test.js` fails if a contract drifts.
- Need a contract changed? Open a PR that edits requirements.md section 4 and get all three people to agree.
- Test counts in README, TEST_PLAN and progress.md: whoever merges last on a given day updates them.

### Timeline

| Day | Work |
|---|---|
| Sun 19 / Mon 20 | A1, B1, C1 (S0 is done) |
| Tue 21 | Real lab data arrives (C5). A2, A3, B2, B3, C2, C3 |
| Wed 22 | A4, A5, B4, B5, C4. S1 docs, S2 demo and screenshots |
| Thu 23 | Demo by 5:00 PM |

### Shared (owner)

- [~] **S2 Demo** (@kukyos 22 Oct)
  - Script written: [demo.md](demo.md) (Test Lab) and [presenting.md](presenting.md) (live site, IBM CoE / DBMS lab, with prep list and expected questions). Rehearse both once end to end.
  - Live prep from presenting.md: door GPS and opening hours with walk-ins for the CoE lab, a timetable slot on the demo day, an HOD account, the kiosk signed in at the door, one approved project, a first backup, and two real phone check-ins (one inside, one refused outside).
  - E2E screenshots refreshed 21 Oct. `03-faculty-today`, `05-kiosk-accepted` and `11-staff-issue` in `docs/screens` are no longer produced by any suite and nothing links them; delete or keep.
  - Swap the Unnati placeholders in the script for the real details when C5 lands.

### WS-C Extra-hours check-in and projects (@?)

- [ ] **C5 Confirm Intel Unnati AI Lab data** (R8, real inputs expected 21 Oct)
  - The demo seed is implemented; see [Unnati demo](unnati-demo.md). It has 30 marked demo workstations, sample equipment/projects and current visits in every preset.
  - Replace the placeholder building, room, synthetic GPS/radius, capacity, hours and inventory with confirmed details in `dev/world.js`; update seed assertions and the demo notes.
  - Verify the real geofence at the lab door during deployment. No real location or asset list has been supplied yet.
  - Meanwhile the live site runs on the IBM Big Data Software CoE (DBMS Lab), set up by the owner on 21 Oct. Adding Unnati live is one lab row, a kiosk and its assets from the admin screens.

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
- [ ] **Tier 3 phone app** (branch `tier3-app`, see [phone-app.md](phone-app.md)): merge, `clasp push`, run `setupInitialise` (adds PresencePings, BioChecks and four appended columns), new deployment version, Vercel deploy (the web link-code screen). Then on a real Android phone: install the APK, link, check in, lock the screen for 20 minutes and confirm reports keep arriving, answer a fingerprint check, try a mock-location app, try airplane mode and reconnect. Check the Apps Script redirect from `/exec` works from the app's HTTP client. Try one Xiaomi/Oppo/Vivo phone for battery killing.
- [ ] Live: set the IBM CoE (DBMS) lab door GPS from a phone in the room, then one check-in inside (passes) and one more than 80 m away (refused). The 21 Oct class closed with 0 of 60 marked, so no live check-in has succeeded yet.

## 2. Build (after the demo)

- [ ] Benchmark return recovery with a large AssetEvents ledger; consider indexing pending return plans to avoid scanning the complete ledger under the lock on each inventory mutation.
- [ ] Theme CSS ships for all ten themes on every page load (Styles.html is about 270 KB). Split it per theme if load time on the campus network is a problem.
- [ ] Frontend unit tests (the UI is covered only by the browser flow).
- [ ] Run the browser flow in Safari and Firefox.
- [ ] Hardening: WebAuthn, only if the UI can be served from an origin you own.
- [ ] Hardening: set `EMAIL_TRANSPORT=mail` and drop the broad Gmail scope from `appsscript.json`.
- [ ] Department rollout: scope the generic lists (not only the HOD views) by `Auth.labScope` once a second department joins.

## 3. Backlog / ideas

Add ideas here before they become tasks.

-
