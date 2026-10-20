// B5: student totals (R10), system usage (R11) and project reports (R7), on a seeded open-lab world.
const test = require('node:test');
const assert = require('node:assert/strict');
const { world } = require('./fixtures');

let n = 0;
const key = () => 'rpt-' + String(++n).padStart(6, '0') + '-abcdefghij';
const at = (w, date, time) => w.e.setTime(w.eval(`U.fromLocal('${date}','${time}')`));

/**
 * Wed 2026-10-14, open lab 08:00-19:00. 10:00 s0 enters on system 0 (project 0) and s1 on system 2 (project 1).
 * 10:30 s0 moves to system 1. 11:00 s0 scans out. s1 never scans out and is signed out automatically at 19:00.
 * Next day s0 works 10:00-11:00 on system 0 again.
 */
function seeded() {
  const w = world();
  w.ok(w.admin, 'labs.upsert', { ...w.lab, openLab: true });
  const cat = w.ok(w.staff, 'categories.upsert', { name: 'Report systems', trackingMode: 'individual', workstation: true }).category;
  w.systems = [1, 2, 3].map((i) => w.ok(w.staff, 'assets.upsert', { labId: w.lab.labId, categoryId: cat.categoryId, name: 'Report system ' + i, assetTag: 'RPT-' + i }).asset);
  w.projects = w.students.slice(0, 2).map((s, i) => w.ok(s.email, 'projects.create', { title: 'Report project ' + i, description: 'Seeded work', labId: w.lab.labId, supervisorFacultyId: w.facultyId, startDate: w.today, endDate: '2026-12-01' }).project);
  const sessionId = w.ok(w.students[0].email, 'sessions.mine').sessions.find((s) => s.type === 'openlab').sessionId;
  const enter = (i, sys, sid) => { const r = w.checkin(w.students[i], { sessionId: sid || sessionId, projectId: w.projects[i].projectId, assetId: sys && sys.assetId }); assert.equal(r.ok, true, JSON.stringify(r)); };
  enter(0, w.systems[0]); enter(1, w.systems[2]);
  w.advance(30 * 60000);
  const work = w.ok(w.students[0].email, 'sessions.mine').sessions.find((s) => s.sessionId === sessionId).mine.work;
  w.ok(w.students[0].email, 'attend.setWork', { sessionId, entryEventId: work.entryEventId, expectedEventId: work.eventId, projectId: w.projects[0].projectId, assetId: w.systems[1].assetId });
  w.advance(30 * 60000);
  assert.equal(w.checkin(w.students[0], { sessionId, action: 'out' }).ok, true);
  at(w, w.today, '19:01'); w.eval('Sessions.closeOpenLabsDue()');
  // Day two
  w.eval("Sessions.materializeOpenLab('2026-10-15')");
  at(w, '2026-10-15', '10:00'); w.eval('Sessions.autoOpenDue()');
  const day2 = w.ok(w.students[0].email, 'sessions.mine').sessions.find((s) => s.type === 'openlab' && s.date === '2026-10-15').sessionId;
  enter(0, w.systems[0], day2);
  w.advance(60 * 60000);
  assert.equal(w.checkin(w.students[0], { sessionId: day2, action: 'out' }).ok, true);
  at(w, '2026-10-15', '19:01'); w.eval('Sessions.closeOpenLabsDue()');
  return w;
}
const run = (w, who, type, p = {}) => w.ok(who, 'reports.run', Object.assign({ type, from: '2026-10-14', to: '2026-10-15' }, p));
const summary = (rep) => Object.fromEntries(rep.summary);

test('student report: total hours, distinct days, visits and automatic sign-outs, searched by register number', () => {
  const w = seeded();
  const found = w.ok(w.staff, 'students.list', { q: w.students[0].rollNo }).students[0];
  const a = run(w, w.staff, 'student', { studentId: found.studentId });
  assert.deepEqual(summary(a), { 'Total verified hours': 2, 'Distinct days': 2, Visits: 2, 'Automatic sign-outs': 0 });
  assert.deepEqual(a.sections[1].rows, [[w.lab.code, w.lab.name, 2, 2, 2, 0]], 'per-lab breakdown');
  assert.equal(a.rows.length, 2); assert.deepEqual(a.sections[0].rows, a.rows, 'the session table stays the first section');
  const b = run(w, w.staff, 'student', { studentId: w.students[1].studentId });
  assert.deepEqual(summary(b), { 'Total verified hours': 9, 'Distinct days': 1, Visits: 1, 'Automatic sign-outs': 1 });
  assert.ok(b.rows[0][7].includes('auto_out'));
  const none = run(w, w.staff, 'student', { studentId: w.students[2].studentId });
  assert.deepEqual(summary(none), { 'Total verified hours': 0, 'Distinct days': 0, Visits: 0, 'Automatic sign-outs': 0 });
  // A narrower range only counts what falls inside it.
  assert.deepEqual(summary(run(w, w.staff, 'student', { studentId: found.studentId, to: '2026-10-14' })), { 'Total verified hours': 1, 'Distinct days': 1, Visits: 1, 'Automatic sign-outs': 0 });
  // A student still gets only their own report.
  assert.deepEqual(summary(w.ok(w.students[1].email, 'reports.run', { type: 'student', from: '2026-10-14', to: '2026-10-15', studentId: w.students[0].studentId })), summary(b));
});

