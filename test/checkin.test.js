// Version A: kiosk QR + GPS geofence (the functional requirements' check-in).
const test = require('node:test');
const assert = require('node:assert/strict');
const { world, LAB_B } = require('./fixtures');

function ready(n = 3, opts = {}) {
  const w = world(Object.assign({ students: n }, opts));
  w.sid = w.session().sessionId;
  w.ok(w.faculty, 'sessions.open', { sessionId: w.sid });
  return w;
}

test('kiosk display: rotating code + link; the code changes every interval (FR-7)', () => {
  const w = ready(0);
  const d = w.ok(w.kioskEmail, 'kiosk.display');
  assert.equal(d.mode, 'AB'); assert.equal(d.interval, 7);
  assert.match(d.code, /^k1\.KSK-[0-9A-F]{12}\.\d+\.[A-Za-z0-9_-]{16}$/);
  assert.equal(d.url, 'https://script.google.com/a/macros/karunya.edu/s/TESTDEPLOYMENT/exec?k=' + encodeURIComponent(d.code));
  assert.equal(d.lab.code, 'IOT01');
  w.advance(7000);
  assert.notEqual(w.ok(w.kioskEmail, 'kiosk.display').code, d.code, 'rotated');
  assert.equal(w.err(w.students.length ? w.students[0].email : w.faculty, 'kiosk.display').code, 'FORBIDDEN');
});

test('happy path: scan kiosk QR, page opens with a 2-minute pass, GPS inside the geofence, IN; later OUT', () => {
  const w = ready(1); const [s] = w.students;
  const code = w.kioskCode();
  const op = w.ok(s.email, 'checkin.open', { code });
  assert.deepEqual(op.actions, ['in']);
  assert.equal(op.prefill, w.sid, 'timetabled class is pre-filled (FR-14)');
  assert.equal(op.candidates[0].reason, 'class');
  assert.equal(op.passExpiresAt - op.serverNow, 120000, 'FR-9: two minutes to finish');
  const geo = w.at(5, 12);
  const r = w.ok(s.email, 'checkin.submit', { pass: op.pass, action: 'in', sessionId: w.sid, reason: 'class', geo });
  assert.equal(r.type, 'IN'); assert.equal(r.mode, 'A'); assert.equal(r.method, 'kiosk'); assert.equal(r.geofence, 'pass'); assert.equal(r.assurance, 'standard');
  const ev = w.eval("Db.readAll('AttendanceEvents').filter(function(e){return e.type==='IN';})[0]");
  assert.equal(ev.entryReason, 'class'); assert.equal(ev.geofence, 'pass');
  assert.ok(ev.distanceM > 4 && ev.distanceM < 6, 'distance stored to 0.1 m'); assert.equal(ev.accuracyM, 12);
  // FR-31: no coordinates anywhere in the database or the audit log
  const dump = JSON.stringify(w.eval("Object.keys(Cfg.SCHEMA).map(function(t){return Db.readAll(t);})"));
  assert.ok(dump.indexOf(String(geo.lat).slice(0, 9)) < 0, 'the phone latitude is not stored anywhere');
  assert.ok(!/"lat"|"lng"/.test(dump));
  // live occupancy moves (FR-16)
  assert.equal(w.ok(s.email, 'labs.occupancy').labs.find((l) => l.code === 'IOT01').inside, 1);
  // check-out with the next kiosk code
  w.advance(5 * 60000);
  const op2 = w.ok(s.email, 'checkin.open', { code: w.kioskCode() });
  assert.deepEqual(op2.actions, ['out']); assert.equal(op2.inside.sessionId, w.sid);
  assert.equal(w.ok(s.email, 'checkin.submit', { pass: op2.pass, action: 'out', geo: w.at(2, 8) }).type, 'OUT');
  assert.equal(w.ok(s.email, 'labs.occupancy').labs.find((l) => l.code === 'IOT01').inside, 0);
});

