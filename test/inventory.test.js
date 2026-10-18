const test = require('node:test');
const assert = require('node:assert/strict');
const { world } = require('./fixtures');

let n = 0;
const key = () => 'idem-' + String(++n).padStart(6, '0') + '-abcdefghij';
const DAY = 86400000;

function stock(w) {
  const arduino = w.ok(w.staff, 'categories.upsert', { name: 'Arduino', trackingMode: 'individual' }).category;
  const resistor = w.ok(w.staff, 'categories.upsert', { name: 'Resistors', trackingMode: 'quantity' }).category;
  const cable = w.ok(w.staff, 'categories.upsert', { name: 'USB cable', trackingMode: 'individual' }).category;
  const ards = [1, 2, 3].map((i) => w.ok(w.staff, 'assets.upsert', { labId: w.lab.labId, categoryId: arduino.categoryId, name: 'Arduino Uno #' + i, assetTag: 'ARD-00' + i, serialNo: 'SN' + i, valueInr: 1200 }).asset);
  const res = w.ok(w.staff, 'assets.upsert', { labId: w.lab.labId, categoryId: resistor.categoryId, name: '220R resistor', quantityTotal: 100 }).asset;
  const cab = w.ok(w.staff, 'assets.upsert', { labId: w.lab.labId, categoryId: cable.categoryId, name: 'USB-A cable 1', assetTag: 'CAB-001' }).asset;
  return { arduino, resistor, cable, ards, res, cab };
}
const get = (w, assetId) => w.eval("Db.get('Assets'," + JSON.stringify(assetId) + ")");
const issue = (w, who, items, extra) => w.call(w.staff, 'loans.issue', Object.assign({ idemKey: key(), borrowerType: 'student', borrowerId: who.studentId, labId: w.lab.labId, items }, extra || {}));
const drift = (w) => w.ok(w.admin, 'system.reconcileInventory', { dryRun: true });

test('individual vs quantity assets: issue, availability, uniqueness', () => {
  const w = world({ students: 2 }); const s = stock(w); const [a] = w.students;
  assert.equal(w.err(w.staff, 'assets.upsert', { labId: w.lab.labId, categoryId: s.arduino.categoryId, name: 'dup', assetTag: 'ard-001' }).code, 'DUPLICATE', 'tags are unique case-insensitively');
  assert.equal(w.err(w.staff, 'assets.upsert', { labId: w.lab.labId, categoryId: s.arduino.categoryId, name: 'no tag' }).code, 'BAD_INPUT', 'individual assets need a tag');
  const r = issue(w, a, [{ assetId: s.ards[0].assetId, qty: 1 }, { assetId: s.res.assetId, qty: 30 }]);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.data.loan.items.find((i) => i.assetId === s.ards[0].assetId).trackingMode, 'individual');
  assert.equal(r.data.loan.items.find((i) => i.assetId === s.res.assetId).trackingMode, 'quantity');
  assert.equal(get(w, s.ards[0].assetId).status, 'on_loan');
  assert.equal(get(w, s.res.assetId).quantityAvailable, 70);
  assert.equal(issue(w, w.students[1], [{ assetId: s.ards[0].assetId, qty: 1 }]).error.code, 'UNAVAILABLE', 'same physical item cannot go out twice');
  assert.equal(issue(w, w.students[1], [{ assetId: s.res.assetId, qty: 71 }]).error.code, 'UNAVAILABLE');
  assert.equal(issue(w, w.students[1], [{ assetId: s.ards[1].assetId, qty: 2 }]).error.code, 'BAD_INPUT', 'individual items are quantity 1');
  assert.deepEqual(drift(w).drift, []);
});

test('idempotent issue: a retried request returns the same loan and does not double-decrement', () => {
  const w = world({ students: 1 }); const s = stock(w); const [a] = w.students;
  const k = key();
  const body = { idemKey: k, borrowerType: 'student', borrowerId: a.studentId, labId: w.lab.labId, items: [{ assetId: s.res.assetId, qty: 10 }] };
  const first = w.ok(w.staff, 'loans.issue', body), second = w.ok(w.staff, 'loans.issue', body);
  assert.equal(first.loan.loanId, second.loan.loanId); assert.equal(second.replayed, true);
  assert.equal(get(w, s.res.assetId).quantityAvailable, 90);
  assert.equal(w.eval("Db.readAll('Loans').length"), 1);
  assert.equal(w.err(w.staff, 'loans.issue', Object.assign({}, body, { idemKey: 'short' })).code, 'BAD_INPUT');
});

