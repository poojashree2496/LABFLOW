# LABFLOW security notes

Written to be read critically. Each section says what is enforced, what is only mitigated, and what is not solved.

## 1. Trust boundaries

- **Identity** comes only from `Session.getActiveUser().getEmail()` on the server, restricted to `karunya.edu` and `karunya.edu.in`. Blank means refuse (`NO_IDENTITY`). The browser never supplies an email, role, roll number or student id that the server believes. See README "Authentication" for the deployment blocker this implies.
- **Authorisation** is in the router (`Code.gs` ROUTES: per-action role list, rate limit, max payload) and again inside services (for example a student can read only their own events; faculty only their own sessions). The UI hiding a button is cosmetic. E2E confirms a student calling an admin action is refused by the server.
- **Kiosks** are separate Google accounts bound to one lab and can call only the kiosk routes (`kiosk.ping`, `kiosk.display`, `kiosk.scan`).
- **Setup functions** are not in the router and call `ownerOnly_()`.
- **Spreadsheet injection:** text columns are stored as plain text; values beginning with `=`, `+`, `-`, `@` are neutralised on CSV export. No data is written to the DOM with `innerHTML`.
- **Concurrency:** state-changing operations run under `LockService`; loan/booking/attendance writes carry idempotency keys so retries do not duplicate.

The [critical workflow audit](docs/workflow-audit.md) adds fresh student/account, scanner, lab and code-freshness checks inside the attendance write lock. Device rejection and revocation hold the lock across their state checks and updates. Equipment fulfilment is validated before writes, and interrupted returns persist a recovery plan before changing counters. These paths are tested with deterministic write failures and interleavings on fakes; real Workspace concurrency and throughput remain unverified.

Project/system assignments are checked against the authenticated student, active group membership, project status and lab. Workstation claims and booking checks run under the attendance write lock, with a second check after GPS acquisition. Mid-visit WORK events are append-only, bound to an entry and expected version, and use client event ids for safe retries. They never verify attendance or reset the exit gap. System choices expose availability without other occupants' identities. These are reported assignments rather than computer/device identity.

The named `labs.live` board is restricted to faculty/staff/admin and department-scoped HOD accounts. HOD reads use the current account department plus shared labs; no assigned department grants shared labs only. Snapshots never enter the public occupancy cache. `systems.status` returns no occupant, project or reservation identities; student responses use only free/busy. The board clears previous visitor data after a failed/refused refresh and discards late responses after navigation.

System-usage reports allow coordinators/super admins and department-scoped HODs; project reports also allow the named supervisor. Client-supplied report scope is overwritten by server authorization. HOD report scope is enforced before building rows, counts or exports. Student reports remain self-only or subject to the existing faculty roster check. CSV formula neutralization and safe text rendering apply to the new report fields.

HOD-only business mutations are refused by an explicit action policy, including generic user/any routes. Updating the caller's own mobile/consent and marking their own notifications read remain allowed and cannot change roles or department. Role/department administration stays super-admin-only. Legacy reads, direct IDs, activity/audit data and exports are scoped on the server. Imported student departments survive onboarding. See [HOD access](docs/hod-access.md).

## 2. Attendance: device-bound reverse QR

Design: the phone proves possession of a registered key by signing a fresh server challenge; the kiosk only relays. The QR is `token~signature`, the token is an HMAC-protected, stateless blob bound to student, credential, session, lab and challenge.

Enforced in code and tested: signature verification (P-256 against the registered public key), HMAC, expiry (default 60 s, 20–180 configurable), open-session and lab match, enrolment, credential revocation, single use (Redemptions sheet + cache nonce, under lock), concurrent duplicate scans, replay refusal, scan rate limits, in-person approval for any device registration after the first or when the active limit is reached.

### WebAuthn versus a device signing key (evaluation)

WebAuthn/passkeys would give hardware-backed keys and phishing-resistant origin binding, which is better key protection. It was not used because the web app runs inside HtmlService's sandboxed iframe on `googleusercontent.com`, where the RP ID/origin is not a stable, controllable origin you own, and platform support inside that iframe is unverified here. A WebCrypto key is the portable option that works in that environment. **Trade-off: the key is software-held.** It is created `extractable: false`, so page script cannot read the private key bytes, but this is a browser guarantee, **not a hardware guarantee**. A compromised device or browser profile can still *use* the key. If your deployment can serve the UI from your own origin, moving to WebAuthn is the recommended hardening.

### Residual risks (not eliminated)

