// Settings, migration, profiles and consent, occupancy, jobs, equipment requests, bookings, reports, quota.
const test = require('node:test');
const assert = require('node:assert/strict');
const { world, NOW } = require('./fixtures');
const { load, initDb } = require('./harness');

test('settings live in script properties (PropertiesService), validated and audited', () => {
  const w = world({ students: 0 });
  w.ok(w.admin, 'settings.set', { values: { kioskQrIntervalSeconds: 9, geoUnavailablePolicy: 'reject', hodEmail: 'hod@karunya.edu' } });
  const props = w.eval('PropertiesService.getScriptProperties().getProperties()');
  assert.equal(props['cfg.kioskQrIntervalSeconds'], '9'); assert.equal(props['cfg.geoUnavailablePolicy'], 'reject');
  assert.equal(w.eval("typeof Cfg.SCHEMA.Config"), 'undefined', 'no settings sheet');
  assert.equal(w.err(w.admin, 'settings.set', { values: { kioskQrIntervalSeconds: 3 } }).code, 'BAD_INPUT', 'FR-7 range is 5-10 s');
  assert.equal(w.err(w.admin, 'settings.set', { values: { rollEmailPattern: '([' } }).code, 'BAD_INPUT');
  assert.equal(w.err(w.admin, 'settings.set', { values: { hodEmail: 'hod@gmail.com' } }).code, 'BAD_INPUT');
  assert.equal(w.err(w.admin, 'settings.set', { values: { rescanMinFraction: 90, rescanMaxFraction: 20 } }).code, 'BAD_INPUT');
  const groups = new Set(w.ok(w.admin, 'settings.get').settings.map((s) => s.group));
  assert.ok(groups.has('Kiosk QR + GPS (A)') && groups.has('Device QR (B)'));
  const audit = w.eval("Db.readAll('AuditEvents').filter(function(e){return e.action==='settings.update';})");
  assert.equal(audit.length, 1); assert.deepEqual(audit[0].detail.kioskQrIntervalSeconds, { from: 7, to: 9 });
});

test('additive migration: an older sheet gains the new columns; anything else is refused', () => {
  const e = load(); initDb(e);
  // simulate an older deployment: the Labs sheet only has the first 11 columns, with data
  e.run(`(function(){ var s = Db.sheet('Labs'), n = Cfg.SCHEMA.Labs.length;
    s.getRange(1, 12, 1, n - 11).setValues([Cfg.SCHEMA.Labs.slice(11).map(function(){ return ''; })]);
    s.getRange(2, 1, 1, 11).setValues([['LAB-000000000001','OLD','Old lab','iot','','',10,'active','',1,'']]); })()`);
  const out = e.run('JSON.stringify(Setup.initialise({ silent: true }))');
  assert.ok(JSON.parse(out).extended.some((x) => /^Labs \+/.test(x)));
  assert.equal(e.run("Db.readAll('Labs')[0].code"), 'OLD', 'data untouched');
  e.run(`Db.sheet('Users').getRange(1, 2, 1, 1).setValues([['mail']])`);
  assert.throws(() => e.run('Setup.initialise({ silent: true })'), /SCHEMA_MISMATCH|headers differ/);
});

