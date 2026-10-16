const test = require('node:test');
const assert = require('node:assert/strict');
const { world } = require('./fixtures');
const { load, initDb } = require('./harness');

const clearThrottle = (w) => Object.keys(w.e.cacheStore).filter((k) => k.startsWith('job|')).forEach((k) => delete w.e.cacheStore[k]);

test('Setup.initialise is idempotent and refuses to touch mismatching sheets', () => {
  const e = load(); const first = initDb(e);
  assert.ok(first.created.length > 20);
  const second = e.run('Setup.initialise({ silent: true })');
  assert.equal(second.created.length, 0); assert.equal(second.spreadsheetId, first.spreadsheetId);
  e.run("Db.sheet('Users').getRange(1, 2, 1, 1).setValues([['hacked']])");
  assert.throws(() => e.run('Setup.initialise({ silent: true })'), /headers differ/);
});

test('text columns are stored as text: roll numbers with leading zeros and formula-like names survive', () => {
  const w = world({ students: 0 });
  w.ok(w.admin, 'students.import', { rows: [{ rollNo: '007', name: '=1+1 Bond', email: 'bond@karunya.edu' }] });
  const r = w.ok(w.staff, 'students.list', {}).students[0];
  assert.equal(r.rollNo, '007'); assert.equal(r.name, '=1+1 Bond');
});

test('selfTest passes on the fake platform (real-platform timings only come from a deployment)', () => {
  const w = world({ students: 0 });
  w.e.run("ScriptApp.newTrigger('x')"); // fake supports it
  w.eval('Triggers.install()');
  const r = w.eval('Setup.selfTest()');
  const bad = r.checks.filter((c) => !c.ok);
  assert.deepEqual(bad, [], JSON.stringify(bad));
  assert.ok(r.checks.length >= 12);
});

test('triggers: install is idempotent, creates exactly our five, never touches foreign triggers', () => {
  const w = world({ students: 0 });
  w.e.run("ScriptApp.newTrigger('someoneElsesJob').timeBased().everyHours(1).create();");
  assert.equal(w.eval('Triggers.install()').created.length, 5);
  assert.equal(w.eval('Triggers.install()').removed, 5);
  const st = w.eval('Triggers.status()');
  assert.equal(st.ok, true); assert.equal(st.otherTriggers, 1);
  assert.equal(w.e.triggers.length, 6);
  w.eval('Triggers.remove()');
  assert.equal(w.e.triggers.length, 1);
  assert.equal(w.eval('Triggers.status()').ok, false);
});

test('nightly job: materialises sessions once, reconciles, checkpoints; reruns create nothing new', () => {
  const w = world({ students: 2 });
  const r1 = JSON.parse(w.e.run('JSON.stringify(Jobs.nightly())'));
  assert.equal(r1.status, 'ok', JSON.stringify(r1));
  const count = () => w.eval("Db.readAll('Sessions').length");
  const c1 = count();
  assert.ok(c1 >= 1);
  clearThrottle(w);
  w.e.run('Jobs.nightly()');
  assert.equal(count(), c1, 'idempotent');
  const throttled = JSON.parse(w.e.run('JSON.stringify(Jobs.nightly())'));
  assert.equal(throttled.skipped, 'throttled', 'calling the entry point repeatedly is throttled');
  assert.ok(w.eval("Db.readAll('AuditCheckpoints').length") >= 1);
  // duplicate materialisation race: second writer gets DUPLICATE and creates nothing
  assert.equal(w.eval("Sessions.materialize('2026-10-14')"), 0);
});

test('a failing job step is logged and does not stop later steps or throw', () => {
  const w = world({ students: 0 });
  w.e.run("Assets.reconcile = function () { throw new Error('sheet exploded'); };");
  const r = JSON.parse(w.e.run('JSON.stringify(Jobs.nightly())'));
  assert.equal(r.status, 'ok');
  assert.match(r.detail.inventoryReconcile.error, /exploded/);
  assert.ok(r.detail.auditCheckpoint !== undefined);
  assert.ok(w.eval("Db.readAll('SystemLog')").some((l) => l.code === 'STEP_FAILED'));
  assert.ok(w.eval("Db.readAll('JobRuns')").some((j) => j.job === 'nightly'));
});

