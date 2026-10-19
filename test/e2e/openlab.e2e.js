#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright-core');
const { start } = require('../../dev/server');

(async () => {
  const dev = await start(0, { preset: 'small' });
  const base = dev.base.replace(/\/$/, ''), w = dev.lab.w;
  let browser, student, admin, passed = 0;
  const errors = [];
  const check = (name, condition) => { assert.ok(condition, name); passed++; console.log('PASS ' + name); };
  const email = 'walkin.browser@karunya.edu';
  const setTime = (time, date = w.today) => { dev.lab.clock.set(w.eval(`U.fromLocal(${JSON.stringify(date)},${JSON.stringify(time)})`)); dev.lab.sync(); };
  const storedLab = () => w.eval(`Db.get('Labs',${JSON.stringify(w.lab.labId)})`);
  const labRow = () => admin.getByRole('row').filter({ hasText: w.lab.code });
  async function scan() {
    await student.evaluate((code) => LF.kioskCheckin(code), w.kioskCode());
    const dialog = student.getByRole('dialog', { name: 'Lab check-in', exact: true });
    await dialog.getByRole('button', { name: /Send location/ }).waitFor();
    return dialog;
  }
  try {
    dev.lab.autoJobs = false; // deliberately test arrival opening and the entry gate with delayed triggers
    w.ok(w.admin, 'students.import', { rows: [{ rollNo: 'SOPEN001', name: 'Browser Walk-in', email }] });
    const profile = w.ok(email, 'onboard', { rollNo: 'SOPEN001', name: 'Browser Walk-in', consent: true, mobile: '9876543222' }).student;
    browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chrome' });
    student = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    admin = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    for (const page of [student, admin]) page.on('pageerror', (e) => errors.push(e.message));
    await admin.goto(base + '/?as=' + w.admin);
    await admin.waitForFunction(() => window.LF && LF.me && LF.role);
    await admin.evaluate(() => LF.go('labs'));
    await labRow().getByRole('button', { name: 'Edit', exact: true }).click();
    let editor = admin.getByRole('dialog', { name: 'Edit ' + w.lab.name, exact: true });
    check('open-lab walk-ins are an explicit opt-in in the lab editor', !await editor.getByLabel('Allow open-lab walk-ins', { exact: true }).isChecked());
    await editor.getByLabel('Allow open-lab walk-ins', { exact: true }).check();
    await editor.getByLabel('Opens', { exact: true }).fill('');
    await editor.getByLabel('Closes', { exact: true }).fill('');
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await editor.getByRole('alert').filter({ hasText: 'Set opening and closing times' }).waitFor();
    check('enabling open lab without hours gives an inline error and saves nothing', !storedLab().openLab);
    await editor.getByLabel('Opens', { exact: true }).fill('08:00');
    await editor.getByLabel('Closes', { exact: true }).fill('19:00');
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await labRow().getByText('Walk-ins enabled', { exact: true }).waitFor();
    check('the admin setting persists and the labs table shows walk-in availability', storedLab().openLab === true);
    await labRow().getByRole('button', { name: 'Edit', exact: true }).click();
    editor = admin.getByRole('dialog');
    check('reopening lab settings preserves the saved walk-in flag', await editor.getByLabel('Allow open-lab walk-ins', { exact: true }).isChecked());
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click();

    setTime('15:00');
    await student.goto(base + '/?as=' + email);
    const visit = student.getByRole('article', { name: 'Open lab', exact: true });
    await visit.getByText('Walk in during opening hours; no advance booking needed.', { exact: true }).waitFor();
    check('a student without a roster or booking sees the daily open-lab session', w.eval(`Db.whereEq('Rosters',{studentId:${JSON.stringify(profile.studentId)}}).length`) === 0 &&
      w.ok(email, 'booking.mine').reservations.length === 0);
    check('student Today fits a 390px phone with open lab enabled', await student.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    let dialog = await scan();
    check('the check-in picker explains open lab as a walk-in visit', await dialog.getByText(/Walk-in open lab/).count() === 1);
    const choice = await dialog.locator('input[name="kc-ses"]:checked').getAttribute('value');
    check('the open-lab session is preselected for a walk-in without class eligibility', w.eval(`Db.get('Sessions',${JSON.stringify(choice)}).type`) === 'openlab');
    await dialog.getByRole('button', { name: /Send location/ }).click();
    await dialog.getByText('Location check passed.', { exact: true }).waitFor();
    const events = () => w.eval(`Db.whereEq('AttendanceEvents',{studentId:${JSON.stringify(profile.studentId)}})`);
    check('QR and GPS check-in records an openlab entry', events().some((e) => e.type === 'IN' && e.entryReason === 'openlab' && e.geofence === 'pass'));
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await visit.getByText(/Verified/).waitFor();
    fs.mkdirSync('.build/shots', { recursive: true });
    await student.screenshot({ path: '.build/shots/openlab-mobile.png', fullPage: true });
    check('the live count includes the walk-in student', w.ok(email, 'labs.occupancy').labs.find((l) => l.labId === w.lab.labId).inside >= 1);

    setTime('16:00');
    dialog = await scan();
    await dialog.getByRole('button', { name: /Send location/ }).click();
    await dialog.getByText('Location check passed.', { exact: true }).waitFor();
    check('a later QR scan records departure from the open-lab session', events().some((e) => e.type === 'OUT'));
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();

    setTime('18:59');
    dialog = await scan();
    setTime('19:00');
    await dialog.getByRole('button', { name: /Send location/ }).click();
    await dialog.getByText('Open lab is available only during its enabled opening hours.', { exact: true }).waitFor();
    check('a pass opened before closing cannot admit a student at closing time', events().filter((e) => e.type === 'IN').length === 1);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await student.reload();
    await student.waitForFunction(() => { const main = document.querySelector('#main'); return main && (main.querySelector('article') || main.textContent.includes('No lab sessions today')); });
    check('open lab disappears from Today outside opening hours', await student.getByRole('article', { name: 'Open lab', exact: true }).count() === 0);

    await labRow().getByRole('button', { name: 'Edit', exact: true }).click();
    editor = admin.getByRole('dialog');
    await editor.getByLabel('Allow open-lab walk-ins', { exact: true }).uncheck();
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await labRow().getByText('Off', { exact: true }).waitFor();
    check('walk-ins can be disabled through the same settings screen', storedLab().openLab === false);
    check('open-lab screens produce no uncaught browser errors', errors.length === 0);
    console.log('\n' + passed + ' open-lab checks passed.');
  } catch (e) {
    fs.mkdirSync('.build/shots', { recursive: true });
    for (const [name, page] of [['student', student], ['admin', admin]]) if (page && !page.isClosed()) {
      await page.screenshot({ path: '.build/shots/openlab-' + name + '-failure.png', fullPage: true });
      console.error(name + ': ' + await page.locator('body').innerText());
    }
    throw e;
  } finally { if (browser) await browser.close(); dev.server.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
