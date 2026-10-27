/**
 * The local Test Lab world: the real src/*.gs running on the in-memory Apps Script fakes (test/harness.js), seeded with
 * a realistic department, a controllable clock, verification-pipeline fault injection, traces and simulated sheet
 * latency. Development only; nothing here is deployed (dev/ is in .claspignore).
 */
const nodeCrypto = require('crypto');
const { world: baseWorld, NOW, LAB_A } = require('../test/fixtures');

const FIRST = ['Aarav', 'Diya', 'Ishaan', 'Ananya', 'Rohan', 'Meera', 'Karthik', 'Nila', 'Arjun', 'Kavya', 'Vikram', 'Sneha', 'Rahul', 'Priya', 'Aditya', 'Lakshmi', 'Siddharth', 'Divya', 'Harish', 'Pooja',
  'Naveen', 'Asha', 'Gokul', 'Revathi', 'Joel', 'Shalini', 'Pranav', 'Keerthana', 'Sanjay', 'Swathi', 'Abel', 'Nandhini', 'Varun', 'Janani', 'Kevin', 'Harini', 'Dinesh', 'Ishwarya', 'Samuel', 'Yamini'];
const LAST = ['Kumar', 'Raj', 'Nair', 'Menon', 'Iyer', 'Thomas', 'Joseph', 'Pillai', 'Reddy', 'Das', 'Paul', 'Babu', 'Krishnan', 'Varghese', 'Prakash', 'Mathew', 'Suresh', 'George', 'Sharma', 'John'];
/** A point `n` metres north and `e` metres east of p. */
const near = (p, n, e) => ({ lat: +(p.lat + n / 111320).toFixed(6), lng: +(p.lng + e / (111320 * Math.cos(p.lat * Math.PI / 180))).toFixed(6) });
// Only LAB_A (IoT) is measured on site. The other three are made-up spots around it (80-115 m away, geofences apart)
// so the whole department fits on one map. Replace with real coordinates when they are known.
const LAB_B = near(LAB_A, 63, 48);
const LAB_C = near(LAB_A, -52, -71);
const LAB_UNNATI = near(LAB_A, -18, 112);
const PRESETS = { small: { students: 12, historyDays: 2 }, demo: { students: 30, historyDays: 5 }, large: { students: 60, historyDays: 10 } };
// Steps that only check something (safe to skip in the Test Lab to see what that check protects against).
const SKIPPABLE = ['nonce_fresh', 'qr_fresh', 'mode_enabled', 'rate_limit', 'device_active', 'student_verified', 'signature', 'replay', 'revocation_recheck', 'authorization_recheck', 'enrolment', 'attendance_state',
  'code_mac', 'code_age', 'code_unused', 'pass_fresh', 'geo_plausible', 'geofence', 'code_once', 'pass_mac'];

/** A clock that runs in real time from a chosen moment and can be paused, advanced or set. */
function makeClock(start) {
  const c = { base: start, realStart: Date.now(), paused: false, frozen: start };
  c.now = () => (c.paused ? c.frozen : c.base + (Date.now() - c.realStart));
  c.set = (ms) => { c.base = ms; c.realStart = Date.now(); c.frozen = ms; };
  c.advance = (ms) => c.set(c.now() + ms);
  c.pause = () => { c.frozen = c.now(); c.paused = true; };
  c.resume = () => { c.set(c.frozen); c.paused = false; };
  return c;
}

/**
 * Wrap every step of the verification pipelines (in the vm only) so the Test Lab can make a step fail, skip it, or
 * slow it down. The production code iterates the step list unchanged; these wrappers exist only in this process.
 */
