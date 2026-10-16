const test = require('node:test');
const assert = require('node:assert/strict');
const { world } = require('./fixtures');

test('identity: no Google identity fails closed, wrong domain refused, nothing client-supplied is trusted', () => {
  const w = world({ students: 1 });
  w.e.state.activeUser = '';
  let r = JSON.parse(w.e.run("JSON.stringify(rpc('me', {}))"));
  assert.equal(r.ok, false); assert.equal(r.error.code, 'NO_IDENTITY');
  assert.equal(w.err('someone@gmail.com', 'me').code, 'DOMAIN_NOT_ALLOWED');
  assert.equal(w.err('evil@karunya.edu.evil.com', 'me').code, 'DOMAIN_NOT_ALLOWED');
  // A student claiming to be admin through the payload gets nothing: roles come from the server.
  const s = w.students[0];
  assert.equal(w.err(s.email, 'users.list', { role: 'admin', email: w.admin }).code, 'FORBIDDEN');
  assert.equal(w.err(s.email, 'settings.get').code, 'FORBIDDEN');
});

test('both institutional domains are accepted', () => {
  const w = world({ students: 0 });
  assert.equal(w.ok('x@karunya.edu.in', 'me').onboardingRequired, true);
  assert.equal(w.ok('y@karunya.edu', 'me').onboardingRequired, true);
});

test('unknown / prototype-chain actions do not exist', () => {
  const w = world({ students: 0 });
  for (const a of ['nope', 'constructor', '__proto__', 'toString', 'hasOwnProperty', '']) assert.equal(w.err(w.admin, a).code, 'NOT_FOUND', a);
  assert.equal(w.err(w.admin, 'Setup.initialise').code, 'NOT_FOUND');
});

test('permission table: every route points at a real handler and role set', () => {
  const w = world({ students: 0 });
  const routes = w.eval("Object.keys(ROUTES).map(function(k){ return { k: k, roles: ROUTES[k].roles, fn: typeof ROUTES[k].fn }; })");
  assert.ok(routes.length > 90);
  const valid = new Set(['any', 'user', 'student', 'faculty', 'staff', 'admin', 'kiosk']);
  for (const r of routes) { assert.equal(r.fn, 'function', r.k); assert.ok(r.roles.length > 0, r.k); r.roles.forEach((x) => assert.ok(valid.has(x), r.k + ':' + x)); }
  // every write-ish admin route is admin only
  for (const r of routes) if (/^(users|settings|kiosks|labs|timetable|audit|system)\./.test(r.k) && !/\.(list|occupancy)$/.test(r.k)) assert.deepEqual(r.roles, ['admin'], r.k);
});

test('role matrix: every route denies roles not listed (backend enforcement, not UI)', () => {
  const w = world({ students: 1 });
  const roleUser = { student: w.students[0].email, faculty: w.faculty, staff: w.staff, admin: w.admin };
  const routes = w.eval("Object.keys(ROUTES).map(function(k){ return { k: k, roles: ROUTES[k].roles }; })");
  let denied = 0;
  for (const r of routes) {
    for (const role of Object.keys(roleUser)) {
      if (r.roles.includes(role) || r.roles.includes('any') || r.roles.includes('user')) continue;
      const res = w.call(roleUser[role], r.k, {});
      assert.equal(res.ok, false, r.k + ' allowed ' + role);
      assert.equal(res.error.code, 'FORBIDDEN', r.k + ' as ' + role + ' -> ' + res.error.code);
      denied++;
    }
  }
  assert.ok(denied > 200, 'denied checks run: ' + denied);
  // denials are audited
  const audit = w.ok(w.admin, 'audit.list', { action: 'rpc.denied', limit: 5 });
  assert.ok(audit.events.length > 0);
});

test('kiosk accounts only reach kiosk routes', () => {
  const w = world({ students: 1 });
  const k = w.kioskEmail;
  assert.equal(w.err(k, 'sessions.mine').code, 'FORBIDDEN');
  assert.equal(w.err(k, 'users.list').code, 'FORBIDDEN');
  assert.equal(w.ok(k, 'kiosk.ping').kiosk.name, 'IoT door');
  assert.equal(w.err(w.students[0].email, 'kiosk.scan', { qr: 'x' }).code, 'FORBIDDEN');
});

test('oversized and malformed payloads are rejected before any work', () => {
  const w = world({ students: 0 });
  assert.equal(w.err(w.admin, 'labs.upsert', { code: 'X', name: 'y'.repeat(200000), type: 'iot' }).code, 'TOO_LARGE');
  assert.equal(w.err(w.admin, 'labs.upsert', { code: 'bad code!', name: 'x', type: 'iot' }).code, 'BAD_INPUT');
  assert.equal(w.err(w.admin, 'labs.upsert', { code: 'OK', name: 'x', type: 'nonsense' }).code, 'BAD_INPUT');
  const r = JSON.parse(w.e.run("JSON.stringify(rpc('labs.upsert', null))"));
  assert.equal(r.ok, false);
});

test('unexpected server errors never leak details and are logged', () => {
  const w = world({ students: 0 });
  w.e.run("Labs.list = function(){ throw new TypeError('secret internals /x/y'); }");
  const err = w.err(w.admin, 'labs.list');
  assert.equal(err.code, 'INTERNAL'); assert.ok(!/secret/.test(JSON.stringify(err))); assert.match(err.message, /Reference E/);
  const log = w.ok(w.admin, 'system.status').recentErrors;
  assert.ok(log.some((l) => l.code === 'UNEXPECTED'));
});

