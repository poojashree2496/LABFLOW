// Reproductions from the critical workflow audit. All user actions use the real RPC gateway.
const test = require('node:test');
const assert = require('node:assert/strict');
const { world, genDevice, signWith } = require('./fixtures');

const HOUR = 3600000;
let sequence = 0;
const key = () => 'audit-request-' + String(++sequence).padStart(8, '0');
const rows = (w, table) => w.eval(`Db.readAll(${JSON.stringify(table)})`);
function stock(w) {
  const cat = w.ok(w.staff, 'categories.upsert', { name: 'Boards', trackingMode: 'individual' }).category;
  const other = w.ok(w.staff, 'categories.upsert', { name: 'Cables', trackingMode: 'quantity' }).category;
  const boards = [1, 2, 3].map((i) => w.ok(w.staff, 'assets.upsert', {
    labId: w.lab.labId, categoryId: cat.categoryId, name: 'Board ' + i, assetTag: 'AUDIT-' + i
  }).asset);
  const cable = w.ok(w.staff, 'assets.upsert', {
    labId: w.lab.labId, categoryId: other.categoryId, name: 'Cable stock', quantityTotal: 20
  }).asset;
  return { cat, other, boards, cable };
}
function issue(w, student, assets, extra = {}) {
  return w.call(w.staff, 'loans.issue', {
    idemKey: key(), borrowerType: 'student', borrowerId: student.studentId,
    labId: w.lab.labId, items: assets.map((a) => ({ assetId: a.assetId, qty: 1 })), ...extra
  });
}
function book(w, student, resource, extra = {}) {
  return w.ok(student.email, 'booking.request', {
    labId: w.lab.labId, resourceType: 'asset', resourceId: resource.assetId,
    startAt: w.NOW + HOUR, endAt: w.NOW + 3 * HOUR, purpose: 'Audit demo', ...extra
  }).reservation;
}
function request(w, student, category, quantity = 1) {
  return w.ok(student.email, 'equipment.request', {
    labId: w.lab.labId, resourceType: 'category', resourceId: category.categoryId, quantity
  }).request;
}
function open(w) {
  const sid = w.session().sessionId;
  w.ok(w.faculty, 'sessions.open', { sessionId: sid });
  return sid;
}
// Deterministic interleaving: emulate a second execution committing while crypto runs outside the lock.
function duringSignature(w, code) {
  w.e.run(`var auditVerify = Creds.verifySignature;
    Creds.verifySignature = function () {
      var ok = auditVerify.apply(null, arguments);
      Creds.verifySignature = auditVerify;
      ${code}
      return ok;
    };`);
}

test('audit: walk-up checkout preserves the exact asset booked, while another unit remains usable', () => {
  const w = world({ students: 2 }), s = stock(w), [a, b] = w.students;
  const r = book(w, a, s.boards[0]);
  w.ok(w.staff, 'booking.decide', { reservationId: r.reservationId, approve: true });
  const blocked = issue(w, b, [s.boards[0]]);
  assert.equal(blocked.error?.code, 'RESERVED', JSON.stringify(blocked));
  assert.equal(rows(w, 'Loans').length, 0);
  assert.equal(issue(w, b, [s.boards[1]]).ok, true);
  assert.equal(issue(w, a, [s.boards[0]], { reservationId: r.reservationId }).ok, true);
});

test('audit: collecting a named-asset booking cannot fulfil it with a different unit', () => {
  const w = world({ students: 1 }), s = stock(w), [a] = w.students;
  const r = book(w, a, s.boards[0]);
  w.ok(w.staff, 'booking.decide', { reservationId: r.reservationId, approve: true });
  const result = issue(w, a, [s.boards[1]], { reservationId: r.reservationId });
  assert.equal(result.error?.code, 'BAD_INPUT', JSON.stringify(result));
  assert.equal(rows(w, 'Reservations')[0].status, 'approved');
  assert.equal(rows(w, 'Loans').length, 0);
});

test('audit: booking retry at the active limit returns its original reservation', () => {
  const w = world({ students: 1 }), s = stock(w), [a] = w.students;
  w.ok(w.admin, 'settings.set', { values: { bookingMaxActivePerRequester: 1 } });
  const first = book(w, a, s.boards[0]);
  const again = book(w, a, s.boards[0]);
  assert.equal(again.reservationId, first.reservationId);
  assert.equal(rows(w, 'Reservations').length, 1);
});

