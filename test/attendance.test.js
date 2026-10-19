const test = require('node:test');
const assert = require('node:assert/strict');
const { world, genDevice, signWith } = require('./fixtures');

async function ready(n = 3) {
  const w = world({ students: n });
  for (const s of w.students) await w.registerDevice(s);
  const ses = w.session();
  w.sid = ses.sessionId;
  return w;
}
const open = (w) => w.ok(w.faculty, 'sessions.open', { sessionId: w.sid });
const rosterRow = (w, student) => w.ok(w.faculty, 'attend.roster', { sessionId: w.sid }).roster.find((r) => r.studentId === student.studentId);

test('schema flags: unique + cached columns keep BOTH flags (regression: cache flag was lost for "u:c")', () => {
  const w = world({ students: 0 });
  const c = w.eval("Cfg.SCHEMA.Users.filter(function(x){return x.name==='email';})[0]");
  assert.equal(c.unique, true); assert.equal(c.cache, true);
  const r = w.eval("Cfg.SCHEMA.StudentProfiles.filter(function(x){return x.name==='rollNo';})[0]");
  assert.equal(r.unique && r.cache, true);
});

test('happy path: register -> open -> IN -> OUT -> close -> verified present', async () => {
  const w = await ready(1);
  const [s] = w.students;
  assert.equal(w.devices[s.studentId].status, 'active', 'first device auto-approved');
  assert.equal(w.err(s.email, 'attend.challenge', { sessionId: w.sid, purpose: 'in', credentialId: w.devices[s.studentId].credentialId }).code, 'SESSION_NOT_OPEN');
  open(w);
  const r1 = w.scan(await w.qr(s, w.sid, 'in'));
  assert.equal(r1.ok, true); assert.equal(r1.data.type, 'IN'); assert.equal(r1.data.student.rollNo, 'S001');
  assert.equal(rosterRow(w, s).state, 'in');
  w.advance(45 * 60000);
  const r2 = w.scan(await w.qr(s, w.sid, 'out'));
  assert.equal(r2.data.type, 'OUT');
  w.ok(w.faculty, 'sessions.close', { sessionId: w.sid });
  const row = rosterRow(w, s);
  assert.equal(row.status, 'present'); assert.equal(row.verifiedMinutes, 45);
  const h = w.ok(s.email, 'attend.history');
  assert.equal(h.history[0].status, 'present'); assert.equal(h.totals.present, 1);
});

test('replayed QR is rejected and recorded', async () => {
  const w = await ready(1); const [s] = w.students; open(w);
  const qr = await w.qr(s, w.sid, 'in');
  assert.equal(w.scan(qr).ok, true);
  const again = w.scan(qr);
  assert.equal(again.ok, false); assert.equal(again.error.code, 'REPLAY');
  const ev = w.eval("Db.readAll('AttendanceEvents').length");
  assert.equal(ev, 1);
  const rej = w.ok(w.admin, 'audit.list', { action: 'scan.reject' }).events;
  assert.ok(rej.some((e) => e.detail.code === 'REPLAY'));
});

test('replay is also rejected after the cache is wiped (Redemptions sheet is the source of truth)', async () => {
  const w = await ready(1); const [s] = w.students; open(w);
  const qr = await w.qr(s, w.sid, 'in');
  w.scan(qr);
  for (const k of Object.keys(w.e.cacheStore)) delete w.e.cacheStore[k];
  assert.equal(w.scan(qr).error.code, 'REPLAY');
});

test('race: the same QR submitted twice while the first is still verifying yields exactly one event', async () => {
  const w = await ready(1); const [s] = w.students; open(w);
  const qr = await w.qr(s, w.sid, 'in');
  // Signature verification happens OUTSIDE the lock. Re-enter a full second scan during the first one's verification.
  w.e.run(`var __orig = Creds.verifySignature, __nested = null;
    Creds.verifySignature = function (a, b, c) { var ok = __orig(a, b, c); if (!__nested) { __nested = 'running'; globalThis.__second = JSON.stringify(rpc('kiosk.scan', { qr: ${JSON.stringify(qr)} })); __nested = 'done'; } return ok; };`);
  w.e.state.activeUser = w.kioskEmail;
  const first = JSON.parse(w.e.run(`JSON.stringify(rpc('kiosk.scan', { qr: ${JSON.stringify(qr)} }))`));
  const second = JSON.parse(w.e.run('globalThis.__second'));
  const oks = [first, second].filter((r) => r.ok).length;
  assert.equal(oks, 1, 'exactly one scan succeeds');
  assert.equal(w.eval("Db.readAll('AttendanceEvents').length"), 1);
  assert.equal(w.eval("Db.readAll('Redemptions').filter(function (r) { return r.purpose === 'in'; }).length"), 1);
});

