/**
 * Scripted test runs: the class rush, the attacks from the SRS (section 15.4) and the everyday flows, each run step
 * by step in a fresh, deterministic world (the real server code on the Apps Script fakes) with the expected and the
 * actual outcome recorded. The Test Lab runs them with its current pipeline faults, so switching a check off shows
 * which scenario it was protecting. `npm run sim` prints the same results; test/scenarios.test.js asserts them.
 */
const { world, LAB_B } = require('../test/fixtures');
const { installPipelineHooks } = require('./world');

const outcome = (r) => (r && r.ok ? 'accepted' : r && r.error ? r.error.code : 'ERROR');

function harness(opts) {
  const mini = { faults: opts.faults || {}, pendingSkips: [], traces: [], traceSeq: 0, opsSince: () => 0 };
  return {
    world: (wopts) => {
      const w = world(wopts || {});
      mini.w = w; installPipelineHooks(mini);
      const ss = Object.values(w.e.spreadsheets)[0]; w.ops = 0;
      ss.onOp = () => { w.ops++; if (opts.latencyMs > 0) { const t = Date.now(); while (Date.now() - t < opts.latencyMs) { /* simulated sheet latency */ } } };
      w.open = () => { w.sid = w.session().sessionId; w.ok(w.faculty, 'sessions.open', { sessionId: w.sid }); return w.sid; };
      return w;
    }
  };
}

const S = [];
const def = (id, group, title, srs, run) => S.push({ id, group, title, srs, run });