test('one code serves the whole class but each student only once (FR-10)', () => {
  const w = ready(3); const code = w.kioskCode();
  for (const s of w.students) assert.equal(w.checkin(s, { code }).ok, true, s.email);
  w.advance(150 * 1000);
  const again = w.call(w.students[0].email, 'checkin.open', { code });
  assert.ok(['REPLAY', 'CODE_EXPIRED'].includes(again.error.code));
  // the same student re-submitting a pass for an already used code (within the code age) is refused
  const w2 = ready(1); const [s] = w2.students; const c2 = w2.kioskCode();
  const op = w2.ok(s.email, 'checkin.open', { code: c2 });
  assert.equal(w2.call(s.email, 'checkin.submit', { pass: op.pass, action: 'in', sessionId: w2.sid, geo: w2.at(1) }).ok, true);
  w2.advance(130 * 1000);
  const op2 = w2.ok(s.email, 'checkin.open', { code: w2.kioskCode() });
  assert.equal(w2.call(s.email, 'checkin.submit', { pass: op.pass, action: 'out', geo: w2.at(1) }).error.code, 'PASS_EXPIRED', 'old pass expired');
  assert.equal(w2.call(s.email, 'checkin.submit', { pass: op2.pass, action: 'out', geo: w2.at(1) }).ok, true);
});