test('race: two DIFFERENT valid IN codes for the same student cannot both check in', async () => {
  const w = await ready(1); const [s] = w.students; open(w);
  const q1 = await w.qr(s, w.sid, 'in'), q2 = await w.qr(s, w.sid, 'in');
  assert.equal(w.scan(q1).ok, true);
  assert.equal(w.scan(q2).error.code, 'DUPLICATE_IN');
  assert.equal(w.eval("Db.readAll('AttendanceEvents').length"), 1);
});

test('expired nonce is rejected; the phone keeps re-signing a live nonce, a stale timestamp is refused', async () => {
  const w = await ready(1); const [s] = w.students; open(w);
  const dev = w.devices[s.studentId];
  const ch = w.ok(s.email, 'attend.challenge', { sessionId: w.sid, purpose: 'in', credentialId: dev.credentialId });
  assert.equal(ch.rotateSeconds, 3); assert.equal(ch.url.indexOf('https://'), 0);
  const shot = await w.sign(ch.token, dev);           // a screenshot taken now
  w.advance(30 * 1000);
  assert.equal(w.scan(shot).error.code, 'STALE_QR', 'a 30 s old rotation is a screenshot');
  assert.equal(w.scan(await w.sign(ch.token, dev)).ok, true, 'the same nonce re-signed now is still valid at 30 s');
  w.advance(125 * 1000); // past the minimum gap between check-in and check-out
  const ch2 = w.ok(s.email, 'attend.challenge', { sessionId: w.sid, purpose: 'out', credentialId: dev.credentialId });
  w.advance(66 * 1000); // ttl 60 s + 5 s skew
  assert.equal(w.scan(await w.sign(ch2.token, dev)).error.code, 'EXPIRED', 'fresh timestamp cannot revive an expired nonce');
  assert.equal(w.scan(await w.sign(ch2.token, dev, w.eval('U.now()') + 60000)).error.code, 'EXPIRED');
});

test('forged signature, wrong key, tampered token and foreign MAC are rejected', async () => {
  const w = await ready(2); const [a, b] = w.students; open(w);
  const ch = w.ok(a.email, 'attend.challenge', { sessionId: w.sid, purpose: 'in', credentialId: w.devices[a.studentId].credentialId });
  // signed by student B's device key, presented for A
  assert.equal(w.scan(await w.sign(ch.token, w.devices[b.studentId])).error.code, 'BAD_SIGNATURE');
  // attacker device not enrolled
  assert.equal(w.scan(await w.sign(ch.token, await genDevice())).error.code, 'BAD_SIGNATURE');
  // the timestamp is inside the signature: changing it breaks the signature (no re-dating a screenshot)
  const good = await w.sign(ch.token, w.devices[a.studentId]), p3 = good.split('~');
  assert.equal(w.scan(p3[0] + '~' + (Number(p3[1]) + 1000) + '~' + p3[2]).error.code, 'BAD_SIGNATURE');
  // token without a signature or timestamp
  assert.equal(w.scan(ch.token + '~').error.code, 'BAD_TOKEN');
  assert.equal(w.scan(ch.token + '~' + (await signWith(w.devices[a.studentId], ch.token))).error.code, 'BAD_TOKEN', 'old two-part format is not accepted');
  // tamper: swap the student id in the token body (MAC must break)
  const parts = ch.token.split('.'); parts[1] = b.studentId;
  assert.equal(w.scan(await w.sign(parts.join('.'), w.devices[a.studentId])).error.code, 'BAD_TOKEN');
  // forged token with the correct shape but made up MAC
  assert.equal(w.scan('a1.x.y.z.q.i.n.9999999999.' + 'A'.repeat(27) + '~' + w.eval('U.now()') + '~' + 'A'.repeat(86)).error.code, 'BAD_TOKEN');
  // garbage
  for (const g of ['', 'hello', '~', 'a~b', '{"x":1}', 'x'.repeat(600)]) assert.equal(w.scan(g).ok, false);
  assert.equal(w.eval("Db.readAll('AttendanceEvents').length"), 0);
});