test('crash in the middle of an issue is rolled back: no half-issued loan, ledger compensated', () => {
  const w = world({ students: 1 }); const s = stock(w); const [a] = w.students;
  w.e.run("var __n = 0, __o = Assets._event; Assets._event = function () { if (++__n === 2) throw new Error('boom'); return __o.apply(null, arguments); };");
  const r = issue(w, a, [{ assetId: s.ards[0].assetId, qty: 1 }, { assetId: s.res.assetId, qty: 5 }, { assetId: s.ards[1].assetId, qty: 1 }]);
  assert.equal(r.ok, false); assert.equal(r.error.code, 'INTERNAL');
  w.e.run('Assets._event = __o;');
  assert.equal(get(w, s.ards[0].assetId).status, 'available');
  assert.equal(get(w, s.res.assetId).quantityAvailable, 100);
  assert.equal(w.eval("Db.readAll('Loans')[0].status"), 'failed');
  assert.deepEqual(drift(w).drift, []);
  // the ledger nets to zero for the touched assets
  const ev = w.eval("Db.readAll('AssetEvents').filter(function (e) { return e.type !== 'create'; })");
  const net = {}; ev.forEach((e) => { net[e.assetId] = (net[e.assetId] || 0) + e.qtyDelta; });
  Object.values(net).forEach((v) => assert.equal(v, 0));
  // client retry with a NEW key succeeds
  assert.equal(issue(w, a, [{ assetId: s.ards[0].assetId, qty: 1 }]).ok, true);
});

test('stale half-written loan is repaired by reconcile', () => {
  const w = world({ students: 1 }); const s = stock(w); const [a] = w.students;
  assert.equal(issue(w, a, [{ assetId: s.ards[0].assetId, qty: 1 }]).ok, true);
  // corrupt: pretend the status update never happened and the loan is stuck
  w.e.run("var l = Db.readAll('Loans')[0]; Db.update('Loans', l.loanId, { status: 'issuing' });");
  w.advance(6 * 60000);
  const rep = w.ok(w.admin, 'system.reconcileInventory', {});
  assert.equal(rep.staleLoans.length, 1);
  assert.equal(get(w, s.ards[0].assetId).status, 'available');
});

test('derived stock drift is detected and repaired from loan items', () => {
  const w = world({ students: 1 }); const s = stock(w); const [a] = w.students;
  issue(w, a, [{ assetId: s.res.assetId, qty: 40 }, { assetId: s.ards[0].assetId, qty: 1 }]);
  w.e.run(`Db.update('Assets', ${JSON.stringify(s.res.assetId)}, { quantityAvailable: 95 }); Db.update('Assets', ${JSON.stringify(s.ards[0].assetId)}, { status: 'available', quantityAvailable: 1, currentLoanId: '' });`);
  const dry = drift(w);
  assert.equal(dry.drift.length, 2);
  assert.equal(get(w, s.res.assetId).quantityAvailable, 95, 'dry run changes nothing');
  w.ok(w.admin, 'system.reconcileInventory', {});
  assert.equal(get(w, s.res.assetId).quantityAvailable, 60);
  assert.equal(get(w, s.ards[0].assetId).status, 'on_loan');
  assert.deepEqual(drift(w).drift, []);
});