test('student can see only own data: loans, history, credentials, reports', async () => {
  const w = world({ students: 2 });
  const [a, b] = w.students;
  assert.equal(w.err(a.email, 'reports.run', { type: 'inventory' }).code, 'FORBIDDEN');
  // student report ignores any studentId in payload and returns the caller's own
  const rep = w.ok(a.email, 'reports.run', { type: 'student', studentId: b.studentId });
  assert.match(rep.title, /Student 1/);
  assert.equal(w.err(a.email, 'cred.list', { studentId: b.studentId }).code, 'FORBIDDEN');
  assert.deepEqual(w.ok(a.email, 'cred.mine').credentials, []);
  // another student's loan is not viewable
  const cat = w.ok(w.staff, 'categories.upsert', { name: 'Sensors', trackingMode: 'quantity' }).category;
  const asset = w.ok(w.staff, 'assets.upsert', { labId: w.lab.labId, categoryId: cat.categoryId, name: 'DHT11', quantityTotal: 10 }).asset;
  const loan = w.ok(w.staff, 'loans.issue', { idemKey: 'k'.repeat(20), borrowerType: 'student', borrowerId: b.studentId, labId: w.lab.labId, items: [{ assetId: asset.assetId, qty: 2 }] }).loan;
  assert.equal(w.err(a.email, 'loans.get', { loanId: loan.loanId }).code, 'FORBIDDEN');
  assert.equal(w.ok(b.email, 'loans.get', { loanId: loan.loanId }).loan.loanId, loan.loanId);
  assert.equal(w.ok(a.email, 'loans.mine').loans.length, 0);
});

test('faculty cannot act on another faculty member\'s session or read other students', () => {
  const w = world({ students: 1 });
  const s = w.session();
  assert.equal(w.err(w.faculty2, 'sessions.open', { sessionId: s.sessionId }).code, 'FORBIDDEN');
  assert.equal(w.err(w.faculty2, 'attend.roster', { sessionId: s.sessionId }).code, 'FORBIDDEN');
  assert.equal(w.err(w.faculty2, 'attend.openRescan', { sessionId: s.sessionId }).code, 'FORBIDDEN');
  const f2 = w.ok(w.faculty2, 'students.list', {});
  assert.equal(f2.students.length, 0, 'faculty only sees students from their own courses/sessions');
  assert.ok(w.ok(w.faculty, 'students.list', {}).students.length >= 1);
  assert.equal(w.err(w.faculty2, 'reports.run', { type: 'student', studentId: w.students[0].studentId }).code, 'FORBIDDEN');
});

test('last administrator cannot be removed or disabled; role changes are audited', () => {
  const w = world({ students: 0 });
  const admin = w.ok(w.admin, 'users.list').users.find((u) => u.email === w.admin);
  assert.equal(w.err(w.admin, 'users.status', { userId: admin.userId, status: 'disabled' }).code, 'LAST_ADMIN');
  assert.equal(w.err(w.admin, 'users.upsert', { email: w.admin, displayName: 'Admin', roles: ['faculty'] }).code, 'LAST_ADMIN');
  w.ok(w.admin, 'users.upsert', { email: 'second@karunya.edu', displayName: 'Second Admin', roles: ['admin'] });
  w.ok(w.admin, 'users.status', { userId: admin.userId, status: 'disabled' });
  assert.equal(w.err(w.admin, 'me').code, 'ACCOUNT_DISABLED');
  const log = w.ok('second@karunya.edu', 'audit.list', { action: 'user.' }).events;
  assert.ok(log.length >= 1);
});

test('bootstrap admin only works while no admin exists', () => {
  const w = world({ students: 0 });
  w.e.run("PropertiesService.getScriptProperties().setProperty('BOOTSTRAP_ADMIN_EMAIL','hacker@karunya.edu')");
  assert.equal(w.ok('hacker@karunya.edu', 'me').roles.includes('admin'), false);
});

test('owner-only setup wrappers refuse web callers', () => {
  const w = world({ students: 0 });
  w.e.state.activeUser = 'student1@karunya.edu';
  assert.throws(() => w.e.run('setupSelfTest()'), /Owner only/);
  assert.throws(() => w.e.run('setupInstallTriggers()'), /Owner only/);
  w.e.state.activeUser = w.e.state.effectiveUser = 'owner@karunya.edu';
  assert.doesNotThrow(() => w.e.run('ownerOnly_()'));
});

test('include() is whitelisted', () => {
  const w = world({ students: 0 });
  assert.throws(() => w.e.run("include('Code')"), /Unknown include/);
  assert.ok(w.e.run("include('Styles')").includes('Styles'));
});

test('rate limit: a route with a small budget returns RATE_LIMITED after it is spent, per caller', () => {
  const w = world({ students: 0 });
  // 'onboard' allows 10 calls per 300 s. The limit is checked before the handler runs, so even failing calls count.
  const codes = [];
  for (let i = 0; i < 12; i++) codes.push(w.call('rl1@karunya.edu', 'onboard', {}).error.code);
  assert.equal(codes.indexOf('RATE_LIMITED'), 10, JSON.stringify(codes));
  // a different caller has their own budget
  assert.notEqual(w.call('rl2@karunya.edu', 'onboard', {}).error.code, 'RATE_LIMITED');
});
