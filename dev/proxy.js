/**
 * Proxy attempts (development only): one tier-3 class, 10:00-12:00, where every student has the LABFLOW app, replayed
 * once per cheating trick. Each run goes through the real server code on the Apps Script fakes with the app simulated
 * the way test/tier3.test.js does it: the same P-256 keys, signed check-ins, a signed location report every 2 minutes
 * and the fingerprint checks the server asks for. The script decides where each person and each phone is; every
 * accept, flag and result comes from the real rpc() gateway. Asha is honest in every run, for comparison.
 *
 * Played by dev/lab/presence.html (the same player as the presence replay). test/proxy.test.js asserts the outcomes.
 */
const { world, genDevice, signWith, LAB_A, north } = require('../test/fixtures');

const MIN = 60000;
// Where a person or phone is: metres north of the lab (radius 20 m) and the GPS accuracy the phone reports.
const PLACES = { door: [0, 12], desk: [6, 12], canteen: [300, 15], hostel: [1200, 20], away: [800, 20] };

const post = (w, action, payload, session) => JSON.parse(w.e.run('doPost({ postData: { contents: ' + JSON.stringify(JSON.stringify({ action, payload, session })) + ' } }).getContent()'));
const fix = (metres, acc) => { const p = north(LAB_A, metres); return [p.lat.toFixed(7), p.lng.toFixed(7), String(acc)]; };

const ATTEMPTS = [
  { id: 'photo', label: 'Photo of the screen', who: 'meena', role: 'At the hostel; a friend sends her a photo of the door screen',
    blurb: 'A friend in the lab photographs the door screen and sends it to Meena at the hostel. She scans the photo with the app.' },
  { id: 'fakegps', label: 'Fake GPS app', who: 'meena', role: 'At the hostel, with a location-faking app',
    blurb: 'Meena turns on a fake-GPS app that puts her phone in the lab, and a friend shows her the door screen live on a video call.' },
  { id: 'leftphone', label: 'Phone left in the lab', who: 'ravi', role: 'Checks in, leaves his phone on the desk, goes to the canteen',
    blurb: 'Ravi checks in properly, then leaves his phone on the desk and walks to the canteen. The phone keeps reporting from inside the lab.' },
  { id: 'swap', label: 'Friend swaps accounts', who: 'karthik', role: 'In the lab; signs in as Meena on his own phone', also: 'meena',
    blurb: 'Karthik checks himself in, then signs out of the app and signs in as Meena to check her in from his phone.' },
  { id: 'walkout', label: 'Checks in, walks out', who: 'ravi', role: 'Checks in, then leaves with his phone',
    blurb: 'Ravi checks in at 10:02 and walks out to the canteen at 10:40 with his phone in his pocket, without checking out.' },
  { id: 'emulator', label: 'Emulator at the hostel', who: 'meena', role: 'Runs the app on a laptop emulator fed the lab location',
    blurb: 'Meena runs the app on an Android emulator at the hostel and feeds it the lab coordinates, so every report says the same spot.' },
  { id: 'noapp', label: 'Skips the app', who: 'divya', role: 'Checks in on the web page instead of the app',
    blurb: 'Divya does not use the app in a phone-app class. She checks in on the LABFLOW web page at the door screen instead.' }
];
const NAMES = { asha: 'Asha', ravi: 'Ravi', meena: 'Meena', karthik: 'Karthik', divya: 'Divya' };