test('bulk return: partial, consumed, damaged, missing; idempotent; cannot over-return', () => {
  const w = world({ students: 1 }); const s = stock(w); const [a] = w.students;
  const loan = issue(w, a, [{ assetId: s.ards[0].assetId, qty: 1 }, { assetId: s.ards[1].assetId, qty: 1 }, { assetId: s.res.assetId, qty: 50 }, { assetId: s.cab.assetId, qty: 1 }]).data.loan;
  const it = (assetId) => loan.items.find((i) => i.assetId === assetId).loanItemId;
  const k = key();
  const body = { idemKey: k, loanId: loan.loanId, lines: [
    { loanItemId: it(s.ards[0].assetId), qtyReturned: 1, conditionIn: 'good' },
    { loanItemId: it(s.ards[1].assetId), qtyDamaged: 1, note: 'USB port burnt' },
    { loanItemId: it(s.res.assetId), qtyReturned: 20, qtyConsumed: 25, qtyMissing: 2 }] };
  const r = w.ok(w.staff, 'loans.return', body);
  assert.equal(r.loan.status, 'partial');
  assert.equal(get(w, s.ards[0].assetId).status, 'available');
  assert.equal(get(w, s.ards[1].assetId).status, 'damaged');
  const res = get(w, s.res.assetId);
  assert.equal(res.quantityTotal, 100 - 25 - 2); assert.equal(res.quantityAvailable, 50 + 20);
  assert.equal(get(w, s.cab.assetId).status, 'on_loan');
  // retry of the same request is a no-op
  const again = w.ok(w.staff, 'loans.return', body);
  assert.equal(again.replayed, true);
  assert.equal(get(w, s.res.assetId).quantityAvailable, 70);
  // over-return refused
  assert.equal(w.err(w.staff, 'loans.return', { idemKey: key(), loanId: loan.loanId, lines: [{ loanItemId: it(s.res.assetId), qtyReturned: 4 }] }).code, 'BAD_INPUT');
  assert.equal(w.err(w.staff, 'loans.return', { idemKey: key(), loanId: loan.loanId, lines: [{ loanItemId: it(s.ards[0].assetId), qtyReturned: 1 }] }).code, 'INVALID_STATE');
  assert.equal(w.err(w.staff, 'loans.return', { idemKey: key(), loanId: loan.loanId, lines: [{ loanItemId: it(s.cab.assetId), qtyConsumed: 1 }] }).code, 'BAD_INPUT', 'individual items cannot be consumed');
  // finish
  const fin = w.ok(w.staff, 'loans.return', { idemKey: key(), loanId: loan.loanId, lines: [{ loanItemId: it(s.res.assetId), qtyReturned: 3 }, { loanItemId: it(s.cab.assetId), qtyMissing: 1, note: 'not in the bag' }] });
  assert.equal(fin.loan.status, 'closed');
  assert.equal(get(w, s.cab.assetId).status, 'missing');
  assert.deepEqual(drift(w).drift, []);
  // admin was told about damage/missing
  assert.ok(w.eval("Db.readAll('Notifications')").some((x) => /Damaged/.test(x.title)));
  // damaged / missing assets cannot be issued
  assert.equal(issue(w, a, [{ assetId: s.ards[1].assetId, qty: 1 }]).error.code, 'UNAVAILABLE');
  assert.equal(issue(w, a, [{ assetId: s.cab.assetId, qty: 1 }]).error.code, 'UNAVAILABLE');
});

test('kits: exact components required; kit loan returns item by item', () => {
  const w = world({ students: 1 }); const s = stock(w); const [a] = w.students;
  const kit = w.ok(w.staff, 'kits.upsert', { labId: w.lab.labId, name: 'IoT starter', components: [{ categoryId: s.arduino.categoryId, quantity: 1 }, { categoryId: s.resistor.categoryId, quantity: 10 }, { categoryId: s.cable.categoryId, quantity: 1 }] }).kit;
  const comp = (cat) => kit.components.find((c) => c.categoryId === cat.categoryId).componentId;
  const picks = [{ componentId: comp(s.arduino), assetId: s.ards[0].assetId }, { componentId: comp(s.resistor), assetId: s.res.assetId, qty: 10 }, { componentId: comp(s.cable), assetId: s.cab.assetId }];
  assert.equal(issue(w, a, [], { kitId: kit.kitId, kitPicks: picks.slice(0, 2) }).error.code, 'BAD_INPUT', 'missing component');
  assert.equal(issue(w, a, [], { kitId: kit.kitId, kitPicks: [picks[0], { componentId: comp(s.resistor), assetId: s.res.assetId, qty: 9 }, picks[2]] }).error.code, 'BAD_INPUT', 'wrong quantity');
  assert.equal(issue(w, a, [], { kitId: kit.kitId, kitPicks: [{ componentId: comp(s.arduino), assetId: s.res.assetId }, picks[1], picks[2]] }).error.code, 'BAD_INPUT', 'wrong category');
  const r = issue(w, a, [], { kitId: kit.kitId, kitPicks: picks });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.data.loan.kitId, kit.kitId); assert.equal(r.data.loan.items.length, 3);
  // editing the kit later does not change history; removed components are soft-removed
  const upd = w.ok(w.staff, 'kits.upsert', { kitId: kit.kitId, labId: w.lab.labId, name: 'IoT starter v2', components: [{ categoryId: s.arduino.categoryId, quantity: 1 }] }).kit;
  assert.equal(upd.components.length, 1);
});