test('student home totals count days and time per lab', () => {
  const w = seeded();
  const t = w.ok(w.students[0].email, 'attend.history').totals;
  assert.equal(t.days, 2); assert.deepEqual(t.byLab, [{ labName: w.lab.name, days: 2, visits: 2, verifiedMinutes: 120 }]);
  assert.equal(w.ok(w.students[2].email, 'attend.history').totals.days, 0);
});

test('system usage: a change of system splits the visit, so each system gets only its own time', () => {
  const w = seeded();
  const rep = (i) => run(w, w.staff, 'systemUsage', { assetId: w.systems[i].assetId });
  const s0 = rep(0);
  assert.deepEqual(summary(s0), { People: 1, Visits: 2, 'Hours used': 1.5, Loans: 0, Bookings: '0 (0 used)' });
  assert.deepEqual(s0.rows.map((r) => [r[0], r[1], r[3], r[4], r[5], r[6], r[7]]), [
    ['2026-10-14', 'Visit', w.students[0].rollNo, '10:00', '10:30', 30, 'Report project 0'],
    ['2026-10-15', 'Visit', w.students[0].rollNo, '10:00', '11:00', 60, 'Report project 0']]);
  const s1 = rep(1);
  assert.deepEqual(summary(s1), { People: 1, Visits: 1, 'Hours used': 0.5, Loans: 0, Bookings: '0 (0 used)' });
  assert.deepEqual(s1.rows[0].slice(3, 7), [w.students[0].rollNo, '10:30', '11:00', 30]);
  const s2 = rep(2);
  assert.equal(summary(s2)['Hours used'], 9); assert.equal(s2.rows[0][1], 'Visit (auto sign-out)'); assert.equal(s2.rows[0][5], '19:00');
  assert.deepEqual(s2.sections[1].rows, [['Report project 1', 1, 1, 9]], 'grouped by purpose');
  // Narrow range, and an unused system.
  assert.deepEqual(summary(run(w, w.staff, 'systemUsage', { assetId: w.systems[0].assetId, to: '2026-10-14' })).Visits, 1);
  const unused = w.ok(w.staff, 'assets.upsert', { labId: w.lab.labId, categoryId: w.eval("Db.get('Assets','" + w.systems[0].assetId + "').categoryId"), name: 'Idle', assetTag: 'RPT-IDLE' }).asset;
  assert.deepEqual(summary(run(w, w.staff, 'systemUsage', { assetId: unused.assetId })), { People: 0, Visits: 0, 'Hours used': 0, Loans: 0, Bookings: '0 (0 used)' });
});

test('system usage: loans and bookings count people once and name the project they served', () => {
  const w = seeded();
  const drones = w.ok(w.staff, 'categories.upsert', { name: 'Drones', trackingMode: 'individual' }).category;
  const [d1, d2] = [1, 2].map((i) => w.ok(w.staff, 'assets.upsert', { labId: w.lab.labId, categoryId: drones.categoryId, name: 'Drone ' + i, assetTag: 'DRN-' + i }).asset);
  at(w, '2026-10-15', '12:00');
  const loan = w.ok(w.staff, 'loans.issue', { idemKey: key(), borrowerType: 'student', borrowerId: w.students[0].studentId, labId: w.lab.labId, items: [{ assetId: d1.assetId, qty: 1 }] });
  w.advance(2 * 3600000);
  const start = w.eval('U.now()') + 86400000, mine = w.students[1];
  assert.equal(w.err(mine.email, 'booking.request', { labId: w.lab.labId, resourceType: 'asset', resourceId: d2.assetId, startAt: start, endAt: start + 3600000, purpose: 'Aerial survey', projectId: w.projects[0].projectId }).code, 'NOT_ELIGIBLE', 'only the booker\'s own project');
  const bk = w.ok(mine.email, 'booking.request', { labId: w.lab.labId, resourceType: 'asset', resourceId: d2.assetId, startAt: start, endAt: start + 3600000, purpose: 'Aerial survey', projectId: w.projects[1].projectId }).reservation;
  assert.equal(bk.projectId, w.projects[1].projectId);
  w.ok(w.staff, 'booking.decide', { reservationId: bk.reservationId, approve: true });
  const r1 = run(w, w.staff, 'systemUsage', { assetId: d1.assetId, to: '2026-10-16' });
  assert.deepEqual(summary(r1), { People: 1, Visits: 0, 'Hours used': 2, Loans: 1, Bookings: '0 (0 used)' });
  assert.deepEqual(r1.rows[0].slice(1, 8), ['Loan', 'Student 1 (' + w.students[0].rollNo + ')', w.students[0].rollNo, '12:00', 'still out', 120, 'Loan']);
  const r2 = run(w, w.staff, 'systemUsage', { assetId: d2.assetId, to: '2026-10-16' });
  assert.deepEqual(summary(r2), { People: 0, Visits: 0, 'Hours used': 0, Loans: 0, Bookings: '1 (0 used)' }, 'an unused booking adds neither people nor hours');
  assert.equal(r2.rows[0][1], 'Booking (approved)'); assert.equal(r2.rows[0][7], 'Report project 1');
  assert.ok(loan.loan.loanId);
});