1. **Live QR relay.** A friend with the real, registered phone can send a live QR screenshot or stream to someone at the kiosk within the 60 s window. The signature proves the key signed, not where the phone is. Mitigations: short TTL, single use, unannounced rescans called by the faculty, faculty spot checks against the photo, exit scans. The optional **two-read check** (setting `scanLivenessReads` = 2) makes the scanner read the QR twice with a new signed timestamp the second time: a photo or screenshot has one timestamp and never passes, so the friend must stream live video of the phone, which is harder to do casually and leaves the same evidence trail. Off by default because each check-in takes about three seconds longer. These raise cost and add evidence; they do not stop a determined group relaying live video.
2. **Device compromise.** Malware or a rooted device can use the key. Revocation and re-registration need in-person approval, which limits blast radius.
3. **Collusion.** A student lending their phone for the whole session, or faculty/staff approving falsely. Manual exceptions and corrections are audited and old ones need admin approval, but a colluding insider is visible only after the fact.
4. **Storage eviction.** Browsers (notably Safari) may delete IndexedDB. The student must re-register with desk approval.
5. **No MAC, IMEI or client GPS** is used as identity. Client-reported location is trivially spoofed, so it is not trusted. Since 22 Oct a location outside the lab or an impossible reading no longer refuses a check-in in tier 1 either; it is recorded, flagged and not counted as present until the faculty decide.
6. **First claim of a roll number.** With `studentAutoVerify` on (the default), the first Google account to claim an imported roll number that has no email on file is verified without a desk check, and that account's first phone becomes the device. Someone could claim a classmate's number first. The claim is audited with the claimer's Google account, the number cannot be claimed twice (the real student is refused and goes to the desk, which can unlink it), and a phone change still needs in-person approval. Importing students with their Karunya emails removes the risk, because then only that email can claim the number. Turn the setting off to have staff verify every claim.

### Tier 3: the phone app (Android, `android/`, `src/PresenceService.gs`)

Design: the app holds two P-256 keys in the Android Keystore. The **device key** signs every check-in (`c1|kiosk code|in/out|time|lat|lng|accuracy|mock`) and every presence report (`p1|session|sequence|time|lat|lng|accuracy|mock`). The **fingerprint key** is created with `setUserAuthenticationParameters(0, AUTH_BIOMETRIC_STRONG)` and `setInvalidatedByBiometricEnrollment(true)`: each use needs a fresh strong biometric, a PIN or pattern cannot unlock it, and enrolling a new fingerprint destroys it. The server stores both public keys (`DeviceCredentials`, kind `app`) and verifies every signature with the same P-256 verifier as tier 2 (it accepts the high-S signatures Android produces).

Linking: the signed-in web app issues a single-use HMAC code bound to the student, valid 5 minutes (`app.pairCode`). The app sends it to the session-free `app.link` with both public keys and a signature of the code by each key (the fingerprint one needs a fingerprint). The code is redeemed once under the lock; the app gets an ordinary 30-day LABFLOW session for that student. The first app phone is active at once; any later one is `pending_approval` until faculty, a coordinator or a super admin approves it, and approving it replaces the old one. The same phone signing in again with the same keys keeps its link.

Enforced in code and tested: device-key signature on every check-in and report (a bad one is refused and flagged `tampered_report`), report sequence numbers (a repeat is flagged `replayed_report`), fingerprint answers signed by the fingerprint key over a server nonce (a device-key signature or a late answer does not pass), random check times derived from an HMAC of the server secret (not stored, not sent to the phone before they are due, different per student), kiosk code freshness, location against the lab radius plus `appRadiusSlackM`, mock-location flag, impossible jumps, frozen locations, reports dated in the future. **Location problems never refuse a check-in** (all tiers, owner decision 22 Oct): they are recorded with assurance `flagged` and raise a flag; in a tier-3 session any open flag makes the result Flagged until the faculty dismiss it or override the result (an audited `OVERRIDE` event).

Residual risks:

1. **Rooted or modified phone.** Root access can fake the location, clear the mock flag and drive the app's keys. Hardware attestation (Play Integrity) would catch most of this, but it needs a paid Play Console account and was ruled out (the brief says free only). The fingerprint key still needs a real enrolled fingerprint on that phone.
2. **A friend's finger enrolled on the student's phone.** The phone then passes fingerprint checks while it stays in the lab with the friend. Enrolling a new fingerprint destroys the key, so this must be done before linking, and a later re-link needs approval.
3. **Location is still reported by the phone.** The app reads the location from Google Play services and flags mock providers, but the server cannot see the radio signals. Treat tier 3 as a strong deterrent with evidence for review, not proof.
4. **Reports are credited by the phone's signed time** (needed for the offline queue). A phone clock set back can make late reports look on time; reports dated in the future are flagged, and every report also records when it arrived.
5. **The pairing code is a bearer secret for 5 minutes.** Whoever opens it first links their phone to that student. It is shown only to the signed-in student, used once, and a link after the first phone needs approval.

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

## 5. Encryption of personal data

Mobile numbers (`Users.mobile`) are needed when equipment is issued, so they are kept, but never as plain text in the sheet.

