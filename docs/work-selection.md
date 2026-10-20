# Project and system selection

Task C3 links visits to [projects](projects.md) and individual workstations. It builds on [daily open lab](openlab.md). Automatic sign-out (C4) releases the current project/system claim at closing; the [live board](live-board.md) shows current people, projects and systems.

## Configure systems

In Inventory, edit a category and select **Use as selectable lab systems**. It must use individual tracking. Available assets in this category become selectable systems in their own lab. Existing categories are not classified by their names: enable the flag explicitly.

## Student flow

For kiosk QR + GPS entry into Open lab, choose an owned/shared pending or active project for that lab. Choose a free system, or **Own laptop / no system**. A single eligible project is preselected; multiple projects require a choice. The server validates ownership, group membership, project status, lab and asset availability again at commit.

Regular class entry still works without a project. A current approved workstation booking requires one of the student's booked systems. Choosing a specific booking requires that exact system, even if the student holds another booking. Other students cannot claim it during its slot or the existing 15-minute early-arrival window. A busy or unavailable booked system cannot be claimed until available.

For device QR entry, the scanner assigns the current booked system, if any; otherwise it records no system. After entry, use **Change system / project** in Today to choose the project and update the system. Device-QR tokens keep their existing format; project selection is after entry on this path.

Today displays the student's current project and system. Changes apply only to that active visit. Switching to another system or own laptop releases the prior assignment. Departure or session closure also releases it. A currently booked system remains required while its booking is active. Only the selected workstation booking is marked used; choosing a second booked system later marks that booking used as well.

These are student-reported work assignments, validated against lab records; they do not identify or inspect the computer the student is browsing from.

## Events and concurrency

IN records carry `projectId` and `assetId`. A mid-visit change appends a `WORK` AttendanceEvent, with `ref` pointing to the active entry event. WORK never verifies presence, increases attendance minutes, changes the exit-scan gap, or modifies past events. VOID semantics apply when deriving current work, just as for attendance.

Project/system validation runs before GPS acquisition and again inside the entry write lock. Work changes validate and append under the same lock. Two students cannot concurrently claim the same system through these paths.

`attend.setWork` accepts:

| Field | Meaning |
|---|---|
| `sessionId` | Active session |
| `entryEventId` | Active visit's entry id, from `mine.work` |
| `expectedEventId` | Last effective entry/WORK id being edited |
| `projectId` | Eligible project; required for open-lab work changes |
| `assetId` | Workstation id, or empty for own laptop |
| `eventId` | Optional client-generated `EVT-` id used as an idempotency key |

It returns `{work}` with the effective assignment ids. The UI allocates an event id once and retains the exact payload while a response is uncertain. A repeated id with identical ownership and data replays the saved event rather than appending another. Stale versions and edits from an earlier visit are refused.

Entry controls freeze during GPS acquisition and submission. After an uncertain entry response, **Refresh sessions to confirm** reads the saved state instead of submitting changed choices against the old pass.

## Integration points

- `Checkin.options` returns private `workChoices`: usable projects, system availability without occupant identity, and the student's booked system ids.
- `sessions.mine` includes `mine.work` (ids and display names), and `workChoices` while the student is inside an open session.
- `Work.current(effectiveEvents)` derives a visit's assignment, honoring effective IN/OUT/WORK events and their entry references. B4 can reuse it for the live board; the standalone `systems.status` route remains B4's stub.
- `Work.occupants(labId)` provides internal active system claims across open sessions. These student ids are not exposed in selection choices.
- No schema or frozen route/role contract changed. The category workstation flag/editor prerequisite of B4 is implemented here.

## Verification

`test/work-selection.test.js` adds 19 backend cases for project eligibility, own-laptop visits, work events and minutes, busy systems, named bookings, version/idempotency checks, effective voids, account access and both QR modes. Deterministic interleavings cover a claim or project rejection during GPS validation.

`npm run e2e:work` adds 23 browser checks for category configuration, selection, phone layout, mid-visit changes, stale availability, booked-system requirements, and interrupted entry/work responses. All checks use local Google-service fakes; real Workspace concurrency and throughput remain unverified.
