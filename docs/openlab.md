# Daily open lab

Task C2 adds walk-in lab sessions to the [v2 requirements](requirements.md). Projects are implemented separately in [Projects](projects.md); [project/system selection](work-selection.md) is implemented as C3, and automatic sign-out is implemented as C4.

## Enable it

As super admin, open Labs, edit an active lab, set its opening and closing times, and select **Allow open-lab walk-ins**. Opening must be before closing on the same day. Existing labs remain opted out until this flag is enabled.

A verified student sees Open lab in Today during opening hours. In kiosk QR mode, scan the lab screen and choose **Walk-in open lab**, a pending/active project, and a system or own laptop. The existing GPS and identity checks still apply. A course roster, research approval and advance booking are not required. Device-QR mode also works through the existing kiosk/coordinator scanner path and requires a registered device as before.

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

## Automatic sign-out

At the scheduled end, every visitor still inside receives an append-only `OUT` event with `method: 'auto'` and `source: 'system'`. Attendance credits time up to closing and includes `auto_out`; history labels it **Auto sign-out**, counts automatic departures separately and explains the event in Details. A normal scanned departure keeps its original time and has no auto flag. An early manual close signs visitors out at that actual closing time.

The session tick closes open labs without the class grace period. Student/faculty session lists, check-in choices and student history also recover overdue closures. Both scan modes refuse new work/attendance writes once closure starts. A delayed trigger records departure at the scheduled end, while `createdAt` retains the actual write time. Google trigger timing still needs deployment verification; an event need not be physically written at the exact closing second.

A deterministic `JobRuns` record with `job: 'openlabClose'` persists the closing time, actor and reason before any exits are appended. Its status stays `pending` until exits, session state, close audit, summaries and flags are complete. Recovery re-derives who is still inside and resumes even if the session row is already closed. Repeated runs do not duplicate exits or the close audit. This path calls `Attend.rebuildSummary` under an outer script lock; its implementation remains unchanged for A4. The archive must retain pending close journals and their sessions until recovery completes.

Three missed exits within 30 days, combining automatic open-lab departures and unverified class exits, raise the existing monthly-deduplicated `never_scans_out` flag. Classes retain their existing missed-exit credit and grace rules; they receive no automatic OUT.

## Reporting and checks

Attendance records carry `entryReason: 'openlab'`. Daily and ERP reports retain the session type, and the monthly audit has a separate Open lab bucket rather than mixing these visits into research/self-work.

- `npm run check`: 16 open-lab backend cases, including both QR modes, exact hours, class coexistence, delayed triggers, configuration changes, nightly idempotency and report separation.
- Closing regression cases in `test/attendance.test.js` and `test/jobs.test.js` cover exact/delayed deadlines, early manual closure, short visits, scanned departures, work changes and workstation release, repeated missed exits, both scan gates and recovery before/after durable writes.
- `npm run e2e:autoclose`: 15 browser checks for QR/GPS entry, a delayed session tick, credited minutes, history badge/totals/details, phone layout and retry idempotency.
- `npm run e2e:openlab`: 15 browser checks for lab configuration, inline validation, phone layout, walk-in QR/GPS entry, departure, closing-time refusal and disabling walk-ins.
- Browser checks use the Test Lab's shared clock and simulated Google services/location. Real campus GPS, Workspace identity and trigger timing remain deployment checks.