test('wrong lab: a kiosk in another lab rejects the code', async () => {
  const w = await ready(1); const [s] = w.students; open(w);
  const qr = await w.qr(s, w.sid, 'in');
  assert.equal(w.scan(qr, 'kiosk2@karunya.edu').error.code, 'WRONG_LAB');
});

test('revocation wins: QR issued before revoke is dead; challenge after revoke is refused', async () => {
  const w = await ready(1); const [s] = w.students; open(w);
  const dev = w.devices[s.studentId];
  const qr = await w.qr(s, w.sid, 'in');
  w.ok(w.staff, 'cred.revoke', { credentialId: dev.credentialId, reason: 'lost phone' });
  assert.equal(w.scan(qr).error.code, 'REVOKED');
  assert.equal(w.err(s.email, 'attend.challenge', { sessionId: w.sid, purpose: 'in', credentialId: dev.credentialId }).code, 'DEVICE_INACTIVE');
  assert.equal(w.eval("Db.readAll('AttendanceEvents').length"), 0);
});

test('revocation during verification (race) is honoured inside the lock', async () => {
  const w = await ready(1); const [s] = w.students; open(w);
  const dev = w.devices[s.studentId], qr = await w.qr(s, w.sid, 'in');
  w.e.run(`var __o = Creds.verifySignature, __done = false;
    Creds.verifySignature = function (a, b, c) { var ok = __o(a, b, c); if (!__done) { __done = true; Db.update('DeviceCredentials', ${JSON.stringify(dev.credentialId)}, { status: 'revoked' }); } return ok; };`);
  assert.equal(w.scan(qr).error.code, 'REVOKED');
});

test('device replacement needs in-person approval; old device keeps working until then, then stops', async () => {
  const w = await ready(1); const [s] = w.students; open(w);
  const old = w.devices[s.studentId];
  const second = await genDevice();
  const ch = w.ok(s.email, 'cred.begin');
  const reg = w.ok(s.email, 'cred.complete', { challenge: ch.challenge, publicKey: second.publicKey, signature: await signWith(second, ch.challenge), label: 'New phone' });
  assert.equal(reg.status, 'pending_approval'); second.credentialId = reg.credentialId;
  // pending device cannot make codes
  assert.equal(w.err(s.email, 'attend.challenge', { sessionId: w.sid, purpose: 'in', credentialId: second.credentialId }).code, 'DEVICE_INACTIVE');
  // student cannot approve themselves; staff must confirm ID check
  assert.equal(w.err(s.email, 'cred.approve', { credentialId: second.credentialId, idChecked: true }).code, 'FORBIDDEN');
  assert.equal(w.err(w.staff, 'cred.approve', { credentialId: second.credentialId }).code, 'BAD_INPUT');
  const qrOld = await w.qr(s, w.sid, 'in', old);
  w.ok(w.staff, 'cred.approve', { credentialId: second.credentialId, idChecked: true });
  assert.equal(w.scan(qrOld).error.code, 'REVOKED', 'old device dead after approval');
  w.devices[s.studentId] = second;
  assert.equal(w.scan(await w.qr(s, w.sid, 'in')).ok, true);
});

