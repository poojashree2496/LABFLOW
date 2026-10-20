const test = require('node:test');
const assert = require('node:assert/strict');
const { world } = require('./fixtures');

const CLIENT = '1234567890-abcdefg.apps.googleusercontent.com';
const b64u = (s) => Buffer.from(s, 'utf8').toString('base64url');

/** A Google-shaped ID token; the tokeninfo fake accepts it only when the signature segment is "google-signed". */
function idToken(w, claims, sig) {
  const c = Object.assign({ iss: 'https://accounts.google.com', aud: CLIENT, exp: Math.floor(w.e.get('U.now()') / 1000) + 3600, email_verified: true }, claims);
  return b64u('{"alg":"RS256","typ":"JWT"}') + '.' + b64u(JSON.stringify(c)) + '.' + (sig || 'google-signed');
}
function post(w, body) {
  w.e.state.activeUser = '';
  return JSON.parse(w.e.run('doPost({ postData: { contents: ' + JSON.stringify(typeof body === 'string' ? body : JSON.stringify(body)) + ' } }).getContent()'));
}
function api(w) {
  w.e.run("PropertiesService.getScriptProperties().setProperty('GOOGLE_CLIENT_ID', " + JSON.stringify(CLIENT) + ')');
  w.signIn = (email, claims, sig) => post(w, { action: 'auth.google', payload: { idToken: idToken(w, Object.assign({ email }, claims), sig) } });
  w.session = (email) => { const r = w.signIn(email); assert.equal(r.ok, true, JSON.stringify(r.error)); return r.data.session; };
  w.api = (session, action, payload) => post(w, { action, payload: payload || {}, session });
  return w;
}

test('hosted app: Google sign-in issues a session and every call runs as that account', () => {
  const w = api(world({ students: 1 }));
  const s = w.students[0];
  const ses = w.session(s.email);
  const me = w.api(ses, 'me');
  assert.equal(me.ok, true); assert.equal(me.data.email, s.email);
  // An email or role in the payload changes nothing.
  assert.equal(w.api(ses, 'users.list', { email: w.admin, role: 'admin' }).error.code, 'FORBIDDEN');
  assert.equal(w.api(w.session(w.admin), 'users.list').ok, true);
  assert.equal(w.e.state.fetches.length, 2, 'one tokeninfo call per sign-in, none per request');
});

test('hosted app: no session means no identity, even when Google cookies identify the owner (no CSRF)', () => {
  const w = api(world({ students: 0 }));
  w.e.state.activeUser = w.admin;
  const r = JSON.parse(w.e.run("doPost({ postData: { contents: JSON.stringify({ action: 'users.list', payload: {} }) } }).getContent()"));
  assert.equal(r.error.code, 'NO_IDENTITY');
  assert.equal(post(w, { action: 'me', payload: {}, session: 'x.y' }).error.code, 'NO_IDENTITY');
  assert.equal(post(w, 'not json').error.code, 'BAD_INPUT');
  assert.equal(post(w, { payload: {} }).error.code, 'BAD_INPUT');
});

test('hosted app: forged, foreign, expired or unverified Google tokens are refused', () => {
  const w = api(world({ students: 0 }));
  const email = 'new@karunya.edu.in';
  assert.equal(w.signIn(email, {}, 'forged').error.code, 'NO_IDENTITY', 'signature not verified by Google');
  assert.equal(w.signIn(email, { aud: '999-other.apps.googleusercontent.com' }).error.code, 'BAD_INPUT', 'token for another app');
  assert.equal(w.signIn(email, { iss: 'https://evil.example' }).error.code, 'BAD_INPUT');
  assert.equal(w.signIn(email, { exp: Math.floor(w.e.get('U.now()') / 1000) - 5 }).error.code, 'BAD_INPUT', 'expired');
  assert.equal(w.signIn(email, { email_verified: false }).error.code, 'NO_IDENTITY');
  assert.equal(w.signIn('someone@gmail.com').error.code, 'DOMAIN_NOT_ALLOWED');
  assert.equal(w.signIn('x@karunya.edu.evil.com').error.code, 'DOMAIN_NOT_ALLOWED');
  assert.equal(post(w, { action: 'auth.google', payload: { idToken: 'junk' } }).error.code, 'BAD_INPUT');
  assert.equal(w.e.state.fetches.length, 4, 'locally invalid tokens never reach Google');
  assert.equal(w.signIn(email).ok, true);
});

test('hosted app: tampered and expired sessions are refused; disabling the account takes effect at once', () => {
  const w = api(world({ students: 1 }));
  const s = w.students[0];
  const ses = w.session(s.email);
  const [body, sig] = ses.split('.');
  const other = b64u(JSON.stringify({ e: w.admin, x: Date.now() + 1e10 }));
  assert.equal(w.api(other + '.' + sig, 'me').error.code, 'NO_IDENTITY', 'body swapped');
  assert.equal(w.api(body + '.' + sig.slice(0, -2) + 'AA', 'me').error.code, 'NO_IDENTITY', 'signature altered');
  assert.equal(w.api(ses, 'me').ok, true);
  w.ok(w.admin, 'users.status', { userId: w.eval("Db.getBy('Users','email'," + JSON.stringify(s.email) + ').userId'), status: 'disabled' });
  assert.equal(w.api(ses, 'me').error.code, 'ACCOUNT_DISABLED');
  const adminSes = w.session(w.admin);
  w.advance(31 * 86400000);
  assert.equal(w.api(adminSes, 'me').error.code, 'SESSION_EXPIRED');
  w.e.run('Setup.rotateSessions()');
  assert.equal(w.api(w.session(w.admin), 'me').ok, true);
});