test('audit: an invalid linked equipment request leaves no loan or stock changes', () => {
  const w = world({ students: 2 }), s = stock(w), [a, b] = w.students;
  open(w); assert.equal(w.checkin(a).ok, true);
  const r = request(w, a, s.cat);
  const before = rows(w, 'Assets');
  assert.equal(issue(w, b, [s.boards[0]], { requestId: r.requestId }).error?.code, 'BAD_INPUT');
  assert.equal(rows(w, 'Loans').length, 0, 'validation must precede writes');
  assert.deepEqual(rows(w, 'Assets'), before);
  assert.equal(rows(w, 'EquipmentRequests')[0].status, 'pending');
});

test('audit: unrelated equipment cannot fulfil a request for another category', () => {
  const w = world({ students: 1 }), s = stock(w), [a] = w.students;
  open(w); assert.equal(w.checkin(a).ok, true);
  const r = request(w, a, s.cat);
  const result = issue(w, a, [s.cable], { requestId: r.requestId });
  assert.equal(result.error?.code, 'BAD_INPUT', JSON.stringify(result));
  assert.equal(rows(w, 'EquipmentRequests')[0].status, 'pending');
  assert.equal(rows(w, 'Loans').length, 0);
});

test('audit: partial quantities cannot silently fulfil an entire equipment request', () => {
  const w = world({ students: 1 }), s = stock(w), [a] = w.students;
  open(w); assert.equal(w.checkin(a).ok, true);
  const r = request(w, a, s.cat, 2);
  const result = issue(w, a, [s.boards[0]], { requestId: r.requestId });
  assert.equal(result.error?.code, 'BAD_INPUT', JSON.stringify(result));
  assert.equal(rows(w, 'Loans').length, 0);
  assert.equal(issue(w, a, s.boards.slice(0, 2), { requestId: r.requestId }).ok, true);
  assert.equal(rows(w, 'EquipmentRequests')[0].status, 'fulfilled');
});

test('audit: failure after stock writes rolls back the loan, booking, request and ledger together', () => {
  const w = world({ students: 1 }), s = stock(w), [a] = w.students;
  open(w); assert.equal(w.checkin(a).ok, true);
  const r = request(w, a, s.cat), booking = book(w, a, s.boards[0]);
  w.ok(w.staff, 'booking.decide', { reservationId: booking.reservationId, approve: true });
  w.e.run(`var auditLog = Audit.log; Audit.log = function (entry) {
    if (entry.action === 'loan.issue') throw new Error('injected issue failure');
    return auditLog(entry);
  };`);
  assert.equal(issue(w, a, [s.boards[0]], { requestId: r.requestId, reservationId: booking.reservationId }).ok, false);
  assert.equal(rows(w, 'Loans')[0].status, 'failed');
  assert.equal(rows(w, 'Assets')[0].status, 'available');
  assert.equal(rows(w, 'Reservations')[0].status, 'approved');
  const req = rows(w, 'EquipmentRequests')[0];
  assert.equal(req.status, 'pending'); assert.equal(req.loanId, '');
  assert.equal(rows(w, 'AssetEvents').filter((e) => e.assetId === s.boards[0].assetId).reduce((sum, e) => sum + e.qtyDelta, 0), 1);
});

for (const change of ['student disabled', 'student unverified', 'scanner demoted', 'kiosk disabled', 'QR stale']) {
  test('audit: scan rechecks ' + change + ' before committing attendance', async () => {
    const w = world({ students: 1 }), [a] = w.students;
    await w.registerDevice(a); const sid = open(w), qr = await w.qr(a, sid, 'in');
    const code = {
      'student disabled': `Db.update('Users', Db.getBy('Users', 'email', ${JSON.stringify(a.email)}).userId, { status: 'disabled' });`,
      'student unverified': `Db.update('StudentProfiles', ${JSON.stringify(a.studentId)}, { status: 'pending' });`,
      'scanner demoted': `Db.update('Users', Db.getBy('Users', 'email', ${JSON.stringify(w.faculty)}).userId, { roles: 'student' });`,
      'kiosk disabled': `Db.update('Kiosks', Db.readAll('Kiosks')[0].kioskId, { status: 'disabled' });`,
      'QR stale': `__testNow += 30000;`
    }[change];
    duringSignature(w, code);
    const result = change === 'scanner demoted' ? w.phoneScan(w.faculty, qr) : w.scan(qr);
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(rows(w, 'AttendanceEvents').length, 0);
    assert.equal(rows(w, 'Redemptions').filter((r) => r.sessionId === sid).length, 0);
  });
}

