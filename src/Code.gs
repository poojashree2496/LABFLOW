/**
 * Code.gs - web app entry point and the single RPC gateway.
 *
 * Every browser call goes through rpc(action, payload). Authorisation is decided HERE and again inside the handlers:
 *  1. identity comes from a verified LABFLOW session (hosted app, doPost) or Session.getActiveUser() (Apps Script
 *     page), resolved by Auth.resolve - never from the payload;
 *  2. the ROUTES table lists the roles allowed for each action; anything not listed does not exist;
 *  3. handlers re-check ownership (a faculty member's own session, a student's own record, a group's membership).
 * Hiding a button in the UI is cosmetic; this table is the control.
 *
 * Role tokens: 'any' = a signed-in allowed-domain Google account even without a LABFLOW account (onboarding only);
 * 'user' = has a LABFLOW account; otherwise one or more of student | faculty | staff | admin | hod | kiosk.
 * Labels in the UI: staff = Coordinator, admin = Super admin, hod = HOD (read-only).
 * rl = [maxCalls, windowSeconds] per caller; default is DEFAULT_RL. Denials are audited (throttled).
 */
var DEFAULT_RL = [150, 60];
var FRONTEND_FILES = ['Styles', 'SharedComponents', 'Vendor_QR', 'Scripts', 'ScriptsStudent', 'ScriptsFaculty', 'ScriptsStaff', 'ScriptsAdmin', 'ScriptsKiosk', 'ScriptsThemes', 'ScriptsProjects'];