function installPipelineHooks(lab) {
  const e = lab.w.e;
  e.ctx.__devFault = (pipeline, id) => lab.faults[pipeline + ':' + id] || null;
  e.ctx.__devSkipped = (id) => { lab.pendingSkips.push(id); };
  e.ctx.__pipelineObserver = (t) => {
    const rec = JSON.parse(JSON.stringify(t));
    rec.skipped = lab.pendingSkips.splice(0); rec.id = ++lab.traceSeq; rec.sheetOps = lab.opsSince(rec.at);
    lab.traces.push(rec); if (lab.traces.length > 200) lab.traces.shift();
  };
  e.run(`(function () {
    var pipes = { 'B.scan': Attend.STEPS_B, 'A.open': Checkin.STEPS_OPEN, 'A.checkin': Checkin.STEPS_A };
    Object.keys(pipes).forEach(function (name) {
      pipes[name].forEach(function (step) {
        if (step.__devWrapped) return;
        var orig = step.run; step.__devWrapped = name;
        step.run = function (c) {
          var m = __devFault(name, step.id);
          if (!m || m.mode === 'normal') return orig(c);
          if (m.mode === 'skip') { __devSkipped(step.id); return; }
          if (m.mode === 'fail') fail('INJECTED_FAULT', 'Test Lab: the "' + step.id + '" step is set to fail.');
          if (m.mode === 'delay') { var t = Date.now(); while (Date.now() - t < Math.min(5000, m.ms || 0)) { /* simulated slow step */ } }
          return orig(c);
        };
      });
    });
  })()`);
}

/** Count (and optionally slow down) every range read/write, to estimate Apps Script time for a flow. */
function installSheetMeter(lab) {
  const ss = Object.values(lab.w.e.spreadsheets)[0];
  lab.ops = { read: 0, write: 0 };
  lab.opLog = [];
  ss.onOp = (kind) => {
    lab.ops[kind]++;
    lab.opLog.push(Date.now()); if (lab.opLog.length > 5000) lab.opLog.splice(0, 1000);
    if (lab.latencyMs > 0) { const t = Date.now(); while (Date.now() - t < lab.latencyMs) { /* simulated sheet latency */ } }
  };
  lab.opsSince = () => lab.ops.read + lab.ops.write;
}

