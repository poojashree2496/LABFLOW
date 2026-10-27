const test = require('node:test');
const assert = require('node:assert/strict');
const { world } = require('./fixtures');
function beforeServiceLock(w, object, method, code) {
  w.e.run(`var identityMethod = ${object}.${method}; ${object}.${method} = function(ctx,p) {
    ${object}.${method} = identityMethod; var identityLock = Locks.with;
    Locks.with = function(fn, timeout) { Locks.with = identityLock; ${code} return identityLock(fn,timeout); };
    return identityMethod(ctx,p); };`);
}

for (const status of ['disabled', 'rejected']) test('replacement approval refuses a profile that became ' + status, async () => {
  const w = world({ students: 1 }), [s] = w.students;
  const old = await w.registerDevice(s), pending = await w.registerDevice(s);
  beforeServiceLock(w, 'Creds', 'approve', `Db.update('StudentProfiles',${JSON.stringify(s.studentId)},{status:${JSON.stringify(status)}});`);
  assert.equal(w.err(w.staff, 'cred.approve', { credentialId: pending.credentialId, idChecked: true }).code, status === 'disabled' ? 'ACCOUNT_DISABLED' : 'NOT_VERIFIED');
  const rows = w.ok(w.staff, 'cred.list', { studentId: s.studentId }).credentials;
  assert.equal(rows.find((c) => c.credentialId === old.credentialId).status, 'active');
  assert.equal(rows.find((c) => c.credentialId === pending.credentialId).status, 'pending_approval');
});

test('replacement approval refreshes desk authorization before changing either phone', async () => {
  const w = world({ students: 1 }), [s] = w.students;
  const old = await w.registerDevice(s), pending = await w.registerDevice(s);
  beforeServiceLock(w, 'Creds', 'approve', `Db.update('Users',Db.getBy('Users','email',${JSON.stringify(w.staff)}).userId,{roles:'faculty'});`);
  assert.equal(w.err(w.staff, 'cred.approve', { credentialId: pending.credentialId, idChecked: true }).code, 'FORBIDDEN');
  assert.equal(w.ok(w.admin, 'cred.list', { studentId: s.studentId }).credentials.find((c) => c.credentialId === old.credentialId).status, 'active');
});

test('a pending credential must belong to the account currently linked to its profile', async () => {
  const w = world({ students: 1 }), [s] = w.students;
  const old = await w.registerDevice(s), pending = await w.registerDevice(s);
  w.e.run(`Db.update('DeviceCredentials',${JSON.stringify(pending.credentialId)},{userEmail:'former@karunya.edu'});`);
  assert.equal(w.err(w.staff, 'cred.approve', { credentialId: pending.credentialId, idChecked: true }).code, 'CONFLICT');
  assert.equal(w.ok(w.staff, 'cred.list', { studentId: s.studentId }).credentials.find((c) => c.credentialId === old.credentialId).status, 'active');
});
