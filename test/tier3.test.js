// Tier 3, the phone app (PresenceService.gs). The app is simulated with Node WebCrypto: the same P-256 keys, the same
// signed messages, and the same doPost path (session token, no Google cookie) the Android app uses.
const test = require('node:test');
const assert = require('node:assert/strict');
const { world, genDevice, signWith, b64u, LAB_A, north } = require('./fixtures');

const MIN = 60000;
const post = (w, action, payload, session) => JSON.parse(w.e.run('doPost({ postData: { contents: ' + JSON.stringify(JSON.stringify({ action, payload, session })) + ' } }).getContent()'));

async function link(w, student, label) {
  const dev = await genDevice(), bio = await genDevice(), pc = w.ok(student.email, 'app.pairCode');
  const r = post(w, 'app.link', { token: pc.token, publicKey: dev.publicKey, bioPublicKey: bio.publicKey, sig: await signWith(dev, pc.token), bioSig: await signWith(bio, pc.token), label: label || 'Pixel' });
  assert.ok(r.ok, JSON.stringify(r.error));
  return { dev, bio, token: pc.token, session: r.data.session, credentialId: r.data.credentialId, status: r.data.status, seq: 0, student, metres: 3, acc: 12, mock: false };
}
const api = (w, app, action, payload) => post(w, action, Object.assign({ credentialId: app.credentialId }, payload || {}), app.session);
const fix = (metres, acc) => { const p = north(LAB_A, metres); return [p.lat.toFixed(7), p.lng.toFixed(7), String(acc)]; };
async function scan(w, app, o = {}) {
  const now = w.eval('U.now()'), [lat, lng, acc] = fix(o.metres === undefined ? app.metres : o.metres, o.acc || app.acc);
  const m = ['c1', o.code || w.kioskCode(), o.purpose || 'in', now, lat, lng, acc, (o.mock === undefined ? app.mock : o.mock) ? 1 : 0].join('|');
  return api(w, app, 'app.scan', { m, sig: await signWith(app.dev, m), sessionId: o.sessionId });  // the server picks the session, as for the real app
}
async function report(w, app, o = {}) {
  // real GPS jitters by a metre or so between readings; a frozen (replayed) location does not
  const jitter = app.frozen ? 0 : ((app.seq * 7) % 10) / 10;
  const at = o.at || w.eval('U.now()'), [lat, lng, acc] = o.nofix ? ['', '', ''] : fix((o.metres === undefined ? app.metres : o.metres) + jitter, o.acc || app.acc);
  const m = ['p1', o.sessionId || w.sid, o.seq === undefined ? ++app.seq : o.seq, at, lat, lng, acc, (o.mock === undefined ? app.mock : o.mock) ? 1 : 0].join('|');
  return { m, sig: await signWith(app.dev, m) };
}
async function ping(w, app, list) { return api(w, app, 'app.ping', { pings: list || [await report(w, app)] }); }
async function answer(w, app, ch) { return api(w, app, 'app.bio', { bioId: ch.bioId, sig: await signWith(app.bio, ch.message) }); }
function ready(n) {
  const w = world({ students: n });
  w.sid = w.session().sessionId;
  w.ok(w.faculty, 'sessions.open', { sessionId: w.sid, checkinMode: 'C' });
  return w;
}
const row = (w, s) => w.ok(w.faculty, 'attend.roster', { sessionId: w.sid }).roster.find((x) => x.studentId === s.studentId);
const flagsOf = (w, s) => w.ok(w.faculty, 'flags.list', { status: 'all' }).flags.filter((f) => f.studentId === s.studentId).map((f) => f.type);