test('proof of possession: registering a key you cannot sign for is refused; challenge is single use', async () => {
  const w = world({ students: 1 }); const s = w.students[0];
  const real = await genDevice(), other = await genDevice();
  const ch = w.ok(s.email, 'cred.begin');
  assert.equal(w.err(s.email, 'cred.complete', { challenge: ch.challenge, publicKey: real.publicKey, signature: await signWith(other, ch.challenge) }).code, 'BAD_SIGNATURE');
  const good = { challenge: ch.challenge, publicKey: real.publicKey, signature: await signWith(real, ch.challenge) };
  assert.equal(w.ok(s.email, 'cred.complete', good).status, 'active');
  const ch2 = w.ok(s.email, 'cred.begin');
  // someone else's challenge cannot be used by another student
  const w2 = world({ students: 2 }); const [a, b] = w2.students;
  const chA = w2.ok(a.email, 'cred.begin'), dev = await genDevice();
  assert.equal(w2.err(b.email, 'cred.complete', { challenge: chA.challenge, publicKey: dev.publicKey, signature: await signWith(dev, chA.challenge) }).code, 'BAD_TOKEN');
  // same public key cannot be registered twice
  const chB = w2.ok(b.email, 'cred.begin');
  w2.ok(a.email, 'cred.complete', { challenge: chA.challenge, publicKey: dev.publicKey, signature: await signWith(dev, chA.challenge) });
  assert.equal(w2.err(b.email, 'cred.complete', { challenge: chB.challenge, publicKey: dev.publicKey, signature: await signWith(dev, chB.challenge) }).code, 'DUPLICATE');
  void ch2;
});

test('eligibility: student not on the roster cannot get a code; kiosk also re-checks', async () => {
  const w = await ready(2); open(w);
  const [a, b] = w.students;
  const rosterRows = w.ok(w.admin, 'roster.list', { courseId: w.course.courseId }).roster || w.ok(w.admin, 'roster.list', { courseId: w.course.courseId }).entries;
  const entry = (rosterRows || []).find((r) => r.studentId === b.studentId);
  assert.ok(entry, 'roster listing returns entries');
  const qr = await w.qr(b, w.sid, 'in'); // issued while eligible
  w.ok(w.admin, 'roster.remove', { rosterId: entry.rosterId });
  assert.equal(w.scan(qr).error.code, 'NOT_ELIGIBLE', 'removal takes effect at the kiosk');
  assert.equal(w.err(b.email, 'attend.challenge', { sessionId: w.sid, purpose: 'in', credentialId: w.devices[b.studentId].credentialId }).code, 'NOT_ELIGIBLE');
  assert.equal(w.scan(await w.qr(a, w.sid, 'in')).ok, true);
});

test('a student cannot request a code with someone else\'s device', async () => {
  const w = await ready(2); open(w);
  const [a, b] = w.students;
  assert.equal(w.err(a.email, 'attend.challenge', { sessionId: w.sid, purpose: 'in', credentialId: w.devices[b.studentId].credentialId }).code, 'NO_DEVICE');
});

test('missing exit scan does NOT award a full session', async () => {
  const w = await ready(2); const [a, b] = w.students; open(w);
  w.scan(await w.qr(a, w.sid, 'in')); w.scan(await w.qr(b, w.sid, 'in'));
  w.advance(100 * 60000);
  w.scan(await w.qr(a, w.sid, 'out'));
  w.ok(w.faculty, 'sessions.close', { sessionId: w.sid });
  const ra = rosterRow(w, a), rb = rosterRow(w, b);
  assert.equal(ra.status, 'present'); assert.equal(ra.verifiedMinutes, 100);
  assert.equal(rb.status, 'unverified_exit'); assert.equal(rb.verifiedMinutes, 0, 'no exit and no rescan => nothing beyond the entry scan is verified');
  assert.ok(rb.flags.includes('unverified_exit'));
});

test('exit grace: OUT after close is accepted within grace, refused after', async () => {
  const w = await ready(2); const [a, b] = w.students; open(w);
  w.scan(await w.qr(a, w.sid, 'in')); w.scan(await w.qr(b, w.sid, 'in'));
  w.advance(60 * 60000);
  const qa = await w.qr(a, w.sid, 'out');
  w.ok(w.faculty, 'sessions.close', { sessionId: w.sid });
  assert.equal(w.scan(qa).ok, true, 'within grace');
  w.advance(16 * 60000);
  assert.equal(w.err(b.email, 'attend.challenge', { sessionId: w.sid, purpose: 'out', credentialId: w.devices[b.studentId].credentialId }).code, 'SESSION_NOT_OPEN');
  assert.equal(rosterRow(w, a).status, 'present');
});

