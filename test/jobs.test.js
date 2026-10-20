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

function openLabVisit(n = 1) {
  const w = world({ students: n });
  w.ok(w.admin, 'labs.upsert', { ...w.lab, openLab: true });
  const projectIds = w.students.map((s) => w.ok(s.email, 'projects.create', { title: 'Closing test', description: 'Closing time test', labId: w.lab.labId,
    supervisorFacultyId: w.facultyId, startDate: w.today, endDate: '2026-12-01' }).project.projectId);
  w.eval('Sessions.autoOpenDue()');
  w.sid = w.eval("Db.readAll('Sessions').filter(function(s){return s.type==='openlab';})[0].sessionId");
  w.setClock = (time) => w.e.setTime(w.eval(`U.fromLocal('${w.today}','${time}')`));
  w.enter = (i = 0) => { const r = w.checkin(w.students[i], { sessionId: w.sid, projectId: projectIds[i] }); assert.equal(r.ok, true, JSON.stringify(r)); };
  w.exits = () => w.eval(`Db.whereEq('AttendanceEvents',{sessionId:'${w.sid}'}).filter(function(e){return e.method==='auto';})`);
  w.summary = (i = 0) => w.eval(`Db.whereEq('AttendanceSummaries',{sessionId:'${w.sid}',studentId:'${w.students[i].studentId}'})[0]`);
  w.closeAudit = () => w.eval(`Db.whereEq('AuditEvents',{entityId:'${w.sid}',action:'session.close'})`);
  return w;
}

test('open-lab closure: exact deadline, delayed execution, all visitors, and repeat execution', () => {
  for (const clock of ['19:00', '19:45']) {
    const w = openLabVisit(2); w.setClock('18:00'); w.enter(0); w.enter(1);
    w.setClock('18:59'); w.eval('Sessions.autoCloseStale()'); assert.equal(w.eval(`Db.get('Sessions','${w.sid}').status`), 'open');
    w.setClock(clock); assert.equal(w.eval('Sessions.autoCloseStale()').closed, 1);
    assert.equal(w.exits().length, 2);
    for (const e of w.exits()) { assert.equal(e.at, w.eval(`U.fromLocal('${w.today}','19:00')`)); assert.equal(e.createdAt, w.eval('U.now()')); assert.equal(e.source, 'system'); }
    for (let i = 0; i < 2; i++) { assert.equal(w.summary(i).verifiedMinutes, 60); assert.ok(w.summary(i).flags.includes('auto_out')); assert.equal(w.summary(i).status, 'present'); }
    assert.deepEqual(w.eval('Sessions.autoCloseStale()'), { closed: 0, failed: 0 });
    assert.equal(w.exits().length, 2); assert.equal(w.closeAudit().length, 1);
    assert.deepEqual(w.eval(`Work.occupants('${w.lab.labId}')`), []);
    const h = w.ok(w.students[0].email, 'attend.history'); assert.equal(h.totals.autoSignOuts, 1);
    assert.equal(w.ok(w.students[0].email, 'attend.events', { sessionId: w.sid }).events.at(-1).method, 'auto');
  }
});

test('open-lab closure: early manual close uses actual time and only exits the current visit', () => {
  const w = openLabVisit(2); w.enter(0); w.enter(1); w.setClock('11:00');
  assert.equal(w.checkin(w.students[0], { sessionId: w.sid, action: 'out' }).ok, true);
  w.setClock('11:30'); w.enter(0); w.setClock('12:00');
  w.ok(w.admin, 'sessions.close', { sessionId: w.sid, reason: 'Maintenance' });
  assert.equal(w.exits().length, 2); assert.ok(w.exits().every((e) => e.at === w.eval('U.now()')));
  assert.equal(w.summary(0).verifiedMinutes, 90); assert.equal(w.summary(1).verifiedMinutes, 120);
  assert.equal(w.closeAudit()[0].actor, w.admin);
});

test('open-lab closure: scanned departures stay normal and a last-second entry bypasses the scan gap', () => {
  const w = openLabVisit(2); w.enter(0); w.setClock('11:00');
  assert.equal(w.checkin(w.students[0], { sessionId: w.sid, action: 'out' }).ok, true);
  w.setClock('18:59'); w.enter(1); w.setClock('19:00'); w.eval('Sessions.autoCloseStale()');
  assert.equal(w.exits().length, 1); assert.equal(w.summary(0).verifiedMinutes, 60);
  assert.ok(!w.summary(0).flags.includes('auto_out')); assert.equal(w.summary(1).verifiedMinutes, 1);
});

