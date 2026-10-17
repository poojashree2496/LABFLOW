const test = require('node:test');
const assert = require('node:assert/strict');
const { createLab } = require('../dev/world');

test('Test Lab demo preset seeds usable attendance, equipment, loans and booking states', () => {
  const lab = createLab({ preset: 'small' });
  const w = lab.w;
  const today = w.ok(w.admin, 'sessions.day', { date: '2026-10-14' }).sessions;
  const equipment = w.ok(w.staff, 'equipment.list', {}).requests;
  const loans = w.ok(w.staff, 'loans.list', {}).loans;
  const bookings = w.ok(w.staff, 'booking.list', {}).reservations;
  const research = w.ok(w.faculty, 'research.pending').requests;
  const flags = w.ok(w.staff, 'flags.list').flags;
  const spotChecks = w.ok(w.faculty, 'spot.list', { sessionId: lab.demoSessionId }).checks;
  const event = w.ok(w.staff, 'events.list', { from: '2026-10-14', to: '2026-10-14' }).events.find((row) => row.labEventId === lab.demoEventId);

  assert.ok(today.some((session) => session.labId === w.lab.labId && session.status === 'open'));
  assert.ok(w.eval("Db.readAll('AttendanceEvents').length") >= 2);
  assert.equal(w.demoPendingStudent.status, 'pending');
  assert.ok(equipment.some((request) => request.status === 'pending'));
  assert.ok(loans.some((loan) => loan.status === 'open' && loan.overdue));
  assert.ok(loans.some((loan) => loan.status === 'open' && !loan.overdue));
  assert.deepEqual(new Set(bookings.map((booking) => booking.status)), new Set(['pending', 'approved', 'rejected']));
  assert.equal(research.length, 1);
  assert.ok(flags.some((flag) => flag.status === 'open' && flag.type === 'implausible_location'));
  assert.ok(spotChecks.some((check) => check.outcome === 'pending'));
  assert.ok(event && event.registered >= 2 && event.guests >= 1);
  assert.ok(w.eval("Db.readAll('Events').length"));
  assert.ok(w.eval("Db.readAll('Groups').length"));
});
