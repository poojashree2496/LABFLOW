#!/usr/bin/env node
// Focused equipment issue flows against the actual UI and backend on local Google-service fakes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright-core');
const { start } = require('../../dev/server');

(async () => {
  const dev = await start(0, { preset: 'small' });
  const base = dev.base.replace(/\/$/, ''), w = dev.lab.w;
  let browser, page, passed = 0;
  const releases = [];
  const check = (name, condition) => { assert.ok(condition, name); passed++; console.log('PASS ' + name); };
  const stock = (name, categoryId, labId = w.lab2.labId) => w.ok(w.staff, 'assets.upsert', { name, categoryId, labId, quantityTotal: 100 }).asset;
  const booking = (student, resource, labId) => {
    const now = w.eval('U.now()');
    const r = w.ok(student.email, 'booking.request', { labId, resourceType: 'category', resourceId: resource.categoryId, quantity: 1,
      startAt: now + 3600000, endAt: now + 7200000, purpose: 'Issue flow browser test' }).reservation;
    return w.ok(w.staff, 'booking.decide', { reservationId: r.reservationId, approve: true }).reservation;
  };
  async function openIssue(request) {
    await page.goto(base + '/?as=staff@karunya.edu');
    await page.getByRole('heading', { name: 'Lab desk', exact: true }).waitFor();
    await page.evaluate((request) => { LF.sel = { request }; LF.go('desk'); }, request || null);
    await page.getByLabel('Search equipment to add').waitFor();
  }
  async function hold(action, matches) {
    let start, release, finish, used = false;
    const started = new Promise((resolve) => { start = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const finished = new Promise((resolve) => { finish = resolve; });
    releases.push(release);
    const handler = async (route) => {
      const body = route.request().postDataJSON();
      if (used || body.action !== action || !matches(body.payload || {})) return route.continue();
      used = true;
      const response = await route.fetch();
      start(); await gate;
      await route.fulfill({ response }); finish();
    };
    await page.route('**/rpc', handler);
    return { started, release: async () => { release(); await finished; await page.waitForTimeout(100); await page.unroute('**/rpc', handler); } };
  }
  try {
    const category = w.ok(w.staff, 'categories.upsert', { name: 'Context stock', trackingMode: 'quantity' }).category;
    const catA = w.ok(w.staff, 'categories.upsert', { name: 'Context component A', trackingMode: 'quantity' }).category;
    const catB = w.ok(w.staff, 'categories.upsert', { name: 'Context component B', trackingMode: 'quantity' }).category;
    stock('Context IoT stock', category.categoryId, w.lab.labId);
    const gpuStock = stock('Context GPU stock', category.categoryId);
    const oldStock = stock('Context old stock', category.categoryId), newStock = stock('Context new stock', category.categoryId);
    stock('Component A stock', catA.categoryId); stock('Component B stock', catB.categoryId);
    const kitA = w.ok(w.staff, 'kits.upsert', { name: 'Context kit A', labId: w.lab2.labId, components: [{ categoryId: catA.categoryId, quantity: 1 }] }).kit;
    const kitB = w.ok(w.staff, 'kits.upsert', { name: 'Context kit B', labId: w.lab2.labId, components: [{ categoryId: catB.categoryId, quantity: 1 }] }).kit;
    const request = w.ok(w.students[0].email, 'equipment.mine').requests.find((r) => r.status === 'pending');
    assert.ok(request, 'seed includes a pending equipment request');
    const iotBooking = booking(w.students[0], category, w.lab.labId);
    const gpuBooking = booking(w.students[0], category, w.lab2.labId);
    browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chrome' });
    page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));

    await openIssue(request);
    const bookingChoice = page.getByLabel('Collect an advance booking (optional)');
    await bookingChoice.locator('option[value="' + iotBooking.reservationId + '"]').waitFor({ state: 'attached' });
    check('a preselected request borrower loads their approved bookings', await bookingChoice.count() === 1);
    await page.getByLabel('Lab *', { exact: true }).selectOption(w.lab2.labId);
    await page.getByLabel('Search equipment to add').fill('Context GPU');
    await page.getByRole('button', { name: /Context GPU stock/ }).click();
    await page.getByRole('button', { name: 'Issue items', exact: true }).click();
    await page.getByText('Issued.', { exact: true }).waitFor();
    const issued = w.ok(w.staff, 'loans.list', { status: 'active' }).loans.find((l) => l.borrowerId === request.studentId && l.labId === w.lab2.labId);
    check('switching labs detaches the old equipment request before checkout', !!issued && w.ok(w.students[0].email, 'equipment.mine').requests.find((r) => r.requestId === request.requestId).status === 'pending');

    await openIssue(request);
    await page.getByLabel('Issue to', { exact: true }).selectOption('group');
    await page.getByLabel('Issue to', { exact: true }).selectOption('student');
    check('switching borrower type does not silently restore the original request student', await page.getByRole('button', { name: 'Change', exact: true }).count() === 0);

    await openIssue(request);
    const heldBooking = await hold('booking.list', (p) => p.labId === w.lab.labId);
    // Re-select the request to initiate another booking lookup behind the route gate.
    await page.evaluate((request) => { LF.sel = { request }; LF.go('desk'); }, request);
    await heldBooking.started;
    await page.getByLabel('Lab *', { exact: true }).selectOption(w.lab2.labId);
    await bookingChoice.locator('option[value="' + gpuBooking.reservationId + '"]').waitFor({ state: 'attached' });
    await heldBooking.release();
    check('a late booking response from the previous lab cannot replace current choices', await bookingChoice.locator('option[value="' + iotBooking.reservationId + '"]').count() === 0);

    const heldSearch = await hold('assets.list', (p) => p.q === 'Context old');
    await page.getByLabel('Search equipment to add').fill('Context old'); await heldSearch.started;
    await page.getByLabel('Search equipment to add').fill('Context new');
    await page.getByRole('button', { name: /Context new stock/ }).waitFor();
    await heldSearch.release();
    check('a slower old equipment search cannot overwrite the latest result', await page.getByRole('button', { name: /Context new stock/ }).count() === 1 && await page.getByRole('button', { name: /Context old stock/ }).count() === 0);

    const kitChoice = page.getByLabel('Issue a kit (optional)');
    await kitChoice.waitFor();
    const heldComponents = await hold('assets.list', (p) => p.categoryId === catA.categoryId && !p.q);
    await kitChoice.selectOption(kitA.kitId); await heldComponents.started;
    await kitChoice.selectOption(kitB.kitId);
    await page.getByLabel('Context component B × 1', { exact: true }).waitFor();
    await heldComponents.release();
    check('late component loading cannot mix picks from two different kits', await page.getByLabel('Context component A × 1', { exact: true }).count() === 0);

    const requestFor = (resourceType, resourceId, quantity) => {
      const before = w.eval('Settings.get("requireCheckinForRequests")');
      w.ok(w.admin, 'settings.set', { values: { requireCheckinForRequests: false } });
      try { return w.ok(w.students[9].email, 'equipment.request', { labId: w.lab2.labId, resourceType, resourceId, quantity }).request; }
      finally { w.ok(w.admin, 'settings.set', { values: { requireCheckinForRequests: before } }); }
    };
    const checklist = page.getByRole('region', { name: 'Issue checklist' });
    const quantityRequest = requestFor('category', category.categoryId, 2);
    await openIssue(quantityRequest);
    const beforeIssue = w.eval("Db.readAll('Loans').length");
    await page.getByRole('button', { name: 'Issue items', exact: true }).click();
    check('a request checklist names the missing quantity before any stock is issued', /Request · Context stock: 0 \/ 2 selected/.test(await checklist.innerText()) && w.eval("Db.readAll('Loans').length") === beforeIssue);
    await page.getByLabel('Search equipment to add').fill('Context new');
    await page.getByRole('button', { name: /Context new stock/ }).click();
    check('request fulfilment updates as equipment is selected', /Request · Context stock: 1 \/ 2 selected/.test(await checklist.innerText()));
    const quantity = page.getByLabel('Quantity of Context new stock', { exact: true });
    await quantity.fill('101'); await page.getByRole('button', { name: 'Issue items', exact: true }).click();
    check('issue quantities above available stock are explained before submission', /only 100 available; 101 selected/.test(await checklist.innerText()) && w.eval("Db.readAll('Loans').length") === beforeIssue);
    let invalidNumbers = true;
    for (const value of ['-1', '1.5', '']) {
      await quantity.fill(value); await page.getByRole('button', { name: 'Issue items', exact: true }).click();
      invalidNumbers = invalidNumbers && /enter a whole quantity of at least 1/.test(await checklist.innerText());
    }
    check('negative, fractional and blank issue quantities are rejected without rounding', invalidNumbers && w.eval("Db.readAll('Loans').length") === beforeIssue);
    await quantity.fill('3');
    check('extra items beyond a request receive a visible warning', /Extra 1/.test(await checklist.innerText()));
    await quantity.fill('2'); await page.getByRole('button', { name: 'Issue items', exact: true }).click();
    await page.getByText('Issued.', { exact: true }).waitFor();
    check('a complete request issues successfully and its old request banner is cleared',
      w.ok(w.students[9].email, 'equipment.mine').requests.find((r) => r.requestId === quantityRequest.requestId).status === 'fulfilled' && await page.getByText('Filling a request:', { exact: true }).isHidden());

    const devices = w.ok(w.staff, 'categories.upsert', { name: 'Context devices', trackingMode: 'individual' }).category;
    const boards = [1, 2].map((i) => w.ok(w.staff, 'assets.upsert', { labId: w.lab2.labId, categoryId: devices.categoryId, name: 'Context board ' + i, assetTag: 'CTX-BOARD-' + i }).asset);
    const multiKit = w.ok(w.staff, 'kits.upsert', { name: 'Context multi-unit kit', labId: w.lab2.labId, components: [
      { categoryId: devices.categoryId, quantity: 2 }, { categoryId: catB.categoryId, quantity: 3 }
    ] }).kit;
    const kitRequest = requestFor('kit', multiKit.kitId, 1);
    await openIssue(kitRequest); await kitChoice.selectOption(multiKit.kitId);
    const firstBoard = page.getByLabel('Context devices × 1 (item 1 of 2)', { exact: true });
    const secondBoard = page.getByLabel('Context devices × 1 (item 2 of 2)', { exact: true });
    await firstBoard.selectOption(boards[0].assetId); await secondBoard.selectOption(boards[0].assetId);
    check('multi-unit individual kit components get separate picks and reject the same item twice', /Context board 1: only 1 available; 2 selected/.test(await checklist.innerText()));
    await secondBoard.selectOption(boards[1].assetId);
    check('missing kit components stay visible after other components are selected', /Kit · Context component B: 0 \/ 3 selected/.test(await checklist.innerText()));
    const componentStock = w.ok(w.staff, 'assets.list', { labId: w.lab2.labId, categoryId: catB.categoryId }).assets[0];
    await page.getByLabel('Context component B × 3', { exact: true }).selectOption(componentStock.assetId);
    await page.getByLabel('Search equipment to add').fill('Component B stock');
    await page.getByRole('button', { name: /Component B stock/ }).click();
    await page.getByLabel('Quantity of Component B stock', { exact: true }).fill('98');
    check('stock validation combines kit picks and separately added items', /only 100 available; 101 selected/.test(await checklist.innerText()));
    await page.getByRole('button', { name: 'Remove Component B stock', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    fs.mkdirSync('.build/shots', { recursive: true });
    await checklist.screenshot({ path: '.build/shots/issue-checklist-mobile.png' });
    check('issue checklist fits a phone and confirms the complete selection', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1) && /Selection ready/.test(await checklist.innerText()));
    await page.getByRole('button', { name: 'Issue items', exact: true }).click(); await page.getByText('Issued.', { exact: true }).waitFor();
    check('a complete kit with two individual units can be issued from the phone layout', w.ok(w.students[9].email, 'equipment.mine').requests.find((r) => r.requestId === kitRequest.requestId).status === 'fulfilled');
    await page.setViewportSize({ width: 1280, height: 820 });

    const retryRequest = requestFor('category', catA.categoryId, 1);
    await openIssue(retryRequest);
    await page.getByLabel('Search equipment to add').fill('Component A stock'); await page.getByRole('button', { name: /Component A stock/ }).click();
    const issueAttempts = [], beforeRetryLoans = w.eval("Db.readAll('Loans').length");
    let committed, releaseReply;
    const committedReply = new Promise((resolve) => { committed = resolve; });
    const replyGate = new Promise((resolve) => { releaseReply = resolve; }); releases.push(releaseReply);
    const issueRoute = async (route) => {
      const body = route.request().postDataJSON();
      if (body.action !== 'loans.issue') return route.continue();
      issueAttempts.push(JSON.stringify(body.payload));
      if (issueAttempts.length === 1) {
        const response = await route.fetch(); assert.equal((await response.json()).ok, true);
        committed(); await replyGate;
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'INTERNAL', message: 'Issue confirmation interrupted.' } }) });
      }
      if (issueAttempts.length === 2) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'FORBIDDEN', message: 'Temporary test refusal.' } }) });
      return route.continue();
    };
    await page.route('**/rpc', issueRoute);
    await page.getByRole('button', { name: 'Issue items', exact: true }).click(); await committedReply;
    check('borrower, lab and quantities are frozen while an issue is processing', await page.getByLabel('Lab *', { exact: true }).isDisabled() && await page.getByLabel('Quantity of Component A stock', { exact: true }).isDisabled() && await page.getByRole('button', { name: 'Change', exact: true }).isDisabled());
    releaseReply(); await page.getByRole('button', { name: 'Retry issue', exact: true }).waitFor();
    check('an uncertain issue keeps the original selection frozen for confirmation', await page.getByLabel('Quantity of Component A stock', { exact: true }).isDisabled());
    await page.getByRole('button', { name: 'Retry issue', exact: true }).click();
    await page.getByText(/Temporary test refusal/).waitFor();
    check('a later refusal cannot unlock an earlier uncertain issue', await page.getByLabel('Lab *', { exact: true }).isDisabled());
    await page.getByRole('button', { name: 'Retry issue', exact: true }).click();
    await page.getByText('Already issued (same request).', { exact: true }).waitFor();
    await page.unroute('**/rpc', issueRoute);
    check('issue confirmation retries preserve the complete payload and create only one loan', issueAttempts.length === 3 && issueAttempts.every((p) => p === issueAttempts[0]) && w.eval("Db.readAll('Loans').length") === beforeRetryLoans + 1);
    const retriedLoanId = w.eval("Db.get('EquipmentRequests', " + JSON.stringify(retryRequest.requestId) + ").loanId");
    await page.getByRole('button', { name: 'Open loan for return', exact: true }).click();
    const retryReturn = page.getByRole('region', { name: 'Return items' });
    await retryReturn.getByRole('button', { name: 'Return all items', exact: true }).click();
    await retryReturn.getByRole('button', { name: 'Record return', exact: true }).click();
    await page.getByText('Loan closed', { exact: true }).waitFor();
    check('a confirmed retry opens the original loan for return', w.ok(w.staff, 'loans.get', { loanId: retriedLoanId }).loan.status === 'closed');

    const declinedRequest = requestFor('category', catA.categoryId, 1);
    await openIssue(declinedRequest);
    await page.getByLabel('Search equipment to add').fill('Component A stock'); await page.getByRole('button', { name: /Component A stock/ }).click();
    let declined = false;
    const rejectIssue = async (route) => {
      if (route.request().postDataJSON().action !== 'loans.issue' || declined) return route.continue();
      declined = true;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'UNAVAILABLE', message: 'Stock changed before checkout.' } }) });
    };
    await page.route('**/rpc', rejectIssue);
    await page.getByRole('button', { name: 'Issue items', exact: true }).click();
    await page.getByText('Stock changed before checkout.', { exact: true }).waitFor();
    check('a confirmed validation refusal allows the selection to be corrected', await page.getByLabel('Quantity of Component A stock', { exact: true }).isEnabled());
    await page.getByLabel('Quantity of Component A stock', { exact: true }).fill('2');
    await page.getByRole('button', { name: 'Issue items', exact: true }).click(); await page.getByText('Issued.', { exact: true }).waitFor();
    await page.unroute('**/rpc', rejectIssue);
    const declinedFulfilment = w.ok(w.students[9].email, 'equipment.mine').requests.find((r) => r.requestId === declinedRequest.requestId);
    const correctedLoan = w.ok(w.staff, 'loans.get', { loanId: w.eval("Db.get('EquipmentRequests', " + JSON.stringify(declinedRequest.requestId) + ").loanId") }).loan;
    check('corrected checkout uses the new quantity after a definite refusal', declinedFulfilment.status === 'fulfilled' && correctedLoan.items[0].qtyIssued === 2);

    const reserved = ["Alpha", "Beta"].map((name) => w.ok(w.staff, 'assets.upsert', { labId: w.lab2.labId, categoryId: devices.categoryId, name: 'Reserved ' + name, assetTag: 'CTX-RESERVED-' + name }).asset);
    const now = w.eval('U.now()');
    const future = w.ok(w.students[0].email, 'booking.request', { labId: w.lab2.labId, resourceType: 'asset', resourceId: reserved[0].assetId,
      startAt: now + 4 * 3600000, endAt: now + 5 * 3600000, purpose: 'Reserved item collection test' }).reservation;
    w.ok(w.staff, 'booking.decide', { reservationId: future.reservationId, approve: true });
    await openIssue(request); await page.getByLabel('Lab *', { exact: true }).selectOption(w.lab2.labId);
    await bookingChoice.selectOption(future.reservationId);
    const bookingDetails = page.getByRole('region', { name: 'Booking collection details' });
    check('booking selection displays the reserved item and server-defined collection window', /Reserved Alpha/.test(await bookingDetails.innerText()) && future.collectionOpensAt === future.startAt - 7200000);
    check('booking collection uses its end time instead of an editable loan period', await page.getByLabel('Loan period (days)', { exact: true }).isDisabled());
    await page.getByLabel('Search equipment to add').fill('Reserved Alpha');
    await page.getByRole('button', { name: /Reserved Alpha/ }).click();
    const beforeBookingIssue = w.eval("Db.readAll('Loans').length");
    await page.getByRole('button', { name: 'Issue items', exact: true }).click();
    check('early collection is explained before a loan is created', /cannot be collected until/.test(await checklist.innerText()) && w.eval("Db.readAll('Loans').length") === beforeBookingIssue);
    await bookingChoice.selectOption('');
    check('switching back to direct checkout removes booking constraints and re-enables the period', await page.getByLabel('Loan period (days)', { exact: true }).isEnabled() && await bookingDetails.isHidden());

    dev.lab.clock.advance(2 * 3600000 + 60000); dev.lab.sync();
    await page.evaluate((at) => LF.setServerNow(at), w.eval('U.now()'));
    await bookingChoice.selectOption(future.reservationId);
    await page.getByRole('button', { name: 'Remove Reserved Alpha', exact: true }).click();
    await page.getByLabel('Search equipment to add').fill('Reserved Beta'); await page.getByRole('button', { name: /Reserved Beta/ }).click();
    await page.getByRole('button', { name: 'Issue items', exact: true }).click();
    check('a different unit cannot satisfy a named reservation', /Choose reserved item/.test(await checklist.innerText()) && w.eval("Db.readAll('Loans').length") === beforeBookingIssue);
    await page.getByRole('button', { name: 'Remove Reserved Beta', exact: true }).click();
    await page.getByLabel('Search equipment to add').fill('Reserved Alpha'); await page.getByRole('button', { name: /Reserved Alpha/ }).click();
    await page.getByRole('button', { name: 'Issue items', exact: true }).click(); await page.getByText('Issued.', { exact: true }).waitFor();
    const collected = w.ok(w.staff, 'loans.list', { status: 'active' }).loans.find((l) => l.reservationId === future.reservationId);
    check('collecting the exact reserved item fulfils its booking and sets the promised due time', !!collected && collected.dueAt === future.endAt && w.ok(w.students[0].email, 'booking.mine').reservations.find((b) => b.reservationId === future.reservationId).status === 'fulfilled');
    await page.getByRole('button', { name: 'Open loan for return', exact: true }).click();
    const collectedReturn = page.getByRole('region', { name: 'Return items' });
    await collectedReturn.getByLabel('Returned Reserved Alpha', { exact: true }).waitFor();
    check('the success action opens the newly issued loan directly for return', /Reserved Alpha/.test(await collectedReturn.innerText()));
    await collectedReturn.getByRole('button', { name: 'Return all items', exact: true }).click();
    await collectedReturn.getByRole('button', { name: 'Record return', exact: true }).click();
    await page.getByText('Loan closed', { exact: true }).waitFor();

    const oversized = w.ok(w.staff, 'kits.upsert', { name: 'Context oversized kit', labId: w.lab2.labId, components: [{ categoryId: devices.categoryId, quantity: 81 }] }).kit;
    await openIssue(); await page.getByLabel('Lab *', { exact: true }).selectOption(w.lab2.labId);
    await kitChoice.selectOption(oversized.kitId);
    check('oversized kits are explained without creating hundreds of unusable controls', /more than 80 picks/.test(await checklist.innerText()) && await page.getByRole('combobox').count() < 10);
    check('issue flows produce no uncaught browser errors', errors.length === 0);
    console.log('\n' + passed + ' issue checks passed.');
  } catch (e) {
    if (page && !page.isClosed()) {
      fs.mkdirSync('.build/shots', { recursive: true });
      await page.screenshot({ path: '.build/shots/issue-failure.png', fullPage: true });
      console.error(await page.locator('#main').innerText());
    }
    throw e;
  } finally {
    releases.forEach((release) => release());
    if (browser) await browser.close();
    dev.server.close();
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