test('onboarding: privacy notice must be accepted, mobile validated, roll number taken from the email (FR-2, FR-3)', () => {
  const w = world({ students: 0 });
  const roll = 'urk24cs1021@karunya.edu.in';
  assert.equal(w.ok(roll, 'me').derivedRollNo, 'URK24CS1021');
  assert.equal(w.err(roll, 'onboard', { rollNo: 'URK24CS9999', name: 'Armaan', mobile: '9876543210' }).code, 'CONSENT_REQUIRED');
  assert.equal(w.err(roll, 'onboard', { rollNo: 'URK24CS9999', name: 'Armaan', mobile: '12345', consent: true }).code, 'BAD_INPUT');
  const r = w.ok(roll, 'onboard', { rollNo: 'URK24CS9999', name: 'Armaan', mobile: '+91 98765 43210', consent: true });
  assert.equal(r.student.rollNo, 'URK24CS1021', 'typed roll number ignored: it comes from the email');
  assert.equal(r.student.status, 'verified');
  const me = w.ok(roll, 'me');
  assert.equal(me.mobile, '9876543210'); assert.equal(me.consentRequired, false);
  // staff accounts are created by admins; they see the notice on first visit
  assert.equal(w.ok(w.staff, 'me').consentRequired, true);
  w.ok(w.staff, 'profile.update', { consent: true, mobile: '9000000001' });
  const st = w.ok(w.staff, 'me'); assert.equal(st.consentRequired, false); assert.equal(st.profileIncomplete, false);
  assert.equal(w.eval("Db.readAll('AuditEvents').filter(function(e){return e.action==='consent.accept';}).length"), 1);
  // turning the derivation off falls back to the typed roll number, pending verification
  w.ok(w.admin, 'settings.set', { values: { rollFromEmail: false } });
  const r2 = w.ok('urk24cs1022@karunya.edu.in', 'onboard', { rollNo: 'ABC123', name: 'Other', mobile: '9876543211', consent: true });
  assert.equal(r2.student.rollNo, 'ABC123'); assert.equal(r2.student.status, 'pending');
});

test('consent is required before device registration and kiosk check-in', async () => {
  const w = world({ students: 1 }); const [s] = w.students;
  w.eval("Db.update('Users', Db.getBy('Users','email'," + JSON.stringify(s.email) + ").userId, { consentVersion: 'old' })");
  assert.equal(w.ok(s.email, 'me').consentRequired, true);
  assert.equal(w.err(s.email, 'cred.complete', { challenge: w.ok(s.email, 'cred.begin').challenge, publicKey: 'A'.repeat(87), signature: 'A'.repeat(86) }).code, 'CONSENT_REQUIRED');
});

test('sessions open themselves from the timetable; overstay alert after closing time', () => {
  const w = world({ students: 1 }); const [s] = w.students;
  const sid = w.session().sessionId;
  w.e.setTime(NOW - 10 * 60000);
  assert.equal(w.eval('Sessions.autoOpenDue()').opened, 0, 'too early');
  w.e.setTime(NOW - 4 * 60000);
  assert.equal(w.eval('Sessions.autoOpenDue()').opened, 1);
  assert.equal(w.ok(w.faculty, 'sessions.get', { sessionId: sid }).session.status, 'open');
  assert.equal(w.checkin(s).ok, true);
  w.ok(w.admin, 'settings.set', { values: { autoOpenSessions: false } });
  assert.equal(w.eval('Sessions.autoOpenDue()').disabled, true);
  // lab closes at 19:00; student never leaves; session kept open by an admin
  w.ok(w.admin, 'labs.upsert', Object.assign({}, w.lab, { inchargeEmails: 'incharge@karunya.edu' }));
  w.e.setTime(Date.UTC(2026, 9, 14, 13, 35)); // 19:05 IST
  assert.equal(w.eval('Jobs.overstay()').alerts, 0, 'before the alert delay');
  w.e.setTime(Date.UTC(2026, 9, 14, 13, 45)); // 19:15 IST
  const occ = w.eval("Occupancy.lab(" + JSON.stringify(w.lab.labId) + ")");
  assert.equal(occ.inside, 1);
  assert.equal(w.eval('Jobs.overstay()').alerts, 1);
  assert.equal(w.eval('Jobs.overstay()').alerts, 0, 'once per lab per day');
  const notes = w.eval("Db.readAll('Notifications').filter(function(n){return n.type==='overstay';})");
  assert.ok(notes.length >= 1 && /still inside/.test(notes[0].title));
  assert.ok(w.e.sentMail.some((m) => m.to === 'incharge@karunya.edu'), 'incharge without an account is emailed directly');
});