var ROUTES = {
  // identity / onboarding
  'me': { roles: ['any'], fn: function (c) { return Users.me(c); } },
  'onboard': { roles: ['any'], rl: [10, 300], fn: function (c, p) { return Users.onboard(c, p); } },
  'profile.update': { roles: ['user'], rl: [20, 300], fn: function (c, p) { return Users.updateProfile(c, p); } },
  'notifications.list': { roles: ['user'], fn: function (c) { return Notify.list(c); } },
  'notifications.read': { roles: ['user'], fn: function (c, p) { return Notify.markRead(c, p); } },

  // dashboards
  'dash.student': { roles: ['student'], fn: function (c) { return Dash.student(c); } },
  'dash.faculty': { roles: ['faculty', 'admin'], fn: function (c) { return Dash.faculty(c); } },
  'dash.staff': { roles: ['staff', 'admin', 'hod'], fn: function (c) { return Dash.staff(c); } },
  'dash.admin': { roles: ['admin', 'hod'], fn: function (c, p) { return Dash.admin(c, p); } },

  // device credentials (student)
  'cred.begin': { roles: ['student'], fn: function (c) { return Creds.beginRegistration(c); } },
  'cred.complete': { roles: ['student'], rl: [10, 600], fn: function (c, p) { return Creds.completeRegistration(c, p); } },
  'cred.mine': { roles: ['student'], fn: function (c, p) { return Creds.listForStudent(c, {}); } },
  'cred.revoke': { roles: ['student', 'staff', 'admin'], rl: [20, 600], fn: function (c, p) { return Creds.revoke(c, p); } },
  'cred.list': { roles: ['staff', 'admin'], fn: function (c, p) { return Creds.listForStudent(c, p); } },
  'cred.pending': { roles: ['faculty', 'staff', 'admin'], fn: function (c) { return Creds.listPending(c); } },
  'cred.approve': { roles: ['faculty', 'staff', 'admin'], fn: function (c, p) { return Creds.approve(c, p); } },   // faculty: phone-app switches only
  'cred.reject': { roles: ['faculty', 'staff', 'admin'], fn: function (c, p) { return Creds.reject(c, p); } },

  // attendance: student side
  'attend.challenge': { roles: ['student'], rl: [60, 60], fn: function (c, p) { return Attend.challenge(c, p); } },
  'attend.history': { roles: ['student'], fn: function (c, p) { return Attend.myHistory(c, p); } },
  'attend.events': { roles: ['student'], fn: function (c, p) { return Attend.myEvents(c, p); } },
  'sessions.mine': { roles: ['student'], fn: function (c, p) { return Sessions.listForStudent(c, p); } },
  'research.request': { roles: ['student'], rl: [10, 600], fn: function (c, p) { return Sessions.requestResearch(c, p); } },
  'photo.set': { roles: ['student', 'staff', 'admin'], rl: [10, 600], maxBytes: 700000, fn: function (c, p) { return Users.setPhoto(c, p); } },

  // attendance, Version A: kiosk shows a rotating QR, the student's phone opens it and sends its location
  'checkin.open': { roles: ['student'], rl: [30, 60], fn: function (c, p) { return Checkin.open(c, p); } },
  'checkin.submit': { roles: ['student'], rl: [30, 60], fn: function (c, p) { return Checkin.submit(c, p); } },
  'kiosk.display': { roles: ['kiosk'], rl: [60, 60], fn: function (c) { return Checkin.display(c); } },

  // attendance, Version B: the student's device-signed QR is scanned by the kiosk or by a teacher / staff / CR phone
  'kiosk.ping': { roles: ['kiosk'], rl: [60, 60], fn: function (c) { return Kiosks.ping(c); } },
  'kiosk.scan': { roles: ['kiosk'], rl: [400, 60], fn: function (c, p) { return Attend.kioskScan(c, p); } },
  'scan.submit': { roles: ['user'], rl: [150, 60], fn: function (c, p) { return Attend.phoneScan(c, p); } },
  'scan.photo': { roles: ['kiosk', 'user'], rl: [120, 60], fn: function (c, p) { return Attend.scanPhoto(c, p); } },
  'student.identify': { roles: ['staff', 'admin'], rl: [60, 60], fn: function (c, p) { return Attend.identify(c, p); } },
  'labs.occupancy': { roles: ['user', 'kiosk'], rl: [90, 60], fn: function (c) { return Occupancy.list(c); } },

  // tier 3, the phone app (PresenceService.gs). 'app.link' runs without a session (doPost) because it creates one.
  'app.pairCode': { roles: ['student'], rl: [10, 600], fn: function (c) { return Presence.pairCode(c); } },
  'app.status': { roles: ['student'], rl: [60, 60], fn: function (c, p) { return Presence.status(c, p); } },
  'app.scan': { roles: ['student'], rl: [30, 60], fn: function (c, p) { return Presence.appScan(c, p); } },
  'app.ping': { roles: ['student'], rl: [60, 60], maxBytes: 200000, fn: function (c, p) { return Presence.ping(c, p); } },
  'app.bio': { roles: ['student'], rl: [20, 60], fn: function (c, p) { return Presence.bioRespond(c, p); } },
  'presence.webPing': { roles: ['student'], rl: [30, 60], fn: function (c, p) { return Presence.webPing(c, p); } },
  'presence.bioNow': { roles: ['user'], rl: [10, 60], fn: function (c, p) { return Presence.bioNow(c, p); } },   // the session's operator (checked in Presence)
  'attend.override': { roles: ['faculty', 'admin'], fn: function (c, p) { return Presence.override(c, p); } },

  // faculty / sessions
  'sessions.day': { roles: ['faculty', 'staff', 'admin', 'hod'], fn: function (c, p) { return Sessions.listForDay(c, p); } },
  'sessions.get': { roles: ['faculty', 'staff', 'admin', 'hod'], fn: function (c, p) { return Sessions.get(c, p); } },
  'sessions.create': { roles: ['faculty', 'admin'], fn: function (c, p) { return Sessions.create(c, p); } },
  'sessions.open': { roles: ['user'], fn: function (c, p) { return Sessions.open(c, p); } },   // owner, event coordinator or class rep (checked in Sessions)
  'sessions.setMode': { roles: ['user'], rl: [20, 60], fn: function (c, p) { return Sessions.setMode(c, p); } },
  'attend.unmark': { roles: ['user'], rl: [60, 60], fn: function (c, p) { return Attend.unmark(c, p); } },   // faculty owner, event coordinator or admin (checked in Attend)
  'sessions.checkinQr': { roles: ['user'], rl: [120, 60], fn: function (c, p) { return Sessions.checkinQr(c, p); } },
  'sessions.close': { roles: ['user'], fn: function (c, p) { return Sessions.close(c, p); } },
  'sessions.cancel': { roles: ['faculty', 'admin'], fn: function (c, p) { return Sessions.cancel(c, p); } },
  'research.pending': { roles: ['faculty', 'admin'], fn: function (c) { return Sessions.pendingResearch(c); } },
  'research.decide': { roles: ['faculty', 'admin'], fn: function (c, p) { return Sessions.decideResearch(c, p); } },
  'roster.session': { roles: ['faculty', 'admin'], maxBytes: 200000, fn: function (c, p) { return Roster.addToSession(c, p); } },
  'attend.roster': { roles: ['user'], rl: [240, 60], fn: function (c, p) { return Attend.roster(c, p); } },
  'attend.studentEvents': { roles: ['faculty', 'staff', 'admin', 'hod'], fn: function (c, p) { return Attend.studentEvents(c, p); } },
  'attend.openRescan': { roles: ['user'], fn: function (c, p) { return Attend.openRescan(c, p); } },
  'flags.list': { roles: ['faculty', 'staff', 'admin', 'hod'], fn: function (c, p) { return Flags.list(c, p); } },
  'flags.resolve': { roles: ['faculty', 'staff', 'admin'], fn: function (c, p) { return Flags.resolve(c, p); } },

  // events and class representatives
  'events.create': { roles: ['faculty', 'admin'], rl: [20, 300], maxBytes: 200000, fn: function (c, p) { return Events.create(c, p); } },
  'events.list': { roles: ['faculty', 'staff', 'admin', 'hod'], fn: function (c, p) { return Events.list(c, p); } },
  'events.mine': { roles: ['user'], fn: function (c) { return Events.mine(c); } },
  'events.register': { roles: ['user'], maxBytes: 200000, fn: function (c, p) { return Events.register(c, p); } },
  'events.addGuest': { roles: ['user'], rl: [60, 300], fn: function (c, p) { return Events.addGuest(c, p); } },
  'events.guests': { roles: ['user', 'hod'], fn: function (c, p) { return Events.guests(c, p); } },
  'events.cancel': { roles: ['faculty', 'admin'], fn: function (c, p) { return Events.cancel(c, p); } },
  'classreps.list': { roles: ['faculty', 'staff', 'admin', 'hod'], fn: function (c, p) { return ClassReps.list(c, p); } },
  'classreps.set': { roles: ['faculty', 'admin'], fn: function (c, p) { return ClassReps.set(c, p); } },
  'classreps.remove': { roles: ['faculty', 'admin'], fn: function (c, p) { return ClassReps.remove(c, p); } },
  'cr.mine': { roles: ['student'], fn: function (c) { return ClassReps.mine(c); } },
  'spot.start': { roles: ['faculty', 'admin'], fn: function (c, p) { return Attend.startSpotCheck(c, p); } },
  'spot.list': { roles: ['faculty', 'admin'], fn: function (c, p) { return Attend.listSpotChecks(c, p); } },
  'spot.resolve': { roles: ['faculty', 'admin'], fn: function (c, p) { return Attend.resolveSpotCheck(c, p); } },
  'attend.correct': { roles: ['faculty', 'admin'], fn: function (c, p) { return Attend.correct(c, p); } },
  'corrections.pending': { roles: ['admin'], fn: function () { return Attend.pendingCorrections(); } },
  'corrections.decide': { roles: ['admin'], fn: function (c, p) { return Attend.decideCorrection(c, p); } },
  'photo.get': { roles: ['faculty', 'staff', 'admin'], rl: [60, 60], fn: function (c, p) { return Users.getPhoto(c, p); } },
  'students.list': { roles: ['faculty', 'staff', 'admin', 'hod'], fn: function (c, p) { return Users.listStudents(c, p); } },

  // staff: verification, inventory, loans, bookings
  'students.verify': { roles: ['staff', 'admin'], fn: function (c, p) { return Users.verifyStudent(c, p); } },
  'students.unlink': { roles: ['admin'], fn: function (c, p) { return Users.unlinkStudent(c, p); } },
  'students.import': { roles: ['staff', 'admin'], maxBytes: 400000, fn: function (c, p) { return Users.importStudents(c, p); } },
  'categories.list': { roles: ['user'], fn: function () { return Assets.listCategories(); } },
  'catalog.list': { roles: ['user'], fn: function (c, p) { return Assets.catalog(c, p); } },
  'equipment.request': { roles: ['student'], rl: [20, 300], fn: function (c, p) { return Requests.create(c, p); } },
  'equipment.mine': { roles: ['student'], fn: function (c) { return Requests.mine(c); } },
  'equipment.cancel': { roles: ['student'], fn: function (c, p) { return Requests.cancel(c, p); } },
  'equipment.list': { roles: ['staff', 'admin', 'hod'], fn: function (c, p) { return Requests.list(c, p); } },
  'equipment.decide': { roles: ['staff', 'admin'], fn: function (c, p) { return Requests.decide(c, p); } },
  'categories.upsert': { roles: ['staff', 'admin'], fn: function (c, p) { return Assets.upsertCategory(c, p); } },
  'assets.list': { roles: ['faculty', 'staff', 'admin', 'hod'], fn: function (c, p) { return Assets.list(c, p); } },
  'assets.upsert': { roles: ['staff', 'admin'], fn: function (c, p) { return Assets.upsert(c, p); } },
  'assets.import': { roles: ['staff', 'admin'], maxBytes: 400000, fn: function (c, p) { return Assets.importAssets(c, p); } },
  'assets.condition': { roles: ['staff', 'admin'], fn: function (c, p) { return Assets.conditionCheck(c, p); } },
  'assets.history': { roles: ['staff', 'admin', 'hod'], fn: function (c, p) { return Assets.history(c, p); } },
  'kits.list': { roles: ['user'], fn: function (c, p) { return Kits.list(c, p); } },
  'kits.upsert': { roles: ['staff', 'admin'], fn: function (c, p) { return Kits.upsert(c, p); } },
  'groups.list': { roles: ['student', 'faculty', 'staff', 'admin', 'hod'], fn: function (c, p) { return Groups.list(c, p); } },
  'groups.create': { roles: ['faculty', 'staff', 'admin'], fn: function (c, p) { return Groups.create(c, p); } },
  'groups.status': { roles: ['staff', 'admin'], fn: function (c, p) { return Groups.setStatus(c, p); } },
  'loans.issue': { roles: ['staff', 'admin'], rl: [60, 60], fn: function (c, p) { return Loans.issue(c, p); } },
  'loans.return': { roles: ['staff', 'admin'], rl: [60, 60], fn: function (c, p) { return Loans.returnItems(c, p); } },
  'loans.get': { roles: ['student', 'staff', 'admin', 'hod'], fn: function (c, p) { return Loans.get(c, p); } },
  'loans.mine': { roles: ['student'], fn: function (c) { return Loans.mine(c); } },
  'loans.list': { roles: ['staff', 'admin', 'hod'], fn: function (c, p) { return Loans.list(c, p); } },
  'booking.check': { roles: ['student', 'faculty', 'staff', 'admin', 'hod'], fn: function (c, p) { return Booking.checkAvailability(c, p); } },
  'booking.request': { roles: ['student', 'faculty'], rl: [20, 300], fn: function (c, p) { return Booking.request(c, p); } },
  'booking.cancel': { roles: ['student', 'faculty', 'staff', 'admin'], fn: function (c, p) { return Booking.cancel(c, p); } },
  'booking.mine': { roles: ['student', 'faculty'], fn: function (c) { return Booking.mine(c); } },
  'booking.list': { roles: ['staff', 'admin', 'hod'], fn: function (c, p) { return Booking.list(c, p); } },
  'booking.decide': { roles: ['staff', 'admin'], fn: function (c, p) { return Booking.decide(c, p); } },

  // reference data (read by everyone with an account, written by admin)
  'directory.faculty': { roles: ['user'], fn: function (c) { return Users.facultyDirectory(c); } },
  'labs.list': { roles: ['user'], fn: function (c, p) { return Labs.list(c, p); } },
  'courses.list': { roles: ['faculty', 'staff', 'admin', 'hod'], fn: function (c) { return Courses.list(c); } },
  'timetable.list': { roles: ['faculty', 'staff', 'admin', 'hod'], fn: function (c, p) { return Timetable.list(c, p); } },
  'facultycourses.list': { roles: ['faculty', 'staff', 'admin', 'hod'], fn: function (c, p) { return FacultyCourses.list(c, p); } },

  // admin configuration
  'labs.upsert': { roles: ['admin'], fn: function (c, p) { return Labs.upsert(c, p); } },
  'kiosks.list': { roles: ['admin', 'hod'], fn: function (c) { return Kiosks.list(c); } },
  'kiosks.upsert': { roles: ['admin'], fn: function (c, p) { return Kiosks.upsert(c, p); } },
  'courses.upsert': { roles: ['admin'], fn: function (c, p) { return Courses.upsert(c, p); } },
  'courses.import': { roles: ['admin'], maxBytes: 400000, fn: function (c, p) { return Courses.import(c, p); } },
  'roster.import': { roles: ['faculty', 'staff', 'admin'], maxBytes: 400000, fn: function (c, p) { return Roster.import(c, p); } },
  'roster.list': { roles: ['faculty', 'staff', 'admin', 'hod'], fn: function (c, p) { return Roster.list(c, p); } },
  'roster.remove': { roles: ['faculty', 'staff', 'admin'], fn: function (c, p) { return Roster.remove(c, p); } },
  'facultycourses.set': { roles: ['admin'], fn: function (c, p) { return FacultyCourses.set(c, p); } },
  'facultycourses.remove': { roles: ['admin'], fn: function (c, p) { return FacultyCourses.remove(c, p); } },
  'timetable.upsert': { roles: ['admin'], fn: function (c, p) { return Timetable.upsert(c, p); } },
  'timetable.remove': { roles: ['admin'], fn: function (c, p) { return Timetable.remove(c, p); } },
  'users.list': { roles: ['admin', 'hod'], fn: function (c) { return Users.listUsers(c); } },
  'users.upsert': { roles: ['admin'], fn: function (c, p) { return Users.upsertUser(c, p); } },
  'users.status': { roles: ['admin'], fn: function (c, p) { return Users.setUserStatus(c, p); } },
  'users.import': { roles: ['admin'], maxBytes: 400000, fn: function (c, p) { return Users.importUsers(c, p); } },
  'settings.get': { roles: ['admin'], fn: function () { return Admin.getSettings(); } },
  'settings.set': { roles: ['admin'], fn: function (c, p) { return Admin.setSettings(c, p); } },
  'audit.list': { roles: ['admin', 'hod'], fn: function (c, p) { return Admin.auditList(c, p); } },
  'audit.verify': { roles: ['admin'], rl: [10, 300], fn: function (c) { return Admin.auditVerify(c); } },
  'system.status': { roles: ['admin'], fn: function () { return Admin.systemStatus(); } },
  'system.quota': { roles: ['admin'], rl: [20, 60], fn: function () { return Admin.quota(); } },
  'activity.feed': { roles: ['staff', 'admin', 'hod'], rl: [90, 60], fn: function (c) { return Dash.activity(c); } },
  'system.reconcileInventory': { roles: ['admin'], rl: [10, 300], fn: function (c, p) { return Admin.reconcileInventory(c, p); } },
  'system.reconcileSession': { roles: ['admin'], rl: [10, 300], fn: function (c, p) { return Admin.reconcileSession(c, p); } },

  // reports
  'reports.run': { roles: ['student', 'faculty', 'staff', 'admin', 'hod'], rl: [20, 300], fn: function (c, p) { return Reports.run(c, p); } },
  'reports.csv': { roles: ['student', 'faculty', 'staff', 'admin', 'hod'], rl: [10, 300], fn: function (c, p) { return Reports.csv(c, p); } },
  'reports.pdf': { roles: ['student', 'faculty', 'staff', 'admin', 'hod'], rl: [5, 300], fn: function (c, p) { return Reports.pdf(c, p); } },

  // v2 (docs/requirements.md section 4). Roles are final; the handlers are built by the task named on each line.
  'projects.create': { roles: ['student'], rl: [10, 300], fn: function (c, p) { return Projects.create(c, p); } }, // C1
  'projects.mine': { roles: ['student'], fn: function (c, p) { return Projects.mine(c, p); } }, // C1
  'projects.get': { roles: ['student', 'faculty', 'staff', 'admin', 'hod'], fn: function (c, p) { return Projects.get(c, p); } }, // C1
  'projects.list': { roles: ['faculty', 'staff', 'admin', 'hod'], fn: function (c, p) { return Projects.list(c, p); } }, // C1
  'projects.decide': { roles: ['faculty', 'staff', 'admin'], rl: [60, 60], fn: function (c, p) { return Projects.decide(c, p); } }, // C1
  'projects.outcome': { roles: ['student', 'faculty'], rl: [20, 300], fn: function (c, p) { return Projects.outcome(c, p); } }, // C1
  'attend.setWork': { roles: ['student'], rl: [30, 60], fn: function (c, p) { return Attend.setWork(c, p); } }, // C3
  'labs.live': { roles: ['faculty', 'staff', 'admin', 'hod'], rl: [90, 60], fn: function (c, p) { return Occupancy.live(c, p); } }, // B4
  'systems.status': { roles: ['user'], rl: [90, 60], fn: function (c, p) { return Occupancy.systems(c, p); } }, // B4
  'users.revealMobile': { roles: ['staff', 'admin'], rl: [20, 300], fn: function (c, p) { return Users.revealMobile(c, p); } }, // A2
  'students.status': { roles: ['staff', 'admin'], fn: function (c, p) { return Users.setStudentStatus(c, p); } }, // B2
  'dash.hod': { roles: ['hod', 'admin'], fn: function (c, p) { return Dash.hod(c, p); } }, // B3
  'system.backup': { roles: ['admin'], rl: [5, 300], fn: function (c, p) { return Backup.now(c, p); } }, // A3
  'system.backups': { roles: ['admin'], fn: function (c, p) { return Backup.list(c, p); } }, // A3
  'system.archive': { roles: ['admin'], rl: [3, 300], fn: function (c, p) { return Backup.archiveYear(c, p); } } // A4
};

