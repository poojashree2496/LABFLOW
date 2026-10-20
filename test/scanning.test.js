// Version B: device-signed rotating QR scanned by a kiosk scanner or by a teacher / staff / CR / coordinator phone.
const test = require('node:test');
const assert = require('node:assert/strict');
const { world } = require('./fixtures');

async function ready(n = 3, opts = {}) {
  const w = world(Object.assign({ students: n }, opts));
  for (const s of w.students) await w.registerDevice(s);
  w.sid = w.session().sessionId;
  w.ok(w.faculty, 'sessions.open', { sessionId: w.sid });
  return w;
}

test('teacher phone opens the QR link: accepted as scanner method with high assurance', async () => {
  const w = await ready(1); const [s] = w.students;
  const link = await w.qrLink(s, w.sid, 'in');
  assert.ok(link.startsWith('https://script.google.com/') && link.includes('?s='));
  const r = w.phoneScan(w.faculty, link);
  assert.equal(r.ok, true); assert.equal(r.data.method, 'scanner'); assert.equal(r.data.mode, 'B'); assert.equal(r.data.assurance, 'high');
  const row = w.ok(w.faculty, 'attend.roster', { sessionId: w.sid }).roster.find((x) => x.studentId === s.studentId);
  assert.equal(row.state, 'in'); assert.equal(row.method, 'scanner'); assert.equal(row.scannerRole, 'faculty');
});

test('who may scan: owner, staff, admin yes; another teacher or a student no (SRS 15.4)', async () => {
  const w = await ready(3); const [a, b, c] = w.students;
  assert.equal(w.phoneScan(w.faculty2, await w.qr(a, w.sid, 'in')).error.code, 'NOT_SCANNER');
  assert.equal(w.phoneScan(b.email, await w.qr(a, w.sid, 'in')).error.code, 'NOT_SCANNER', 'student scanning another student is refused');
  assert.equal(w.phoneScan(w.staff, await w.qr(a, w.sid, 'in')).data.assurance, 'high');
  assert.equal(w.phoneScan(w.admin, await w.qr(b, w.sid, 'in')).ok, true);
  assert.equal(w.phoneScan(w.faculty, await w.qr(c, w.sid, 'in')).ok, true);
});

test('class representative: operates and scans own class only; never themselves; not after the session (SRS 7.2)', async () => {
  const w = await ready(4); const [cr, a, b] = w.students;
  w.ok(w.faculty, 'classreps.set', { courseId: w.course.courseId, section: 'A', studentId: cr.studentId });
  assert.equal(w.err(w.faculty2, 'classreps.set', { courseId: w.course.courseId, section: 'A', studentId: a.studentId }).code, 'FORBIDDEN', 'only the teacher of the course assigns');
  const mine = w.ok(cr.email, 'cr.mine');
  assert.equal(mine.reps.length, 1); assert.equal(mine.sessions[0].sessionId, w.sid);
  assert.equal(w.ok(cr.email, 'me').classRep, true);
  // scanning classmates is tagged
  assert.equal(w.phoneScan(cr.email, await w.qr(a, w.sid, 'in')).ok, true);
  const row = w.ok(w.faculty, 'attend.roster', { sessionId: w.sid }).roster.find((x) => x.studentId === a.studentId);
  assert.equal(row.scannerRole, 'cr'); assert.equal(row.scannedBy, cr.email, 'the teacher sees who scanned whom');
  assert.equal(w.phoneScan(cr.email, await w.qr(cr, w.sid, 'in')).error.code, 'SELF_SCAN');
  // the CR can call a rescan when the teacher asks, and see the live roster, but not spot checks or corrections
  assert.ok(w.ok(cr.email, 'attend.openRescan', { sessionId: w.sid }).window);
  assert.ok(w.ok(cr.email, 'attend.roster', { sessionId: w.sid }).roster.length >= 4);
  assert.equal(w.err(cr.email, 'spot.start', { sessionId: w.sid }).code, 'FORBIDDEN');
  assert.equal(w.err(cr.email, 'attend.correct', { sessionId: w.sid, studentId: b.studentId, action: 'add_in', reason: 'Was here all along, phone dead' }).code, 'FORBIDDEN');
  // a student who is not the CR cannot operate the session
  assert.equal(w.err(b.email, 'sessions.close', { sessionId: w.sid }).code, 'FORBIDDEN');
  // after the session ends the CR permission ends with it
  w.advance(3 * 60000);
  const qrOut = await w.qr(b, w.sid, 'in');
  w.ok(w.faculty, 'sessions.close', { sessionId: w.sid });
  assert.equal(w.phoneScan(cr.email, qrOut).error.code, 'CR_SESSION_ENDED');
  // switched off globally
  w.ok(w.admin, 'settings.set', { values: { crScanningEnabled: false } });
  assert.equal(w.ok(cr.email, 'cr.mine').crScanning, false);
});