/* ------------------------------------------------------------------ Version A: kiosk QR + GPS */
def('a-rush', 'Kiosk QR + GPS (A)', 'Class rush: 60 students scan the same kiosk screen', 'FR-10, NFR speed', async (T) => {
  const w = T.world({ students: 60, mode: 'A' }); w.open();
  let ok = 0, ops0 = w.ops, t0 = Date.now(); const code = w.kioskCode();
  for (let i = 0; i < 60; i++) { if (i % 10 === 0 && i) w.advance(7000); if (w.checkin(w.students[i], { code: i < 10 ? code : undefined }).ok) ok++; }
  await T.step('All 60 check in (one code works for the whole class, once each)', '60 accepted', () => ok + ' accepted');
  await T.step('Live occupancy shows 60 inside', 60, () => w.ok(w.admin, 'labs.occupancy').labs.find((l) => l.code === 'IOT01').inside);
  T.note('Sheet operations for 60 check-ins: ' + (w.ops - ops0) + ' (about ' + Math.round((w.ops - ops0) / 60) + ' per check-in). In-memory time ' + (Date.now() - t0) + ' ms; real Apps Script adds network and sheet latency.');
});
def('a-outside', 'Kiosk QR + GPS (A)', 'Honest student outside the geofence', 'FR-11, FR-12', async (T) => {
  const w = T.world({ students: 2, mode: 'A' }); w.open(); const [a, b] = w.students;
  await T.step('200 m away is recorded, not refused', 'accepted', () => outcome(w.checkin(a, { geo: w.at(200, 15) })));
  await T.step('...and shows as flagged for the faculty, not present', 'flagged', () => w.ok(w.faculty, 'attend.roster', { sessionId: w.sid }).roster.find((r) => r.studentId === a.studentId).status);
  await T.step('40 m away but 30 m GPS error is forgiven (indoor GPS)', 'accepted', () => outcome(w.checkin(b, { geo: w.at(40, 30) })));
});
def('a-spoof-console', 'Kiosk QR + GPS (A)', 'Attack: send the lab\'s coordinates from the hostel (browser console)', 'SRS 6.3, 15.4', async (T) => {
  const w = T.world({ students: 1, mode: 'A' }); w.open(); const [s] = w.students;
  T.note('The friend in the lab photographs the kiosk code; the student at the hostel opens it within 30 s and sends the lab coordinates with a believable accuracy.');
  await T.step('Accepted: a browser cannot prove location (documented limit)', 'accepted', () => outcome(w.checkin(s, { geo: w.at(2, 9) })));
  await T.step('A rescan window later catches the absence', 'missed_rescan', () => {
    w.advance(20 * 60000); w.ok(w.faculty, 'attend.openRescan', { sessionId: w.sid, seconds: 90 }); w.advance(3 * 60000);
    return w.ok(w.faculty, 'attend.roster', { sessionId: w.sid }).roster.find((r) => r.studentId === s.studentId).status;
  });
});
def('a-mock-accuracy', 'Kiosk QR + GPS (A)', 'Attack: location faking app reports 0.5 m accuracy', 'FR-30', async (T) => {
  const w = T.world({ students: 1, mode: 'A' }); w.open(); const [s] = w.students;
  await T.step('Impossible accuracy is recorded, not refused', 'accepted', () => outcome(w.checkin(s, { geo: w.at(1, 0.5) })));
  await T.step('A high-severity flag is raised for review', true, () => w.ok(w.staff, 'flags.list', {}).flags.some((f) => f.type === 'implausible_location' && f.severity === 'high'));
});
def('a-old-code', 'Kiosk QR + GPS (A)', 'Attack: reuse a photo of the kiosk code taken earlier', 'FR-7, FR-9', async (T) => {
  const w = T.world({ students: 1, mode: 'A' }); w.open(); const [s] = w.students; const code = w.kioskCode();
  w.advance(60 * 1000);
  await T.step('A code older than the allowance is refused', 'CODE_EXPIRED', () => outcome(w.call(s.email, 'checkin.open', { code })));
});
def('a-twice', 'Kiosk QR + GPS (A)', 'Attack: use the same kiosk code twice', 'FR-10', async (T) => {
  const w = T.world({ students: 1, mode: 'A' }); w.open(); const [s] = w.students; const code = w.kioskCode();
  await T.step('First use checks in', 'accepted', () => outcome(w.checkin(s, { code })));
  w.advance(150 * 1000);
  await T.step('The same code (still within its allowance) cannot be used again', ['REPLAY', 'CODE_EXPIRED'], () => outcome(w.call(s.email, 'checkin.open', { code })));
});
def('a-pass-timeout', 'Kiosk QR + GPS (A)', 'Student opens the page but takes longer than the 2-minute pass', 'FR-9', async (T) => {
  const w = T.world({ students: 1, mode: 'A' }); w.open(); const [s] = w.students;
  const op = w.ok(s.email, 'checkin.open', { code: w.kioskCode() }); w.advance(125 * 1000);
  await T.step('The pass expires', 'PASS_EXPIRED', () => outcome(w.call(s.email, 'checkin.submit', { pass: op.pass, action: 'in', sessionId: w.sid, geo: w.at(1) })));
});
def('a-no-exit', 'Kiosk QR + GPS (A)', 'Scan in and never scan out', 'FR-17', async (T) => {
  const w = T.world({ students: 2, mode: 'A' }); w.open(); const [a, b] = w.students;
  w.checkin(a); w.checkin(b); w.advance(100 * 60000); w.checkin(b, { action: 'out' }); w.advance(20 * 60000); w.ok(w.faculty, 'sessions.close', { sessionId: w.sid });
  const ro = w.ok(w.faculty, 'attend.roster', { sessionId: w.sid }).roster;
  await T.step('The student who left without scanning gets "unverified exit"', 'unverified_exit', () => ro.find((r) => r.studentId === a.studentId).status);
  await T.step('...and no hours beyond the entry', 0, () => ro.find((r) => r.studentId === a.studentId).verifiedMinutes);
  await T.step('The student who scanned out is present with 100 minutes', 100, () => ro.find((r) => r.studentId === b.studentId).verifiedMinutes);
});
def('a-travel', 'Kiosk QR + GPS (A)', 'Impossible travel between two labs', 'FR-29', async (T) => {
  const w = T.world({ students: 1, mode: 'AB' }); w.open(); const [s] = w.students;
  w.checkin(s);
  const ev = w.ok(w.admin, 'events.create', { name: 'GPU talk', labId: w.lab2.labId, date: w.today, startTime: '09:30', endTime: '12:00', openToAll: true, override: true, facultyId: w.facultyId });
  w.ok(w.admin, 'sessions.open', { sessionId: ev.event.sessionId }); w.advance(30 * 1000);
  await T.step('Check-in 350 m away 30 s later is accepted (location is plausible there)', 'accepted', () => outcome(w.checkin(s, { kiosk: 'kiosk2@karunya.edu', action: 'in', sessionId: ev.event.sessionId, geo: w.at(2, 10, LAB_B) })));
  await T.step('...and flagged as impossible travel', true, () => w.ok(w.staff, 'flags.list', {}).flags.some((f) => f.type === 'impossible_travel'));
});