test('hosted app: sign-in refuses until the client ID is configured', () => {
  const w = world({ students: 0 });
  const r = post(w, { action: 'auth.google', payload: { idToken: idToken(w, { email: w.admin }) } });
  assert.equal(r.error.code, 'NOT_CONFIGURED');
});

test('doGet serves the page only to a visitor Google identifies; anonymous visitors get a pointer, not google.script.run', () => {
  const w = world({ students: 0 });
  w.e.state.activeUser = '';
  const anon = w.e.run('doGet({ parameter: {} })');
  assert.equal(anon.mime, 'JSON');
  assert.match(JSON.parse(anon.getContent()).data.open, /^https:/);
  w.e.state.activeUser = w.admin;
  assert.equal(w.e.run("doGet({ parameter: { k: 'abc' } }).template"), 'Index');
});

test('setup helpers validate the client ID and app URL', () => {
  const w = world({ students: 0 });
  assert.throws(() => w.e.run("Setup.setGoogleSignIn('not-an-id')"));
  assert.throws(() => w.e.run("Setup.setAppUrl('http://insecure.example')"));
  w.e.run('Setup.setGoogleSignIn(' + JSON.stringify(CLIENT) + ')');
  w.e.run("Setup.setAppUrl('https://labflow.vercel.app')");
  assert.equal(w.e.get('Setup.webAppUrl()'), 'https://labflow.vercel.app/');
  assert.throws(() => w.e.run("Setup.setAllowedDomains('not a domain')"));
  w.e.run("Setup.setAllowedDomains('karunya.edu.in, @Gmail.com')");
  assert.deepEqual(w.eval('Auth.allowedDomains()'), ['karunya.edu.in', 'gmail.com']);
});

// B2: the coordinator (staff) manages students
test('coordinator imports students, adds one to a course, disables and re-enables a profile; each action audited as staff', () => {
  const w = world({ students: 1 });
  const imp = w.ok(w.staff, 'students.import', { rows: [{ rollNo: 'URK25CS2001', name: 'Coord Import', email: 'coord.import@karunya.edu' }] });
  assert.equal(imp.created, 1);
  const r = w.ok(w.staff, 'roster.import', { courseId: w.course.courseId, rows: ['URK25CS2001'] });
  assert.equal(r.added, 1);
  const entry = w.ok(w.staff, 'roster.list', { courseId: w.course.courseId }).roster.find((x) => x.rollNo === 'URK25CS2001');
  const stu = w.ok(w.staff, 'students.list', { q: 'URK25CS2001' }).students[0];
  assert.equal(w.err(w.students[0].email, 'students.status', { studentId: stu.studentId, status: 'disabled', reason: 'test' }).code, 'FORBIDDEN');
  assert.equal(w.err(w.staff, 'students.status', { studentId: stu.studentId, status: 'disabled' }).code, 'BAD_INPUT', 'a reason is required');
  const off = w.ok(w.staff, 'students.status', { studentId: stu.studentId, status: 'disabled', reason: 'Left the programme' });
  assert.equal(off.student.status, 'disabled');
  assert.equal(w.ok(w.staff, 'students.status', { studentId: stu.studentId, status: 'disabled', reason: 'Left the programme' }).replayed, true);
  assert.equal(w.ok(w.staff, 'students.list', { q: 'URK25CS2001' }).students.length, 1, 'never deleted');
  const again = w.ok(w.staff, 'roster.import', { courseId: w.course.courseId, rows: ['URK25CS2001'] });
  assert.equal(again.errors.length, 1, 'a disabled student cannot be added to a roster');
  assert.equal(w.ok(w.staff, 'students.status', { studentId: stu.studentId, status: 'enabled' }).student.status, 'imported');
  w.ok(w.staff, 'roster.remove', { rosterId: entry.rosterId });
  const acts = w.ok(w.admin, 'audit.list', { limit: 100 }).events.filter((e) => e.actor === w.staff && ['students.import', 'roster.import', 'student.disable', 'student.enable', 'roster.remove'].includes(e.action));
  assert.ok(acts.length >= 5 && acts.every((e) => e.role === 'staff'), 'audited with role staff');
});

test('a disabled student cannot check in', () => {
  const w = world({ students: 1 });
  const s = w.students[0];
  w.ok(w.staff, 'students.status', { studentId: s.studentId, status: 'disabled', reason: 'Suspended' });
  const res = w.checkin(s);
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'ACCOUNT_DISABLED');
  w.ok(w.staff, 'students.status', { studentId: s.studentId, status: 'enabled' });
  const back = w.checkin(s);
  assert.notEqual(back.ok ? '' : back.error.code, 'ACCOUNT_DISABLED', 'enabled again, so the disabled refusal is gone');
});