test('group loans: members can see them, outsiders cannot; group status guarded', () => {
  const w = world({ students: 3 }); const s = stock(w); const [a, b, c] = w.students;
  assert.equal(w.err(a.email, 'groups.create', { name: 'x', studentIds: [a.studentId] }).code, 'FORBIDDEN');
  const g = w.ok(w.faculty, 'groups.create', { name: 'Team Alpha', studentIds: [a.studentId, b.studentId], leaderId: a.studentId }).group;
  assert.equal(w.ok(a.email, 'groups.list').groups.length, 1); assert.equal(w.ok(c.email, 'groups.list').groups.length, 0);
  const r = w.call(w.staff, 'loans.issue', { idemKey: key(), borrowerType: 'group', borrowerId: g.groupId, labId: w.lab.labId, items: [{ assetId: s.ards[0].assetId, qty: 1 }] });
  assert.equal(r.ok, true);
  assert.equal(w.ok(b.email, 'loans.mine').loans.length, 1);
  assert.equal(w.ok(c.email, 'loans.mine').loans.length, 0);
  assert.equal(w.err(c.email, 'loans.get', { loanId: r.data.loan.loanId }).code, 'FORBIDDEN');
  assert.equal(w.err(w.staff, 'groups.status', { groupId: g.groupId, status: 'disbanded' }).code, 'INVALID_STATE');
  assert.equal(w.err(w.faculty, 'groups.create', { name: 'bad', studentIds: ['STU-000000000000'] }).code, 'NOT_FOUND');
});

test('limits: max open loans and overdue block', () => {
  const w = world({ students: 1 }); const s = stock(w); const [a] = w.students;
  w.ok(w.admin, 'settings.set', { values: { maxOpenLoansPerBorrower: 2 } });
  assert.equal(issue(w, a, [{ assetId: s.ards[0].assetId, qty: 1 }], { days: 1 }).ok, true);
  assert.equal(issue(w, a, [{ assetId: s.ards[1].assetId, qty: 1 }]).ok, true);
  assert.equal(issue(w, a, [{ assetId: s.ards[2].assetId, qty: 1 }]).error.code, 'LIMIT');
  w.ok(w.admin, 'settings.set', { values: { maxOpenLoansPerBorrower: 5 } });
  w.advance(2 * DAY);
  assert.equal(issue(w, a, [{ assetId: s.ards[2].assetId, qty: 1 }]).error.code, 'OVERDUE');
  assert.equal(w.ok(w.staff, 'loans.list', { status: 'overdue' }).loans.length, 1);
});

test('overdue reminders: one notification per loan per day, one staff digest, never duplicated by reruns', () => {
  const w = world({ students: 1 }); const s = stock(w); const [a] = w.students;
  issue(w, a, [{ assetId: s.ards[0].assetId, qty: 1 }], { days: 1 });
  w.advance(3 * DAY);
  w.eval('Loans.sendOverdueReminders()'); w.eval('Loans.sendOverdueReminders()');
  const n1 = w.eval("Db.readAll('Notifications').filter(function (n) { return n.type === 'overdue'; })");
  assert.equal(n1.filter((x) => /Overdue lab items/.test(x.title)).length, 1);
  assert.equal(n1.filter((x) => /overdue loan/.test(x.title)).length, 1, 'one staff digest');
  w.advance(DAY);
  w.eval('Loans.sendOverdueReminders()');
  assert.equal(w.eval("Db.readAll('Notifications').filter(function (n) { return /Overdue lab items/.test(n.title); }).length"), 2, 'a new day reminds again');
});

test('condition checks update status and are idempotent', () => {
  const w = world({ students: 0 }); const s = stock(w);
  const k = key();
  w.ok(w.staff, 'assets.condition', { idemKey: k, assetId: s.ards[0].assetId, condition: 'damaged', note: 'cracked header' });
  assert.equal(get(w, s.ards[0].assetId).status, 'damaged');
  assert.equal(w.ok(w.staff, 'assets.condition', { idemKey: k, assetId: s.ards[0].assetId, condition: 'damaged' }).replayed, true);
  assert.equal(w.ok(w.staff, 'assets.history', { assetId: s.ards[0].assetId }).events.filter((e) => e.type === 'condition').length, 1);
});

