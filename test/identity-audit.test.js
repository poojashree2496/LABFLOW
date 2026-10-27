const test = require('node:test');
const assert = require('node:assert/strict');
const { world } = require('./fixtures');
const PHOTO = 'data:image/jpeg;base64,/9j/AQID';
const OTHER = 'data:image/jpeg;base64,/9j/BAUG';
const profile = (w, s) => w.eval(`Db.get('StudentProfiles',${JSON.stringify(s.studentId)})`);
function duringDecode(w, code) {
  w.e.run(`var identityDecode = Users._decodePhoto; Users._decodePhoto = function(p) {
    Users._decodePhoto = identityDecode; var bytes = identityDecode(p); ${code} return bytes; };`);
}
function beforeServiceLock(w, object, method, code) {
  w.e.run(`var identityMethod = ${object}.${method}; ${object}.${method} = function(ctx,p) {
    ${object}.${method} = identityMethod; var identityLock = Locks.with;
    Locks.with = function(fn, timeout) { Locks.with = identityLock; ${code} return identityLock(fn,timeout); };
    return identityMethod(ctx,p); };`);
}

test('a verified student cannot overwrite a reference photo added during their upload', () => {
  const w = world({ students: 1 }), [s] = w.students;
  duringDecode(w, `Users.setPhoto(Auth._contextForEmail(${JSON.stringify(w.staff)}),{studentId:${JSON.stringify(s.studentId)},photo:${JSON.stringify(OTHER)}});`);
  assert.equal(w.err(s.email, 'photo.set', { photo: PHOTO }).code, 'FORBIDDEN');
  assert.equal(w.ok(w.staff, 'photo.get', { studentId: s.studentId }).dataUrl, OTHER);
});

test('a former account cannot upload a photo after unlink and reclaim during decoding', () => {
  const w = world({ students: 1 }), [s] = w.students;
  w.e.run(`Db.update('StudentProfiles',${JSON.stringify(s.studentId)},{importedEmail:''});`);
  duringDecode(w, `Users.unlinkStudent(Auth._contextForEmail(${JSON.stringify(w.admin)}),{studentId:${JSON.stringify(s.studentId)},reason:'Recover the wrong account'});
    Users.onboard(Auth._contextForEmail('photo.new@karunya.edu'),{rollNo:${JSON.stringify(s.rollNo)},name:'New Owner',consent:true,mobile:'9876543210'});`);
  assert.equal(w.err(s.email, 'photo.set', { photo: PHOTO }).code, 'FORBIDDEN');
  assert.equal(profile(w, s).email, 'photo.new@karunya.edu');
  assert.equal(profile(w, s).photoFileId, '');
});

test('desk photo uploads refuse a stale reviewed account', () => {
  const w = world({ students: 1 }), [s] = w.students;
  assert.equal(w.err(w.staff, 'photo.set', { studentId: s.studentId, expectedEmail: 'former@karunya.edu', photo: PHOTO }).code, 'CONFLICT');
  assert.equal(profile(w, s).photoFileId, '');
});

test('delayed onboarding photos cannot attach to or return a newer claim', () => {
  const w = world({ students: 0 });
  w.ok(w.admin, 'students.import', { rows: [{ rollNo: 'PHOTO001', name: 'Photo Claim' }] });
  w.e.run(`var identityStore = Users._storePhoto; Users._storePhoto = function(p,bytes) {
    Users._storePhoto = identityStore;
    Users.unlinkStudent(Auth._contextForEmail(${JSON.stringify(w.admin)}),{studentId:p.studentId,reason:'Recover before delayed photo'});
    Users.onboard(Auth._contextForEmail('photo.reclaim@karunya.edu'),{rollNo:p.rollNo,name:'New Claim',consent:true,mobile:'9876543211'});
    return identityStore(p,bytes); };`);
  assert.equal(w.err('photo.first@karunya.edu', 'onboard', { rollNo: 'PHOTO001', name: 'First Claim', consent: true, mobile: '9876543210', photo: PHOTO }).code, 'CONFLICT');
  const p = w.eval("Db.getBy('StudentProfiles','rollNo','PHOTO001')");
  assert.equal(p.email, 'photo.reclaim@karunya.edu'); assert.equal(p.photoFileId, '');
});

test('faculty photo reads recheck a spot check resolved while waiting for the lock', () => {
  const w = world({ students: 1 }), [s] = w.students, sid = w.session().sessionId;
  w.ok(w.staff, 'photo.set', { studentId: s.studentId, photo: PHOTO });
  w.ok(w.faculty, 'sessions.open', { sessionId: sid }); assert.equal(w.checkin(s, { sessionId: sid }).ok, true);
  const check = w.ok(w.faculty, 'spot.start', { sessionId: sid, studentId: s.studentId }).checks[0];
  beforeServiceLock(w, 'Users', 'getPhoto', `Db.update('SpotChecks',${JSON.stringify(check.checkId)},{outcome:'confirmed'});`);
  assert.equal(w.err(w.faculty, 'photo.get', { studentId: s.studentId }).code, 'FORBIDDEN');
});

test('a delayed onboarding photo preserves a newer desk reference for the same claim', () => {
  const w = world({ students: 0 });
  w.e.run(`var identityStore = Users._storePhoto; Users._storePhoto = function(p,bytes) {
    Users._storePhoto = identityStore;
    Users.setPhoto(Auth._contextForEmail(${JSON.stringify(w.staff)}),{studentId:p.studentId,photo:${JSON.stringify(OTHER)}});
    return identityStore(p,bytes); };`);
  const s = w.ok('photo.delay@karunya.edu', 'onboard', { rollNo: 'PHOTO002', name: 'Delayed Photo', consent: true, mobile: '9876543210', photo: PHOTO }).student;
  assert.equal(w.ok(w.staff, 'photo.get', { studentId: s.studentId }).dataUrl, OTHER);
});

test('valid photo uploads preserve own-first-photo and staff-replacement permissions', () => {
  const w = world({ students: 1 }), [s] = w.students;
  assert.equal(w.ok(s.email, 'photo.set', { photo: PHOTO }).ok, true);
  assert.equal(w.err(s.email, 'photo.set', { photo: OTHER }).code, 'FORBIDDEN');
  w.ok(w.staff, 'photo.set', { studentId: s.studentId, expectedEmail: s.email, photo: OTHER });
  assert.equal(w.ok(w.staff, 'photo.get', { studentId: s.studentId }).dataUrl, OTHER);
  assert.equal(w.err(w.hod, 'photo.get', { studentId: s.studentId }).code, 'FORBIDDEN');
});