test('audit: registration challenge expiring during signature verification is refused', async () => {
  const w = world({ students: 1 }), [a] = w.students, dev = await genDevice();
  const { challenge } = w.ok(a.email, 'cred.begin');
  const signature = await signWith(dev, challenge);
  duringSignature(w, '__testNow += 301000;');
  const result = w.call(a.email, 'cred.complete', { challenge, signature, publicKey: dev.publicKey });
  assert.equal(result.error?.code, 'EXPIRED', JSON.stringify(result));
  assert.equal(rows(w, 'DeviceCredentials').length, 0);
});

test('audit: replacement rejection cannot overwrite an approval committed before its lock', async () => {
  const w = world({ students: 1 }), [a] = w.students;
  const old = await w.registerDevice(a), next = await w.registerDevice(a);
  // Another request approves the replacement immediately before this operation acquires the lock.
  w.e.run(`var auditWith = Locks.with, auditStaff = Auth._contextForEmail(${JSON.stringify(w.staff)});
    Locks.with = function (fn, timeout) {
      Locks.with = auditWith;
      Creds.approve(auditStaff, { credentialId: ${JSON.stringify(next.credentialId)}, idChecked: true });
      return auditWith(fn, timeout);
    };`);
  const result = w.call(w.staff, 'cred.reject', { credentialId: next.credentialId, reason: 'No ID check' });
  assert.equal(result.error?.code, 'INVALID_STATE', JSON.stringify(result));
  const credentials = rows(w, 'DeviceCredentials');
  assert.equal(credentials.find((c) => c.credentialId === old.credentialId).status, 'replaced');
  assert.equal(credentials.find((c) => c.credentialId === next.credentialId).status, 'active');
});

test('audit: a manual exit must follow the current entry, including after re-entry', () => {
  const w = world({ students: 1 }), [a] = w.students, sid = open(w);
  assert.equal(w.checkin(a).ok, true);
  w.advance(10 * 60000); assert.equal(w.checkin(a, { action: 'out', sessionId: sid }).ok, true);
  w.advance(10 * 60000); assert.equal(w.checkin(a, { action: 'in', sessionId: sid }).ok, true);
  w.advance(10 * 60000);
  const result = w.call(w.faculty, 'attend.correct', {
    sessionId: sid, studentId: a.studentId, action: 'add_out',
    at: w.NOW + 15 * 60000, reason: 'Student forgot the exit scan'
  });
  assert.equal(result.error?.code, 'BAD_INPUT', JSON.stringify(result));
  assert.equal(rows(w, 'AttendanceEvents').filter((e) => e.type === 'CORR_OUT').length, 0);
  assert.equal(w.ok(w.faculty, 'attend.correct', {
    sessionId: sid, studentId: a.studentId, action: 'add_out',
    at: w.NOW + 25 * 60000, reason: 'Student forgot the exit scan'
  }).approvalStatus, 'approved');
  const roster = w.ok(w.faculty, 'attend.roster', { sessionId: sid }).roster[0];
  assert.equal(roster.state, 'out'); assert.equal(roster.verifiedMinutes, 15);
});

