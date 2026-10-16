#!/usr/bin/env node
/**
 * Local preview server (NOT part of the Apps Script deployment). It serves the real Index.html/Scripts*.html, and
 * answers google.script.run.rpc(...) by calling the REAL server code (src/*.gs) inside the in-memory Apps Script fakes
 * from test/harness.js. Use it to look at and click through the UI. It proves nothing about Workspace identity, quotas,
 * latency or the HtmlService sandbox - those need a real deployment (see TEST_PLAN.md).
 *
 *   node scripts/dev-server.js [port]      then open  http://localhost:8787/?as=student1@karunya.edu
 * Seeded accounts: admin@karunya.edu, staff@karunya.edu, faculty@karunya.edu, student1..6@karunya.edu, kiosk1@karunya.edu
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { world, NOW } = require('../test/fixtures');

const SRC = path.join(__dirname, '..', 'src');
function seed(w) {
  const A = w.admin, S = w.staff;
  const esp = w.ok(S, 'categories.upsert', { name: 'ESP32 board', trackingMode: 'individual' }).category;
  const wire = w.ok(S, 'categories.upsert', { name: 'Jumper wires', trackingMode: 'quantity' }).category;
  const bb = w.ok(S, 'categories.upsert', { name: 'Breadboard', trackingMode: 'individual' }).category;
  for (let i = 1; i <= 4; i++) w.ok(S, 'assets.upsert', { categoryId: esp.categoryId, labId: w.lab.labId, name: 'ESP32 DevKit', assetTag: 'ESP-' + String(i).padStart(3, '0'), serialNo: 'SN' + i, valueInr: 650, location: 'Cupboard A' });
  for (let i = 1; i <= 3; i++) w.ok(S, 'assets.upsert', { categoryId: bb.categoryId, labId: w.lab.labId, name: 'Breadboard 830', assetTag: 'BB-' + String(i).padStart(3, '0') });
  w.ok(S, 'assets.upsert', { categoryId: wire.categoryId, labId: w.lab.labId, name: 'Jumper wires (M-M)', quantityTotal: 200, assetTag: 'WIRE-MM' });
  w.ok(S, 'kits.upsert', { labId: w.lab.labId, name: 'IoT starter kit', description: 'ESP32, breadboard, wires', components: [{ categoryId: esp.categoryId, quantity: 1 }, { categoryId: bb.categoryId, quantity: 1 }, { categoryId: wire.categoryId, quantity: 10 }] });
  const stu = w.students;
  w.ok(A, 'users.upsert', { email: 'faculty@karunya.edu', displayName: 'Dr Faculty', roles: ['faculty'], employeeCode: 'F001' });
  w.ok(S, 'groups.create', { name: 'Smart-farm team', studentIds: [stu[0].studentId, stu[1].studentId], leaderId: stu[0].studentId, labId: w.lab.labId });
  const now = Date.now() % 1; void now;
  return { esp, wire, bb };
}

function render(file) {
  const read = (n) => fs.readFileSync(path.join(SRC, n + '.html'), 'utf8');
  return read(file).replace(/<\?!= include\('([A-Za-z_]+)'\) \?>/g, (_, n) => read(n));
}

const mockRun = `<script>
(function () {
  var as = new URLSearchParams(location.search).get('as') || 'student1@karunya.edu';
  function chain(ok, bad) { return { withSuccessHandler: function (f) { return chain(f, bad); }, withFailureHandler: function (f) { return chain(ok, f); },
    rpc: function (action, payload) { fetch('/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ as: as, action: action, payload: payload }) })
      .then(function (r) { return r.json(); }).then(function (r) { if (ok) ok(r); }).catch(function (e) { if (bad) bad(e); }); } }; }
  window.google = { script: { run: chain(null, null) } };
})();
</script>`;

function start(port, opts) {
  opts = opts || {};
  const w = world({ students: opts.students || 6 });
  const extra = seed(w);
  const t0 = Date.now();
  const sync = () => w.e.setTime(NOW + (Date.now() - t0));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/') {
      const html = render('Index').replace('<body>', '<body>' + mockRun);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(html);
    }
    if (req.method === 'POST' && url.pathname === '/rpc') {
      let body = ''; req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try { const j = JSON.parse(body); sync(); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(w.call(j.as, j.action, j.payload))); }
        catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: { code: 'INTERNAL', message: String(e.message) } })); }
      }); return;
    }
    res.writeHead(404); res.end('not found');
  });
  return new Promise((resolve) => server.listen(port, () => resolve({ server, w, extra, sync })));
}
module.exports = { start };
if (require.main === module) {
  const port = Number(process.argv[2]) || 8787;
  start(port).then(() => console.log('LABFLOW preview on http://localhost:' + port + '/?as=student1@karunya.edu  (also: admin@, staff@, faculty@, kiosk1@karunya.edu)'));
}