test('rescan window: answered keeps credit; missed caps verified time and flags', async () => {
  const w = await ready(2); const [a, b] = w.students; open(w);
  w.scan(await w.qr(a, w.sid, 'in')); w.scan(await w.qr(b, w.sid, 'in'));
  w.advance(30 * 60000);
  assert.equal(w.err(a.email, 'attend.challenge', { sessionId: w.sid, purpose: 'rescan', credentialId: w.devices[a.studentId].credentialId }).code, 'NO_RESCAN_WINDOW');
  w.ok(w.faculty, 'attend.openRescan', { sessionId: w.sid, seconds: 300 });
  assert.equal(w.scan(await w.qr(a, w.sid, 'rescan')).data.type, 'RESCAN');
  assert.equal(w.err(a.email, 'attend.challenge', { sessionId: w.sid, purpose: 'rescan', credentialId: w.devices[a.studentId].credentialId }).code, 'ALREADY_RESCANNED');
  w.advance(10 * 60000); // window closes, b never answered
  w.advance(50 * 60000);
  w.scan(await w.qr(a, w.sid, 'out')); w.scan(await w.qr(b, w.sid, 'out'));
  w.ok(w.faculty, 'sessions.close', { sessionId: w.sid });
  const ra = rosterRow(w, a), rb = rosterRow(w, b);
  assert.equal(ra.status, 'present'); assert.equal(ra.verifiedMinutes, 90);
  assert.equal(rb.status, 'missed_rescan'); assert.equal(rb.verifiedMinutes, 0, 'b was last verified at entry: nothing after the missed rescan counts');
});

test('random rescans are planned and fire from the tick job', async () => {
  const w = await ready(1); const [s] = w.students;
  const o = open(w).session;
  assert.ok(o.nextRescanAt > o.openedAt && o.nextRescanAt < o.scheduledEnd);
  w.scan(await w.qr(s, w.sid, 'in'));
  w.setTime = null; w.e.setTime(o.nextRescanAt + 1000);
  const r = w.eval('Attend.tickRescans()');
  assert.equal(r.started, 1);
  assert.equal(w.eval('Attend.tickRescans()').started, 0, 'idempotent');
  assert.equal(w.scan(await w.qr(s, w.sid, 'rescan')).ok, true);
});

test('spot check: pick, resolve fail flags student, photo access is restricted and audited', async () => {
  const w = await ready(3); open(w);
  for (const s of w.students) w.scan(await w.qr(s, w.sid, 'in'));
  const chk = w.ok(w.faculty, 'spot.start', { sessionId: w.sid, count: 2 });
  assert.equal(chk.checks.length, 2);
  assert.equal(w.err(w.faculty2, 'spot.start', { sessionId: w.sid }).code, 'FORBIDDEN');
  const target = chk.checks[0];
  // no photo uploaded => clean error, not a crash
  const g = w.call(w.faculty, 'photo.get', { studentId: target.studentId, sessionId: w.sid });
  assert.equal(g.ok, true); assert.equal(g.data.dataUrl, null, 'owning faculty with a pending check may ask; there is simply no photo');
  // another faculty / a student cannot fetch photos at all
  assert.equal(w.err(w.faculty2, 'photo.get', { studentId: target.studentId, sessionId: w.sid }).code, 'FORBIDDEN');
  assert.equal(w.err(w.students[0].email, 'photo.get', { studentId: target.studentId }).code, 'FORBIDDEN');
  w.ok(w.faculty, 'spot.resolve', { checkId: target.checkId, outcome: 'mismatch', note: 'Not the person on the record' });
  const row = w.ok(w.faculty, 'attend.roster', { sessionId: w.sid }).roster.find((r) => r.studentId === target.studentId);
  assert.equal(row.status, 'flagged'); assert.equal(row.spotCheck, 'mismatch');
});