for (const change of ['student disabled', 'kiosk disabled', 'pass expired']) {
  test('audit: kiosk-GPS check-in rechecks ' + change + ' under the lock', () => {
    const w = world({ students: 1 }), [a] = w.students, sid = open(w);
    const code = {
      'student disabled': `Db.update('Users', Db.getBy('Users', 'email', ${JSON.stringify(a.email)}).userId, { status: 'disabled' });`,
      'kiosk disabled': `Db.update('Kiosks', Db.readAll('Kiosks')[0].kioskId, { status: 'disabled' });`,
      'pass expired': '__testNow += 121000;'
    }[change];
    w.e.run(`var auditGeoStep = Checkin.STEPS_A.filter(function (s) { return s.id === 'geofence'; })[0];
      var auditGeo = auditGeoStep.run;
      auditGeoStep.run = function (c) { auditGeo(c); ${code} };`);
    assert.equal(w.checkin(a, { sessionId: sid }).ok, false);
    assert.equal(rows(w, 'AttendanceEvents').length, 0);
    assert.equal(rows(w, 'Redemptions').filter((r) => r.sessionId === sid).length, 0);
  });
}

for (const stage of ['item', 'stock', 'ledger', 'loan', 'completion', 'stock saved', 'completion saved']) {
  test('audit: interrupted return at ' + stage + ' resumes once with the same request key', () => {
    const w = world({ students: 1 }), s = stock(w), [a] = w.students;
    const loan = issue(w, a, [s.cable], { items: [{ assetId: s.cable.assetId, qty: 10 }] }).data.loan;
    const predicate = {
      item: "table === 'LoanItems'",
      stock: "table === 'Assets'",
      ledger: "table === 'AssetEvents' && patch.type === 'return'",
      loan: "table === 'Loans'",
      completion: "table === 'AssetEvents' && patch.type === 'return-complete'",
      'stock saved': "table === 'Assets'",
      'completion saved': "table === 'AssetEvents' && patch.type === 'return-complete'"
    }[stage];
    const method = stage === 'ledger' || stage.startsWith('completion') ? 'insert' : 'update';
    w.e.run(`var auditWrite = Db.${method}; Db.${method} = function (table, id, patch) {
      ${method === 'insert' ? 'patch = id;' : ''}
      if (${predicate}) { Db.${method} = auditWrite; ${stage.endsWith('saved') ? 'auditWrite.apply(null, arguments);' : ''} throw new Error('injected return failure'); }
      return auditWrite.apply(null, arguments);
    };`);
    const body = { idemKey: key(), loanId: loan.loanId, lines: [{ loanItemId: loan.items[0].loanItemId, qtyReturned: 4, qtyConsumed: 3 }] };
    assert.equal(w.call(w.staff, 'loans.return', body).ok, false);
    w.e.run(`Db.${method} = auditWrite;`);
    const recovered = w.ok(w.staff, 'loans.return', body);
    assert.equal(recovered.loan.status, 'partial');
    assert.equal(recovered.loan.items[0].qtyReturned, 4);
    assert.equal(recovered.loan.items[0].qtyConsumed, 3);
    assert.equal(recovered.loan.items[0].outstanding, 3);
    const after = rows(w, 'Assets').find((x) => x.assetId === s.cable.assetId);
    assert.equal(after.quantityTotal, 17); assert.equal(after.quantityAvailable, 14);
    const events = rows(w, 'AssetEvents').filter((x) => x.loanId === loan.loanId);
    assert.equal(events.filter((x) => x.type === 'return').length, 1);
    assert.equal(events.filter((x) => x.type === 'consume').length, 1);
    assert.equal(w.ok(w.staff, 'loans.return', body).replayed, true);
    assert.equal(rows(w, 'Assets').find((x) => x.assetId === s.cable.assetId).quantityAvailable, 14);
  });
}

test('audit: next checkout recovers an interrupted return before using the stock', () => {
  const w = world({ students: 2 }), s = stock(w), [a, b] = w.students;
  const loan = issue(w, a, [s.cable], { items: [{ assetId: s.cable.assetId, qty: 10 }] }).data.loan;
  w.e.run(`var auditWrite = Db.update; Db.update = function (table, id, patch) {
    if (table === 'Assets') { Db.update = auditWrite; throw new Error('injected return failure'); }
    return auditWrite(table, id, patch);
  };`);
  const body = { idemKey: key(), loanId: loan.loanId, lines: [{ loanItemId: loan.items[0].loanItemId, qtyReturned: 4, qtyConsumed: 3 }] };
  assert.equal(w.call(w.staff, 'loans.return', body).ok, false);
  assert.equal(issue(w, b, [s.cable], { items: [{ assetId: s.cable.assetId, qty: 2 }] }).ok, true);
  assert.equal(w.ok(w.staff, 'loans.return', body).replayed, true);
  const after = rows(w, 'Assets').find((x) => x.assetId === s.cable.assetId);
  assert.equal(after.quantityTotal, 17); assert.equal(after.quantityAvailable, 12);
  assert.deepEqual(w.ok(w.admin, 'system.reconcileInventory', { dryRun: true }).drift, []);
});

