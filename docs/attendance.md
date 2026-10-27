# Attendance

Attendance is a log of what happened plus a summary worked out from the log. The log is never edited.

## Three tiers of proxy protection

| Tier | Mode | Check-in | Presence after check-in |
|---|---|---|---|
| 1 | A | Kiosk QR + browser GPS | Random location checks while the page is open (`presence.webPing`), faculty-called rescans |
| 2 | B | Device-signed student QR, scanned in the room | Faculty-called rescans, spot checks |
| 3 | C | The LABFLOW Android app scans the kiosk QR | Signed location reports every 2 minutes until the end, 2 random fingerprint checks, a result of Present / Partial / Absent / Flagged |

Nobody is refused for a location problem in any tier: a check-in from outside the geofence, with an impossible accuracy, a mock location or an old kiosk code is recorded with assurance `flagged`, raises a flag, and is not counted as present until the faculty decide. Students without the app can check in to a tier-3 session through tier 1 or 2 and are flagged `no_app`. Tier 3 is described in [phone-app.md](phone-app.md).

## Where attendance happens

| Session type | Opened by | Who can check in |
|---|---|---|
| `class` | Timetable (opens by itself) or faculty | Students on the course roster |
| `event` | Event lead / staff | Registered students and guests added by the lead |
| `openlab` | The daily extra-hours session, created from the lab's opening hours | Any verified student, no booking or roster needed |
| `research` | Student asks, the supervisor approves | The requesting student |

A lab supports one of three modes (lab setting `checkinMode`, with `defaultCheckinMode` as the fallback). When the faculty opens a session they choose the mode for that session from the ones the lab supports; kiosk QR + GPS is preselected. A session without a choice (opened by the timetable or a class rep) uses the lab's mode. The choice is stored in `Sessions.checkinMode`, and the other mode is refused for that session.

| Mode | How a student checks in |
|---|---|
| **A** (the SRS) | The lab kiosk shows a QR that changes every ~7 s. The student scans it with the phone camera, the web app opens, and the phone's GPS is checked against the lab geofence |
| **B** (device-signed) | The student's registered phone shows a QR signed with its own key. A kiosk scanner, or the phone of the faculty, staff, event lead or class representative, scans it |
| **AB** | Both are accepted |
| **C** (tier 3, chosen per session, needs a lab with A) | The LABFLOW phone app scans the kiosk QR (`Presence.STEPS_C`). A and B check-ins are still accepted, flagged `no_app` |

## Mode A pipeline (`Checkin.STEPS_A`)

`checkin.open` validates the scanned code the moment the page opens (the student then has `kioskPassMinutes`, default 2, to finish). `checkin.submit` runs these steps in order and stops at the first that fails:

1. `pass_mac` - the check-in pass is authentic (HMAC)
2. `pass_owner` - the pass belongs to the signed-in student
3. `pass_fresh` - finished within the pass time
4. `kiosk_active` - the kiosk is active and its lab uses kiosk QR
5. `rate_limit` - per-student check-in rate limit
6. `target` - a session is chosen and the entry reason matches it
7. `work` - project and workstation choices are valid
8. `geo_reading` - a location reading arrived (or policy allows none)
9. `geo_plausible` - the reading is physically possible; an impossible one is recorded and flagged, not refused
10. `geofence` - inside the lab radius (haversine, with the reported accuracy allowed for); outside is recorded and flagged, not refused

Steps 11 to 15 run under the script lock: `code_once` (this student has not used this kiosk code), `session_open`, `enrolment`, `attendance_state` (no double entry, minimum gap, one rescan) and `record` (append the event). Latitude and longitude are never stored, only pass/fail, distance and accuracy. One kiosk code serves a whole class, but each student can use it once.

## Mode B pipeline (`Attend.STEPS_B`)

1. The phone registers a non-extractable ECDSA P-256 key. The server issues a challenge; the phone signs it. A second or replacement device needs in-person approval by staff.
2. To check in, the phone asks for a server nonce bound to student, credential, session and lab and shows a QR that it re-signs every few seconds.
3. The scanner submits the QR. The server runs: `payload`, `token_mac`, `nonce_fresh`, `qr_fresh`, `mode_enabled`, `scanner_allowed`, `rate_limit`, `device_active`, `student_verified`, `signature`, `liveness`. Then, under the lock, it re-checks the account, scanner, lab and code freshness, consumes the nonce once (Redemptions sheet plus cache), and appends the event.

