const test = require('node:test');
const assert = require('node:assert/strict');
const { world, genDevice, signWith } = require('./fixtures');
const row = (w, s) => w.eval(`Db.get('StudentProfiles',${JSON.stringify(s.studentId)})`);
function beforeLock(w, code) {
  // Arm after RPC identity resolution, so a login timestamp write cannot consume the interleaving.
  w.e.run(`var recoveryVerifyStudent = Users.verifyStudent; Users.verifyStudent = function(ctx, p) {
    Users.verifyStudent = recoveryVerifyStudent;
    var recoveryLock = Locks.with; Locks.with = function(fn, timeout) { Locks.with = recoveryLock; ${code} return recoveryLock(fn, timeout); };
    return recoveryVerifyStudent(ctx,p); };`);
}

for (const state of ['disabled', 'unlinked']) test('verification rechecks a profile ' + state + ' while waiting for the lock', () => {
  const w = world({ students: 1 }), [s] = w.students;
  beforeLock(w, `Db.update('StudentProfiles',${JSON.stringify(s.studentId)},${JSON.stringify(state === 'disabled' ? { status: 'disabled' } : { status: 'imported', userId: '', email: '' })});`);
  assert.equal(w.err(w.staff, 'students.verify', { studentId: s.studentId, approve: true }).code, 'INVALID_STATE');
  assert.equal(row(w, s).status, state === 'disabled' ? 'disabled' : 'imported');
});

test('unlink holds the lock across credential revocation and profile detachment', async () => {
  const w = world({ students: 1 }), [s] = w.students;
  const dev = await genDevice(), ch = w.ok(s.email, 'cred.begin');
  const payload = { challenge: ch.challenge, publicKey: dev.publicKey, signature: await signWith(dev, ch.challenge), label: 'Racing phone' };
  w.e.run(`var recoveryRevoke = Creds.revokeAllFor, recoveryStudent = Auth._contextForEmail(${JSON.stringify(s.email)});
    Creds.revokeAllFor = function(id, actor, reason) { recoveryRevoke(id, actor, reason);
      if (!Locks.depth) Creds.completeRegistration(recoveryStudent,${JSON.stringify(payload)}); };`);
  w.ok(w.admin, 'students.unlink', { studentId: s.studentId, reason: 'Wrong account recovery' });
  assert.equal(row(w, s).userId, '');
  assert.equal(w.eval("Db.readAll('DeviceCredentials').filter(function(c){return c.status==='active'||c.status==='pending_approval';}).length"), 0);
});

test('stale desk reviews cannot verify, reject or unlink a different claim', () => {
  const w = world({ students: 1 }), [s] = w.students;
  for (const action of ['students.verify', 'students.unlink']) {
    const p = { studentId: s.studentId, expectedEmail: 'old.claim@karunya.edu', reason: 'Reviewed a different account' };
    for (const approve of action === 'students.verify' ? [true, false] : [undefined]) {
      assert.equal(w.err(action === 'students.unlink' ? w.admin : w.staff, action, { ...p, approve }).code, 'CONFLICT');
    }
  }
  assert.equal(row(w, s).email, s.email);
  assert.equal(row(w, s).status, 'verified');
});

test('an old account cannot finish device registration after unlink and a new claim', async () => {
  const w = world({ students: 1 }), [s] = w.students;
  // Model a first-claim profile, whose imported record has no bound email.
  w.e.run(`Db.update('StudentProfiles',${JSON.stringify(s.studentId)},{importedEmail:''});`);
  const dev = await genDevice(), ch = w.ok(s.email, 'cred.begin');
  const payload = { challenge: ch.challenge, publicKey: dev.publicKey, signature: await signWith(dev, ch.challenge), label: 'Old account phone' };
  w.e.run(`var recoveryVerify = Creds.verifySignature; Creds.verifySignature = function(pub,msg,sig) {
    var ok = recoveryVerify(pub,msg,sig); Creds.verifySignature = recoveryVerify;
    Users.unlinkStudent(Auth._contextForEmail(${JSON.stringify(w.admin)}),{studentId:${JSON.stringify(s.studentId)},reason:'Recover wrong first claim'});
    Users.onboard(Auth._contextForEmail('new.claim@karunya.edu'),{rollNo:${JSON.stringify(s.rollNo)},name:'New Claim',mobile:'9876543210',consent:true}); return ok; };`);
  assert.equal(w.err(s.email, 'cred.complete', payload).code, 'FORBIDDEN');
  assert.equal(row(w, s).email, 'new.claim@karunya.edu');
  assert.equal(w.eval("Db.readAll('DeviceCredentials').length"), 0);
});

test('reject, disable and re-enable never turns a rejected claim into a verified student', () => {
  const w = world({ students: 1 }), [s] = w.students;
  w.ok(w.staff, 'students.verify', { studentId: s.studentId, approve: false });
  w.ok(w.staff, 'students.status', { studentId: s.studentId, status: 'disabled', reason: 'Needs identity review' });
  const next = w.ok(w.staff, 'students.status', { studentId: s.studentId, status: 'enabled' }).student;
  assert.equal(next.status, 'pending');
  assert.equal(w.err(s.email, 'cred.begin').code, 'NOT_VERIFIED');
});

test('desk authorization is refreshed after waiting for the recovery lock', () => {
  const w = world({ students: 1 }), [s] = w.students;
  beforeLock(w, `Db.update('Users',Db.getBy('Users','email',${JSON.stringify(w.staff)}).userId,{roles:'faculty'});`);
  assert.equal(w.err(w.staff, 'students.verify', { studentId: s.studentId, approve: false }).code, 'FORBIDDEN');
  assert.equal(row(w, s).status, 'verified');
});

test('unlink revokes every device, is retryable and preserves history for the next claim', async () => {
  const w = world({ students: 1 }), [s] = w.students;
  await w.registerDevice(s); await w.registerDevice(s);
  const sid = w.session().sessionId;
  w.ok(w.faculty, 'sessions.open', { sessionId: sid });
  assert.equal(w.checkin(s, { sessionId: sid }).ok, true);
  w.ok(w.admin, 'students.unlink', { studentId: s.studentId, reason: 'Desk verified wrong account' });
  w.ok(w.admin, 'students.unlink', { studentId: s.studentId, reason: 'Retry uncertain response' });
  assert.ok(w.ok(w.admin, 'cred.list', { studentId: s.studentId }).credentials.every((c) => c.status === 'revoked'));
  assert.equal(w.eval("Db.readAll('AttendanceEvents').length"), 1);
  assert.equal(w.ok(s.email, 'onboard', { rollNo: s.rollNo, name: 'Student One', mobile: '9876543210', consent: true }).student.studentId, s.studentId);
  assert.equal((await w.registerDevice(s)).status, 'pending_approval');
});
