const test = require('node:test');
const assert = require('node:assert/strict');
const { world } = require('./fixtures');

test('a wrong-email claim cannot reserve an imported roll or create a partial account', () => {
  const w = world({ students: 0 });
  w.ok(w.admin, 'students.import', { rows: [{ rollNo: 'SAUDIT01', name: 'Intended Student', email: 'intended@karunya.edu' }] });
  const payload = { rollNo: 'SAUDIT01', name: 'Wrong Student', consent: true, mobile: '9876543210' };
  assert.equal(w.err('wrong@karunya.edu', 'onboard', payload).code, 'FORBIDDEN');
  assert.equal(w.eval("Db.getBy('Users','email','wrong@karunya.edu')"), null);
  const untouched = w.eval("Db.getBy('StudentProfiles','rollNo','SAUDIT01')");
  assert.equal(untouched.status, 'imported');
  assert.ok(!untouched.userId);
  assert.equal(w.ok('intended@karunya.edu', 'onboard', payload).student.status, 'verified');
});

test('a duplicate roll claim fails without inserting an account', () => {
  const w = world({ students: 1 });
  const payload = { rollNo: w.students[0].rollNo, name: 'Another Student', consent: true, mobile: '9876543210' };
  assert.equal(w.err('duplicate@karunya.edu', 'onboard', payload).code, 'ROLL_TAKEN');
  assert.equal(w.eval("Db.getBy('Users','email','duplicate@karunya.edu')"), null);
  w.ok(w.admin, 'users.upsert', { email: 'existing@karunya.edu', displayName: 'Existing Student', roles: ['student'] });
  const before = w.eval("Db.getBy('Users','email','existing@karunya.edu')");
  assert.equal(w.err('existing@karunya.edu', 'onboard', payload).code, 'ROLL_TAKEN');
  const after = w.eval("Db.getBy('Users','email','existing@karunya.edu')");
  assert.equal(after.mobile, before.mobile);
  assert.equal(after.consentAt, before.consentAt);
});

test('a second onboarding request for the same account cannot claim another imported profile', () => {
  const w = world({ students: 0 });
  w.ok(w.admin, 'users.upsert', { email: 'claim@karunya.edu', displayName: 'Claim Student', roles: ['student'] });
  w.ok(w.admin, 'students.import', { rows: [{ rollNo: 'SAUDIT02', name: 'First' }, { rollNo: 'SAUDIT03', name: 'Second' }] });
  // Two requests resolved identity before either obtained the write lock.
  w.e.run("var originalOnboardLock = Locks.with; Locks.with = function (fn, timeout) { Locks.with = originalOnboardLock; Users.onboard(Auth._contextForEmail('claim@karunya.edu'), {rollNo:'SAUDIT02',name:'First Student',consent:true,mobile:'9876543210'}); return originalOnboardLock(fn, timeout); };");
  assert.equal(w.err('claim@karunya.edu', 'onboard', { rollNo: 'SAUDIT03', name: 'Second Student', consent: true, mobile: '9876543211' }).code, 'ALREADY_ONBOARDED');
  assert.equal(w.eval("Db.where('StudentProfiles',function(s){return s.email === 'claim@karunya.edu';}).length"), 1);
});
