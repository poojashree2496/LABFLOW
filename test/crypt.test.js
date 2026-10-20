const test = require('node:test');
const assert = require('node:assert/strict');
const { world } = require('./fixtures');

// A2: phone numbers are encrypted at rest with AES-256-GCM. The sheet never holds a plain number, a changed value does not
// open, only the owner and a coordinator or super admin can read a number, and every reveal is audited.
const rows = (w) => w.eval("Db.readAll('Users').map(function (u) { return { email: u.email, mobile: u.mobile }; })");
const stored = (w, email) => rows(w).find((u) => u.email === email).mobile;
const key = () => 'issue-' + Math.random().toString(36).slice(2) + Date.now();

test('crypt: seal and open round-trip, fresh nonce each time, field bound in, unicode safe', () => {
  const w = world({ students: 0 });
  const a = w.eval("Crypt.seal('9876543210', 'Users.mobile')"), b = w.eval("Crypt.seal('9876543210', 'Users.mobile')");
  assert.match(a, /^enc1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
  assert.notEqual(a, b, 'the same number seals to a different value every time');
  assert.equal(a.split(':').length, 4);
  assert.ok(!a.includes('9876543210'));
  assert.equal(w.eval(`Crypt.open(${JSON.stringify(a)}, 'Users.mobile')`), '9876543210');
  assert.equal(w.eval(`Crypt.open(${JSON.stringify(b)}, 'Users.mobile')`), '9876543210');
  const u = w.eval("Crypt.open(Crypt.seal('नमस्ते ☎ 98765', 'x'), 'x')");
  assert.equal(u, 'नमस्ते ☎ 98765');
  assert.equal(w.eval("Crypt.open(Crypt.seal('', 'x'), 'x')"), '');
  // sealed for one field does not open as another
  assert.equal(w.eval(`(function () { try { Crypt.open(${JSON.stringify(a)}, 'Users.email'); return 'opened'; } catch (e) { return e.code; } })()`), 'INTEGRITY');
});

test('crypt: the stored form is standard AES-256-GCM (Node\'s own implementation opens it, and the reverse)', () => {
  const nodeCrypto = require('node:crypto');
  const w = world({ students: 0 });
  const secret = w.eval("PropertiesService.getScriptProperties().getProperty('PII_KEY')");
  assert.ok(secret && secret.length >= 32);
  const key = nodeCrypto.createHmac('sha256', secret).update('enc').digest();
  const b64u = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const sealed = w.eval("Crypt.seal('9876543210', 'Users.mobile')").split(':');
  const d = nodeCrypto.createDecipheriv('aes-256-gcm', key, b64u(sealed[1]));
  d.setAAD(Buffer.from('Users.mobile')); d.setAuthTag(b64u(sealed[3]));
  assert.equal(Buffer.concat([d.update(b64u(sealed[2])), d.final()]).toString('utf8'), '9876543210');
  // a value produced by Node opens in the app
  const iv = nodeCrypto.randomBytes(12), c = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from('Users.mobile'));
  const ct = Buffer.concat([c.update('9123456789', 'utf8'), c.final()]), tag = c.getAuthTag();
  const enc = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(w.eval(`Crypt.open(${JSON.stringify('enc1:' + enc(iv) + ':' + enc(ct) + ':' + enc(tag))}, 'Users.mobile')`), '9123456789');
});

test('crypt: changing any character of any part makes the value fail to open', () => {
  const w = world({ students: 0 });
  const sealed = w.eval("Crypt.seal('9876543210', 'Users.mobile')");
  const parts = sealed.split(':');
  const flip = (c) => (c === 'A' ? 'B' : 'A');
  const attempts = [];
  for (let p = 1; p <= 3; p++) for (let i = 0; i < parts[p].length; i++) {
    const changed = parts.slice(); changed[p] = parts[p].slice(0, i) + flip(parts[p][i]) + parts[p].slice(i + 1);
    attempts.push(changed.join(':'));
  }
  attempts.push(sealed.replace('enc1:', 'enc2:'), parts.slice(0, 3).join(':'), parts[0] + ':' + parts[1] + ':' + parts[3] + ':' + parts[2], 'enc1:::', '9876543210');
  let opened = 0;
  for (const bad of attempts) {
    const r = w.eval(`(function () { try { return { v: Crypt.open(${JSON.stringify(bad)}, 'Users.mobile') }; } catch (e) { return { code: e.code }; } })()`);
    if (r.v !== undefined && bad !== sealed) opened++;
    else assert.equal(r.code, 'INTEGRITY');
  }
  assert.equal(opened, 0, attempts.length + ' altered values tried; none may open');
  assert.ok(attempts.length > 50);
});

