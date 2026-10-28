#!/usr/bin/env node
// Real UI/server code, isolated Chromium profiles and in-memory Google services.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright-core');
const { start } = require('../../dev/server');

(async () => {
  const dev = await start(0, { preset: 'small' }), w = dev.lab.w;
  let browser, faculty, student, kiosk, claim, passed = 0;
  const errors = [], check = (name, ok) => { assert.ok(ok, name); passed++; console.log('PASS ' + name); };
  const email = 'workflow.student@karunya.edu', absent = 'workflow.absent@karunya.edu';
  const advance = (ms) => { dev.lab.clock.set(w.eval('U.now()') + ms); dev.lab.sync(); };
  const login = async (page, who) => { await page.goto(dev.base + '?as=' + who); await page.waitForFunction(() => window.LF && LF.me); };
  const today = async () => { await student.evaluate(() => LF.go('today')); };
  const card = (page, title) => page.getByRole('article', { name: title, exact: true });
  async function kioskScan(action, title) {
    await student.evaluate((code) => LF.kioskCheckin(code), w.kioskCode());
    const dialog = student.getByRole('dialog', { name: 'Lab check-in', exact: true });
    await dialog.getByRole('button', { name: /Send location/ }).waitFor();
    if (action === 'in') await dialog.getByRole('radio', { name: new RegExp(title) }).check();
    await dialog.getByRole('button', { name: /Send location/ }).click();
    await dialog.getByRole('button', { name: 'Done', exact: true }).waitFor();
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  }
  async function open(mode, random = false) {
    w.ok(w.admin, 'settings.set', { values: { rescanMode: random ? 'random' : 'off' } });
    const s = w.ok(w.faculty, 'sessions.create', { type: 'event', labId: w.lab.labId, title: 'Workflow ' + mode,
      date: w.today, startTime: '10:00', endTime: '12:00', openToAll: true }).session;
    await faculty.evaluate(() => LF.go('today'));
    await card(faculty, s.title).getByRole('button', { name: 'Open session', exact: true }).click();
    const dialog = faculty.getByRole('dialog', { name: 'Open ' + s.title, exact: true });
    check(mode + ' opening defaults to kiosk QR without changing lab capabilities', await dialog.getByLabel('How students check in').inputValue() === 'A');
    await dialog.getByLabel('How students check in').selectOption(mode);
    await dialog.getByRole('button', { name: 'Open session', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await today(); await card(student, s.title).waitFor();
    check(mode + ' selection is saved and returned to students', w.ok(email, 'sessions.mine').sessions.find((x) => x.sessionId === s.sessionId).labMode === mode);
    return s;
  }
  async function onboard(who, roll, name) {
    await login(claim, who);
    await claim.getByLabel('Roll number *', { exact: true }).fill(roll);
    await claim.getByLabel('Full name *', { exact: true }).fill(name);
    await claim.getByLabel('Mobile number *', { exact: true }).fill('9876543210');
    await claim.getByLabel('I have read the privacy notice', { exact: true }).check();
    await claim.getByRole('button', { name: 'Create my profile', exact: true }).click();
  }
  async function signedQr(page, sessionId, purpose) {
    return page.evaluate(async ({ sessionId, purpose }) => {
      const k = await LF.device.load(), ch = await LF.api('attend.challenge', { sessionId, purpose, credentialId: k.credentialId });
      const ts = Math.round(LF.now()); return ch.token + '~' + ts + '~' + (await LF.device.sign(ch.token + '.' + ts)).signature;
    }, { sessionId, purpose });
  }
  async function submitQr(qr, label) {
    const input = kiosk.getByLabel(/Scanner input/); await input.fill(qr); await input.press('Enter');
    await kiosk.locator('.kiosk-flash.good').getByText(label, { exact: true }).waitFor();
  }
  try {
    dev.lab.autoJobs = false;
    const lab = w.eval(`Db.get('Labs',${JSON.stringify(w.lab.labId)})`);
    w.ok(w.admin, 'labs.upsert', { ...lab, checkinMode: 'AB' });
    for (const s of w.ok(w.faculty, 'sessions.day', { date: w.today }).sessions.filter((s) => s.labId === w.lab.labId && s.status === 'open')) {
      w.ok(w.faculty, 'sessions.close', { sessionId: s.sessionId });
    }
    w.ok(w.admin, 'students.import', { rows: [
      { rollNo: 'SFLOW01', name: 'Workflow Student', email }, { rollNo: 'SFLOW02', name: 'Workflow Absent', email: absent },
      { rollNo: 'SCLAIM01', name: 'Intended Claim', email: 'intended.claim@karunya.edu' },
      { rollNo: 'SCLAIM02', name: 'First Claim' }, { rollNo: 'SCLAIM03', name: 'Desk Claim' }
    ] });
    const s = w.ok(email, 'onboard', { rollNo: 'SFLOW01', name: 'Workflow Student', consent: true, mobile: '9876543210' }).student;
    const a = w.ok(absent, 'onboard', { rollNo: 'SFLOW02', name: 'Workflow Absent', consent: true, mobile: '9876543211' }).student;
    browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chrome' });
    faculty = await browser.newPage({ viewport: { width: 1280, height: 850 } });
    student = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    kiosk = await browser.newPage(); claim = await browser.newPage({ viewport: { width: 390, height: 844 } });
    for (const p of [faculty, student, kiosk, claim]) p.on('pageerror', (e) => errors.push(e.message));
    await login(faculty, w.faculty); await login(student, email); await login(kiosk, w.kioskEmail);

    const sa = await open('A');
    check('A offers lab scanning and hides student QR', await card(student, sa.title).getByRole('button', { name: 'Scan the lab screen', exact: true }).count() === 1 && await card(student, sa.title).getByRole('button', { name: 'Show my QR', exact: true }).count() === 0);
    check('A hides faculty device scanning', await card(faculty, sa.title).getByRole('button', { name: 'Scan students', exact: true }).count() === 0);
    await kioskScan('in', sa.title);
    check('A entry through the location form records an IN', w.ok(email, 'sessions.mine').sessions.find((x) => x.sessionId === sa.sessionId).mine.state === 'in');
    assert.equal(w.checkin({ ...a, email: absent }, { sessionId: sa.sessionId }).ok, true);
    advance(5 * 60000);
    await faculty.evaluate((id) => { LF.sel.sessionId = id; LF.go('live'); }, sa.sessionId);
    await faculty.getByRole('button', { name: 'Presence check now', exact: true }).click();
    await faculty.getByText('Presence check running.', { exact: true }).waitFor();
    await today(); await card(student, sa.title).getByText('Presence check.', { exact: true }).waitFor();
    check('faculty-triggered rescan reaches the student in mode A', true);
    await card(student, sa.title).getByRole('button', { name: "I'm here: confirm my location", exact: true }).click();
    await student.getByText('Presence confirmed', { exact: true }).first().waitFor();
    check('A presence check is one location reading, no QR', w.ok(email, 'sessions.mine').sessions.find((x) => x.sessionId === sa.sessionId).mine.rescan.done === true);
    check('answering the rescan appends RESCAN', w.eval(`Db.whereEq('AttendanceEvents',{sessionId:${JSON.stringify(sa.sessionId)},studentId:${JSON.stringify(s.studentId)}}).some(function(e){return e.type==='RESCAN';})`));
    advance(91000); w.eval('Attend.tickRescans()');
    const roster = w.ok(w.faculty, 'attend.roster', { sessionId: sa.sessionId }).roster;
    check('missed rescan is flagged and does not gain the whole session', roster.find((x) => x.studentId === a.studentId).status === 'missed_rescan' && roster.find((x) => x.studentId === a.studentId).verifiedMinutes === 0);
    check('answered rescan retains verified time', roster.find((x) => x.studentId === s.studentId).verifiedMinutes >= 5);
    advance(30000); // the accidental-double-scan guard also applies after a rescan
    await kioskScan('out', sa.title);
    check('A exit records OUT', w.ok(email, 'sessions.mine').sessions.find((x) => x.sessionId === sa.sessionId).mine.state === 'out');
    w.ok(w.faculty, 'sessions.close', { sessionId: sa.sessionId });

    const sb = await open('B');
    check('B offers student QR and hides lab scanning', await card(student, sb.title).getByRole('button', { name: 'Show my QR', exact: true }).count() === 1 && await card(student, sb.title).getByRole('button', { name: 'Scan the lab screen', exact: true }).count() === 0);
    check('B offers faculty scanning', await card(faculty, sb.title).getByRole('button', { name: 'Scan students', exact: true }).count() === 1);
    await student.evaluate(() => LF.go('device'));
    await student.getByRole('button', { name: 'Register this phone', exact: true }).click();
    await student.getByText('Device registered', { exact: true }).waitFor();
    await today(); await card(student, sb.title).getByRole('button', { name: 'Show my QR', exact: true }).click();
    await student.getByRole('dialog').locator('svg[aria-label="Attendance QR code"]').waitFor();
    check('B draws a QR using the browser registered key', true);
    await submitQr(await signedQr(student, sb.sessionId, 'in'), 'Checked in');
    check('kiosk accepts a genuine browser-signed B QR', w.ok(email, 'sessions.mine').sessions.find((x) => x.sessionId === sb.sessionId).mine.state === 'in');
    await student.getByRole('dialog').waitFor({ state: 'hidden' });
    advance(8000); // a new kiosk rotation after the previous session's A exit
    const op = w.ok(email, 'checkin.open', { code: w.kioskCode() });
    check('kiosk QR does not advertise an unsupported B exit', op.inside === null && !op.actions.includes('out'));
    advance(5 * 60000);
    await faculty.evaluate((id) => { LF.sel.sessionId = id; LF.go('live'); }, sb.sessionId);
    await faculty.getByRole('button', { name: 'Presence check now', exact: true }).click();
    await faculty.getByText('Presence check running.', { exact: true }).waitFor();
    await today(); await card(student, sb.title).getByRole('button', { name: "I'm here: confirm my location", exact: true }).click();
    await student.getByText('Presence confirmed', { exact: true }).first().waitFor();
    check('B presence check is the same location confirmation, no QR', await card(student, sb.title).getByRole('button', { name: 'Confirm presence (QR)', exact: true }).count() === 0);
    check('B presence check credits the confirmed interval', w.ok(w.faculty, 'attend.roster', { sessionId: sb.sessionId }).roster.find((x) => x.studentId === s.studentId).verifiedMinutes >= 5);
    advance(121000);
    await submitQr(await signedQr(student, sb.sessionId, 'out'), 'Checked out');
    check('B exit through the scanner records OUT', w.ok(email, 'sessions.mine').sessions.find((x) => x.sessionId === sb.sessionId).mine.state === 'out');
    w.ok(w.faculty, 'sessions.close', { sessionId: sb.sessionId });

    const both = await open('AB', true);
    check('AB offers both entry methods', await card(student, both.title).getByRole('button', { name: 'Show my QR', exact: true }).count() === 1 && await card(student, both.title).getByRole('button', { name: 'Scan the lab screen', exact: true }).count() === 1);
    check('opening from the UI preserves configured random rescans', w.ok(w.faculty, 'sessions.get', { sessionId: both.sessionId }).session.rescanMode === 'random' && w.ok(w.faculty, 'sessions.get', { sessionId: both.sessionId }).session.nextRescanAt > w.eval('U.now()'));
    check('student workflow fits a phone', await student.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await kioskScan('in', both.title);
    check('AB accepts the location-based entry', w.ok(email, 'sessions.mine').sessions.find((x) => x.sessionId === both.sessionId).mine.state === 'in');
    await login(claim, absent); await claim.evaluate(() => LF.go('device'));
    await claim.getByRole('button', { name: 'Register this phone', exact: true }).click();
    await claim.getByText('Device registered', { exact: true }).waitFor();
    await submitQr(await signedQr(claim, both.sessionId, 'in'), 'Checked in');
    check('AB also accepts a different student through device QR', w.ok(absent, 'sessions.mine').sessions.find((x) => x.sessionId === both.sessionId).mine.state === 'in');

    await onboard('wrong.claim@karunya.edu', 'SCLAIM01', 'Wrong Claim');
    await claim.getByRole('alert').filter({ hasText: 'different university email' }).waitFor();
    check('wrong-email onboarding shows a recoverable inline error', await claim.getByRole('button', { name: 'Create my profile', exact: true }).isEnabled());
    check('wrong-email refusal leaves imported profile unclaimed', !w.eval("Db.getBy('StudentProfiles','rollNo','SCLAIM01').userId"));
    await onboard('intended.claim@karunya.edu', 'SCLAIM01', 'Intended Claim');
    await claim.waitForFunction(() => LF.me && LF.me.student && LF.me.student.status === 'verified');
    check('the intended email can claim and is verified', true);
    await onboard('first.claim@karunya.edu', 'SCLAIM02', 'First Claim');
    await claim.waitForFunction(() => LF.me && LF.me.student && LF.me.student.status === 'verified');
    check('first claim without imported email uses automatic verification', true);
    await onboard('second.claim@karunya.edu', 'SCLAIM02', 'Second Claim');
    await claim.getByRole('alert').filter({ hasText: 'already linked' }).waitFor();
    check('a second claim is refused visibly without creating an account', w.eval("Db.getBy('Users','email','second.claim@karunya.edu')") === null);
    w.ok(w.admin, 'settings.set', { values: { studentAutoVerify: false } });
    await onboard('desk.claim@karunya.edu', 'SCLAIM03', 'Desk Claim');
    await claim.getByText('Waiting for verification', { exact: true }).waitFor();
    check('turning automatic verification off sends the claim to the desk', w.ok('desk.claim@karunya.edu', 'me').student.status === 'pending');
    check('pending claims cannot check in', w.err('desk.claim@karunya.edu', 'checkin.open', { code: w.kioskCode() }).code === 'NOT_VERIFIED');
    check('onboarding and verification screens fit a phone', await claim.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    check('no uncaught browser errors', errors.length === 0);
    console.log('\n' + passed + ' session workflow checks passed.');
  } catch (e) {
    fs.mkdirSync('.build/shots', { recursive: true });
    for (const [name, page] of [['faculty', faculty], ['student', student], ['claim', claim]]) if (page && !page.isClosed()) {
      await page.screenshot({ path: '.build/shots/session-workflow-' + name + '-failure.png', fullPage: true });
      console.error(name + ': ' + await page.locator('body').innerText());
    }
    throw e;
  } finally { if (browser) await browser.close(); dev.server.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