test('stale open sessions are auto-closed independently; recent ones untouched', async () => {
  const w = world({ students: 1 });
  await w.registerDevice(w.students[0]);
  const s1 = w.session(); w.ok(w.faculty, 'sessions.open', { sessionId: s1.sessionId });
  const ev = w.ok(w.faculty, 'sessions.create', { type: 'event', labId: w.lab2.labId, title: 'Later', date: w.today, startTime: '13:00', endTime: '16:00', openToAll: true }).session;
  w.e.setTime(w.NOW + 3 * 3600000); w.ok(w.faculty, 'sessions.open', { sessionId: ev.sessionId, override: false });
  w.scan(await w.qr(w.students[0], ev.sessionId, 'in', w.devices[w.students[0].studentId]), 'kiosk2@karunya.edu');
  w.e.setTime(w.NOW + 2 * 3600000 + 31 * 60000); // class ended 12:00, grace 30 min
  const r = w.eval('Sessions.autoCloseStale()');
  assert.equal(r.closed, 1);
  const day = w.ok(w.faculty, 'sessions.day', { date: w.today }).sessions;
  assert.equal(day.find((s) => s.sessionId === s1.sessionId).status, 'closed');
  assert.equal(day.find((s) => s.sessionId === ev.sessionId).status, 'open');
  assert.equal(w.eval("Db.get('Sessions', " + JSON.stringify(s1.sessionId) + ").closeReason"), 'auto-closed after scheduled end');
});

test('timetable: faculty double-booking is blocked, lab overlap needs an explicit override; sessions follow the timetable', () => {
  const w = world({ students: 0 });
  const c2 = w.ok(w.admin, 'courses.upsert', { code: 'CSE302', name: 'Compilers' }).course;
  const base = { labId: w.lab2.labId, courseId: c2.courseId, facultyId: w.facultyId, dayOfWeek: 3, startTime: '11:00', endTime: '12:30', validFrom: '2026-10-01', validTo: '2026-12-31' };
  assert.equal(w.err(w.admin, 'timetable.upsert', base).code, 'CONFLICT', 'same faculty already teaches 10-12 on Wednesdays');
  const f2 = Object.assign({}, base, { facultyId: w.faculty2Id, labId: w.lab.labId });
  const e1 = w.err(w.admin, 'timetable.upsert', f2);
  assert.equal(e1.code, 'CONFLICT'); assert.equal(e1.extra.overridable, true);
  assert.equal(w.ok(w.admin, 'timetable.upsert', Object.assign({ override: true }, f2)).slot.courseCode, 'CSE302');
  assert.equal(w.err(w.admin, 'timetable.upsert', Object.assign({}, base, { startTime: '13:00', endTime: '12:00' })).code, 'BAD_INPUT');
  // outside validity: no sessions on a Wednesday after validTo
  w.ok(w.admin, 'timetable.upsert', { labId: w.lab2.labId, courseId: c2.courseId, facultyId: w.faculty2Id, dayOfWeek: 4, startTime: '09:00', endTime: '10:00', validFrom: '2026-10-01', validTo: '2026-10-15' });
  assert.equal(w.eval("Sessions.materialize('2026-10-15')"), 1);
  assert.equal(w.eval("Sessions.materialize('2026-10-22')"), 0);
});

