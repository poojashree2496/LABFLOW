const test = require('node:test');
const assert = require('node:assert/strict');
const { world } = require('./fixtures');

test('session mode is rechecked after GPS validation, before redeeming a kiosk pass', () => {
  const w = world({ students: 1 }), [s] = w.students;
  w.sid = w.session().sessionId;
  w.ok(w.faculty, 'sessions.open', { sessionId: w.sid, checkinMode: 'A' });
  w.e.run(`var geoStep = Checkin.STEPS_A.filter(function (s) { return s.id === 'geofence'; })[0], originalGeo = geoStep.run;
    geoStep.run = function (c) { originalGeo(c); Db.update('Sessions', c.session.sessionId, {checkinMode:'B'}); };`);
  assert.equal(w.checkin(s, { sessionId: w.sid }).error.code, 'MODE_DISABLED');
  assert.equal(w.eval("Db.readAll('AttendanceEvents').length"), 0);
  assert.equal(w.eval("Db.readAll('Redemptions').length"), 0);
});

test('kiosk options do not offer exits or rescans for a device-only session', async () => {
  const w = world({ students: 1 }), [s] = w.students;
  w.sid = w.session().sessionId;
  w.ok(w.faculty, 'sessions.open', { sessionId: w.sid, checkinMode: 'B' });
  await w.registerDevice(s);
  assert.equal(w.scan(await w.qr(s, w.sid, 'in')).ok, true);
  w.ok(w.faculty, 'attend.openRescan', { sessionId: w.sid });
  const options = w.ok(s.email, 'checkin.open', { code: w.kioskCode() });
  assert.equal(options.inside, null);
  assert.ok(!options.actions.includes('out') && !options.actions.includes('rescan'));
  assert.ok(!options.candidates.some((x) => x.sessionId === w.sid));
});

