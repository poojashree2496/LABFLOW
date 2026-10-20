const test = require('node:test');
const assert = require('node:assert/strict');
const { world } = require('./fixtures');

// B3: the HOD sees the labs of their own department plus labs with no department, and nothing from another department.
function setup() {
  const w = world({ students: 1 });
  const cse = w.ok(w.admin, 'labs.upsert', { code: 'CSE01', name: 'CSE Lab', type: 'iot', department: 'CSE' }).lab;
  const ece = w.ok(w.admin, 'labs.upsert', { code: 'ECE01', name: 'ECE Lab', type: 'iot', department: 'ECE' }).lab;
  const cat = w.ok(w.staff, 'categories.upsert', { name: 'Scope systems', trackingMode: 'individual', workstation: true }).category;
  const asset = (lab, tag) => w.ok(w.staff, 'assets.upsert', { labId: lab.labId, categoryId: cat.categoryId, name: 'System ' + tag, assetTag: tag }).asset;
  return { w, cse, ece, cat, cseAsset: asset(cse, 'CSE-PC-1'), eceAsset: asset(ece, 'ECE-PC-1') };
}
const codes = (labs) => labs.map((l) => l.code).sort();

test('B3: a CSE HOD sees CSE labs and labs without a department, not an ECE lab', () => {
  const { w, ece } = setup();
  const d = w.ok(w.hod, 'dash.hod', {});
  assert.deepEqual(codes(d.labs), ['CSE01', 'GPU01', 'IOT01']);
  assert.equal(d.department, 'CSE');
  assert.equal(d.readOnly, true);
  assert.deepEqual(codes(w.ok(w.hod, 'labs.live', {}).labs), ['CSE01', 'GPU01', 'IOT01']);
  assert.equal(w.err(w.hod, 'labs.live', { labId: ece.labId }).code, 'FORBIDDEN');
  // a super admin sees every lab and is not read-only
  const a = w.ok(w.admin, 'dash.hod', {});
  assert.deepEqual(codes(a.labs), ['CSE01', 'ECE01', 'GPU01', 'IOT01']);
  assert.equal(a.readOnly, false);
  // a coordinator has no HOD dashboard
  assert.equal(w.err(w.staff, 'dash.hod', {}).code, 'FORBIDDEN');
  // the helper itself
  assert.equal(w.eval("Auth.labScope({ has: function (r) { return r === 'student'; } })").length, 0);
});

test('B3: the department comes from the account and an update that leaves it out keeps it', () => {
  const { w } = setup();
  assert.equal(w.ok(w.admin, 'users.list', { role: 'hod' }).users.find((u) => u.email === w.hod).department, 'CSE', 'a new HOD with none named is CSE');
  w.ok(w.admin, 'users.upsert', { email: 'ece.hod@karunya.edu', displayName: 'Dr ECE', roles: ['hod'], department: 'ECE' });
  assert.deepEqual(codes(w.ok('ece.hod@karunya.edu', 'dash.hod', {}).labs), ['ECE01', 'GPU01', 'IOT01']);
  w.ok(w.admin, 'users.upsert', { email: 'ece.hod@karunya.edu', displayName: 'Dr ECE Renamed', roles: ['hod'] });
  assert.deepEqual(codes(w.ok('ece.hod@karunya.edu', 'dash.hod', {}).labs), ['ECE01', 'GPU01', 'IOT01'], 'renaming does not reset the department');
  // department names match without regard to case or spaces
  w.ok(w.admin, 'users.upsert', { email: 'ece.hod@karunya.edu', displayName: 'Dr ECE', roles: ['hod'], department: ' cse ' });
  assert.deepEqual(codes(w.ok('ece.hod@karunya.edu', 'dash.hod', {}).labs), ['CSE01', 'GPU01', 'IOT01']);
  // editing a lab without naming a department keeps it; naming an empty one clears it
  const lab = w.ok(w.admin, 'labs.list', {}).labs.find((l) => l.code === 'ECE01');
  assert.equal(lab.department, 'ECE');
  const keep = w.ok(w.admin, 'labs.upsert', { labId: lab.labId, code: 'ECE01', name: 'ECE Lab renamed', type: 'iot' }).lab;
  assert.equal(keep.department, 'ECE');
  assert.equal(w.ok(w.admin, 'labs.upsert', { labId: lab.labId, code: 'ECE01', name: 'ECE Lab renamed', type: 'iot', department: '' }).lab.department, '');
  assert.deepEqual(codes(w.ok(w.hod, 'dash.hod', {}).labs), ['CSE01', 'ECE01', 'GPU01', 'IOT01'], 'a lab with no department is everyone\'s');
});

