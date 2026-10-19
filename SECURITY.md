# LABFLOW security notes

Written to be read critically. Each section says what is enforced, what is only mitigated, and what is not solved.

## 1. Trust boundaries

- **Identity** comes only from `Session.getActiveUser().getEmail()` on the server, restricted to `karunya.edu` and `karunya.edu.in`. Blank means refuse (`NO_IDENTITY`). The browser never supplies an email, role, roll number or student id that the server believes. See README "Authentication" for the deployment blocker this implies.
- **Authorisation** is in the router (`Code.gs` ROUTES: per-action role list, rate limit, max payload) and again inside services (for example a student can read only their own events; faculty only their own sessions). The UI hiding a button is cosmetic. E2E confirms a student calling an admin action is refused by the server.
- **Kiosks** are separate Google accounts bound to one lab and can call only `kiosk.ping` and `kiosk.scan`.
- **Setup functions** are not in the router and call `ownerOnly_()`.
- **Spreadsheet injection:** text columns are stored as plain text; values beginning with `=`, `+`, `-`, `@` are neutralised on CSV export. No data is written to the DOM with `innerHTML`.
- **Concurrency:** state-changing operations run under `LockService`; loan/booking/attendance writes carry idempotency keys so retries do not duplicate.

The [critical workflow audit](docs/workflow-audit.md) adds fresh student/account, scanner, lab and code-freshness checks inside the attendance write lock. Device rejection and revocation hold the lock across their state checks and updates. Equipment fulfilment is validated before writes, and interrupted returns persist a recovery plan before changing counters. These paths are tested with deterministic write failures and interleavings on fakes; real Workspace concurrency and throughput remain unverified.

Project/system assignments are checked against the authenticated student, active group membership, project status and lab. Workstation claims and booking checks run under the attendance write lock, with a second check after GPS acquisition. Mid-visit WORK events are append-only, bound to an entry and expected version, and use client event ids for safe retries. They never verify attendance or reset the exit gap. System choices expose availability without other occupants' identities. These are reported assignments rather than computer/device identity.

The named `labs.live` board is restricted to faculty/staff/admin and department-scoped HOD accounts. HOD reads fail closed until the shared department helper is implemented. Snapshots never enter the public occupancy cache. `systems.status` returns no occupant, project or reservation identities; student responses use only free/busy. The board clears previous visitor data after a failed/refused refresh and discards late responses after navigation.

## 2. Attendance: device-bound reverse QR

Design: the phone proves possession of a registered key by signing a fresh server challenge; the kiosk only relays. The QR is `token~signature`, the token is an HMAC-protected, stateless blob bound to student, credential, session, lab and challenge.

Enforced in code and tested: signature verification (P-256 against the registered public key), HMAC, expiry (default 60 s, 20–180 configurable), open-session and lab match, enrolment, credential revocation, single use (Redemptions sheet + cache nonce, under lock), concurrent duplicate scans, replay refusal, scan rate limits, in-person approval for any device registration after the first or when the active limit is reached.

### WebAuthn versus a device signing key (evaluation)

WebAuthn/passkeys would give hardware-backed keys and phishing-resistant origin binding, which is better key protection. It was not used because the web app runs inside HtmlService's sandboxed iframe on `googleusercontent.com`, where the RP ID/origin is not a stable, controllable origin you own, and platform support inside that iframe is unverified here. A WebCrypto key is the portable option that works in that environment. **Trade-off: the key is software-held.** It is created `extractable: false`, so page script cannot read the private key bytes, but this is a browser guarantee, **not a hardware guarantee**. A compromised device or browser profile can still *use* the key. If your deployment can serve the UI from your own origin, moving to WebAuthn is the recommended hardening.

### Residual risks (not eliminated)

1. **Live QR relay.** A friend with the real, registered phone can send a live QR screenshot or stream to someone at the kiosk within the 60 s window. The signature proves the key signed, not where the phone is. Mitigations: short TTL, single use, random rescans, faculty spot checks against the photo, exit scans. These raise cost and add evidence; they do not stop a determined group.
2. **Device compromise.** Malware or a rooted device can use the key. Revocation and re-registration need in-person approval, which limits blast radius.
3. **Collusion.** A student lending their phone for the whole session, or faculty/staff approving falsely. Manual exceptions and corrections are audited and old ones need admin approval, but a colluding insider is visible only after the fact.
4. **Storage eviction.** Browsers (notably Safari) may delete IndexedDB. The student must re-register with desk approval.
5. **No MAC, IMEI or client GPS** is used as identity. Client-reported location is trivially spoofed, so it is not trusted.

## 3. Audit log

Every sensitive action appends a row with `hash = SHA-256(prev_hash + canonical row)`. Checkpoints store the head in a sheet, in a script property, and in emailed anchors. `Audit.verify` detects edits, deletions in the middle, truncation and head rewrite (tested).

**Limits, stated plainly:** this is tamper-*evident*, not tamper-*proof*. Whoever owns the spreadsheet and script can recompute the whole chain and replace the sheet and the script property. The emailed anchors (sent to people outside the owner's control) are what make a full rewrite detectable, so the recipients must actually keep them. Audit rows record the actor's server-verified email, never client-claimed values.

## 4. Other controls and their weaknesses

- **Rate limiting** uses `CacheService` counters. It is approximate (cache can evict, counters are not atomic across instances). It slows abuse; it is not a hard guarantee.
- **OAuth scopes** are broad because the app uses Sheets, Drive, Docs and Gmail. `https://mail.google.com/` (GmailApp) is the broadest. Set the script property `EMAIL_TRANSPORT=mail` to use `MailApp` (`script.send_mail` only) and remove the broad scope from `appsscript.json`; the cost is no threaded Gmail features, which the app does not need.
- **Execute-as-owner** means the script owner's Drive/Sheets quota and permissions apply to all users, and the DB spreadsheet must not be shared with users. Anyone with edit access to the spreadsheet or script bypasses all application authorisation, so keep that set minimal.
- **Student photos** are in a private Drive folder owned by the script owner and served only through authorised RPC calls.
- **Secrets:** the QR HMAC secret lives in script properties. `Setup.rotateQrSecret` invalidates live QRs.
- **No passwords** are stored anywhere.

## 5. Third-party code

| Component | Use | Licence |
|---|---|---|
| @noble/curves 1.9.7 | P-256 ECDSA verification, bundled into `Vendor_P256.gs` (Apps Script has no native ECDSA) | MIT |
| qrcode-generator 2.0.4 | QR rendering in the browser | MIT |
| Tailwind CSS 3.4 | build-time only; compiled CSS is in `Styles.html` | MIT |
| Google Fonts (Anton, Instrument Serif, Inter) | runtime CDN load | SIL OFL |

The signature verifier is third-party code running inside the trust boundary. It is covered by known-answer and tamper tests, and `setupSelfTest()` re-checks it on the real runtime.

## 6. Reporting

Report suspected vulnerabilities privately to the project owner rather than in a public issue.