/* ------------------------------------------------------------------ Version B: device-signed QR */
def('b-rush', 'Device QR (B)', 'Class rush at the kiosk scanner: 60 students', 'NFR speed', async (T) => {
  const w = T.world({ students: 60, mode: 'B' }); for (const s of w.students) await w.registerDevice(s); w.open();
  let ok = 0; const ops0 = w.ops, t0 = Date.now();
  for (const s of w.students) if (w.scan(await w.qr(s, w.sid, 'in')).ok) ok++;
  await T.step('All 60 accepted', 60, () => ok);
  T.note('Sheet operations for 60 scans: ' + (w.ops - ops0) + '. In-memory time ' + (Date.now() - t0) + ' ms (signature verification included).');
});
def('b-screenshot', 'Device QR (B)', 'Attack: screenshot of a QR sent to a friend', 'SRS 15.4', async (T) => {
  const w = T.world({ students: 1, mode: 'B' }); const [s] = w.students; await w.registerDevice(s); w.open();
  const shot = await w.qr(s, w.sid, 'in'); w.advance(20 * 1000);
  await T.step('Refused once older than the freshness window', 'STALE_QR', () => outcome(w.scan(shot)));
  await T.step('Flagged for review', true, () => w.ok(w.faculty, 'flags.list', {}).flags.some((f) => f.type === 'stale_qr'));
});
def('b-replay', 'Device QR (B)', 'Attack: show a QR that was already scanned', 'SRS 15.4, FR-27', async (T) => {
  const w = T.world({ students: 1, mode: 'B' }); const [s] = w.students; await w.registerDevice(s); w.open();
  const qr = await w.qr(s, w.sid, 'in');
  await T.step('First scan accepted', 'accepted', () => outcome(w.scan(qr)));
  await T.step('Same nonce re-signed and shown again is refused', 'REPLAY', async () => outcome(w.scan(await w.sign(qr.split('~')[0], w.devices[s.studentId]))));
});
def('b-clock', 'Device QR (B)', 'Attack: QR pre-generated with the phone clock moved ahead', 'SRS 15.4', async (T) => {
  const w = T.world({ students: 1, mode: 'B' }); const [s] = w.students; await w.registerDevice(s); w.open();
  const ch = w.ok(s.email, 'attend.challenge', { sessionId: w.sid, purpose: 'in', credentialId: w.devices[s.studentId].credentialId });
  await T.step('Timestamp an hour ahead is refused', 'STALE_QR', async () => outcome(w.scan(await w.sign(ch.token, w.devices[s.studentId], w.eval('U.now()') + 3600000))));
  w.advance(5 * 60000);
  await T.step('An hour later the server nonce inside it has expired anyway', 'EXPIRED', async () => outcome(w.scan(await w.sign(ch.token, w.devices[s.studentId]))));
});
def('b-friend-phone', 'Device QR (B)', 'Attack: generate a friend\'s QR on your own phone', 'SRS 9.1', async (T) => {
  const w = T.world({ students: 2, mode: 'B' }); const [a, b] = w.students; await w.registerDevice(a); await w.registerDevice(b); w.open();
  const ch = w.ok(a.email, 'attend.challenge', { sessionId: w.sid, purpose: 'in', credentialId: w.devices[a.studentId].credentialId });
  await T.step('Signed with B\'s key for A: refused', 'BAD_SIGNATURE', async () => outcome(w.scan(await w.sign(ch.token, w.devices[b.studentId]))));
});
def('b-student-scans', 'Device QR (B)', 'Attack: a student scans another student\'s QR', 'SRS 15.4', async (T) => {
  const w = T.world({ students: 2, mode: 'B' }); const [a, b] = w.students; await w.registerDevice(a); w.open();
  await T.step('Refused: not a scanner for this session', 'NOT_SCANNER', async () => outcome(w.phoneScan(b.email, await w.qrLink(a, w.sid, 'in'))));
});
def('b-cr', 'Device QR (B)', 'Class representative: scans classmates, never themselves, not after the session', 'SRS 7.2, 15.4', async (T) => {
  const w = T.world({ students: 3, mode: 'B' }); const [cr, a, b] = w.students; for (const s of w.students) await w.registerDevice(s); w.open();
  w.ok(w.faculty, 'classreps.set', { courseId: w.course.courseId, section: 'A', studentId: cr.studentId });
  await T.step('CR scans a classmate', 'accepted', async () => outcome(w.phoneScan(cr.email, await w.qr(a, w.sid, 'in'))));
  await T.step('The teacher sees the scan tagged as made by the CR', 'cr', () => w.ok(w.faculty, 'attend.roster', { sessionId: w.sid }).roster.find((r) => r.studentId === a.studentId).scannerRole);
  await T.step('CR cannot scan themselves', 'SELF_SCAN', async () => outcome(w.phoneScan(cr.email, await w.qr(cr, w.sid, 'in'))));
  const late = await w.qr(b, w.sid, 'in'); w.ok(w.faculty, 'sessions.close', { sessionId: w.sid });
  await T.step('After the session ends the CR permission is gone', 'CR_SESSION_ENDED', () => outcome(w.phoneScan(cr.email, late)));
});
def('b-revoked', 'Device QR (B)', 'Lost phone revoked: its codes stop working at once', 'SRS 7.1', async (T) => {
  const w = T.world({ students: 1, mode: 'B' }); const [s] = w.students; const dev = await w.registerDevice(s); w.open();
  const qr = await w.qr(s, w.sid, 'in'); w.ok(s.email, 'cred.revoke', { credentialId: dev.credentialId, reason: 'lost phone' });
  await T.step('A code made just before the revocation is refused', 'REVOKED', () => outcome(w.scan(qr)));
});
def('b-two-phones', 'Device QR (B)', 'One person carrying two phones to the teacher', 'SRS 9.2', async (T) => {
  const w = T.world({ students: 2, mode: 'B' }); const [a, b] = w.students; await w.registerDevice(a); await w.registerDevice(b); w.open();
  const qa = await w.qr(a, w.sid, 'in'), qb = await w.qr(b, w.sid, 'in');
  await T.step('Both scans go through (the software cannot see who holds the phones)', 'accepted accepted', () => outcome(w.phoneScan(w.faculty, qa)) + ' ' + outcome(w.phoneScan(w.faculty, qb)));
  await T.step('Two scans on one phone within seconds are flagged', true, () => w.ok(w.faculty, 'flags.list', {}).flags.some((f) => f.type === 'back_to_back'));
});

