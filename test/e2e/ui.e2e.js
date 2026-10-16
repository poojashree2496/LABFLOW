#!/usr/bin/env node
/**
 * Browser end-to-end check of the REAL UI against the REAL server code on in-memory fakes (dev/server.js, demo world).
 * Run:  npm run e2e      (uses the installed Google Chrome through playwright-core; set CHROMIUM_PATH to use another)
 * It drives both check-in modes with genuine browser WebCrypto + IndexedDB keys, simulated GPS and the real server-side
 * verification. It does NOT prove behaviour inside Google's HtmlService iframe, Workspace identity or Apps Script latency.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { start } = require('../../dev/server');

const SHOTS = path.join(__dirname, '..', '..', '.build', 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const results = []; let failures = 0;
function check(name, ok, detail) { results.push({ name, ok, detail }); if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || !detail ? '' : '  -> ' + detail)); }
const IST = (h, m) => Date.UTC(2026, 9, 14, h, m) - 330 * 60000;

(async () => {
  const dev = await start(0, { preset: 'demo' });
  const base = dev.base.replace(/\/$/, ''), lab = dev.lab, w = lab.w;
  const post = (name, body) => fetch(base + '/dev/api/' + name, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const setClock = (ms) => { lab.clock.set(ms); lab.sync(); };
  const tick = () => post('job', { name: 'tickSessions' });
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chrome' });
  const errors = [];
  async function page(ctx, who, label, query) {
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(label + ' pageerror: ' + e.message));
    p.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_(NAME|INTERNET|CONNECTION|TUNNEL|PROXY)|Failed to load resource/.test(m.text())) errors.push(label + ' console: ' + m.text()); });
    await p.goto(base + '/?as=' + who + (query || ''));
    return p;
  }
  const shot = (p, name) => p.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: false });
  const mobile = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
  const desktop = { viewport: { width: 1280, height: 820 } };
  const kioskCode = (k) => w.call(k, 'kiosk.display', {}).data.code;
  try {
    // ---------------- student phone: home, compatibility check, device registration (for device-QR labs)
    setClock(IST(10, 1)); await tick(); // the 10:00 IoT class opens by itself from the timetable
    const sctx = await browser.newContext(mobile), s1 = await page(sctx, 'student1@karunya.edu', 'student');
    await s1.waitForSelector('text=Today\'s lab sessions'); await s1.waitForTimeout(400); await shot(s1, '01-student-today-mobile');
    check('student home renders with sessions and the live lab count', await s1.locator('article').count() >= 1 && await s1.locator('.occ-card').count() === 3);
    await s1.getByRole('button', { name: 'Device' }).last().click();
    await s1.getByRole('button', { name: 'Register this phone' }).click();
    await s1.waitForSelector('text=Device registered');
    check('device registration through real WebCrypto + server P-256 verification', true);
    await s1.getByRole('button', { name: 'Run check' }).click();
    await s1.waitForSelector('text=Key storage (IndexedDB)'); await s1.waitForTimeout(400);
    const diag = await s1.locator('section[aria-label="Compatibility check"]').innerText();
    check('compatibility check reports key storage and location', /Key storage \(IndexedDB\)[\s\S]*OK/.test(diag) && /Location/.test(diag), diag.slice(0, 300));

    // ---------------- Version A: kiosk screen QR + phone camera link + GPS
    const kctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }), k1 = await page(kctx, 'kiosk1@karunya.edu', 'kiosk-A');
    await k1.waitForSelector('svg[aria-label="Attendance QR code"]'); await k1.waitForTimeout(500); await shot(k1, '02-kiosk-qr-display');
    check('kiosk in mode A shows a rotating check-in QR', await k1.locator('text=Scan to check in').count() === 1);
    await s1.goto(base + '/?as=student1@karunya.edu&k=' + encodeURIComponent(kioskCode('kiosk1@karunya.edu')));
    await s1.waitForSelector('text=What are you here for?'); await shot(s1, '03-student-checkin-pass');
    check('the scanned code is validated as the page opens, with the timetabled class pre-selected', await s1.locator('input[name="kc-ses"]:checked').count() === 1);
    await s1.getByRole('button', { name: /Send location and check in/ }).click();
    await s1.waitForSelector('text=Location check passed'); await shot(s1, '04-student-checked-in');
    check('Version A check-in accepted with the simulated GPS inside the geofence', true);
    await post('geo', { mode: 'outside', lab: 'A', offsetM: 250 });
    const s4 = await page(sctx, 'student4@karunya.edu', 'student4', '&k=' + encodeURIComponent(kioskCode('kiosk1@karunya.edu')));
    await s4.waitForSelector('text=What are you here for?'); await s4.getByRole('button', { name: /Send location and check in/ }).click();
    await s4.waitForSelector('.result.bad'); await shot(s4, '05-student-outside-geofence');
    check('a phone 250 m away is refused by the geofence', /from the lab/.test(await s4.locator('.result.bad').innerText()));
    await post('geo', { mode: 'inside', lab: 'A', offsetM: 4 });
    await s4.close();

    // ---------------- faculty: live roster shows how each student checked in
    const fctx = await browser.newContext(desktop), f = await page(fctx, 'faculty@karunya.edu', 'faculty');
    await f.waitForSelector('text=Today\'s labs'); await shot(f, '06-faculty-today');
    await f.getByRole('button', { name: 'Live roster' }).first().click();
    await f.waitForSelector('tr:has-text("URK24CS1001")'); await f.waitForTimeout(400);
    const row = await f.locator('tr', { hasText: 'URK24CS1001' }).innerText();
    check('live roster shows the student inside, checked in at the kiosk with GPS ok', /Inside/.test(row) && /kiosk/.test(row) && /GPS ok/.test(row), row);
    await shot(f, '07-faculty-live-roster');
    await f.getByRole('button', { name: 'Random spot check' }).click();
    await f.waitForSelector('text=Spot checks to complete'); await shot(f, '08-faculty-spot-check');
    check('spot check created with the photo-less fallback', await f.locator('text=No photo on file').count() >= 1);
    await f.getByRole('button', { name: 'Matches' }).first().click(); await f.locator('.toast', { hasText: 'Recorded' }).waitFor();

    // ---------------- staff: equipment request from inside the lab, filled on the issue screen
    setClock(IST(10, 30));
    await s1.goto(base + '/?as=student1@karunya.edu'); await s1.getByRole('button', { name: 'Equipment' }).last().click();
    await s1.getByRole('tab', { name: 'Request in the lab' }).click(); await s1.waitForSelector('text=Ask the lab desk');
    await s1.getByLabel('What do you need?').selectOption({ label: /ESP32 board/ }).catch(async () => { const v = await s1.getByLabel('What do you need?').locator('option', { hasText: 'ESP32 board' }).getAttribute('value'); await s1.getByLabel('What do you need?').selectOption(v); });
    await s1.getByRole('button', { name: 'Send request' }).click(); await s1.waitForSelector('text=Request sent to the lab desk');
    check('student inside the lab requests equipment', true);
    const tctx = await browser.newContext(desktop), t = await page(tctx, 'staff@karunya.edu', 'staff');
    await t.waitForSelector('text=Equipment requests'); await t.waitForTimeout(600); await shot(t, '12-staff-desk');
    await t.locator('section', { hasText: 'Equipment requests' }).getByRole('button', { name: 'Issue' }).first().click();
    await t.waitForSelector('text=Filling a request');
    await t.getByLabel('Search equipment to add').fill('ESP'); await t.getByRole('button', { name: /ESP32 DevKit/ }).first().click();
    await shot(t, '13-staff-issue'); await t.getByRole('button', { name: 'Issue items' }).click(); await t.waitForSelector('text=Issued.');
    check('staff issues the requested item and the request closes', w.call('student1@karunya.edu', 'equipment.mine', {}).data.requests[0].status === 'fulfilled');
    await t.getByRole('tab', { name: 'Return' }).click(); await t.getByRole('button', { name: /Aarav/ }).click();
    await t.getByRole('button', { name: 'All back' }).first().click(); await t.getByRole('button', { name: 'Record return' }).click(); await t.waitForSelector('text=Loan closed');
    check('staff records the return; the loan closes', w.call(w.staff, 'loans.list', { status: 'active' }).data.loans.length === 0);

    // ---------------- Version B: device QR at the GPU lab kiosk scanner, and a teacher phone opening the QR link
    setClock(IST(14, 1)); await tick();
    await s1.goto(base + '/?as=student1@karunya.edu'); await s1.waitForSelector('text=CSE302 Deep Learning Lab');
    await s1.locator('article', { hasText: 'CSE302' }).getByRole('button', { name: 'Show my QR' }).click();
    await s1.waitForSelector('.modal svg[aria-label="Attendance QR code"]'); await s1.waitForTimeout(600); await shot(s1, '09-student-device-qr');
    check('device QR is drawn and rotating', await s1.locator('.modal .progress').count() === 1);
    const make = (purpose) => s1.evaluate(async (purpose) => { const ses = (await LF.api('sessions.mine')).sessions.find((s) => /CSE302/.test(s.title)), k = await LF.device.load(); const ch = await LF.api('attend.challenge', { sessionId: ses.sessionId, purpose, credentialId: k.credentialId }); const ts = Math.round(LF.now()); return ch.token + '~' + ts + '~' + (await LF.device.sign(ch.token + '.' + ts)).signature; }, purpose);
    const code = await make('in');
    const k2 = await page(kctx, 'kiosk2@karunya.edu', 'kiosk-B');
    const kin = k2.getByLabel(/Scanner input/);
    await kin.waitFor(); await kin.fill(code); await kin.press('Enter');
    await k2.waitForSelector('.kiosk-flash.good'); await shot(k2, '10-kiosk-scanner-accepted');
    check('kiosk scanner accepts the device QR and names the student', /Aarav/.test(await k2.locator('.kiosk-flash').innerText()));
    await s1.waitForSelector('text=Recorded at', { timeout: 15000 });
    check('student phone notices the scan and confirms', true);
    await k2.waitForTimeout(5300); await kin.fill(code); await kin.press('Enter');
    await k2.waitForSelector('.kiosk-flash.bad');
    check('the same QR shown again is refused', /already used/i.test(await k2.locator('.kiosk-flash').innerText()), await k2.locator('.kiosk-flash').innerText());
    setClock(IST(14, 6));
    const outCode = await make('out');
    const f2ctx = await browser.newContext(mobile), f2 = await page(f2ctx, 'faculty2@karunya.edu', 'faculty2-phone', '&s=' + encodeURIComponent(outCode));
    await f2.waitForSelector('.result'); await f2.waitForTimeout(500); await shot(f2, '11-teacher-phone-scan');
    check('teacher phone opening the student QR link records the exit', /Checked out/.test(await f2.locator('.result').first().innerText()), await f2.locator('.result').first().innerText());
    const s5 = await page(sctx, 'student5@karunya.edu', 'student5', '&s=' + encodeURIComponent(await make('in')));
    await s5.waitForSelector('.result'); check('a student opening another student\'s QR link is refused', /teacher, lab staff/.test(await s5.locator('.result').first().innerText()));
    await s5.close();

    // ---------------- class representative and event coordinator see their pages
    const crp = await page(sctx, 'student2@karunya.edu', 'cr');
    await crp.waitForSelector('text=Today\'s lab sessions');
    check('the class representative gets the class rep page', await crp.getByRole('button', { name: 'More' }).count() + await crp.getByRole('button', { name: 'Class rep' }).count() >= 1);
    await crp.close();


    // ---------------- admin: every page renders without error; mobile layout; access control; labelled controls
    const actx = await browser.newContext(desktop), a = await page(actx, 'admin@karunya.edu', 'admin');
    await a.waitForSelector('text=Overview'); await a.waitForTimeout(600); await shot(a, '14-admin-overview');
    const nav = await a.locator('nav.sidebar button').allInnerTexts();
    for (const label of nav) {
      await a.locator('nav.sidebar button', { hasText: label }).first().click(); await a.waitForTimeout(450);
      check('admin page "' + label.trim() + '" loads', await a.locator('text=Could not load this').count() === 0);
      if (/Labs|Settings|Audit|Flags|Events/.test(label)) await shot(a, '15-admin-' + label.trim().toLowerCase().replace(/[^a-z]+/g, '-'));
    }
    await a.locator('nav.sidebar button', { hasText: 'Audit & system' }).click(); await a.getByRole('tab', { name: 'Quota usage' }).click(); await a.waitForSelector('text=Trigger runtime today'); await shot(a, '16-admin-quota');
    check('quota usage panel renders', true);
    const mctx = await browser.newContext(mobile), am = await page(mctx, 'admin@karunya.edu', 'admin-mobile');
    await am.waitForSelector('#main h1'); await am.waitForTimeout(500);
    check('no horizontal page scroll on a 390px phone (admin overview)', await am.evaluate(() => document.documentElement.scrollWidth <= 390));
    check('no horizontal page scroll on a 390px phone (student)', await s1.evaluate(() => document.documentElement.scrollWidth <= 390));
    const denied = await s1.evaluate(async () => { try { await LF.api('users.list'); return 'allowed'; } catch (e) { return e.code; } });
    check('student calling an admin action is denied by the server', denied === 'FORBIDDEN', denied);
    await a.locator('nav.sidebar button', { hasText: 'Overview' }).click(); await a.waitForTimeout(400);
    const unlabeled = await a.evaluate(() => Array.from(document.querySelectorAll('button,a,input,select,textarea')).filter((el) => !el.hidden && el.type !== 'hidden' && !(el.innerText || '').trim() && !el.getAttribute('aria-label') && !(el.labels && el.labels.length) && !el.getAttribute('title')).length);
    check('no unlabeled interactive controls on the admin page', unlabeled === 0, unlabeled + ' found');

    // ---------------- Test Lab pages
    const lctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } }), L = await lctx.newPage();
    L.on('pageerror', (e) => errors.push('lab pageerror: ' + e.message));
    for (const sec of ['overview', 'pipeline', 'scenarios', 'theme', 'data', 'stage']) {
      await L.goto(base + '/lab#' + sec); await L.waitForTimeout(sec === 'stage' ? 3500 : 900);
      check('Test Lab "' + sec + '" renders', await L.locator('main h1').count() === 1);
      await shot(L, '20-lab-' + sec);
    }
    await L.goto(base + '/lab#scenarios'); await L.waitForSelector('text=Attack: screenshot of a QR sent to a friend');
    await L.locator('.result', { hasText: 'Attack: screenshot of a QR sent to a friend' }).getByRole('button', { name: 'Run' }).click();
    await L.waitForSelector('.result.ok'); check('a scenario runs from the Test Lab', true);
  } catch (e) {
    check('e2e flow completed without exception', false, e.message.split('\n')[0]);
    console.error(e);
  }
  check('no browser console errors or uncaught exceptions', errors.length === 0, errors.slice(0, 5).join(' | '));
  await browser.close(); dev.server.close();
  fs.writeFileSync(path.join(__dirname, '..', '..', '.build', 'e2e-results.json'), JSON.stringify({ ran: new Date().toISOString(), results }, null, 1));
  console.log('\n' + results.filter((r) => r.ok).length + ' passed, ' + failures + ' failed. Screenshots: ' + SHOTS);
  process.exit(failures ? 1 : 0);
})();