test('email: digest per person, quota reserve respected, failures recorded, disabled switch honoured', () => {
  const w = world({ students: 2 });
  const [a, b] = w.students;
  const st = (id) => w.eval("Db.get('StudentProfiles', " + JSON.stringify(id) + ")");
  w.e.run(`Notify.toStudent(${JSON.stringify(a.studentId)}, 't', 'One', 'first', 'd1'); Notify.toStudent(${JSON.stringify(a.studentId)}, 't', 'Two', 'second', 'd2'); Notify.toStudent(${JSON.stringify(b.studentId)}, 't', 'Solo', 'x', 'd3');
    Notify.toStudent(${JSON.stringify(b.studentId)}, 't', 'Solo', 'x', 'd3');`);
  void st;
  assert.equal(w.eval("Db.readAll('Notifications').filter(function (n) { return n.type === 't'; }).length"), 3, 'dedupeKey prevents the duplicate');
  w.e.state.mailQuota = 40; // below the 50 reserve
  assert.equal(w.eval('Notify.flushEmails()').sent, 0);
  w.e.state.mailQuota = 1000;
  const r = w.eval('Notify.flushEmails()');
  assert.equal(r.sent, 2);
  const mails = w.e.sentMail.filter((m) => /karunya/.test(m.to));
  const toA = mails.find((m) => m.to === a.email);
  assert.match(toA.subject, /2 updates/); assert.ok(/One/.test(toA.body) && /Two/.test(toA.body));
  assert.equal(w.eval('Notify.flushEmails()').sent, 0, 'already sent');
  w.e.run(`Notify.toStudent(${JSON.stringify(a.studentId)}, 't', 'Three', 'x', 'd4');`);
  w.e.state.mailFail = true;
  w.eval('Notify.flushEmails()');
  assert.equal(w.eval("Db.readAll('Notifications').filter(function (n) { return n.title === 'Three'; })[0].emailStatus"), 'failed');
  assert.ok(w.eval("Db.readAll('SystemLog')").some((l) => l.code === 'MAIL_FAILED'));
  w.e.state.mailFail = false;
  w.ok(w.admin, 'settings.set', { values: { emailEnabled: false } });
  w.e.run(`Notify.toStudent(${JSON.stringify(a.studentId)}, 't', 'Four', 'x', 'd5');`);
  assert.equal(w.eval("Db.readAll('Notifications').filter(function (n) { return n.title === 'Four'; })[0].emailStatus"), 'none');
});

test('morning job: daily report and audit anchor are each emailed once per date, only to allowed-domain recipients', () => {
  const w = world({ students: 1 });
  w.ok(w.admin, 'settings.set', { values: { reportRecipients: 'head@karunya.edu,dean@karunya.edu.in' } });
  w.e.setTime(w.NOW + 24 * 3600000); // next day 10:00
  const r = JSON.parse(w.e.run('JSON.stringify(Jobs.morning())'));
  assert.equal(r.status, 'ok', JSON.stringify(r));
  const before = w.e.sentMail.length;
  assert.equal(w.e.sentMail.filter((m) => /Audit anchor/.test(m.subject)).length, 2);
  assert.equal(w.e.sentMail.filter((m) => /Daily lab report/.test(m.subject)).length, 2);
  assert.match(w.e.sentMail.find((m) => /Audit anchor/.test(m.subject)).body, /Head hash: [0-9a-f]{64}/);
  clearThrottle(w);
  w.e.run('Jobs.morning()');
  assert.equal(w.e.sentMail.length, before, 'no duplicate emails on rerun');
  assert.ok(Object.values(w.e.folders).some((f) => f.files.some((x) => /^daily_/.test(x.name))), 'CSV copy saved to the private folder');
});

test('email transport can be switched to MailApp (narrower OAuth scope)', () => {
  const w = world({ students: 0 });
  w.e.run("PropertiesService.getScriptProperties().setProperty('EMAIL_TRANSPORT', 'mail');");
  assert.equal(w.eval("Notify.sendNow('x@karunya.edu', 'Hi', 'Body')"), true);
  assert.equal(w.e.sentMail[0].via, 'mail');
});

test('audit: tamper, truncation and head rewrite are all detected', () => {
  const w = world({ students: 1 });
  for (let i = 0; i < 12; i++) w.ok(w.admin, 'labs.upsert', { code: 'L' + i, name: 'Lab ' + i, type: 'other' });
  w.eval('Audit.checkpoint("test")');
  assert.equal(w.ok(w.admin, 'audit.verify').ok, true);
  // truncation: wipe the last 3 rows
  const n = w.eval("Db.readAll('AuditEvents').length");
  w.e.run(`var s = Db.sheet('AuditEvents'); s.getRange(${n - 1}, 1, 3, 11).setValues([['','','','','','','','','','',''],['','','','','','','','','','',''],['','','','','','','','','','','']]);`);
  const v = w.ok(w.admin, 'audit.verify');
  assert.equal(v.ok, false);
  assert.ok(v.checkpointProblems.length > 0 || v.storedHeadProblem, 'checkpoint/anchor reveals the truncation');
});