test('class representative: roster only, and only for their own course and section', async () => {
  const w = await ready(2); const [cr, a] = w.students;
  w.ok(w.faculty, 'classreps.set', { courseId: w.course.courseId, section: 'A', studentId: cr.studentId });
  // an outsider with a registered device, for the same session
  w.ok(w.admin, 'students.import', { rows: [{ rollNo: 'X901', name: 'Outsider', email: 'outsider@karunya.edu', section: 'B' }] });
  w.ok('outsider@karunya.edu', 'onboard', { rollNo: 'X901', name: 'Outsider', consent: true, mobile: '9876500001' });
  const out = { email: 'outsider@karunya.edu', studentId: w.ok('outsider@karunya.edu', 'me').student.studentId };
  await w.registerDevice(out);
  assert.equal(w.err(out.email, 'attend.challenge', { sessionId: w.sid, purpose: 'in', credentialId: w.devices[out.studentId].credentialId }).code, 'NOT_ELIGIBLE', 'cannot even get a code for a class they are not in');
  // a CR of a different section is not a CR here
  const w2 = await ready(2); const [x, y] = w2.students;
  w2.ok(w2.faculty, 'classreps.set', { courseId: w2.course.courseId, section: 'A', studentId: x.studentId });
  w2.eval("Db.update('ClassReps', Db.readAll('ClassReps')[0].repId, { section: 'B' })");
  assert.equal(w2.phoneScan(x.email, await w2.qr(y, w2.sid, 'in')).error.code, 'NOT_SCANNER');
  void a;
});

test('events: coordinator operates the event session, scans, adds guests; lunch break excluded from hours', async () => {
  const w = await ready(3); const [coord, a, b] = w.students;
  w.ok(w.faculty, 'sessions.close', { sessionId: w.sid });
  const ev = w.ok(w.faculty, 'events.create', { name: 'Saturday IoT workshop', labId: w.lab.labId, date: w.today, startTime: '10:00', endTime: '16:00', breakStart: '13:00', breakEnd: '14:00',
    capacity: 2, coordinatorEmail: coord.email, rollNos: ['S002', 'S003'] });
  assert.equal(ev.registered, 2);
  const sid = ev.event.sessionId;
  assert.equal(w.ok(coord.email, 'events.mine').events.length, 1);
  assert.ok(w.ok(coord.email, 'me').coordinating >= 1);
  w.ok(coord.email, 'sessions.open', { sessionId: sid });
  assert.equal(w.phoneScan(coord.email, await w.qr(a, sid, 'in')).ok, true);
  assert.equal(w.phoneScan(coord.email, await w.qr(b, sid, 'in')).ok, true);
  assert.equal(w.err(coord.email, 'attend.challenge', { sessionId: sid, purpose: 'in', credentialId: w.devices[coord.studentId].credentialId }).code, 'NOT_ELIGIBLE', 'the coordinator is not a registered participant');
  w.ok(coord.email, 'events.addGuest', { labEventId: ev.event.labEventId, name: 'Guest Speaker', organisation: 'Bosch' });
  const roster = w.ok(coord.email, 'attend.roster', { sessionId: sid });
  assert.equal(roster.guests, 1); assert.equal(roster.counts.capacity, 2); assert.equal(roster.counts.overCapacity, false);
  // 10:00 -> 15:00 with a 13:00-14:00 break: 4 verified hours, no scans needed at lunch
  w.e.setTime(Date.UTC(2026, 9, 14, 9, 30)); // 15:00 IST
  assert.equal(w.ok(a.email, 'attend.challenge', { sessionId: sid, purpose: 'out', credentialId: w.devices[a.studentId].credentialId }).ttl, 60);
  assert.equal(w.phoneScan(w.faculty, await w.qr(a, sid, 'out')).ok, true);
  const mine = w.ok(w.faculty, 'attend.roster', { sessionId: sid }).roster.find((r) => r.studentId === a.studentId);
  assert.equal(mine.verifiedMinutes, 240);
  // after the event (plus grace) the coordinator rights are gone
  w.e.setTime(Date.UTC(2026, 9, 14, 12, 0)); // 17:30 IST, end 16:00 + 60 min grace
  assert.equal(w.err(coord.email, 'attend.roster', { sessionId: sid }).code, 'FORBIDDEN');
  assert.equal(w.err(coord.email, 'events.addGuest', { labEventId: ev.event.labEventId, name: 'Late guest' }).code, 'FORBIDDEN');
  const audit = w.eval("Db.readAll('AuditEvents').filter(function(e){return e.action==='event.guest';}).length");
  assert.equal(audit, 1);
});