test('projects report: owner, supervisor, timeline, status, outcome and hours logged', () => {
  const w = seeded();
  const rep = run(w, w.staff, 'projects');
  assert.deepEqual(summary(rep), { Projects: 2, Active: 0, Completed: 0, 'Hours logged': 11 });
  const row = (title) => Object.fromEntries(rep.columns.map((c, i) => [c, rep.rows.find((r) => r[0] === title)[i]]));
  assert.deepEqual([row('Report project 0')['Hours logged'], row('Report project 0').Visits, row('Report project 0').Status], [2, 2, 'pending']);
  assert.deepEqual([row('Report project 1')['Hours logged'], row('Report project 1').Visits], [9, 1]);
  assert.equal(row('Report project 0').Owner, 'Student 1'); assert.equal(row('Report project 0')['Roll no.'], w.students[0].rollNo);
  assert.equal(row('Report project 0').Supervisor, w.eval("Db.get('FacultyProfiles','" + w.facultyId + "').name")); assert.equal(row('Report project 0').Lab, w.lab.name);
  assert.equal(row('Report project 0').Start, w.today); assert.equal(row('Report project 0').End, '2026-12-01');
  // Outcome and status come through, and filters narrow the list.
  const pid = w.projects[0].projectId;
  w.ok(w.faculty, 'projects.decide', { projectId: pid, approve: true });
  w.ok(w.students[0].email, 'projects.outcome', { projectId: pid, outcome: 'Built the classifier', outcomeLink: 'https://example.com/r' });
  const active = run(w, w.staff, 'projects', { status: 'active' });
  assert.equal(active.rows.length, 1); assert.equal(active.rows[0][9], 'Built the classifier'); assert.equal(active.rows[0][10], 'https://example.com/r');
  assert.equal(summary(active).Active, 1);
  assert.equal(run(w, w.staff, 'projects', { labId: w.lab2.labId }).rows.length, 0);
  assert.equal(w.err(w.staff, 'reports.run', { type: 'projects', status: 'bogus' }).code, 'BAD_INPUT');
  // Hours count only sessions inside the chosen dates.
  assert.equal(run(w, w.staff, 'projects', { from: '2026-10-14', to: '2026-10-14' }).rows.find((r) => r[0] === 'Report project 0')[11], 1);
});

test('reports: access rules for the new report types', () => {
  const w = seeded();
  const asset = w.systems[0].assetId;
  // Students cannot run either; faculty see only the projects they supervise and no system usage.
  assert.equal(w.err(w.students[0].email, 'reports.run', { type: 'systemUsage', assetId: asset }).code, 'FORBIDDEN');
  assert.equal(w.err(w.students[0].email, 'reports.run', { type: 'projects' }).code, 'FORBIDDEN');
  assert.equal(w.err(w.faculty, 'reports.run', { type: 'systemUsage', assetId: asset }).code, 'FORBIDDEN');
  assert.equal(run(w, w.faculty, 'projects').rows.length, 2);
  assert.equal(run(w, w.faculty2, 'projects').rows.length, 0, 'another faculty member supervises none of them');
  // A payload cannot widen or replace the server-side scope.
  assert.equal(run(w, w.faculty2, 'projects', { _supervisor: w.facultyId, _labIds: [w.lab.labId] }).rows.length, 0);
  assert.equal(run(w, w.admin, 'systemUsage', { assetId: asset }).rows.length, 2);
  assert.equal(w.err(w.staff, 'reports.run', { type: 'systemUsage' }).code, 'BAD_INPUT');
  assert.equal(w.err(w.staff, 'reports.run', { type: 'systemUsage', assetId: 'AST-000000000000' }).code, 'NOT_FOUND');
});

test('reports: CSV exports of the new reports carry the summary and neutralise spreadsheet formulas', () => {
  const w = seeded();
  w.e.run(`Db.update('Projects','${w.projects[1].projectId}',{title:'=HYPERLINK("http://x")'})`);
  const csv = w.ok(w.staff, 'reports.csv', { type: 'systemUsage', assetId: w.systems[2].assetId, from: '2026-10-14', to: '2026-10-15' }).csv;
  assert.ok(csv.includes('Summary,Value') && csv.includes('Hours used,9') && csv.includes('Who used it, when and for what') && csv.includes('By project or purpose'));
  assert.ok(!/(^|,)"?=HYPERLINK/m.test(csv), 'a leading = is escaped');
  const pcsv = w.ok(w.admin, 'reports.csv', { type: 'projects' }).csv;
  assert.ok(pcsv.includes('Hours logged') && !/(^|,)"?=HYPERLINK/m.test(pcsv));
});