test('crypt: a different key cannot open a value, and a missing key fails closed', () => {
  const w = world({ students: 0 });
  const sealed = w.eval("Crypt.seal('9876543210', 'Users.mobile')");
  w.e.run("PropertiesService.getScriptProperties().setProperty('PII_KEY', 'a-completely-different-key')");
  assert.equal(w.eval(`(function () { try { Crypt.open(${JSON.stringify(sealed)}, 'Users.mobile'); return 'opened'; } catch (e) { return e.code; } })()`), 'INTEGRITY');
  w.e.run("PropertiesService.getScriptProperties().deleteProperty('PII_KEY')");
  assert.equal(w.eval("(function () { try { Crypt.seal('1', 'x'); return 'sealed'; } catch (e) { return e.code; } })()"), 'NOT_CONFIGURED');
});

test('crypt: mask shows six dots and the last four digits', () => {
  const w = world({ students: 0 });
  assert.equal(w.eval("Crypt.mask('9876541021')"), '••••••1021');
  assert.equal(w.eval("Crypt.mask('')"), '');
  assert.equal(w.eval("Crypt.mask('123')"), '••••');
  assert.equal(w.eval("Crypt.mask(undefined)"), '');
});

test('the sheet never holds a plain number: onboarding, profile updates and fixtures all store sealed values', () => {
  const w = world({ students: 2 });
  w.ok('new.student@karunya.edu', 'onboard', { rollNo: 'URK24CS7777', name: 'New Student', consent: true, mobile: '9123456780' });
  w.ok(w.staff, 'profile.update', { consent: true, mobile: '9000000001' });
  const all = rows(w).filter((u) => u.mobile);
  assert.ok(all.length >= 4);
  for (const u of all) assert.match(u.mobile, /^enc1:/, u.email + ' holds a plain number');
  assert.ok(!JSON.stringify(rows(w)).match(/[6-9]\d{9}/), 'no ten-digit number anywhere in the Users sheet');
  // the owner of the number always gets it back in full
  assert.equal(w.ok('new.student@karunya.edu', 'me').mobile, '9123456780');
  assert.equal(w.ok(w.staff, 'me').mobile, '9000000001');
  // changing the number seals the new one
  w.ok('new.student@karunya.edu', 'profile.update', { mobile: '9123456781' });
  assert.match(stored(w, 'new.student@karunya.edu'), /^enc1:/);
  assert.equal(w.ok('new.student@karunya.edu', 'me').mobile, '9123456781');
  // profileIncomplete still works
  assert.equal(w.ok('new.student@karunya.edu', 'me').profileIncomplete, false);
});

test('nobody else receives a number: directories, lists and reports carry none, and loans show only the masked form', () => {
  const w = world({ students: 2 }); const [a] = w.students;
  w.ok(a.email, 'profile.update', { mobile: '9876541021' });
  for (const who of [w.admin, w.staff, w.hod, w.faculty]) {
    for (const [action, payload] of [['students.list', { limit: 100 }], ['users.list', {}], ['directory.faculty', {}]]) {
      const r = w.call(who, action, payload);
      assert.ok(!JSON.stringify(r).includes('9876541021'), action + ' leaked a number to ' + who);
      assert.ok(!JSON.stringify(r).includes('enc1:'), action + ' leaked sealed data to ' + who);
    }
  }
  const cat = w.ok(w.staff, 'categories.upsert', { name: 'Arduino', trackingMode: 'individual' }).category;
  const asset = w.ok(w.staff, 'assets.upsert', { labId: w.lab.labId, categoryId: cat.categoryId, name: 'Arduino #1', assetTag: 'ARD-001', serialNo: 'S1', valueInr: 1000 }).asset;
  const loan = w.ok(w.staff, 'loans.issue', { idemKey: key(), borrowerType: 'student', borrowerId: a.studentId, labId: w.lab.labId, items: [{ assetId: asset.assetId, qty: 1 }] }).loan;
  for (const who of [w.staff, w.admin, w.hod]) {
    const got = w.ok(who, 'loans.get', { loanId: loan.loanId });
    assert.equal(got.loan.borrowerMobile, '••••••1021');
    assert.ok(!JSON.stringify(got).includes('9876541021'));
  }
});

