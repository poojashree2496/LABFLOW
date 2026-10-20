#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright-core');
const { start } = require('../../dev/server');

// Live board (R1, R2, R9): the named board for faculty, coordinators, HODs and super admins.
(async () => {
  const dev = await start(0, { preset: 'small' });
  const base = dev.base.replace(/\/$/, ''), w = dev.lab.w;
  let browser, staff, faculty, student, passed = 0;
  const errors = [];
  const check = (name, condition) => { assert.ok(condition, name); passed++; console.log('PASS ' + name); };
  async function open(page, email) {
    await page.goto(base + '/?as=' + email);
    await page.waitForFunction(() => window.LF && LF.me && LF.role);
  }
  try {
    dev.lab.autoJobs = false;
    w.lab = w.ok(w.admin, 'labs.upsert', { ...w.lab, openLab: true }).lab;
    const category = w.ok(w.staff, 'categories.upsert', { name: 'Board systems', trackingMode: 'individual', workstation: true }).category;
    const systems = [1, 2, 3].map((n) => w.ok(w.staff, 'assets.upsert', { labId: w.lab.labId, categoryId: category.categoryId, name: 'Board GPU ' + n, assetTag: 'BOARD-GPU-' + n }).asset);
    const people = ['a', 'b'].map((suffix, index) => {
      const email = 'board.' + suffix + '@karunya.edu', rollNo = 'SBRD00' + index;
      w.ok(w.admin, 'students.import', { rows: [{ email, rollNo, name: 'Board student ' + suffix }] });
      const profile = w.ok(email, 'onboard', { rollNo, name: 'Board student ' + suffix, consent: true, mobile: '987654322' + index }).student;
      const project = w.ok(email, 'projects.create', { title: 'Board project ' + suffix, description: 'Private description ' + suffix, labId: w.lab.labId,
        supervisorFacultyId: w.facultyId, startDate: w.today, endDate: '2026-12-01' }).project;
      return { email, rollNo, studentId: profile.studentId, project, profile };
    });
    dev.lab.clock.set(w.eval(`U.fromLocal('${w.today}','15:00')`)); dev.lab.sync();
    const sessionId = w.ok(people[0].email, 'sessions.mine').sessions.find((s) => s.type === 'openlab' && s.labId === w.lab.labId).sessionId;
    people.forEach((p, i) => { const r = w.checkin({ email: p.email, studentId: p.studentId, rollNo: p.rollNo }, { sessionId, projectId: p.project.projectId, assetId: systems[i].assetId }); assert.equal(r.ok, true, JSON.stringify(r)); });

    browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chrome' });
    staff = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    faculty = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    student = await browser.newPage({ viewport: { width: 390, height: 844 } });
    for (const page of [staff, faculty, student]) page.on('pageerror', (e) => errors.push(e.message));

    await open(staff, w.staff); await staff.evaluate(() => LF.go('board'));
    const cardOf = (page) => page.getByRole('region', { name: w.lab.name, exact: true });
    const tableOf = (page) => page.getByRole('table', { name: 'Students inside ' + w.lab.name });
    await tableOf(staff).waitFor();
    check('the coordinator sees the two students inside with their register numbers', await tableOf(staff).getByRole('row').filter({ hasText: 'SBRD000' }).count() === 1 && await tableOf(staff).getByRole('row').filter({ hasText: 'SBRD001' }).count() === 1);
    check('each row shows the student\'s project and system', await tableOf(staff).getByRole('row').filter({ hasText: 'Board student a' }).filter({ hasText: 'Board project a' }).filter({ hasText: 'Board GPU 1' }).count() === 1
      && await tableOf(staff).getByRole('row').filter({ hasText: 'Board student b' }).filter({ hasText: 'Board project b' }).filter({ hasText: 'Board GPU 2' }).count() === 1);
    check('each row shows how long the student has been inside', await tableOf(staff).getByRole('row').filter({ hasText: 'Board student' }).locator('[data-since]').count() === 2);
    check('the lab card shows the head count and system availability', await cardOf(staff).getByText('2 in use', { exact: true }).count() === 1 && await cardOf(staff).getByText('1 free', { exact: true }).count() === 1);
    check('the project description is never shown on the board', !(await staff.locator('main').innerText()).includes('Private description'));

    await open(faculty, w.faculty); await faculty.evaluate(() => LF.go('board'));
    await tableOf(faculty).waitFor();
    check('faculty can open the live board from a phone', await tableOf(faculty).getByRole('row').filter({ hasText: 'Board student a' }).count() === 1);
    check('the board fits a 390px phone without horizontal page scroll', await faculty.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

    await open(student, people[0].email);
    check('students have no live board screen', await student.evaluate(() => !(LF.routes.student || []).some((v) => v.id === 'board')));

    // A departure leaves the board on the next refresh.
    dev.lab.clock.set(w.eval('U.now()') + 20 * 60000); dev.lab.sync();
    const out = w.checkin({ email: people[0].email, studentId: people[0].studentId, rollNo: people[0].rollNo }, { sessionId, action: 'out' });
    assert.equal(out.ok, true, JSON.stringify(out));
    await staff.getByRole('button', { name: 'Refresh now', exact: true }).click();
    await tableOf(staff).getByRole('row').filter({ hasText: 'Board student a' }).waitFor({ state: 'detached' });
    check('a student who signs out disappears and the count drops', await tableOf(staff).getByRole('row').filter({ hasText: 'Board student b' }).count() === 1 && await cardOf(staff).getByText('1 free', { exact: true }).count() === 0 && await cardOf(staff).getByText('2 free', { exact: true }).count() === 1);

    // A failed refresh keeps the last data and says so.
    await staff.route('**/rpc', async (route) => {
      if (route.request().postDataJSON().action !== 'labs.live') return route.continue();
      return route.fulfill({ json: { ok: false, error: { code: 'NETWORK', message: 'Offline for the test.' } } });
    });
    await staff.getByRole('button', { name: 'Refresh now', exact: true }).click();
    await staff.getByText('Could not refresh the board.', { exact: false }).waitFor();
    check('a failed refresh keeps the last data on screen with a warning', await tableOf(staff).getByRole('row').filter({ hasText: 'Board student b' }).count() === 1 && (await staff.getByText('(not refreshed)', { exact: false }).count()) === 1);
    await staff.unroute('**/rpc');
    await staff.getByRole('button', { name: 'Refresh now', exact: true }).click();
    await staff.getByText('Could not refresh the board.', { exact: false }).waitFor({ state: 'detached' });
    check('the warning clears when the next refresh succeeds', true);

    fs.mkdirSync('.build/shots', { recursive: true });
    await staff.screenshot({ path: '.build/shots/live-board.png' }); await faculty.screenshot({ path: '.build/shots/live-board-mobile.png' });
    check('the live board produces no uncaught browser errors', errors.length === 0);
    console.log('\n' + passed + ' live-board checks passed.');
  } catch (e) {
    fs.mkdirSync('.build/shots', { recursive: true });
    for (const [name, page] of [['staff', staff], ['faculty', faculty], ['student', student]]) if (page && !page.isClosed()) {
      await page.screenshot({ path: '.build/shots/board-' + name + '-failure.png', fullPage: true }); console.error(name + ': ' + await page.locator('body').innerText());
    }
    throw e;
  } finally { if (browser) await browser.close(); dev.server.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
