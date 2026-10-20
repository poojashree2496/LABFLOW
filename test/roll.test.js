// A1: register numbers (R18). URK + 2-digit year + department + serial.
const test = require('node:test');
const assert = require('node:assert/strict');
const { world } = require('./fixtures');

test('parseRoll: URK24CS1021 gives join year 2024, graduation 2028, department CS and serial 1021', () => {
  const w = world({ students: 0 });
  assert.deepEqual(w.eval("U.parseRoll('URK24CS1021')"), { joinYear: 2024, gradYear: 2028, dept: 'CS', serial: '1021' });
  assert.deepEqual(w.eval("U.parseRoll('  urk23ece045 ')"), { joinYear: 2023, gradYear: 2027, dept: 'ECE', serial: '045' }, 'lowercase and spaces are tolerated');
  for (const other of ['PHD2024007', 'S001', 'URK24C1021', 'URK24CS12', 'URK24CS123456', 'URK2CS1021', 'XRK24CS1021', '', null, undefined]) {
    assert.equal(w.eval('U.parseRoll(' + JSON.stringify(other === undefined ? null : other) + ')'), null, String(other));
  }
});

test('import fills join year and department from a matching number; other formats import without parsed fields', () => {
  const w = world({ students: 0 });
  const r = w.ok(w.admin, 'students.import', { rows: [
    { rollNo: 'URK24CS1021', name: 'Parsed Student' },
    { rollNo: 'URK24EC1002', name: 'Given Dept', department: 'Electronics' },
    { rollNo: 'PHD2024007', name: 'Research Scholar' }] });
  assert.equal(r.created, 3); assert.deepEqual(r.errors, []);
  const by = Object.fromEntries(w.ok(w.admin, 'students.list').students.map((s) => [s.rollNo, s]));
  assert.equal(by.URK24CS1021.joinYear, 2024); assert.equal(by.URK24CS1021.department, 'CS');
  assert.equal(by.URK24EC1002.joinYear, 2024); assert.equal(by.URK24EC1002.department, 'Electronics', 'a department that was supplied is never overwritten');
  assert.equal(by.PHD2024007.joinYear, null); assert.equal(by.PHD2024007.department, 'CSE', 'unparsed numbers keep the old default');
});

test('onboarding a matching number records the join year; a PhD-style number onboards without parsed fields', () => {
  const w = world({ students: 0 });
  w.ok(w.admin, 'students.import', { rows: [{ rollNo: 'URK24CS1021', name: 'Imported', email: 'imp@karunya.edu' }] });
  const a = w.ok('imp@karunya.edu', 'onboard', { rollNo: 'URK24CS1021', name: 'Imported', consent: true, mobile: '9876543210' }).student;
  assert.equal(a.joinYear, 2024); assert.equal(a.department, 'CS'); assert.equal(a.status, 'verified');
  const b = w.ok('new@karunya.edu', 'onboard', { rollNo: 'urk23it0099', name: 'Self Claimed', consent: true, mobile: '9876543211' }).student;
  assert.equal(b.rollNo, 'URK23IT0099'); assert.equal(b.joinYear, 2023); assert.equal(b.department, 'IT');
  const c = w.ok('phd@karunya.edu', 'onboard', { rollNo: 'PHD2024007', name: 'Scholar', consent: true, mobile: '9876543212' }).student;
  assert.equal(c.joinYear, null); assert.equal(c.department, 'CSE');
  const d = w.ok('given@karunya.edu', 'onboard', { rollNo: 'URK22CS0001', name: 'Explicit', department: 'AI&DS', consent: true, mobile: '9876543213' }).student;
  assert.equal(d.department, 'AI&DS'); assert.equal(d.joinYear, 2022);
});

test('students.list filters by batch (join year), including profiles saved before A1', () => {
  const w = world({ students: 0 });
  w.ok(w.admin, 'students.import', { rows: [
    { rollNo: 'URK24CS1001', name: 'A' + 'a' }, { rollNo: 'URK24CS1002', name: 'Bb' }, { rollNo: 'URK23CS1003', name: 'Cc' }, { rollNo: 'PHD2024007', name: 'Dd' }] });
  const batch = (year) => w.ok(w.admin, 'students.list', { batch: year }).students.map((s) => s.rollNo);
  assert.deepEqual(batch(2024), ['URK24CS1001', 'URK24CS1002']);
  assert.deepEqual(batch(2023), ['URK23CS1003']);
  assert.deepEqual(batch(2022), []);
  // A row saved before the join year existed still matches through its register number.
  const old = w.eval("Db.getBy('StudentProfiles','rollNo','URK23CS1003').studentId");
  w.e.run(`Db.update('StudentProfiles','${old}',{joinYear:null})`);
  assert.deepEqual(batch(2023), ['URK23CS1003']);
  assert.equal(w.err(w.admin, 'students.list', { batch: 'soon' }).code, 'BAD_INPUT');
  assert.equal(w.ok(w.admin, 'students.list').students.length, 4, 'no filter lists everyone');
});