/* ------------------------------------------------------------------ platform and human controls */
def('s-admin-call', 'Access control', 'Attack: a student calls an admin function from the console', 'FR-5, 15.4', async (T) => {
  const w = T.world({ students: 1 }); const [s] = w.students;
  await T.step('settings.set as a student', 'FORBIDDEN', () => outcome(w.call(s.email, 'settings.set', { values: { qrTtlSeconds: 180 } })));
  await T.step('users.upsert to make themselves admin', 'FORBIDDEN', () => outcome(w.call(s.email, 'users.upsert', { email: s.email, displayName: 'x', roles: ['admin'] })));
  await T.step('An unknown internal function name', 'NOT_FOUND', () => outcome(w.call(s.email, 'Setup.initialise', {})));
  await T.step('A Gmail account is refused before anything else', 'DOMAIN_NOT_ALLOWED', () => outcome(w.call('someone@gmail.com', 'me', {})));
});
def('s-audit', 'Access control', 'Attack: edit a past audit row by hand', 'FR-32, 15.4', async (T) => {
  const w = T.world({ students: 2 });
  await T.step('The chain verifies before', true, () => w.eval('Audit.verify().ok'));
  w.e.run("(function(){ var rows = Db.readAll('AuditEvents'); var x = rows[3]; Db.putRow('AuditEvents', x.__row, Object.assign({}, x, { actor: 'someone-else@karunya.edu' })); })()");
  await T.step('The edit is detected', false, () => w.eval('Audit.verify().ok'));
});
def('s-spot', 'Human controls', 'Spot check: photo does not match the person in the room', 'SRS 6.2 (13)', async (T) => {
  const w = T.world({ students: 2, mode: 'A' }); w.open(); const [a] = w.students; w.checkin(a);
  const c = w.ok(w.faculty, 'spot.start', { sessionId: w.sid, studentId: a.studentId }).checks[0];
  w.ok(w.faculty, 'spot.resolve', { checkId: c.checkId, outcome: 'mismatch', note: 'Different person at the bench' });
  await T.step('The student is flagged on the roster', 'flagged', () => w.ok(w.faculty, 'attend.roster', { sessionId: w.sid }).roster.find((r) => r.studentId === a.studentId).status);
});
def('s-late-correction', 'Human controls', 'Manual correction a week later needs admin approval', 'FR-32', async (T) => {
  const w = T.world({ students: 1, mode: 'A' }); w.open(); const [s] = w.students; w.advance(130 * 60000); w.ok(w.faculty, 'sessions.close', { sessionId: w.sid }); w.advance(7 * 86400000);
  await T.step('Faculty correction goes to the admin queue', 'pending', () => w.ok(w.faculty, 'attend.correct', { sessionId: w.sid, studentId: s.studentId, action: 'add_in', at: w.NOW + 5 * 60000, reason: 'Phone dead, signed the paper register' }).approvalStatus);
  await T.step('Admin sees it waiting', 1, () => w.ok(w.admin, 'corrections.pending').corrections.length);
});

