# Tasks (what is left to do)

Only open work lives here. When something is finished, **delete it from this file and add it to [progress.md](progress.md)** with the date and what was actually run. Never move an item to progress.md unless it was really done.

Legend: `[ ]` not started, `[~]` in progress, `[!]` blocked (say why). Order inside each section is priority order.

Implementation deadline: 23 Oct 2026, 5:00 PM (aim to be demo-ready by 21 Oct).

Last updated: 2026-10-17

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

## 2. Next up (docs, before the demo)

- [ ] `docs/` pages: architecture, attendance (both modes and the pipeline), data model, deployment, testing and Test Lab, FR traceability matrix (FR-1 to FR-39 mapped to tests).
- [ ] Docs: a page on the site themes (how to pick one, what each changes, and how to add one: a stylesheet in `styles/themes/`, an entry in `src/ScriptsThemes.html`, the id in the `uiTheme` setting).
- [ ] Rewrite README.md (screenshots, features, quick start, team) and refresh SECURITY.md and TEST_PLAN.md for both modes.
- [ ] Copy the new screenshots from `.build/shots` into `docs/screens/`.
- [ ] Add a `.gitattributes` (LF line endings).

## 3. Build (after the demo)

- [ ] Rerun the browser flow after the critical workflow audit (local attempt could not start: `playwright-core` absent). Pay particular attention to staff issue/return and both attendance modes. See [workflow-audit.md](workflow-audit.md).
- [ ] Benchmark return recovery with a large AssetEvents ledger; consider indexing pending return plans to avoid scanning the complete ledger under the lock on each inventory mutation.
- [ ] Theme CSS ships for all ten themes on every page load (Styles.html is about 270 KB). Split it per theme if load time on the campus network is a problem.
- [ ] Frontend unit tests (the UI is covered only by the browser flow).
- [ ] Run the browser flow in Safari and Firefox.
- [ ] Hardening: WebAuthn, only if the UI can be served from an origin you own.
- [ ] Hardening: set `EMAIL_TRANSPORT=mail` and drop the broad Gmail scope from `appsscript.json`.

## 4. Backlog / ideas

Add ideas here before they become tasks.

-