test('open-lab closure: arrival reads and history recover a delayed trigger', () => {
  for (const route of ['sessions.mine', 'attend.history']) {
    const w = openLabVisit(); w.enter(); w.setClock('19:05');
    w.ok(w.students[0].email, route); assert.equal(w.exits().length, 1); assert.equal(w.summary().verifiedMinutes, 540);
  }
});

test('open-lab closure: late scanner submission cannot append an additional departure', async () => {
  const w = openLabVisit(); const s = w.students[0]; await w.registerDevice(s); w.enter();
  w.setClock('18:59'); const qr = await w.qr(s, w.sid, 'out'); w.setClock('19:00');
  assert.equal(w.scan(await w.sign(qr.split('~')[0], w.devices[s.studentId])).error.code, 'OUT_OF_WINDOW');
  assert.equal(w.exits().length, 1);
  assert.equal(w.eval(`Db.whereEq('AttendanceEvents',{sessionId:'${w.sid}',type:'OUT'}).length`), 1);
});

// Fail both before a write and after its durable append/update: retries must recover the actual
// sheet state, including a session already marked closed and a partially rebuilt summary.
for (const stage of ['event', 'session', 'audit', 'summary', 'flags', 'complete']) {
  for (const after of [false, true]) test(`open-lab closure recovery: ${stage}, failure ${after ? 'after' : 'before'} write`, () => {
    const w = openLabVisit(2); w.enter(0); w.enter(1); w.setClock('19:05');
    w.e.run(`
      var originalInsert = Db.insert, originalUpdate = Db.update, originalMany = Db.insertMany, originalFlags = Flags.afterClose, fired = false;
      function inject(kind, table, record, fn) {
        var match = !fired && (
          ('${stage}'==='event' && kind==='insert' && table==='AttendanceEvents' && record.method==='auto') ||
          ('${stage}'==='session' && kind==='update' && table==='Sessions' && record.status==='closed') ||
          ('${stage}'==='audit' && kind==='insert' && table==='AuditEvents' && record.action==='session.close') ||
          ('${stage}'==='summary' && kind==='many' && table==='AttendanceSummaries') ||
          ('${stage}'==='complete' && kind==='update' && table==='JobRuns' && record.status==='ok') ||
          ('${stage}'==='flags' && kind==='flags'));
        if (match) { fired=true; if (${after}) fn(); throw new Error('Injected close interruption'); }
        return fn();
      }
      Db.insert = function(t,r){return inject('insert',t,r,function(){return originalInsert(t,r);});};
      Db.insertMany = function(t,r){return inject('many',t,r,function(){return originalMany(t,r);});};
      Db.update = function(t,id,r){return inject('update',t,r,function(){return originalUpdate(t,id,r);});};
      Flags.afterClose = function(s){return inject('flags','',{},function(){return originalFlags(s);});};
    `);
    assert.equal(w.eval('Sessions.autoCloseStale()').failed, 1); assert.equal(w.eval('fired'), true);
    w.e.run('Db.insert=originalInsert;Db.update=originalUpdate;Db.insertMany=originalMany;Flags.afterClose=originalFlags;');
    w.eval('Sessions.autoCloseStale()');
    assert.equal(w.exits().length, 2); assert.equal(w.closeAudit().length, 1);
    for (let i = 0; i < 2; i++) { assert.equal(w.summary(i).verifiedMinutes, 540); assert.ok(w.summary(i).flags.includes('auto_out')); }
    assert.equal(w.eval(`Db.get('JobRuns',Sessions._closeRunId('${w.sid}')).status`), 'ok');
    assert.equal(w.eval('Audit.verify().ok'), true);
  });
}

test('open-lab closure: an interrupted early close is resumed before any new entry', () => {
  const w = openLabVisit(2); w.enter(); w.setClock('11:00');
  w.e.run("var savedFlags=Flags.afterClose; Flags.afterClose=function(){throw new Error('Interrupted');};");
  assert.equal(w.call(w.admin, 'sessions.close', { sessionId: w.sid }).ok, false);
  w.e.run('Flags.afterClose=savedFlags;'); w.setClock('11:30');
  const result = w.checkin(w.students[1], { sessionId: w.sid });
  assert.equal(result.ok, false); assert.equal(w.exits().length, 1); assert.equal(w.summary().verifiedMinutes, 60);
  assert.equal(w.eval(`Db.get('JobRuns',Sessions._closeRunId('${w.sid}')).status`), 'ok');
});