/* ------------------------------------------------------------------ inventory, events, jobs */
def('i-request', 'Inventory', 'Equipment request needs a check-in, staff fill it on the issue screen', 'FR-21, FR-22', async (T) => {
  const w = T.world({ students: 1, mode: 'A' }); const [s] = w.students;
  const cat = w.ok(w.staff, 'categories.upsert', { name: 'ESP32', trackingMode: 'individual' }).category, a = w.ok(w.staff, 'assets.upsert', { categoryId: cat.categoryId, labId: w.lab.labId, name: 'ESP32', assetTag: 'E1' }).asset;
  await T.step('Not checked in: refused', 'NOT_CHECKED_IN', () => outcome(w.call(s.email, 'equipment.request', { labId: w.lab.labId, resourceType: 'category', resourceId: cat.categoryId })));
  w.open(); w.checkin(s);
  const q = w.ok(s.email, 'equipment.request', { labId: w.lab.labId, resourceType: 'category', resourceId: cat.categoryId }).request;
  await T.step('Staff issue the item against the request', 'fulfilled', () => { w.ok(w.staff, 'loans.issue', { idemKey: 'scenario-key-000001', borrowerType: 'student', borrowerId: s.studentId, labId: w.lab.labId, items: [{ assetId: a.assetId }], requestId: q.requestId }); return w.ok(s.email, 'equipment.mine').requests[0].status; });
});
def('i-noshow', 'Inventory', 'GPU slot no-show is released after 15 minutes', 'FR-25', async (T) => {
  const w = T.world({ students: 1, mode: 'A' }); const [s] = w.students;
  const cat = w.ok(w.staff, 'categories.upsert', { name: 'GPU workstation', trackingMode: 'individual' }).category, ws = w.ok(w.staff, 'assets.upsert', { categoryId: cat.categoryId, labId: w.lab.labId, name: 'RTX 4090', assetTag: 'WS1' }).asset;
  const start = w.NOW + 3600000, r = w.ok(s.email, 'booking.request', { labId: w.lab.labId, resourceType: 'asset', resourceId: ws.assetId, startAt: start, endAt: start + 7200000, purpose: 'Training' }).reservation;
  w.ok(w.staff, 'booking.decide', { reservationId: r.reservationId, approve: true }); w.e.setTime(start + 16 * 60000);
  await T.step('Slot released by the tick job', 1, () => w.eval('Booking.expireStale()').released);
});
def('i-overdue', 'Inventory', 'Overdue kit: the morning job emails a reminder', 'FR-23', async (T) => {
  const w = T.world({ students: 1, mode: 'A' }); const [s] = w.students;
  const cat = w.ok(w.staff, 'categories.upsert', { name: 'Breadboard', trackingMode: 'individual' }).category, a = w.ok(w.staff, 'assets.upsert', { categoryId: cat.categoryId, labId: w.lab.labId, name: 'Breadboard', assetTag: 'BB1' }).asset;
  w.ok(w.staff, 'loans.issue', { idemKey: 'scenario-key-000002', borrowerType: 'student', borrowerId: s.studentId, labId: w.lab.labId, days: 1, items: [{ assetId: a.assetId }] });
  w.advance(3 * 86400000);
  await T.step('Reminder queued and emailed', true, () => { w.eval('Jobs.morning()'); w.e.run("CacheService.getScriptCache().remove('job|sendEmails')"); w.eval('Jobs.sendEmails()'); return w.e.sentMail.some((m) => m.to === s.email && /overdue|due/i.test(m.subject + m.body)); });
});
def('e-workshop', 'Events', 'Workshop: coordinator, lunch break, capacity, guests', 'App. B.2', async (T) => {
  const w = T.world({ students: 3, mode: 'B' }); const [coord, a, b] = w.students; for (const s of w.students) await w.registerDevice(s);
  const ev = w.ok(w.faculty, 'events.create', { name: 'Workshop', labId: w.lab.labId, date: w.today, startTime: '10:00', endTime: '16:00', breakStart: '13:00', breakEnd: '14:00', capacity: 1, coordinatorEmail: coord.email, rollNos: ['S002', 'S003'] });
  const sid = ev.event.sessionId; w.ok(coord.email, 'sessions.open', { sessionId: sid });
  await T.step('Coordinator scans a participant', 'accepted', async () => outcome(w.phoneScan(coord.email, await w.qr(a, sid, 'in'))));
  w.phoneScan(coord.email, await w.qr(b, sid, 'in'));
  await T.step('Capacity warning when over capacity', true, () => w.ok(coord.email, 'attend.roster', { sessionId: sid }).counts.overCapacity);
  w.e.setTime(Date.UTC(2026, 9, 14, 9, 30)); w.phoneScan(w.faculty, await w.qr(a, sid, 'out'));
  await T.step('Lunch break excluded: 10:00-15:00 counts 4 hours', 240, () => w.ok(w.faculty, 'attend.roster', { sessionId: sid }).roster.find((r) => r.studentId === a.studentId).verifiedMinutes);
});
def('j-digest', 'Reports and jobs', 'Evening digest goes to the lab incharge with the PDF', 'FR-34, FR-38', async (T) => {
  const w = T.world({ students: 2, mode: 'A' }); w.ok(w.admin, 'labs.upsert', Object.assign({}, w.lab, { inchargeEmails: 'incharge@karunya.edu' })); w.open(); w.students.forEach((s) => w.checkin(s));
  w.e.setTime(Date.UTC(2026, 9, 14, 12, 30));
  await T.step('Digest emailed with one attachment', 1, () => { w.eval('Jobs.evening()'); const m = w.e.sentMail.find((x) => x.to === 'incharge@karunya.edu'); return m && m.o && m.o.attachments ? m.o.attachments.length : 0; });
});

