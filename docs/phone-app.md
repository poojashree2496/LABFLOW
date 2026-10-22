# The LABFLOW phone app (tier 3)

The phone app confirms a student is in the lab for the whole session, not only at the moment they check in. It is an Android app (`android/`), free to build and install, with no paid account or service behind it.

## The three tiers of proxy protection

The faculty choose the tier when they open a session (Today > Open > "How students check in"). Kiosk QR + GPS stays the default.

| Tier | How a student checks in | What keeps proving presence |
|---|---|---|
| 1 | Scans the rotating code on the lab screen with the phone camera; the browser sends one GPS reading | While the LABFLOW page stays open, it reports the location at random times the server picks (5 to 15 minutes apart by default). The faculty can also call a rescan at any time. |
| 2 | Shows a QR signed by their registered phone; the kiosk or a teacher's phone scans it | Rescans and spot checks called by the faculty |
| 3 | Scans the lab screen with the **LABFLOW app** | The app reports the location every 2 minutes until the session ends, also with the screen locked, and asks for a fingerprint at 2 random times |

**Nobody is blocked.** In every tier a check-in from outside the lab, with a faked or impossible location, or with an old forwarded code is *recorded and flagged*, never refused. A flagged student is not counted as present until the faculty review them. Students without the app (iPhones, for now) can still check in to a tier-3 session through the lab screen; they are flagged "no app" for the faculty to decide.

## How tier 3 works

1. **One phone per student.** The student taps *Sign in* in the app. LABFLOW opens in the browser; they sign in with Google as usual and get a single-use link code, which opens the app (`labflow://pair?t=...`). The app makes two keys in the Android Keystore and the server keeps only their public halves. The first phone is linked at once. A new phone later is held for approval: the faculty (Today > Phone switch requests), a coordinator or a super admin approves it after checking the student. Until then its check-ins are flagged. Approving it switches the old phone off.
2. **Check-in.** The student scans the lab screen with the app. The scan counts only when the code is fresh (an old or forwarded picture is flagged), the phone is at the lab (lab radius plus the looseness setting), and the phone is not reporting a mock location. The app signs the check-in with its device key, so the server knows it came from that phone.
3. **Staying present.** After check-in a foreground service runs until the session ends. It shows the notification "Attendance tracking is on" and keeps working with the screen locked or in other apps. Every 2 minutes it reads the location, signs a report and sends it. With no network, reports are queued on the phone and sent in order when the connection comes back; the server credits them by their signed time.
4. **Is it the student, not just the phone?** Twice per session, at times only the server knows (one in the first 15 to 40 % of the session, one in 60 to 85 %, so never at the start or end and always well apart, and different for each student), the next report brings back a fingerprint check. The phone shows a notification; the student has 2 minutes. The answer is signed with a second key that Android unlocks **only** with a strong biometric. A PIN, pattern or password cannot unlock it, and enrolling a new fingerprint destroys it. The faculty can also send a check to the whole class at any time (Live roster > Fingerprint check now). Each phone receives it with its next report, within 2 minutes.
5. **Catching cheating.** These raise flags: a mock (faked) location, a location that jumps impossibly far between two reports, a location that never changes at all, a report or answer that fails its signature check (tampered), a report sent twice (replayed), a phone clock far in the future, an old kiosk code, an unapproved phone, and no app in a tier-3 session.

### The final result

Worked out from the check-in, the reports, the fingerprint checks and open flags, and rebuilt at any time (nothing is overwritten):

| Result | When |
|---|---|
| **Present** | Checked in, at the lab for at least 75 % of the session, every fingerprint check passed, no open flag |
| **Partial** | Checked in, but missed or failed a fingerprint check, or at the lab for less than 75 % |
| **Absent** | Never checked in, or at the lab for less than 40 % |
| **Flagged** | An open flag. The faculty decide |

The faculty can override any result (Live roster > Actions > Override the result). The override is stored as an event with their name and reason and written to the audit log. Dismissing the flag under Flags also lets the computed result return.

### What the teacher sees

Live roster, for a tier-3 session: when each student checked in, the last report and how far from the lab it was, whether they are at the lab now, the share of the session they have been at the lab, every fingerprint check (passed, pending, missed, failed) and their open flags. Students without the app show "no app".

## Install the app on a phone

The app needs Android 11 or newer, Google Play services, and a fingerprint set up on the phone.

**Get the APK.** Either take `labflow-tier3.apk` from the team, or build it:

```
cd android
gradlew assembleDebug        # needs JDK 17+ and the Android SDK (platform 35); local.properties: sdk.dir=...
# the APK: android/app/build/outputs/apk/debug/app-debug.apk
```