test('open-lab closure: auto-outs and class missed exits share the repeated missed-exit detector', () => {
  const w = openLabVisit(); w.enter(); w.setClock('19:00'); w.eval('Sessions.autoCloseStale()');
  const sid = w.students[0].studentId;
  w.e.run(`
    ['one','two'].forEach(function(n){
      var id=U.id('session');
      Db.insert('Sessions',{sessionId:id,type:'class',labId:'${w.lab.labId}',status:'closed',closedAt:U.now()-86400000,scheduledStart:U.now()-90000000});
      Db.insert('AttendanceSummaries',{sumId:id+':${sid}',sessionId:id,studentId:'${sid}',status:'unverified_exit',flags:['unverified_exit']});
    });
    Flags.afterClose(Db.get('Sessions','${w.sid}')); Flags.afterClose(Db.get('Sessions','${w.sid}'));
  `);
  const flags = w.eval("Db.whereEq('Flags',{type:'never_scans_out'})");
  assert.equal(flags.length, 1); assert.equal(flags[0].detail.missedExitsLast30Days, 3);
});

test('open-lab closure: three actual automatic departures raise one repeated missed-exit flag', () => {
  const w = openLabVisit();
  for (const date of ['2026-10-14', '2026-10-15', '2026-10-16']) {
    w.e.setTime(w.eval(`U.fromLocal('${date}','18:00')`));
    w.eval(`Sessions._openLabsDue('${date}')`);
    w.sid = w.eval(`Db.whereEq('Sessions',{date:'${date}',type:'openlab'})[0].sessionId`);
    w.enter(); w.e.setTime(w.eval(`U.fromLocal('${date}','19:00')`)); w.eval('Sessions.autoCloseStale()');
    assert.equal(w.eval("Db.whereEq('Flags',{type:'never_scans_out'}).length"), date === '2026-10-16' ? 1 : 0);
  }
  w.eval('Sessions.autoCloseStale()');
  assert.equal(w.eval("Db.whereEq('Flags',{type:'never_scans_out'})[0].detail.missedExitsLast30Days"), 3);
});

test('open-lab closure: work changes do not shorten credit and a workstation is released', () => {
  const w = openLabVisit(), s = w.students[0]; w.enter();
  const category = w.ok(w.staff, 'categories.upsert', { name: 'Test systems', trackingMode: 'individual', workstation: true }).category;
  const asset = w.ok(w.staff, 'assets.upsert', { labId: w.lab.labId, categoryId: category.categoryId, name: 'Closing system', assetTag: 'CLOSE-SYSTEM' }).asset;
  w.setClock('18:00');
  const state = w.ok(s.email, 'sessions.mine').sessions.find((x) => x.sessionId === w.sid).mine.work;
  w.ok(s.email, 'attend.setWork', { sessionId: w.sid, entryEventId: state.entryEventId, expectedEventId: state.eventId, projectId: state.projectId, assetId: asset.assetId });
  assert.equal(w.eval(`Work.occupants('${w.lab.labId}').length`), 1);
  w.setClock('19:00'); w.eval('Sessions.autoCloseStale()');
  assert.equal(w.summary().verifiedMinutes, 540);
  assert.deepEqual(w.eval(`Work.occupants('${w.lab.labId}')`), []);
  const effective = w.eval(`Attend._effective(Attend._eventsFor(Db.get('Sessions','${w.sid}')))`);
  assert.equal(w.eval(`Work.current(${JSON.stringify(effective[s.studentId])})`), null);
});

// ---------------------------------------------------------------------------------------------------------------------------
// A3: nightly backup copies of the spreadsheet, with rotation.
const backups = (w) => w.ok(w.admin, 'system.backups').backups;
const night = (w) => { const r = w.e.run('Backup.nightly()'); w.advance(86400000); return r; };

test('backup: 45 simulated nights leave 30 daily copies plus the first copy of the older month', () => {
  const w = world({ students: 0 });
  for (let i = 0; i < 45; i++) night(w);
  const list = backups(w);
  assert.equal(list.length, 31);
  assert.equal(list.filter((b) => b.keeps === 'daily').length, 30);
  const monthly = list.filter((b) => b.keeps === 'monthly');
  assert.equal(monthly.length, 1);
  assert.equal(monthly[0].date, '2026-10-14', 'the first copy of October outlives the daily window');
  assert.equal(w.e.trashed.length, 14, 'the 14 copies in between went to the bin');
  assert.equal(list[0].date, '2026-11-27', 'newest first');
  assert.equal(list.filter((b) => b.name === 'LABFLOW backup 2026-11-27').length, 1);
});