test('code age, pass expiry, forged and foreign codes', () => {
  const w = ready(2); const [a, b] = w.students;
  const code = w.kioskCode();
  w.advance(45 * 1000); // shown for 7 s + 30 s allowance
  assert.equal(w.err(a.email, 'checkin.open', { code }).code, 'CODE_EXPIRED');
  const fresh = w.kioskCode();
  const forged = fresh.slice(0, -4) + (fresh.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
  assert.equal(w.err(a.email, 'checkin.open', { code: forged }).code, 'BAD_CODE');
  assert.equal(w.err(a.email, 'checkin.open', { code: 'hello' }).code, 'BAD_CODE');
  assert.equal(w.ok(a.email, 'checkin.open', { code: 'https://x.example/exec?k=' + fresh }).lab.code, 'IOT01', 'the full link is accepted');
  // pass bound to the student who opened it
  const op = w.ok(a.email, 'checkin.open', { code: fresh });
  assert.equal(w.err(b.email, 'checkin.submit', { pass: op.pass, action: 'in', sessionId: w.sid, geo: w.at(1) }).code, 'BAD_PASS');
  // two minutes to finish
  w.advance(121 * 1000);
  assert.equal(w.err(a.email, 'checkin.submit', { pass: op.pass, action: 'in', sessionId: w.sid, geo: w.at(1) }).code, 'PASS_EXPIRED');
  // tampered pass
  const op2 = w.ok(a.email, 'checkin.open', { code: w.kioskCode() });
  const bad = op2.pass.replace(a.studentId, b.studentId);
  assert.equal(w.err(a.email, 'checkin.submit', { pass: bad, action: 'in', sessionId: w.sid, geo: w.at(1) }).code, 'BAD_TOKEN');
  // staff/faculty cannot use the student flow
  assert.equal(w.err(w.faculty, 'checkin.open', { code: w.kioskCode() }).code, 'FORBIDDEN');
});

test('geofence: outside is recorded and flagged, never refused; accuracy allowance factored in (FR-11/12), no coordinates stored', () => {
  const w = ready(4); const [a, b, c, d] = w.students;
  const far = w.checkin(a, { geo: w.at(200, 15) });
  assert.equal(far.ok, true); assert.equal(far.data.geofence, 'fail'); assert.equal(far.data.assurance, 'flagged');
  // 40 m away with 30 m reported accuracy: 40 - min(30, 30) = 10 <= 20 -> inside
  assert.equal(w.checkin(b, { geo: w.at(40, 30) }).data.geofence, 'pass', 'indoor GPS error forgiven');
  // 40 m away with 5 m accuracy: 35 > 20 -> outside
  assert.equal(w.checkin(c, { geo: w.at(40, 5) }).data.geofence, 'fail');
  // the allowance is capped: 200 m accuracy does not let someone 120 m away in
  assert.equal(w.checkin(d, { geo: w.at(120, 200) }).data.geofence, 'fail');
  const flags = w.ok(w.faculty, 'flags.list', {}).flags;
  assert.ok(flags.some((f) => f.type === 'outside_geofence' && f.studentId === a.studentId && f.detail.band === '100-500m'));
  // a flagged check-in is never counted as present until the faculty decide
  const roster = w.ok(w.faculty, 'attend.roster', { sessionId: w.sid }).roster, row = (s) => roster.find((x) => x.studentId === s.studentId);
  assert.equal(row(a).status, 'flagged'); assert.ok(row(a).flags.includes('location_flagged'));
  assert.equal(row(b).status, 'present');
  w.ok(w.faculty, 'attend.override', { sessionId: w.sid, studentId: a.studentId, outcome: 'present', reason: 'Seen in the room' });
  const after = w.ok(w.faculty, 'attend.roster', { sessionId: w.sid }).roster.find((x) => x.studentId === a.studentId);
  assert.equal(after.status, 'present'); assert.equal(after.overridden, true);
  assert.ok(w.eval("Db.readAll('AuditEvents')").some((e) => e.action === 'attend.override'));
  const audit = JSON.stringify(w.eval("Db.readAll('AuditEvents')"));
  assert.ok(audit.indexOf(String(w.at(200, 15).lat).slice(0, 8)) < 0, 'coordinates never reach the audit log');
});

test('mock-location heuristics: impossible accuracy recorded and flagged, not refused; identical readings flagged (FR-30)', () => {
  const w = ready(2); const [a, b] = w.students;
  const spoof = w.checkin(a, { geo: w.at(1, 0.5) });
  assert.equal(spoof.ok, true); assert.equal(spoof.data.assurance, 'flagged');
  assert.ok(w.ok(w.staff, 'flags.list', {}).flags.some((f) => f.type === 'implausible_location' && f.severity === 'high'));
  // the same exact reading in two different sessions
  assert.equal(w.checkin(b, { geo: w.at(7.25, 6.5) }).ok, true);
  const ev = w.ok(w.admin, 'events.create', { name: 'IoT clinic', labId: w.lab.labId, date: w.today, startTime: '12:30', endTime: '13:30', openToAll: true, facultyId: w.facultyId });
  w.advance(150 * 60000);
  w.ok(w.faculty, 'sessions.close', { sessionId: w.sid });
  w.ok(w.admin, 'sessions.open', { sessionId: ev.event.sessionId });
  assert.equal(w.checkin(b, { action: 'in', sessionId: ev.event.sessionId, reason: 'event', geo: w.at(7.25, 6.5) }).ok, true);
  assert.ok(w.ok(w.staff, 'flags.list', {}).flags.some((f) => f.type === 'identical_reading' && f.studentId === b.studentId));
});

test('location unavailable: accepted as lower assurance with a flag, or refused by policy (SRS 6.4)', () => {
  const w = ready(2); const [a, b] = w.students;
  const r = w.checkin(a, { geo: null });
  assert.equal(r.ok, true); assert.equal(r.data.geofence, 'na'); assert.equal(r.data.assurance, 'lower');
  assert.ok(w.ok(w.faculty, 'flags.list', {}).flags.some((f) => f.type === 'no_location'));
  w.ok(w.admin, 'settings.set', { values: { geoUnavailablePolicy: 'reject' } });
  assert.equal(w.checkin(b, { geo: null }).error.code, 'NO_LOCATION');
});

test('minimum gap stops an accidental double scan from checking out (FR-15)', () => {
  const w = ready(1); const [s] = w.students;
  assert.equal(w.checkin(s).ok, true);
  w.advance(20 * 1000);
  const r = w.checkin(s);
  assert.equal(r.error.code, 'TOO_SOON');
  w.advance(110 * 1000);
  assert.equal(w.checkin(s).data.type, 'OUT');
});

test('rescan windows work through the kiosk QR too', () => {
  const w = ready(1); const [s] = w.students;
  w.checkin(s);
  w.advance(10 * 60000);
  w.ok(w.faculty, 'attend.openRescan', { sessionId: w.sid });
  const op = w.ok(s.email, 'checkin.open', { code: w.kioskCode() });
  assert.deepEqual(op.actions, ['rescan', 'out']);
  assert.equal(w.ok(s.email, 'checkin.submit', { pass: op.pass, action: 'rescan', geo: w.at(2) }).type, 'RESCAN');
});

test('entry reason must match the session; not enrolled is refused; mode B-only lab refuses kiosk QR', () => {
  const w = ready(1); const [s] = w.students;
  const op = w.ok(s.email, 'checkin.open', { code: w.kioskCode() });
  assert.equal(w.err(s.email, 'checkin.submit', { pass: op.pass, action: 'in', sessionId: w.sid, reason: 'research', geo: w.at(1) }).code, 'BAD_INPUT');
  // a student not on the roster sees the class as not eligible and is refused
  w.ok(w.admin, 'students.import', { rows: [{ rollNo: 'X900', name: 'Outsider', email: 'outsider@karunya.edu' }] });
  w.ok('outsider@karunya.edu', 'onboard', { rollNo: 'X900', name: 'Outsider', consent: true, mobile: '9876500000' });
  const op2 = w.ok('outsider@karunya.edu', 'checkin.open', { code: w.kioskCode() });
  assert.equal(op2.candidates.find((c) => c.sessionId === w.sid).eligible, false);
  assert.equal(w.err('outsider@karunya.edu', 'checkin.submit', { pass: op2.pass, action: 'in', sessionId: w.sid, geo: w.at(1) }).code, 'NOT_ELIGIBLE');
  // switch the lab to device QR only
  w.ok(w.admin, 'labs.upsert', Object.assign({}, w.lab, { checkinMode: 'B' }));
  assert.equal(w.ok(w.kioskEmail, 'kiosk.display').code, undefined, 'no rotating code in mode B');
  assert.equal(w.err(s.email, 'checkin.open', { code: op.pass.length ? w.eval("Checkin._code(" + JSON.stringify(w.eval("Db.readAll('Kiosks')[0].kioskId")) + ", Checkin._step(U.now()))") : '' }).code, 'MODE_DISABLED');
});

test('impossible travel between labs is flagged (FR-29); one lab alone cannot be checked', () => {
  const w = ready(1); const [s] = w.students;
  assert.equal(w.checkin(s).ok, true);
  // GPU lab session 2 minutes later, 350 m away -> ~10 km/h is fine; make it 30 s later -> far too fast
  const ev = w.ok(w.admin, 'events.create', { name: 'GPU talk', labId: w.lab2.labId, date: w.today, startTime: '09:30', endTime: '12:00', openToAll: true, override: true, facultyId: w.facultyId });
  w.ok(w.admin, 'sessions.open', { sessionId: ev.event.sessionId });
  w.advance(30 * 1000);
  assert.equal(w.checkin(s, { kiosk: 'kiosk2@karunya.edu', sessionId: ev.event.sessionId, geo: w.at(2, 10, LAB_B) }).ok, true);
  const f = w.ok(w.staff, 'flags.list', {}).flags.find((x) => x.type === 'impossible_travel');
  assert.ok(f, 'flagged'); assert.equal(f.detail.fromLab, 'IOT01'); assert.equal(f.detail.toLab, 'GPU01'); assert.ok(f.detail.kmh > 15);
});

test('research visit via a workstation booking: self-work session, booking marked used (FR-25)', () => {
  const w = ready(1); const [s] = w.students;
  const cat = w.ok(w.staff, 'categories.upsert', { name: 'GPU workstation', trackingMode: 'individual' }).category;
  const ws = w.ok(w.staff, 'assets.upsert', { categoryId: cat.categoryId, labId: w.lab.labId, name: 'RTX 4090 #1', assetTag: 'WS-01' }).asset;
  const start = w.eval('U.now()') + 30 * 60000;
  const rsv = w.ok(s.email, 'booking.request', { labId: w.lab.labId, resourceType: 'asset', resourceId: ws.assetId, startAt: start, endAt: start + 2 * 3600000, purpose: 'Train model' }).reservation;
  w.ok(w.staff, 'booking.decide', { reservationId: rsv.reservationId, approve: true });
  w.advance(20 * 60000); // 10 minutes before the slot
  const op = w.ok(s.email, 'checkin.open', { code: w.kioskCode() });
  const cand = op.candidates.find((c) => c.reservationId === rsv.reservationId);
  assert.ok(cand && cand.reason === 'research');
  const r = w.ok(s.email, 'checkin.submit', { pass: op.pass, action: 'in', reservationId: rsv.reservationId, reason: 'research', geo: w.at(1) });
  assert.match(r.session.title, /^Self-work: RTX 4090/);
  assert.ok(w.eval("Db.get('Reservations'," + JSON.stringify(rsv.reservationId) + ").usedAt") > 0, 'slot counted as used');
  // idempotent: the same booking maps to the same session
  assert.equal(w.eval("Sessions.selfWorkFor(Db.get('Reservations'," + JSON.stringify(rsv.reservationId) + "), " + JSON.stringify(s.studentId) + ").sessionId"), r.session.sessionId);
});

function liveWorld() {
  const w = world();
  w.ok(w.admin, 'labs.upsert', { ...w.lab, openLab: true });
  const cat = w.ok(w.staff, 'categories.upsert', { name: 'Live systems', trackingMode: 'individual', workstation: true }).category;
  w.systems = [1, 2, 3].map((n) => w.ok(w.staff, 'assets.upsert', { labId: w.lab.labId, categoryId: cat.categoryId, name: 'Live system ' + n, assetTag: 'LIVE-' + n }).asset);
  w.projectIds = w.students.map((s, i) => w.ok(s.email, 'projects.create', { title: 'Live project ' + i, description: 'Private project description', labId: w.lab.labId,
    supervisorFacultyId: w.facultyId, startDate: w.today, endDate: '2026-12-01' }).project.projectId);
  w.liveSessionId = w.ok(w.students[0].email, 'sessions.mine').sessions.find((s) => s.type === 'openlab').sessionId;
  w.enterLive = (i) => { const r = w.checkin(w.students[i], { sessionId: w.liveSessionId, projectId: w.projectIds[i], assetId: w.systems[i].assetId }); assert.equal(r.ok, true, JSON.stringify(r)); };
  w.board = (email = w.staff, p = {}) => w.ok(email, 'labs.live', p);
  w.systemStatus = (email = w.staff) => w.ok(email, 'systems.status', { labId: w.lab.labId }).labs[0].systems;
  return w;
}

test('live board: faculty, staff and admin see current people, projects, systems and entry times', () => {
  const w = liveWorld(); w.enterLive(0); w.enterLive(1);
  for (const who of [w.faculty, w.staff, w.admin]) {
    const b = w.board(who, { labId: w.lab.labId }); assert.equal(b.labs.length, 1);
    const lab = b.labs[0]; assert.equal(lab.inside, 2); assert.equal(lab.visits.length, 2); assert.equal(b.refreshSeconds, 5);
    for (let i = 0; i < 2; i++) {
      const visit = lab.visits.find((v) => v.studentId === w.students[i].studentId);
      assert.equal(visit.rollNo, w.students[i].rollNo); assert.ok(visit.name); assert.equal(visit.since, w.NOW);
      assert.equal(visit.sessionId, w.liveSessionId); assert.equal(visit.projectId, w.projectIds[i]); assert.equal(visit.projectTitle, 'Live project ' + i);
      assert.equal(visit.assetId, w.systems[i].assetId); assert.equal(visit.assetName, w.systems[i].name);
    }
    assert.deepEqual(lab.systems.map((a) => a.status), ['busy', 'busy', 'free']);
    assert.ok(!JSON.stringify(b).includes('Private project description'));
  }
});

test('live board: students and kiosks cannot fetch identities; public caches and availability stay anonymous', () => {
  const w = liveWorld(); w.enterLive(0); w.board();
  for (const who of [w.students[0].email, w.kioskEmail, 'unknown@karunya.edu']) assert.equal(w.err(who, 'labs.live').code, 'FORBIDDEN');
  const systems = w.ok(w.students[1].email, 'systems.status'), publicCounts = w.ok(w.students[1].email, 'labs.occupancy');
  for (const payload of [systems, publicCounts, w.ok(w.kioskEmail, 'labs.occupancy')]) {
    const text = JSON.stringify(payload);
    assert.ok(!text.includes(w.students[0].studentId)); assert.ok(!text.includes(w.students[0].rollNo));
    assert.ok(!text.includes(w.projectIds[0])); assert.ok(!text.includes('Live project 0'));
    assert.ok(!text.includes('visits')); assert.ok(!text.includes('mobile')); assert.ok(!text.includes('email'));
  }
  assert.ok(w.systemStatus().every((s) => !('visits' in s) && !('studentId' in s)));
});

test('live board: a work change preserves entry time and VOID restores the effective assignment', () => {
  const w = liveWorld(); w.enterLive(0); w.advance(10 * 60000);
  const state = w.ok(w.students[0].email, 'sessions.mine').sessions.find((s) => s.sessionId === w.liveSessionId).mine.work;
  const changed = w.ok(w.students[0].email, 'attend.setWork', { sessionId: w.liveSessionId, entryEventId: state.entryEventId, expectedEventId: state.eventId,
    projectId: w.projectIds[0], assetId: w.systems[2].assetId });
  let lab = w.board().labs.find((l) => l.labId === w.lab.labId);
  assert.equal(lab.visits[0].assetId, w.systems[2].assetId); assert.equal(lab.visits[0].since, w.NOW);
  assert.equal(lab.systems.find((s) => s.assetId === w.systems[0].assetId).status, 'free');
  w.e.run(`Db.insert('AttendanceEvents',{eventId:U.id('event'),sessionId:'${w.liveSessionId}',studentId:'${w.students[0].studentId}',type:'VOID',ref:'${changed.work.eventId}',at:U.now(),createdAt:U.now(),approvalStatus:'approved'})`);
  lab = w.board().labs.find((l) => l.labId === w.lab.labId);
  assert.equal(lab.visits[0].assetId, w.systems[0].assetId); assert.equal(lab.systems.find((s) => s.assetId === w.systems[2].assetId).status, 'free');
});

test('live board: scanned departure removes a visitor and immediately frees their system', () => {
  const w = liveWorld(); w.enterLive(0); w.enterLive(1); w.board(); w.advance(3 * 60000);
  assert.equal(w.checkin(w.students[0], { sessionId: w.liveSessionId, action: 'out' }).ok, true);
  const lab = w.board().labs.find((l) => l.labId === w.lab.labId);
  assert.equal(lab.inside, 1); assert.deepEqual(lab.visits.map((v) => v.studentId), [w.students[1].studentId]);
  assert.equal(lab.systems.find((s) => s.assetId === w.systems[0].assetId).status, 'free');
});

test('live board: delayed closing is recovered on read and releases automatic sign-outs', () => {
  const w = liveWorld(); w.enterLive(0); w.e.setTime(w.eval(`U.fromLocal('${w.today}','19:05')`));
  const lab = w.board().labs.find((l) => l.labId === w.lab.labId);
  assert.equal(lab.inside, 0); assert.deepEqual(lab.visits, []); assert.ok(lab.systems.every((s) => s.status === 'free'));
  assert.equal(w.eval(`Db.whereEq('AttendanceEvents',{sessionId:'${w.liveSessionId}',method:'auto'}).length`), 1);
});

test('systems: booking holds are booked for staff and busy for students, with exact time boundaries', () => {
  const w = liveWorld(), assetId = w.systems[0].assetId, startAt = w.NOW + 15 * 60000, endAt = startAt + 3600000;
  const r = w.ok(w.students[0].email, 'booking.request', { labId: w.lab.labId, resourceType: 'asset', resourceId: assetId, startAt, endAt, purpose: 'Private booking purpose' }).reservation;
  assert.equal(w.systemStatus()[0].status, 'booked');
  const student = w.systemStatus(w.students[1].email); assert.equal(student[0].status, 'busy'); assert.ok(!JSON.stringify(student).includes(r.reservationId));
  w.ok(w.staff, 'booking.decide', { reservationId: r.reservationId, approve: false, note: 'Test release' });
  assert.equal(w.systemStatus()[0].status, 'free');
  const next = w.ok(w.students[0].email, 'booking.request', { labId: w.lab.labId, resourceType: 'asset', resourceId: assetId, startAt: startAt + 1, endAt: endAt + 1, purpose: 'Later hold' }).reservation;
  assert.equal(w.systemStatus()[0].status, 'free'); w.advance(1); assert.equal(w.systemStatus()[0].status, 'booked');
  w.e.setTime(next.endAt); assert.equal(w.systemStatus()[0].status, 'free');
});

test('systems: only individual workstations are listed; broken systems are never advertised as free', () => {
  const w = liveWorld();
  const cat = w.ok(w.staff, 'categories.upsert', { name: 'Not a system', trackingMode: 'individual' }).category;
  w.ok(w.staff, 'assets.upsert', { labId: w.lab.labId, categoryId: cat.categoryId, name: 'Sensor', assetTag: 'LIVE-SENSOR' });
  w.ok(w.staff, 'assets.upsert', { ...w.systems[0], condition: 'damaged' });
  assert.equal(w.systemStatus().length, 3); assert.equal(w.systemStatus()[0].status, 'unavailable');
  assert.equal(w.systemStatus(w.students[0].email)[0].status, 'busy');
});

test('live board: HOD endpoints use department scope and reject an invalid supplied scope', () => {
  const w = liveWorld(); w.enterLive(0);
  for (const route of ['labs.live', 'systems.status']) assert.equal(w.ok(w.hod, route).labs.length, 2);
  w.e.run(`Auth.labScope=function(){return ['${w.lab2.labId}'];};`);
  for (const route of ['labs.live', 'systems.status']) {
    const result = w.ok(w.hod, route); assert.deepEqual(result.labs.map((l) => l.labId), [w.lab2.labId]);
    assert.ok(!JSON.stringify(result).includes(w.students[0].studentId));
    assert.equal(w.err(w.hod, route, { labId: w.lab.labId }).code, 'FORBIDDEN');
  }
  w.e.run(`Auth.labScope=function(){return [];};`); assert.deepEqual(w.board(w.hod).labs, []);
  w.e.run('Auth.labScope=function(){return null;};');
  for (const route of ['labs.live', 'systems.status']) assert.equal(w.err(w.hod, route).code, 'FORBIDDEN');
});

test('live board: filters validate ids, exclude inactive labs and retain empty active labs', () => {
  const w = liveWorld();
  assert.equal(w.err(w.staff, 'labs.live', { labId: 'bad' }).code, 'BAD_INPUT');
  assert.equal(w.board().labs.length, 2); assert.equal(w.board().labs[0].inside, 0);
  w.ok(w.admin, 'labs.upsert', { ...w.lab2, status: 'inactive' });
  assert.equal(w.board().labs.length, 1); assert.equal(w.err(w.staff, 'systems.status', { labId: w.lab2.labId }).code, 'FORBIDDEN');
});
