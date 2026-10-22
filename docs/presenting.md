# Presenting LABFLOW on the live site

The live demo runs on the lab already set up on the hosted app: the **IBM Big Data Software CoE (DBMS Lab)**. Parts that need a moved clock or a staged attack run on the local Test Lab ([demo.md](demo.md)). At the start, tell the audience which screen is which.

Last updated: 2026-10-21

## What the live site holds (checked 21 Oct, evening)

| Item | State |
|---|---|
| Lab | `IBMCOE`, IBM Big Data Software CoE (DBMS Lab), CSE, capacity 60, both check-in modes (AB), radius 40 m |
| Door GPS | **Not set.** Until it is, every kiosk check-in passes as "location not available" and no one can be flagged for being outside |
| Opening hours / open lab | **Not set / off.** No walk-in sessions are created, so outside a timetabled class a student has nothing to check in to |
| Kiosk | `CoE door screen`, account `cleoch4ria@gmail.com`; has never signed in at the door |
| Course and timetable | `DBMSLAB` (Ms. Denisha), roster of 60, Wednesdays 11:00 to 12:40 from 21 Oct to 31 Dec |
| Students | 61 imported (`URK24CS1001` onward), 3 signed in and verified: `URK24CS1277`, `URK24CS1021`, `URK24CS1030` |
| Staff accounts | `amohamed@karunya.edu.in` is super admin, faculty and coordinator. **No HOD account** |
| Inventory | 3 categories (CoE desktop, a workstation category; Data warehouse appliance; Edge AI board), 36 assets |
| Projects | None |
| Backups | Folder created, **no copy yet**. All 5 triggers installed |
| 21 Oct class | Opened 12:36, closed 13:10, **0 of 60 marked**. No check-in has yet succeeded on the live site |
| Errors | Three short "Service Spreadsheets failed" errors from Google (09:01, 12:18). Page loads now retry up to three times |

## Before the demo

Do these in order. Steps 1 and 8 have to be done in the room.

1. **Door GPS.** On a phone, go to Admin > Labs & kiosks > Edit the CoE lab. Stand in the middle of the lab and press **Use this device's location**. Wait until the accuracy reads 20 m or better, then save. Keep the radius at 40 m, or lower it to 25 m if the next room is close.
2. **Open lab.** In the same form, set From 08:00 and Until 19:00 (or the real hours), tick **Allow open-lab walk-ins**, and save. This creates the daily extra-hours session that the brief is about.
3. **A class on the demo day.** The timetable has a Wednesday slot only. Add a slot for the demo day and time under Admin > Academics > Timetable, so "who is missing" (R12) has a live class to show.
4. **HOD account.** Admin > People: add a spare Google account (for example `amohamedarmaan@gmail.com`) with the role HOD and department CSE.
5. **Kiosk.** Sign in as `cleoch4ria@gmail.com` on the laptop or tablet at the door and leave the kiosk screen open. The Kiosks table should now show a "last seen" time.
6. **One project.** As a student (`URK24CS1021`), go to My projects and create one with `amohamed` as supervisor. Approve it as faculty, so check-in has a project to pick.
7. **Backup.** Admin > Audit & system > System health > **Back up now**, then open the Drive folder. Check the next morning that the nightly copy is there.
8. **Rehearse twice on a real phone.** Do one check-in at the door, which must pass. Then do one from another block or the road outside, which must show "Recorded, but your phone places you outside the lab" and appear as flagged on the Live roster (radius 40 m plus up to 30 m of forgiven GPS error, so go more than about 80 m away). The deployed version before the `tier3-app` branch refuses it instead. Without this rehearsal the demo is the first live check-in ever.
9. **Phones for device QR (reverse scanning).** On each demo student's phone: Device > **Run check** (all OK) > **Register this phone**. A first phone is active straight away. Add a photo on the same page, because the kiosk shows it after a scan. Keep one spare phone unregistered for the "new phone needs approval" step.
10. **On the day.** Charge the phones. Before the presentation starts, sign in on every phone once and allow camera and location. Have a phone hotspot ready for "from home". Open the local Test Lab (`npm run dev`, demo preset, **Rebuild world**) in a second window.

