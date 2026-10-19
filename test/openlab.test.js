const test = require('node:test');
const assert = require('node:assert/strict');
const { world } = require('./fixtures');

function enable(w, extra = {}) {
  w.lab = w.ok(w.admin, 'labs.upsert', { ...w.lab, openLab: true, ...extra }).lab;
  return w.lab;
}
const setTime = (w, time, date = w.today) => w.e.setTime(w.eval(`U.fromLocal(${JSON.stringify(date)}, ${JSON.stringify(time)})`));
const sessions = (w) => w.eval("Db.readAll('Sessions').filter(function(s){return s.type==='openlab';})");
const mine = (w, student = w.students[0]) => w.ok(student.email, 'sessions.mine').sessions.filter((s) => s.type === 'openlab');
const open = (w) => { enable(w); w.eval('Sessions.autoOpenDue()'); return sessions(w)[0]; };

test('open lab: opt-in requires hours and preserves an omitted flag on later lab edits', () => {
  const w = world();
  assert.equal(w.lab.openLab, false);
  assert.equal(w.err(w.admin, 'labs.upsert', { ...w.lab2, openLab: true }).code, 'BAD_INPUT');
  enable(w);
  const { openLab, ...withoutFlag } = w.lab;
  assert.equal(w.ok(w.admin, 'labs.upsert', withoutFlag).lab.openLab, true);
  assert.equal(w.err(w.admin, 'labs.upsert', { ...w.lab, openTime: '', closeTime: '' }).code, 'BAD_INPUT');
});

test('open lab: materialization is unique per lab/date and excludes inactive, disabled and invalid labs', () => {
  const w = world(); enable(w);
  assert.equal(w.eval(`Sessions.materializeOpenLab('${w.today}')`), 1);
  assert.equal(w.eval(`Sessions.materializeOpenLab('${w.today}')`), 0);
  assert.equal(w.eval("Sessions.materializeOpenLab('2026-10-15')"), 1);
  const [s] = sessions(w);
  assert.equal(s.slotKey, 'open|' + w.lab.labId + '|' + w.today);
  assert.equal(s.openToAll, true); assert.equal(s.rescanMode, 'off'); assert.equal(s.facultyId, '');
  w.e.run(`Db.update('Labs', '${w.lab.labId}', {status:'inactive'})`);
  assert.equal(w.eval("Sessions.materializeOpenLab('2026-10-16')"), 0);
  w.e.run(`Db.update('Labs', '${w.lab.labId}', {status:'active', closeTime:'07:00'})`);
  assert.equal(w.eval("Sessions.materializeOpenLab('2026-10-16')"), 0);
  assert.equal(w.err(w.admin, 'sessions.day', { date: '2026-02-30' }).code, 'BAD_INPUT');
});

test('open lab: opening is exact, automatic and independent of the class auto-open switch', () => {
  const w = world(); enable(w); setTime(w, '07:59');
  w.ok(w.admin, 'settings.set', { values: { autoOpenSessions: false } });
  assert.equal(w.eval('Sessions.autoOpenDue()').opened, 0);
  assert.equal(mine(w).length, 0);
  const s = sessions(w)[0];
  assert.equal(w.err(w.admin, 'sessions.open', { sessionId: s.sessionId, override: true }).code, 'OUT_OF_WINDOW');
  setTime(w, '08:00');
  const r = w.eval('Sessions.autoOpenDue()');
  assert.equal(r.opened, 1); assert.equal(r.disabled, true); assert.equal(r.openLabsOpened, 1);
  assert.equal(mine(w).length, 1);
  assert.equal(w.eval('Sessions.autoOpenDue()').opened, 0);
});

test('open lab: student and kiosk arrival screens recover a delayed opening trigger', () => {
  const w = world(); enable(w); setTime(w, '15:00');
  assert.equal(sessions(w).length, 0);
  const op = w.ok(w.students[0].email, 'checkin.open', { code: w.kioskCode() });
  assert.equal(op.candidates[0].reason, 'openlab'); assert.equal(op.prefill, sessions(w)[0].sessionId);
  assert.equal(mine(w)[0].status, 'open');
  assert.equal(sessions(w).length, 1);
});