function seed(lab, preset) {
  const w = lab.w, A = w.admin, S = w.staff, opts = PRESETS[preset] || PRESETS.demo;
  w.e.setTime(NOW - 4 * 86400000); // set-up happened a few days before the simulated day
  // labs: the IoT lab follows the spec (kiosk QR + GPS), the GPU lab uses device QR, the computing lab offers both
  w.ok(A, 'labs.upsert', Object.assign({}, w.lab, { checkinMode: 'A', openTime: '08:00', closeTime: '19:00', inchargeEmails: 'staff@karunya.edu', building: 'Engineering block', room: 'EB-204' }));
  w.ok(A, 'labs.upsert', Object.assign({}, w.lab2, { latitude: LAB_B.lat, longitude: LAB_B.lng, checkinMode: 'B', openTime: '08:00', closeTime: '21:00', building: 'Research block', room: 'RB-110' }));
  lab.lab3 = w.ok(A, 'labs.upsert', { code: 'CMP01', name: 'Computing Lab', type: 'computing', capacity: 60, latitude: LAB_C.lat, longitude: LAB_C.lng, radiusM: 25, checkinMode: 'AB', openTime: '08:00', closeTime: '18:00', building: 'Engineering block', room: 'EB-101' }).lab;
  w.ok(A, 'kiosks.upsert', { labId: lab.lab3.labId, name: 'Computing door', authorizedEmail: 'kiosk3@karunya.edu' });
  w.ok(A, 'users.upsert', { email: 'faculty3@karunya.edu', displayName: 'Dr Priya Raman', roles: ['faculty'], employeeCode: 'F003' });
  w.ok(A, 'users.upsert', { email: 'faculty@karunya.edu', displayName: 'Dr Anand Joseph', roles: ['faculty'], employeeCode: 'F001' });
  w.ok(A, 'users.upsert', { email: 'faculty2@karunya.edu', displayName: 'Dr Sunita Mathew', roles: ['faculty'], employeeCode: 'F002' });
  w.ok(A, 'users.upsert', { email: S, displayName: 'Ravi (Lab staff)', roles: ['staff'] });
  w.ok(A, 'users.upsert', { email: A, displayName: 'Lab Admin', roles: ['admin'] });
  w.ok(A, 'users.upsert', { email: 'hod@karunya.edu', displayName: 'Dr Meena Krishnan (HOD, CSE)', roles: ['hod'] });
  const fac3 = w.ok('faculty3@karunya.edu', 'me').faculty.facultyId;
  const c2 = w.ok(A, 'courses.upsert', { code: 'CSE302', name: 'Deep Learning Lab' }).course, c3 = w.ok(A, 'courses.upsert', { code: 'CSE303', name: 'Web Technology Lab' }).course;
  w.ok(A, 'facultycourses.set', { facultyId: w.faculty2Id, courseId: c2.courseId, section: 'A' });
  w.ok(A, 'facultycourses.set', { facultyId: fac3, courseId: c3.courseId, section: 'A' });
  // students with realistic names; the email local part stays studentN so the Test Lab can switch identities
  const rows = [];
  for (let i = 1; i <= opts.students; i++) rows.push({ rollNo: 'URK24CS1' + String(i).padStart(3, '0'), name: FIRST[(i - 1) % FIRST.length] + ' ' + LAST[(i * 7) % LAST.length], email: 'student' + i + '@karunya.edu', section: 'A', year: 3 });
  w.ok(A, 'students.import', { rows });
  rows.forEach((r, i) => { const s = w.ok(r.email, 'onboard', { rollNo: r.rollNo, name: r.name, consent: true, mobile: '98' + String(40000000 + i * 3917).slice(0, 8) }).student; w.students.push({ email: r.email, studentId: s.studentId, rollNo: r.rollNo, name: r.name }); });
  w.demoPendingStudent = w.ok('pending.student@karunya.edu', 'onboard', { rollNo: 'URK24CS1999', name: 'Pending Verification', consent: true, mobile: '9876509999' }).student;
  [w.admin, w.staff, w.faculty, w.faculty2, 'faculty3@karunya.edu', 'hod@karunya.edu'].forEach((e, i) => w.ok(e, 'profile.update', { consent: true, mobile: '90000000' + String(10 + i) }));
  const rolls = rows.map((r) => r.rollNo);
  w.ok(A, 'roster.import', { courseId: w.course.courseId, rows: rolls });
  w.ok(A, 'roster.import', { courseId: c2.courseId, rows: rolls.slice(0, Math.ceil(rolls.length / 2)) });
  w.ok(A, 'roster.import', { courseId: c3.courseId, rows: rolls });
  // a weekly timetable on every working day so any simulated date has sessions
  for (let d = 1; d <= 6; d++) {
    if (d !== 3) w.ok(A, 'timetable.upsert', { labId: w.lab.labId, courseId: w.course.courseId, facultyId: w.facultyId, section: 'A', dayOfWeek: d, startTime: '10:00', endTime: '12:00', validFrom: '2026-10-01', validTo: '2026-12-31' });
    w.ok(A, 'timetable.upsert', { labId: w.lab2.labId, courseId: c2.courseId, facultyId: w.faculty2Id, section: 'A', dayOfWeek: d, startTime: '14:00', endTime: '16:00', validFrom: '2026-10-01', validTo: '2026-12-31' });
    w.ok(A, 'timetable.upsert', { labId: lab.lab3.labId, courseId: c3.courseId, facultyId: fac3, section: 'A', dayOfWeek: d, startTime: '09:00', endTime: '11:00', validFrom: '2026-10-01', validTo: '2026-12-31' });
  }
  // inventory
  const esp = w.ok(S, 'categories.upsert', { name: 'ESP32 board', trackingMode: 'individual' }).category, bb = w.ok(S, 'categories.upsert', { name: 'Breadboard', trackingMode: 'individual' }).category;
  const wire = w.ok(S, 'categories.upsert', { name: 'Jumper wires', trackingMode: 'quantity' }).category, led = w.ok(S, 'categories.upsert', { name: 'LED (5 mm)', trackingMode: 'quantity' }).category;
  const dht = w.ok(S, 'categories.upsert', { name: 'DHT22 sensor', trackingMode: 'individual' }).category, gpu = w.ok(S, 'categories.upsert', { name: 'GPU workstation', trackingMode: 'individual' }).category;
  const espAssets = [];
  for (let i = 1; i <= 12; i++) espAssets.push(w.ok(S, 'assets.upsert', { categoryId: esp.categoryId, labId: w.lab.labId, name: 'ESP32 DevKit', assetTag: 'ESP-' + String(i).padStart(3, '0'), serialNo: 'ESP32-SN' + (1000 + i), valueInr: 650, location: 'Cupboard A' }).asset);
  for (let i = 1; i <= 12; i++) w.ok(S, 'assets.upsert', { categoryId: bb.categoryId, labId: w.lab.labId, name: 'Breadboard 830', assetTag: 'BB-' + String(i).padStart(3, '0'), location: 'Cupboard A' });
  for (let i = 1; i <= 6; i++) w.ok(S, 'assets.upsert', { categoryId: dht.categoryId, labId: w.lab.labId, name: 'DHT22', assetTag: 'DHT-' + String(i).padStart(3, '0'), location: 'Drawer 3' });
  const wireAsset = w.ok(S, 'assets.upsert', { categoryId: wire.categoryId, labId: w.lab.labId, name: 'Jumper wires (M-M)', quantityTotal: 400, assetTag: 'WIRE-MM' }).asset;
  w.ok(S, 'assets.upsert', { categoryId: led.categoryId, labId: w.lab.labId, name: 'Red LED 5 mm', quantityTotal: 300, assetTag: 'LED-RED' });
  const workstations = [];
  for (let i = 1; i <= 4; i++) workstations.push(w.ok(S, 'assets.upsert', { categoryId: gpu.categoryId, labId: w.lab2.labId, name: 'RTX 4090 workstation #' + i, assetTag: 'WS-0' + i, serialNo: 'WS-SN-' + i, valueInr: 350000, location: 'Bay ' + i }).asset);
  w.ok(S, 'kits.upsert', { labId: w.lab.labId, name: 'LED blink kit', description: 'ESP32, breadboard, LED, wires', components: [{ categoryId: esp.categoryId, quantity: 1 }, { categoryId: bb.categoryId, quantity: 1 }, { categoryId: led.categoryId, quantity: 2 }, { categoryId: wire.categoryId, quantity: 10 }] });
  w.ok(S, 'groups.create', { name: 'Smart-farm team', studentIds: [w.students[0].studentId, w.students[1].studentId], leaderId: w.students[0].studentId, labId: w.lab.labId });
  // a class representative, and an evening workshop with a coordinator and a lunch break
  w.ok(w.faculty, 'classreps.set', { courseId: w.course.courseId, section: 'A', studentId: w.students[1].studentId });
  const demoEvent = w.ok(w.faculty, 'events.create', { name: 'Hands-on IoT workshop', labId: lab.lab3.labId, date: '2026-10-14', startTime: '12:00', endTime: '17:00', breakStart: '13:00', breakEnd: '14:00', capacity: 40, openToAll: true, coordinatorEmail: w.students[2].email, override: true }).event;
  lab.demoEventId = demoEvent.labEventId;
  // attendance history on earlier days, so reports and charts have something real in them
  history(lab, opts.historyDays);
  phoneAppClass(lab);
  // A live class and a couple of checked-in students make the dashboards and request queue useful immediately.
  w.e.setTime(NOW + 6 * 60000);
  w.e.run('Sessions.materialize(U.local(U.now()).date)');
  w.e.run('Sessions.autoOpenDue()');
  const todaySession = w.ok(A, 'sessions.day', { date: '2026-10-14' }).sessions.find((s) => s.labId === w.lab.labId);
  [w.students[0], w.students[1]].forEach((s) => {
    const result = w.checkin(s, { sessionId: todaySession.sessionId });
    if (!result.ok) throw new Error('Demo check-in failed for ' + s.email + ': ' + result.error.code);
  });
  lab.demoSessionId = todaySession.sessionId;
  w.ok(w.students[0].email, 'equipment.request', { labId: w.lab.labId, resourceType: 'category', resourceId: esp.categoryId, quantity: 1, note: 'Board for the LED blink exercise' });
  w.ok(A, 'spot.start', { sessionId: todaySession.sessionId, studentId: w.students[0].studentId });
  // a location-faking check-in: recorded (nobody is refused), flagged for the faculty and not counted as present
  w.checkin(w.students[11], { sessionId: todaySession.sessionId, geo: w.at(1, 0.5) });
  w.ok(w.faculty, 'events.register', { labEventId: demoEvent.labEventId, rollNos: [w.students[3].rollNo, w.students[4].rollNo] });
  w.ok(w.faculty, 'events.addGuest', { labEventId: demoEvent.labEventId, name: 'Demo Guest', organisation: 'Karunya Innovation Centre' });
  w.ok(w.students[8].email, 'research.request', { labId: w.lab2.labId, facultyId: w.facultyId, date: '2026-10-15', startTime: '14:00', endTime: '16:00', purpose: 'IoT sensor calibration research' });

  // Loans include a current checkout and an overdue example for the staff workflow.
  w.ok(S, 'loans.issue', { idemKey: 'demo-current-loan-0001', borrowerType: 'student', borrowerId: w.students[3].studentId, labId: w.lab.labId, items: [{ assetId: espAssets[0].assetId }, { assetId: wireAsset.assetId, qty: 20 }], days: 4 });
  w.e.setTime(NOW - 2 * 86400000);
  w.ok(S, 'loans.issue', { idemKey: 'demo-overdue-loan-0001', borrowerType: 'student', borrowerId: w.students[4].studentId, labId: w.lab.labId, items: [{ assetId: espAssets[1].assetId }], days: 1 });

  // Keep pending, approved and rejected reservations available to try from the student and staff screens.
  w.e.setTime(NOW + 6 * 60000);
  const bookingStart = NOW + 86400000, bookingEnd = bookingStart + 2 * 3600000;
  w.ok(w.students[5].email, 'booking.request', { labId: w.lab.labId, resourceType: 'kit', resourceId: w.eval("Db.readAll('Kits')[0].kitId"), startAt: bookingStart, endAt: bookingEnd, purpose: 'Prepare the IoT project demonstration' });
  const approved = w.ok(w.students[6].email, 'booking.request', { labId: w.lab2.labId, resourceType: 'asset', resourceId: workstations[0].assetId, startAt: bookingStart, endAt: bookingEnd, purpose: 'Train the image classifier' }).reservation;
  w.ok(S, 'booking.decide', { reservationId: approved.reservationId, approve: true, note: 'Approved for the scheduled project work.' });
  const rejected = w.ok(w.students[7].email, 'booking.request', { labId: w.lab2.labId, resourceType: 'asset', resourceId: workstations[1].assetId, startAt: bookingStart, endAt: bookingEnd, purpose: 'Use the GPU workstation for coursework' }).reservation;
  w.ok(S, 'booking.decide', { reservationId: rejected.reservationId, approve: false, note: 'Please use the next available slot.' });
  seedUnnati(lab);
  lab.studentsMeta = rows;
}