test('audit: reconciliation recovers a damaged-item return and leaves its completed plan alone', () => {
  const w = world({ students: 1 }), s = stock(w), [a] = w.students;
  const loan = issue(w, a, [s.boards[0]]).data.loan;
  w.e.run(`var auditWrite = Db.update; Db.update = function (table, id, patch) {
    if (table === 'Assets') { Db.update = auditWrite; throw new Error('injected return failure'); }
    return auditWrite(table, id, patch);
  };`);
  assert.equal(w.call(w.staff, 'loans.return', {
    idemKey: key(), loanId: loan.loanId, lines: [{ loanItemId: loan.items[0].loanItemId, qtyDamaged: 1 }]
  }).ok, false);
  w.ok(w.admin, 'system.reconcileInventory', {});
  assert.equal(w.ok(w.staff, 'loans.get', { loanId: loan.loanId }).loan.status, 'closed');
  assert.equal(rows(w, 'Assets')[0].status, 'damaged');
  w.ok(w.staff, 'assets.upsert', { ...s.boards[0], status: 'available', condition: 'good' });
  w.ok(w.admin, 'system.reconcileInventory', {});
  assert.equal(rows(w, 'Assets')[0].status, 'available', 'a completed old plan must never overwrite later repairs');
});

test('audit: notification failure does not fail an already committed checkout or return', () => {
  const w = world({ students: 1 }), s = stock(w), [a] = w.students;
  w.e.run("Loans._notifyBorrower = function () { throw new Error('injected notification failure'); };");
  const checkedOut = issue(w, a, [s.boards[0]]);
  assert.equal(checkedOut.ok, true);
  const loan = checkedOut.data.loan;
  const returned = w.ok(w.staff, 'loans.return', {
    idemKey: key(), loanId: loan.loanId, lines: [{ loanItemId: loan.items[0].loanItemId, qtyReturned: 1 }]
  });
  assert.equal(returned.loan.status, 'closed');
  assert.equal(rows(w, 'Assets')[0].status, 'available');
  assert.equal(rows(w, 'SystemLog').filter((e) => e.code === 'NOTIFY_FAILED').length, 2);
});

test('audit: an oversized return is refused before writes and can be split into smaller returns', () => {
  const w = world({ students: 1 }), s = stock(w), [a] = w.students;
  w.ok(w.staff, 'assets.import', { rows: Array.from({ length: 45 }, (_, i) => ({
    lab: 'IOT01', category: s.other.name, name: 'Bulk item ' + i, quantity: 10
  })) });
  const assets = rows(w, 'Assets').filter((x) => x.name.startsWith('Bulk item '));
  const loan = issue(w, a, assets, { items: assets.map((x) => ({ assetId: x.assetId, qty: 10 })) }).data.loan;
  const lines = loan.items.map((x) => ({ loanItemId: x.loanItemId, qtyReturned: 1, qtyConsumed: 3,
    qtyDamaged: 3, qtyMissing: 3, note: 'Detailed condition note '.padEnd(200, 'x') }));
  const before = rows(w, 'Assets');
  const result = w.call(w.staff, 'loans.return', { idemKey: key(), loanId: loan.loanId, lines });
  assert.equal(result.error?.code, 'BAD_INPUT', JSON.stringify(result));
  assert.deepEqual(rows(w, 'Assets'), before);
  assert.equal(rows(w, 'AssetEvents').filter((e) => e.type === 'return-plan').length, 0);
  w.ok(w.staff, 'loans.return', { idemKey: key(), loanId: loan.loanId, lines: lines.slice(0, 22) });
  assert.equal(w.ok(w.staff, 'loans.return', { idemKey: key(), loanId: loan.loanId, lines: lines.slice(22) }).loan.status, 'closed');
});