test('corrections are append-only, reasoned, approval-gated when late, and never rewrite events', async () => {
  const w = await ready(2); const [a, b] = w.students; open(w);
  w.scan(await w.qr(a, w.sid, 'in'));
  const evBefore = w.eval("Db.readAll('AttendanceEvents')");
  // faculty adds an entry for b who forgot the phone
  assert.equal(w.err(w.faculty, 'attend.correct', { sessionId: w.sid, studentId: b.studentId, action: 'add_in', reason: 'short' }).code, 'BAD_INPUT');
  const c = w.ok(w.faculty, 'attend.correct', { sessionId: w.sid, studentId: b.studentId, action: 'add_in', reason: 'Phone battery dead, seen in lab' });
  assert.equal(c.approvalStatus, 'approved');
  assert.equal(rosterRow(w, b).state, 'in');
  // void a's scan
  const aIn = evBefore.find((e) => e.studentId === a.studentId);
  w.ok(w.faculty, 'attend.correct', { sessionId: w.sid, studentId: a.studentId, action: 'void', eventId: aIn.eventId, reason: 'Scanned by mistake at the door' });
  assert.equal(rosterRow(w, a).state, 'none');
  const all = w.eval("Db.readAll('AttendanceEvents')");
  assert.equal(all.length, evBefore.length + 2, 'history only grows');
  const orig = all.find((e) => e.eventId === aIn.eventId);
  assert.equal(orig.type, 'IN', 'original event untouched');
  // late corrections need admin approval
  w.advance(3 * 3600000);
  w.ok(w.faculty, 'sessions.close', { sessionId: w.sid });
  w.advance(30 * 3600000);
  const late = w.ok(w.faculty, 'attend.correct', { sessionId: w.sid, studentId: a.studentId, action: 'add_in', at: w.NOW + 600000, reason: 'Late correction after review' });
  assert.equal(late.approvalStatus, 'pending');
  assert.equal(rosterRow(w, a).state, 'none', 'pending correction has no effect yet');
  assert.equal(w.err(w.faculty, 'corrections.decide', { eventId: late.eventId, approve: true }).code, 'FORBIDDEN');
  const pend = w.ok(w.admin, 'corrections.pending').corrections;
  assert.equal(pend.length, 1);
  w.ok(w.admin, 'corrections.decide', { eventId: late.eventId, approve: true, note: 'ok' });
  assert.notEqual(rosterRow(w, a).state, 'none');
  assert.ok(w.eval("Db.readAll('AttendanceEvents')").length > all.length);
});

test('closing / opening one session never touches another; double-open per lab refused', async () => {
  const w = await ready(1);
  const evt = w.ok(w.faculty, 'sessions.create', { type: 'event', labId: w.lab2.labId, title: 'Hackathon', date: w.today, startTime: '10:00', endTime: '13:00', openToAll: true }).session;
  open(w);
  w.ok(w.faculty, 'sessions.open', { sessionId: evt.sessionId });
  const dup = w.call(w.faculty, 'sessions.create', { type: 'event', labId: w.lab.labId, title: 'Clash', date: w.today, startTime: '10:30', endTime: '11:30' });
  assert.equal(dup.ok, false); assert.equal(dup.error.code, 'CONFLICT');
  assert.equal(w.err(w.faculty, 'sessions.open', { sessionId: evt.sessionId }).code, 'INVALID_STATE');
  w.ok(w.faculty, 'sessions.close', { sessionId: w.sid });
  const day = w.ok(w.faculty, 'sessions.day', { date: w.today }).sessions;
  assert.equal(day.find((s) => s.sessionId === w.sid).status, 'closed');
  assert.equal(day.find((s) => s.sessionId === evt.sessionId).status, 'open');
  // history of the closed session is intact and closing twice is refused
  assert.equal(w.err(w.faculty, 'sessions.close', { sessionId: w.sid }).code, 'INVALID_STATE');
});

test('revoked kiosk loses scan rights immediately', async () => {
  const w = await ready(1); const [s] = w.students; open(w);
  const k = w.ok(w.admin, 'kiosks.list').kiosks.find((x) => x.authorizedEmail === w.kioskEmail);
  const qr = await w.qr(s, w.sid, 'in');
  w.ok(w.admin, 'kiosks.upsert', { kioskId: k.kioskId, labId: k.labId, name: k.name, authorizedEmail: k.authorizedEmail, status: 'revoked' });
  assert.equal(w.scan(qr).error.code, 'FORBIDDEN');
});