test('asset import validates every row and is all-or-nothing', () => {
  const w = world({ students: 0 }); stock(w);
  const bad = w.ok(w.staff, 'assets.import', { rows: [{ lab: 'IOT01', category: 'Arduino', name: 'A', assetTag: 'IMP-1' }, { lab: 'NOPE', category: 'Arduino', name: 'B', assetTag: 'IMP-2' }] });
  assert.equal(bad.imported, 0); assert.equal(bad.errors.length, 1);
  const good = w.ok(w.staff, 'assets.import', { rows: [{ lab: 'IOT01', category: 'Arduino', name: 'A', assetTag: 'IMP-1' }, { lab: 'IOT01', category: 'Resistors', name: 'R', quantity: 20 }] });
  assert.equal(good.imported, 2);
  assert.equal(w.err(w.staff, 'assets.import', { rows: [{ lab: 'IOT01', category: 'Arduino', name: 'A', assetTag: 'IMP-1' }] }).code, 'DUPLICATE');
});

// ---------------------------------------------------------------------------------------------------------------------------
const hr = (w, h) => w.NOW + h * 3600000;
function book(w, who, body) { return w.call(who.email, 'booking.request', Object.assign({ labId: w.lab.labId, resourceType: 'category', quantity: 1, purpose: 'Project demo' }, body)); }

test('advance booking: capacity is enforced, pending holds stock, approval re-checks, cancel releases', () => {
  const w = world({ students: 3 }); const s = stock(w); const [a, b, c] = w.students;
  const slot = { startAt: hr(w, 24), endAt: hr(w, 30), resourceId: s.arduino.categoryId };
  assert.equal(book(w, a, Object.assign({ quantity: 2 }, slot)).ok, true);
  const r2 = book(w, b, Object.assign({ quantity: 1 }, slot));
  assert.equal(r2.ok, true, 'one left');
  assert.equal(r2.data.reservation.collectionOpensAt, slot.startAt - 2 * 3600000, 'the booking exposes its server-defined collection window');
  const r3 = book(w, c, Object.assign({ quantity: 1 }, slot));
  assert.equal(r3.error.code, 'NOT_AVAILABLE', 'pending requests hold stock');
  // a different, non-overlapping window is fine
  assert.equal(book(w, c, { resourceId: s.arduino.categoryId, startAt: hr(w, 40), endAt: hr(w, 44), quantity: 3 }).ok, true);
  // approve, cancel, free up
  const id1 = w.ok(a.email, 'booking.mine').reservations.find((r) => r.quantity === 2).reservationId;
  assert.equal(w.err(b.email, 'booking.cancel', { reservationId: id1 }).code, 'FORBIDDEN', 'cannot cancel others\' bookings');
  w.ok(w.staff, 'booking.decide', { reservationId: id1, approve: true });
  assert.equal(w.err(w.staff, 'booking.decide', { reservationId: id1, approve: true }).code, 'INVALID_STATE');
  w.ok(a.email, 'booking.cancel', { reservationId: id1 });
  assert.equal(w.ok(a.email, 'booking.cancel', { reservationId: id1 }).replayed, true);
  assert.equal(book(w, c, Object.assign({ quantity: 2 }, slot)).ok, true, 'cancelled stock is free again');
  assert.equal(w.ok(a.email, 'booking.check', { labId: w.lab.labId, resourceType: 'category', resourceId: s.arduino.categoryId, startAt: slot.startAt, endAt: slot.endAt }).categories[0].free, 0);
});