test('B3: facilities, loans, bookings and equipment requests are limited to the HOD\'s labs', () => {
  const { w, cse, ece, cseAsset, eceAsset } = setup();
  const tags = (r) => r.assets.map((a) => a.assetTag);
  assert.ok(tags(w.ok(w.hod, 'assets.list', {})).includes('CSE-PC-1'));
  assert.ok(!tags(w.ok(w.hod, 'assets.list', {})).includes('ECE-PC-1'));
  assert.ok(!tags(w.ok(w.hod, 'assets.list', { labId: ece.labId })).length, 'asking for another department\'s lab returns nothing');
  assert.ok(tags(w.ok(w.staff, 'assets.list', {})).includes('ECE-PC-1'), 'coordinators still see every lab');
  assert.equal(w.err(w.hod, 'assets.history', { assetId: eceAsset.assetId }).code, 'FORBIDDEN');
  assert.ok(Array.isArray(w.ok(w.hod, 'assets.history', { assetId: cseAsset.assetId }).events));
  const now = w.eval('U.now()');
  [cse, ece].forEach((lab, i) => {
    w.eval(`Db.insert('Reservations', { reservationId: 'RES-0000000000${i}1', labId: '${lab.labId}', resourceType: 'asset', resourceId: 'x', quantity: 1, requesterType: 'student', requesterId: 's', startAt: ${now + 3600000}, endAt: ${now + 7200000}, status: 'pending', requestedAt: ${now} }).reservationId`);
    w.eval(`Db.insert('EquipmentRequests', { requestId: 'EQR-0000000000${i}1', labId: '${lab.labId}', studentId: 's', resourceType: 'category', resourceId: 'c', quantity: 1, status: 'pending', requestedAt: ${now} }).requestId`);
    w.eval(`Db.insert('Loans', { loanId: 'LON-0000000000${i}1', labId: '${lab.labId}', borrowerType: 'student', borrowerId: 's', status: 'open', issuedBy: 'x', issuedAt: ${now}, dueAt: ${now - 1000}, idemKey: 'k${i}' }).loanId`);
  });
  assert.deepEqual(w.ok(w.hod, 'booking.list', {}).reservations.map((r) => r.labId), [cse.labId]);
  assert.equal(w.ok(w.staff, 'booking.list', {}).reservations.length, 2);
  assert.deepEqual(w.ok(w.hod, 'equipment.list', {}).requests.map((r) => r.labId), [cse.labId]);
  assert.deepEqual(w.ok(w.hod, 'loans.list', {}).loans.map((l) => l.labId), [cse.labId]);
  const d = w.ok(w.hod, 'dash.hod', {});
  assert.equal(d.queues.pendingBookings, 1); assert.equal(d.queues.pendingEquipment, 1); assert.equal(d.queues.activeLoans, 1); assert.equal(d.queues.overdueLoans, 1);
  assert.equal(d.stock.individual, 1, 'only the CSE system is counted');
  assert.equal(w.ok(w.admin, 'dash.hod', {}).stock.individual, 2);
});

test('B3: sessions, flags and session reports outside the department are refused', () => {
  const { w, ece } = setup();
  const s = w.session();
  w.eval(`Db.update('Labs', '${s.labId}', { department: 'ECE' })`);
  assert.equal(w.ok(w.hod, 'sessions.day', { date: w.today }).sessions.length, 0, 'the day list leaves out another department');
  assert.ok(w.ok(w.admin, 'sessions.day', { date: w.today }).sessions.length > 0);
  assert.equal(w.err(w.hod, 'sessions.get', { sessionId: s.sessionId }).code, 'FORBIDDEN');
  assert.equal(w.err(w.hod, 'reports.run', { type: 'session', sessionId: s.sessionId }).code, 'FORBIDDEN');
  assert.equal(w.ok(w.admin, 'sessions.get', { sessionId: s.sessionId }).session.sessionId, s.sessionId);
  w.eval(`Db.insert('Flags', { flagId: 'FLG-000000000001', type: 'x', severity: 'low', studentId: 'x', sessionId: '${s.sessionId}', labId: '${s.labId}', detail: {}, status: 'open', createdAt: 1, dedupeKey: 'b3-1' }).flagId`);
  assert.equal(w.ok(w.hod, 'flags.list', {}).flags.length, 0);
  assert.equal(w.ok(w.staff, 'flags.list', {}).flags.length, 1);
  w.eval(`Db.update('Labs', '${s.labId}', { department: 'CSE' })`);
  assert.equal(w.ok(w.hod, 'flags.list', {}).flags.length, 1);
  assert.equal(w.ok(w.hod, 'sessions.get', { sessionId: s.sessionId }).session.sessionId, s.sessionId);
  // a system in another department has no usage report for this HOD
  const other = w.ok(w.staff, 'assets.list', { labId: ece.labId, limit: 5 }).assets[0];
  assert.equal(w.err(w.hod, 'reports.run', { type: 'systemUsage', assetId: other.assetId }).code, 'FORBIDDEN');
});
