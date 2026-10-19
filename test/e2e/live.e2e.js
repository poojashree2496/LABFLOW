#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright-core');
const { start } = require('../../dev/server');

(async () => {
  const dev = await start(0, { preset: 'small' }), w = dev.lab.w, demo = dev.lab.unnati;
  let browser, page, passed = 0; const errors = [];
  const check = (name, yes) => { assert.ok(yes, name); console.log('PASS ' + name); passed++; };
  const clock = (time) => { dev.lab.clock.set(w.eval(`U.fromLocal('${w.today}','${time}')`)); dev.lab.sync(); };
  const region = () => page.getByRole('region', { name: 'UNNATI live board', exact: true });
  const firstStudent = w.students.find((s) => s.studentId === demo.studentIds[0]);
  async function open(who) {
    await page.goto(dev.base + '?as=' + who);
    await page.waitForFunction(() => window.LF && LF.me && LF.role);
    await page.evaluate(() => LF.go('lab-board'));
  }
  try {
    dev.lab.autoJobs = false; clock('10:15');
    w.ok(w.admin, 'settings.set', { values: { occupancyRefreshSeconds: 3 } });
    browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chrome' });
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', (e) => errors.push(e.message));
    await open(w.staff);
    await region().getByText('3 people inside', { exact: false }).waitFor();
    check('staff can open the separate lab-wide board', await page.getByRole('heading', { name: 'Live lab board', exact: true }).count() === 1);
    check('the seeded visitors show their register numbers and project assignments', (await region().innerText()).includes(firstStudent.rollNo) && (await region().innerText()).includes('Image classification (demo)'));
    check('all thirty Unnati workstations have availability cards', await region().getByRole('article').count() === 30);
    check('initial availability has three busy and twenty-seven free systems', await region().getByRole('article').getByText('Busy', { exact: true }).count() === 3 && await region().getByRole('article').getByText('Free', { exact: true }).count() === 27);
    await page.getByLabel('Board lab', { exact: true }).selectOption(demo.lab.labId);
    check('lab selection narrows the board without another permissions endpoint', await page.getByRole('region').count() === 1);
    await page.getByLabel('Search live board', { exact: true }).fill(firstStudent.rollNo);
    check('search by register number selects the current visit', await region().getByRole('row').count() === 2);
    await page.getByLabel('Search live board', { exact: true }).fill('');

    const state = w.ok(firstStudent.email, 'sessions.mine').sessions.find((s) => s.sessionId === demo.sessionId).mine.work;
    const title = 'Project <img src=x onerror=alert(1)> ' + 'longtitle'.repeat(12);
    const project = w.ok(firstStudent.email, 'projects.create', { title: title.slice(0, 120), description: 'Safe literal rendering', labId: demo.lab.labId, supervisorFacultyId: w.faculty2Id, startDate: w.today, endDate: '2026-12-01' }).project;
    w.ok(firstStudent.email, 'attend.setWork', { sessionId: demo.sessionId, entryEventId: state.entryEventId, expectedEventId: state.eventId, projectId: project.projectId, assetId: demo.workstationIds[3] });
    await region().getByRole('cell').filter({ hasText: '<img src=x onerror=alert(1)>' }).waitFor({ timeout: 12000 });
    check('automatic refresh follows a mid-visit system/project change', (await region().getByRole('table').innerText()).includes('GPU workstation 04 (demo)'));
    check('project markup is displayed as literal text', await region().locator('table img').count() === 0);
    check('work changes preserve the visit entry time', (await region().getByRole('table').innerText()).includes('09:50'));
    check('automatic polling keeps its timer bounded', await page.evaluate(() => LF.timers.length < 12));

    const assetId = demo.workstationIds[4], now = w.eval('U.now()');
    w.ok(w.students[5].email, 'booking.request', { labId: demo.lab.labId, resourceType: 'asset', resourceId: assetId, startAt: now + 600000, endAt: now + 3600000, purpose: 'Private purpose' });
    await page.getByRole('button', { name: 'Refresh board', exact: true }).click();
    await region().getByRole('article', { name: 'DEMO-UNNATI-GPU-05', exact: true }).getByText('Booked', { exact: true }).waitFor();
    check('staff can distinguish held bookings from busy systems', true);
    await page.setViewportSize({ width: 390, height: 844 });
    check('the board fits a phone with long project names', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    fs.mkdirSync('.build/shots', { recursive: true });
    await page.screenshot({ path: '.build/shots/live-board-mobile.png', fullPage: true });
    await region().locator('.tbl-wrap').evaluate((el) => { el.scrollLeft = 200; });
    await page.getByRole('button', { name: 'Refresh board', exact: true }).click();
    await page.waitForFunction(() => !Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('Refresh board')).disabled);
    check('phone table scrolling survives a refresh', await region().locator('.tbl-wrap').evaluate((el) => el.scrollLeft === 200));
    check('filters survive a server refresh', await page.getByLabel('Board lab', { exact: true }).inputValue() === demo.lab.labId);

    const result = w.checkin(firstStudent, { kiosk: demo.kioskEmail, sessionId: demo.sessionId, action: 'out', geo: w.at(3, 12, dev.lab.labs.UNNATI) });
    assert.equal(result.ok, true, JSON.stringify(result));
    await region().getByText('2 people inside', { exact: false }).waitFor({ timeout: 12000 });
    check('automatic refresh removes a departed visitor', !(await region().getByRole('table').innerText()).includes(firstStudent.rollNo));
    check('departure releases the selected workstation', await region().getByRole('article', { name: 'DEMO-UNNATI-GPU-04', exact: true }).getByText('Free', { exact: true }).count() === 1);

    let failNext = true;
    await page.route('**/rpc', async (route) => {
      const payload = route.request().postDataJSON();
      if (failNext && payload.action === 'labs.live') { failNext = false; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'FORBIDDEN', message: 'Access changed' } }) }); }
      return route.continue();
    });
    await page.getByRole('button', { name: 'Refresh board', exact: true }).click();
    await page.getByText('Access changed', { exact: true }).waitFor();
    check('a refused refresh clears the previous identities', await page.getByRole('region').count() === 0);
    await page.unroute('**/rpc');
    await page.getByRole('button', { name: 'Refresh board', exact: true }).click();
    await region().waitFor(); check('manual refresh recovers after a refused response', true);

    clock('19:05');
    await page.getByRole('button', { name: 'Refresh board', exact: true }).click();
    await region().getByText('Nobody checked in', { exact: true }).waitFor();
    check('the board recovers a delayed close and removes automatic departures', (await region().innerText()).includes('0 people inside'));
    check('automatic closing releases all workstation claims', w.eval(`Work.occupants('${demo.lab.labId}').length`) === 0);
    for (const who of [w.faculty, w.admin]) { await open(who); await region().waitFor(); check(who + ' can open the shared board', true); }
    await open(w.hod);
    await page.getByText('Department access is being configured', { exact: true }).waitFor();
    check('HOD access stays closed until department scope is implemented', await page.getByRole('region', { name: / live board$/ }).count() === 0);
    await page.goto(dev.base + '?as=' + firstStudent.email);
    await page.waitForFunction(() => window.LF && LF.me && LF.role);
    check('students have no named live-board route', await page.evaluate(() => !(LF.routes.student || []).some((r) => r.id === 'lab-board')));
    const privacy = w.ok(firstStudent.email, 'systems.status');
    check('student availability exposes no identities or reservation details', !JSON.stringify(privacy).includes('studentId') && !JSON.stringify(privacy).includes('projectId') && privacy.labs.every((l) => l.systems.every((s) => ['free', 'busy'].includes(s.status))));
    check('the live board produces no uncaught browser errors', errors.length === 0);
    console.log('\n' + passed + ' live-board checks passed.');
  } catch (e) {
    if (page) { fs.mkdirSync('.build/shots', { recursive: true }); await page.screenshot({ path: '.build/shots/live-board-failure.png', fullPage: true }); console.error(await page.locator('body').innerText()); }
    throw e;
  } finally { if (browser) await browser.close(); dev.server.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
