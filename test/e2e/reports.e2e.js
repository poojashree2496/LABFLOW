#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright-core');
const { start } = require('../../dev/server');

// B5 screens: system usage and projects reports for the coordinator, and days/time per lab on the student home.
(async () => {
  const dev = await start(0, { preset: 'small' });
  const base = dev.base.replace(/\/$/, ''), w = dev.lab.w;
  let browser, staff, student, passed = 0;
  const errors = [];
  const check = (name, condition) => { assert.ok(condition, name); passed++; console.log('PASS ' + name); };
  async function open(page, email) {
    await page.goto(base + '/?as=' + email);
    await page.waitForFunction(() => window.LF && LF.me && LF.role);
  }
  try {
    dev.lab.autoJobs = false;
    w.lab = w.ok(w.admin, 'labs.upsert', { ...w.lab, openLab: true }).lab;
    const category = w.ok(w.staff, 'categories.upsert', { name: 'Report systems', trackingMode: 'individual', workstation: true }).category;
    const system = w.ok(w.staff, 'assets.upsert', { labId: w.lab.labId, categoryId: category.categoryId, name: 'Report GPU 1', assetTag: 'REPORT-GPU-1' }).asset;
    const email = 'report.a@karunya.edu', rollNo = 'SRPT000';
    w.ok(w.admin, 'students.import', { rows: [{ email, rollNo, name: 'Report student' }] });
    const profile = w.ok(email, 'onboard', { rollNo, name: 'Report student', consent: true, mobile: '9876543290' }).student;
    const project = w.ok(email, 'projects.create', { title: 'Report project', description: 'Reporting', labId: w.lab.labId, supervisorFacultyId: w.facultyId, startDate: w.today, endDate: '2026-12-01' }).project;
    dev.lab.clock.set(w.eval(`U.fromLocal('${w.today}','15:00')`)); dev.lab.sync();
    const sessionId = w.ok(email, 'sessions.mine').sessions.find((s) => s.type === 'openlab' && s.labId === w.lab.labId).sessionId;
    const me = { email, studentId: profile.studentId, rollNo };
    assert.equal(w.checkin(me, { sessionId, projectId: project.projectId, assetId: system.assetId }).ok, true);
    dev.lab.clock.set(w.eval('U.now()') + 45 * 60000); dev.lab.sync();
    assert.equal(w.checkin(me, { sessionId, action: 'out' }).ok, true);
    w.ok(w.admin, 'sessions.close', { sessionId });

    browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chrome' });
    staff = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    student = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    for (const page of [staff, student]) page.on('pageerror', (e) => errors.push(e.message));

    await open(staff, w.staff); await staff.evaluate(() => LF.go('reports'));
    await staff.locator('#rp-type').selectOption({ label: 'System usage' });
    await staff.getByRole('button', { name: 'Run report', exact: true }).click();
    await staff.getByText('Choose a system.', { exact: false }).first().waitFor();
    check('running system usage without choosing a system asks for one', true);
    await staff.locator('#rp-asset').selectOption({ label: 'Report GPU 1 (REPORT-GPU-1)' });
    await staff.getByRole('button', { name: 'Run report', exact: true }).click();
    await staff.getByRole('heading', { name: /System usage - Report GPU 1/ }).waitFor();
    check('the system usage report shows people, visits and hours', await staff.getByText('0.8', { exact: true }).count() >= 1 && await staff.getByText('Hours used', { exact: true }).count() === 1);
    check('it lists who used the system, and for which project', await staff.getByRole('row').filter({ hasText: 'Report student' }).filter({ hasText: 'Report project' }).filter({ hasText: '15:00' }).count() >= 1);
    check('it groups the use by project or purpose', await staff.getByRole('heading', { name: 'By project or purpose' }).count() === 1);
    const csv = await staff.evaluate(async (id) => (await LF.api('reports.csv', { type: 'systemUsage', assetId: id, from: '2026-10-01', to: '2026-10-31' })).csv, system.assetId);
    check('the CSV export carries the summary and the table', csv.includes('Hours used') && csv.includes('Report project'));

    await staff.locator('#rp-type').selectOption({ label: 'Projects' });
    await staff.getByRole('button', { name: 'Run report', exact: true }).click();
    await staff.getByRole('heading', { name: 'Projects', exact: true }).first().waitFor();
    check('the projects report shows owner, status and hours logged', await staff.getByRole('row').filter({ hasText: 'Report project' }).filter({ hasText: 'Report student' }).filter({ hasText: 'pending' }).count() >= 1 && await staff.getByText('Hours logged', { exact: true }).count() >= 1);

    await open(student, email);
    await student.getByText('Days in the lab', { exact: true }).waitFor();
    check('the student home shows days in the lab and time per lab', await student.getByText(w.lab.name + ' 45 min', { exact: false }).count() === 1);
    check('the student home fits a 390px phone', await student.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    fs.mkdirSync('.build/shots', { recursive: true });
    await staff.screenshot({ path: '.build/shots/reports-system-usage.png' }); await student.screenshot({ path: '.build/shots/student-days-in-lab.png' });
    check('the report screens produce no uncaught browser errors', errors.length === 0);
    console.log('\n' + passed + ' report checks passed.');
  } catch (e) {
    fs.mkdirSync('.build/shots', { recursive: true });
    for (const [name, page] of [['staff', staff], ['student', student]]) if (page && !page.isClosed()) {
      await page.screenshot({ path: '.build/shots/reports-' + name + '-failure.png', fullPage: true }); console.error(name + ': ' + (await page.locator('body').innerText()).slice(0, 1500));
    }
    throw e;
  } finally { if (browser) await browser.close(); dev.server.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