async function run(id) {
  const A = ATTEMPTS.find((a) => a.id === id);
  if (!A) throw new Error('unknown proxy attempt ' + id);
  const keys = ['asha', A.who].concat(A.also ? [A.also] : []);
  const w = world({ students: keys.length });
  const sid = w.session().sessionId, start = w.eval('U.now()');
  const at = () => w.eval('U.now()');
  const S = {};
  keys.forEach((k, i) => { S[k] = Object.assign({ key: k, name: NAMES[k], place: 'away', phone: 'away', mock: false, frozen: false, apps: [], app: null, seen: null, tracking: false }, w.students[i]); });
  const frames = [], windows = [];
  const api = (app, action, payload) => post(w, action, Object.assign({ credentialId: app.credentialId }, payload || {}), app.session);

  /** The app on a phone links to an account through a single-use code from the signed-in web app. */
  const link = async (owner, holder, label) => {
    const dev = await genDevice(), bio = await genDevice(), pc = w.ok(owner.email, 'app.pairCode');
    const r = post(w, 'app.link', { token: pc.token, publicKey: dev.publicKey, bioPublicKey: bio.publicKey, sig: await signWith(dev, pc.token), bioSig: await signWith(bio, pc.token), label });
    if (!r.ok) throw new Error('link failed: ' + JSON.stringify(r.error));
    return { dev, bio, session: r.data.session, credentialId: r.data.credentialId, status: r.data.status, owner, holder, seq: 0 };
  };
  const reading = (s) => { const p = PLACES[s.mock || s.frozen ? 'desk' : s.phone]; const jitter = s.frozen ? 0 : ((s.app.seq * 7) % 10) / 10; return fix(p[0] + jitter, p[1]); };
  const outcome = (r) => (r.ok ? { ok: true, flagged: (r.data.flagged || []).length > 0 || r.data.assurance === 'flagged', flags: r.data.flagged || [] } : { ok: false, code: r.error.code, message: r.error.message });

  const snap = (text, result) => {
    const rows = w.ok(w.faculty, 'attend.roster', { sessionId: sid }).roster;
    frames.push({ at: at(), text, result: result || null,
      students: keys.map((k) => { const s = S[k], r = rows.find((x) => x.studentId === s.studentId) || {}, app = r.app || {};
        return { key: k, place: s.place, phone: s.phone, state: r.state || 'out', status: r.status || 'absent', flags: (app.flags || r.flags || []), coverage: app.coveragePct || 0, lastProof: s.seen }; }) });
  };
  /** The app scans the door screen: a check-in signed by the phone's device key. */
  const appScan = async (s, text, o = {}) => {
    const [lat, lng, acc] = reading(s);
    const m = ['c1', o.code || w.kioskCode(), 'in', at(), lat, lng, acc, s.mock ? 1 : 0].join('|');
    const r = api(s.app, 'app.scan', { m, sig: await signWith(s.app.dev, m) });
    if (r.ok) { s.tracking = true; if (PLACES[s.phone][0] <= 20 && !s.mock) s.seen = at(); }
    snap(text, Object.assign({ who: s.name }, outcome(r)));
    return r;
  };
  /** Every 2 minutes each tracking app sends a signed location report. The server may hand back a fingerprint check. */
  const reportAll = async (narrate) => {
    for (const k of keys) {
      const s = S[k];
      if (!s.tracking || !s.app) continue;
      const [lat, lng, acc] = reading(s);
      const m = ['p1', sid, ++s.app.seq, at(), lat, lng, acc, s.mock ? 1 : 0].join('|');
      const r = api(s.app, 'app.ping', { pings: [{ m, sig: await signWith(s.app.dev, m) }] });
      if (!r.ok) throw new Error('ping failed: ' + JSON.stringify(r.error));
      if (PLACES[s.phone][0] <= 20 && !s.mock && !s.frozen) s.seen = at();
      if (r.data.challenge) await challenge(s, r.data.challenge, narrate);
    }
  };
  const asked = new Set();
  const challenge = async (s, ch, narrate) => {
    const owner = s.app.owner, withPhone = owner.place === s.phone, atLab = PLACES[s.phone][0] <= 20;
    if (!withPhone && asked.has(ch.bioId)) return; // an unanswered check comes back with every report until it expires
    asked.add(ch.bioId);
    const label = ch.kind === 'teacher' ? 'Teacher check' : 'Fingerprint';
    if (owner.key === A.who || owner.key === A.also) windows.push({ kind: ch.kind, from: at(), to: ch.deadline, label: label + ' ' + owner.name });
    if (!withPhone) { snap(narrate.missed ? narrate.missed(owner) : owner.name + "'s phone asks for a fingerprint. " + owner.name + ' is not with the phone, so nobody can answer it.'); return; }
    const r = api(s.app, 'app.bio', { bioId: ch.bioId, sig: await signWith(s.app.bio, ch.message) });
    const res = Object.assign({ who: owner.name }, r.ok ? { ok: true, flagged: r.data.outcome !== 'passed' } : outcome(r));
    if (!atLab || s.mock || s.frozen) {
      if (narrate.awayShown) return;
      narrate.awayShown = true;
      return snap(owner.name + "'s phone asks for a fingerprint, and " + owner.name + ' answers it with the phone in hand. That proves who holds the phone, not where it is: the location reports still decide.', res);
    }
    if (owner.key === 'asha' && narrate.ashaShown) return;
    if (owner.key === 'asha') narrate.ashaShown = true;
    snap(owner.name + "'s phone buzzes: a fingerprint check at a time only the server knew. " + owner.name + ' touches the sensor. The answer is signed by a key that only a fingerprint unlocks.', res);
  };
  const tickTo = async (t, narrate) => { while (at() + 2 * MIN <= t) { w.advance(2 * MIN); await reportAll(narrate); } const now = at(); if (t > now) w.advance(t - now); };

  // everyone has linked the app on their own phone before the class (the first phone is active at once)
  for (const k of keys) { S[k].app = await link(S[k], S[k], NAMES[k] + "'s phone"); S[k].apps.push(S[k].app); }
  w.ok(w.faculty, 'sessions.open', { sessionId: sid, checkinMode: 'C' });
  snap('10:00. The teacher opens the class in phone-app mode. ' + A.blurb, null);
  const narrate = {};
  const enter = async (k, text) => { const s = S[k]; s.place = 'door'; s.phone = 'door'; await appScan(s, text); s.place = 'desk'; s.phone = 'desk'; };

  w.advance(2 * MIN);
  await enter('asha', 'Asha scans the door screen with the app. Fresh code, phone at the lab, signed by her phone: checked in. From now on the app reports her location every 2 minutes, also with the screen locked.');
  const M = S.meena, R = S.ravi, K = S.karthik, D = S.divya;

  if (id === 'photo') {
    M.place = 'hostel'; M.phone = 'hostel';
    const photo = w.kioskCode(); w.advance(90 * 1000);
    await appScan(M, 'The photo reaches Meena 90 seconds later and she scans it with the app. The code is old and her phone is 1.2 km away. Recorded, but flagged twice: an old code and outside the lab. She does not count as present until the teacher decides.', { code: photo });
    await tickTo(start + 120 * MIN, narrate);
  } else if (id === 'fakegps') {
    M.place = 'hostel'; M.phone = 'hostel'; M.mock = true;
    await appScan(M, "Meena scans the live code over the video call. The fake-GPS app puts her phone in the lab, but Android marks the reading as coming from a mock location app, and the app signs that mark into the check-in. Recorded and flagged: faked location.");
    await tickTo(start + 120 * MIN, narrate);
  } else if (id === 'leftphone') {
    await enter('ravi', 'Ravi scans the door screen with the app. Checked in, honestly so far.');
    await tickTo(start + 15 * MIN, narrate);
    R.place = 'canteen'; snap('10:15. Ravi leaves his phone on the desk and walks to the canteen. The phone keeps reporting from inside the lab, so on location alone he still looks present.');
    narrate.missed = (o) => o.name + "'s phone, alone on the desk, asks for a fingerprint. Only " + o.name + "'s finger unlocks the key, and he is in the canteen. A friend's finger does not work, and a PIN cannot unlock it. Missed.";
    await tickTo(start + 70 * MIN, narrate);
    w.ok(w.faculty, 'presence.bioNow', { sessionId: sid });
    snap('11:10. The teacher presses "Fingerprint check now" on the live roster. Every phone gets it with its next report, within 2 minutes.', { who: 'Teacher', ok: true, flagged: false });
    await tickTo(start + 120 * MIN, narrate);
  } else if (id === 'swap') {
    M.place = 'hostel'; M.phone = 'hostel';
    await enter('karthik', 'Karthik scans the door screen with the app. Checked in.');
    w.advance(3 * MIN);
    K.tracking = false; K.app = null;
    const mine = await link(M, K, "Karthik's phone");
    K.app = mine; K.tracking = false;
    snap("10:05. Karthik signs out of the app, which deletes its keys, and signs in as Meena. Meena already has her own phone linked, so this one is a new phone for her account: it waits for the teacher's approval.");
    const [lat, lng, acc] = fix(PLACES.desk[0], PLACES.desk[1]);
    const m = ['c1', w.kioskCode(), 'in', at(), lat, lng, acc, 0].join('|');
    const r = api(mine, 'app.scan', { m, sig: await signWith(mine.dev, m) });
    snap("Karthik scans the door screen as Meena. The phone is at the lab, but it is not Meena's approved phone. Recorded and flagged: unapproved phone. The teacher sees the switch request, and that it came from inside the lab while Meena's own phone never checked in.", Object.assign({ who: 'Meena' }, outcome(r)));
    narrate.missed = (o) => o.name + "'s phone was signed out, so " + o.name + "'s fingerprint check never reaches him. Missed.";
    await tickTo(start + 120 * MIN, narrate);
    snap('Karthik paid for it too: once he signed out, his own phone stopped reporting for him, so his time at the lab stopped at 10:05 and his fingerprint checks were never answered.');
  } else if (id === 'walkout') {
    await enter('ravi', 'Ravi scans the door screen with the app. Checked in.');
    await tickTo(start + 40 * MIN, narrate);
    R.place = 'canteen'; R.phone = 'canteen';
    snap('10:40. Ravi walks out to the canteen without checking out. His phone goes with him, and the next report says 300 m from the lab.');
    await tickTo(start + 120 * MIN, narrate);
  } else if (id === 'emulator') {
    M.place = 'hostel'; M.phone = 'hostel'; M.frozen = true;
    await appScan(M, 'Meena scans a forwarded code from the emulator, which reports the lab coordinates. The check-in looks fine on its own.');
    await tickTo(start + 20 * MIN, narrate);
    snap('Real GPS jitters by a metre or so on every reading. The emulator reports exactly the same spot and accuracy, report after report, and after six in a row the server flags it: frozen location.');
    await tickTo(start + 120 * MIN, narrate);
  } else if (id === 'noapp') {
    D.place = 'door'; D.phone = 'door';
    const r = w.checkin(D, { action: 'in', geo: w.at(PLACES.door[0], PLACES.door[1]) });
    D.place = 'desk'; D.phone = 'desk';
    snap('Divya checks in on the web page at the door screen instead of the app. She is not blocked, but in a phone-app class nothing keeps proving she stays, so she is flagged "no app" for the teacher to decide.', Object.assign({ who: 'Divya' }, r.ok ? { ok: true, flagged: true } : outcome(r)));
    await tickTo(start + 120 * MIN, narrate);
  }

  w.ok(w.faculty, 'sessions.close', { sessionId: sid });
  const roster = w.ok(w.faculty, 'attend.roster', { sessionId: sid }).roster;
  snap('12:00. The class closes. Attended needs the phone at the lab for at least 75% of the class, every fingerprint check passed and no open flag. Everyone else is not attended; a flagged student waits for the teacher to decide.');
  return {
    id: A.id, label: A.label, blurb: A.blurb, tier: 3, start, end: start + 120 * MIN, radiusM: 20, windows, frames,
    cast: keys.map((k) => { const r = roster.find((x) => x.studentId === S[k].studentId), app = r.app || {};
      return { key: k, name: NAMES[k], rollNo: S[k].rollNo, role: k === 'asha' ? 'Honest: stays the whole class' : k === A.who ? A.role : 'At the hostel, never comes',
        status: r.status, flags: app.flags || r.flags || [], coverage: app.coveragePct || 0, checks: (app.checks || []).map((c) => c.outcome) }; })
  };
}

async function runAll() { const out = []; for (const a of ATTEMPTS) out.push(await run(a.id)); return out; }

module.exports = { run, runAll, ATTEMPTS };
