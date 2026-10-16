#!/usr/bin/env node
/**
 * Local preview server and Test Lab (development only, never deployed).
 *
 *   npm run dev            http://localhost:8787/lab   (Test Lab)
 *                          http://localhost:8787/?as=student1@karunya.edu   (the app as any seeded account)
 *
 * The app pages are the real src/Index.html + Scripts*.html with a mock google.script.run that calls the real server
 * code (src/*.gs) running on in-memory Apps Script fakes. `?as=` picks the identity here only; production has no such
 * parameter. The Test Lab adds a controllable clock, trigger jobs on demand, verification-pipeline fault injection,
 * scenario runs, simulated GPS, a live theme editor and data browsers. None of it proves Workspace identity, quotas,
 * latency or HtmlService behaviour; see docs/testing.md.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createLab, describePipelines, runJob, PRESETS } = require('./world');
const scenarios = require('./scenarios');

const SRC = path.join(__dirname, '..', 'src');
const LAB_DIR = path.join(__dirname, 'lab');
const ID_OK = /^[a-z0-9._%+'-]+@karunya\.edu(\.in)?$/;

function render(file) {
  const read = (n) => fs.readFileSync(path.join(SRC, n + '.html'), 'utf8');
  return read(file).replace(/<\?!= include\('([A-Za-z_]+)'\) \?>/g, (_, n) => read(n));
}
/** Same filtering as launchJson_ in Code.gs: only well-formed codes reach the page. */
function launchJson(q) {
  const out = {};
  const k = q.get('k'), s = q.get('s');
  if (k && /^[A-Za-z0-9._-]{10,200}$/.test(k)) out.k = k;
  if (s && /^[A-Za-z0-9._~-]{40,600}$/.test(s)) out.s = s;
  return JSON.stringify(out).replace(/</g, '\\u003c');
}

/** Injected into app pages served here: the google.script.run mock and the Test Lab hooks. */
function devScript(as) {
  return `<script>
(function () {
  var as = ${JSON.stringify(as)};
  function chain(ok, bad) { return { withSuccessHandler: function (f) { return chain(f, bad); }, withFailureHandler: function (f) { return chain(ok, f); },
    rpc: function (action, payload) { fetch('/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ as: as, action: action, payload: payload }) })
      .then(function (r) { return r.json(); }).then(function (r) { if (ok) ok(r); }).catch(function (e) { if (bad) bad(e); }); } }; }
  window.google = { script: { run: chain(null, null) } };
  window.LF_DEV = { as: as };
  // Simulated location: the Test Lab decides where this "phone" is (inside, outside, spoofed accuracy, denied, or real GPS).
  var realGeo = navigator.geolocation;
  function devPosition(ok, err) {
    fetch('/dev/api/geo').then(function (r) { return r.json(); }).then(function (g) {
      if (g.mode === 'real' && realGeo) return realGeo.getCurrentPosition(ok, err, { enableHighAccuracy: true, timeout: 15000 });
      if (g.mode === 'denied') return err && err({ code: 1, message: 'User denied Geolocation' });
      if (g.mode === 'unavailable') return err && err({ code: 2, message: 'Position unavailable' });
      ok({ coords: { latitude: g.lat, longitude: g.lng, accuracy: g.accuracy }, timestamp: Date.now() });
    }).catch(function () { err && err({ code: 2, message: 'Position unavailable' }); });
  }
  try { Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition: function (ok, err) { devPosition(ok, err); }, watchPosition: function (ok, err) { devPosition(ok, err); return 1; }, clearWatch: function () {} } }); } catch (e) { /* keep the real one */ }
  // Live theme from the Test Lab editor (same origin, so localStorage + storage events reach every app tab and frame).
  function applyDevTheme() { try { var t = JSON.parse(localStorage.getItem('lf-dev-theme') || 'null'); var el = document.getElementById('lf-dev-theme'); if (!el) { el = document.createElement('style'); el.id = 'lf-dev-theme'; document.head.appendChild(el); } el.textContent = t && t.css ? t.css : ''; } catch (e) { /* ignore */ } }
  applyDevTheme(); window.addEventListener('storage', function (e) { if (e.key === 'lf-dev-theme') applyDevTheme(); });
  // QR relay for the Test Lab stage: every QR this page draws is announced; the stage can hand a code to another frame,
  // which then behaves as if its camera had opened the link.
  var bc = 'BroadcastChannel' in window ? new BroadcastChannel('labflow-dev') : null;
  document.addEventListener('DOMContentLoaded', function () {
    var LF = window.LF; if (!LF) return;
    var orig = LF.util.qrSvg;
    LF.util.qrSvg = function (text) { if (bc) bc.postMessage({ type: 'qr', as: as, text: text, at: Date.now() }); return orig(text); };
    if (bc) bc.onmessage = function (m) {
      var d = m.data || {};
      if (d.type === 'open' && d.to === as) {
        var q = (String(d.text).split('?')[1] || '').split('&'), k = '', s = '';
        q.forEach(function (p) { var kv = p.split('='); if (kv[0] === 'k') k = decodeURIComponent(kv[1] || ''); if (kv[0] === 's') s = decodeURIComponent(kv[1] || ''); });
        if (k && LF.kioskCheckin) LF.kioskCheckin(k); else if (s && LF.scanLink) LF.scanLink(s); else if (LF.toast) LF.toast('Not a LABFLOW link', 'bad');
      }
      if (d.type === 'reload') location.reload();
    };
  });
})();
</script>`;
}