test('reveal: staff and admin can read one number, it is audited with who asked, and no one else can', () => {
  const w = world({ students: 2 }); const [a, b] = w.students;
  w.ok(a.email, 'profile.update', { mobile: '9876541021' });
  const r = w.ok(w.staff, 'users.revealMobile', { studentId: a.studentId, reason: 'Loan overdue, calling the borrower' });
  assert.equal(r.mobile, '9876541021'); assert.equal(r.rollNo, a.rollNo);
  assert.equal(w.ok(w.admin, 'users.revealMobile', { studentId: a.studentId }).mobile, '9876541021');
  const audit = w.eval("Db.readAll('AuditEvents').filter(function (e) { return e.action === 'pii.reveal'; })");
  assert.equal(audit.length, 2);
  assert.equal(audit[0].actor, w.staff); assert.equal(audit[0].role, 'staff'); assert.equal(audit[0].entityId, a.studentId);
  assert.equal(audit[1].actor, w.admin);
  assert.ok(!JSON.stringify(audit).includes('9876541021'), 'the audit trail records that a reveal happened, never the number');
  assert.ok(JSON.stringify(audit[0].detail).includes('Loan overdue'));
  for (const who of [a.email, w.faculty, w.hod, b.email]) assert.equal(w.err(who, 'users.revealMobile', { studentId: a.studentId }).code, 'FORBIDDEN', who);
  assert.equal(w.err(w.staff, 'users.revealMobile', { studentId: 'bad' }).code, 'BAD_INPUT');
  assert.equal(w.err(w.staff, 'users.revealMobile', { studentId: 'STU-' + '0'.repeat(12) }).code, 'NOT_FOUND');
});

test('reveal is rate-limited so it cannot be used to harvest numbers', () => {
  const w = world({ students: 1 }); const [a] = w.students;
  let refused = null;
  for (let i = 0; i < 40 && !refused; i++) { const res = w.call(w.staff, 'users.revealMobile', { studentId: a.studentId }); if (!res.ok) refused = res.error.code; }
  assert.equal(refused, 'RATE_LIMITED');
});

test('migration: plain numbers are sealed once, running it again changes nothing, and the nightly job does it too', () => {
  const w = world({ students: 2 }); const [a, b] = w.students;
  w.ok(a.email, 'profile.update', { mobile: '9876541021' });
  const userA = w.eval(`Db.get('StudentProfiles', ${JSON.stringify(a.studentId)}).userId`), userB = w.eval(`Db.get('StudentProfiles', ${JSON.stringify(b.studentId)}).userId`);
  // simulate a sheet from before A2
  w.eval(`Db.update('Users', ${JSON.stringify(userA)}, { mobile: '9876541021' }).userId`);
  w.eval(`Db.update('Users', ${JSON.stringify(userB)}, { mobile: '9876541022' }).userId`);
  assert.ok(rows(w).some((u) => u.mobile === '9876541021'));
  assert.equal(w.ok(a.email, 'me').mobile, '9876541021', 'a not-yet-migrated number still reads');
  const first = w.eval('Users.encryptMobiles()');
  assert.equal(first.sealed, 2);
  for (const u of rows(w).filter((x) => x.mobile)) assert.match(u.mobile, /^enc1:/);
  const before = JSON.stringify(rows(w));
  const second = w.eval('Users.encryptMobiles()');
  assert.equal(second.sealed, 0);
  assert.equal(JSON.stringify(rows(w)), before, 'a second run changes nothing');
  assert.equal(w.ok(a.email, 'me').mobile, '9876541021');
  assert.equal(w.ok(b.email, 'me').mobile, '9876541022');
  // the nightly job sweeps up anything that slipped in as plain text
  w.eval(`Db.update('Users', ${JSON.stringify(userA)}, { mobile: '9000000009' }).userId`);
  w.eval("Jobs.nightly().status");
  assert.match(stored(w, a.email), /^enc1:/);
  assert.equal(w.ok(a.email, 'me').mobile, '9000000009');
});

test('selfTest includes the encryption round trip and tamper check', () => {
  const w = world({ students: 0 });
  const out = w.eval("(function () { var rec = []; var orig = console.log; console.log = function (s) { rec.push(s); }; try { var r = Setup.selfTest(); } finally { console.log = orig; } return r.checks.filter(function (c) { return /encryption/i.test(c.name); }); })()");
  assert.equal(out.length, 1);
  assert.equal(out[0].ok, true, JSON.stringify(out[0]));
});
