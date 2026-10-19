# Contributing to LABFLOW

How to work in this repository. Read this before your first change. The current work is in [docs/tasks.md](docs/tasks.md), and its reasons in [docs/requirements.md](docs/requirements.md).

## Setup

```
npm install
npm run build        # vendor files + Tailwind -> src/Styles.html
npm run check        # lint + all backend tests (must pass before every merge)
npm run dev          # http://localhost:8787/lab (Test Lab) and /?as=student1@karunya.edu
npm run sim          # scripted scenarios (class rush and attacks)
npm run e2e          # browser suite against the local fakes (needs Chrome; CHROMIUM_PATH overrides)
```

One test file: `node --test test/checkin.test.js`. One test: `node --test --test-name-pattern="replay" test/checkin.test.js`.

In the dev server, `?as=` picks the signed-in account: `admin@`, `staff@`, `faculty@`, `faculty2@`, `student1@`... and `kiosk1@`.. `kiosk3@karunya.edu`. It exists only locally.

## Generated files

`src/Styles.html`, `src/Vendor_P256.gs` and `src/Vendor_QR.html` are generated. Never edit them by hand; run `npm run build`. Tailwind only scans `src/Index.html`, `src/Scripts*.html` and `src/SharedComponents.html`, so a utility class you have not used before exists only after `npm run build:css`.

## How the code is organised

- **One global scope.** Apps Script joins every `.gs` file into a single scope: there are no modules and no `require`. Each service is a global object, and its name often differs from its file (`Attend` is in AttendanceService.gs, `Booking` in BookingService.gs). To find one, search for `var Name =`.
- **Load order is fixed.** A new `.gs` file goes into **both** `LOAD_ORDER` in `test/harness.js` and `filePushOrder` in `.clasp.json.example`, at the same position.
- **One entry point.** The browser can call only `rpc(action, payload)` in `src/Code.gs`.
  - An action exists only if it is in `ROUTES`. Its `roles` list is the access control: `'any'` (any signed-in account on an allowed domain), `'user'` (any LABFLOW account), or named roles.
  - A route can also set `rl: [max, windowSec]` (rate limit) and `maxBytes`.
- **Identity comes from `ctx`**, which `Auth.resolve()` builds from the Google session. Never trust an email, role, roll number or student id in the payload. Handlers are `fn(ctx, payload)` and must check ownership themselves (a faculty member's own session, a student's own record).
- **Errors.** `rpc` never throws: it returns `{ok:true,data}` or `{ok:false,error}`. Raise user-facing errors with `fail(CODE, message)`. Any other exception becomes `INTERNAL` with a reference id and is logged.
- **Validate every payload** with the `V.*` helpers in `src/Util.gs`.

## Data rules

- The schema is the string DSL in `Cfg.SCHEMA_SRC` (`src/Config.gs`), written as `name:type:flags`.
  - Types: `s` text, `n` number, `b` boolean, `j` JSON.
  - Flags: `u` unique, `c` cached lookup.
  - The first column is the primary key.
- **Schema changes are additive.** New columns go at the end of a table, and `Setup.initialise` extends existing sheets. Changing or reordering existing columns breaks deployed sheets.
- **All writes go through `Db.insert`, `Db.update` and `Db.insertMany`.** They take the script lock, enforce uniqueness and clear caches. Never write to a sheet any other way.
- **Rows are never deleted.** Soft-delete with a `status` column. The only exception is the yearly archive (task A4), which copies rows to an archive spreadsheet before removing them.
- Attendance events are append-only: IN, OUT, RESCAN, corrections and voids. Summaries are derived from them and can be rebuilt.
- Admin-tunable values live in `Cfg.SETTINGS` and are read with `Settings.get(key)`. Secrets and deployment config are script properties with keys in `Cfg.PROP`.

## Cross-cutting rules

- **Time:** use `U.now()`, never `Date.now()`. Tests freeze and move the clock. Everything is IST (`U.local`, `U.fromLocal`), sent as `YYYY-MM-DD` and `HH:MM` strings.
- **Audit:** sensitive actions call `Audit.log({actor: ctx.email, role, action, entityType, entityId, detail})`. The log is hash-chained. Never write to `AuditEvents` directly.
- **CSV exports** pass values through `U.csvSafe`.
- Read `SECURITY.md` before you touch sign-in, attendance or the audit log.

## Frontend

- Vanilla JavaScript on `window.LF`. Build elements with `LF.h(tag, props, ...children)`. **Never put data into `innerHTML`.**
- Each screen registers with `LF.register({ role, id, label, icon, render(root) })`, optionally with `when(me)`. Role screens live in `src/Scripts{Student,Faculty,Staff,Admin,Kiosk}.html`.
- Server calls go through `LF.api(action, payload)`. Icons come from the sprite in `SharedComponents.html` (`LF.icon('name')`).
- A new HTML file must be added to **both** `FRONTEND_FILES` in `Code.gs` and `Index.html`.
- The UI only hides buttons. The server decides every permission.
- Never restyle `.qr-frame` or `.scanbox` or their parents; the browser suite checks this.

## Tests

- `test/harness.js` loads the real `src/*.gs` into Node with hand-written fakes of the Google services. The fakes copy real behaviour: `Utilities` returns signed bytes, and unformatted cells turn numeric text into numbers.
- If your code uses a Google service method the fake does not have yet, add it to the fake.
- Write tests through `test/fixtures.js` `world()`. It seeds an admin, staff, faculty, labs, kiosks, a course, students and a timetable slot, on Wed 2026-10-14 at 10:00 IST. The helpers:
  - `w.ok(email, action, payload)` returns the data or throws.
  - `w.err(...)` returns the error.
  - `w.advance(ms)` moves the clock.
  - `w.checkin(student, {...})` checks a student in.
  - `w.eval(expr)` evaluates an expression inside the app.
- Every task in docs/tasks.md names the test file to extend.
- When you add tests, update the counts quoted in README, TEST_PLAN and docs/progress.md.

## Git workflow

- One branch per workstream (`ws-a-data`, `ws-b-roles`, `ws-c-extrahours`), with small pull requests into `main`.
- Before opening a PR, rebase on `main` and get `npm run check` green.
- Commit under your own name. Write messages that say what changed and why. Keep names of tools and assistants out of commits and docs.
- When a task is done: delete it from docs/tasks.md and add a row to the docs/progress.md log (date, change, what ran), in the same commit.
- The contracts in docs/requirements.md section 4 change only through a PR that edits that section, agreed by all three people.
