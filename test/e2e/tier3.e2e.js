#!/usr/bin/env node
/**
 * Browser check of tier 3 (the phone app) on the real UI and the real server code on in-memory fakes (dev/server.js).
 * Run:  npm run e2e:tier3
 * The web side runs in Chrome: the student makes a link code on the hosted page (/app?pairApp=1, the address the
 * Android app opens), and the faculty use the live roster. The phone app itself is simulated with Node WebCrypto and
 * the same signed messages and doPost calls as the Android code (android/), so this does not test the APK on a phone.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { start } = require('../../dev/server');
const { genDevice, signWith, north } = require('../fixtures');

const SHOTS = path.join(__dirname, '..', '..', '.build', 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
let failures = 0;
function check(name, ok, detail) { if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || !detail ? '' : '  -> ' + detail)); }
const IST = (h, m) => Date.UTC(2026, 9, 14, h, m) - 330 * 60000;

(async () => {
  const dev = await start(0, { preset: 'demo' });
  const base = dev.base.replace(/\/$/, ''), lab = dev.lab, w = lab.w;
  const setClock = (ms) => { lab.clock.set(ms); lab.sync(); };
  const exec = (action, payload, session) => fetch(base + '/exec', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ action, payload, session }) }).then((r) => r.json());
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chrome' });
  const errors = [];
  const watch = (p, label) => p.on('pageerror', (e) => errors.push(label + ': ' + e.message));
  const shot = (p, name) => p.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: false });
  try {
    // the faculty open the 10:00 IoT class as a phone-app session
    setClock(IST(9, 58));
    const ses = w.ok(w.faculty, 'sessions.day', { date: '2026-10-14' }).sessions.find((s) => s.labId === w.lab.labId);
    // the demo preset has already opened the class; switch it to tier 3, the value the open dialog stores
    if (ses.status === 'scheduled') w.ok(w.faculty, 'sessions.open', { sessionId: ses.sessionId, checkinMode: 'C' });
    else w.e.run("Db.update('Sessions', '" + ses.sessionId + "', { checkinMode: 'C' })");
    setClock(IST(10, 1));
    // two students who have not arrived yet: one with the app, one with an iPhone
    const none = w.ok(w.faculty, 'attend.roster', { sessionId: ses.sessionId }).roster.filter((r) => r.state === 'none' && r.enrolled).map((r) => r.studentId);
    const [S1, S2] = w.students.filter((s) => none.includes(s.studentId));

    // student: the hosted page the app opens makes a single-use link code
    const H = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); watch(H, 'student');
    await H.goto(base + '/app?pairApp=1'); await H.waitForSelector('text=Sign in (dev server)');
    await H.getByLabel('Email (dev server)').fill(S1.email); await H.getByRole('button', { name: 'Sign in (dev server)' }).click();
    await H.waitForSelector('text=Link the LABFLOW phone app'); await H.waitForTimeout(300); await shot(H, '30-student-link-app');
    const href = await H.getByRole('link', { name: 'Open the LABFLOW app' }).getAttribute('href');
    check('the hosted page opened with ?pairApp=1 shows a labflow:// link code', /^labflow:\/\/pair\?t=/.test(href), href);

    // the phone app: link with two keys, check in by scanning the kiosk code, then report every two minutes
    const token = decodeURIComponent(href.split('t=')[1]), dev1 = await genDevice(), bio = await genDevice();
    const linked = await exec('app.link', { token, publicKey: dev1.publicKey, bioPublicKey: bio.publicKey, sig: await signWith(dev1, token), bioSig: await signWith(bio, token), label: 'Pixel 7' });
    check('the app links through doPost without a Google session', linked.ok && linked.data.status === 'active', JSON.stringify(linked.error));
    const app = { session: linked.data.session, cred: linked.data.credentialId, seq: 0 };
    const fix = (m) => { const p = north(w.lab.latitude !== undefined ? { lat: w.lab.latitude, lng: w.lab.longitude } : { lat: 0, lng: 0 }, m); return [p.lat.toFixed(7), p.lng.toFixed(7), '11.0']; };
    const code = w.call('kiosk1@karunya.edu', 'kiosk.display', {}).data.code;
    const now = () => w.eval('U.now()');
    const m = ['c1', code, 'in', now(), ...fix(4), 0].join('|');
    const scan = await exec('app.scan', { credentialId: app.cred, m, sig: await signWith(dev1, m) }, app.session);
    check('the app check-in is accepted and starts tracking', scan.ok && scan.data.tracking && scan.data.tracking.track === true, JSON.stringify(scan.error || scan.data && scan.data.tracking));
    for (let i = 0; i < 5; i++) {
      setClock(now() + 2 * 60000);
      const p = ['p1', ses.sessionId, ++app.seq, now(), ...fix(3 + (i % 3) * 0.7), 0].join('|');
      await exec('app.ping', { credentialId: app.cred, pings: [{ m: p, sig: await signWith(dev1, p) }] }, app.session);
    }
    // an iPhone student without the app checks in at the kiosk page: not refused, flagged
    w.checkin(S2, { geo: w.at(3, 12) });

    // faculty: live roster with the phone-app column, and a fingerprint check for the whole class
    const F = await browser.newPage({ viewport: { width: 1440, height: 900 } }); watch(F, 'faculty');
    await F.goto(base + '/?as=faculty@karunya.edu'); await F.waitForSelector('text=Today\'s labs');
    check('the session card says phone app (tier 3)', await F.locator('text=phone app (tier 3)').count() >= 1);
    await F.getByRole('button', { name: 'Live roster' }).first().click();
    const roll1 = S1.rollNo, roll2 = S2.rollNo;
    await F.waitForSelector('tr:has-text("' + roll1 + '")'); await F.waitForTimeout(400);
    const row1 = await F.locator('tr', { hasText: roll1 }).innerText(), row2 = await F.locator('tr', { hasText: roll2 }).innerText();
    check('the app student shows at the lab with a last report and share of the session', /at the lab/.test(row1) && /% of session/.test(row1) && /Last report/.test(row1), row1);
    check('the student without the app is flagged, not refused', /flagged/i.test(row2) && /no app/.test(row2), row2);
    await F.getByRole('button', { name: 'Fingerprint check now' }).click();
    await F.waitForSelector('text=Fingerprint check sent'); await shot(F, '31-faculty-tier3-roster');
    setClock(now() + 2 * 60000);
    const p = ['p1', ses.sessionId, ++app.seq, now(), ...fix(4), 0].join('|');
    const reply = await exec('app.ping', { credentialId: app.cred, pings: [{ m: p, sig: await signWith(dev1, p) }] }, app.session);
    const ch = reply.data && reply.data.challenge;
    check('the next report from the phone carries the teacher\'s fingerprint check', !!ch && ch.kind === 'teacher', JSON.stringify(reply));
    const ans = await exec('app.bio', { credentialId: app.cred, bioId: ch.bioId, sig: await signWith(bio, ch.message) }, app.session);
    check('a fingerprint-key signature passes the check', ans.ok && ans.data.outcome === 'passed', JSON.stringify(ans));
    await F.getByRole('button', { name: 'Reload' }).click(); await F.waitForTimeout(600);
    check('the roster shows the passed fingerprint check', /fingerprint passed/.test(await F.locator('tr', { hasText: roll1 }).innerText()));
    await F.locator('tr', { hasText: roll2 }).getByRole('button', { name: /Actions/ }).click();
    await F.getByRole('button', { name: 'Override the result' }).click();
    await F.getByLabel('Reason').fill('iPhone, seen in the room');
    await F.getByRole('button', { name: 'Record result' }).click();
    await F.waitForSelector('text=Result recorded'); await F.waitForTimeout(600);
    check('the faculty override shows on the roster', /present/i.test(await F.locator('tr', { hasText: roll2 }).innerText()));
    check('no page errors', errors.length === 0, errors.join(' | '));
  } catch (e) { failures++; console.error(e); }
  await browser.close(); dev.server.close();
  console.log(failures ? failures + ' failed' : 'all passed');
  process.exit(failures ? 1 : 0);
})();
