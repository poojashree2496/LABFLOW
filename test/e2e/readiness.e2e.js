#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright-core');
const { start } = require('../../dev/server');
(async () => {
  const dev = await start(0, { preset: 'small' }), w = dev.lab.w;
  let browser, admin, passed = 0;
  const errors = [], check = (name, ok) => { assert.ok(ok, name); passed++; console.log('PASS ' + name); };
  const panel = () => admin.getByRole('region', { name: 'Lab readiness', exact: true });
  const lab = () => panel().getByRole('region', { name: w.lab.code + ' setup', exact: true });
  const item = (label) => lab().getByRole('listitem').filter({ hasText: label });
  const global = () => panel().getByRole('region', { name: 'Shared setup checks', exact: true });
  const refresh = async () => { const done = admin.waitForResponse((r) => r.url().endsWith('/rpc') && r.request().postDataJSON().action === 'system.status'); await panel().getByRole('button', { name: 'Refresh setup checks', exact: true }).click(); await done; };
  async function health() {
    await admin.evaluate(() => LF.go('audit'));
    await admin.getByRole('tab', { name: 'System health', exact: true }).click();
    await panel().getByRole('heading', { name: 'Lab readiness', exact: true }).waitFor();
  }
  try {
    dev.lab.autoJobs = false;
    const old = w.eval(`Db.get('Labs',${JSON.stringify(w.lab.labId)})`);
    w.ok(w.admin, 'labs.upsert', { ...old, latitude: null, longitude: null, openTime: '', closeTime: '', openLab: false });
    w.e.run(`Db.whereEq('Kiosks',{labId:${JSON.stringify(w.lab.labId)}}).forEach(function(k){Db.update('Kiosks',k.kioskId,{lastSeenAt:null});});`);
    browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chrome' });
    admin = await browser.newPage({ viewport: { width: 390, height: 844 } }); admin.on('pageerror', (e) => errors.push(e.message));
    await admin.goto(dev.base + '?as=' + w.admin); await admin.waitForFunction(() => window.LF && LF.role);
    await health();
    check('system health exposes lab readiness', await panel().isVisible());
    check('saved settings are not presented as a successful physical check-in', await panel().getByText(/Confirm cameras, location and a real check-in in the room/).count() === 1);
    check('missing door GPS needs attention', (await item('Door GPS').innerText()).includes('Needs attention'));
    check('disabled walk-ins do not imply invalid opening hours', (await item('Opening hours').innerText()).includes('Not required') && (await item('Walk-in access').innerText()).includes('Walk-ins are off'));
    check('a kiosk that has never signed in needs attention', (await item('Door kiosk').innerText()).includes('Needs attention'));
    check('no backup copy is distinguished from a backup folder', (await global().getByRole('listitem').filter({ hasText: 'Recent backup' }).innerText()).includes('No backup copy found'));
    check('device-only labs do not require GPS', (await panel().getByRole('region', { name: w.lab2.code + ' setup', exact: true }).getByRole('listitem').filter({ hasText: 'Door GPS' }).innerText()).includes('Not required'));
    await lab().getByRole('button', { name: 'Labs and kiosks', exact: true }).click();
    await admin.getByRole('tab', { name: 'Scan kiosks', exact: true }).waitFor();
    check('setup actions navigate to the existing lab editor', await admin.getByRole('tab', { name: 'Scan kiosks', exact: true }).count() === 1);
    await health();
    w.ok(w.admin, 'labs.upsert', { ...old, openLab: true }); w.ok(w.kioskEmail, 'kiosk.ping');
    const student = w.students[0];
    w.ok(student.email, 'projects.create', { title: 'Readiness walk-in project', description: 'Demo preparation', labId: w.lab.labId, supervisorFacultyId: w.facultyId, startDate: w.today, endDate: '2026-12-01' });
    w.ok(w.admin, 'system.backup'); await refresh();
    await item('Door GPS').getByText('Configured', { exact: true }).waitFor();
    check('refresh reflects saved GPS and open-lab hours', (await item('Opening hours').innerText()).includes('08:00 to 19:00'));
    check('fresh kiosk and eligible projects update without reloading the page', (await item('Door kiosk').innerText()).includes('Configured') && (await item('Walk-in projects').innerText()).includes('Configured'));
    check('a recent actual backup copy is shown', (await global().getByRole('listitem').filter({ hasText: 'Recent backup' }).innerText()).includes('within the last 36 hours'));
    check('the backup shortcut points to the existing backup controls', await global().getByRole('link', { name: 'View backups', exact: true }).getAttribute('href') === '#labflow-backups' && await admin.locator('#labflow-backups').count() === 1);
    check('readiness fits a phone without horizontal overflow', await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    fs.mkdirSync('.build/shots', { recursive: true }); await panel().scrollIntoViewIfNeeded(); await admin.screenshot({ path: '.build/shots/readiness-mobile.png' });
    w.e.run("DriveApp.getFolderById = function(){throw new Error('temporary access failure');};"); await refresh();
    await global().getByText('Could not check', { exact: true }).waitFor();
    check('backup access failure shows unknown while lab checks remain visible', await lab().isVisible());
    check('no uncaught browser errors', errors.length === 0);
    console.log('\n' + passed + ' readiness browser checks passed.');
  } catch (e) {
    if (admin) { fs.mkdirSync('.build/shots', { recursive: true }); await admin.screenshot({ path: '.build/shots/readiness-failure.png', fullPage: true }); console.error(await admin.locator('body').innerText()); }
    throw e;
  } finally { if (browser) await browser.close(); dev.server.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
