# Daily open lab

Task C2 adds walk-in lab sessions to the [v2 requirements](requirements.md). Projects are implemented separately in [Projects](projects.md); associating a project and system with a visit remains C3, and automatic sign-out remains C4.

## Enable it

As super admin, open Labs, edit an active lab, set its opening and closing times, and select **Allow open-lab walk-ins**. Opening must be before closing on the same day. Existing labs remain opted out until this flag is enabled.

A verified student sees Open lab in Today during opening hours. In kiosk QR mode, scan the lab screen and choose **Walk-in open lab**. The existing GPS and identity checks still apply. A course roster, research approval and advance booking are not required. Device-QR mode also works through the existing kiosk/coordinator scanner path and requires a registered device as before.

Regular classes remain first in eligible check-in choices. Open lab and approved research visits can run alongside a regular class; the class/event conflict rules continue to prevent overlapping exclusive sessions.

## Session lifecycle

- `Sessions.materializeOpenLab(date)` creates one session per enabled, active lab and date, using the unique key `open|labId|date`.
- Sessions use type/reason `openlab`, `openToAll: true` and `rescanMode: 'off'`.
- The nightly job creates today and the next two days. The session tick opens due sessions. Student session lists and kiosk check-in choices also open due sessions, so an arrival can recover a delayed opening trigger.
- Opening is at `openTime`, without the early-opening window used for regular classes. The class `autoOpenSessions` setting does not disable opted-in open labs.
- New entries stop at `closeTime`, even if the closing trigger is late. Both QR modes recheck the live lab flag, lab status and hours at scan commit. Disabling walk-ins stops new entries; an existing visitor can still scan out.
- Hour edits refresh sessions that have not opened yet. Active sessions keep their original schedule, and the entry gate also enforces the current configured hours. Widening the lab hours does not extend an active session beyond its original end.
- Closed and cancelled daily sessions are never recreated or reopened on an arrival read.
- An open-lab auto-opening failure is logged and counted without preventing regular timetable classes from opening.

Until C4 is implemented, a missed exit follows the existing unverified-exit handling; enabling open lab does not yet add an automatic OUT event or credit time through closing. Closing/sign-out integration is therefore still required before the complete extra-hours workflow is ready.

## Reporting and checks

Attendance records carry `entryReason: 'openlab'`. Daily and ERP reports retain the session type, and the monthly audit has a separate Open lab bucket rather than mixing these visits into research/self-work.

- `npm run check`: 16 open-lab backend cases, including both QR modes, exact hours, class coexistence, delayed triggers, configuration changes, nightly idempotency and report separation.
- `npm run e2e:openlab`: 15 browser checks for lab configuration, inline validation, phone layout, walk-in QR/GPS entry, departure, closing-time refusal and disabling walk-ins.
- Browser checks use the Test Lab's shared clock and simulated Google services/location. Real campus GPS, Workspace identity and trigger timing remain deployment checks.