test('booking validation: past, too far ahead, too long, over limit, others\' groups', () => {
  const w = world({ students: 2 }); const s = stock(w); const [a, b] = w.students;
  const base = { resourceId: s.arduino.categoryId };
  assert.equal(book(w, a, Object.assign({ startAt: w.NOW - 3600000, endAt: hr(w, 1) }, base)).error.code, 'BAD_INPUT');
  assert.equal(book(w, a, Object.assign({ startAt: hr(w, 24 * 30), endAt: hr(w, 24 * 30 + 2) }, base)).error.code, 'BAD_INPUT');
  assert.equal(book(w, a, Object.assign({ startAt: hr(w, 2), endAt: hr(w, 24 * 9) }, base)).error.code, 'BAD_INPUT');
  assert.equal(book(w, a, Object.assign({ startAt: hr(w, 5), endAt: hr(w, 4) }, base)).error.code, 'BAD_INPUT');
  for (let i = 0; i < 3; i++) assert.equal(book(w, a, Object.assign({ startAt: hr(w, 24 * (i + 1)), endAt: hr(w, 24 * (i + 1) + 2) }, base)).ok, true);
  assert.equal(book(w, a, Object.assign({ startAt: hr(w, 24 * 6), endAt: hr(w, 24 * 6 + 2) }, base)).error.code, 'LIMIT');
  const g = w.ok(w.faculty, 'groups.create', { name: 'G', studentIds: [a.studentId] }).group;
  assert.equal(book(w, b, Object.assign({ requesterType: 'group', requesterId: g.groupId, startAt: hr(w, 10), endAt: hr(w, 12) }, base)).error.code, 'FORBIDDEN');
  // requester is derived from the caller: a payload "requesterId" for a student booking is ignored
  const ok = book(w, b, Object.assign({ requesterId: a.studentId, startAt: hr(w, 10), endAt: hr(w, 12) }, base));
  assert.equal(w.ok(b.email, 'booking.mine').reservations.length, 1); void ok;
});

test('walk-up checkout cannot consume stock promised to an approved booking; the booking holder can collect it', () => {
  const w = world({ students: 2 }); const s = stock(w); const [a, b] = w.students;
  // book 3 of 3 Arduinos starting in 3 hours
  const r = book(w, a, { resourceId: s.arduino.categoryId, quantity: 3, startAt: hr(w, 3), endAt: hr(w, 9) }).data.reservation;
  w.ok(w.staff, 'booking.decide', { reservationId: r.reservationId, approve: true });
  const walk = issue(w, b, [{ assetId: s.ards[0].assetId, qty: 1 }], { days: 1 });
  assert.equal(walk.error.code, 'RESERVED', JSON.stringify(walk));
  // too early to collect
  assert.equal(w.call(w.staff, 'loans.issue', { idemKey: key(), borrowerType: 'student', borrowerId: a.studentId, labId: w.lab.labId, reservationId: r.reservationId, items: s.ards.map((x) => ({ assetId: x.assetId, qty: 1 })) }).error.code, 'TOO_EARLY');
  // wrong person
  w.e.setTime(hr(w, 2.5));
  assert.equal(w.call(w.staff, 'loans.issue', { idemKey: key(), borrowerType: 'student', borrowerId: b.studentId, labId: w.lab.labId, reservationId: r.reservationId, items: s.ards.map((x) => ({ assetId: x.assetId, qty: 1 })) }).error.code, 'BAD_INPUT');
  const ok = w.call(w.staff, 'loans.issue', { idemKey: key(), borrowerType: 'student', borrowerId: a.studentId, labId: w.lab.labId, reservationId: r.reservationId, items: s.ards.map((x) => ({ assetId: x.assetId, qty: 1 })) });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.data.loan.dueAt, hr(w, 9), 'due at booking end');
  assert.equal(w.ok(w.staff, 'booking.list', { status: 'fulfilled' }).reservations.length, 1);
  // a walk-up checkout for stock NOT promised is fine
  const other = book(w, b, { resourceId: s.resistor.categoryId, quantity: 50, startAt: hr(w, 24), endAt: hr(w, 26) }).data.reservation;
  w.ok(w.staff, 'booking.decide', { reservationId: other.reservationId, approve: true });
  assert.equal(issue(w, b, [{ assetId: s.res.assetId, qty: 40 }], { days: 1 }).ok, true);
  assert.equal(issue(w, b, [{ assetId: s.res.assetId, qty: 30 }], { days: 3 }).error.code, 'RESERVED');
});