test('open lab: a verified walk-in needs neither a booking nor a course roster and records openlab reason', () => {
  const w = world(); enable(w); setTime(w, '15:00');
  w.e.run("Db.readAll('Rosters').forEach(function(r){Db.update('Rosters',r.rosterId,{status:'removed'});}); Roster._bump();");
  const [s] = w.students, r = w.checkin(s, { reason: 'openlab' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const ev = w.eval("Db.readAll('AttendanceEvents')[0]");
  assert.equal(ev.entryReason, 'openlab'); assert.equal(ev.geofence, 'pass');
  assert.equal(w.eval("Db.readAll('Reservations').length"), 0);
  assert.equal(w.ok(s.email, 'labs.occupancy').labs.find((l) => l.labId === w.lab.labId).inside, 1);
  w.advance(150000); assert.equal(w.checkin(s, { action: 'out' }).ok, true);
});

test('open lab: opening it before the class does not block timetable auto-open or class prefill', () => {
  const w = world(); enable(w); setTime(w, '08:00');
  assert.equal(w.eval('Sessions.autoOpenDue()').openLabsOpened, 1);
  setTime(w, '10:00'); assert.equal(w.eval('Sessions.autoOpenDue()').opened, 1);
  const op = w.ok(w.students[0].email, 'checkin.open', { code: w.kioskCode() });
  assert.deepEqual(op.candidates.map((c) => c.reason), ['class', 'openlab']);
  assert.equal(op.prefill, op.candidates[0].sessionId);
  const s = w.ok(w.admin, 'sessions.day').sessions;
  assert.equal(s.filter((x) => x.status === 'open').length, 2);
  assert.equal(w.checkin(w.students[0], { reason: 'class' }).ok, true);
});

test('open lab: manual class opening and conflict checks exempt openlab but still protect classes/events', () => {
  const w = world(); enable(w); const s = mine(w)[0];
  const cls = w.ok(w.faculty, 'sessions.day').sessions.find((x) => x.type === 'class');
  assert.equal(w.ok(w.faculty, 'sessions.open', { sessionId: cls.sessionId }).session.status, 'open');
  assert.equal(w.err(w.faculty, 'sessions.create', { type: 'event', labId: w.lab.labId, title: 'Conflicting event', date: w.today, startTime: '10:00', endTime: '11:00' }).code, 'CONFLICT');
  assert.equal(w.ok(w.faculty, 'sessions.create', { type: 'event', labId: w.lab.labId, title: 'Afternoon event', date: w.today, startTime: '15:00', endTime: '16:00' }).session.type, 'event');
  assert.equal(w.ok(w.admin, 'sessions.get', { sessionId: s.sessionId }).session.status, 'open');
});

test('open lab: it also opens when a class is already running and manual opening keeps rescans off', () => {
  const w = world(), cls = w.session();
  w.ok(w.faculty, 'sessions.open', { sessionId: cls.sessionId }); enable(w);
  w.eval(`Sessions.materializeOpenLab('${w.today}')`);
  const s = sessions(w)[0];
  const r = w.ok(w.admin, 'sessions.open', { sessionId: s.sessionId, rescanMode: 'random' }).session;
  assert.equal(r.status, 'open'); assert.equal(r.rescanMode, 'off'); assert.equal(r.nextRescanAt, null);
});

test('open lab: new entries stop at closing even when the session-close trigger is delayed', () => {
  const w = world(), s = open(w); setTime(w, '18:59');
  const op = w.ok(w.students[0].email, 'checkin.open', { code: w.kioskCode() });
  setTime(w, '19:00');
  assert.equal(w.err(w.students[0].email, 'checkin.submit', { pass: op.pass, action: 'in', sessionId: s.sessionId, reason: 'openlab', geo: w.at(1) }).code, 'OUT_OF_WINDOW');
  assert.equal(mine(w).length, 0);
  const after = w.ok(w.students[1].email, 'checkin.open', { code: w.kioskCode() });
  assert.equal(after.candidates.filter((c) => c.reason === 'openlab').length, 0);
  assert.equal(w.eval("Db.readAll('AttendanceEvents').length"), 0);
});

test('open lab: disabling it after issuing a pass prevents entry but still permits an existing visitor to exit', () => {
  const w = world(), s = open(w), [a, b] = w.students;
  assert.equal(w.checkin(a, { sessionId: s.sessionId, reason: 'openlab' }).ok, true);
  const op = w.ok(b.email, 'checkin.open', { code: w.kioskCode() });
  enable(w, { openLab: false });
  assert.equal(w.err(b.email, 'checkin.submit', { pass: op.pass, action: 'in', sessionId: s.sessionId, geo: w.at(1) }).code, 'OUT_OF_WINDOW');
  w.advance(150000); assert.equal(w.checkin(a, { action: 'out' }).ok, true);
});

test('open lab: Version B uses the same hours gate and accepts a normal device scan during opening hours', async () => {
  const w = world(), [a, b] = w.students, s = open(w);
  await w.registerDevice(a); await w.registerDevice(b);
  assert.equal(w.scan(await w.qr(a, s.sessionId, 'in')).ok, true);
  setTime(w, '18:59'); const qr = await w.qr(b, s.sessionId, 'in');
  setTime(w, '19:00');
  const result = w.scan(await w.sign(qr.split('~')[0], w.devices[b.studentId]));
  assert.equal(result.error.code, 'OUT_OF_WINDOW', JSON.stringify(result));
});

test('open lab: closed or cancelled daily sessions are not recreated or reopened by arrival reads', () => {
  const w = world(), s = open(w);
  w.ok(w.admin, 'sessions.close', { sessionId: s.sessionId });
  assert.equal(mine(w).length, 0);
  assert.equal(w.eval('Sessions.autoOpenDue()').openLabsOpened, 0);
  assert.equal(sessions(w).length, 1);
  w.eval("Sessions.materializeOpenLab('2026-10-15')");
  const tomorrow = sessions(w).find((r) => r.date === '2026-10-15');
  w.ok(w.admin, 'sessions.cancel', { sessionId: tomorrow.sessionId, reason: 'Closed for maintenance' });
  setTime(w, '10:00', '2026-10-15');
  assert.equal(mine(w).length, 0);
  assert.equal(sessions(w).find((r) => r.sessionId === tomorrow.sessionId).status, 'cancelled');
});

test('open lab: nightly creates three days once and a failing class step does not stop it', () => {
  const w = world(); enable(w);
  w.e.run("Sessions.materialize = function(){throw new Error('class failure');};");
  const r = w.eval('Jobs.nightly()');
  assert.match(r.detail.materialize.error, /class failure/);
  assert.deepEqual(r.detail.materializeOpenLab, [1, 1, 1]);
  assert.equal(sessions(w).length, 3);
  w.e.run("CacheService.getScriptCache().remove('job|nightly')");
  assert.deepEqual(w.eval('Jobs.nightly()').detail.materializeOpenLab, [0, 0, 0]);
});

test('open lab: hour edits update future scheduled sessions without rewriting an active visit', () => {
  const w = world(), s = open(w);
  w.eval("Sessions.materializeOpenLab('2026-10-15')");
  enable(w, { openTime: '09:00', closeTime: '18:00' });
  w.eval("Sessions.materializeOpenLab('2026-10-15')");
  const future = sessions(w).find((r) => r.date === '2026-10-15');
  assert.equal(future.scheduledStart, w.eval("U.fromLocal('2026-10-15','09:00')"));
  assert.equal(future.scheduledEnd, w.eval("U.fromLocal('2026-10-15','18:00')"));
  assert.equal(sessions(w).find((r) => r.sessionId === s.sessionId).scheduledEnd, s.scheduledEnd);
});

test('open lab: monthly audit separates walk-in hours from research and class usage', () => {
  const w = world(), s = open(w);
  assert.equal(w.checkin(w.students[0], { sessionId: s.sessionId, reason: 'openlab' }).ok, true);
  w.advance(3600000); assert.equal(w.checkin(w.students[0], { action: 'out' }).ok, true);
  w.ok(w.admin, 'sessions.close', { sessionId: s.sessionId });
  const report = w.ok(w.admin, 'reports.run', { type: 'monthlyAudit', month: '2026-10' });
  const row = report.sections[0].rows.find((r) => r[0] === 'Open lab');
  assert.ok(row); assert.equal(row[3], 1); assert.equal(row[5], 1);
  assert.equal(report.sections[0].rows.some((r) => r[0] === 'Research and self-work'), false);
});

test('open lab: a failing open-lab trigger step does not prevent regular timetable opening', () => {
  const w = world(); enable(w);
  const cls = w.session();
  w.e.run("Sessions._openLabsDue = function(){throw new Error('open-lab failure');};");
  const r = w.eval('Jobs.tickSessions()');
  assert.equal(r.detail.autoOpen.openLabsFailed, 1);
  assert.equal(r.detail.autoOpen.opened, 1);
  assert.equal(w.ok(w.faculty, 'sessions.get', { sessionId: cls.sessionId }).session.status, 'open');
  assert.ok(w.eval("Db.readAll('SystemLog')").some((r) => r.code === 'OPEN_LAB_AUTO_OPEN_FAILED'));
});