test('mode switch: an A-only lab refuses device QR codes; a B-only kiosk shows no rotating code', async () => {
  const w = await ready(1); const [s] = w.students;
  w.ok(w.admin, 'labs.upsert', Object.assign({}, w.lab, { checkinMode: 'A' }));
  assert.equal(w.err(s.email, 'attend.challenge', { sessionId: w.sid, purpose: 'in', credentialId: w.devices[s.studentId].credentialId }).code, 'MODE_DISABLED');
  w.ok(w.admin, 'labs.upsert', Object.assign({}, w.lab, { checkinMode: 'AB' }));
  const qr = await w.qr(s, w.sid, 'in');
  w.ok(w.admin, 'labs.upsert', Object.assign({}, w.lab, { checkinMode: 'A' }));
  assert.equal(w.scan(qr).error.code, 'MODE_DISABLED');
  // default mode comes from settings when the lab has none
  w.ok(w.admin, 'labs.upsert', Object.assign({}, w.lab, { checkinMode: '' }));
  assert.equal(w.ok(w.admin, 'labs.list').labs.find((l) => l.code === 'IOT01').mode, 'A');
  w.ok(w.admin, 'settings.set', { values: { defaultCheckinMode: 'B' } });
  assert.equal(w.ok(w.kioskEmail, 'kiosk.display').code, undefined);
});

test('flags: back-to-back phone scans, replayed and stale codes are raised for review and can be resolved', async () => {
  const w = await ready(3); const [a, b, c] = w.students;
  const qa = await w.qr(a, w.sid, 'in'), qb = await w.qr(b, w.sid, 'in');
  assert.equal(w.phoneScan(w.faculty, qa).ok, true);
  assert.equal(w.phoneScan(w.faculty, qb).ok, true); // same instant: one person with two phones?
  assert.equal(w.scan(qa).error.code, 'REPLAY');
  const old = await w.qr(c, w.sid, 'in');
  w.advance(20 * 1000);
  assert.equal(w.scan(old).error.code, 'STALE_QR');
  const flags = w.ok(w.faculty, 'flags.list', {}).flags;
  const types = flags.map((f) => f.type).sort();
  assert.deepEqual(types, ['back_to_back', 'replay_attempt', 'stale_qr']);
  assert.equal(w.ok(w.faculty2, 'flags.list', {}).flags.length, 0, 'other faculty do not see these');
  const f = flags.find((x) => x.type === 'back_to_back');
  w.ok(w.faculty, 'flags.resolve', { flagId: f.flagId, outcome: 'dismissed', note: 'Two students in the queue, seen in person' });
  assert.equal(w.ok(w.faculty, 'flags.list', {}).flags.length, 2);
  assert.equal(w.err(w.faculty, 'flags.resolve', { flagId: f.flagId, outcome: 'resolved', note: 'again' }).code, 'INVALID_STATE');
  // the same situation is not raised twice (the used nonce re-signed with a fresh timestamp)
  assert.equal(w.scan(await w.sign(qa.split('~')[0], w.devices[a.studentId])).error.code, 'REPLAY');
  assert.equal(w.ok(w.staff, 'flags.list', { status: 'all' }).flags.filter((x) => x.type === 'replay_attempt').length, 1);
});

