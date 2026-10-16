/**
 * Test world builder. Everything goes through the real rpc() gateway as the real caller (the fake only supplies
 * Session.getActiveUser), so authorisation, validation and audit behave exactly as in production code.
 * Client-side crypto is simulated with Node's WebCrypto using the SAME algorithm as the browser (ECDSA P-256 / SHA-256,
 * 64-byte r||s signatures, raw 65-byte public key, base64url).
 */
const nodeCrypto = require('crypto');
const { load, initDb } = require('./harness');

const subtle = nodeCrypto.webcrypto.subtle;
const NOW = Date.UTC(2026, 9, 14, 4, 30); // Wed 2026-10-14 10:00 IST
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function genDevice() {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const pub = b64u(await subtle.exportKey('raw', kp.publicKey));
  return { privateKey: kp.privateKey, publicKey: pub };
}
async function signWith(dev, message) {
  return b64u(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, dev.privateKey, Buffer.from(message, 'utf8')));
}

function world(opts = {}) {
  const e = load();
  initDb(e);
  e.setTime(NOW);
  e.run("PropertiesService.getScriptProperties().setProperty('BOOTSTRAP_ADMIN_EMAIL','admin@karunya.edu')");
  const w = { e, NOW, students: [], kioskEmail: 'kiosk1@karunya.edu', devices: {} };

  w.call = (email, action, payload) => {
    e.state.activeUser = email;
    return JSON.parse(e.run('JSON.stringify(rpc(' + JSON.stringify(action) + ',' + JSON.stringify(payload === undefined ? {} : payload) + '))'));
  };
  w.ok = (email, action, payload) => {
    const r = w.call(email, action, payload);
    if (!r.ok) throw new Error(action + ' failed for ' + email + ': ' + r.error.code + ' ' + r.error.message);
    return r.data;
  };
  w.err = (email, action, payload) => {
    const r = w.call(email, action, payload);
    if (r.ok) throw new Error(action + ' unexpectedly succeeded for ' + email);
    return r.error;
  };
  w.advance = (ms) => e.setTime(e.get('U.now()') + ms);
  w.eval = (code) => JSON.parse(e.run('JSON.stringify(' + code + ')'));

  // ---- base data ----
  w.admin = 'admin@karunya.edu'; w.staff = 'staff@karunya.edu'; w.faculty = 'faculty@karunya.edu'; w.faculty2 = 'faculty2@karunya.edu';
  w.ok(w.admin, 'me'); // creates the bootstrap admin
  w.ok(w.admin, 'users.upsert', { email: w.staff, displayName: 'Lab Staff', roles: ['staff'] });
  w.ok(w.admin, 'users.upsert', { email: w.faculty, displayName: 'Dr Faculty', roles: ['faculty'], employeeCode: 'F001' });
  w.ok(w.admin, 'users.upsert', { email: w.faculty2, displayName: 'Dr Other', roles: ['faculty'], employeeCode: 'F002' });
  w.lab = w.ok(w.admin, 'labs.upsert', { code: 'IOT01', name: 'IoT Lab', type: 'iot', capacity: 70 }).lab;
  w.lab2 = w.ok(w.admin, 'labs.upsert', { code: 'GPU01', name: 'GPU Lab', type: 'gpu', capacity: 30 }).lab;
  w.ok(w.admin, 'kiosks.upsert', { labId: w.lab.labId, name: 'IoT door', authorizedEmail: w.kioskEmail });
  w.ok(w.admin, 'kiosks.upsert', { labId: w.lab2.labId, name: 'GPU door', authorizedEmail: 'kiosk2@karunya.edu' });
  w.course = w.ok(w.admin, 'courses.upsert', { code: 'CSE301', name: 'Embedded Systems' }).course;
  w.facultyId = w.ok(w.faculty, 'me').faculty.facultyId;
  w.faculty2Id = w.ok(w.faculty2, 'me').faculty.facultyId;
  w.ok(w.admin, 'facultycourses.set', { facultyId: w.facultyId, courseId: w.course.courseId, section: 'A' });

  // ---- students: imported with emails so onboarding auto-verifies ----
  const n = opts.students === undefined ? 3 : opts.students;
  const rows = [];
  for (let i = 1; i <= n; i++) rows.push({ rollNo: 'S' + String(i).padStart(3, '0'), name: 'Student ' + i, email: 'student' + i + '@karunya.edu', section: 'A', year: 3 });
  if (rows.length) w.ok(w.admin, 'students.import', { rows });
  for (let i = 1; i <= n; i++) {
    const email = 'student' + i + '@karunya.edu';
    const r = w.ok(email, 'onboard', { rollNo: rows[i - 1].rollNo, name: rows[i - 1].name });
    w.students.push({ email, studentId: r.student.studentId, rollNo: rows[i - 1].rollNo, status: r.student.status });
  }
  if (rows.length) w.ok(w.admin, 'roster.import', { courseId: w.course.courseId, rows: rows.map((r) => r.rollNo) });

  // ---- timetable: today 10:00-12:00 in IoT lab ----
  w.slot = w.ok(w.admin, 'timetable.upsert', { labId: w.lab.labId, courseId: w.course.courseId, facultyId: w.facultyId, section: 'A', dayOfWeek: 3, startTime: '10:00', endTime: '12:00', validFrom: '2026-10-01', validTo: '2026-12-31' }).slot;
  w.today = '2026-10-14';
  w.session = () => w.ok(w.faculty, 'sessions.day', { date: w.today }).sessions[0];

  // ---- devices / QR ----
  w.registerDevice = async (student) => {
    const dev = await genDevice();
    const ch = w.ok(student.email, 'cred.begin');
    const sig = await signWith(dev, ch.challenge);
    const r = w.ok(student.email, 'cred.complete', { challenge: ch.challenge, publicKey: dev.publicKey, signature: sig, label: 'Test phone' });
    dev.credentialId = r.credentialId; dev.status = r.status;
    w.devices[student.studentId] = dev;
    return dev;
  };
  w.qr = async (student, sessionId, purpose, dev) => {
    dev = dev || w.devices[student.studentId];
    const ch = w.ok(student.email, 'attend.challenge', { sessionId, purpose, credentialId: dev.credentialId });
    return ch.token + '~' + (await signWith(dev, ch.token));
  };
  w.scan = (qr, kiosk) => w.call(kiosk || w.kioskEmail, 'kiosk.scan', { qr });
  return w;
}

module.exports = { world, genDevice, signWith, NOW, b64u };
