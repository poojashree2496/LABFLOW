# LABFLOW test plan and results

Last full run on the build in this repository: `npm run check` and `npm run e2e`.

## A. What actually ran

| Suite | Command | Result |
|---|---|---|
| Syntax lint of every `.gs` (as plain V8 scripts) and every inline `<script>` in `.html` | `npm run lint` | all files ok |
| Backend: foundation (16), access (16), attendance (30), checkin (12), scanning (9), inventory (21), jobs (12), platform (14), api (7) | `npm test` | **137 pass, 0 fail** |
| Browser E2E (Playwright, real Chromium) | `npm run e2e` | **74 pass, 0 fail** |

How the backend tests work: `test/harness.js` loads the real `src/*.gs` files into a Node `vm` with hand-written fakes of SpreadsheetApp, CacheService, LockService, PropertiesService, Utilities, MailApp/GmailApp, DriveApp, ScriptApp and Session. The fakes are as faithful as I could make them, but they are my interpretation of Google's behaviour.

What the backend tests cover: schema creation and mismatch refusal; role routing and denial for each role; unauthenticated and wrong-domain refusal; kiosk-only access; rate limit; payload size limit; registration challenge and in-person approval for second/replacement devices; QR validity (bad signature, tampered token, expired, wrong lab, wrong session, wrong student, revoked credential, replay, concurrent duplicate); exit handling (a missing exit never credits the whole session); rescans and spot checks; corrections, voids and admin approval of old corrections; student history including an open session; timetable conflict detection; loans, kits, reservations, idempotent issue/return and reconciliation; booking capacity; audit chain tamper, truncation and head rewrite; the four trigger handlers, their minimum intervals and the email digest/transport switch; CSV formula neutralisation.

What the E2E covers (browser against the real server code on fakes): student device registration with real WebCrypto and server-side P-256 verification, key-storage compatibility check, faculty opens session, QR render and countdown, kiosk accept and replay refusal, student phone confirmation, live roster, spot check, exit scan, advance booking, research-visit approval, staff issue and return, booking approval, all 13 admin pages load, no horizontal scroll at 390 px (using `scrollWidth`), a student calling an admin action is denied by the server, no unlabeled controls on the admin page, no console errors. Every site theme (10) is switched on in turn: student (390 px phone), faculty, admin, kiosk and the hosted sign-in screen must render with no sideways scroll, and the kiosk QR and every element above it must carry no transform, filter, blend mode, clip or opacity, so no theme can make the code unscannable.

## B. NOT tested: needs a real Workspace deployment

Run these after deploying; each is a pass/fail check.

| # | Check | How | Why it matters |
|---|---|---|---|
| 1 | Identity for both domains | Open the app as an ordinary user from `karunya.edu` and from `karunya.edu.in` | `getActiveUser()` may be blank for users outside the deployer's Workspace domain. See README. **Highest risk.** |
| 2 | `setupInitialise`, `setupBootstrapAdmin`, `setupSelfTest` | Run from editor, read the output | Real sheet latency, lock time, P-256 verify time on the real runtime |
| 3 | Triggers | `setupInstallTriggers`, then check the Triggers page after a day | Handlers named `trg_*` should work; confirm they ran (admin "Audit & system" > health) |
| 4 | Key persistence in the HtmlService iframe | Register on an Android Chrome phone and an iPhone Safari; close the browser, reopen, generate a QR | IndexedDB in the sandboxed iframe may be partitioned or evicted |
| 5 | Camera/scanner | Kiosk with a USB scanner; kiosk with camera mode in Chrome | `getUserMedia` inside the iframe needs the camera permission policy to allow it |
| 6 | Real scan latency | 30 students scanning within 2 minutes | Lock contention, `rpc` latency (each call is hundreds of ms in Apps Script) |
| 7 | Quotas | One day of email digests plus a PDF report | MailApp/Gmail daily limits, Drive and Docs quotas |
| 8 | Audit anchors | Confirm the anchor email arrives and is archived by someone other than the owner | Required for the audit chain to mean anything |
| 9 | Colour, fonts, layout on real phones | Visual check of each site theme the department might pick; scan the kiosk QR with a real phone under each | Google Fonts load from CDN; only the active theme's fonts are fetched |
| 10 | Accessibility with a screen reader | NVDA or VoiceOver pass through the student and kiosk flows | Automated check covers only unlabeled controls |
| 11 | Physical controls dry run | A real session with a rescan, a spot check and a deliberate relay attempt | Measures whether the controls catch what the design claims |

## C. Known gaps in automated coverage

- No frontend unit tests; the UI is covered only by the E2E flow. Admin pages are checked for loading, not for every form.
- The E2E uses Chromium only. Safari/Firefox are untested.
- PDF report generation is exercised against the fake DocumentApp/DriveApp, so real PDF output has not been seen.
- No load test, and no test of the real `LockService` timeout behaviour.