## Showing both check-in modes

The CoE lab accepts both modes (AB), so the door screen shows the rotating QR and, beside it, a scanner. Both need an open session: the open lab (prep step 2) or the class slot (prep step 3).

**Mode A: the student scans the lab (the brief's flow).**
1. Phone camera at the door screen, then tap the link (or in the app, Today > **Scan the lab screen**).
2. LABFLOW opens with a 2-minute pass. Pick the session, a project and a system, and allow location.
3. The phone shows "Checked in". The door screen's "Latest check-ins" list updates and the head count goes up.
4. Scan again later and choose **Check out**.

*Say:* "The screen proves you were at the door in the last few seconds; the GPS proves you are still in the room. Both go through 15 checks on the server, and any one of them can refuse."

**Mode B: the lab scans the student (reverse scanning).**
1. Student: Today > open-lab card > **Show my QR**. The QR is signed by a key that never leaves the phone and redraws every 3 seconds.
2. Scan it in any of these three ways:
   - **Door screen.** Press **Use camera** on the kiosk scanner panel and hold the phone up to the laptop webcam. A USB barcode scanner also works.
   - **Coordinator phone.** **Scan visitors** > **Open scanner**.
   - **Faculty phone.** During their own class: Today > **Scan students**. A phone's normal camera app also works, because the QR is a link.
3. The scanner flashes green with the name, roll number and photo. Faculty and coordinator scans count as high assurance.

*Say:* "No GPS here. Presence is proven because someone in the room scanned a phone that only that student holds."

**Attacks to run live (each one is refused, and the message names the reason):**

| Try | What happens | Shows |
|---|---|---|
| Screenshot a student's QR, wait 20 s, scan the screenshot | Refused: the code is too old. Signed timestamps go stale after 15 s | Screenshots are useless |
| Scan a student's live QR (accepted), then scan a screenshot taken a moment earlier | Refused: this code was already used | Replay protection |
| A student opens the in-app scanner and scans a friend | Refused: only the teacher, lab staff, event lead or class rep can scan | Server-side permissions |
| Register the spare phone as a second device | Goes to "waiting for approval". Coordinator > Desk approves it and the old phone stops working | Identity can't be moved between phones at will |
| Mode A from more than 80 m away | Recorded, flagged with the distance band, not counted as present until the faculty decide | Geofence (needs prep step 1) |

*Answer before they ask:* a friend streaming live video of the phone can still beat Mode B. Setting `scanLivenessReads` to 2 makes the scanner read twice with a new timestamp, so a photo never passes. Random rescans and photo spot checks catch the rest.

## Everything else, if there is time

Each of these takes about a minute. All of them run on the live site.

| Feature | Where | One line to say |
|---|---|---|
| Rescan | Faculty > Live roster > **Request rescan now** (or a class rep: **Call a rescan**) | Everyone inside must confirm again within a short window, which catches people who checked in and left |
| Spot check | Faculty > Live roster > **Random spot check** | Picks random students and shows their photo to compare against the face in the room |
| Flags | Faculty or Coordinator > Flags | Suspicious patterns (never scanning out, two students on one phone, impossible travel) are flagged for review; they never change attendance on their own |
| Corrections | Faculty > Live roster, on a student | A manual fix is a new row with a reason; the original stays, and old corrections need admin approval |
| Class rep | Faculty > Students > **Assign a class representative** | A student who can scan classmates during their own class |
| Events and guests | Student or faculty > Events I run > **Add a guest** | Extra sessions with an event lead and outside guests |
| Research visit | Student > Research | Ask for lab time outside class; the supervisor approves |
| Loans and kits | Coordinator > Issue / Return, Inventory > **Add kit** | Issue a kit as one item; the return records what came back and in what condition |
| Reports | Reports > any type > PDF or CSV | Every report exports; CSV is safe against spreadsheet formula injection |
| Audit chain | Admin > Audit & system > Audit trail > **Verify chain integrity** | Re-checks every hash link and shows where a break is |
| Themes | Admin > Settings, site theme | Ten looks for the whole site, chosen by the admin |
| Installable app | Phone browser menu > Add to Home screen | It opens like an app, with the Karunya icon |

## Run order (about 12 minutes)

For each step: **Do** what is on screen; **Say** the line for the audience; **Note** what can go wrong.

**1. Sign-in (R13, R16).** *Do:* open the site and sign in with Google. *Say:* "No passwords. Google proves who you are and the server decides your role; the browser is never trusted with an email or a role." *Note:* sign in on every device before the presentation starts. A first login asks for a phone number.

**2. Kiosk QR + GPS check-in (R3).** For the full version with reverse scanning and live attacks, use "Showing both check-in modes" above. *Do:* the door screen shows the QR. A student scans it with the phone camera, the page opens, the student picks the open lab, a project and a system, and is marked in. *Say:* "The code changes every 7 seconds and is signed by the server. The phone's location is checked against the lab, and the coordinates are thrown away right after the check." *Note:* if the GPS fix is slow, wait for "accurate to about N m". The student has 2 minutes after scanning.

**3. Refusal from outside (R3).** *Do:* have a second student, who has already walked out of range, try the same thing. Show the message "Your phone places you ... from the lab". *Note:* this works only after prep step 1. If GPS is not set, skip this step and explain it instead.

**3b. "Does it keep checking during the class?" (local `/presence`).** *Do:* open `http://localhost:8787/presence` and press Play (or Next step while you talk). One class runs on the real attendance engine: Ravi walks out to the canteen, and Meena checks in from the hostel with a faked location and is accepted. The teacher calls two rescans without warning, and each one asks everyone inside to scan the door screen again within 90 seconds with GPS inside. Ravi is refused from 300 m away, Meena never sees the screen, and both end as "missed rescan" with 0 minutes. *Say:* "A web page can't follow a phone all day: the browser stops it when the screen locks. So the teacher checks at moments nobody can predict. Leaving early costs you everything after your last proof." *Note:* Restart picks different times; the outcome is the same.

**4. Live board "from home" (R1, R2, R9).** *Do:* put a laptop on the phone hotspot, sign in as coordinator, open Live board and choose the CoE lab. It shows the count, each student with their system and project, and how long they have been inside. *Say:* "Staff see this from anywhere. Students and the kiosk only see the head count."

**5. Changing work mid-visit (R1, R7).** *Do:* the student opens Today > **Change system / project**. The board shows the change on its next refresh.

**6. Booking and queue (R5, R6).** *Do:* student A books a CoE desktop for a slot. Student B tries the same slot, is refused and presses **Join waitlist** ("#1"). A cancels; B is promoted and notified. *Say:* "First come, first served. A no-show is released automatically and the next person moves up."

**7. Project with outcome (R7).** *Do:* the student submits an outcome with a link, and the faculty accepts it under Projects. *Say:* "Every visit is tied to a project, so each system's use has a purpose, a timeline and an outcome."

**8. Register-number lookup (R10, R18).** *Do:* Reports > Student attendance for `URK24CS1021`. *Say:* "URK 24 CS 1021: the system reads the join year and department out of the number."

**9. System lookup (R11).** *Do:* Reports > System usage for the desktop used in step 2. It shows who used it, for how long and for which project. Export the PDF.

**10. Who is missing (R12).** *Do:* faculty Today shows the DBMS class roster with "Absent" and "Not arrived yet". *Note:* this needs prep step 3. The roster has 60 names and most are imported placeholders, so the absent list is long, and that is expected.

**11. Phone numbers encrypted (R15).** *Do:* Issue / Return, open a loan: the number is masked. Press **Reveal**, then show the `pii.reveal` line in the Audit trail. *Say:* "AES-256 encryption at rest. Every reveal is logged, and the log never contains the number."

**12. Roles (R16).** *Do:* HOD account: department view only, nothing editable. Coordinator: Students > disable and re-enable a student.

**13. Backups and archive (R14).** *Do:* System health > Backups shows the copies and the Drive folder. Yearly archive moves old years into their own spreadsheet.

**14. Closing time (R4), on the Test Lab.** *Do:* move the clock past 19:00 and press **Run tick**. Everyone is signed out and credited up to 19:00. *Say:* "On the live site a trigger runs every 5 minutes, so the sign-out lands within 5 minutes of closing, but it is always credited at the closing time."

**15. What is new (R17), on the Test Lab.** *Do:* run a replay attack, which is refused. Then tamper with an audit row and press Verify chain, which catches it. *Say:* "There is a second check-in mode where the student's own phone signs the QR, so a screenshot goes stale in seconds."

Close with: "Apps Script, an HTML front end and Google Sheets, at zero cost. Over 300 automated backend tests and 27 attack and rush scenarios run on every change."

## If something breaks

- "Could not load this": Google had a short Sheets error. The page retries three times on its own; press reload once more.
- A check-in is refused unexpectedly: the message names the check that failed. Read it out; that is part of the point.
- No network in the room: switch to the Test Lab, which runs entirely on the laptop.
- The Intel Unnati AI Lab is not on the live site. It exists in the Test Lab with marked placeholder data ([unnati-demo.md](unnati-demo.md)).

## Questions to expect

### Location and proxy attendance

**Can a student fake their GPS?**
Yes, with effort, and we say so. A phone reports its own location, and a student who knows the browser console can send the lab's coordinates. That is why GPS is one check out of fifteen and not the only one. To mark someone else present, a proxy needs that student's Google login, a code from the screen inside the last few seconds, and a faked location. Random rescans, faculty spot checks against the student's photo, and exit scans catch what is left. Device-QR mode is the stronger option.

**Why not Wi-Fi, Bluetooth or MAC addresses?**
A browser cannot read any of them. Only a native app could, and the brief asks for Apps Script and HTML at no cost.

**Does it keep checking that the student stays in the lab?**
Yes, whenever the teacher wants. During a class the teacher (or a class rep) presses **Request rescan now**, and students get no warning. Automatic random rescans exist but are off by default: the teacher decides. Everyone marked inside must scan the door screen again within 90 seconds with GPS inside the lab, or show their device QR to the scanner. Anyone who doesn't is marked "missed rescan", and their credited time stops at their last proof. Spot checks compare the student's photo with the face in the room, and an exit scan closes the visit. Following a phone continuously isn't possible from a web page, because the browser pauses the page when the screen locks, and it would drain the battery and track students' locations all day. Show `/presence`.

**Indoors GPS is poor. Will genuine students be refused?**
No student is refused for location: a check-in outside the geofence is recorded and flagged, and the faculty decide.
The phone reports its own error margin. We forgive up to 30 m of it (a setting) on top of the radius. The phone keeps reading for up to 12 seconds and keeps the best fix. If there is no location at all (location turned off, a desktop), the default is to accept the check-in and raise a flag for the faculty. It can be set to refuse instead.

**Do you store students' locations?**
No. The coordinates are used for the distance check and then dropped. We keep only pass or fail, the distance and the accuracy.

**What stops a student photographing the kiosk QR and sending it to a friend at home?**
The code is only valid for a few seconds. The pass it opens belongs to whoever is signed in, so the friend can only mark themselves, and their own GPS puts them at home. Each student can use a given code only once.

**And in device-QR mode?**
The student's phone holds a private key that the browser will not export. The QR carries a signature over a timestamp that changes every few seconds, so a screenshot goes stale, and each code works once (replay is refused). A live video relay can still work. That is in SECURITY.md, and the optional two-read check makes even that harder.

**What if a student loses their phone?**
Their device key is revoked and a new phone is registered with in-person approval at the desk.

### Architecture

**Why Google Sheets as a database?**
The brief asks for it. It costs nothing, the university already has Google accounts, and staff can open the sheet and read it. Every write goes through one layer that takes a lock, checks unique keys and never deletes a row.

**How do you stop two students writing at the same moment and corrupting data?**
The writes that matter run under the Apps Script script lock, one at a time. The checks run before the lock, and only the final ones (code not reused, session open, no double entry, record) run inside it, so the locked part stays short.

**Will it handle a full class scanning at once?**
Each check-in is one short server call, and the locked section is the last few steps. We have simulated a class rush locally. The real Google timings for 30 students in two minutes have not been measured yet, and there is a benchmark function ready for it (`setupBenchmarkScans`).

**What about the 10-million-cell limit of a spreadsheet?**
A nightly copy goes to Drive (30 daily and 12 monthly kept). Once a year, old scan-level rows move into a separate archive spreadsheet per academic year, so the live sheet stays small. Totals and student history keep working from the summaries.

**Why is the site on Vercel if the brief says Apps Script?**
The back end, the data and every rule are Apps Script and Sheets. Vercel only serves the same HTML as an installable app, without the Apps Script page frame. The same pages also run straight from Apps Script. Vercel's free tier costs nothing.

**How does the server know who I am?**
Google Sign-In gives the browser a signed ID token. The server checks it with Google, then issues its own session signed with a secret only the server holds. Each call carries that session, and roles are always looked up on the server.

**What runs without anyone clicking?**
Five time triggers: a session tick every 5 minutes (opens timetabled classes, closes the open lab and signs people out, releases no-show bookings), email sending, and nightly work (backup, digests, audit anchor).

### Security and data

**How are phone numbers protected?**
AES-256-GCM from an audited library; it is not a cipher we wrote ourselves. The key is kept in the script's properties, never in the sheet. Every value has its own random nonce, and any change to the stored text makes it fail to open. Numbers are shown masked. Only a coordinator or super admin can reveal one, one at a time, rate-limited and logged.

**Can an admin quietly edit attendance?**
Corrections are new rows; nothing is overwritten. Every sensitive action goes into an audit log where each row includes the hash of the one before it. Editing or deleting a row breaks the chain, and Verify chain shows where. The chain head is also emailed out, so even the owner cannot rewrite the whole log unnoticed.

**What can the HOD do?**
Read everything in their department and nothing else. Every write is refused on the server for that role, not just hidden in the screen.

**What if someone calls the server directly, without the UI?**
The UI only hides buttons. Each of the 143 actions has a role list on the server (the busy ones also have rate limits), and each handler checks ownership again (your own session, your own record).

**Why can gmail.com accounts sign in?**
For the demo and testing only. The allowed domains are a single setting; production would allow only the Karunya domains.

### Scope

**Did you build it for the Intel Unnati AI Lab, as asked?**
The system works with any lab; a lab is one row added from the admin screen. Unnati's location and inventory had not arrived, so the live site runs on the IBM CoE (DBMS) lab with its real course and assets, and the Test Lab has Unnati with marked placeholder data. Adding Unnati live takes about two minutes once its details are known.

**How is this tested?**
Over 300 backend tests run the real server code against stand-ins of Google's services, 27 scripted scenarios replay class rushes and attacks, and browser suites click through every role. The Test Lab lets you inject a fault into any step of a check-in and watch it get refused.

**What does it not do yet?**
It has not been tried with two Karunya domains at once, a full class rush on Google's servers, or a month of nightly jobs. Location can be faked by a determined student, as covered above. The list is in [tasks.md](tasks.md) section 1.
