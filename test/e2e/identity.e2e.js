#!/usr/bin/env node
// Synthetic reference images, isolated browser profiles and local Google-service fakes only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright-core');
const { start } = require('../../dev/server');
(async () => {
  const dev = await start(0, { preset: 'small' }), w = dev.lab.w;
  let browser, staff, admin, student, passed = 0;
  const errors = [], check = (name, ok) => { assert.ok(ok, name); passed++; console.log('PASS ' + name); };
  const email = 'identity.audit@karunya.edu', rollNo = 'IDPHOTO01'; let s;
  const stored = () => w.eval(`Db.get('StudentProfiles',${JSON.stringify(s.studentId)})`);
  const publicStudent = () => w.ok(w.staff, 'students.list', { q: rollNo }).students.find((x) => x.rollNo === rollNo);
  const devices = () => w.ok(w.staff, 'cred.list', { studentId: s.studentId }).credentials;
  const photo = () => w.ok(w.staff, 'photo.get', { studentId: s.studentId }).dataUrl;
  async function login(page, who) { await page.goto(dev.base + '?as=' + who); await page.waitForFunction(() => window.LF && LF.role); }
  async function details(page) { await page.evaluate((p) => LF.showStudent(p), publicStudent()); const d = page.getByRole('dialog'); await d.getByLabel('Take or upload a reference photo', { exact: true }).waitFor(); return d; }
  async function upload(d, color) {
    const data = await d.page().evaluate((color) => { const c = document.createElement('canvas'); c.width = c.height = 32; const x = c.getContext('2d'); x.fillStyle = color; x.fillRect(0, 0, 32, 32); return c.toDataURL('image/jpeg'); }, color);
    await d.getByLabel('Take or upload a reference photo', { exact: true }).setInputFiles({ name: 'synthetic-reference.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(data.split(',')[1], 'base64') });
  }
  async function approval() {
    await staff.evaluate(() => LF.go('queue'));
    const row = staff.getByRole('region', { name: 'Device replacement requests', exact: true }).locator('.row').filter({ hasText: rollNo });
    await row.getByRole('button', { name: 'Approve', exact: true }).click();
    return staff.getByRole('dialog', { name: 'Approve new device for Photo Audit', exact: true });
  }
  try {
    dev.lab.autoJobs = false;
    w.ok(w.admin, 'students.import', { rows: [{ rollNo, name: 'Photo Audit', email }] });
    s = w.ok(email, 'onboard', { rollNo, name: 'Photo Audit', consent: true, mobile: '9876543210' }).student;
    const old = await w.registerDevice({ ...s, email }), pending = await w.registerDevice({ ...s, email });
    browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chrome' });
    staff = await browser.newPage({ viewport: { width: 390, height: 844 } }); admin = await browser.newPage(); student = await browser.newPage({ viewport: { width: 390, height: 844 } });
    for (const p of [staff, admin, student]) p.on('pageerror', (e) => errors.push(e.message));
    await login(staff, w.staff); await login(admin, w.admin); await login(student, email);
    let d = await details(staff);
    check('coordinator has an enabled desk photo upload', await d.getByLabel('Take or upload a reference photo', { exact: true }).isEnabled());
    check('photo review fits a phone', await staff.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await upload(d, '#cc2233'); await d.waitFor({ state: 'hidden' }); const first = photo();
    check('desk upload saves a readable JPEG through the actual file control', first.startsWith('data:image/jpeg;base64,/9j/'));
    d = await details(staff); const img = d.getByRole('img', { name: 'Reference photo of Photo Audit', exact: true });
    await img.waitFor(); await img.evaluate((el) => el.decode());
    check('saved photo renders from the fake private Drive blob', await img.evaluate((el) => el.naturalWidth > 0));
    await student.reload(); await student.waitForFunction(() => window.LF && LF.role); await student.evaluate(() => LF.go('device'));
    await student.getByText('A reference photo is on file (used only for lab spot checks and on the scanner screen).', { exact: true }).waitFor();
    check('verified students cannot replace the desk reference through the UI', await student.getByLabel('Upload a photo', { exact: true }).count() === 0);
    const denied = await student.evaluate(async (photo) => { try { await LF.api('photo.set', { photo }); return 'ALLOWED'; } catch (e) { return e.code; } }, first);
    check('forged student replacement is refused by the server', denied === 'FORBIDDEN' && photo() === first);
    await upload(d, '#2255cc'); await d.waitFor({ state: 'hidden' }); const second = photo();
    check('coordinators can replace an existing verified reference', second !== first);
    d = await details(admin); await upload(d, '#22aa55'); await d.waitFor({ state: 'hidden' }); const third = photo();
    check('super admins can use the same reference-photo control', third !== second);

    d = await approval(); await d.getByRole('button', { name: 'Approve device', exact: true }).click();
    await d.getByRole('alert').filter({ hasText: 'Confirm the ID check first' }).waitFor();
    check('replacement approval still requires an in-person ID confirmation', devices().find((x) => x.credentialId === pending.credentialId).status === 'pending_approval');
    w.ok(w.staff, 'students.status', { studentId: s.studentId, status: 'disabled', reason: 'Disabled during desk review' });
    await d.getByLabel("I have checked the student's ID card in person", { exact: true }).check();
    await d.getByRole('button', { name: 'Approve device', exact: true }).click();
    await d.getByRole('alert').filter({ hasText: 'profile is disabled' }).waitFor();
    check('approval of a newly disabled profile fails inline', await d.getByRole('button', { name: 'Approve device', exact: true }).isEnabled());
    check('refused approval does not replace the old phone', devices().find((x) => x.credentialId === old.credentialId).status === 'active');
    await d.getByRole('button', { name: 'Cancel', exact: true }).click();
    w.ok(w.staff, 'students.status', { studentId: s.studentId, status: 'enabled' });
    d = await approval(); await d.getByLabel("I have checked the student's ID card in person", { exact: true }).check();
    await d.getByRole('button', { name: 'Approve device', exact: true }).click(); await d.waitFor({ state: 'hidden' });
    check('valid approval activates the new phone and replaces the old one', devices().find((x) => x.credentialId === pending.credentialId).status === 'active' && devices().find((x) => x.credentialId === old.credentialId).status === 'replaced');

    const uncertain = await w.registerDevice({ ...s, email }); let interrupted = false;
    await staff.route('**/rpc', async (route) => {
      const body = route.request().postDataJSON();
      if (body.action === 'cred.approve' && body.payload.credentialId === uncertain.credentialId && !interrupted) {
        interrupted = true; const committed = await (await route.fetch()).json(); assert.ok(committed.ok);
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'INTERNAL', message: 'Approval confirmation interrupted.' } }) });
      } else await route.continue();
    });
    d = await approval(); await d.getByLabel("I have checked the student's ID card in person", { exact: true }).check();
    await d.getByRole('button', { name: 'Approve device', exact: true }).click();
    await d.getByRole('alert').filter({ hasText: 'Approval confirmation interrupted.' }).waitFor();
    const savedAt = devices().find((x) => x.credentialId === uncertain.credentialId).approvedAt;
    check('a lost success response leaves an enabled retry in the same review', interrupted && savedAt && await d.getByRole('button', { name: 'Approve device', exact: true }).isEnabled());
    const response = staff.waitForResponse((r) => r.url().endsWith('/rpc') && r.request().postDataJSON().action === 'cred.approve');
    await d.getByRole('button', { name: 'Approve device', exact: true }).click();
    const retried = await (await response).json(); await d.waitFor({ state: 'hidden' });
    check('retry confirms the approved phone without changing its timestamp or reactivating another', retried.ok && retried.data.replayed && devices().filter((x) => x.status === 'active').length === 1 && devices().find((x) => x.credentialId === uncertain.credentialId).approvedAt === savedAt);

    d = await details(staff);
    w.e.run(`Db.update('StudentProfiles',${JSON.stringify(s.studentId)},{importedEmail:''});`);
    w.ok(w.admin, 'students.unlink', { studentId: s.studentId, reason: 'Reclaim while photo dialog is open' });
    w.ok('identity.new@karunya.edu', 'onboard', { rollNo, name: 'New Claim', consent: true, mobile: '9876543211' });
    await upload(d, '#ffffff');
    await staff.getByText('The account linked to this profile changed. Refresh the student list and review it again.', { exact: true }).waitFor();
    check('stale desk photo upload visibly requires a fresh review', await d.isVisible());
    check('stale upload preserves the new claim and existing reference', stored().email === 'identity.new@karunya.edu' && photo() === third);
    check('identity screens have no uncaught browser errors', errors.length === 0);
    console.log('\n' + passed + ' identity browser checks passed.');
  } catch (e) {
    fs.mkdirSync('.build/shots', { recursive: true });
    for (const [name, page] of [['staff', staff], ['admin', admin], ['student', student]]) if (page) { await page.screenshot({ path: '.build/shots/identity-' + name + '-failure.png', fullPage: true }); console.error(name + ': ' + await page.locator('body').innerText()); }
    throw e;
  } finally { if (browser) await browser.close(); dev.server.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