test('tier 3 link: pairing code from the web, first phone active, a switch waits for the teacher', async () => {
  const w = ready(2); const [a, b] = w.students;
  const app = await link(w, a);
  assert.equal(app.status, 'active');
  const st = api(w, app, 'app.status');
  assert.ok(st.ok); assert.equal(st.data.student.rollNo, a.rollNo); assert.equal(st.data.device.status, 'active');
  // the code is single use and bound to the student who made it
  const again = post(w, 'app.link', { token: app.token, publicKey: app.dev.publicKey, bioPublicKey: app.bio.publicKey, sig: await signWith(app.dev, app.token), bioSig: await signWith(app.bio, app.token) });
  assert.equal(again.error.code, 'REPLAY');
  // a wrong key proof is refused
  const pc = w.ok(b.email, 'app.pairCode'), d1 = await genDevice(), d2 = await genDevice();
  assert.equal(post(w, 'app.link', { token: pc.token, publicKey: d1.publicKey, bioPublicKey: d2.publicKey, sig: await signWith(d2, pc.token), bioSig: await signWith(d2, pc.token) }).error.code, 'BAD_SIGNATURE');
  // the web key and the app have separate slots: a browser device still registers as the first one
  assert.equal((await w.registerDevice(a)).status, 'active');
  // a second phone is pending; it still checks in, flagged, until faculty approve it
  const phone2 = await link(w, a, 'New phone');
  assert.equal(phone2.status, 'pending_approval');
  assert.equal((await scan(w, phone2)).ok, true);
  assert.ok(flagsOf(w, a).includes('unapproved_device'));
  const pending = w.ok(w.faculty, 'cred.pending').pending;
  assert.deepEqual(pending.map((p) => p.credentialId), [phone2.credentialId], 'faculty see phone-app requests only');
  w.ok(w.faculty, 'cred.approve', { credentialId: phone2.credentialId, idChecked: true });
  assert.equal(api(w, app, 'app.status').error.code, 'NO_DEVICE', 'the old phone stops working');
  assert.equal(api(w, phone2, 'app.status').data.device.status, 'active');
});

test('tier 3 check-in: a forwarded old code, a faked location and a far-away phone are recorded and flagged, never refused', async () => {
  const w = ready(4); const [a, b, c, d] = w.students;
  const [pa, pb, pc, pd] = [await link(w, a), await link(w, b), await link(w, c), await link(w, d)];
  const ok = await scan(w, pa);
  assert.equal(ok.ok, true); assert.equal(ok.data.mode, 'C'); assert.equal(ok.data.method, 'app'); assert.equal(ok.data.tracking.track, true);
  const old = w.kioskCode(); w.advance(2 * MIN);
  const fwd = await scan(w, pb, { code: old });
  assert.equal(fwd.ok, true); assert.deepEqual(fwd.data.flagged, ['stale_code']);
  assert.deepEqual((await scan(w, pc, { mock: true })).data.flagged, ['mock_location']);
  assert.deepEqual((await scan(w, pd, { metres: 400 })).data.flagged, ['outside_geofence']);
  for (const s of [b, c, d]) assert.equal(row(w, s).status, 'flagged');
  assert.equal(row(w, a).status, 'present');
  // a check-in not signed by the linked phone is refused (it is not from the app) and flagged as tampered
  const m = ['c1', w.kioskCode(), 'in', w.eval('U.now()'), ...fix(3, 12), 0].join('|');
  const other = await genDevice();
  const e = await link(w, w.students[0]); // a fresh pending phone of a, to avoid DUPLICATE_IN noise
  assert.equal(api(w, e, 'app.scan', { m, sig: await signWith(other, m), sessionId: w.sid }).error.code, 'BAD_SIGNATURE');
  assert.ok(flagsOf(w, a).includes('tampered_report'));
});