test('equipment requests need an active check-in (FR-21); staff fulfil on the issue screen; catalogue is open to all (FR-20)', () => {
  const w = world({ students: 1 }); const [s] = w.students;
  const S = w.staff;
  const esp = w.ok(S, 'categories.upsert', { name: 'ESP32 board', trackingMode: 'individual' }).category;
  const a1 = w.ok(S, 'assets.upsert', { categoryId: esp.categoryId, labId: w.lab.labId, name: 'ESP32', assetTag: 'ESP-001' }).asset;
  w.ok(S, 'assets.upsert', { categoryId: esp.categoryId, labId: w.lab.labId, name: 'ESP32', assetTag: 'ESP-002' });
  const cat = w.ok(s.email, 'catalog.list', { labId: w.lab.labId }).labs[0];
  assert.equal(cat.categories[0].free, 2); assert.equal(cat.units.length, 2); assert.equal(cat.units[0].serialNo, undefined, 'no serials for students');
  assert.equal(w.err(s.email, 'equipment.request', { labId: w.lab.labId, resourceType: 'category', resourceId: esp.categoryId }).code, 'NOT_CHECKED_IN');
  w.ok(w.faculty, 'sessions.open', { sessionId: w.session().sessionId });
  w.checkin(s);
  const req = w.ok(s.email, 'equipment.request', { labId: w.lab.labId, resourceType: 'category', resourceId: esp.categoryId, quantity: 1, note: 'Board for LED blink' }).request;
  assert.equal(req.status, 'pending'); assert.ok(req.sessionId);
  assert.equal(w.ok(S, 'dash.staff').pendingEquipment, 1);
  assert.equal(w.ok(S, 'equipment.list', {}).requests[0].rollNo, 'S001');
  const loan = w.ok(S, 'loans.issue', { idemKey: 'k'.repeat(20), borrowerType: 'student', borrowerId: s.studentId, labId: w.lab.labId, items: [{ assetId: a1.assetId }], requestId: req.requestId }).loan;
  const done = w.ok(s.email, 'equipment.mine').requests[0];
  assert.equal(done.status, 'fulfilled'); assert.equal(done.loanId, loan.loanId);
  const req2 = w.ok(s.email, 'equipment.request', { labId: w.lab.labId, resourceType: 'category', resourceId: esp.categoryId }).request;
  w.ok(S, 'equipment.decide', { requestId: req2.requestId, note: 'None left on the shelf' });
  assert.equal(w.ok(s.email, 'equipment.mine').requests[0].status, 'rejected');
  assert.equal(w.err(s.email, 'equipment.request', { labId: w.lab.labId, resourceType: 'category', resourceId: esp.categoryId, quantity: 5 }).code, 'NOT_AVAILABLE');
});

test('workstation slots: a no-show is released after 15 minutes; a used slot completes at its end (FR-25)', () => {
  const w = world({ students: 2 }); const [a, b] = w.students;
  const cat = w.ok(w.staff, 'categories.upsert', { name: 'GPU workstation', trackingMode: 'individual' }).category;
  const ws1 = w.ok(w.staff, 'assets.upsert', { categoryId: cat.categoryId, labId: w.lab.labId, name: 'RTX #1', assetTag: 'WS-1' }).asset;
  const ws2 = w.ok(w.staff, 'assets.upsert', { categoryId: cat.categoryId, labId: w.lab.labId, name: 'RTX #2', assetTag: 'WS-2' }).asset;
  const start = NOW + 60 * 60000, end = start + 2 * 3600000;
  const r1 = w.ok(a.email, 'booking.request', { labId: w.lab.labId, resourceType: 'asset', resourceId: ws1.assetId, startAt: start, endAt: end, purpose: 'Training' }).reservation;
  const r2 = w.ok(b.email, 'booking.request', { labId: w.lab.labId, resourceType: 'asset', resourceId: ws2.assetId, startAt: start, endAt: end, purpose: 'Training' }).reservation;
  w.ok(w.staff, 'booking.decide', { reservationId: r1.reservationId, approve: true });
  w.ok(w.staff, 'booking.decide', { reservationId: r2.reservationId, approve: true });
  w.e.setTime(start + 5 * 60000);
  assert.equal(w.checkin(a, { reservationId: r1.reservationId, action: 'in', reason: 'research' }).ok, true);
  w.e.setTime(start + 16 * 60000);
  const x = w.eval('Booking.expireStale()');
  assert.equal(x.released, 1);
  const list = w.ok(w.staff, 'booking.list', {}).reservations;
  assert.equal(list.find((r) => r.reservationId === r2.reservationId).status, 'expired');
  assert.match(list.find((r) => r.reservationId === r2.reservationId).decisionNote, /No-show/);
  assert.equal(list.find((r) => r.reservationId === r1.reservationId).status, 'approved');
  w.e.setTime(end + 60000);
  assert.equal(w.eval('Booking.expireStale()').completed, 1);
  // utilisation in the monthly audit uses used slots
  const ma = w.ok(w.admin, 'reports.run', { type: 'monthlyAudit', month: '2026-10' });
  const util = ma.sections.find((s) => /Workstation/.test(s.title)).rows;
  assert.deepEqual(util.find((r) => r[0] === 'WS-1').slice(2, 5), [2, 2, 100]);
  assert.deepEqual(util.find((r) => r[0] === 'WS-2').slice(2, 6), [2, 0, 0, 1]);
});

