/**
 * Presence demo (development only): one class, 10:00-12:00, run through the real server code on the Apps Script
 * fakes, to show that LABFLOW keeps checking who is still in the room. The script decides where each student's
 * phone is; every accept or refuse, status and credited minute comes from the real rpc() gateway.
 *
 *   - Rescans happen only when the faculty calls one (Live roster > Request rescan now). Students are not warned.
 *     The demo's teacher calls two, at times that change on every run.
 *   - Each window is 90 s. Confirming means scanning the door screen again with GPS inside the geofence.
 *
 * Served by dev/server.js at /presence; test/presence.test.js asserts the outcomes.
 */
const { world } = require('../test/fixtures');

const CAST = [
  { key: 'asha', name: 'Asha', role: 'Stays the whole class' },
  { key: 'ravi', name: 'Ravi', role: 'Slips out to the canteen' },
  { key: 'meena', name: 'Meena', role: 'Marks in from the hostel with a faked location' },
  { key: 'karthik', name: 'Karthik', role: 'Leaves early and scans out' },
  { key: 'divya', name: 'Divya', role: 'Arrives late, stays' }
];
// Where each phone is: metres north of the lab (radius 20 m) and the reported GPS accuracy.
const PLACES = { door: [0, 12], desk: [6, 12], canteen: [300, 15], hostel: [1200, 20], away: [800, 20] };
const MIN = 60000;

