/**
 * The demo runtime: the real LABFLOW server code (LFENGINE, src/*.gs wrapped by dev/build-artifact.js) on the fakes in
 * env.js, restored from the Test Lab world snapshot, with a simulated clock that runs in real time. Every call goes
 * through the real rpc() as the given account. Shared by the demo page and the build's self-test. Development only.
 */
var LFDEMO = function (LFENV, LFENGINE, snapshot, startNow) {
'use strict';
var base = startNow, startedAt = Date.now();
var now = function () { return base + (Date.now() - startedAt); };
var env, eng, traces, seq, devices;

function boot() {
  base = startNow; startedAt = Date.now();
  env = LFENV.createEnv({ snapshot: snapshot, now: now });
  eng = LFENGINE.apply(null, LFENV.SERVICE_NAMES.map(function (n) { return env.services[n]; }));
  traces = []; seq = 0; devices = {};
  eng.observe(function (t) { var r = JSON.parse(JSON.stringify(t)); r.id = ++seq; traces.push(r); if (traces.length > 200) traces.shift(); });
}
function sync() { eng.setNow(now()); env.state.lockHeld = false; }
function call(as, action, payload) {
  sync(); env.state.activeUser = as || '';
  return JSON.parse(JSON.stringify(eng.rpc(action, payload === undefined ? {} : payload)));
}
function ok(as, action, payload) {
  var r = call(as, action, payload);
  if (!r.ok) throw new Error(action + ' failed for ' + as + ': ' + r.error.code + ' ' + r.error.message);
  return r.data;
}
function read(table) { sync(); return JSON.parse(JSON.stringify(eng.Db.readAll(table))); }

/** Who and what exists, for the page's pickers. */
function state() {
  sync();
  var Db = eng.Db, Labs = eng.Labs, date = eng.U.local(now()).date;
  var profiles = Db.readAll('StudentProfiles');
  var reps = Db.readAll('ClassReps').filter(function (r) { return r.status === 'active'; }).map(function (r) { return r.studentId; });
  var coords = Db.readAll('Events').filter(function (x) { return x.status === 'active'; }).map(function (x) { return x.coordinatorEmail; });
  return JSON.parse(JSON.stringify({
    now: now(),
    users: Db.readAll('Users').map(function (u) {
      var p = profiles.find(function (s) { return s.email === u.email; });
      return { email: u.email, name: u.displayName, roles: String(u.roles), classRep: !!(p && reps.indexOf(p.studentId) >= 0), coordinator: coords.indexOf(u.email) >= 0 };
    }),
    labs: Db.readAll('Labs').map(function (l) { return { labId: l.labId, code: l.code, name: l.name, mode: Labs.modeOf(l), latitude: l.latitude, longitude: l.longitude, radiusM: Labs.radiusOf(l) }; }),
    kiosks: Db.readAll('Kiosks').map(function (k) { var l = Db.get('Labs', k.labId) || {}; return { email: k.authorizedEmail, name: k.name, labId: k.labId, lab: l.code, mode: Labs.modeOf(l) }; }),
    students: profiles.map(function (s) { return { studentId: s.studentId, email: s.email, rollNo: s.rollNo, name: s.name }; }),
    sessions: Db.readAll('Sessions').filter(function (s) { return s.date === date; }).map(function (s) { var l = Db.get('Labs', s.labId) || {}; return { sessionId: s.sessionId, title: s.title, lab: l.code, labId: s.labId, status: s.status, start: s.scheduledStart, end: s.scheduledEnd, type: s.type, checkinMode: s.checkinMode || '' }; })
  }));
}

/** The 5-minute trigger, run now (ignores its own throttle). */
function tick() { delete env.cacheStore['job|tickSessions']; sync(); return JSON.parse(JSON.stringify(eng.Jobs.tickSessions())); }

/** An "open to all" event session in the lab, owned by faculty@ and opened by the admin, unless one is already open. */
function openTestSession(labId, steps) {
  var admin = 'admin@karunya.edu', log = function (label, action, r) { if (steps) steps.push({ who: 'admin', label: label, action: action, ok: r.ok, data: r.data, error: r.error }); return r; };
  var open = read('Sessions').filter(function (s) { return s.labId === labId && s.status === 'open'; })[0];
  if (open) { if (steps) steps.push({ who: 'setup', label: 'Use the session already open in this lab: ' + open.title, ok: true, data: { sessionId: open.sessionId } }); return { sessionId: open.sessionId, existing: open.title }; }
  sync();
  var t = eng.U.local(now()), end = eng.U.local(now() + 7200000);
  var facultyId = read('FacultyProfiles').filter(function (f) { return f.email === 'faculty@karunya.edu'; })[0].facultyId;
  var c = log('Create a test session open to every student', 'sessions.create', call(admin, 'sessions.create', { type: 'event', labId: labId, date: t.date, startTime: t.time, endTime: end.date === t.date ? end.time : '23:59', title: 'Demo session (open to all)', openToAll: true, facultyId: facultyId, override: true }));
  if (!c.ok) return { error: c.error };
  var o = log('Open it', 'sessions.open', call(admin, 'sessions.open', { sessionId: c.data.session.sessionId, override: true }));
  return o.ok ? { sessionId: c.data.session.sessionId } : { error: o.error };
}

/* ------------------------------------------------------------------ a simulated phone: WebCrypto P-256, like the app */
var ALG = { name: 'ECDSA', namedCurve: 'P-256' }, SIG = { name: 'ECDSA', hash: 'SHA-256' };
function b64u(buf) { var s = '', u8 = new Uint8Array(buf); for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
async function signWith(key, text) { return b64u(await crypto.subtle.sign(SIG, key, new TextEncoder().encode(text))); }

/**
 * The whole check-in for one student in one call, as each party in turn (kiosk, student, admin). Opens an
 * "open to all" test session in the lab when none is open. b: { labId, student (email), method 'A'|'B', action, geo }.
 */
async function quick(b) {
  var steps = [], seq0 = seq, admin = 'admin@karunya.edu';
  var step = function (who, label, as, action, payload) { var r = call(as, action, payload); steps.push({ who: who, label: label, action: action, ok: r.ok, data: r.data, error: r.error }); return r; };
  var done = function () { return { steps: steps, traces: traces.filter(function (t) { return t.id > seq0; }) }; };
  var st = state(), labId = String(b.labId || ''), student = st.students.find(function (s) { return s.email === b.student; });
  if (!student) throw new Error('Unknown student ' + b.student);
  var kiosk = (read('Kiosks').filter(function (k) { return k.labId === labId && k.status !== 'revoked'; })[0] || {}).authorizedEmail;
  if (!kiosk) throw new Error('This lab has no kiosk');
  var ses = openTestSession(labId, steps), sid = ses.sessionId;
  if (!sid) return done();
  if (b.method === 'B') {
    var dev = devices[student.studentId];
    if (!dev) {
      var pair = await crypto.subtle.generateKey(ALG, false, ['sign', 'verify']), pub = b64u(await crypto.subtle.exportKey('raw', pair.publicKey));
      var begin = step('student', 'Phone asks to register its key', student.email, 'cred.begin', {});
      if (!begin.ok) return done();
      var reg = step('student', 'Phone proves it holds a new P-256 key', student.email, 'cred.complete', { challenge: begin.data.challenge, publicKey: pub, signature: await signWith(pair.privateKey, begin.data.challenge), label: 'Demo phone' });
      if (!reg.ok) return done();
      dev = devices[student.studentId] = { key: pair.privateKey, credentialId: reg.data.credentialId };
    }
    var ch = step('student', 'Phone asks for a QR token', student.email, 'attend.challenge', { sessionId: sid, purpose: b.action || 'in', credentialId: dev.credentialId });
    if (!ch.ok) return done();
    var ts = now(), qr = ch.data.token + '~' + ts + '~' + await signWith(dev.key, ch.data.token + '.' + ts);
    steps.push({ who: 'student', label: 'Phone signs token.timestamp and shows it as a QR', ok: true, data: { qr: qr } });
    step('kiosk', 'Kiosk camera scans the QR', kiosk, 'kiosk.scan', { qr: qr });
  } else {
    var k = step('kiosk', 'Kiosk shows its rotating code', kiosk, 'kiosk.display', {});
    if (!k.ok) return done();
    if (!k.data.code) { steps.push({ who: 'kiosk', label: 'Lab allows kiosk QR + GPS', ok: false, error: { code: 'MODE', message: 'This lab does not use kiosk QR + GPS (mode ' + k.data.mode + ').' } }); return done(); }
    var op = step('student', 'Phone opens the kiosk link', student.email, 'checkin.open', { code: k.data.code });
    if (!op.ok) return done();
    var geo = b.geo ? { lat: Number(b.geo.lat), lng: Number(b.geo.lng), accuracy: Number(b.geo.accuracy) || 12 } : undefined;
    step('student', 'Phone submits with its location', student.email, 'checkin.submit', { pass: op.data.pass, action: b.action || op.data.actions[0], sessionId: sid, geo: geo });
  }
  var ro = call(admin, 'attend.roster', { sessionId: sid });
  steps.push({ who: 'admin', label: 'Roster status afterwards', action: 'attend.roster', ok: ro.ok, error: ro.error, data: ro.ok ? ro.data.roster.find(function (r) { return r.studentId === student.studentId; }) || { status: 'not on roster' } : undefined });
  return done();
}

boot();
return {
  now: now, advance: function (ms) { base += ms; }, reset: boot,
  call: call, ok: ok, read: read, state: state, tick: tick, quick: quick, openTestSession: openTestSession,
  traces: function (since) { return traces.filter(function (t) { return t.id > (since || 0); }); },
  auditVerify: function () { sync(); return JSON.parse(JSON.stringify(eng.Audit.verify())); },
  mail: function () { return env.sentMail.slice(-50).reverse(); }
};
};
if (typeof module !== 'undefined') module.exports = LFDEMO;
