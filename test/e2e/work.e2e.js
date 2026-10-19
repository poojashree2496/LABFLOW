#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright-core');
const { start } = require('../../dev/server');

(async () => {
  const dev = await start(0, { preset: 'small' });
  const base = dev.base.replace(/\/$/, ''), w = dev.lab.w;
  let browser, student, other, staff, passed = 0;
  const errors = [];
  const check = (name, condition) => { assert.ok(condition, name); passed++; console.log('PASS ' + name); };
  const events = () => w.eval("Db.readAll('AttendanceEvents')");
  const card = (page) => page.getByRole('article', { name: 'Open lab', exact: true });
  const state = (person) => w.ok(person.email, 'sessions.mine').sessions.find((s) => s.type === 'openlab').mine;
  async function open(page, email) {
    await page.goto(base + '/?as=' + email);
    await page.waitForFunction(() => window.LF && LF.me && LF.role);
  }
  async function scan(page) {
    await page.evaluate((code) => LF.kioskCheckin(code), w.kioskCode());
    const dialog = page.getByRole('dialog', { name: 'Lab check-in', exact: true });
    await dialog.getByRole('button', { name: /Send location/ }).waitFor(); return dialog;
  }
  async function editor(page) {
    await card(page).getByRole('button', { name: 'Change system / project', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Change system / project', exact: true });
    await dialog.getByRole('button', { name: 'Save project and system', exact: true }).waitFor(); return dialog;
  }
  function change(person, assetId) {
    const current = state(person).work;
    return w.ok(person.email, 'attend.setWork', { sessionId, entryEventId: current.entryEventId, expectedEventId: current.eventId,
      projectId: person.project.projectId, assetId });
  }
  let sessionId;
  try {
    dev.lab.autoJobs = false;
    w.lab = w.ok(w.admin, 'labs.upsert', { ...w.lab, openLab: true }).lab;
    const category = w.ok(w.staff, 'categories.upsert', { name: 'Browser systems', trackingMode: 'individual' }).category;
    const systems = [1, 2, 3].map((n) => w.ok(w.staff, 'assets.upsert', { labId: w.lab.labId, categoryId: category.categoryId, name: 'Browser GPU ' + n, assetTag: 'BROWSER-GPU-' + n }).asset);
    const people = ['a', 'b'].map((suffix, index) => {
      const email = 'work.' + suffix + '@karunya.edu', rollNo = 'SWORK00' + index;
      w.ok(w.admin, 'students.import', { rows: [{ email, rollNo, name: 'Work student ' + suffix }] });
      const student = w.ok(email, 'onboard', { rollNo, name: 'Work student ' + suffix, consent: true, mobile: '987654321' + index }).student;
      const project = w.ok(email, 'projects.create', { title: 'Work project ' + suffix, description: 'GPU experimentation', labId: w.lab.labId,
        supervisorFacultyId: w.facultyId, startDate: w.today, endDate: '2026-12-01' }).project;
      return { email, studentId: student.studentId, project };
    });
    const [a, b] = people;
    const alternate = w.ok(a.email, 'projects.create', { title: 'Alternate project', description: 'Compare experimental results', labId: w.lab.labId,
      supervisorFacultyId: w.facultyId, startDate: w.today, endDate: '2026-12-01' }).project;
    dev.lab.clock.set(w.eval(`U.fromLocal('${w.today}','15:00')`)); dev.lab.sync();
    browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chrome' });
    student = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    other = await browser.newPage({ viewport: { width: 390, height: 844 } }); staff = await browser.newPage();
    for (const page of [student, other, staff]) page.on('pageerror', (e) => errors.push(e.message));

    await open(staff, w.staff); await staff.evaluate(() => LF.go('inventory'));
    await staff.getByRole('tab', { name: 'Categories', exact: true }).click();
    await staff.getByRole('row').filter({ hasText: category.name }).getByRole('button', { name: 'Edit', exact: true }).click();
    const categoryEditor = staff.getByRole('dialog');
    await categoryEditor.getByLabel('Use as selectable lab systems', { exact: true }).check();
    await categoryEditor.getByRole('button', { name: 'Save', exact: true }).click();
    await categoryEditor.waitFor({ state: 'detached' });
    check('coordinator can mark a category as selectable lab systems', w.eval(`Db.get('Categories','${category.categoryId}').workstation`) === true);

    await open(student, a.email); await card(student).waitFor();
    let dialog = await scan(student);
    check('open-lab entry shows the project and system pickers', await dialog.getByRole('region', { name: 'Project and system' }).count() === 1);
    await dialog.getByRole('button', { name: /Send location/ }).click();
    check('missing project is refused locally before an entry is written', events().filter((e) => e.studentId === a.studentId && e.type === 'IN').length === 0);
    await dialog.getByLabel('Project *', { exact: true }).selectOption(a.project.projectId);
    await dialog.getByLabel('System', { exact: true }).selectOption(systems[0].assetId);
    check('entry pickers fit a 390px phone', await student.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await dialog.getByRole('button', { name: /Send location/ }).click();
    await dialog.getByText('Location check passed.', { exact: true }).waitFor();
    const entry = events().find((e) => e.studentId === a.studentId && e.type === 'IN'); sessionId = entry.sessionId;
    check('entry stores the pending project and selected workstation', entry.projectId === a.project.projectId && entry.assetId === systems[0].assetId);
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await card(student).getByText('Project: Work project a · System: Browser GPU 1', { exact: true }).waitFor();
    check('Today displays the current project and system', state(a).work.assetId === systems[0].assetId);

    await open(other, b.email); await card(other).waitFor();
    dialog = await scan(other);
    check('another student sees a busy system disabled', await dialog.getByLabel('System', { exact: true }).locator('option[value="' + systems[0].assetId + '"]').isDisabled());
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    dialog = await editor(student);
    await dialog.getByLabel('Project *', { exact: true }).selectOption(alternate.projectId);
    await dialog.getByLabel('System', { exact: true }).selectOption(systems[1].assetId);
    await dialog.getByRole('button', { name: 'Save project and system', exact: true }).click();
    await card(student).getByText('Project: Alternate project · System: Browser GPU 2', { exact: true }).waitFor();
    check('a mid-visit change appends WORK with the selected project and system', events().some((e) => e.studentId === a.studentId && e.type === 'WORK' && e.projectId === alternate.projectId && e.assetId === systems[1].assetId));
    check('a work change does not verify attendance minutes', state(a).verifiedMinutes === 0);
    dialog = await scan(other);
    check('the previous system becomes selectable after it is released', !await dialog.getByLabel('System', { exact: true }).locator('option[value="' + systems[0].assetId + '"]').isDisabled());
    await dialog.getByLabel('System', { exact: true }).selectOption(systems[0].assetId);
    let lostEntry = false;
    await other.route('**/rpc', async (route) => {
      const body = route.request().postDataJSON();
      if (body.action !== 'checkin.submit' || lostEntry) return route.continue();
      lostEntry = true;
      const response = await route.fetch(); assert.equal((await response.json()).ok, true);
      return route.fulfill({ json: { ok: false, error: { code: 'NETWORK', message: 'Lost entry confirmation.' } } });
    });
    await dialog.getByRole('button', { name: /Send location/ }).click();
    await dialog.getByRole('button', { name: 'Refresh sessions to confirm', exact: true }).waitFor();
    check('an uncertain entry freezes its project/system choices', await dialog.getByLabel('System', { exact: true }).isDisabled());
    await dialog.getByRole('button', { name: 'Refresh sessions to confirm', exact: true }).click();
    await card(other).getByText('Project: Work project b · System: Browser GPU 1', { exact: true }).waitFor();
    check('refresh confirms the original entry without resubmitting or duplicating it', events().filter((e) => e.studentId === b.studentId && e.type === 'IN').length === 1 && state(b).work.assetId === systems[0].assetId);
    await other.unroute('**/rpc');

    dialog = await editor(student);
    await dialog.getByLabel('System', { exact: true }).selectOption(systems[2].assetId);
    change(b, systems[2].assetId);
    await dialog.getByRole('button', { name: 'Save project and system', exact: true }).click();
    await dialog.getByRole('alert').filter({ hasText: 'That system is in use' }).waitFor();
    check('a system claimed after choices load is refused by the server', state(a).work.assetId === systems[1].assetId);
    await dialog.getByRole('button', { name: 'Refresh choices', exact: true }).click();
    await student.waitForFunction((id) => { const select = document.querySelector('[role="dialog"] select[name="assetId"]'); return select && Array.from(select.options).some((o) => o.value === id && o.disabled); }, systems[2].assetId);
    dialog = student.getByRole('dialog', { name: 'Change system / project', exact: true });
    check('refreshing choices disables the newly busy system', await dialog.getByLabel('System', { exact: true }).locator('option[value="' + systems[2].assetId + '"]').isDisabled());
    await dialog.getByLabel('System', { exact: true }).selectOption('');
    await dialog.getByRole('button', { name: 'Save project and system', exact: true }).click();
    await card(student).getByText('Project: Alternate project · System: Own laptop / no system', { exact: true }).waitFor();
    check('own-laptop selection releases the workstation without ending attendance', state(a).state === 'in' && state(a).work.assetId === '');

    const attempts = [], before = events().filter((e) => e.type === 'WORK').length;
    await student.route('**/rpc', async (route) => {
      const body = route.request().postDataJSON();
      if (body.action !== 'attend.setWork') return route.continue();
      attempts.push(body.payload);
      if (attempts.length === 1) {
        const response = await route.fetch(); assert.equal((await response.json()).ok, true);
        return route.fulfill({ json: { ok: false, error: { code: 'NETWORK', message: 'Lost work confirmation.' } } });
      }
      return route.continue();
    });
    dialog = await editor(student);
    await dialog.getByLabel('System', { exact: true }).selectOption(systems[0].assetId);
    await dialog.getByRole('button', { name: 'Save project and system', exact: true }).click();
    await dialog.getByRole('alert').filter({ hasText: 'Lost work confirmation' }).waitFor();
    check('an uncertain work update freezes its original choices', await dialog.getByLabel('System', { exact: true }).isDisabled());
    await dialog.getByRole('button', { name: 'Save project and system', exact: true }).click();
    await card(student).getByText('Project: Alternate project · System: Browser GPU 1', { exact: true }).waitFor();
    check('work retries reuse the same event id and payload', attempts.length === 2 && JSON.stringify(attempts[0]) === JSON.stringify(attempts[1]));
    check('lost-confirmation retry appends exactly one work event', events().filter((e) => e.type === 'WORK').length === before + 1);
    await student.unroute('**/rpc');

    change(b, '');
    const now = w.eval('U.now()');
    const reservation = w.ok(a.email, 'booking.request', { labId: w.lab.labId, resourceType: 'asset', resourceId: systems[2].assetId, startAt: now, endAt: now + 3600000, purpose: 'Booked GPU work' }).reservation;
    w.ok(w.staff, 'booking.decide', { reservationId: reservation.reservationId, approve: true });
    await student.evaluate(() => LF.go('today')); await card(student).getByRole('button', { name: 'Change system / project', exact: true }).waitFor();
    dialog = await editor(student);
    check('a currently booked system is preselected', await dialog.getByLabel('System', { exact: true }).inputValue() === systems[2].assetId);
    check('a booking disables own-laptop selection', await dialog.getByLabel('System', { exact: true }).locator('option[value=""]').isDisabled());
    await dialog.getByRole('button', { name: 'Save project and system', exact: true }).click();
    await card(student).getByText('Project: Alternate project · System: Browser GPU 3', { exact: true }).waitFor();
    check('the chosen booked system is marked used', !!w.eval(`Db.get('Reservations','${reservation.reservationId}').usedAt`));
    check('current-work details fit the phone layout', await student.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    fs.mkdirSync('.build/shots', { recursive: true }); await card(student).screenshot({ path: '.build/shots/work-selection-mobile.png' });
    check('work-selection screens produce no uncaught browser errors', errors.length === 0);
    console.log('\n' + passed + ' work-selection checks passed.');
  } catch (e) {
    fs.mkdirSync('.build/shots', { recursive: true });
    for (const [name, page] of [['student', student], ['other', other], ['staff', staff]]) if (page && !page.isClosed()) {
      await page.screenshot({ path: '.build/shots/work-' + name + '-failure.png', fullPage: true }); console.error(name + ': ' + await page.locator('body').innerText());
    }
    throw e;
  } finally { if (browser) await browser.close(); dev.server.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
