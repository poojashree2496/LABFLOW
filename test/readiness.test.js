const test = require('node:test');
const assert = require('node:assert/strict');
const { world } = require('./fixtures');
const read = (w) => w.ok(w.admin, 'system.status').readiness;
const labCheck = (r, id, key) => r.labs.find((l) => l.labId === id).checks.find((c) => c.key === key);
const globalCheck = (r, key) => r.global.find((c) => c.key === key);

test('readiness is admin-only and reports missing setup without creating sessions or a backup folder', () => {
  const w = world({ students: 1 });
  w.ok(w.admin, 'labs.upsert', { ...w.lab, latitude: null, longitude: null, openTime: '', closeTime: '' });
  const sessions = w.eval("Db.readAll('Sessions')"), props = w.eval('PropertiesService.getScriptProperties().getProperties()');
  const r = read(w);
  assert.equal(labCheck(r, w.lab.labId, 'geofence').state, 'attention');
  assert.equal(labCheck(r, w.lab.labId, 'kiosk').state, 'attention');
  assert.equal(labCheck(r, w.lab.labId, 'hours').state, 'not_required');
  assert.equal(globalCheck(r, 'backup').state, 'attention');
  assert.equal(w.ok(w.admin, 'system.backups').folderUrl, null, 'opening the existing backup panel is also read-only');
  assert.deepEqual(w.eval("Db.readAll('Sessions')"), sessions);
  assert.deepEqual(w.eval('PropertiesService.getScriptProperties().getProperties()'), props);
  for (const who of [w.hod, w.staff, w.faculty, w.students[0].email, w.kioskEmail]) assert.equal(w.err(who, 'system.status').code, 'FORBIDDEN');
});

test('readiness reflects saved GPS, hours, fresh kiosk, pending projects and backups', () => {
  const w = world({ students: 1 }), [s] = w.students;
  w.ok(w.admin, 'labs.upsert', { ...w.lab, openLab: true });
  w.ok(w.kioskEmail, 'kiosk.ping');
  w.ok(s.email, 'projects.create', { labId: w.lab.labId, title: 'Demo project', description: 'Pending is usable', supervisorFacultyId: w.facultyId, startDate: w.today, endDate: '2026-12-01' });
  w.ok(w.admin, 'system.backup');
  const r = read(w);
  for (const key of ['geofence', 'hours', 'kiosk', 'project', 'teaching']) assert.equal(labCheck(r, w.lab.labId, key).state, 'configured', key);
  assert.equal(globalCheck(r, 'backup').state, 'configured');
  w.advance(36 * 3600000 + 1);
  assert.equal(globalCheck(read(w), 'backup').state, 'attention');
});

test('device-only labs do not require GPS; kiosk freshness and inactive labs are explicit', () => {
  const w = world({ students: 0, mode: 'B' });
  w.ok(w.admin, 'labs.upsert', { ...w.lab, checkinMode: 'B', latitude: null, longitude: null });
  w.ok(w.admin, 'labs.upsert', { ...w.lab2, checkinMode: 'B', status: 'inactive' });
  w.ok(w.kioskEmail, 'kiosk.ping');
  const r = read(w);
  assert.equal(r.labs.length, 1);
  assert.equal(labCheck(r, w.lab.labId, 'geofence').state, 'not_required');
  w.advance(120000); assert.equal(labCheck(read(w), w.lab.labId, 'kiosk').state, 'configured');
  w.advance(1); assert.equal(labCheck(read(w), w.lab.labId, 'kiosk').state, 'attention');
});

test('unreadable backup folders produce unknown while the other setup checks still work', () => {
  const w = world({ students: 0 });
  w.ok(w.admin, 'system.backup');
  w.e.run("DriveApp.getFolderById = function () { throw new Error('permission denied SECRET_FOLDER'); };");
  const r = read(w);
  assert.equal(globalCheck(r, 'backup').state, 'unknown');
  assert.ok(r.labs.length > 0);
  assert.ok(!JSON.stringify(r).includes('SECRET_FOLDER'));
});

test('closed and cancelled classes do not appear as remaining teaching sessions', () => {
  const w = world({ students: 0 }), s = w.session();
  w.ok(w.faculty, 'sessions.open', { sessionId: s.sessionId });
  w.ok(w.faculty, 'sessions.close', { sessionId: s.sessionId });
  assert.equal(labCheck(read(w), w.lab.labId, 'teaching').state, 'info');
  w.e.run(`Db.update('Sessions',${JSON.stringify(s.sessionId)},{status:'cancelled'});`);
  assert.equal(labCheck(read(w), w.lab.labId, 'teaching').state, 'info');
});