`liveness` does nothing unless the setting `scanLivenessReads` is 2. With 2, the first read is answered with `SCAN_AGAIN` (not logged as a rejection) and the code is accepted only when the same scanner reads the same challenge again, within 20 seconds, with a later signed timestamp. A still picture of the QR carries one timestamp and never passes. A live video relay still passes; see [SECURITY.md](../SECURITY.md).

`Pipeline.run` records every step, so the Test Lab can show which step refused a scan. The steps that need the lock always come last.

## The event log

`AttendanceEvents` is append-only. No code path updates or deletes a row.

| Type | Meaning |
|---|---|
| `IN`, `OUT`, `RESCAN` | Accepted scans (method `kiosk`, `scanner`, `manual` or `auto`) |
| `SPOT_OK`, `SPOT_FAIL` | Result of a faculty photo spot check |
| `CORR_IN`, `CORR_OUT` | Manual correction with operator, reason and approval status |
| `VOID` | Cancels an earlier event; the original stays in the log |
| `DECISION` | Admin approval or rejection of a pending correction |
| `WORK` | Project or system change during a visit; has no effect on attendance time |

Corrections to sessions older than `correctionApprovalAfterHours` (24) need admin approval.

## Summaries and verified time

`AttendanceSummaries` holds one row per student per session, derived from the events and rebuildable at any time (`Attend.rebuildSummary`; `system.reconcileSession` checks a session and rebuilds without touching events).

- Time counts only between an entry and a verified end: an exit scan, or, when the exit scan is missing, the last rescan or spot check in that stint. A missing exit scan never credits the full session.
- An event's lunch break is never counted.
- Open lab: time counts to the scheduled closing time, and anyone still inside is signed out automatically (`method: auto`, flag `auto_out`). Three automatic departures raise one `never_scans_out` flag. A class keeps the stricter rule: a missing exit stays `unverified_exit` for the faculty to review.
- Status is one of `present`, `absent`, `missed_rescan`, `unverified_exit`, `flagged`, and in a tier-3 session `partial`. Flags add `late`, `corrected`, `spot_check_failed`, `auto_out`, `location_flagged`, `overridden`.
- A check-in or rescan recorded with assurance `flagged` makes the status `flagged`, and a flagged rescan proves no time.
- In a tier-3 session the status is the phone-app result (`Presence.decorate`): Present, Partial, Absent or Flagged, from the share of the session at the lab, the fingerprint checks and open flags.
- `OVERRIDE` (`attend.override`, the session's faculty): the faculty's final result for a student, with a reason, audited. It wins over the computed status.

## Physical controls

Cryptography proves the key signed, not where the phone is. These controls add cost for a cheater and evidence for a reviewer:

- **Rescan windows** - called by the faculty or a class rep at any time (Live roster > Request rescan now), `rescanWindowSeconds` (90) long, with no warning to students. A missed one caps credited time and flags the student. Automatic random rescans (`rescanMode: random`) remain available as a setting but are off by default.
- **Spot checks** - faculty pick students and compare the photo on file with the person; a failure flags the student.
- **Exit scans**, **back-to-back scan detection** (one phone scanning two students too fast), **mock-location heuristics**, **impossible travel** between labs.
- **Flags** go to a review queue (`Flags`); resolving one is audited.

See [SECURITY.md](../SECURITY.md) for what this does and does not prove.

## Project and system selection

At check-in the student can pick a project and a workstation. In the open lab a project is required (an "own laptop" visit is allowed). A system someone is using shows as busy; a booked system is preselected. Changing project or system during a visit appends a `WORK` event; it never verifies time or resets the exit gap. Details: [work-selection.md](work-selection.md), [openlab.md](openlab.md).

## Archived sessions

After the yearly archive moves a session's scan rows to the archive spreadsheet, the session is marked `archivedAt`. Its summaries stay live, so history and totals do not change. Corrections, reconcile and summary rebuilds refuse it with `ARCHIVED`. See [SECURITY.md](../SECURITY.md) and [requirements.md](requirements.md) (R14).

## Session workflow regression coverage

The [22 Oct audit](session-workflow-audit.md) covers session-mode selection, final-lock mode enforcement, supported kiosk actions, faculty-called rescans and verification credit in both modes. Opening a session from the faculty UI preserves its rescan policy; default-off sessions still support manual rescans.
