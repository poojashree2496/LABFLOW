#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright-core');
const { start } = require('../../dev/server');
(async () => {
  const dev = await start(0, { preset: 'small' }), w = dev.lab.w;
  let browser, admin, staff, passed = 0;
  const errors = [], check = (name, ok) => { assert.ok(ok, name); passed++; console.log('PASS ' + name); };
  const rollNo = 'RDESK001', first = 'desk.first@karunya.edu', second = 'desk.second@karunya.edu', third = 'desk.third@karunya.edu';
  const onboard = (email) => w.ok(email, 'onboard', { rollNo, name: 'Desk Recovery', consent: true, mobile: '9876543210' }).student;
  let profile;
  const stored = () => w.eval(`Db.get('StudentProfiles',${JSON.stringify(profile.studentId)})`);
  const row = () => admin.getByRole('row').filter({ hasText: rollNo });
  async function students() {
    await admin.evaluate(() => LF.go('users'));
    await admin.getByRole('tab', { name: 'Students', exact: true }).click();
    await row().waitFor();
  }
  async function unlinkDialog() {
    await row().getByRole('button', { name: 'Open', exact: true }).click();
    await admin.getByRole('button', { name: 'Unlink account (wrong account claimed this profile)', exact: true }).click();
    const d = admin.getByRole('dialog', { name: 'Unlink ' + rollNo, exact: true });
    await d.getByLabel('Reason *', { exact: true }).fill('ID checked at the lab desk');
    return d;
  }
  try {
    dev.lab.autoJobs = false; profile = onboard(first);
    browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chrome' });
    admin = await browser.newPage({ viewport: { width: 390, height: 844 } }); staff = await browser.newPage();
    for (const p of [admin, staff]) p.on('pageerror', (e) => errors.push(e.message));
    await admin.goto(dev.base + '?as=' + w.admin); await admin.waitForFunction(() => window.LF && LF.role);
    await students(); await row().getByRole('button', { name: 'Verify', exact: true }).waitFor();
    w.ok(w.admin, 'students.unlink', { studentId: profile.studentId, reason: 'Reclaim before stale review' }); onboard(second);
    await row().getByRole('button', { name: 'Verify', exact: true }).click();
    await admin.getByText('The account linked to this profile changed. Refresh the student list and review it again.', { exact: true }).waitFor();
    check('stale verification visibly asks the reviewer to refresh', stored().email === second && stored().status === 'verified');
    await students(); const stale = await unlinkDialog();
    w.ok(w.admin, 'students.unlink', { studentId: profile.studentId, reason: 'New claim before stale unlink' }); onboard(third);
    await stale.getByRole('button', { name: 'Unlink', exact: true }).click();
    await stale.getByRole('alert').filter({ hasText: 'account linked to this profile changed' }).waitFor();
    check('stale unlink is refused inline without detaching the new account', stored().email === third);
    check('a refused unlink can be cancelled and reviewed again', await stale.getByRole('button', { name: 'Unlink', exact: true }).isEnabled());
    await stale.getByRole('button', { name: 'Cancel', exact: true }).click();
    const student = { ...profile, email: third }; await w.registerDevice(student); await w.registerDevice(student);
    await students(); const current = await unlinkDialog();
    check('unlink review fits a phone', await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await current.getByRole('button', { name: 'Unlink', exact: true }).click(); await current.waitFor({ state: 'hidden' });
    check('fresh unlink returns the profile to the import pool', stored().status === 'imported' && !stored().userId);
    check('fresh unlink revokes active and pending phones', w.ok(w.admin, 'cred.list', { studentId: profile.studentId }).credentials.every((c) => c.status === 'revoked'));
    check('old account cannot register against the detached profile', w.err(third, 'cred.begin').code === 'NOT_ONBOARDED');
    const claimed = onboard(first); check('the correct account can reclaim the same profile', claimed.studentId === profile.studentId && claimed.status === 'verified');
    await staff.goto(dev.base + '?as=' + w.staff); await staff.waitForFunction(() => window.LF && LF.role);
    await staff.evaluate((s) => LF.showStudent(s), { ...claimed, email: first });
    await staff.getByRole('dialog').getByRole('heading', { name: 'Devices', exact: true }).waitFor();
    check('coordinators cannot see the super-admin unlink control', await staff.getByRole('button', { name: /Unlink account/ }).count() === 0);
    check('recovery screens have no uncaught browser errors', errors.length === 0);
    console.log('\n' + passed + ' recovery browser checks passed.');
  } catch (e) {
    if (admin) { fs.mkdirSync('.build/shots', { recursive: true }); await admin.screenshot({ path: '.build/shots/recovery-failure.png', fullPage: true }); console.error(await admin.locator('body').innerText()); }
    throw e;
  } finally { if (browser) await browser.close(); dev.server.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
