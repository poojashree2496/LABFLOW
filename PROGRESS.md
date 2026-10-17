# Progress

Status as of 17 Oct 2026. Implementation deadline: 23 Oct 2026, 5:00 PM (aim to be demo-ready by 21 Oct).

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
- Ten site themes, chosen by the administrator in Settings > Appearance and applied to every user, the kiosks and the sign-in screen. Each one changes the layout as well as the look: Karunya (the default: the university portal look with the Karunya logo, a profile header and dashed stat boxes), neo-brutalism, pixel art, wabi-sabi, cybercore, maximal library, scrapbook, post-internet, luxury type and bohemian. Only the active theme's fonts load. No theme may restyle a QR code or the camera preview.
- Screens for every role, including the kiosk display / scanner / split view, the phone scanner with photo, flags review, events, class reps and lab geofence editing.

**Test Lab (`npm run dev`, then /lab; local only)**
- Seeded department world and a simulated clock.
- Trigger jobs on demand.
- Pipeline fault injection with live step traces.
- 27 scripted scenarios: the class rush and every SRS 15.4 attack.
- Stage with the kiosk and two phones side by side, a QR relay and simulated GPS.
- A site-theme switcher with a live preview as any role, and data/mail/audit browsers.

**Hosted app**
- Google sign-in, signed LABFLOW sessions and a JSON API to the Apps Script backend, served as an installable app from Vercel.

**Checks**
- 136 backend tests pass.
- 27 of 27 scenarios pass.
- Browser E2E: 74 of 74 checks pass, including every theme on every role and a check that no theme touches the kiosk QR.

## Left

- [ ] `docs/` folder: architecture, attendance (both modes and the pipeline), data model, deployment, testing and Test Lab, FR traceability matrix (FR-1 to FR-39 mapped to tests), the SRS PDF.
- [ ] Rewrite README.md (screenshots from `.build/shots`, features, quick start, team) and refresh SECURITY.md and TEST_PLAN.md for both modes.
- [ ] Copy the new screenshots into `docs/screens/`.
- [ ] Add a `.gitattributes` (LF line endings).
- [ ] Docs: a page on the site themes (how to pick one, what each changes, and how to add one: a stylesheet in `styles/themes/`, an entry in `src/ScriptsThemes.html`, the id in the `uiTheme` setting).
- [ ] Theme CSS ships for all ten themes on every page load (Styles.html is about 270 KB). Split it per theme if load time on the campus network is a problem.
- [ ] Deployment checks that need the real Workspace (TEST_PLAN section B): identity for both domains first, then GPS and camera inside the HtmlService iframe, key persistence on iPhone, `Setup.benchmarkScans()` timings, trigger runs, quota use.
- [ ] Measured cost: about 38 sheet operations per kiosk check-in and 20 per device-QR scan. Measure on the real runtime with `Setup.benchmarkScans()` and trim the locked section if the 9 AM rush is slow.