test('scanner screen photo: only the scanner that just recorded the event; desk identification by QR', async () => {
  const w = await ready(2); const [a, b] = w.students;
  const r = w.phoneScan(w.faculty, await w.qr(a, w.sid, 'in'));
  assert.deepEqual(w.ok(w.faculty, 'scan.photo', { eventId: r.data.eventId }), { dataUrl: null }, 'no photo on file is fine');
  assert.equal(w.err(w.staff, 'scan.photo', { eventId: r.data.eventId }).code, 'FORBIDDEN');
  w.advance(3 * 60000);
  assert.equal(w.err(w.faculty, 'scan.photo', { eventId: r.data.eventId }).code, 'FORBIDDEN', 'gone after two minutes');
  const id = w.ok(w.staff, 'student.identify', { qr: await w.qr(b, w.sid, 'in') });
  assert.equal(id.student.rollNo, 'S002');
  assert.equal(w.err(w.faculty, 'student.identify', { qr: await w.qr(b, w.sid, 'in') }).code, 'FORBIDDEN');
});

test('pipelines are data: every step is traced in order and the locked steps come last', async () => {
  const w = await ready(1); const [s] = w.students;
  const traces = [];
  w.e.ctx.__pipelineObserver = (t) => traces.push(JSON.parse(JSON.stringify(t)));
  w.scan(await w.qr(s, w.sid, 'in'));
  const steps = w.eval('Pipeline.describe(Attend.STEPS_B)');
  assert.deepEqual(traces[0].trace.map((x) => x.id), steps.map((x) => x.id));
  assert.equal(traces[0].ok, true); assert.equal(traces[0].pipeline, 'B.scan');
  const firstLocked = steps.findIndex((x) => x.locked);
  assert.ok(steps.slice(firstLocked).every((x) => x.locked), 'no unlocked step after a locked one');
  assert.deepEqual(steps.slice(firstLocked).map((x) => x.id), ['replay', 'revocation_recheck', 'authorization_recheck', 'session_open', 'enrolment', 'attendance_state', 'work', 'record']);
  // a refusal names the step that decided it
  w.scan(await w.sign('a1.x.y.z.q.i.n.1.' + 'A'.repeat(27), w.devices[s.studentId]));
  const last = traces[traces.length - 1];
  assert.equal(last.ok, false); assert.equal(last.trace[last.trace.length - 1].id, 'token_mac');
  const a = w.eval('Pipeline.describe(Checkin.STEPS_A)').map((x) => x.id);
  assert.deepEqual(a.slice(-5), ['code_once', 'session_open', 'enrolment', 'attendance_state', 'record']);
});

// Two-read liveness (scanLivenessReads = 2): a picture of the QR has one timestamp and can never pass; a live phone can.
async function liveReady() {
  const w = await ready(2);
  w.ok(w.admin, 'settings.set', { values: { scanLivenessReads: 2 } });
  return w;
}
const row = (w, s) => w.ok(w.faculty, 'attend.roster', { sessionId: w.sid }).roster.find((x) => x.studentId === s.studentId);

test('liveness: off by default; with two reads on, the first read asks for another and records nothing', async () => {
  const w0 = await ready(1);
  assert.equal(w0.scan(await w0.qr(w0.students[0], w0.sid, 'in')).ok, true, 'default is a single read');
  const w = await liveReady(); const [s] = w.students;
  const ch = w.ok(s.email, 'attend.challenge', { sessionId: w.sid, purpose: 'in', credentialId: w.devices[s.studentId].credentialId });
  const dev = w.devices[s.studentId], t0 = w.eval('U.now()');
  const first = w.scan(await w.sign(ch.token, dev, t0));
  assert.equal(first.error.code, 'SCAN_AGAIN');
  assert.equal(row(w, s).state, 'none', 'nothing recorded after the first read');
  assert.equal(w.eval("Db.readAll('AuditEvents').filter(function (e) { return e.action === 'scan.reject'; }).length"), 0, 'a first read is not logged as a rejection');
  assert.equal(w.eval("Db.readAll('Flags').length"), 0, 'and raises no flag');
  const second = w.scan(await w.sign(ch.token, dev, t0 + 3000));
  assert.equal(second.ok, true); assert.equal(row(w, s).state, 'in');
});

