# Demo script (teacher brief v2)

A 15-minute walk through R1-R18 ([requirements.md](requirements.md)) on the local Test Lab. Every step runs on in-memory fakes, so nothing can break during the demo. Show the live deployment only for sign-in and the backup folder (step 9) after its deployment checks pass.

The Intel Unnati AI Lab building, room, GPS point, hours and inventory are **placeholders** until C5 lands ([unnati-demo.md](unnati-demo.md)). Say so if asked.

## Before you start

1. `npm install`, `npm run build`, `npm run dev`.
2. Open `http://localhost:8787/lab`, choose the **demo** preset, press **Rebuild world**. The clock starts at 09:54 IST.
3. Open one browser tab per account (`http://localhost:8787/?as=<email>`):

| Tab | Account | Plays |
|---|---|---|
| Student | `student10@karunya.edu` | Visitor already on system 01 |
| Walk-in | `student5@karunya.edu` | New walk-in visitor |
| Faculty | `faculty2@karunya.edu` | Project supervisor |
| Coordinator | `staff@karunya.edu` | Lab coordinator, loan desk |
| HOD | `hod@karunya.edu` | Read-only department view |
| Admin | `admin@karunya.edu` | Super admin |
| Kiosk | `kiosk4@karunya.edu` | Unnati door screen |

Use a phone-width window (or the browser's device toolbar) for the student tabs.

## The script

| # | Show | Where | Covers |
|---|---|---|---|
| 1 | **Walk-in check-in.** In the Test Lab Stage pick kiosk **Unnati demo door** and phone location **Unnati lab (demo GPS)**. The kiosk tab shows a rotating QR; scan it from the Walk-in tab. The GPS check passes, the student picks a free system (and a project, if they have one) and is marked in. Switch the location to outside and try again: refused. | Kiosk, Walk-in, Test Lab | R3, R8 |
| 2 | **Live board, "from home".** Coordinator > **Live board** > Unnati: count of students inside, each one's system and project, free/busy/booked systems. It refreshes by itself; point out that it works from any network. | Coordinator | R1, R2, R9 |
| 3 | **Change of work mid-visit.** Student tab > Today > **Change system / project**. The board shows the change on its next refresh. | Student, Coordinator | R1, R7 |
| 4 | **Booking a system, then the queue.** Student tab > Equipment: book a GPU workstation for a time slot. Walk-in tab: try the same system and slot; it is taken, so press **Join waitlist** (position shown). Cancel the first booking: the waiting student is promoted to a normal request (a coordinator still confirms it) and told. | Student, Walk-in | R5, R6 |
| 5 | **Project with outcome.** Student tab > **My projects**: the project's supervisor, timeline and status. Submit an outcome (summary and link). Faculty tab > **Projects**: accept it. | Student, Faculty | R7 |
| 6 | **Register-number lookup.** Coordinator > Reports > **Student attendance**, roll number `URK24CS1010`: days in the lab, total verified hours, per-lab split. Point out the roll number format (join year 24, CSE). | Coordinator | R10, R18 |
| 7 | **System lookup.** Coordinator > Reports > **System usage**, choose Unnati system 01: how many people used it, their visits, hours and the project or booking purpose. Export CSV or PDF. | Coordinator | R11 |
| 8 | **Regular lab, who is missing.** Faculty `faculty@karunya.edu` > Today: the 10:00 timetable session; the roster lists "Absent" / "Not arrived yet". | Faculty | R12 |
| 9 | **Backups and archive.** Admin > Audit & system > **System health**: **Backups** (nightly copy, 30 daily + 12 monthly kept, **Back up now**) and **Yearly archive** (old years move to their own spreadsheet). | Admin | R13, R14 |
| 10 | **Phone numbers encrypted.** Coordinator > Issue / Return > **Return** tab, pick a loan: the borrower's phone is masked. Press **Reveal**, then Admin > Audit & system > Audit trail shows a `pii.reveal` entry without the number. | Coordinator, Admin | R15 |
| 11 | **Roles.** HOD tab: Overview, Labs and facilities, Live board, Reports, all for the department only, nothing editable. Coordinator > Students: import, disable or re-enable a student (never deleted). | HOD, Coordinator | R16 |
| 12 | **Closing time.** Test Lab: set the clock past 19:00 and press **Run tick**. Every Unnati visitor is signed out at 19:00, systems are released, and the student's Attendance tab shows the automatic sign-out. | Test Lab, Student | R4 |
| 13 | **What is new (R17).** Test Lab: run a replay or relay attack scenario and show it refused; **Tamper with a row** then **Verify chain** to show the audit log catches it. Mention device-bound signed QR as the second check-in mode. | Test Lab | R17 |

Built on Google Apps Script with an HTML front end and Google Sheets storage (R13): show the spreadsheet on the live deployment if time allows.

## If something goes wrong

- Rebuild the world right before the demo and before any screenshots; rehearsals change the data.
- Screen stuck or data odd: Test Lab > **Rebuild world** and restart from step 1.
- A step refuses unexpectedly: the Test Lab Pipeline panel shows which check failed and why.
- Screenshots of every screen are in [screens/](screens/) as a fallback.
