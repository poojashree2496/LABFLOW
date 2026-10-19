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

test('Unnati demo: every preset has marked placeholder inventory and current project/system visits', () => {
  for (const preset of ['small', 'demo', 'large']) {
    const lab = createLab({ preset }), w = lab.w, demo = lab.unnati;
    const labs = w.ok(w.admin, 'labs.list').labs;
    assert.equal(labs.length, 4);
    const unnati = labs.find((l) => l.code === 'UNNATI');
    assert.equal(unnati.name, 'Intel Unnati AI Lab');
    assert.equal(unnati.openLab, true); assert.equal(unnati.openTime, '08:00'); assert.equal(unnati.closeTime, '19:00');
    assert.match(unnati.notes, /DEMO PLACEHOLDER/); assert.match(unnati.building, /TBD/); assert.match(unnati.room, /TBD/);
    assert.equal(unnati.latitude, Math.round(lab.labs.UNNATI.lat * 1e6) / 1e6);
    const assets = w.ok(w.staff, 'assets.list', { labId: unnati.labId }).assets;
    const cats = w.eval("Db.readAll('Categories')");
    const systems = assets.filter((a) => cats.find((c) => c.categoryId === a.categoryId).workstation === true);
    assert.equal(systems.length, 30); assert.equal(assets.length, 40);
    assert.equal(assets.filter((a) => a.name.startsWith('3D printer')).length, 2);
    assert.equal(assets.filter((a) => a.name.startsWith('Drone')).length, 2);
    assert.equal(assets.filter((a) => a.name.startsWith('Development board')).length, 6);
    assert.ok(assets.every((a) => a.trackingMode === 'individual' && a.assetTag.startsWith('DEMO-UNNATI-') && a.notes.includes('DEMO PLACEHOLDER')));
    const claims = w.eval(`Work.occupants('${unnati.labId}')`);
    assert.equal(claims.length, 3); assert.equal(new Set(claims.map((c) => c.assetId)).size, 3);
    assert.deepEqual(new Set(claims.map((c) => c.studentId)), new Set(demo.studentIds));
    const session = w.eval(`Db.get('Sessions','${demo.sessionId}')`);
    assert.equal(session.status, 'open'); assert.equal(session.type, 'openlab');
    assert.equal(w.ok(w.admin, 'labs.occupancy').labs.find((l) => l.labId === unnati.labId).inside, 3);
    for (let i = 0; i < 3; i++) {
      const student = w.students.find((s) => s.studentId === demo.studentIds[i]);
      const mine = w.ok(student.email, 'sessions.mine').sessions.find((s) => s.sessionId === demo.sessionId).mine;
      assert.equal(mine.state, 'in'); assert.equal(mine.work.projectId, demo.projectIds[i]); assert.equal(mine.work.assetId, demo.workstationIds[i]);
      assert.ok(mine.firstIn <= lab.clock.now(), 'demo visits must exist before the initial Test Lab clock');
      const project = w.eval(`Db.get('Projects','${demo.projectIds[i]}')`);
      assert.equal(project.status, i === 1 ? 'pending' : 'active'); assert.equal(project.supervisorFacultyId, w.faculty2Id);
    }
  }
});

test('Unnati demo: seeded visits close through the production workflow and reopen cleanly the next day', () => {
  const lab = createLab({ preset: 'small' }), w = lab.w, demo = lab.unnati;
  lab.clock.set(w.eval("U.fromLocal('2026-10-14','19:05')")); lab.sync();
  w.eval('Sessions.autoCloseStale()'); w.eval('Sessions.autoCloseStale()');
  const outs = w.eval(`Db.whereEq('AttendanceEvents',{sessionId:'${demo.sessionId}',type:'OUT'})`);
  assert.equal(outs.length, 3); assert.ok(outs.every((e) => e.method === 'auto' && e.at === w.eval("U.fromLocal('2026-10-14','19:00')")));
  const summaries = w.eval(`Db.whereEq('AttendanceSummaries',{sessionId:'${demo.sessionId}'})`);
  assert.equal(summaries.length, 3); assert.ok(summaries.every((r) => r.verifiedMinutes === 550 && r.flags.includes('auto_out')));
  assert.deepEqual(w.eval(`Work.occupants('${demo.lab.labId}')`), []);
  lab.clock.set(w.eval("U.fromLocal('2026-10-15','10:00')")); lab.sync();
  const student = w.students.find((s) => s.studentId === demo.studentIds[0]);
  const session = w.ok(student.email, 'sessions.mine').sessions.find((s) => s.labId === demo.lab.labId && s.type === 'openlab');
  assert.ok(session && session.sessionId !== demo.sessionId);
  const result = w.checkin(student, { kiosk: demo.kioskEmail, sessionId: session.sessionId, projectId: demo.projectIds[0], assetId: demo.workstationIds[0], geo: w.at(3, 12, lab.labs.UNNATI) });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(w.eval(`Work.occupants('${demo.lab.labId}').length`), 1);
});