/** C5 demo placeholders only: no real room, coordinates, models or inventory have been supplied. */
function seedUnnati(lab) {
  const w = lab.w, placeholder = 'DEMO PLACEHOLDER: quantities, models and locations await the confirmed lab inventory.';
  w.e.setTime(NOW - 10 * 60000); // 09:50, before the Test Lab clock starts at 10:07
  const unnati = w.ok(w.admin, 'labs.upsert', { code: 'UNNATI', name: 'Intel Unnati AI Lab', type: 'gpu', capacity: 30,
    building: 'TBD (demo placeholder)', room: 'TBD (demo)', latitude: LAB_UNNATI.lat, longitude: LAB_UNNATI.lng, radiusM: 25,
    checkinMode: 'AB', openLab: true, openTime: '08:00', closeTime: '19:00', inchargeEmails: w.staff,
    notes: 'DEMO PLACEHOLDER: building, room, GPS, radius, capacity, opening hours and inventory are unconfirmed. Replace with real lab data when supplied.' }).lab;
  const kioskEmail = 'kiosk4@karunya.edu';
  w.ok(w.admin, 'kiosks.upsert', { labId: unnati.labId, name: 'Unnati demo door', authorizedEmail: kioskEmail });
  const systems = w.ok(w.staff, 'categories.upsert', { name: 'Unnati GPU workstation (demo)', trackingMode: 'individual', workstation: true, notes: placeholder }).category;
  const workstationIds = [];
  const addUnits = (category, label, tag, count) => {
    const ids = [];
    for (let i = 1; i <= count; i++) ids.push(w.ok(w.staff, 'assets.upsert', { labId: unnati.labId, categoryId: category.categoryId,
      name: label + ' ' + String(i).padStart(2, '0') + ' (demo)', assetTag: 'DEMO-UNNATI-' + tag + '-' + String(i).padStart(2, '0'),
      location: 'TBD (demo placeholder)', notes: placeholder }).asset.assetId);
    return ids;
  };
  workstationIds.push(...addUnits(systems, 'GPU workstation', 'GPU', 30));
  for (const [label, tag, count] of [['3D printer', '3DP', 2], ['Drone', 'DRONE', 2], ['Development board', 'DEV', 6]]) {
    const category = w.ok(w.staff, 'categories.upsert', { name: 'Unnati ' + label + ' (demo)', trackingMode: 'individual', notes: placeholder }).category;
    addUnits(category, label, tag, count);
  }
  const students = w.students.slice(9, 12), projectIds = [];
  ['Image classification', 'Drone navigation', 'Sensor anomaly detection'].forEach((title, i) => {
    const project = w.ok(students[i].email, 'projects.create', { title: title + ' (demo)',
      description: 'DEMO PLACEHOLDER: sample AI project for the Unnati walkthrough; not a real research record.',
      labId: unnati.labId, supervisorFacultyId: w.faculty2Id, startDate: '2026-10-14', endDate: '2026-11-30' }).project;
    projectIds.push(project.projectId);
    if (i !== 1) w.ok(w.faculty2, 'projects.decide', { projectId: project.projectId, approve: true });
  });
  const session = w.ok(students[0].email, 'sessions.mine').sessions.find((s) => s.labId === unnati.labId && s.type === 'openlab');
  students.forEach((student, i) => {
    const result = w.checkin(student, { kiosk: kioskEmail, sessionId: session.sessionId, projectId: projectIds[i], assetId: workstationIds[i], geo: w.at(3 + i, 12, LAB_UNNATI) });
    if (!result.ok) throw new Error('Unnati demo check-in failed for ' + student.email + ': ' + result.error.code);
  });
  lab.unnati = { lab: unnati, kioskEmail, workstationIds, projectIds, studentIds: students.map((s) => s.studentId), sessionId: session.sessionId };
}