function run() {
  const w = world({ students: CAST.length, mode: 'A' });
  const S = {}; CAST.forEach((c, i) => { S[c.key] = Object.assign({}, c, w.students[i], { place: 'away', shown: 'away' }); });
  const sid = w.session().sessionId, start = w.eval('U.now()');
  const frames = [], windows = [];
  const geo = (place) => w.at(PLACES[place][0], PLACES[place][1]);
  const at = () => w.eval('U.now()');
  const goTo = (t) => { const now = at(); if (t > now) w.advance(t - now); };
  const snap = (text, result) => {
    const rows = w.ok(w.faculty, 'attend.roster', { sessionId: sid }).roster;
    frames.push({ at: at(), text, result: result || null,
      students: CAST.map((c) => { const s = S[c.key], r = rows.find((x) => x.studentId === s.studentId) || {};
        return { key: c.key, place: s.shown, state: r.state || 'out', status: r.status || 'absent', flags: r.flags || [], minutes: r.verifiedMinutes || 0, lastProof: s.lastProof || null }; }) });
  };
  const outcome = (r) => (r.ok ? { ok: true, flagged: r.data.assurance === 'flagged' } : { ok: false, code: r.error.code, message: r.error.message });
  /** A student's phone scans the door screen. The phone reports the location it is told to (the hostel trick sends the lab's). */
  const scan = (key, action, reportFrom, text) => {
    const s = S[key], r = w.checkin(s, { action, geo: geo(reportFrom || s.place) });
    if (r.ok) s.lastProof = at();
    snap(text, Object.assign({ who: s.name, action }, outcome(r)));
    return r;
  };
  const move = (key, place, text) => { S[key].place = place; S[key].shown = place; snap(text); };

  w.ok(w.faculty, 'sessions.open', { sessionId: sid, checkinMode: 'A' });
  snap('10:00. The teacher opens the class with kiosk QR + GPS. During the class the teacher can call a presence rescan at any moment. Students are never told when.');

  const inLab = (k) => S[k].place === 'door' || S[k].place === 'desk';
  const enter = (k, text) => { S[k].place = 'door'; S[k].shown = 'door'; scan(k, 'in', null, text); S[k].place = 'desk'; S[k].shown = 'desk'; };
  const leave = (k, text) => { S[k].shown = 'door'; scan(k, 'out', 'door', text); S[k].place = 'away'; S[k].shown = 'away'; };
  let ravisTry = false;
  const rescan = (kind) => {
    w.ok(w.faculty, 'attend.openRescan', { sessionId: sid });
    const from = at(), closesAt = from + 90 * 1000;
    windows.push({ kind, from, to: closesAt });
    snap(kind === 'first'
      ? 'RESCAN. The teacher presses "Request rescan now" in the Live roster. Every phone still marked inside must scan the door screen again within 90 seconds, with GPS inside the lab.'
      : 'Later the teacher calls another rescan. Same rule: 90 seconds, at the door, inside the geofence.');
    w.advance(20 * 1000);
    ['asha', 'karthik', 'divya'].filter(inLab).forEach((k) => { S[k].shown = 'door'; scan(k, 'rescan', 'door', S[k].name + ' walks to the door screen and confirms. Proven present at this moment.'); S[k].shown = 'desk'; });
    if (S.ravi.place === 'canteen' && !ravisTry) { ravisTry = true; w.advance(10 * 1000); scan('ravi', 'rescan', 'canteen', 'Ravi sees the alert and confirms from the canteen. Recorded but flagged: his phone is 300 m from the lab, so it proves nothing and the teacher reviews him.'); }
    goTo(closesAt + 1000);
    w.e.run('trg_tickSessions()');
    snap(kind === 'first'
      ? 'The window closes. Meena never confirmed: she cannot see the door screen from the hostel, and nobody knew the time in advance. Ravi confirmed from outside, so he is flagged for the teacher. Anyone who did not confirm is now "missed rescan", and their time stops at their last proof.'
      : 'The second window closes. Everyone in the room has proved they are here; Ravi and Meena still have nothing after their first scan.');
  };

  // The teacher picks the moments; they change on every run so nobody can learn them.
  const firstAt = start + (33 + Math.floor(Math.random() * 22)) * MIN, secondAt = start + (75 + Math.floor(Math.random() * 30)) * MIN;
  const agenda = [
    [start + 2 * MIN, () => {
      ['asha', 'ravi', 'karthik'].forEach((k) => enter(k, S[k].name + ' scans the door screen. GPS puts the phone inside the lab: marked in.'));
      S.meena.place = 'hostel'; S.meena.shown = 'hostel';
      scan('meena', 'in', 'desk', "Meena is at the hostel. A friend sends her a photo of the door screen and she fakes the lab's location from the browser. Her phone reports the lab's coordinates, so it is accepted: a web page cannot prove where a phone really is. Had she sent her real hostel location, it would be recorded and flagged, not counted as present until the teacher decides. Watch what happens next.");
    }],
    [start + 20 * MIN, () => enter('divya', 'Divya arrives 20 minutes late and scans in.')],
    [start + 27 * MIN, () => move('ravi', 'canteen', 'Ravi walks out to the canteen without scanning out. On paper he is still in the lab.')],
    [start + 60 * MIN, () => leave('karthik', 'Karthik leaves at 11:00 and scans out at the door. He is not flagged and nothing is wrong with his scans, but half a class is not enough to count as attended.')],
    [firstAt, () => rescan('first')],
    [secondAt, () => rescan('second')],
    [start + 115 * MIN, () => ['asha', 'divya'].forEach((k) => leave(k, S[k].name + ' scans out at the end of class.'))],
    [start + 120 * MIN, () => { w.ok(w.faculty, 'sessions.close', { sessionId: sid }); snap('12:00. The class closes. Attendance is attended or not: a student needs to be proven in the lab for at least 75% of the class. Divya came 20 minutes late and stayed, so she counts. Karthik left at 11:00, so he does not, with no flag. A missed rescan means not attended; Ravi confirmed from outside, so the teacher decides.'); }]
  ];
  agenda.sort((x, y) => x[0] - y[0]).forEach(([t, fn]) => { goTo(t); fn(); });

  const roster = w.ok(w.faculty, 'attend.roster', { sessionId: sid }).roster;
  return {
    start, end: start + 120 * MIN, radiusM: 20, windows, frames,
    cast: CAST.map((c) => { const r = roster.find((x) => x.studentId === S[c.key].studentId); return Object.assign({}, c, { rollNo: S[c.key].rollNo, status: r.status, flags: r.flags, minutes: r.verifiedMinutes }); })
  };
}

module.exports = { run };
