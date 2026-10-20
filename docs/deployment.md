# Deployment

Nothing in this repository has been run against a live Google account. Follow this page in order, and finish with the checks in [TEST_PLAN.md](../TEST_PLAN.md) section B.

## Before you start

- A Google account **inside the Karunya Workspace organisation** to own the script. A personal `@gmail.com` account cannot serve `@karunya.edu` users.
- Decide how users will reach the app (next section). Do this first; it decides the rest.
- Two or three people who will hold the secrets listed under "Keep these safe".

## Choose the entry route

The web app is deployed with `executeAs: USER_DEPLOYING` (it runs as the owner and uses the owner's quota). The manifest sets `access: ANYONE_ANONYMOUS`, so the hosted app can call it; the server itself refuses any call it cannot tie to an allowed Google account.

| Route | Identity comes from | Use when |
|---|---|---|
| **A. Apps Script page** (`/exec` opened directly) | `Session.getActiveUser()` | Both `karunya.edu` and `karunya.edu.in` are in **one** Workspace organisation |
| **B. Hosted app** (static site, for example on Vercel) | Google sign-in: ID token checked server-side, then a signed LABFLOW session | Users of one domain get a blank email on route A, or you want an installable phone app |

On route A, `getActiveUser()` returns the visitor's address only when the visitor is in the same Workspace domain as the owner. For anyone else it is empty and the app refuses with `NO_IDENTITY`; there is no workaround in the code, by design (it never trusts an email sent by the browser). Check it before anything else: deploy, then open the app as an ordinary user from each domain. See the README section "Authentication". If a domain fails, either have IT merge the domains into one organisation, or use route B.

## 1. Create the script

1. Create a Google Apps Script project owned by the account above.
2. Copy everything in `src/` into it, or use `clasp`: copy `.clasp.json.example` to `.clasp.json`, paste the script id, then `clasp push` (`filePushOrder` lists the load order; `.clasp.json` is git-ignored). `appsscript.json` carries the time zone (`Asia/Kolkata`), scopes and web-app settings.
3. Run `npm run build` first if you changed styles, so `src/Styles.html` is current.

## 2. Initialise (run from the editor, in this order)

| Function | What it does |
|---|---|
| `setupInitialise()` | Creates the "LABFLOW Database" spreadsheet, all 37 sheets and headers, the QR secret and the encryption key `PII_KEY`. Idempotent; refuses (`SCHEMA_MISMATCH`) rather than alter a mismatching sheet |
| `setupBootstrapAdmin('you@karunya.edu')` | The first super admin. Honoured only while no active admin exists |
| `setupSelfTest()` | Platform checks with real timings: P-256 verify time, lock behaviour, identity, encryption round trip. Read its output |
| `setupInstallTriggers()` | Installs the five time triggers ([architecture.md](architecture.md)). Safe to run twice; touches only its own triggers |
| `setupEncryptMobiles()` | Only if you imported data before this version: seals plain mobile numbers. The nightly job also does it |

Setup functions are not routes and refuse anyone but the script owner.

## 3. Deploy the web app

Deploy > New deployment > Web app. Execute as: **Me**. Who has access: as the manifest says. Copy the `/exec` URL.

## 4. Hosted app (route B only)

1. In Google Cloud, create an OAuth **Web** client. Add the site's origin as an authorised JavaScript origin. Copy the client id (`...apps.googleusercontent.com`; it is public, not a secret).
2. In the editor run `setupGoogleSignIn('<client id>')` and `setupAppUrl('https://<your-site>/')` (QR codes and email links then point at the site).
3. Optionally `Setup.setAllowedDomains` to change the allowed domains (default `karunya.edu`, `karunya.edu.in`).
4. Deploy the static site. For Vercel, import the repository and set two environment variables: `LABFLOW_API_URL` (the `/exec` URL) and `LABFLOW_GOOGLE_CLIENT_ID`. The build is `node scripts/build-web.js` into `dist/`, and `vercel.json` adds the security headers. Locally: `LABFLOW_API_URL=... LABFLOW_GOOGLE_CLIENT_ID=... npm run build:web`.
5. `Setup.rotateSessions` signs everyone out of the hosted app.

## 5. Configure the university data

Sign in as the bootstrap admin, then in the admin pages:

1. **Labs**: code, room, capacity, GPS and radius, opening hours, check-in mode, department, and Open lab if the lab runs daily extra hours.
2. **Kiosks**: a kiosk is a dedicated Google account (for example `iot-lab-kiosk@karunya.edu`) bound to one lab. Sign in with it on the lab PC or tablet. Kiosk accounts can call only the kiosk routes (`kiosk.ping`, `kiosk.display`, `kiosk.scan`).
3. **Users and roles**, courses, rosters and the timetable. CSV import is available for users and students (`URK24CS1021`-style roll numbers fill join year and department).
4. **Settings**: allowed values are listed with limits in Admin > Settings; set `reportRecipients`, `hodEmail` and `academicYearStartMonth`, and choose a site theme ([themes.md](themes.md)).
5. Students open the app on their phone, open "My device", run the compatibility check and register the device. A second or replacement device needs in-person approval by staff.

## 6. Backups and the archive

Backups and archives need no setup: the first backup creates the Drive folder "LABFLOW Backups", and the first archive creates a folder "LABFLOW Archive" owned by the script owner. Press **Back up now** under Admin > Audit & system > System health to test it. The details are in SECURITY.md section 6.

## Keep these safe

| Secret | Why |
|---|---|
| `PII_KEY` (script property) | Without it, a restored backup shows phone numbers as sealed text. Note it somewhere separate from the spreadsheet |
| Script owner account | Anyone who can edit the script or the spreadsheet bypasses all application authorisation. Keep that set minimal |
| Audit anchor recipients | The nightly anchor email is what makes a full rewrite of the audit chain detectable |

## After deploying

Work through [TEST_PLAN.md](../TEST_PLAN.md) section B. The highest risk is identity for both domains (check 1), then key persistence on real phones inside the iframe (check 4) and the camera (check 5).