test('reports: digest (FR-34), custom range (FR-36), session log (FR-37), ERP (FR-39), CSV with sections', async () => {
  const w = world({ students: 3 }); const [a, b] = w.students;
  for (const s of w.students) await w.registerDevice(s);
  const sid = w.session().sessionId;
  w.ok(w.faculty, 'sessions.open', { sessionId: sid });
  w.checkin(a);
  w.phoneScan(w.faculty, await w.qr(b, sid, 'in'));
  w.advance(60 * 60000);
  w.checkin(a);
  w.ok(w.faculty, 'sessions.close', { sessionId: sid });
  const d = w.ok(w.staff, 'reports.run', { type: 'digest', date: w.today, labId: w.lab.labId });
  assert.equal(d.meta.uniqueVisits, 2); assert.equal(d.meta.unverifiedExits, 1); assert.equal(d.meta.peakInside, 2); assert.equal(d.meta.peakHour, 10);
  assert.equal(d.sections[0].rows.find((r) => r[0] === '10:00')[1], 2);
  const c = w.ok(w.staff, 'reports.run', { type: 'custom', from: w.today, to: w.today });
  assert.equal(c.sections[1].rows.length, 3);
  const log = w.ok(w.faculty, 'reports.run', { type: 'session', sessionId: sid });
  assert.equal(log.rows.find((r) => r[0] === 'S001')[6], 'kiosk');
  assert.equal(log.rows.find((r) => r[0] === 'S002')[6], 'scanner');
  assert.equal(log.rows.find((r) => r[0] === 'S001')[8], 'pass', 'geofence result');
  assert.equal(w.err(w.faculty2, 'reports.run', { type: 'session', sessionId: sid }).code, 'FORBIDDEN');
  const erp = w.ok(w.admin, 'reports.run', { type: 'erp', from: w.today, to: w.today });
  assert.deepEqual(erp.columns, ['date', 'roll_no', 'student_name', 'course_code', 'section', 'lab_code', 'session_id', 'session_type', 'status', 'first_in', 'last_out', 'verified_minutes', 'method', 'flags']);
  assert.equal(erp.rows.length, 3);
  assert.equal(w.err(w.staff, 'reports.run', { type: 'erp' }).code, 'FORBIDDEN');
  const csv = w.ok(w.staff, 'reports.csv', { type: 'digest', date: w.today, labId: w.lab.labId }).csv;
  assert.equal(csv.charCodeAt(0), 0xFEFF, 'BOM for Excel');
  assert.ok(csv.includes('Hourly distribution') && csv.includes('Summary,Value'));
  assert.ok(w.ok(w.staff, 'reports.pdf', { type: 'monthlyAudit', month: '2026-10' }).base64.length > 0);
});

