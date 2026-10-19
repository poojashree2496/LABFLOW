const test = require('node:test');
const assert = require('node:assert/strict');
const { world } = require('./fixtures');
function ready() {
  const w = world(); w.ok(w.admin, 'labs.upsert', { ...w.lab, openLab: true });
  const cat = w.ok(w.staff, 'categories.upsert', { name: 'Report systems', trackingMode: 'individual', workstation: true }).category;
  w.assets = [1, 2].map((i) => w.ok(w.staff, 'assets.upsert', { categoryId: cat.categoryId, labId: w.lab.labId, name: 'Report system ' + i, assetTag: 'REPORT-' + i }).asset);
  w.projects = [0, 1].map((i) => w.ok(w.students[0].email, 'projects.create', { title: 'Report project ' + i, description: 'Report test', supervisorFacultyId: i ? w.faculty2Id : w.facultyId, labId: w.lab.labId, startDate: w.today, endDate: '2026-12-01' }).project);
  w.sid = w.ok(w.students[0].email, 'sessions.mine').sessions.find((s) => s.type === 'openlab').sessionId;
  w.enter = (asset = 0, project = 0) => assert.equal(w.checkin(w.students[0], { sessionId: w.sid, assetId: w.assets[asset].assetId, projectId: w.projects[project].projectId }).ok, true);
  w.exit = () => assert.equal(w.checkin(w.students[0], { sessionId: w.sid, action: 'out' }).ok, true);
  w.change = (asset, project) => { const x = w.ok(w.students[0].email, 'sessions.mine').sessions.find((s) => s.sessionId === w.sid).mine.work;
    return w.ok(w.students[0].email, 'attend.setWork', { sessionId: w.sid, entryEventId: x.entryEventId, expectedEventId: x.eventId, assetId: w.assets[asset].assetId, projectId: w.projects[project].projectId }).work; };
  w.report = (type, extra = {}, who = w.staff) => w.ok(who, 'reports.run', { type, from: w.today, to: w.today, ...extra });
  return w;
}
const summary = (r, key) => r.summary.find((x) => x[0] === key)[1];
test('reports: student totals count re-entry visits, unique days and per-lab hours without counting absences', () => {
  const w = ready(); w.enter(); w.advance(3600000); w.exit(); w.advance(180000); w.enter(); w.advance(1800000); w.exit();
  const r = w.report('student', { studentId: w.students[0].studentId });
  assert.equal(r.meta.totals.visits, 2); assert.equal(r.meta.totals.distinctDays, 1); assert.equal(r.meta.totals.hours, 1.5); assert.equal(r.meta.labTotals[0].hours, 1.5);
  assert.equal(w.report('student', { studentId: w.students[1].studentId }).meta.totals.distinctDays, 0);
  assert.equal(w.ok(w.students[0].email, 'dash.student').labAttendance[0].hours, 1.5);
});
test('reports: work changes partition credited system and project time without resetting verification', () => {
  const w = ready(); w.enter(); w.advance(1800000); w.change(1, 1); w.advance(3600000); w.exit();
  assert.equal(w.report('systemUsage', { assetId: w.assets[0].assetId }).meta.verifiedMinutes, 30);
  const second = w.report('systemUsage', { assetId: w.assets[1].assetId }); assert.equal(second.meta.verifiedMinutes, 60); assert.equal(summary(second, 'Attendance visits'), 1);
  const projects = w.report('projects'); assert.equal(projects.rows.find((r) => r[0] === 'Report project 0').at(-1), 0.5); assert.equal(projects.rows.find((r) => r[0] === 'Report project 1').at(-1), 1);
});
test('reports: missed class exits and unverified WORK changes do not create hours', () => {
  const w = ready(); w.enter(); w.advance(3600000); w.change(1, 1);
  assert.equal(w.report('systemUsage', { assetId: w.assets[1].assetId }).meta.verifiedMinutes, 0);
  assert.equal(w.report('student', { studentId: w.students[0].studentId }).meta.totals.hours, 0);
});
test('reports: automatic closing credits to closing and counts auto sign-outs', () => {
  const w = ready(); w.e.setTime(w.eval(`U.fromLocal('${w.today}','19:05')`));
  // Enter at the original clock, then delay the close trigger.
  w.e.setTime(w.NOW); w.enter(); w.e.setTime(w.eval(`U.fromLocal('${w.today}','19:05')`));
  const r = w.report('student', { studentId: w.students[0].studentId }); assert.equal(r.meta.totals.hours, 9); assert.equal(r.meta.totals.autoSignOuts, 1);
  assert.equal(w.report('systemUsage', { assetId: w.assets[0].assetId }).meta.verifiedMinutes, 540);
});
test('reports: breaks and missed rescans cap credited work using attendance policy', () => {
  const w = ready(); w.enter(); w.advance(7200000); w.exit();
  w.e.run(`Db.update('Sessions','${w.sid}',{breakStart:${w.NOW + 1800000},breakEnd:${w.NOW + 3600000}})`);
  assert.equal(w.report('systemUsage', { assetId: w.assets[0].assetId }).meta.verifiedMinutes, 90);
  w.e.run(`Db.insert('RescanWindows',{windowId:U.id('window'),sessionId:'${w.sid}',status:'closed',openedAt:${w.NOW + 600000},closesAt:${w.NOW + 660000}})`);
  assert.equal(w.report('systemUsage', { assetId: w.assets[0].assetId }).meta.verifiedMinutes, 0);
});
test('reports: voiding a work change restores the previous system and project allocation', () => {
  const w = ready(); w.enter(); w.advance(1800000); const work = w.change(1, 1); w.advance(1800000); w.exit();
  w.e.run(`Db.insert('AttendanceEvents',{eventId:U.id('event'),sessionId:'${w.sid}',studentId:'${w.students[0].studentId}',type:'VOID',ref:'${work.eventId}',approvalStatus:'approved',at:U.now(),createdAt:U.now()})`);
  assert.equal(w.report('systemUsage', { assetId: w.assets[0].assetId }).meta.verifiedMinutes, 60); assert.equal(w.report('systemUsage', { assetId: w.assets[1].assetId }).rows.length, 0);
});
test('reports: reservations and loans appear separately and never add attendance hours', () => {
  const w = ready(), assetId = w.assets[0].assetId;
  const loan = w.ok(w.staff, 'loans.issue', { idemKey: 'reports-loan-000001', labId: w.lab.labId, borrowerType: 'student', borrowerId: w.students[0].studentId, items: [{ assetId }], days: 1 }).loan;
  const item = w.ok(w.staff, 'loans.get', {loanId:loan.loanId}).loan.items[0];
  w.advance(60000); w.ok(w.staff,'loans.return',{idemKey:'reports-return-0001',loanId:loan.loanId,lines:[{loanItemId:item.loanItemId,qtyReturned:1,conditionIn:'good'}]});
  w.ok(w.students[1].email, 'booking.request', { labId: w.lab.labId, resourceType: 'asset', resourceId: assetId, startAt: w.NOW + 3600000, endAt: w.NOW + 7200000, purpose: 'Train demo classifier' });
  const r = w.report('systemUsage', { assetId }); assert.equal(r.meta.verifiedMinutes, 0); assert.equal(r.sections[1].rows.length, 1); assert.equal(r.sections[2].rows.length, 1); assert.ok(r.sections[1].rows[0].includes('Train demo classifier'));
});
test('reports: new report roles are enforced and client-supplied scope cannot expand faculty access', () => {
  const w = ready(); w.enter(); w.advance(3600000); w.exit();
  assert.equal(w.report('projects', { reportFacultyId: '', reportLabIds: null }, w.faculty).rows.length, 1);
  assert.equal(w.report('projects', {}, w.faculty2).rows[0][0], 'Report project 1');
  assert.equal(w.err(w.faculty, 'reports.run', { type: 'systemUsage', assetId: w.assets[0].assetId }).code, 'FORBIDDEN');
  for (const type of ['projects', 'systemUsage']) assert.equal(w.err(w.students[0].email, 'reports.run', { type, assetId: w.assets[0].assetId }).code, 'FORBIDDEN');
  const own = w.report('student', { studentId: w.students[1].studentId }, w.students[0].email); assert.equal(own.meta.rollNo, w.students[0].rollNo);
  assert.equal(w.err(w.hod, 'reports.run', { type: 'projects' }).code, 'FORBIDDEN');
});
test('reports: asset, lab and date validation refuses mismatched or invalid filters', () => {
  const w = ready();
  assert.equal(w.err(w.staff, 'reports.run', { type: 'systemUsage', assetId: w.assets[0].assetId, labId: w.lab2.labId }).code, 'FORBIDDEN');
  assert.equal(w.err(w.staff, 'reports.run', { type: 'systemUsage', assetId: 'bad' }).code, 'BAD_INPUT');
  assert.equal(w.err(w.staff, 'reports.run', { type: 'projects', from: '2027-01-01', to: w.today }).code, 'BAD_INPUT');
  assert.equal(w.report('projects', { labId: w.lab2.labId }).rows.length, 0);
});
test('reports: CSV includes totals, per-lab and contextual sections with formula-safe values', () => {
  const w = ready(); w.enter(); w.advance(3600000); w.exit();
  w.e.run(`Db.update('Projects','${w.projects[0].projectId}',{title:'=MALICIOUS()'})`);
  for (const type of ['student', 'systemUsage', 'projects']) {
    const p = { type, studentId: w.students[0].studentId, assetId: w.assets[0].assetId, from: w.today, to: w.today };
    const csv = w.ok(w.staff, 'reports.csv', p).csv; assert.ok(csv.includes('Verified hours')); if (type !== 'student') assert.ok(csv.includes("'=MALICIOUS()"));
  }
});
test('reports: historical summary fallback retains days/hours and marks unavailable visit counts', () => {
  const w = ready();
  w.e.run(`Db.insert('AttendanceSummaries',{sumId:'${w.sid}:${w.students[0].studentId}',sessionId:'${w.sid}',studentId:'${w.students[0].studentId}',firstIn:U.now(),status:'present',verifiedMinutes:60,flags:[]})`);
  const r = w.report('student', { studentId: w.students[0].studentId }); assert.equal(r.meta.totals.hours, 1); assert.equal(r.meta.totals.distinctDays, 1); assert.equal(r.meta.totals.unknownVisitSessions, 1); assert.equal(r.meta.totals.visits, 0);
});
test('reports: usage clips an overnight visit to the chosen IST day', () => {
  const w = ready(); w.enter(); w.e.run(`Db.update('Sessions','${w.sid}',{type:'research',scheduledEnd:U.fromLocal('2026-10-15','02:00')})`);
  w.e.setTime(w.eval("U.fromLocal('2026-10-15','01:00')")); w.exit();
  const r = w.report('systemUsage', { assetId: w.assets[0].assetId, from: '2026-10-15', to: '2026-10-15' }); assert.equal(r.meta.verifiedMinutes, 60);
});
test('reports: voiding every entry does not resurrect a stored summary', () => {
  const w = ready(); w.enter(); w.advance(3600000); w.exit(); w.eval(`Attend.rebuildSummary('${w.sid}')`);
  w.e.run(`Db.whereEq('AttendanceEvents',{sessionId:'${w.sid}'}).forEach(function(e){Db.insert('AttendanceEvents',{eventId:U.id('event'),sessionId:e.sessionId,studentId:e.studentId,type:'VOID',ref:e.eventId,approvalStatus:'approved',at:U.now(),createdAt:U.now()});})`);
  const r = w.report('student', { studentId: w.students[0].studentId }); assert.equal(r.meta.totals.hours, 0); assert.equal(r.meta.totals.visits, 0);
});
test('reports: closed class missing exit stays unverified instead of inheriting open-lab credit', () => {
  const w = ready(); w.enter(); w.e.run(`Db.update('Sessions','${w.sid}',{type:'class'})`); w.advance(3600000); w.ok(w.admin, 'sessions.close', { sessionId: w.sid });
  const r = w.report('student', { studentId: w.students[0].studentId }); assert.equal(r.rows[0][3], 'unverified_exit'); assert.equal(r.meta.totals.hours, 0);
});
test('reports: new sectioned reports can use the existing PDF exporter', () => {
  const w = ready(); w.enter(); w.advance(3600000); w.exit();
  for (const type of ['student','systemUsage','projects']) assert.ok(w.ok(w.staff,'reports.pdf',{type,studentId:w.students[0].studentId,assetId:w.assets[0].assetId,from:w.today,to:w.today}).base64.length > 0);
});
test('reports: future HOD route integration fails closed and applies a supplied department scope', () => {
  const w = ready();
  assert.throws(() => w.eval(`Reports.run(Auth._contextForEmail('${w.hod}'),{type:'projects'})`), /B3/);
  w.e.run(`Auth.labScope=function(){return ['${w.lab2.labId}'];};`);
  assert.deepEqual(w.eval(`Reports.run(Auth._contextForEmail('${w.hod}'),{type:'projects'}).rows`), []);
  assert.throws(() => w.eval(`Reports.run(Auth._contextForEmail('${w.hod}'),{type:'systemUsage',assetId:'${w.assets[0].assetId}'})`), /scope/);
});