test('backup: the copy is of the live database, goes to a private Drive folder, and a second run the same day adds nothing', () => {
  const w = world({ students: 0 });
  const first = w.e.run('Backup.nightly()'), again = w.e.run('Backup.nightly()');
  assert.equal(first.created, 'LABFLOW backup 2026-10-14');
  assert.equal(again.created, null); assert.equal(again.alreadyDone, true);
  const dbId = w.eval('PropertiesService.getScriptProperties().getProperty(Cfg.PROP.DB_ID)');
  const folder = Object.values(w.e.folders).find((f) => f.name === 'LABFLOW Backups');
  assert.equal(folder.files.length, 1);
  assert.equal(folder.files[0].copyOf, dbId);
});

test('backup: rotation only touches our own backup files', () => {
  const w = world({ students: 0 });
  w.e.run('Backup.nightly()');
  const folder = Object.values(w.e.folders).find((f) => f.name === 'LABFLOW Backups');
  folder.createFile('notes.txt', 'keep me'); folder.createFile('LABFLOW backup old copy', 'keep me too');
  w.advance(86400000);
  for (let i = 0; i < 40; i++) night(w);
  const names = folder.files.filter((f) => !f.trashed).map((f) => f.name);
  assert.ok(names.includes('notes.txt') && names.includes('LABFLOW backup old copy'));
});

test('backup: the monthly rule keeps the first copy of each of the last 12 months and drops older ones', () => {
  const w = world({ students: 0 });
  const r = JSON.parse(w.e.run(`JSON.stringify((function () {
    var es = [], d = '2025-08-01';
    for (var i = 0; i < 447; i++, d = U.addDays(d, 1)) es.push({ id: 'f' + i, date: d, createdAt: i });
    var plan = Backup._plan(es, '2026-10-21');
    var kept = es.filter(function (e) { return plan.keep[e.id]; });
    return { kept: kept.length, daily: kept.filter(function (e) { return plan.keep[e.id] === 'daily'; }).length,
             monthly: kept.filter(function (e) { return plan.keep[e.id] === 'monthly'; }).map(function (e) { return e.date; }) };
  })())`));
  assert.equal(r.daily, 30);
  assert.equal(r.monthly.length, 11, 'October is inside the daily window, so 11 more months are kept on their own');
  assert.equal(r.monthly[0], '2025-11-01'); assert.equal(r.monthly[10], '2026-09-01');
  assert.ok(!r.monthly.includes('2025-10-01') && !r.monthly.includes('2025-08-01'), 'older than 12 months goes');
});

test('backup: a manual backup is audited, listed, admin-only, and does not clash with the nightly copy', () => {
  const w = world({ students: 0 });
  const made = w.ok(w.admin, 'system.backup');
  assert.match(made.created, /^LABFLOW backup 2026-10-14 \(manual \d{6}\)$/);
  assert.equal(made.backups.length, 1); assert.equal(made.backups[0].manual, true);
  assert.ok(w.eval("Db.readAll('AuditEvents')").some((a) => a.action === 'backup.manual' && a.actor === w.admin));
  assert.equal(w.err(w.staff, 'system.backup').code, 'FORBIDDEN');
  assert.equal(w.err(w.staff, 'system.backups').code, 'FORBIDDEN');
  const nightlyToo = w.e.run('Backup.nightly()');
  assert.equal(nightlyToo.created, 'LABFLOW backup 2026-10-14');
  assert.equal(backups(w).length, 2);
});

test('backup: a failed copy keeps every older backup, tells the admin, and does not stop the rest of the nightly job', () => {
  const w = world({ students: 0 });
  for (let i = 0; i < 3; i++) night(w);
  w.e.run("DriveApp.getFileById = function () { throw new Error('Drive is down'); };");
  const r = JSON.parse(w.e.run('JSON.stringify(Jobs.nightly())'));
  assert.equal(r.status, 'ok');
  assert.match(r.detail.backup.error, /Drive is down/);
  assert.ok(r.detail.auditCheckpoint !== undefined, 'later steps still ran');
  assert.equal(backups(w).length, 3, 'nothing was rotated away');
  assert.ok(w.eval("Db.readAll('Notifications')").some((n) => n.title === 'Nightly backup failed'));
});

test('backup: the nightly job runs the backup step after everything else and the job log shows it', () => {
  const w = world({ students: 0 });
  const r = JSON.parse(w.e.run('JSON.stringify(Jobs.nightly())'));
  assert.equal(r.status, 'ok', JSON.stringify(r));
  assert.equal(r.detail.backup.created, 'LABFLOW backup 2026-10-14');
  assert.deepEqual(Object.keys(r.detail).slice(-2), ['backup', 'archive'], 'the backup comes right before the archive step');
  assert.equal(r.detail.archive.skipped, 'not July');
  assert.equal(backups(w).length, 1);
});
