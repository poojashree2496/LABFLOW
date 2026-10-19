#!/usr/bin/env node
// Project lifecycle through the actual UI and RPC gateway, with isolated Chromium profiles and Google fakes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright-core');
const { start } = require('../../dev/server');

(async () => {
  const dev = await start(0, { preset: 'small' });
  const base = dev.base.replace(/\/$/, ''), w = dev.lab.w;
  let browser, student, passed = 0;
  const errors = [];
  const check = (name, condition) => { assert.ok(condition, name); passed++; console.log('PASS ' + name); };
  const projectRows = () => w.eval("Db.readAll('Projects')");
  async function open(page, email, role) {
    await page.goto(base + '/?as=' + encodeURIComponent(email));
    await page.waitForFunction(() => window.LF && LF.me && LF.role);
    await page.evaluate((role) => LF.go('projects', role), role);
    await page.getByRole('heading', { name: role === 'student' ? 'My projects' : 'Projects', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Refresh projects', exact: true }).waitFor();
  }
  async function newProject(page, title, extra = {}) {
    await page.getByRole('button', { name: 'New project', exact: true }).click();
    const form = page.getByRole('dialog', { name: 'Create project', exact: true });
    await form.getByLabel('Project title', { exact: false }).fill(title);
    await form.getByLabel('Description', { exact: false }).fill('Measure navigation accuracy using a lab workstation.');
    await form.getByLabel('Lab *', { exact: true }).selectOption(w.lab.labId);
    await form.getByLabel('Supervisor *', { exact: true }).selectOption(extra.supervisor || w.facultyId);
    await form.getByLabel('Start date', { exact: false }).fill('2026-10-14');
    await form.getByLabel('Target end date', { exact: false }).fill('2026-11-20');
    if (extra.groupId) await form.getByLabel('Project team', { exact: true }).selectOption(extra.groupId);
    return form;
  }
  const card = (page, name) => page.getByRole('article', { name, exact: true });
  try {
    const group = w.ok(w.staff, 'groups.create', { name: 'Browser navigation team', labId: w.lab.labId,
      studentIds: w.students.slice(0, 2).map((s) => s.studentId), leaderId: w.students[0].studentId }).group;
    browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chrome' });
    student = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const faculty = await browser.newPage(), other = await browser.newPage(), staff = await browser.newPage();
    for (const page of [student, faculty, other, staff]) page.on('pageerror', (e) => errors.push(e.message));
    await open(student, w.students[0].email, 'student');
    await student.getByRole('button', { name: 'More', exact: true }).click();
    await student.getByRole('dialog', { name: 'Menu', exact: true }).getByRole('button', { name: 'My projects', exact: true }).click();
    await student.getByRole('button', { name: 'New project', exact: true }).waitFor();
    check('projects are reachable through the phone navigation menu', await student.evaluate(() => LF.current.id === 'projects'));
    check('student projects screen starts with a useful empty state', await student.getByText('No projects yet', { exact: true }).count() === 1);
    let form = await newProject(student, 'Browser navigation');
    await form.getByLabel('Target end date', { exact: false }).fill('2026-01-01');
    await form.getByRole('button', { name: 'Create project', exact: true }).click();
    await form.getByRole('alert').filter({ hasText: 'End date' }).waitFor();
    check('a definite timeline refusal leaves the project form editable', !await form.getByLabel('Project title', { exact: false }).isDisabled() && projectRows().length === 0);
    await form.getByLabel('Target end date', { exact: false }).fill('2026-11-20');
    check('project editor fits a 390px phone', await student.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await form.getByRole('button', { name: 'Create project', exact: true }).click();
    await card(student, 'Browser navigation').getByText('Awaiting approval', { exact: true }).waitFor();
    check('student creates a pending project with supervisor and timeline', projectRows()[0].supervisorFacultyId === w.facultyId && projectRows()[0].endDate === '2026-11-20');

    await open(other, w.faculty2, 'faculty');
    check('another faculty account cannot see the project', await card(other, 'Browser navigation').count() === 0);
    await open(faculty, w.faculty, 'faculty');
    await card(faculty, 'Browser navigation').getByRole('button', { name: 'Approve project', exact: true }).click();
    await card(faculty, 'Browser navigation').getByText('Active', { exact: true }).waitFor();
    check('named supervisor approves through the project screen', projectRows()[0].status === 'active');
    await student.getByRole('button', { name: 'Refresh projects', exact: true }).click();
    await card(student, 'Browser navigation').getByRole('button', { name: 'Record outcome', exact: true }).click();
    form = student.getByRole('dialog', { name: 'Outcome: Browser navigation', exact: true });
    await form.getByLabel('Outcome *', { exact: true }).fill('Reached the target accuracy.');
    await form.getByLabel('Result link (optional)', { exact: true }).fill('javascript:alert(1)');
    await form.getByRole('button', { name: 'Submit outcome', exact: true }).click();
    await form.getByRole('alert').filter({ hasText: 'http://' }).waitFor();
    check('unsafe result URLs are refused without losing the outcome draft', await form.getByLabel('Outcome *', { exact: true }).inputValue() === 'Reached the target accuracy.');
    await form.getByLabel('Result link (optional)', { exact: true }).fill('https://example.org/results');
    await form.getByRole('button', { name: 'Submit outcome', exact: true }).click();
    await card(student, 'Browser navigation').getByText('Outcome awaiting review', { exact: true }).waitFor();
    check('student submits an outcome without completing their own project', projectRows()[0].status === 'active' && !!projectRows()[0].outcomeAt);
    check('result links open separately without opener access', await card(student, 'Browser navigation').getByRole('link', { name: 'Open result link' }).getAttribute('rel') === 'noopener noreferrer');

    await faculty.getByRole('button', { name: 'Refresh projects', exact: true }).click();
    await card(faculty, 'Browser navigation').getByRole('button', { name: 'Accept outcome', exact: true }).waitFor();
    w.ok(w.students[0].email, 'projects.outcome', { projectId: projectRows()[0].projectId, outcome: 'Revised final results: 8 cm error.' });
    await card(faculty, 'Browser navigation').getByRole('button', { name: 'Accept outcome', exact: true }).click();
    await card(faculty, 'Browser navigation').getByText('Revised final results: 8 cm error.', { exact: true }).waitFor();
    check('accepting stale results refreshes the project and keeps it active', projectRows()[0].status === 'active');
    await card(faculty, 'Browser navigation').getByRole('button', { name: 'Accept outcome', exact: true }).click();
    await card(faculty, 'Browser navigation').getByText('Completed', { exact: true }).waitFor();
    await student.getByRole('button', { name: 'Refresh projects', exact: true }).click();
    await card(student, 'Browser navigation').getByText('Completed', { exact: true }).waitFor();
    check('supervisor accepts the reviewed outcome and closes editing', projectRows()[0].status === 'completed' && await card(student, 'Browser navigation').getByRole('button', { name: /outcome/i }).count() === 0);

    form = await newProject(student, 'Browser group project', { groupId: group.groupId, supervisor: w.faculty2Id });
    await form.getByRole('button', { name: 'Create project', exact: true }).click();
    await card(student, 'Browser group project').waitFor();
    check('group leader can create a team project', projectRows().find((p) => p.title === 'Browser group project').groupId === group.groupId);
    await open(other, w.students[1].email, 'student');
    check('group members can see their shared project', await card(other, 'Browser group project').count() === 1);
    await other.getByRole('button', { name: 'New project', exact: true }).click();
    await other.getByRole('dialog', { name: 'Create project', exact: true }).waitFor();
    check('nonleader is not offered their group for project creation', await other.getByLabel('Project team', { exact: true }).locator('option[value="' + group.groupId + '"]').count() === 0);
    await other.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
    await open(staff, w.staff, 'staff');
    await card(staff, 'Browser group project').getByRole('button', { name: 'Approve project', exact: true }).click();
    await card(staff, 'Browser group project').getByText('Active', { exact: true }).waitFor();
    check('coordinator can approve a project assigned to another supervisor', projectRows().find((p) => p.title === 'Browser group project').approvedBy === w.staff);
    await other.getByRole('button', { name: 'Refresh projects', exact: true }).click();
    await card(other, 'Browser group project').getByText('Active', { exact: true }).waitFor();
    check('nonleader group member has a read-only project card', await card(other, 'Browser group project').getByRole('button').count() === 0);

    const payloads = [];
    await student.route('**/rpc', async (route) => {
      const body = route.request().postDataJSON();
      if (body.action !== 'projects.create') return route.continue();
      payloads.push(body.payload);
      if (payloads.length === 1) {
        const response = await route.fetch(); assert.equal((await response.json()).ok, true);
        return route.fulfill({ json: { ok: false, error: { code: 'NETWORK', message: 'Lost project confirmation.' } } });
      }
      if (payloads.length === 2) return route.fulfill({ json: { ok: false, error: { code: 'BAD_INPUT', message: 'Simulated later refusal.' } } });
      return route.continue();
    });
    const retryTitle = 'Retry <img src=x onerror=alert(1)> project';
    form = await newProject(student, retryTitle);
    await form.getByRole('button', { name: 'Create project', exact: true }).click();
    await form.getByRole('button', { name: 'Retry same request', exact: true }).waitFor();
    check('lost creation confirmation preserves and freezes the original details', await form.getByLabel('Project title', { exact: false }).isDisabled());
    await form.getByRole('button', { name: 'Close', exact: true }).click();
    await student.getByRole('button', { name: 'New project', exact: true }).click();
    form = student.getByRole('dialog', { name: 'Create project', exact: true });
    check('closing and reopening the editor preserves an uncertain request', await form.getByLabel('Project title', { exact: false }).inputValue() === retryTitle && await form.getByLabel('Project title', { exact: false }).isDisabled());
    await form.getByRole('button', { name: 'Retry same request', exact: true }).click();
    await form.getByRole('alert').filter({ hasText: 'Simulated later refusal' }).waitFor();
    check('a later refusal does not unlock an earlier uncertain creation', await form.getByLabel('Project title', { exact: false }).isDisabled());
    await form.getByRole('button', { name: 'Retry same request', exact: true }).click();
    await card(student, retryTitle).waitFor();
    check('three creation attempts reuse the identical payload', payloads.length === 3 && payloads.every((p) => JSON.stringify(p) === JSON.stringify(payloads[0])));
    check('retry creates exactly one saved project', projectRows().filter((p) => p.title === retryTitle).length === 1);
    check('project titles are rendered as text', await card(student, retryTitle).locator('img').count() === 0 && await card(student, retryTitle).getByRole('heading', { name: retryTitle, exact: true }).count() === 1);
    await student.unroute('**/rpc');
    check('project cards fit a 390px phone', await student.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    fs.mkdirSync('.build/shots', { recursive: true });
    await student.screenshot({ path: '.build/shots/projects-mobile.png', fullPage: true });
    await open(staff, w.admin, 'admin');
    check('super admin can open the shared project review screen', await card(staff, retryTitle).getByRole('button', { name: 'Approve project', exact: true }).count() === 1);
    await card(staff, retryTitle).getByRole('button', { name: 'Reject project', exact: true }).click();
    const rejection = staff.getByRole('dialog');
    await rejection.getByLabel('Reason shown to the student', { exact: false }).fill('Please narrow the scope.');
    await rejection.getByRole('button', { name: 'Reject project', exact: true }).click();
    await card(staff, retryTitle).getByText('Rejected', { exact: true }).waitFor();
    check('project rejection is saved and explained in the student notification', w.ok(w.students[0].email, 'notifications.list').notifications.some((n) => n.body.includes('Please narrow the scope.')));
    check('project screens produce no uncaught browser errors', errors.length === 0);
    console.log('\n' + passed + ' project checks passed.');
  } catch (e) {
    if (student && !student.isClosed()) {
      fs.mkdirSync('.build/shots', { recursive: true });
      await student.screenshot({ path: '.build/shots/projects-failure.png', fullPage: true });
      console.error(await student.locator('body').innerText());
    }
    throw e;
  } finally { if (browser) await browser.close(); dev.server.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