- **Cipher:** AES-256-GCM, an authenticated cipher, from the audited `@noble/ciphers` library bundled as `Vendor_AES.gs`. No homemade cipher. Each value uses a fresh 12-byte nonce and is bound to its field name, so a value copied into another column does not open.
- **Key:** HMAC-SHA256 of the script property `PII_KEY`. The key is created by `setupInitialise` and lives only in script properties, **not in the spreadsheet**. A copy of the sheet, a backup or an archive therefore holds sealed text only.
- **Tampering:** changing any character of a stored value makes it fail to open (`INTEGRITY`); a different key cannot open it; a missing key fails closed.
- **Who sees a number:** masked everywhere (`••••••1021`). A student sees their own number in full. A coordinator or super admin can reveal **one number at a time** (20 per 5 minutes), and every reveal is written to the audit log with who asked. Directories, lists and reports carry no numbers; the loan desk shows the masked form with a reveal button.
- **Migration:** `setupEncryptMobiles` (and the nightly job) seals any plain number left from before encryption. It is idempotent.

Limits, stated plainly: this protects the data in the sheet and its copies. Anyone who can edit the script or read its properties can read `PII_KEY` and decrypt. **Keep a note of `PII_KEY` somewhere separate from the spreadsheet:** without it a restored backup shows phone numbers as sealed text. `Setup.selfTest` checks the encryption round trip on the real runtime.

## 6. Backups and the yearly archive

**Nightly backup.** The 01:00 job copies the whole database spreadsheet into the private Drive folder "LABFLOW Backups", named `LABFLOW backup YYYY-MM-DD`. Rotation keeps the newest 30 days plus the first copy of each of the last 12 months; everything else that carries our name goes to the Drive bin, and files with any other name are never touched. A second run on the same day adds nothing, and rotation runs only after a copy exists, so a failed copy never costs an older backup (the admins are told). **Back up now** (super admin, audited) makes a manual copy. The copies are owned by the script owner and not shared.

**Yearly archive.** The academic year runs 1 June to 31 May (the start month is a setting). Scan-level rows of finished years move to a separate spreadsheet "LABFLOW Archive YYYY-YY" so the live sheet stays fast. Each batch is copied, read back and compared, and only then deleted, under the script lock; a stopped run resumes where it left off and a second run moves nothing twice. A backup of the day is made first. The super admin runs it from Admin > Audit & system; the nightly job also runs it each July for years older than the previous one, only if that day's backup exists.

What stays live: sessions, per-student summaries, loans and the audit log, so history, totals and the audit chain read the same afterwards. An archived session refuses corrections, reconciles and summary rebuilds (`ARCHIVED`), because the scans they would recompute from are no longer there. Known limits: the scoped-HOD audit view cannot map audit rows about archived scans, an asset's history shows fewer events for archived loans, and visit counts for archived sessions are shown as unavailable.

The archive spreadsheets and the backups are only as private as the Drive folders they sit in: keep them owned by the script owner and unshared.

## 7. Read-only HOD access

The HOD role can open the department overview, facilities, live board and reports, and can change nothing:

- **Enforced on the server:** every route has a role list, and the HOD is refused on all business writes by an explicit action policy, including generic user routes. A test sweeps every route as an HOD and expects each write to be refused.
- **Department scope:** a HOD sees the labs of their own department plus labs with no department (shared labs). A HOD with no department sees shared labs only. Direct record ids, legacy read endpoints, reports and exports are scoped before rows or counts are built; a client-supplied scope is overwritten.
- **Allowed personal actions:** updating one's own mobile and consent, and marking one's own notifications read. These cannot change roles or department.
- **Not available to the HOD:** `system.status`, `system.quota`, settings, and the audit log outside its scope. Assigning the role and a department stays with the super admin. See [HOD access](docs/hod-access.md).

## 8. Third-party code

| Component | Use | Licence |
|---|---|---|
| @noble/curves 1.9.7 | P-256 ECDSA verification, bundled into `Vendor_P256.gs` (Apps Script has no native ECDSA) | MIT |
| @noble/ciphers 1.3.0 | AES-256-GCM for personal data at rest, bundled into `Vendor_AES.gs` (Apps Script has no symmetric cipher) | MIT |
| qrcode-generator 2.0.4 | QR rendering in the browser | MIT |
| Tailwind CSS 3.4 | build-time only; compiled CSS is in `Styles.html` | MIT |
| Google Fonts (Anton, Instrument Serif, Inter) | runtime CDN load | SIL OFL |

The signature verifier and the cipher are third-party code running inside the trust boundary. They are covered by known-answer and tamper tests (the cipher's output is also opened by Node's own AES-GCM), and `setupSelfTest()` re-checks both on the real runtime.

## 9. Reporting

Report suspected vulnerabilities privately to the project owner rather than in a public issue.
