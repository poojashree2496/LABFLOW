#!/usr/bin/env node
/**
 * Builds the shareable LABFLOW demo: one self-contained HTML page that runs the real server code (src/*.gs) on the
 * browser fakes (dev/artifact/env.js), restored from a snapshot of the Test Lab world, plus the real app UI in frames.
 * The presence replay and the attack scenarios are recorded here in Node and embedded. Before writing, the build boots
 * the bundled engine on the browser fakes and checks the hashing, the audit chain and the check-in flows; any failure
 * stops the build. Development only.
 *
 *   node dev/build-artifact.js [out.html]      (default .build/labflow-demo.html)
 */
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const { createLab } = require('./world');
const scenarios = require('./scenarios');
const presence = require('./presence');
const proxy = require('./proxy');
const { render } = require('../scripts/build-web');
const { LOAD_ORDER, SRC } = require('../test/harness');
const LFENV = require('./artifact/env');
const LFDEMO = require('./artifact/demo');

const OUT = path.resolve(process.argv[2] || path.join(__dirname, '..', '.build', 'labflow-demo.html'));
const DEMO_URL = 'https://labflow.demo/';

/** src/*.gs in load order inside one function, the way Apps Script shares one global scope. */
function engineSource() {
  const body = LOAD_ORDER.map((f) => '/* ---- ' + f + ' ---- */\n' + fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n;\n');
  return 'function LFENGINE(' + LFENV.SERVICE_NAMES.join(', ') + ') {\nvar __testNow, __pipelineObserver;\n' + body +
    '\n;return { rpc: rpc, setNow: function (ms) { __testNow = ms; }, observe: function (f) { __pipelineObserver = f; }, Db: Db, Labs: Labs, U: U, Jobs: Jobs, Audit: Audit };\n}';
}

/** The real app page for an iframe: Index.html with its includes, no launch parameters. */
function appHtml() { return render('Index').replace('<?!= launch ?>', '{}'); }

function check(name, ok, detail) { if (!ok) throw new Error('Self-test failed: ' + name + (detail ? ' -> ' + detail : '')); console.log('ok   ' + name); }

async function selfTest(LFENGINE, snapshot, startNow) {
  for (let n = 0; n < 300; n += 7) {
    const b = nodeCrypto.randomBytes(n), k = nodeCrypto.randomBytes(n % 90);
    if (Buffer.from(LFENV.sha256(b)).toString('hex') !== nodeCrypto.createHash('sha256').update(b).digest('hex')) check('sha256 matches Node at ' + n + ' bytes', false);
    if (Buffer.from(LFENV.hmac(k, b)).toString('hex') !== nodeCrypto.createHmac('sha256', k).update(b).digest('hex')) check('hmac matches Node at ' + n + ' bytes', false);
  }
  check('SHA-256 and HMAC match Node crypto', true);
  const d = LFDEMO(LFENV, LFENGINE, snapshot, startNow);
  const audit = d.auditVerify();
  check('the audit chain from the snapshot verifies', audit.ok !== false && !(audit.problems && audit.problems.length), JSON.stringify(audit).slice(0, 200));
  const st = d.state(), lab = (c) => st.labs.find((l) => l.code === c), iot = lab('IOT01'), gpu = lab('GPU01');
  const free = ['student28@karunya.edu', 'student29@karunya.edu', 'student30@karunya.edu'];
  const status = (r) => { const last = r.steps[r.steps.length - 1]; return last && last.data && last.data.status; };
  const a1 = await d.quick({ labId: iot.labId, student: free[0], method: 'A', geo: { lat: iot.latitude, lng: iot.longitude, accuracy: 10 } });
  check('method A at the IoT lab ends present', status(a1) === 'present', JSON.stringify(a1.steps.filter((s) => !s.ok)));
  check('a pipeline trace is recorded', a1.traces.length >= 2);
  const a2 = await d.quick({ labId: iot.labId, student: free[1], method: 'A', geo: { lat: iot.latitude + 100 / 111320, lng: iot.longitude, accuracy: 10 } });
  check('method A 100 m out ends flagged', status(a2) === 'flagged', status(a2));
  const b1 = await d.quick({ labId: gpu.labId, student: free[2], method: 'B' });
  check('method B on the GPU lab ends present', status(b1) === 'present', JSON.stringify(b1.steps.filter((s) => !s.ok)));
  const tier3 = st.sessions.find((s) => s.lab === 'CMP01' && s.checkinMode === 'C');
  const ro = d.ok('faculty3@karunya.edu', 'attend.roster', { sessionId: tier3.sessionId }).roster.filter((r) => r.state !== 'none').map((r) => r.status).sort();
  check('the phone-app class shows 2 present, 2 partial, 2 flagged', ro.join(',') === 'flagged,flagged,partial,partial,present,present', ro.join(','));
  check('the student dashboard loads', d.call('student1@karunya.edu', 'me').ok);
  check('the 5-minute tick runs', !!d.tick());
}

(async () => {
  const t0 = Date.now();
  const lab = createLab({ preset: 'demo', baseUrl: DEMO_URL });
  const startNow = lab.clock.now();
  const snapshot = LFENV.snapshotOf(lab.w.e);
  const engine = engineSource();
  const LFENGINE = new Function(engine + '\nreturn LFENGINE;')();
  await selfTest(LFENGINE, snapshot, startNow);

  const runs = [presence.run(), presence.run(), presence.run()];
  const proxyRuns = await proxy.runAll();
  const caught = proxyRuns.every((r) => r.cast.every((c) => (c.key === 'asha') === (c.status === 'present')));
  check('every proxy attempt is caught and honest Asha is present in each (' + proxyRuns.length + ' attempts)', caught);
  const sc = [];
  for (const s of scenarios.list()) sc.push(await scenarios.run(s.id));
  console.log('ok   recorded ' + runs.length + ' presence replays and ' + sc.length + ' scenarios (' + sc.filter((r) => r.ok).length + ' as expected)');

  const presenceHtml = fs.readFileSync(path.join(__dirname, 'lab', 'presence.html'), 'utf8')
    .replace("const r = await fetch('/dev/api/presence', { method: 'POST' }); data = await r.json();", 'data = window.PRESENCE_RUNS[(window.__run = ((window.__run || 0) + 1)) % window.PRESENCE_RUNS.length];');
  if (presenceHtml.indexOf('PRESENCE_RUNS') < 0) throw new Error('presence.html changed: update the fetch replacement in build-artifact.js');

  // JSON with every "<" escaped, so nothing inside can close the page's <script> early.
  const js = (v) => JSON.stringify(v).split('<').join('\\u003c').split(String.fromCharCode(0x2028)).join('\\u2028').split(String.fromCharCode(0x2029)).join('\\u2029');
  const data = { snapshot, startNow, app: appHtml(), presence: presenceHtml, presenceRuns: runs, proxyRuns, scenarios: sc, builtAt: new Date().toISOString() };
  const raw = (s) => s.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
  const shell = fs.readFileSync(path.join(__dirname, 'artifact', 'shell.html'), 'utf8');
  const parts = shell.split(/\/\*@(ENV|ENGINE|DEMO|DATA)@\*\//);
  if (parts.length !== 9) throw new Error('shell.html must hold each placeholder once');
  const fill = { ENV: raw(fs.readFileSync(path.join(__dirname, 'artifact', 'env.js'), 'utf8')), ENGINE: raw(engine), DEMO: raw(fs.readFileSync(path.join(__dirname, 'artifact', 'demo.js'), 'utf8')), DATA: 'var LFDATA = ' + js(data) + ';' };
  const html = parts.map((p, i) => (i % 2 ? fill[p] : p)).join('');

  // nothing from the live deployment may ride along in a page that gets shared: the live values sit in the
  // git-ignored src/Local_*.gs, and no deployment id or owner email may appear either
  const live = fs.readdirSync(SRC).filter((f) => /^Local_.*\.gs$/.test(f)).flatMap((f) => fs.readFileSync(path.join(SRC, f), 'utf8').match(/'[^']{12,}'/g) || []).map((q) => q.slice(1, -1));
  const leaks = live.filter((v) => html.includes(v)).concat([/AKfycb[\w-]{20,}/, /amohamed/i].filter((re) => re.test(html)).map(String));
  if (leaks.length) throw new Error('Live deployment details found in the page: ' + leaks.join(', '));

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, html);
  console.log('wrote ' + OUT + ' (' + Math.round(html.length / 1024) + ' KB) in ' + (Date.now() - t0) + ' ms');
})().catch((e) => { console.error(e.message || e); process.exit(1); });