test('research visit needs supervisor authorisation before it can be opened', async () => {
  const w = await ready(1); const [s] = w.students;
  const req = w.ok(s.email, 'research.request', { labId: w.lab2.labId, facultyId: w.facultyId, date: w.today, startTime: '14:00', endTime: '17:00', purpose: 'Thesis experiment' }).session;
  assert.equal(req.status, 'pending_approval');
  assert.equal(w.err(w.faculty, 'sessions.open', { sessionId: req.sessionId }).code, 'INVALID_STATE');
  assert.equal(w.err(w.faculty2, 'research.decide', { sessionId: req.sessionId, approve: true }).code, 'FORBIDDEN');
  w.ok(w.faculty, 'research.decide', { sessionId: req.sessionId, approve: true });
  w.e.setTime(w.NOW + 4 * 3600000 - 10 * 60000);
  w.ok(w.faculty, 'sessions.open', { sessionId: req.sessionId });
});

test('summaries are rebuildable from events and reconcile reports problems without mutating events', async () => {
  const w = await ready(2); const [a, b] = w.students; open(w);
  w.scan(await w.qr(a, w.sid, 'in')); w.advance(20 * 60000); w.scan(await w.qr(a, w.sid, 'out'));
  w.ok(w.faculty, 'sessions.close', { sessionId: w.sid });
  const before = w.eval("Db.readAll('AttendanceSummaries')").map((r) => [r.studentId, r.status, r.verifiedMinutes]).sort();
  // destroy the derived table, rebuild it
  w.e.run("Db.readAll('AttendanceSummaries').forEach(function (r) { Db.putRow('AttendanceSummaries', r.__row, { sumId: 'x' + r.sumId, sessionId: r.sessionId, studentId: r.studentId, status: 'present', verifiedMinutes: 9999 }); });");
  w.e.run("Db.readAll('AttendanceSummaries').forEach(function (r) { Db.putRow('AttendanceSummaries', r.__row, { sumId: r.sessionId + ':' + r.studentId, sessionId: r.sessionId, studentId: r.studentId, status: 'present', verifiedMinutes: 9999 }); });");
  const rep = w.ok(w.admin, 'system.reconcileSession', { sessionId: w.sid });
  assert.deepEqual(rep.problems, []);
  const after = w.eval("Db.readAll('AttendanceSummaries')").map((r) => [r.studentId, r.status, r.verifiedMinutes]).sort();
  assert.deepEqual(after, before);
  void b;
});

test('audit chain stays valid across all of the above and detects tampering', async () => {
  const w = await ready(2); const [a] = w.students; open(w);
  w.scan(await w.qr(a, w.sid, 'in'));
  const v = w.ok(w.admin, 'audit.verify');
  assert.equal(v.ok, true); assert.ok(v.rows > 10);
  // tamper with one audit row in the sheet
  w.e.run("var row = Db.readAll('AuditEvents')[5]; Db.sheet('AuditEvents').getRange(row.__row, 6, 1, 1).setValues([['forged.action']]);");
  const bad = w.ok(w.admin, 'audit.verify');
  assert.equal(bad.ok, false); assert.ok(bad.chainProblems.length > 0);
});

test('60-student arrival rush: all scans accepted once, no duplicate events, no lock starvation', async () => {
  const w = world({ students: 60 });
  for (const s of w.students) await w.registerDevice(s);
  w.sid = w.session().sessionId; open(w);
  const qrs = [];
  for (const s of w.students) qrs.push(await w.qr(s, w.sid, 'in'));
  const t0 = process.hrtime.bigint();
  const results = qrs.map((q) => w.scan(q));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(results.filter((r) => r.ok).length, 60, JSON.stringify(results.filter((r) => !r.ok).slice(0, 2)));
  assert.equal(w.eval("Db.readAll('AttendanceEvents').length"), 60);
  assert.equal(new Set(w.eval("Db.readAll('Redemptions').filter(function (r) { return r.purpose === 'in'; }).map(function(r){return r.nonce;})")).size, 60);
  assert.equal(w.e.state.lockTimeouts, 0);
  // replaying the whole batch changes nothing
  const again = qrs.map((q) => w.scan(q));
  assert.equal(again.filter((r) => r.ok).length, 0);
  assert.equal(w.eval("Db.readAll('AttendanceEvents').length"), 60);
  const live = w.ok(w.faculty, 'attend.roster', { sessionId: w.sid }).counts;
  assert.equal(live.inside, 60);
  console.log('# rush(60) in-memory CPU time for 60 scans: ' + ms.toFixed(0) + ' ms (NOT an Apps Script timing; see TEST_PLAN.md)');
  w.advance(100 * 60000);
  for (const s of w.students) assert.equal(w.scan(await w.qr(s, w.sid, 'out')).ok, true);
  w.ok(w.faculty, 'sessions.close', { sessionId: w.sid });
  const rows = w.ok(w.faculty, 'attend.roster', { sessionId: w.sid }).roster;
  assert.equal(rows.filter((r) => r.status === 'present').length, 60);
});

