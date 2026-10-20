const test = require('node:test');
const assert = require('node:assert/strict');
const { world } = require('./fixtures');

function ready() {
  const w = world();
  w.lab = w.ok(w.admin, 'labs.upsert', { ...w.lab, openLab: true }).lab;
  w.category = w.ok(w.staff, 'categories.upsert', { name: 'Lab systems', trackingMode: 'individual', workstation: true }).category;
  w.systems = [1, 2, 3].map((n) => w.ok(w.staff, 'assets.upsert', { labId: w.lab.labId, categoryId: w.category.categoryId, name: 'GPU system ' + n, assetTag: 'SYSTEM-' + n }).asset);
  w.projects = w.students.map((s, i) => w.ok(s.email, 'projects.create', { title: 'Project ' + i, description: 'System work', labId: w.lab.labId,
    supervisorFacultyId: w.facultyId, startDate: w.today, endDate: '2026-12-01' }).project);
  w.sessionId = w.ok(w.students[0].email, 'sessions.mine').sessions.find((s) => s.type === 'openlab').sessionId;
  w.enter = (index, extra = {}) => w.checkin(w.students[index], { sessionId: w.sessionId, reason: 'openlab', projectId: w.projects[index].projectId, ...extra });
  w.state = (index = 0) => w.ok(w.students[index].email, 'sessions.mine').sessions.find((s) => s.sessionId === w.sessionId).mine;
  w.change = (index, assetId, extra = {}) => {
    const state = w.state(index);
    return w.call(w.students[index].email, 'attend.setWork', { sessionId: w.sessionId, entryEventId: state.work.entryEventId, expectedEventId: state.work.eventId,
      projectId: w.projects[index].projectId, assetId: assetId || '', ...extra });
  };
  return w;
}
const events = (w) => w.eval("Db.readAll('AttendanceEvents')");
function booking(w, index, asset) {
  const r = w.ok(w.students[index].email, 'booking.request', { labId: w.lab.labId, resourceType: 'asset', resourceId: asset.assetId,
    startAt: w.NOW, endAt: w.NOW + 7200000, purpose: 'System work' }).reservation;
  return w.ok(w.staff, 'booking.decide', { reservationId: r.reservationId, approve: true }).reservation;
}

test('work: category flags require individual tracking and survive partial category edits', () => {
  const w = ready();
  assert.equal(w.err(w.staff, 'categories.upsert', { name: 'Invalid systems', trackingMode: 'quantity', workstation: true }).code, 'BAD_INPUT');
  assert.equal(w.ok(w.staff, 'categories.upsert', { categoryId: w.category.categoryId, name: w.category.name, trackingMode: 'individual' }).category.workstation, true);
});

test('work: kiosk entry records a pending project and chosen system, with private availability choices', () => {
  const w = ready();
  const op = w.ok(w.students[0].email, 'checkin.open', { code: w.kioskCode() });
  assert.deepEqual(op.workChoices.projects.map((p) => p.projectId), [w.projects[0].projectId]);
  assert.equal(op.workChoices.systems.length, 3);
  assert.equal(JSON.stringify(op.workChoices).includes('student2'), false);
  assert.equal(w.enter(0, { assetId: w.systems[0].assetId }).ok, true);
  assert.equal(events(w)[0].projectId, w.projects[0].projectId); assert.equal(events(w)[0].assetId, w.systems[0].assetId);
  assert.equal(w.state().work.assetName, 'GPU system 1'); assert.equal(w.state().work.projectTitle, 'Project 0');
});

test('work: open-lab kiosk entry requires a project and permits an own-laptop visit', () => {
  const w = ready();
  assert.equal(w.enter(0, { projectId: '' }).error.code, 'BAD_INPUT');
  assert.equal(w.enter(0).ok, true); assert.equal(events(w)[0].assetId, '');
});

test('work: foreign, rejected and wrong-lab projects are refused before attendance is written', () => {
  const w = ready();
  assert.equal(w.enter(0, { projectId: w.projects[1].projectId }).error.code, 'NOT_ELIGIBLE');
  w.ok(w.faculty, 'projects.decide', { projectId: w.projects[0].projectId, approve: false });
  assert.equal(w.enter(0).error.code, 'NOT_ELIGIBLE');
  const q = w.ok(w.students[0].email, 'projects.create', { title: 'Other lab', description: 'Wrong lab', labId: w.lab2.labId,
    supervisorFacultyId: w.facultyId, startDate: w.today, endDate: '2026-12-01' }).project;
  assert.equal(w.enter(0, { projectId: q.projectId }).error.code, 'NOT_ELIGIBLE');
  assert.equal(events(w).length, 0);
});

test('work: busy systems cannot be claimed by a second student and become free after departure', () => {
  const w = ready(), id = w.systems[0].assetId;
  assert.equal(w.enter(0, { assetId: id }).ok, true);
  assert.equal(w.enter(1, { assetId: id }).error.code, 'SYSTEM_BUSY');
  const op = w.ok(w.students[1].email, 'checkin.open', { code: w.kioskCode() });
  assert.equal(op.workChoices.systems.find((s) => s.assetId === id).status, 'busy');
  w.advance(150000); assert.equal(w.checkin(w.students[0], { action: 'out' }).ok, true);
  assert.equal(w.enter(1, { assetId: id }).ok, true);
});