test('kit booking expands into component demand; expiry job clears stale requests and no-shows', () => {
  const w = world({ students: 2 }); const s = stock(w); const [a, b] = w.students;
  const kit = w.ok(w.staff, 'kits.upsert', { labId: w.lab.labId, name: 'Kit', components: [{ categoryId: s.arduino.categoryId, quantity: 2 }] }).kit;
  assert.equal(book(w, a, { resourceType: 'kit', resourceId: kit.kitId, quantity: 2, startAt: hr(w, 5), endAt: hr(w, 8) }).error.code, 'NOT_AVAILABLE', '2 kits x 2 Arduinos = 4 > 3');
  const r = book(w, a, { resourceType: 'kit', resourceId: kit.kitId, quantity: 1, startAt: hr(w, 5), endAt: hr(w, 8) }).data.reservation;
  assert.equal(book(w, b, { resourceId: s.arduino.categoryId, quantity: 2, startAt: hr(w, 6), endAt: hr(w, 7) }).error.code, 'NOT_AVAILABLE');
  w.ok(w.staff, 'booking.decide', { reservationId: r.reservationId, approve: true });
  w.e.setTime(hr(w, 6.5));
  assert.equal(w.eval('Booking.expireStale()').expired, 0, 'inside the 2h no-show window');
  w.e.setTime(hr(w, 5 + 2.1));
  assert.equal(w.eval('Booking.expireStale()').expired, 1);
  assert.equal(w.eval('Booking.expireStale()').expired, 0, 'idempotent');
  assert.equal(w.ok(a.email, 'booking.mine').reservations[0].status, 'expired');
  assert.equal(book(w, b, { resourceId: s.arduino.categoryId, quantity: 3, startAt: hr(w, 30), endAt: hr(w, 32) }).ok, true, 'stock is back');
});

test('individual asset booked by name is exclusive for overlapping windows', () => {
  const w = world({ students: 2 }); const s = stock(w); const [a, b] = w.students;
  const slot = { resourceType: 'asset', resourceId: s.ards[0].assetId, startAt: hr(w, 5), endAt: hr(w, 8) };
  assert.equal(book(w, a, slot).ok, true);
  assert.equal(book(w, b, Object.assign({}, slot, { startAt: hr(w, 7), endAt: hr(w, 9) })).error.code, 'NOT_AVAILABLE');
  assert.equal(book(w, b, Object.assign({}, slot, { startAt: hr(w, 8), endAt: hr(w, 9) })).ok, true, 'back-to-back is fine');
});

test('lock contention fails closed: when another execution holds the lock nothing is written (BUSY)', async () => {
  const w = world({ students: 1 }); const s = stock(w); const [a] = w.students;
  await w.registerDevice(a);
  const sid = w.session().sessionId; w.ok(w.faculty, 'sessions.open', { sessionId: sid });
  const qr = await w.qr(a, sid, 'in');
  w.e.state.lockHeld = true; // another execution owns the script lock
  const before = { loans: w.eval("Db.readAll('Loans').length"), bookings: w.eval("Db.readAll('Reservations').length"), events: w.eval("Db.readAll('AttendanceEvents').length") };
  assert.equal(issue(w, a, [{ assetId: s.res.assetId, qty: 1 }]).error.code, 'BUSY');
  assert.equal(book(w, a, { resourceId: s.cable.categoryId, startAt: hr(w, 5), endAt: hr(w, 8) }).error.code, 'BUSY');
  assert.equal(w.scan(qr).error.code, 'BUSY');
  w.e.state.lockHeld = false;
  assert.deepEqual({ loans: w.eval("Db.readAll('Loans').length"), bookings: w.eval("Db.readAll('Reservations').length"), events: w.eval("Db.readAll('AttendanceEvents').length") }, before);
  assert.equal(w.scan(qr).ok, true, 'the same QR still works once the lock is free (a BUSY scan did not burn the code)');
});

