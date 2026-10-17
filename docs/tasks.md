# Tasks (what is left to do)

Only open work lives here. When something is finished, **delete it from this file and add it to [progress.md](progress.md)** with the date and what was actually run. Never move an item to progress.md unless it was really done.

Legend: `[ ]` not started, `[~]` in progress, `[!]` blocked (say why). Order inside each section is priority order.

Last updated: 2026-10-17

---

## 1. Deployment checks (need a real Google Workspace, so none are done)

Do these first. Write the date and result next to each when you finish it.

- [ ] **Identity for both domains.** Open the web app as an ordinary user from `karunya.edu` and from `karunya.edu.in`. Highest risk: if the second domain is a separate Workspace, its users will be refused. See README "Authentication".
- [ ] Run `setupInitialise`, `setupBootstrapAdmin`, `setupSelfTest`; read the real timings (P-256 verify, sheet write, lock).
- [ ] Run `setupInstallTriggers`; confirm all four triggers ran after a day.
- [ ] Device key survives closing the browser (Android Chrome and iPhone Safari).
- [ ] Kiosk with a USB scanner; kiosk with camera mode in Chrome.
- [ ] 30 students scanning within 2 minutes (latency, lock contention).
- [ ] One day of email digests and one PDF report (quotas).
- [ ] Audit anchor email arrives and is kept by someone other than the script owner.
- [ ] Screen-reader pass (NVDA or VoiceOver) on the student and kiosk flows.
- [ ] Physical dry run: a rescan, a spot check, and a deliberate relay attempt.

## 2. Next up (build)

- [ ] `Setup.benchmarkScans`: measure real scan throughput on the deployment.
- [ ] Frontend unit tests (the UI is covered only by the browser flow).
- [ ] Run the browser flow in Safari and Firefox.
- [ ] Hardening: WebAuthn, only if the UI can be served from an origin you own.
- [ ] Hardening: set `EMAIL_TRANSPORT=mail` and drop the broad Gmail scope from `appsscript.json`.

## 3. Backlog / ideas

Add ideas here before they become tasks.

-