test('work: project/system changes are append-only and do not verify time or reset the exit gap', () => {
  const w = ready(); assert.equal(w.enter(0, { assetId: w.systems[0].assetId }).ok, true);
  const before = w.state(); w.advance(30000);
  assert.equal(w.change(0, w.systems[1].assetId).ok, true);
  assert.equal(w.state().verifiedMinutes, before.verifiedMinutes);
  assert.equal(w.state().lastIn, before.lastIn);
  assert.equal(w.enter(1, { assetId: w.systems[0].assetId }).ok, true, 'old system is immediately released');
  w.advance(90000); assert.equal(w.checkin(w.students[0], { action: 'out' }).ok, true, 'gap is measured from the entry, not WORK');
  assert.equal(w.state().verifiedMinutes, 2);
  assert.equal(events(w).filter((e) => e.type === 'WORK').length, 1);
});

test('work: own booked workstation is required and another student cannot take it', () => {
  const w = ready(), id = w.systems[0].assetId; booking(w, 0, w.systems[0]);
  const op = w.ok(w.students[0].email, 'checkin.open', { code: w.kioskCode() });
  assert.deepEqual(op.workChoices.bookedAssetIds, [id]);
  assert.equal(w.enter(0).error.code, 'BOOKED_SYSTEM_REQUIRED');
  assert.equal(w.enter(0, { assetId: w.systems[1].assetId }).error.code, 'BOOKED_SYSTEM_REQUIRED');
  assert.equal(w.enter(1, { assetId: id }).error.code, 'NOT_AVAILABLE');
  assert.equal(w.enter(0, { assetId: id }).ok, true);
  assert.equal(w.change(0, '').error.code, 'BOOKED_SYSTEM_REQUIRED');
});

test('work: only the selected booked workstation is marked used, including a later system change', () => {
  const w = ready(), first = booking(w, 0, w.systems[0]), second = booking(w, 0, w.systems[1]);
  assert.equal(w.enter(0, { assetId: w.systems[0].assetId }).ok, true);
  assert.ok(w.eval(`Db.get('Reservations','${first.reservationId}').usedAt`));
  assert.equal(w.eval(`Db.get('Reservations','${second.reservationId}').usedAt`), null);
  assert.equal(w.change(0, w.systems[1].assetId).ok, true);
  assert.ok(w.eval(`Db.get('Reservations','${second.reservationId}').usedAt`));
});

test('work: a named booking cannot be fulfilled with another system the same student also booked', () => {
  const w = ready(), first = booking(w, 0, w.systems[0]); booking(w, 0, w.systems[1]);
  const payload = { reservationId: first.reservationId, reason: 'research', projectId: w.projects[0].projectId };
  assert.equal(w.checkin(w.students[0], { ...payload, assetId: w.systems[1].assetId }).error.code, 'BOOKED_SYSTEM_REQUIRED');
  assert.equal(events(w).length, 0);
  assert.equal(w.checkin(w.students[0], { ...payload, assetId: w.systems[0].assetId }).ok, true);
});

test('work: unavailable, non-workstation and wrong-lab assets are refused', () => {
  const w = ready();
  w.e.run(`Db.update('Assets','${w.systems[0].assetId}',{status:'maintenance'}); Db.update('Assets','${w.systems[1].assetId}',{labId:'${w.lab2.labId}'});`);
  for (const a of w.systems.slice(0, 2)) assert.equal(w.enter(0, { assetId: a.assetId }).error.code, 'NOT_AVAILABLE');
  w.e.run(`Db.update('Categories','${w.category.categoryId}',{workstation:false})`);
  assert.equal(w.enter(0, { assetId: w.systems[2].assetId }).error.code, 'NOT_AVAILABLE');
  assert.equal(events(w).length, 0);
});

test('work: a system claimed during GPS validation is rechecked under the entry lock', () => {
  const w = ready(), id = w.systems[0].assetId;
  const op = w.ok(w.students[1].email, 'checkin.open', { code: w.kioskCode() });
  const payload = { pass: op.pass, action: 'in', sessionId: w.sessionId, projectId: w.projects[1].projectId, assetId: id, geo: w.at(1) };
  w.e.run(`var workGeo = Checkin.STEPS_A.filter(function(s){return s.id==='geofence';})[0], workGeoOriginal=workGeo.run;
    workGeo.run=function(c){workGeoOriginal(c);workGeo.run=workGeoOriginal;Checkin.submit(Auth._contextForEmail('${w.students[1].email}'),${JSON.stringify(payload)});};`);
  assert.equal(w.enter(0, { assetId: id }).error.code, 'SYSTEM_BUSY');
  assert.deepEqual(events(w).filter((e) => e.type === 'IN').map((e) => e.studentId), [w.students[1].studentId]);
});