/**
 * Tier 3 on the simulated day: the 09:00 Computing class runs as a phone-app session. Four students link the
 * simulated app (Node keys, the same signed messages as android/) and report every 2 minutes; one leaves at 09:40,
 * one never answers a fingerprint check. Two without the app (iPhones) check in on the kiosk page and are flagged.
 */
function phoneAppClass(lab) {
  const w = lab.w, fac = 'faculty3@karunya.edu', kiosk = 'kiosk3@karunya.edu', t0 = Date.UTC(2026, 9, 14, 3, 30); // 09:00 IST
  const key = () => { const k = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }), j = k.publicKey.export({ format: 'jwk' });
    return { privateKey: k.privateKey, publicKey: Buffer.concat([Buffer.from([4]), Buffer.from(j.x, 'base64url'), Buffer.from(j.y, 'base64url')]).toString('base64url') }; };
  const sign = (k, msg) => nodeCrypto.sign('sha256', Buffer.from(msg, 'utf8'), { key: k.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const fix = (m) => { const p = near(LAB_C, m, m / 2); return [p.lat.toFixed(7), p.lng.toFixed(7), String(8 + (m % 7))]; };
  const now = () => w.eval('U.now()');
  w.e.setTime(t0 - 5 * 60000);
  w.e.run('Sessions.materialize(U.local(U.now()).date)');
  const ses = w.ok(fac, 'sessions.day', { date: '2026-10-14' }).sessions.find((s) => s.labId === lab.lab3.labId && s.type === 'class');
  w.ok(fac, 'sessions.open', { sessionId: ses.sessionId, checkinMode: 'C' });
  const app = w.students.slice(3, 7).map((s, i) => {
    w.e.setTime(t0 + i * 70000);
    const token = w.ok(s.email, 'app.pairCode').token, dev = key(), bio = key();
    const r = w.eval('appLink_(' + JSON.stringify({ token, publicKey: dev.publicKey, bioPublicKey: bio.publicKey, sig: sign(dev, token), bioSig: sign(bio, token), label: ['Pixel 7', 'Galaxy A54', 'Redmi Note 12', 'OnePlus Nord'][i] }) + ')');
    if (!r.ok) throw new Error('Demo app link failed for ' + s.email + ': ' + r.error.code);
    const code = w.ok(kiosk, 'kiosk.display').code, m = ['c1', code, 'in', now(), ...fix(3 + i), 0].join('|');
    w.ok(s.email, 'app.scan', { credentialId: r.data.credentialId, sessionId: ses.sessionId, m, sig: sign(dev, m) });
    return { s, dev, bio, cred: r.data.credentialId, seq: 0, leaves: i === 1 ? t0 + 40 * 60000 : Infinity, ignoresBio: i === 2 };
  });
  w.students.slice(7, 9).forEach((s, i) => { w.e.setTime(t0 + (5 + i) * 60000); const r = w.checkin(s, { kiosk, sessionId: ses.sessionId, geo: Object.assign(near(LAB_C, 2 + i * 3, 1), { accuracy: 11 }) }); if (!r.ok) throw new Error('Demo kiosk check-in failed for ' + s.email + ': ' + r.error.code); });
  for (let t = t0 + 6 * 60000; t <= t0 + 64 * 60000; t += 2 * 60000) {
    w.e.setTime(t);
    if (t === t0 + 30 * 60000) w.ok(fac, 'presence.bioNow', { sessionId: ses.sessionId });
    app.forEach((a, i) => {
      if (t >= a.leaves) return;
      const p = ['p1', ses.sessionId, ++a.seq, now() + i * 1000, ...fix(2 + ((a.seq + i) % 9)), 0].join('|');
      const ch = (w.ok(a.s.email, 'app.ping', { credentialId: a.cred, pings: [{ m: p, sig: sign(a.dev, p) }] }) || {}).challenge;
      if (ch && !a.ignoresBio) w.ok(a.s.email, 'app.bio', { credentialId: a.cred, bioId: ch.bioId, sig: sign(a.bio, ch.message) });
    });
  }
  lab.phoneAppSessionId = ses.sessionId;
}

/** Past days: the IoT class runs with kiosk QR check-ins; most students scan out, a few forget. */
function history(lab, days) {
  const w = lab.w, today = Date.UTC(2026, 9, 14, 4, 30);
  const backs = [];
  for (let back = 1; backs.length < days && back < 30; back++) {
    const t = today - back * 86400000, dow = new Date(t + 330 * 60000).getUTCDay();
    if (dow !== 0) backs.push(back);
  }
  backs.reverse().forEach((back) => {
    const t = today - back * 86400000;
    w.e.setTime(t - 2 * 60000);
    const date = w.eval('U.local(U.now()).date');
    const ses = w.ok(w.faculty, 'sessions.day', { date }).sessions.find((s) => s.labId === w.lab.labId);
    if (!ses) return;
    w.e.setTime(t);
    w.ok(w.faculty, 'sessions.open', { sessionId: ses.sessionId });
    // readings vary like real indoor GPS (identical readings across sessions are what the spoofing detector looks for)
    w.students.forEach((s, i) => { if ((i + back) % 6 === 0) return; w.e.setTime(t + i * 9000); w.checkin(s, { geo: w.at(2 + ((i * 7 + back * 3) % 13), 6 + ((i * 11 + back * 5) % 18)) }); });
    w.e.setTime(t + 110 * 60000);
    w.students.forEach((s, i) => { if ((i + back) % 6 === 0 || (i + back) % 7 === 0) return; w.checkin(s, { action: 'out', geo: w.at(1 + ((i * 5 + back * 2) % 11), 5 + ((i * 7 + back * 3) % 15)) }); });
    w.e.setTime(t + 121 * 60000);
    w.ok(w.faculty, 'sessions.close', { sessionId: ses.sessionId });
  });
}

/** Build a fresh Test Lab world. */
function createLab(opts = {}) {
  const preset = opts.preset || 'demo';
  const lab = { preset, faults: {}, pendingSkips: [], traces: [], traceSeq: 0, latencyMs: 0, autoJobs: true, geo: { mode: 'inside', accuracy: 12, offsetM: 4 }, startedAt: Date.now() };
  lab.w = baseWorld({ students: 0, mode: 'AB' });
  lab.w.e.run("PropertiesService.getScriptProperties().setProperty('WEBAPP_URL', " + JSON.stringify(opts.baseUrl || 'http://localhost:8787/') + ')');
  seed(lab, preset);
  // the simulated day starts at 10:07, just after the seeded check-ins of the 10:00 class; the clock then runs in real time
  lab.clock = makeClock(NOW + 7 * 60000);
  lab.sync = () => lab.w.e.setTime(lab.clock.now());
  lab.sync();
  lab.w.e.run('Sessions.materialize(U.local(U.now()).date)');
  installSheetMeter(lab);
  installPipelineHooks(lab);
  lab.labs = { A: LAB_A, B: LAB_B, C: LAB_C, UNNATI: LAB_UNNATI };
  return lab;
}

/** Pipelines and their steps, with the Test Lab's current mode for each. */
function describePipelines(lab) {
  const d = JSON.parse(lab.w.e.run('JSON.stringify({ "A.open": Pipeline.describe(Checkin.STEPS_OPEN), "A.checkin": Pipeline.describe(Checkin.STEPS_A), "B.scan": Pipeline.describe(Attend.STEPS_B) })'));
  Object.keys(d).forEach((p) => d[p].forEach((s) => { const f = lab.faults[p + ':' + s.id]; s.mode = f ? f.mode : 'normal'; s.ms = f ? f.ms : 0; s.skippable = SKIPPABLE.indexOf(s.id) >= 0; }));
  return d;
}

/** Run a trigger job now, ignoring its minimum-gap throttle. */
function runJob(lab, name) {
  const allowed = ['tickSessions', 'sendEmails', 'nightly', 'morning', 'evening'];
  if (allowed.indexOf(name) < 0) throw new Error('Unknown job ' + name);
  lab.sync();
  lab.w.e.run("CacheService.getScriptCache().remove('job|" + name + "')");
  return JSON.parse(lab.w.e.run('JSON.stringify(Jobs.' + name + '())'));
}

module.exports = { createLab, describePipelines, runJob, installPipelineHooks, SKIPPABLE, PRESETS, makeClock };