test('reports: shapes, access rules, CSV formula neutralisation, PDF export path, truncation flag', () => {
  const w = world({ students: 2 }); const s = stock(w); const [a, b] = w.students;
  w.ok(w.staff, 'assets.upsert', { labId: w.lab.labId, categoryId: s.resistor.categoryId, name: '=HYPERLINK("http://x","y")', quantityTotal: 5 });
  issue(w, a, [{ assetId: s.ards[0].assetId, qty: 1 }]);
  for (const t of ['daily', 'monthly', 'utilisation', 'assetUsage', 'inventory', 'overdue']) {
    const r = w.ok(w.staff, 'reports.run', { type: t });
    assert.ok(Array.isArray(r.columns) && Array.isArray(r.rows), t);
    r.rows.forEach((row) => assert.equal(row.length, r.columns.length, t + ' row width'));
  }
  assert.equal(w.err(w.staff, 'reports.run', { type: 'audit' }).code, 'FORBIDDEN');
  assert.ok(w.ok(w.admin, 'reports.run', { type: 'audit' }).rows.length > 5);
  assert.equal(w.err(w.faculty, 'reports.run', { type: 'inventory' }).code, 'FORBIDDEN');
  assert.equal(w.ok(w.faculty, 'reports.run', { type: 'faculty', facultyId: w.faculty2Id }).title.includes('Dr Faculty'), true, 'faculty always gets their own report whatever id is sent');
  assert.equal(w.err(a.email, 'reports.run', { type: 'faculty' }).code, 'FORBIDDEN');
  const csv = w.ok(w.staff, 'reports.csv', { type: 'inventory' });
  assert.match(csv.filename, /^inventory_\d{4}-\d{2}-\d{2}\.csv$/);
  assert.ok(csv.csv.includes("'=HYPERLINK"), 'formula-looking text is neutralised');
  assert.ok(!/(^|,)=HYPERLINK/m.test(csv.csv));
  const pdf = w.ok(w.staff, 'reports.pdf', { type: 'overdue' });
  assert.match(pdf.filename, /\.pdf$/); assert.equal(Buffer.from(pdf.base64, 'base64').toString().startsWith('%PDF'), true);
  assert.deepEqual(w.e.trashed, ['doc-1'], 'temporary Doc is trashed');
  assert.equal(w.err(w.staff, 'reports.run', { type: 'daily', date: '2026-02-31' }).code, 'BAD_INPUT');
  assert.equal(w.err(w.staff, 'reports.run', { type: 'utilisation', from: '2020-01-01', to: '2026-01-01' }).code, 'BAD_INPUT');
  void b;
});

test('reports: daily/monthly/student numbers match the attendance data', async () => {
  const w = world({ students: 3 });
  for (const st of w.students) await w.registerDevice(st);
  const sid = w.session().sessionId; w.ok(w.faculty, 'sessions.open', { sessionId: sid });
  for (const st of w.students.slice(0, 2)) w.scan(await w.qr(st, sid, 'in'));
  w.advance(60 * 60000);
  w.scan(await w.qr(w.students[0], sid, 'out'));
  w.ok(w.faculty, 'sessions.close', { sessionId: sid });
  const d = w.ok(w.admin, 'reports.run', { type: 'daily', date: w.today });
  const row = d.rows[0];
  const col = (n) => d.columns.indexOf(n);
  assert.equal(row[col('Roster')], 3); assert.equal(row[col('Present')], 1); assert.equal(row[col('Absent')], 1); assert.equal(row[col('Unverified exit')], 1);
  const f = w.ok(w.faculty, 'reports.run', { type: 'faculty', from: w.today, to: w.today });
  assert.equal(f.rows.length, 1);
  const st = w.ok(w.students[0].email, 'reports.run', { type: 'student', from: w.today, to: w.today });
  assert.equal(st.rows[0][st.columns.indexOf('Verified minutes')], 60);
  const m = w.ok(w.admin, 'reports.run', { type: 'monthly', month: '2026-10' });
  assert.equal(m.rows[0][0], 'IOT01');
});

test('settings: validated, audited, applied; unknown keys and bad values rejected', () => {
  const w = world({ students: 0 });
  assert.equal(w.err(w.admin, 'settings.set', { values: { qrTtlSeconds: 5 } }).code, 'BAD_INPUT');
  assert.equal(w.err(w.admin, 'settings.set', { values: { qrTtlSeconds: 'abc' } }).code, 'BAD_INPUT');
  assert.equal(w.err(w.admin, 'settings.set', { values: { nonsense: 1 } }).code, 'BAD_INPUT');
  assert.equal(w.err(w.admin, 'settings.set', { values: { reportRecipients: 'a@gmail.com' } }).code, 'BAD_INPUT');
  assert.equal(w.err(w.admin, 'settings.set', { values: { rescanMode: 'sometimes' } }).code, 'BAD_INPUT');
  const r = w.ok(w.admin, 'settings.set', { values: { qrTtlSeconds: 90, reportRecipients: 'Head@karunya.edu, dean@karunya.edu.in', emailEnabled: false } });
  assert.deepEqual(r.changed.sort(), ['emailEnabled', 'qrTtlSeconds', 'reportRecipients']);
  assert.equal(w.ok('x@karunya.edu', 'me').onboardingRequired, true);
  assert.equal(w.eval('Settings.get("qrTtlSeconds")'), 90);
  assert.equal(w.eval('Settings.get("reportRecipients")'), 'head@karunya.edu,dean@karunya.edu.in');
  assert.ok(w.ok(w.admin, 'audit.list', { action: 'settings.update' }).events.length === 1);
});