test('tier 3 session: present, partial, absent and flagged from reports and fingerprint checks', async () => {
  const w = ready(6); const S = w.students;
  const stay = await link(w, S[0]), leave = await link(w, S[1]), nofinger = await link(w, S[2]), gone = await link(w, S[3]), faker = await link(w, S[4]);
  const iphone = S[5]; // no app: checks in through the kiosk page (tier 1)
  w.advance(MIN);
  for (const app of [stay, leave, nofinger, gone, faker]) assert.equal((await scan(w, app)).ok, true);
  assert.equal(w.checkin(iphone).ok, true);
  const asked = { stay: new Set(), nofinger: new Set() };
  for (let t = 2; t < 120; t += 2) {
    w.advance(2 * MIN);
    if (t === 76) leave.metres = 150;         // walks out at 11:17 without scanning out
    if (t === 30) gone.metres = 250;          // leaves for the hostel at 10:31, walking
    if (t === 34) gone.metres = 500;
    if (t === 40) gone.metres = 900;
    if (t === 50) faker.mock = true;          // switches on a location-faking app
    for (const [k, app] of Object.entries({ stay, leave, nofinger, gone, faker })) {
      const r = await ping(w, app);
      assert.ok(r.ok, JSON.stringify(r.error));
      if (r.data.challenge) {
        if (k === 'nofinger') { asked.nofinger.add(r.data.challenge.bioId); continue; }
        if (k === 'stay') asked.stay.add(r.data.challenge.bioId);
        assert.equal((await answer(w, app, r.data.challenge)).data.outcome, 'passed');
      }
    }
  }
  w.advance(2 * MIN);
  w.ok(w.faculty, 'sessions.close', { sessionId: w.sid });
  assert.equal(asked.stay.size, 2, 'two random fingerprint checks'); assert.equal(asked.nofinger.size, 2);
  const live = (s) => row(w, s);
  assert.equal(live(S[0]).status, 'present'); assert.ok(live(S[0]).app.coveragePct >= 95);
  assert.deepEqual(live(S[0]).app.checks.map((c) => c.outcome), ['passed', 'passed']);
  assert.equal(live(S[1]).status, 'partial'); assert.ok(live(S[1]).app.coveragePct > 55 && live(S[1]).app.coveragePct < 70);
  assert.equal(live(S[2]).status, 'partial'); assert.deepEqual(live(S[2]).app.checks.map((c) => c.outcome), ['missed', 'missed']);
  assert.equal(live(S[3]).status, 'absent'); assert.ok(live(S[3]).app.coveragePct < 40);
  assert.equal(live(S[4]).status, 'flagged'); assert.ok(live(S[4]).app.flags.includes('mock_location'));
  assert.equal(live(S[5]).status, 'flagged'); assert.ok(live(S[5]).app.flags.includes('no_app'), 'an iPhone student is not blocked, only flagged');
  // leaving is not cheating: no flag for the students who walked out
  assert.deepEqual(flagsOf(w, S[1]), []); assert.deepEqual(flagsOf(w, S[3]), []);
  // the stored summaries match the live view (rebuilt at close)
  const sums = w.eval("Db.readAll('AttendanceSummaries')").filter((x) => x.sessionId === w.sid);
  assert.deepEqual(S.map((s) => sums.find((x) => x.studentId === s.studentId).status), ['present', 'partial', 'partial', 'absent', 'flagged', 'flagged']);
  // the teacher overrides; it is an audited event and the summary follows
  w.ok(w.faculty, 'attend.override', { sessionId: w.sid, studentId: S[5].studentId, outcome: 'present', reason: 'iPhone, seen in class' });
  assert.equal(w.eval("Db.readAll('AttendanceSummaries')").find((x) => x.sessionId === w.sid && x.studentId === S[5].studentId).status, 'present');
  assert.equal(w.err(w.faculty2, 'attend.override', { sessionId: w.sid, studentId: S[0].studentId, outcome: 'absent', reason: 'not my class' }).code, 'FORBIDDEN');
  // privacy: no coordinates are stored
  const pings = JSON.stringify(w.eval("Db.readAll('PresencePings')"));
  assert.ok(pings.indexOf(north(LAB_A, 3).lat.toFixed(5)) < 0);
});

test('tier 3 reports: offline batches count, replays and tampering are flagged, jumps and frozen locations are flagged', async () => {
  const w = ready(4); const [a, b, c, d] = w.students;
  const pa = await link(w, a), pb = await link(w, b), pc = await link(w, c), pd = await link(w, d);
  for (const p of [pa, pb, pc, pd]) await scan(w, p);
  // a: offline for 20 minutes; the app queues reports and sends them together
  const queued = [];
  for (let i = 0; i < 10; i++) { w.advance(2 * MIN); queued.push(await report(w, pa)); }
  const r = await ping(w, pa, queued);
  assert.equal(r.data.stored, 10); assert.equal(r.data.track, true);
  assert.ok(row(w, a).app.coveragePct >= 95);
  // b: the same report sent twice, and one with a broken signature
  const one = await report(w, pb);
  await ping(w, pb, [one]); await ping(w, pb, [one]);
  await ping(w, pb, [{ m: one.m.slice(0, -1) + '1', sig: one.sig }]);
  assert.ok(flagsOf(w, b).includes('replayed_report')); assert.ok(flagsOf(w, b).includes('tampered_report'));
  // c: 2 km in two minutes
  w.advance(2 * MIN); await ping(w, pc); w.advance(2 * MIN); pc.metres = 2000; await ping(w, pc);
  assert.ok(flagsOf(w, c).includes('location_jump'));
  // d: exactly the same reading again and again
  pd.frozen = true;
  for (let i = 0; i < 6; i++) { w.advance(2 * MIN); await ping(w, pd); }
  assert.ok(flagsOf(w, d).includes('frozen_location'));
  assert.ok(!flagsOf(w, a).length, 'a clean offline catch-up raises nothing: ' + flagsOf(w, a));
  // reports dated in the future
  await ping(w, pa, [await report(w, pa, { at: w.eval('U.now()') + 30 * MIN })]);
  assert.ok(flagsOf(w, a).includes('clock_skew'));
});