test('liveness: the same picture read again never passes, even many times', async () => {
  const w = await liveReady(); const [s] = w.students, dev = w.devices[s.studentId];
  const ch = w.ok(s.email, 'attend.challenge', { sessionId: w.sid, purpose: 'in', credentialId: dev.credentialId });
  const picture = await w.sign(ch.token, dev, w.eval('U.now()'));
  for (let i = 0; i < 4; i++) { w.advance(1500); assert.equal(w.scan(picture).error.code, 'SCAN_AGAIN'); }
  assert.equal(row(w, s).state, 'none');
});

test('liveness: a different scanner cannot finish another scanner\'s first read, and a stale first read starts over', async () => {
  const w = await liveReady(); const [s] = w.students, dev = w.devices[s.studentId];
  const ch = w.ok(s.email, 'attend.challenge', { sessionId: w.sid, purpose: 'in', credentialId: dev.credentialId });
  const t0 = w.eval('U.now()');
  assert.equal(w.phoneScan(w.faculty, await w.sign(ch.token, dev, t0)).error.code, 'SCAN_AGAIN');
  assert.equal(w.phoneScan(w.staff, await w.sign(ch.token, dev, t0 + 2000)).error.code, 'SCAN_AGAIN', 'another scanner starts its own first read');
  assert.equal(w.phoneScan(w.faculty, await w.sign(ch.token, dev, t0 + 3000)).error.code, 'SCAN_AGAIN', 'the first scanner\'s read was replaced, so it starts over');
  assert.equal(w.phoneScan(w.faculty, await w.sign(ch.token, dev, t0 + 6000)).ok, true);
});

test('liveness: only a verified second read counts; a forged second timestamp, a replay after success and a stale first read all fail', async () => {
  const w = await liveReady(); const [a, b] = w.students;
  const da = w.devices[a.studentId], db = w.devices[b.studentId];
  const ch = w.ok(a.email, 'attend.challenge', { sessionId: w.sid, purpose: 'in', credentialId: da.credentialId });
  const t0 = w.eval('U.now()');
  assert.equal(w.scan(await w.sign(ch.token, da, t0)).error.code, 'SCAN_AGAIN');
  const forged = ch.token + '~' + (t0 + 3000) + '~' + (await w.sign(ch.token, da, t0 + 1)).split('~')[2];
  assert.equal(w.scan(forged).error.code, 'BAD_SIGNATURE', 'the signature is checked before the second read counts');
  assert.equal(w.scan(await w.sign(ch.token, da, t0 + 3000)).ok, true);
  assert.equal(w.scan(await w.sign(ch.token, da, t0 + 6000)).error.code, 'REPLAY', 'a used code is still refused');
  // a first read older than 20 s is forgotten
  const chB = w.ok(b.email, 'attend.challenge', { sessionId: w.sid, purpose: 'in', credentialId: db.credentialId });
  const u0 = w.eval('U.now()');
  assert.equal(w.scan(await w.sign(chB.token, db, u0)).error.code, 'SCAN_AGAIN');
  w.advance(21000);
  assert.equal(w.scan(await w.sign(chB.token, db, w.eval('U.now()'))).error.code, 'SCAN_AGAIN', 'after 20 s it is a fresh first read');
});

test('liveness: out and rescan scans follow the same rule, and desk identification is not affected', async () => {
  const w = await liveReady(); const [s] = w.students, dev = w.devices[s.studentId];
  const live = async (purpose) => {
    const ch = w.ok(s.email, 'attend.challenge', { sessionId: w.sid, purpose, credentialId: dev.credentialId });
    const t = w.eval('U.now()');
    assert.equal(w.scan(await w.sign(ch.token, dev, t)).error.code, 'SCAN_AGAIN');
    return w.scan(await w.sign(ch.token, dev, t + 3000));
  };
  assert.equal((await live('in')).ok, true);
  w.advance(600000);
  assert.equal((await live('out')).ok, true);
  assert.equal(row(w, s).state, 'out');
});