function send(res, code, body, type) { res.writeHead(code, { 'content-type': type || 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); }
function readBody(req) { return new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 2e6) req.destroy(); }); req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { resolve({}); } }); }); }
const STATIC = { '/lab': 'index.html', '/lab/': 'index.html', '/lab/lab.js': 'lab.js', '/lab/lab.css': 'lab.css' };
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function start(port, opts) {
  opts = opts || {};
  let lab = null, base = '';
  const build = (preset) => { const t = Date.now(); lab = createLab({ preset: preset || opts.preset || 'demo', baseUrl: base }); lab.buildMs = Date.now() - t; return lab; };
  let jobTimer = null;
  const autoJobs = () => { clearInterval(jobTimer); jobTimer = setInterval(() => { if (lab && lab.autoJobs) { try { runJob(lab, 'tickSessions'); } catch (e) { /* surfaced in the lab's job panel */ } } }, 60000); jobTimer.unref(); };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    try {
      if (req.method === 'GET' && p === '/') {
        const as = url.searchParams.get('as') || 'student1@karunya.edu';
        if (!ID_OK.test(as)) return send(res, 400, 'Bad ?as identity', 'text/plain');
        const html = render('Index').replace('<?!= launch ?>', launchJson(url.searchParams)).replace('<body>', '<body>' + devScript(as));
        return send(res, 200, html, 'text/html; charset=utf-8');
      }
      if (req.method === 'POST' && p === '/rpc') {
        const j = await readBody(req);
        lab.sync();
        return send(res, 200, lab.w.call(String(j.as || ''), String(j.action || ''), j.payload));
      }
      if (req.method === 'GET' && STATIC[p]) { const f = path.join(LAB_DIR, STATIC[p]); return send(res, 200, fs.readFileSync(f), TYPES[path.extname(f)]); }
      if (p.indexOf('/dev/api/') === 0) return api(p.slice(9), req, res, url);
      return send(res, 404, 'not found', 'text/plain');
    } catch (e) { return send(res, 500, { ok: false, error: { code: 'DEV_SERVER', message: String(e && e.message) } }); }
  });

  /* ---------------------------------------------------------------- Test Lab API */
  async function api(name, req, res, url) {
    const body = req.method === 'POST' ? await readBody(req) : {};
    const e = lab.w.e, ev = (code) => JSON.parse(e.run('JSON.stringify(' + code + ')'));
    lab.sync();
    switch (name) {
      case 'state': {
        const users = ev("Db.readAll('Users').map(function(u){ return { email: u.email, name: u.displayName, roles: u.roles }; })");
        const kiosks = ev("Db.readAll('Kiosks').map(function(k){ var l = Db.get('Labs', k.labId) || {}; return { email: k.authorizedEmail, name: k.name, lab: l.code, mode: Labs.modeOf(l) }; })");
        const reps = ev("Db.readAll('ClassReps').filter(function(r){return r.status==='active';}).map(function(r){ return r.studentId; })");
        const coord = ev("Db.readAll('Events').filter(function(x){return x.status==='active';}).map(function(x){ return x.coordinatorEmail; })");
        const labs = ev("Db.readAll('Labs').map(function(l){ return { labId: l.labId, code: l.code, name: l.name, mode: Labs.modeOf(l), latitude: l.latitude, longitude: l.longitude, radiusM: Labs.radiusOf(l) }; })");
        const students = ev("Db.readAll('StudentProfiles').map(function(s){ return { studentId: s.studentId, email: s.email, rollNo: s.rollNo, name: s.name }; })");
        const date = ev('U.local(U.now()).date'), sessions = ev("Db.readAll('Sessions').filter(function(s){ return s.date === " + JSON.stringify(date) + "; }).map(function(s){ var l = Db.get('Labs', s.labId) || {}; return { sessionId: s.sessionId, title: s.title, lab: l.code, status: s.status, start: s.scheduledStart, end: s.scheduledEnd, type: s.type }; })");
        return send(res, 200, { now: lab.clock.now(), paused: lab.clock.paused, preset: lab.preset, presets: Object.keys(PRESETS), buildMs: lab.buildMs, latencyMs: lab.latencyMs, autoJobs: lab.autoJobs, geo: lab.geo,
          users: users.map((u) => Object.assign(u, { classRep: students.some((s) => s.email === u.email && reps.indexOf(s.studentId) >= 0), coordinator: coord.indexOf(u.email) >= 0 })), kiosks, labs, students, sessions, ops: lab.ops });
      }
      case 'clock': {
        const a = body.action;
        if (a === 'advance') lab.clock.advance(Number(body.ms) || 0);
        else if (a === 'set') lab.clock.set(Number(body.ms));
        else if (a === 'pause') lab.clock.pause();
        else if (a === 'resume') lab.clock.resume();
        lab.sync();
        return send(res, 200, { now: lab.clock.now(), paused: lab.clock.paused });
      }
      case 'job': return send(res, 200, { job: body.name, result: runJob(lab, String(body.name)) });
      case 'reset': build(body.preset); return send(res, 200, { ok: true, preset: lab.preset, buildMs: lab.buildMs });
      case 'pipelines': return send(res, 200, { pipelines: describePipelines(lab) });
      case 'fault': {
        const key = String(body.pipeline) + ':' + String(body.step);
        if (!body.mode || body.mode === 'normal') delete lab.faults[key]; else lab.faults[key] = { mode: body.mode, ms: Number(body.ms) || 0 };
        return send(res, 200, { faults: lab.faults });
      }
      case 'faults.clear': lab.faults = {}; return send(res, 200, { faults: {} });
      case 'traces': { const since = Number(url.searchParams.get('since')) || 0; return send(res, 200, { traces: lab.traces.filter((t) => t.id > since) }); }
      case 'latency': lab.latencyMs = Math.max(0, Math.min(400, Number(body.ms) || 0)); return send(res, 200, { latencyMs: lab.latencyMs });
      case 'autojobs': lab.autoJobs = !!body.on; return send(res, 200, { autoJobs: lab.autoJobs });
      case 'geo': {
        if (req.method === 'POST') { lab.geo = Object.assign({}, lab.geo, body); return send(res, 200, lab.geo); }
        const g = lab.geo, labs = lab.labs, baseP = labs[g.lab || 'A'] || labs.A;
        const off = g.mode === 'outside' ? (g.offsetM || 250) : (g.offsetM || 4);
        return send(res, 200, { mode: g.mode, lat: baseP.lat + off / 111320, lng: baseP.lng, accuracy: g.mode === 'spoof' ? 0.5 : (g.accuracy || 12) });
      }
      case 'tables': return send(res, 200, { tables: ev('Object.keys(Cfg.SCHEMA).map(function(t){ return { name: t, rows: Db.count(t), columns: Cfg.SCHEMA[t].map(function(c){ return c.name; }) }; })') });
      case 'table': {
        const t = String(url.searchParams.get('name') || ''); if (!/^[A-Za-z]+$/.test(t)) return send(res, 400, { error: 'bad table' });
        const limit = Math.min(500, Number(url.searchParams.get('limit')) || 200);
        return send(res, 200, { name: t, rows: ev("Db.tail(" + JSON.stringify(t) + ", " + limit + ").reverse()") });
      }
      case 'outbox': return send(res, 200, { mail: e.sentMail.slice(-100).reverse().map((m) => ({ to: m.to, subject: m.subject, body: m.body, attachments: m.o && m.o.attachments ? m.o.attachments.length : 0 })) });
      case 'audit.verify': return send(res, 200, ev('Audit.verify()'));
      case 'audit.tamper': {
        const r = ev("(function(){ var rows = Db.readAll('AuditEvents'); if (rows.length < 3) return { done: false }; var x = rows[Math.floor(rows.length / 2)]; Db.putRow('AuditEvents', x.__row, Object.assign({}, x, { actor: 'someone-else@karunya.edu' })); return { done: true, seq: x.seq }; })()");
        return send(res, 200, r);
      }
      case 'scenarios': return send(res, 200, { scenarios: scenarios.list() });
      case 'scenario': {
        const ids = body.id === 'all' ? scenarios.list().map((s) => s.id) : [String(body.id)];
        const results = [];
        for (const id of ids) results.push(await scenarios.run(id, { faults: lab.faults, latencyMs: body.latency ? lab.latencyMs : 0 }));
        return send(res, 200, { results });
      }
      case 'kioskcode': {
        const k = String(url.searchParams.get('kiosk') || 'kiosk1@karunya.edu'); const r = lab.w.call(k, 'kiosk.display', {});
        return send(res, 200, r.ok ? { code: r.data.code, url: r.data.url, mode: r.data.mode } : { error: r.error });
      }
      default: return send(res, 404, { error: 'unknown dev api ' + name });
    }
  }

  return new Promise((resolve) => server.listen(port, () => {
    base = 'http://localhost:' + server.address().port + '/';
    build(); autoJobs();
    resolve({ server, get lab() { return lab; }, get w() { return lab.w; }, sync: () => lab.sync(), base });
  }));
}
module.exports = { start };

if (require.main === module) {
  const port = Number(process.argv[2]) || 8787;
  const preset = (process.argv.find((a) => a.startsWith('--preset=')) || '').split('=')[1];
  start(port, { preset }).then(({ lab }) => {
    console.log('LABFLOW Test Lab   http://localhost:' + port + '/lab');
    console.log('The app            http://localhost:' + port + '/?as=student1@karunya.edu   (also admin@, staff@, faculty@, kiosk1@karunya.edu)');
    console.log('World "' + lab.preset + '" built in ' + lab.buildMs + ' ms; simulated clock starts Wed 14 Oct 2026, 09:54 IST.');
  });
}