test('tier 3 fingerprint: random times hidden, apart and away from the edges; the teacher can ask any time; a PIN key cannot answer', async () => {
  const w = ready(3); const [a, b] = w.students;
  const s = w.eval("Db.get('Sessions', '" + w.sid + "')"), span = s.scheduledEnd - s.scheduledStart;
  const slots = (st) => w.eval("Presence.slots(Db.get('Sessions', '" + w.sid + "'), '" + st.studentId + "')").map((x) => (x.at - s.scheduledStart) / span);
  for (const st of w.students) {
    const [f1, f2] = slots(st);
    assert.ok(f1 >= 0.15 && f1 <= 0.4 && f2 >= 0.6 && f2 <= 0.85 && f2 - f1 >= 0.2, String([f1, f2]));
  }
  assert.notDeepEqual(slots(a), slots(b), 'each student has different times');
  assert.deepEqual(slots(a), slots(a), 'derived, not stored: the same every time');
  const pa = await link(w, a), pb = await link(w, b);
  await scan(w, pa); await scan(w, pb);
  w.advance(5 * MIN);
  assert.equal((await ping(w, pa)).data.challenge, null, 'nothing due near the start');
  const asked = w.ok(w.faculty, 'presence.bioNow', { sessionId: w.sid });
  assert.equal(asked.reachWithinSeconds, 120);
  assert.equal(w.err(w.faculty2, 'presence.bioNow', { sessionId: w.sid }).code, 'FORBIDDEN');
  const ca = (await ping(w, pa)).data.challenge, cb = (await ping(w, pb)).data.challenge;
  assert.equal(ca.kind, 'teacher'); assert.equal(cb.kind, 'teacher');
  // the same check is offered again until answered (the app may have missed the reply)
  assert.equal((await ping(w, pa)).data.challenge.bioId, ca.bioId);
  // signed with the device key instead of the fingerprint key: refused as tampered
  assert.equal((await api(w, pa, 'app.bio', { bioId: ca.bioId, sig: await signWith(pa.dev, ca.message) })).data.outcome, 'failed');
  assert.ok(flagsOf(w, a).includes('tampered_report'));
  // b answers after the 2-minute window: it counts as missed
  w.advance(3 * MIN);
  assert.equal((await answer(w, pb, cb)).data.outcome, 'late');
  assert.deepEqual(row(w, b).app.checks.map((c) => c.outcome), ['missed']);
  assert.equal(row(w, b).status, 'partial');
});

test('tier 3 signatures in Android Keystore form (high S) verify; tier 1 random location checks', async () => {
  const w = ready(2); const [a, b] = w.students;
  const pa = await link(w, a);
  // Android does not normalise S; flip a valid signature to its high-S twin and it must still verify
  const n = BigInt('0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551');
  const m = ['c1', w.kioskCode(), 'in', w.eval('U.now()'), ...fix(3, 12), 0].join('|');
  const sig = Buffer.from((await signWith(pa.dev, m)).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const s = BigInt('0x' + sig.subarray(32).toString('hex')), hi = n - s;
  const flipped = Buffer.concat([sig.subarray(0, 32), Buffer.from(hi.toString(16).padStart(64, '0'), 'hex')]);
  assert.equal(api(w, pa, 'app.scan', { m, sig: b64u(flipped), sessionId: w.sid }).ok, true);
  // tier 1: the open web page reports at random times; away from the lab is flagged
  assert.equal(w.checkin(b).ok, true);
  const r1 = w.ok(b.email, 'presence.webPing', { sessionId: w.sid, geo: w.at(5, 12) });
  assert.ok(r1.next >= 300 && r1.next <= 900); assert.equal(r1.inLab, true);
  assert.equal(w.ok(b.email, 'presence.webPing', { sessionId: w.sid, geo: w.at(600, 12) }).inLab, false);
  assert.ok(flagsOf(w, b).includes('away_from_lab'));
  assert.equal(w.ok(a.email, 'presence.webPing', { sessionId: w.students[0] ? w.sid : '' }).next !== undefined, true);
});