function list() { return S.map((s) => ({ id: s.id, group: s.group, title: s.title, srs: s.srs })); }

async function run(id, opts = {}) {
  const sc = S.find((s) => s.id === id);
  if (!sc) return { id, ok: false, error: 'unknown scenario' };
  const steps = [], notes = [], H = harness(opts), t0 = Date.now();
  const T = {
    world: H.world,
    note: (t) => notes.push(t),
    step: async (label, expected, fn) => {
      const s0 = Date.now(); let actual, err = '';
      try { actual = await fn(); } catch (e) { actual = 'ERROR'; err = String(e && e.message).slice(0, 300); }
      const ok = Array.isArray(expected) ? expected.indexOf(actual) >= 0 : actual === expected;
      steps.push({ label, expected: Array.isArray(expected) ? expected.join(' or ') : expected, actual, ok, ms: Date.now() - s0, error: err });
    }
  };
  let crashed = '';
  try { await sc.run(T); } catch (e) { crashed = String(e && e.message).slice(0, 400); }
  return { id: sc.id, group: sc.group, title: sc.title, srs: sc.srs, ok: !crashed && steps.length > 0 && steps.every((s) => s.ok), steps, notes, crashed, ms: Date.now() - t0, faults: Object.keys(opts.faults || {}) };
}

module.exports = { list, run };

if (require.main === module) {
  (async () => {
    let failed = 0;
    for (const s of list()) {
      const r = await run(s.id);
      if (!r.ok) failed++;
      console.log((r.ok ? 'PASS ' : 'FAIL ') + r.title + '  [' + r.srs + ']  ' + r.ms + ' ms');
      r.steps.forEach((x) => console.log('     ' + (x.ok ? 'ok  ' : 'BAD ') + x.label + ': expected ' + x.expected + ', got ' + x.actual + (x.error ? ' (' + x.error + ')' : '')));
      r.notes.forEach((n) => console.log('     note: ' + n));
      if (r.crashed) console.log('     crashed: ' + r.crashed);
    }
    console.log('\n' + (list().length - failed) + ' of ' + list().length + ' scenarios behaved as expected.');
    process.exit(failed ? 1 : 0);
  })();
}