test('scheduled digest goes to lab incharges with the PDF; monthly audit on the 1st goes to the HOD', () => {
  const w = world({ students: 1 }); const [s] = w.students;
  w.ok(w.admin, 'labs.upsert', Object.assign({}, w.lab, { inchargeEmails: 'incharge@karunya.edu' }));
  w.ok(w.admin, 'settings.set', { values: { hodEmail: 'hod@karunya.edu', reportRecipients: 'office@karunya.edu' } });
  w.ok(w.faculty, 'sessions.open', { sessionId: w.session().sessionId });
  w.checkin(s);
  w.e.setTime(Date.UTC(2026, 9, 14, 12, 30)); // 18:00 IST
  const r = w.eval('Jobs.evening()');
  assert.equal(r.status, 'ok');
  const mail = w.e.sentMail.filter((m) => /Daily digest/.test(m.subject));
  assert.ok(mail.some((m) => m.to === 'incharge@karunya.edu' && m.o && m.o.attachments && m.o.attachments.length === 1));
  assert.ok(mail.some((m) => m.to === 'office@karunya.edu'));
  const n = w.e.sentMail.length;
  w.e.run("CacheService.getScriptCache().remove('job|evening')");
  w.eval('Jobs.evening()');
  assert.equal(w.e.sentMail.length, n, 'idempotent per date');
  w.e.setTime(Date.UTC(2026, 10, 1, 1, 0)); // 1 Nov, 06:30 IST
  const nr = w.eval('Jobs.nightly()');
  assert.equal(nr.detail.monthlyAudit.month, '2026-10');
  assert.ok(w.e.sentMail.some((m) => m.to === 'hod@karunya.edu' && /Monthly audit - 2026-10/.test(m.subject)));
});

test('quota panel reports usage against Google limits (SRS 14)', () => {
  const w = world({ students: 1 });
  const q = w.ok(w.admin, 'system.quota');
  const keys = q.items.map((i) => i.key);
  assert.deepEqual(keys, ['mail', 'triggers', 'triggerCount', 'calls', 'docs', 'props', 'cells']);
  assert.ok(q.items.find((i) => i.key === 'calls').used > 5, 'requests are counted');
  assert.equal(q.items.find((i) => i.key === 'triggerCount').used, 5);
  assert.equal(w.err(w.staff, 'system.quota').code, 'FORBIDDEN');
});

test('launch links are filtered and escaped before they reach the page', () => {
  const w = world({ students: 0 });
  assert.equal(w.eval("launchJson_({ k: 'k1.KSK-0123456789AB.123.abcdefghijklmnop' })").replace(/\\u003c/g, '<'), '{"k":"k1.KSK-0123456789AB.123.abcdefghijklmnop"}');
  assert.equal(w.eval("launchJson_({ k: '</script><script>alert(1)</script>' })"), '{}');
  assert.equal(w.eval("launchJson_({ s: 'a'.repeat(30) })"), '{}', 'too short to be a student code');
  assert.equal(w.eval("launchJson_(null)"), '{}');
});

test('frequent manual check-ins and repeated missing exits are flagged', () => {
  const w = world({ students: 2 }); const [a, b] = w.students;
  for (let day = 0; day < 3; day++) {
    w.e.setTime(NOW + day * 7 * 86400000);
    const date = w.eval('U.local(U.now()).date');
    const ses = w.ok(w.faculty, 'sessions.day', { date }).sessions[0];
    w.ok(w.faculty, 'sessions.open', { sessionId: ses.sessionId });
    w.ok(w.faculty, 'attend.correct', { sessionId: ses.sessionId, studentId: a.studentId, action: 'add_in', reason: 'Phone battery dead, seen in person' });
    w.checkin(b);
    w.advance(60 * 60000);
    w.ok(w.faculty, 'sessions.close', { sessionId: ses.sessionId });
  }
  const types = w.ok(w.staff, 'flags.list', {}).flags.map((f) => f.type + ':' + f.rollNo).sort();
  assert.ok(types.includes('frequent_manual:S001'));
  assert.ok(types.includes('never_scans_out:S002'));
});
