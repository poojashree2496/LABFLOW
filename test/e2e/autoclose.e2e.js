#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright-core');
const { start } = require('../../dev/server');

(async () => {
  const dev = await start(0, { preset: 'small' }), w = dev.lab.w;
  let browser, page, passed = 0;
  const errors = [], email = 'closing.browser@karunya.edu';
  const check = (name, condition) => { assert.ok(condition, name); passed++; console.log('PASS ' + name); };
  const setTime = (time) => { dev.lab.clock.set(w.eval(`U.fromLocal('${w.today}','${time}')`)); dev.lab.sync(); };
  try {
    dev.lab.autoJobs = false;
    w.ok(w.admin, 'labs.upsert', { ...w.lab, openLab: true });
    w.ok(w.admin, 'students.import', { rows: [{ rollNo: 'SCLOSE001', name: 'Closing Browser', email }] });
    const student = w.ok(email, 'onboard', { rollNo: 'SCLOSE001', name: 'Closing Browser', consent: true, mobile: '9876543222' }).student;
    w.ok(email, 'projects.create', { title: 'Closing-time project', description: 'Browser closing test', labId: w.lab.labId,
      supervisorFacultyId: w.facultyId, startDate: w.today, endDate: '2026-12-01' });
    setTime('18:00');
    browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chrome' });
    page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(dev.base.replace(/\/$/, '') + '/?as=' + email);
    await page.getByRole('article', { name: 'Open lab', exact: true }).waitFor();
    await page.evaluate((code) => LF.kioskCheckin(code), w.kioskCode());
    const dialog = page.getByRole('dialog', { name: 'Lab check-in', exact: true });
    await dialog.getByRole('button', { name: /Send location/ }).click();
    await dialog.getByText('Location check passed.', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    const events = () => w.eval(`Db.whereEq('AttendanceEvents',{studentId:'${student.studentId}'})`);
    check('real QR/GPS entry reaches the backend before closing', events().filter((e) => e.type === 'IN').length === 1);
    check('no auto exit is written before closing', events().filter((e) => e.method === 'auto').length === 0);
    const sessionId = events()[0].sessionId;
    setTime('19:05');
    // This is the production job entry point on fakes, deliberately five minutes late.
    check('the session tick completes after the missed deadline', w.eval('Jobs.tickSessions()').status === 'ok');
    const out = events().filter((e) => e.method === 'auto');
    check('the delayed tick writes one automatic exit at 19:00', out.length === 1 && out[0].at === w.eval(`U.fromLocal('${w.today}','19:00')`));
    check('the actual append time records the trigger delay', out[0].createdAt === w.eval('U.now()'));
    await page.evaluate(() => LF.go('history'));
    const row = page.getByRole('row').filter({ hasText: 'Open lab' });
    await row.getByText('Auto sign-out', { exact: true }).waitFor();
    check('history distinguishes automatic departure', await row.getByText('Auto sign-out', { exact: true }).count() === 1);
    const history = w.ok(email, 'attend.history');
    check('history credits one hour up to closing', history.history.find((r) => r.sessionId === sessionId).verifiedMinutes === 60);
    check('the history total includes this automatic sign-out', history.totals.autoSignOuts === 1 && await page.getByText('Auto sign-outs', { exact: true }).count() === 1);
    check('the history table displays the credited hour', (await row.innerText()).includes('1h'));
    check('history fits a phone screen', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await row.getByRole('button', { name: 'Details', exact: true }).click();
    await page.getByRole('dialog').getByText('Automatically signed out at closing', { exact: true }).waitFor();
    check('event details explain why departure was recorded', await page.getByRole('dialog').getByText('Automatically signed out at closing', { exact: true }).count() === 1);
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
    fs.mkdirSync('.build/shots', { recursive: true });
    await page.screenshot({ path: '.build/shots/autoclose-mobile.png', fullPage: true });
    w.eval('Sessions.autoCloseStale()');
    check('repeated closure and history reads do not duplicate departures', events().filter((e) => e.type === 'OUT').length === 1);
    await page.evaluate(() => LF.go('today'));
    await page.waitForFunction(() => !document.querySelector('#main .skeleton'));
    check('Today removes the closed open lab', await page.getByRole('article', { name: 'Open lab', exact: true }).count() === 0);
    check('automatic departure releases the active project/system claim', !w.eval(`Work.occupants('${w.lab.labId}')`).some((r) => r.studentId === student.studentId));
    check('closing and history produce no uncaught browser errors', errors.length === 0);
    console.log('\n' + passed + ' automatic sign-out checks passed.');
  } catch (e) {
    if (page) { fs.mkdirSync('.build/shots', { recursive: true }); await page.screenshot({ path: '.build/shots/autoclose-failure.png', fullPage: true }); console.error(await page.locator('body').innerText()); }
    throw e;
  } finally { if (browser) await browser.close(); dev.server.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
