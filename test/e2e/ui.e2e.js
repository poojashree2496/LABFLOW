#!/usr/bin/env node
/**
 * Browser end-to-end check of the REAL UI against the REAL server code running on in-memory fakes (scripts/dev-server.js).
 * Run:  node test/e2e/ui.e2e.js        (needs Playwright + Chromium; not part of `npm test`)
 * It exercises genuine browser WebCrypto + IndexedDB for the device key, and the real server-side P-256 verification.
 * It does NOT prove behaviour inside Google's HtmlService iframe, Workspace identity, or Apps Script latency.
 */
const fs = require('fs');
const path = require('path');
let pw; try { pw = require('playwright'); } catch (e) { pw = require('/opt/npm-tools/node_modules/playwright'); }
const { start } = require('../../scripts/dev-server');

const SHOTS = path.join(__dirname, '..', '..', '.build', 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const results = []; let failures = 0;
function check(name, ok, detail) { results.push({ name, ok, detail }); if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok || !detail ? '' : '  -> ' + detail)); }

(async () => {
  const { server, w, sync } = await start(0, { students: 6 });
  const base = 'http://localhost:' + server.address().port;
  const browser = await pw.chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const errors = [];
  async function page(ctx, who, label) {
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(label + ' pageerror: ' + e.message));
    p.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_(NAME|INTERNET|CONNECTION|TUNNEL|PROXY)|Failed to load resource/.test(m.text())) errors.push(label + ' console: ' + m.text()); });
    await p.goto(base + '/?as=' + who);
    return p;
  }
  const shot = (p, name) => p.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: false });
  const mobile = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
  const desktop = { viewport: { width: 1280, height: 820 } };
  try {
    // ---------------- student on a phone: register device
    const sctx = await browser.newContext(mobile), s1 = await page(sctx, 'student1@karunya.edu', 'student');
    await s1.waitForSelector('text=Today\'s lab sessions'); await shot(s1, '01-student-today-mobile');
    check('student home renders with session list', await s1.locator('article').count() >= 1);
    await s1.getByRole('button', { name: 'Device' }).last().click();
    await s1.getByRole('button', { name: 'Register this phone' }).click();
    await s1.waitForSelector('text=Device registered');
    check('device registration through real WebCrypto + server P-256 verification', true);
    await s1.getByRole('button', { name: 'Run check' }).click();
    await s1.waitForSelector('text=Key storage (IndexedDB)'); await s1.waitForTimeout(400);
    const diagText = await s1.locator('section[aria-label="Compatibility check"]').innerText();
    check('compatibility check reports key storage OK', /Key storage \(IndexedDB\)[\s\S]*OK/.test(diagText), diagText.slice(0, 300));
    await shot(s1, '02-student-device-mobile');

    // ---------------- faculty opens the session (desktop UI)
    const fctx = await browser.newContext(desktop), f = await page(fctx, 'faculty@karunya.edu', 'faculty');
    await f.waitForSelector('text=Open session'); await shot(f, '03-faculty-today');
    await f.getByRole('button', { name: 'Open session' }).first().click();
    await f.getByRole('dialog').getByRole('button', { name: 'Open session' }).click();
    await f.waitForSelector('text=Session opened');
    check('faculty opens a session from the UI', true);

    // ---------------- student shows QR
    await s1.getByRole('button', { name: 'Today' }).last().click();
    await s1.getByRole('button', { name: 'Show check-in QR' }).click();
    await s1.waitForSelector('.modal svg[aria-label="Attendance QR code"]');
    await shot(s1, '04-student-qr-mobile');
    check('QR is rendered and counting down', /\d:\d\d/.test(await s1.locator('.modal .t-big').innerText()));
    // produce the exact string the phone would show, with the phone's own key (same code path as the screen)
    const code = await s1.evaluate(async () => { const sid = (await LF.api('sessions.mine')).sessions[0].sessionId, k = await LF.device.load(); const ch = await LF.api('attend.challenge', { sessionId: sid, purpose: 'in', credentialId: k.credentialId }); return ch.token + '~' + (await LF.device.sign(ch.token)).signature; });

    // ---------------- kiosk scans (keyboard-wedge style input)
    const kctx = await browser.newContext({ viewport: { width: 1024, height: 700 } }), k = await page(kctx, 'kiosk1@karunya.edu', 'kiosk');
    await k.waitForSelector('#k-input');
    await k.fill('#k-input', code); await k.press('#k-input', 'Enter');
    await k.waitForSelector('text=Checked in'); await shot(k, '05-kiosk-accepted');
    check('kiosk accepts a valid scan and names the student', /Student 1/.test(await k.locator('.kiosk-flash').innerText()));
    await s1.waitForSelector('text=Recorded at', { timeout: 15000 });
    check('student phone notices the scan and confirms', true);
    await k.waitForTimeout(5300);
    await k.fill('#k-input', code); await k.press('#k-input', 'Enter');
    await k.waitForSelector('text=Not accepted');
    check('replayed QR is refused at the kiosk', /already used/i.test(await k.locator('.kiosk-flash').innerText()), await k.locator('.kiosk-flash').innerText());
    await shot(k, '06-kiosk-replay-refused');

    // ---------------- faculty live roster
    await f.getByRole('button', { name: 'Live roster' }).first().click();
    await f.waitForSelector('text=Student 1'); await f.waitForTimeout(300);
    check('live roster shows the student inside', /Inside/.test(await f.locator('tr', { hasText: 'S001' }).innerText()));
    await shot(f, '07-faculty-live-roster');
    await f.getByRole('button', { name: 'Random spot check' }).click();
    await f.waitForSelector('text=Spot checks to complete'); await shot(f, '08-faculty-spot-check');
    check('spot check created and photo-less fallback shown', await f.locator('text=No photo on file').count() >= 1);
    await f.getByRole('button', { name: 'Not in room' }).first().click();
    await f.getByRole('dialog').locator('textarea').fill('not found in room');
    await f.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await f.waitForSelector('text=Recorded');

    // ---------------- student exit via real flow, then history
    const out = await s1.evaluate(async () => { const sid = (await LF.api('sessions.mine')).sessions[0].sessionId, k = await LF.device.load(); const ch = await LF.api('attend.challenge', { sessionId: sid, purpose: 'out', credentialId: k.credentialId }); return ch.token + '~' + (await LF.device.sign(ch.token)).signature; });
    await k.fill('#k-input', out); await k.press('#k-input', 'Enter'); await k.waitForSelector('text=Checked out');
    check('exit scan accepted', true);
    await s1.reload(); await s1.getByRole('button', { name: 'History' }).last().click(); await s1.waitForSelector('text=Attendance history');
    await s1.waitForSelector('table'); await shot(s1, '09-student-history-mobile');

    // ---------------- student books equipment ahead; staff approves; student asks for a research visit; supervisor approves
    await s1.getByRole('button', { name: 'Equipment' }).last().click();
    await s1.getByRole('tab', { name: 'Book in advance' }).click();
    await s1.getByLabel('Purpose').fill('IoT mini-project demo');
    await s1.getByRole('button', { name: 'Check availability' }).click();
    await s1.waitForSelector('text=free for that period');
    await s1.getByRole('button', { name: 'Request booking' }).click();
    await s1.waitForSelector('text=Booking requested');
    check('student requests an advance booking', w.call(w.staff, 'booking.list', { status: 'pending' }).data.reservations.length === 1);
    await s1.getByRole('tab', { name: 'My bookings' }).click(); await s1.waitForSelector('text=pending'); await shot(s1, '09b-student-bookings-mobile');
    await s1.getByRole('button', { name: 'Research' }).last().click();
    await s1.getByLabel('Purpose').fill('Sensor calibration');
    await s1.getByRole('button', { name: 'Send request' }).click(); await s1.waitForSelector('text=Request sent');
    await f.getByRole('button', { name: 'Plan' }).first().click(); await f.getByRole('tab', { name: 'Research requests' }).click();
    await f.waitForSelector('text=Sensor calibration'); await shot(f, '09c-faculty-research-approval');
    await f.getByRole('button', { name: 'Approve' }).first().click(); await f.waitForSelector('text=Approved');
    check('research visit request approved by the named supervisor', w.call(w.faculty, 'research.pending', {}).data.requests.length === 0);

    // ---------------- staff: issue + return through the UI
    const tctx = await browser.newContext(desktop), t = await page(tctx, 'staff@karunya.edu', 'staff');
    await t.waitForSelector('text=Lab desk'); await shot(t, '10-staff-desk');
    await t.getByRole('button', { name: 'Issue / Return' }).first().click();
    await t.waitForSelector('text=Issue to');
    await t.getByLabel('Student', { exact: true }).fill('S002'); await t.getByRole('button', { name: /S002/ }).click();
    await t.getByLabel('Search equipment to add').fill('ESP'); await t.getByRole('button', { name: /ESP32 DevKit/ }).first().click();
    await shot(t, '11-staff-issue');
    await t.getByRole('button', { name: 'Issue items' }).click();
    await t.waitForSelector('text=Issued.');
    check('staff issues equipment to a student', true);
    const dup = w.call(w.staff, 'loans.list', { status: 'active' }); check('loan recorded server-side', dup.ok && dup.data.loans.length === 1);
    await t.getByRole('tab', { name: 'Return' }).click();
    await t.getByRole('button', { name: /Student 2/ }).click();
    await t.getByRole('button', { name: 'All back' }).first().click();
    await shot(t, '12-staff-return');
    await t.getByRole('button', { name: 'Record return' }).click();
    await t.waitForSelector('text=Loan closed');
    check('staff returns equipment; loan closes', w.call(w.staff, 'loans.list', { status: 'active' }).data.loans.length === 0);
    await t.getByRole('button', { name: 'Bookings' }).first().click(); await t.waitForSelector('text=IoT mini-project demo');
    await t.getByRole('button', { name: 'Approve' }).first().click(); await t.locator('.toast', { hasText: 'Approved' }).waitFor();
    check('staff approves the booking', w.call(w.staff, 'booking.list', { status: 'approved' }).data.reservations.length === 1);
    await t.getByRole('button', { name: 'Inventory' }).first().click(); await t.waitForSelector('table'); await shot(t, '13-staff-inventory');

    // ---------------- admin: every page renders without error
    const actx = await browser.newContext(desktop), a = await page(actx, 'admin@karunya.edu', 'admin');
    await a.waitForSelector('text=Overview'); await a.waitForTimeout(500); await shot(a, '14-admin-overview');
    const nav = await a.locator('nav.sidebar button').allInnerTexts();
    for (const label of nav) {
      await a.locator('nav.sidebar button', { hasText: label }).first().click(); await a.waitForTimeout(450);
      const bad = await a.locator('text=Could not load this').count();
      check('admin page "' + label.trim() + '" loads', bad === 0);
      if (/People|Academics|Settings|Audit/.test(label)) await shot(a, '15-admin-' + label.trim().toLowerCase().replace(/[^a-z]+/g, '-'));
    }
    const mctx = await browser.newContext(mobile), am = await page(mctx, 'admin@karunya.edu', 'admin-mobile');
    await am.waitForSelector('#main h1'); await am.waitForTimeout(500); await shot(am, '16-admin-overview-mobile');
    const sw = await am.evaluate(() => document.documentElement.scrollWidth <= 390);
    check('no horizontal page scroll on a 390px phone (admin overview)', sw);
    const sw2 = await s1.evaluate(() => document.documentElement.scrollWidth <= 390);
    check('no horizontal page scroll on a 390px phone (student history)', sw2);

    // ---------------- cross-user denial through the UI transport
    const denied = await s1.evaluate(async () => { try { await LF.api('users.list'); return 'allowed'; } catch (e) { return e.code; } });
    check('student calling an admin action is denied by the server', denied === 'FORBIDDEN', denied);

    // ---------------- unlabeled controls
    const unlabeled = await a.evaluate(() => Array.from(document.querySelectorAll('button,a,input,select,textarea')).filter((el) => !el.hidden && el.type !== 'hidden' && !(el.innerText || '').trim() && !el.getAttribute('aria-label') && !(el.labels && el.labels.length) && !el.getAttribute('title')).length);
    check('no unlabeled interactive controls on the admin page', unlabeled === 0, unlabeled + ' found');
  } catch (e) {
    check('e2e flow completed without exception', false, e.message.split('\n')[0]);
    console.error(e);
  }
  check('no browser console errors or uncaught exceptions', errors.length === 0, errors.slice(0, 5).join(' | '));
  await browser.close(); server.close();
  fs.writeFileSync(path.join(__dirname, '..', '..', '.build', 'e2e-results.json'), JSON.stringify({ ran: new Date().toISOString(), results }, null, 1));
  console.log('\n' + results.filter((r) => r.ok).length + ' passed, ' + failures + ' failed. Screenshots: ' + SHOTS);
  process.exit(failures ? 1 : 0);
})();