test('work: project rejection during GPS validation prevents the pending entry', () => {
  const w = ready();
  w.e.run(`var workGeo = Checkin.STEPS_A.filter(function(s){return s.id==='geofence';})[0], workGeoOriginal=workGeo.run;
    workGeo.run=function(c){workGeoOriginal(c);Db.update('Projects','${w.projects[0].projectId}',{status:'rejected'});};`);
  assert.equal(w.enter(0).error.code, 'NOT_ELIGIBLE'); assert.equal(events(w).length, 0);
});

test('work: stale change versions and changes after exit/re-entry cannot overwrite the current visit', () => {
  const w = ready(); assert.equal(w.enter(0).ok, true);
  const old = w.state().work;
  assert.equal(w.change(0, w.systems[0].assetId).ok, true);
  assert.equal(w.change(0, w.systems[1].assetId, { expectedEventId: old.eventId }).error.code, 'CONFLICT');
  w.advance(150000); assert.equal(w.checkin(w.students[0], { action: 'out' }).ok, true);
  w.advance(7000); assert.equal(w.enter(0).ok, true);
  assert.equal(w.change(0, w.systems[1].assetId, { entryEventId: old.entryEventId }).error.code, 'NO_ENTRY');
});

test('work: repeated change ids replay once without duplicate work or audit events', () => {
  const w = ready(); assert.equal(w.enter(0).ok, true);
  const work = w.state().work, payload = { eventId: 'EVT-AABBCCDDEE00', sessionId: w.sessionId, entryEventId: work.entryEventId,
    expectedEventId: work.eventId, projectId: w.projects[0].projectId, assetId: w.systems[0].assetId };
  w.ok(w.students[0].email, 'attend.setWork', payload);
  assert.equal(w.ok(w.students[0].email, 'attend.setWork', payload).replay, true);
  assert.equal(events(w).filter((e) => e.type === 'WORK').length, 1);
  assert.equal(w.eval("Db.whereEq('AuditEvents',{action:'attend.work'}).length"), 1);
  assert.equal(w.err(w.students[1].email, 'attend.setWork', payload).code, 'CONFLICT');
});

test('work: voided work changes restore the prior effective system assignment', () => {
  const w = ready(); assert.equal(w.enter(0, { assetId: w.systems[0].assetId }).ok, true);
  const changed = w.change(0, w.systems[1].assetId); assert.equal(changed.ok, true);
  w.ok(w.admin, 'attend.correct', { sessionId: w.sessionId, studentId: w.students[0].studentId, action: 'void', eventId: changed.data.work.eventId, reason: 'Incorrect system selected' });
  assert.equal(w.state().work.assetId, w.systems[0].assetId);
});

test('work: device QR entry uses its booked system and supports a later project/system WORK update', async () => {
  const w = ready(), [s] = w.students;
  booking(w, 0, w.systems[0]); await w.registerDevice(s);
  const result = w.scan(await w.qr(s, w.sessionId, 'in')); assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(w.state().work.assetId, w.systems[0].assetId); assert.equal(w.state().work.projectId, '');
  assert.equal(w.change(0, w.systems[0].assetId).ok, true);
  assert.equal(w.state().work.projectId, w.projects[0].projectId);
});

test('work: an unbooked device QR visitor starts with own laptop and can claim a free system', async () => {
  const w = ready(), [s] = w.students; await w.registerDevice(s);
  assert.equal(w.scan(await w.qr(s, w.sessionId, 'in')).ok, true);
  assert.equal(w.state().work.assetId, '');
  assert.equal(w.change(0, w.systems[1].assetId).ok, true);
  assert.equal(w.state().verifiedMinutes, 0);
});

test('work: device scan refuses a busy booked system without consuming the nonce, then succeeds after release', async () => {
  const w = ready(), [a] = w.students;
  assert.equal(w.enter(1, { assetId: w.systems[0].assetId }).ok, true);
  booking(w, 0, w.systems[0]); await w.registerDevice(a);
  const qr = await w.qr(a, w.sessionId, 'in');
  assert.equal(w.scan(qr).error.code, 'SYSTEM_BUSY');
  assert.equal(w.change(1, '').ok, true);
  assert.equal(w.scan(qr).ok, true);
  assert.equal(events(w).filter((e) => e.studentId === a.studentId && e.type === 'IN').length, 1);
});

test('work: disabled students, HOD accounts and non-visitors cannot set work', () => {
  const w = ready(); assert.equal(w.enter(0).ok, true);
  const work = w.state().work, payload = { sessionId: w.sessionId, entryEventId: work.entryEventId, expectedEventId: work.eventId,
    projectId: w.projects[0].projectId, assetId: w.systems[0].assetId };
  assert.equal(w.err(w.hod, 'attend.setWork', payload).code, 'FORBIDDEN');
  assert.equal(w.err(w.students[1].email, 'attend.setWork', { ...payload, projectId: w.projects[1].projectId }).code, 'NO_ENTRY');
  w.e.run(`Db.update('StudentProfiles','${w.students[0].studentId}',{status:'disabled'})`);
  assert.equal(w.err(w.students[0].email, 'attend.setWork', payload).code, 'ACCOUNT_DISABLED', 'a disabled profile is refused at the door (B2)');
});