/**
 * The Apps Script page is served only to a visitor Google identifies (same Workspace domain as the owner, or the
 * owner). Everyone else gets a short JSON pointer to the hosted app: on an "Anyone" deployment an HTML page here
 * would expose google.script.run to anonymous visitors.
 */
function doGet(e) {
  if (!Auth.rawEmail()) return json_({ ok: true, data: { app: 'LABFLOW', open: Setup.webAppUrl(), api: 'POST {action, payload, session} as text/plain' } });
  var t = HtmlService.createTemplateFromFile('Index');
  t.launch = launchJson_(e && e.parameter);
  return t.evaluate().setTitle('LABFLOW').addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/**
 * JSON API for the hosted app. The browser POSTs text/plain (a "simple" request, so no CORS preflight, which Apps
 * Script cannot answer) with body {action, payload, session}. Identity comes ONLY from the session: a call without
 * one is refused even if the browser happens to carry Google cookies for the owner (no cross-site request forgery).
 * Three actions run without a session: 'auth.google' exchanges a Google ID token for one, 'app.link' exchanges the
 * phone app's pairing code for one, and 'ui.theme' returns only the site theme so the sign-in screen can wear it.
 */
function doPost(e) {
  var body = null;
  try { body = JSON.parse(e && e.postData && e.postData.contents || ''); } catch (x) { body = null; }
  if (!body || typeof body !== 'object' || typeof body.action !== 'string') return json_({ ok: false, error: { code: 'BAD_INPUT', message: 'Invalid request.' } });
  if (body.action === 'auth.google') return json_(signIn_(body.payload));
  if (body.action === 'ui.theme') return json_({ ok: true, data: { uiTheme: Settings.get('uiTheme') } });
  if (body.action === 'app.link') return json_(appLink_(body.payload));
  return json_(rpc(body.action, body.payload, typeof body.session === 'string' ? body.session : '', true));
}

function signIn_(payload) { return sessionFree_(function () { return Auth.signIn(payload || {}); }); }
/** The phone app trades a single-use pairing code (made by the signed-in web app) for its own session. */
function appLink_(payload) { return sessionFree_(function () { return Presence.link(payload || {}); }); }
function sessionFree_(fn) {
  try { return { ok: true, data: fn() }; }
  catch (e) {
    if (e instanceof AppError) return { ok: false, error: { code: e.code, message: e.message, extra: e.extra || null } };
    var ref = 'E' + Utilities.getUuid().slice(0, 8).toUpperCase();
    try { Syslog.error('auth', 'UNEXPECTED', String(e && e.message), { ref: ref }); } catch (x) { console.error(ref + ' ' + e); }
    return { ok: false, error: { code: 'INTERNAL', message: 'Something went wrong. Reference ' + ref + '.', ref: ref } };
  }
}

function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

/**
 * The app can be opened from a QR link: ?k=<kiosk code> (Version A: a student scanned the kiosk screen) or
 * ?s=<student code> (Version B: a teacher / staff / CR phone scanned a student). The values are only passed through
 * to the page, which sends them back to rpc() for verification; they are character-checked here and embedded as
 * JSON with "<" escaped, so a crafted link cannot inject markup.
 */
function launchJson_(params) {
  var out = {};
  params = params || {};
  if (typeof params.k === 'string' && /^[A-Za-z0-9._-]{10,200}$/.test(params.k)) out.k = params.k;
  if (typeof params.s === 'string' && /^[A-Za-z0-9._~-]{40,600}$/.test(params.s)) out.s = params.s;
  if (params.pairApp === '1') out.pairApp = true;
  return JSON.stringify(out).replace(/</g, '\\u003c');
}

/** HTML template include. Whitelisted so the client cannot read arbitrary project files through it. */
function include(name) {
  if (FRONTEND_FILES.indexOf(name) < 0) throw new Error('Unknown include');
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/**
 * The only client-callable gateway. Always returns { ok:true, data } or { ok:false, error:{ code, message, extra, ref } }
 * (never throws), so the UI can show a precise message and never sees a stack trace.
 */
function rpc(action, payload, session, apiCall) {
  var started = Date.now();
  try {
    var route = (typeof action === 'string' && Object.prototype.hasOwnProperty.call(ROUTES, action)) ? ROUTES[action] : null;
    if (!route) fail('NOT_FOUND', 'Unknown action.');
    var body = payload === undefined || payload === null ? {} : payload;
    var size = 0; try { size = JSON.stringify(body).length; } catch (e) { fail('BAD_INPUT', 'Invalid request.'); }
    if (size > (route.maxBytes || 100000)) fail('TOO_LARGE', 'The request is too large.');
    var ctx = Auth.resolve(session, apiCall === true);
    var allowed = route.roles.some(function (r) { return r === 'any' || (r === 'user' && !!ctx.user) || ctx.has(r); });
    allowed = allowed && (!Auth.hodOnly(ctx) || Auth.HOD_ACTIONS.indexOf(action) >= 0);
    if (!allowed) {
      if (Auth.rateLimit('deny|' + ctx.email, 5, 60)) Audit.tryLog({ actor: ctx.email, role: ctx.roles.join(','), action: 'rpc.denied', entityType: 'Action', entityId: action, result: 'denied', detail: { roles: ctx.roles } });
      fail('FORBIDDEN', 'You do not have permission to do that.');
    }
    var rl = route.rl || DEFAULT_RL, who = ctx.kiosk ? 'k:' + ctx.kiosk.kioskId : ctx.email;
    if (!Auth.rateLimit(action + '|' + who, rl[0], rl[1])) fail('RATE_LIMITED', 'Too many requests. Please slow down.');
    Admin.countCall();
    var data = route.fn(ctx, body);
    return { ok: true, data: data === undefined ? null : data, ms: Date.now() - started };
  } catch (e) {
    if (e instanceof AppError) return { ok: false, error: { code: e.code, message: e.message, extra: e.extra || null } };
    var ref = 'E' + Utilities.getUuid().slice(0, 8).toUpperCase();
    try { Syslog.error('rpc', 'UNEXPECTED', String(action) + ': ' + String(e && e.message), { ref: ref, stack: String(e && e.stack).slice(0, 600) }); } catch (x) { console.error(ref + ' ' + e); }
    return { ok: false, error: { code: 'INTERNAL', message: 'Something went wrong. Reference ' + ref + '.', ref: ref } };
  }
}

// Convenience wrappers to run from the Apps Script editor. They are global functions, so google.script.run could call them;
// ownerOnly_() therefore refuses unless the caller IS the script owner (running from the editor).
function ownerOnly_() {
  var a = '', o = '';
  try { a = String(Session.getActiveUser().getEmail() || '').toLowerCase(); o = String(Session.getEffectiveUser().getEmail() || '').toLowerCase(); } catch (e) {}
  if (!a || a !== o) throw new Error('Owner only: run this from the Apps Script editor.');
}
function setupInitialise() { ownerOnly_(); return Setup.initialise({}); }
function setupSelfTest() { ownerOnly_(); return Setup.selfTest(); }
/** One-off migration (A2): seal every phone number still stored as plain text. Safe to run again. */
function setupEncryptMobiles() { ownerOnly_(); var r = Users.encryptMobiles(); Audit.tryLog({ actor: 'script-owner', role: 'owner', action: 'pii.encrypt', entityType: 'Users', result: 'ok', detail: r }); console.log(JSON.stringify(r)); return r; }
function setupInstallTriggers() { ownerOnly_(); return Triggers.install(); }
function setupBootstrapAdmin(email) { ownerOnly_(); return Setup.setBootstrapAdmin(email); }
function setupGoogleSignIn(clientId) { ownerOnly_(); return Setup.setGoogleSignIn(clientId); }
function setupAppUrl(url) { ownerOnly_(); return Setup.setAppUrl(url); }
function setupBenchmarkScans(students) { ownerOnly_(); return Setup.benchmarkScans(students); }