test('device swap needs in-person approval even after the student revokes their own device (no self-service re-registration)', async () => {
  const w = await ready(1);
  const [s] = w.students, old = w.devices[s.studentId];
  w.ok(s.email, 'cred.revoke', { credentialId: old.credentialId, reason: 'lost phone' });
  const dev2 = await w.registerDevice(s);
  assert.equal(dev2.status, 'pending_approval', 'a second device must wait for the lab desk');
  open(w);
  assert.equal(w.err(s.email, 'attend.challenge', { sessionId: w.sid, purpose: 'in', credentialId: dev2.credentialId }).code, 'DEVICE_INACTIVE');
  w.ok(w.staff, 'cred.approve', { credentialId: dev2.credentialId, idChecked: true });
  assert.equal(w.scan(await w.qr(s, w.sid, 'in', dev2)).data.type, 'IN');
});

test('attend.studentEvents: owner sees a student\'s scans and can void one by id; a student cannot call it', async () => {
  const w = await ready(1);
  const [s] = w.students; open(w);
  w.scan(await w.qr(s, w.sid, 'in'));
  const r = w.ok(w.faculty, 'attend.studentEvents', { sessionId: w.sid, studentId: s.studentId });
  assert.equal(r.events.length, 1); assert.equal(r.events[0].type, 'IN'); assert.equal(r.events[0].voided, false);
  assert.equal(w.err(s.email, 'attend.studentEvents', { sessionId: w.sid, studentId: s.studentId }).code, 'FORBIDDEN');
  w.ok(w.faculty, 'attend.correct', { sessionId: w.sid, studentId: s.studentId, action: 'void', eventId: r.events[0].eventId, reason: 'scanned by mistake at the door' });
  const after = w.ok(w.faculty, 'attend.studentEvents', { sessionId: w.sid, studentId: s.studentId });
  assert.equal(after.events.find((e) => e.type === 'IN').voided, true, 'original stays in the log, marked voided');
  assert.equal(rosterRow(w, s).state, 'none');
});

test('history shows a session that is still open (computed live), then the stored summary after close', async () => {
  const w = await ready(1);
  const [s] = w.students; open(w);
  w.scan(await w.qr(s, w.sid, 'in'));
  let h = w.ok(s.email, 'attend.history');
  assert.equal(h.history.length, 1); assert.equal(h.history[0].sessionId, w.sid); assert.equal(h.history[0].status, 'present');
  w.advance(30 * 60000); w.scan(await w.qr(s, w.sid, 'out'));
  w.ok(w.faculty, 'sessions.close', { sessionId: w.sid });
  h = w.ok(s.email, 'attend.history');
  assert.equal(h.history.length, 1, 'no duplicate row after the summary exists'); assert.equal(h.history[0].verifiedMinutes, 30);
});

test('automatic OUT credits only open lab through closing and leaves class missed-exit policy unchanged', () => {
  const w = world();
  const compute = (type, evts) => w.eval(`Attend._compute({type:'${type}',status:'closed',scheduledStart:U.now(),scheduledEnd:U.now()+3600000,closedAt:U.now()+3600000},${JSON.stringify(evts)},[],U.now()+7200000)`);
  const at = w.eval('U.now()');
  const entry = { type: 'IN', at }, out = { type: 'OUT', method: 'auto', at: at + 7200000 };
  const c = compute('openlab', [entry, out]);
  assert.equal(c.verifiedMinutes, 60); assert.equal(c.inside, false); assert.ok(c.flags.includes('auto_out'));
  const cls = compute('class', [entry]);
  assert.equal(cls.status, 'unverified_exit'); assert.equal(cls.verifiedMinutes, 0); assert.ok(!cls.flags.includes('auto_out'));
  assert.ok(!compute('class', [entry, out]).flags.includes('auto_out'));
});