**Install it.** Send the APK to the phone (WhatsApp, Drive or a USB cable) and open it. Android asks to allow installs from that app ("Install unknown apps"); allow it once and tap Install. With a cable: `adb install app-debug.apk`. Google Play Protect may warn about an unknown developer; choose *Install anyway*. Publishing on the Play Store would need a paid developer account, so the app is shared as an APK.

**First run.**

1. Open LABFLOW and tap **Sign in to link this phone**. Sign in with the college Google account in the browser, then tap **Open the LABFLOW app**. (On a laptop: the page shows a QR; tap **Scan a link code shown on a laptop** in the app.)
2. Confirm with the fingerprint. The phone is now linked.
3. The app explains why it needs location, then asks. Choose **While using the app** and **Precise**. Allow notifications too, so fingerprint checks are seen.
4. **Keep LABFLOW running**: tap Allow so Android does not stop the app to save battery. On Xiaomi, Redmi, POCO, Oppo, Realme, Vivo, OnePlus and Samsung phones also open *App settings > Battery* and choose *No restrictions* (or *Unrestricted*), and turn on *Autostart* if it is there. The app shows these steps itself.

In the lab: tap **Check in: scan the lab screen**. Leave the phone with you; the notification shows while tracking is on. At the end, tap **Check out**, or just leave when the session closes (tracking stops by itself).

**Test server.** *Server settings* in the app points it at another LABFLOW, for example the dev server on the same Wi-Fi: API `http://<laptop IP>:8787/exec`, website `http://<laptop IP>:8787/app`.

## Set up a lab's location (no code)

The location check uses the lab's coordinates and radius, which a super admin edits in the app:

1. Stand inside the lab, ideally in the middle of the room, with a phone that has a good location fix.
2. On that phone, sign in as super admin > **Labs & kiosks** > the lab > **Edit** and tap **Use this device's location**; it fills Latitude and Longitude. (Or type them: in Google Maps, long-press the spot and copy the numbers.) Set **Geofence radius (m)** to about half the room's longest side, 20 to 30 m for a normal lab. Save.
3. Make sure the lab's check-in mode includes kiosk QR (A or AB), because tier 3 scans the lab screen.

How loose the check is, without code (super admin > **Settings** > *Phone app (tier 3)*):

| Setting | Default | Meaning |
|---|---|---|
| `appRadiusSlackM` | 30 m | Added to the lab radius for the app. A student just outside the door still counts as present. |
| `appPingSeconds` | 120 | How often the app reports |
| `bioChecksPerSession` | 2 | Random fingerprint checks per student (0 to 2) |
| `bioResponseSeconds` | 120 | Time to answer a fingerprint check |
| `presentCoveragePct` | 75 | Share of the session at the lab needed for Present |
| `absentCoveragePct` | 40 | Below this the result is Absent |
| `frozenPings` | 6 | Identical reports in a row that count as a frozen (faked) location |
| `webPingMinSeconds`, `webPingMaxSeconds` | 300, 900 | Tier 1: gap between the random location checks of an open page |

`gpsAccuracyAllowanceM` (how much of the phone's reported GPS error is forgiven) and `maxTravelSpeedKmh` (what counts as an impossible jump) are shared with tier 1.

## Privacy

Location is read only from check-in to the end of that session, with a notification showing the whole time. The server keeps the distance to the lab, the reported accuracy and a 12-character hash of each reading (to spot a location that never changes); never latitude or longitude.

## Limits

- **Android only.** iPhone students check in through tier 1 and are flagged for review.
- **Not tested on a real phone yet.** The server side, the web screens and the app's message and signature formats are tested (see TEST_PLAN); the APK has been built and its signature encoding unit-tested, but the full flow has not run on a handset or against the live Apps Script.
- **A rooted phone** can fake anything the app reports: location, the mock flag, even the keys' use. Play Integrity would detect most of this but needs a paid Play Console account. The fingerprint key still needs a real enrolled fingerprint on that phone.
- **Phone handed to a friend who stays in the lab:** the fingerprint checks catch it only if the friend cannot pass the fingerprint, which holds unless the student enrolled the friend's finger on their phone.
- **Delivery delay:** a fingerprint check reaches the phone with its next report (up to 2 minutes). There is no push service, which would need Firebase. The 2 minutes to answer start when the phone receives it.
- **Battery killers:** some phone brands stop background apps despite the settings. Missing reports count as time away from the lab (Partial), not as cheating.
- **Open-lab visits** that need a project chosen at check-in are not supported in the app yet; use the web page for those.
