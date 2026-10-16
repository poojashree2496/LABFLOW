# Progress

Status as of 16 Oct 2026. Implementation deadline: 23 Oct 2026, 5:00 PM (aim to be demo-ready by 21 Oct).

## Built

**Check-in, both versions from the SRS**
- Version A (the specification's flow): the lab kiosk shows a QR that rotates every 5-10 s; the student's phone camera opens the app with the code; the code is checked the moment the page opens and the student gets a 2-minute pass; one GPS reading is checked against the lab geofence with the reported accuracy allowed for. Coordinates are never stored (FR-7 to FR-17, FR-31).
- Version B: the phone re-signs a server nonce every 3 s with its device key; the QR is a link that the teacher's, lab staff's, class rep's or coordinator's phone opens, or the kiosk scanner reads.
- Check-in mode per lab (A, B or both), with a default in Settings.
- Both modes run as traced verification pipelines (ordered named steps; the replay check and the write run inside the lock).
- Entry reasons with timetable prefill. Self-work sessions behind workstation bookings. Research visits open on arrival. Timetabled classes open by themselves.
- Flags for review: impossible GPS accuracy, identical readings, impossible travel between labs, replayed or stale codes, two students on one phone, desktop device registration, frequent manual check-ins, repeated missing exits.

**People and events**
- Class representatives: session operator, scan classmates (session-only, roster-only, never themselves, tagged).
- Events: registration list or open to all, lunch break excluded from hours, capacity warning, coordinator rights that expire, guests.
- Privacy notice on first login (DPDP), mobile number, roll number taken from the email and locked.

**Labs, inventory, reports**
- Live occupancy on every dashboard. Lab hours with overstay alerts at closing.
- Equipment requests need an active check-in (FR-21) and are filled on the issue screen. Students see availability without checking in.
- Workstation slots: no-show released after 15 minutes; used slots counted.
- Reports: evening per-lab digest with PDF to lab incharges, monthly audit on the 1st to the HOD, custom range, session log, ERP export with fixed columns, PDF from a Docs template.
- Admin quota-usage panel. Settings stored in PropertiesService. Additive schema migration.

**UI**
- Karunya blue and gold theme, with a gold rule under every header.
- Screens for every role, including the kiosk display / scanner / split view, the phone scanner with photo, flags review, events, class reps and lab geofence editing.

**Test Lab (`npm run dev`, then /lab; local only)**
- Seeded department world and a simulated clock.
- Trigger jobs on demand.
- Pipeline fault injection with live step traces.
- 27 scripted scenarios: the class rush and every SRS 15.4 attack.
- Stage with the kiosk and two phones side by side, a QR relay and simulated GPS.
- Live theme editor with presets, and data/mail/audit browsers.

**Checks**
- 127 backend tests pass.
- 27 of 27 scenarios pass.
- Browser E2E: 17 of 18 checks pass.

## Left

- [ ] E2E: move the equipment-request step before the clock jumps to 14:00 (the 10:00 class auto-closes, so the student is no longer inside). This is a test-ordering issue, not an app bug.
- [ ] `docs/` folder: architecture, attendance (both modes and the pipeline), data model, deployment, testing and Test Lab, FR traceability matrix (FR-1 to FR-39 mapped to tests), the SRS PDF.
- [ ] Rewrite README.md (screenshots from `.build/shots`, features, quick start, team) and refresh SECURITY.md and TEST_PLAN.md for both modes.
- [ ] Copy the new screenshots into `docs/screens/`.
- [ ] Add a `.gitattributes` (LF line endings).
- [ ] Force-push the rewritten history to origin/main once the above is committed.
- [ ] Deployment checks that need the real Workspace (TEST_PLAN section B): identity for both domains first, then GPS and camera inside the HtmlService iframe, key persistence on iPhone, `Setup.benchmarkScans()` timings, trigger runs, quota use.
- [ ] Measured cost: about 38 sheet operations per kiosk check-in and 20 per device-QR scan. Measure on the real runtime with `Setup.benchmarkScans()` and trim the locked section if the 9 AM rush is slow.
