#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright-core');
const { start } = require('../../dev/server');
(async () => {
  const dev = await start(0, { preset: 'small' }), w = dev.lab.w, demo = dev.lab.unnati;
  let browser, page, passed = 0; const errors = [];
  const check = (name, ok) => { assert.ok(ok, name); passed++; console.log('PASS ' + name); };
  async function login(who, view = 'reports') { await page.goto(dev.base + '?as=' + who); await page.waitForFunction(() => window.LF && LF.me && LF.role); await page.evaluate((id) => LF.go(id), view); }
  async function range() { await page.getByLabel('From', { exact: true }).fill('2026-10-14'); await page.getByLabel('To', { exact: true }).fill('2026-10-14'); }
  async function run() {
    const response = page.waitForResponse((r) => r.url().endsWith('/rpc') && r.request().postDataJSON().action === 'reports.run');
    await page.getByRole('button', { name: 'Run report', exact: true }).click(); await response;
    await page.getByRole('button', { name: 'CSV', exact: true }).waitFor();
  }
  async function download() { const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'CSV', exact: true }).click(); const d = await pending; return fs.readFileSync(await d.path(), 'utf8'); }
  try {
    dev.lab.autoJobs = false; dev.lab.clock.set(w.eval("U.fromLocal('2026-10-14','19:05')")); dev.lab.sync();
    browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chrome' });
    page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true }); page.on('pageerror', e => errors.push(e.message));
    await login(w.staff); await page.getByLabel('Report', { exact: true }).selectOption('systemUsage'); await range();
    await page.getByLabel('Lab', { exact: true }).selectOption(demo.lab.labId);
    await page.locator('#rp-asset option').filter({ hasText: 'DEMO-UNNATI-GPU-01' }).waitFor({ state: 'attached' });
    check('system picker contains all thirty Unnati workstations', await page.locator('#rp-asset option').count() === 31);
    await page.getByLabel('System', { exact: true }).selectOption(demo.workstationIds[0]); await run();
    check('system report displays verified use and contextual sections', (await page.locator('main').innerText()).includes('550') && await page.getByRole('heading', { name: 'Reservations (not attendance)', exact: true }).count() === 1 && await page.getByRole('heading', { name: 'Equipment loans (not attendance)', exact: true }).count() === 1);
    check('system CSV exports the work and separate context', (await download()).includes('Reported system use'));

    // Delay an old lab response, select another lab, then deliver the old response.
    let release, held = false;
    await page.route('**/rpc', async route => {
      const b = route.request().postDataJSON();
      if (!held && b.action === 'assets.list' && b.payload.labId === w.lab.labId) { held = true; const response = await route.fetch(); await new Promise(r => { release = r; }); await route.fulfill({ response }); } else await route.continue();
    });
    await page.getByLabel('Lab', { exact: true }).selectOption(w.lab.labId);
    await page.waitForFunction(() => document.querySelector('#rp-asset').disabled);
    for (let i = 0; i < 100 && !release; i++) await page.waitForTimeout(20);
    assert.ok(release); await page.getByLabel('Lab', { exact: true }).selectOption(demo.lab.labId);
    await page.locator('#rp-asset option').filter({ hasText: 'DEMO-UNNATI-GPU-01' }).waitFor({ state: 'attached' }); release(); await page.waitForTimeout(200);
    check('an old asset response cannot overwrite the newly selected lab', await page.locator('#rp-asset option').count() === 31);
    await page.unroute('**/rpc');

    await page.getByLabel('Report', { exact: true }).selectOption('student'); await page.getByLabel('Student', { exact: true }).fill('URK24CS1010'); await run();
    check('student report shows totals and per-lab breakdown', await page.getByText('Auto sign-outs', { exact: true }).count() >= 1 && await page.getByRole('heading', { name: 'Per-lab totals', exact: true }).count() === 1);
    const studentCsv = await download(); check('student CSV includes the auto sign-out and selected lab', studentCsv.includes('auto_out') && studentCsv.includes('UNNATI') && studentCsv.includes('Verified hours'));
    const markup = 'Project <img src=x onerror=alert(1)> (demo)';
    const base = { description: 'Report browser coverage', labId: demo.lab.labId, startDate: w.today, endDate: '2026-12-01' };
    w.ok(w.students[9].email, 'projects.create', { ...base, title: markup, supervisorFacultyId: w.faculty2Id });
    w.ok(w.students[9].email, 'projects.create', { ...base, title: 'Hidden other supervisor project', supervisorFacultyId: w.facultyId });
    await page.getByLabel('Report', { exact: true }).selectOption('projects'); await run();
    check('project report includes outcomes, timeline and logged hours', await page.getByRole('columnheader', { name: /outcome/i }).count() >= 1 && (await page.locator('main').innerText()).includes('Verified hours'));
    check('project markup remains literal text', await page.getByRole('cell', { name: markup, exact: true }).count() === 1 && await page.locator('main table img').count() === 0);
    check('project CSV includes the sample projects', (await download()).includes('Image classification (demo)'));
    await page.setViewportSize({ width: 390, height: 844 });
    check('reports fit a phone with tables scrolling inside their containers', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    fs.mkdirSync('.build/shots', { recursive: true }); await page.screenshot({ path: '.build/shots/reports-mobile.png', fullPage: true });

    await login(w.faculty2); await page.getByLabel('Report', { exact: true }).selectOption('projects'); await range(); await run();
    check('faculty reports include only supervised projects', (await page.locator('main').innerText()).includes(markup) && !(await page.locator('main').innerText()).includes('Hidden other supervisor project'));
    check('faculty cannot select the staff system-usage report', await page.locator('#rp-type option[value="systemUsage"]').count() === 0);
    await login(w.students[9].email, 'today');
    await page.getByRole('heading', { name: 'Your lab time (past 90 days)', exact: true }).waitFor();
    check('student home shows per-lab days and verified hours', await page.getByRole('table', { name: 'Your lab time', exact: true }).count() === 1 && (await page.getByRole('table', { name: 'Your lab time', exact: true }).innerText()).includes('Intel Unnati AI Lab'));
    check('student home still fits a phone', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: '.build/shots/student-lab-time-mobile.png', fullPage: true });
    await page.evaluate(() => LF.go('reports')); await range(); await run();
    check('students have their own attendance report without another student picker', await page.locator('#rp-who').isHidden() && await page.locator('#rp-type option').count() === 1);
    check('student report identity comes from the server', (await page.locator('main').innerText()).includes('URK24CS1010'));
    check('report screens produce no uncaught browser errors', errors.length === 0);
    console.log('\n' + passed + ' report checks passed.');
  } catch (e) { if (page) { fs.mkdirSync('.build/shots', { recursive: true }); await page.screenshot({ path: '.build/shots/reports-failure.png', fullPage: true }); console.error(await page.locator('body').innerText()); } throw e; }
  finally { if (browser) await browser.close(); dev.server.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
