/* LABFLOW Test Lab (development only). Drives the local world through /dev/api and the real app in frames.
   Sections: Overview (clock, jobs, identities, world), Stage (kiosk + phones side by side with a QR relay and simulated
   GPS), Pipelines (fault injection + live traces), Scenarios (scripted runs), Theme (live token editor), Data. */
(function () {
'use strict';

/* ------------------------------------------------------------------ tiny DOM + API helpers */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) for (const k of Object.keys(props)) {
    const v = props[k];
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  (function add(list) { list.forEach((c) => { if (c === null || c === undefined || c === false) return; if (Array.isArray(c)) add(c); else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c))); }); })(kids);
  return el;
}
const $ = (s) => document.querySelector(s);
const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
async function api(name, body) {
  const r = await fetch('/dev/api/' + name, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json(); if (!r.ok) throw new Error(j.error || j.message || 'request failed'); return j;
}
function toast(msg, bad) { const t = h('div', { class: 'toast' + (bad ? ' bad' : '') }, msg); $('#toasts').appendChild(t); setTimeout(() => t.remove(), bad ? 6000 : 3000); }
const IST = 330 * 60000;
const fmtTime = (ms) => new Date(ms + IST).toISOString().slice(11, 19);
const fmtDate = (ms) => { const d = new Date(ms + IST); return d.toUTCString().slice(0, 11) + ' ' + d.toISOString().slice(0, 10).slice(0, 4); };
const btn = (label, onClick, cls) => h('button', { class: 'btn ' + (cls || ''), onclick: async (e) => { const b = e.currentTarget; b.disabled = true; try { await onClick(e); } catch (x) { toast(String(x.message || x), true); } finally { b.disabled = false; } } }, label);
const appUrl = (as, extra) => '/?as=' + encodeURIComponent(as) + (extra || '');

let state = null, timers = [];
const every = (ms, fn) => { const t = setInterval(fn, ms); timers.push(t); return t; };
async function refreshState() { state = await api('state'); drawClock(); return state; }
function drawClock() {
  if (!state) return;
  const c = $('#clock'); clear(c).append(fmtDate(state.now) + '  ' + fmtTime(state.now) + ' IST' + (state.paused ? '  (paused)' : ''), h('small', null, 'simulated clock · world "' + state.preset + '"'));
}
setInterval(() => { if (state && !state.paused) { state.now += 1000; drawClock(); } }, 1000);

/* ------------------------------------------------------------------ sections */
const SECTIONS = [
  { id: 'overview', label: 'Overview', render: overview },
  { id: 'stage', label: 'Stage (simulate a class)', render: stage },
  { id: 'pipeline', label: 'Verification pipeline', render: pipelines },
  { id: 'scenarios', label: 'Scenario runs', render: scenariosView },
  { id: 'theme', label: 'Site themes', render: themeView },
  { id: 'data', label: 'Data and mail', render: dataView }
];
let current = null;
function go(id) {
  timers.forEach(clearInterval); timers = [];
  current = SECTIONS.find((s) => s.id === id) || SECTIONS[0];
  try { history.replaceState(null, '', '#' + current.id); } catch (e) { /* ignore */ }
  clear($('#nav')).append(...SECTIONS.map((s) => h('button', { 'aria-current': s.id === current.id ? 'page' : null, onclick: () => go(s.id) }, s.label)), h('div', { class: 'hint' }, 'Development only. Nothing here exists in the deployed app.'));
  const main = clear($('#main')); current.render(main); main.focus({ preventScroll: true });
}

/* ------------------------------------------------------------------ Overview */
function overview(root) {
  root.append(h('h1', null, 'Overview'), h('p', { class: 'lead' }, 'The real LABFLOW server code runs here on in-memory fakes of Google Sheets, Cache, Lock, Mail and Drive. Move the clock, run the background jobs, rebuild the world and open the app as anyone.'));
  const grid = h('div', { class: 'grid' }); root.append(grid);
  const clockP = h('section', { class: 'panel stack' }, h('h2', null, 'Clock'), h('p', { class: 'hint' }, 'The simulated day runs in real time. Jump it forward to reach the next class, a rescan window, closing time or tomorrow.'));
  const adv = (label, ms) => btn(label, async () => { await api('clock', { action: 'advance', ms }); await refreshState(); toast('Clock moved ' + label); });
  const dt = h('input', { class: 'input', type: 'datetime-local' });
  clockP.append(h('div', { class: 'row' }, adv('+1 min', 60000), adv('+5 min', 300000), adv('+30 min', 1800000), adv('+1 h', 3600000), adv('+1 day', 86400000)),
    h('div', { class: 'row' }, dt, btn('Set (IST)', async () => { if (!dt.value) return; const ms = Date.parse(dt.value + ':00Z') - IST; await api('clock', { action: 'set', ms }); await refreshState(); toast('Clock set'); })),
    h('div', { class: 'row' }, btn('Pause', async () => { await api('clock', { action: 'pause' }); await refreshState(); }), btn('Resume', async () => { await api('clock', { action: 'resume' }); await refreshState(); })));
  const jobs = h('section', { class: 'panel stack' }, h('h2', null, 'Background jobs'), h('p', { class: 'hint' }, 'The same trigger handlers Apps Script runs. The 5-minute tick opens timetabled classes, starts random rescans, closes stale sessions, releases no-show bookings and sends overstay alerts.'));
  const out = h('pre', { class: 'mono hint', style: { maxHeight: '220px', overflow: 'auto' } });
  const job = (name, label) => btn(label, async () => { const r = await api('job', { name }); out.textContent = name + ': ' + JSON.stringify(r.result, null, 1); toast(label + ' finished'); });
  const auto = h('input', { type: 'checkbox', checked: state.autoJobs, onchange: async (e) => { await api('autojobs', { on: e.target.checked }); toast(e.target.checked ? 'Tick runs every minute' : 'Automatic tick off'); } });
  jobs.append(h('div', { class: 'row' }, job('tickSessions', 'Tick (5 min)'), job('sendEmails', 'Send emails'), job('morning', 'Morning'), job('evening', 'Evening digest'), job('nightly', 'Nightly')), h('label', { class: 'row hint' }, auto, 'Run the tick automatically every real minute'), out);
  const worldP = h('section', { class: 'panel stack' }, h('h2', null, 'World'), h('p', { class: 'hint' }, 'Rebuilds everything from scratch: four labs (IoT in kiosk QR + GPS mode, GPU in device-QR mode, Computing with both, and Intel Unnati AI Lab with placeholder inventory and live project/system visits), a weekly timetable, students, inventory, a class representative, a workshop with a coordinator and past attendance.'));
  const preset = h('select', { class: 'input' }, state.presets.map((p) => h('option', { value: p, selected: p === state.preset }, p)));
  const lat = h('input', { type: 'range', min: 0, max: 200, step: 5, value: state.latencyMs }), latV = h('span', { class: 'mono' }, state.latencyMs + ' ms');
  lat.addEventListener('input', () => { latV.textContent = lat.value + ' ms'; });
  lat.addEventListener('change', async () => { await api('latency', { ms: Number(lat.value) }); toast('Each sheet read or write now takes ' + lat.value + ' ms'); });
  worldP.append(h('div', { class: 'row' }, preset, btn('Rebuild world', async () => { toast('Building...'); const r = await api('reset', { preset: preset.value }); await refreshState(); toast('World "' + r.preset + '" built in ' + r.buildMs + ' ms'); go('overview'); }, 'gold')),
    h('label', { class: 'f' }, 'Simulated latency per sheet read/write', h('div', { class: 'row' }, lat, latV)), h('div', { class: 'hint' }, 'Sheet operations so far: ' + state.ops.read + ' reads, ' + state.ops.write + ' writes. Apps Script typically spends tens of milliseconds on each.'),
    h('div', { class: 'hint' }, 'Built in ' + state.buildMs + ' ms.'));
  const ids = h('section', { class: 'panel stack' }, h('h2', null, 'Open the app as...'), h('p', { class: 'hint' }, 'Each link opens a tab signed in as that account (identity switching exists only on this local server).'));
  const groups = { admin: [], hod: [], staff: [], faculty: [], student: [] };
  state.users.forEach((u) => { const r = String(u.roles).split(',')[0]; (groups[r] || groups.student).push(u); });
  Object.keys(groups).forEach((g) => { if (!groups[g].length) return; ids.append(h('h3', null, g), h('div', { class: 'row' }, groups[g].slice(0, g === 'student' ? 12 : 10).map((u) => h('a', { class: 'btn sm', href: appUrl(u.email), target: '_blank', rel: 'noopener', title: u.email }, (u.name || u.email) + (u.classRep ? ' · CR' : '') + (u.coordinator ? ' · coordinator' : ''))))); });
  ids.append(h('h3', null, 'kiosks'), h('div', { class: 'row' }, state.kiosks.map((k) => h('a', { class: 'btn sm', href: appUrl(k.email), target: '_blank', rel: 'noopener' }, k.name + ' (' + k.lab + ', mode ' + k.mode + ')'))));
  const today = h('section', { class: 'panel stack' }, h('h2', null, 'Sessions on the simulated day'), h('table', null, h('thead', null, h('tr', null, ['Time', 'Lab', 'Session', 'Type', 'Status'].map((x) => h('th', null, x)))),
    h('tbody', null, state.sessions.sort((a, b) => a.start - b.start).map((s) => h('tr', null, h('td', { class: 'mono' }, fmtTime(s.start).slice(0, 5) + '-' + fmtTime(s.end).slice(0, 5)), h('td', null, s.lab), h('td', null, s.title), h('td', null, s.type), h('td', null, h('span', { class: 'chip ' + (s.status === 'open' ? 'ok' : s.status === 'closed' ? '' : 'idle') }, s.status)))))));
  grid.append(clockP, jobs, worldP, ids, today);
}

/* ------------------------------------------------------------------ Stage: kiosk + phones + relay */
const relay = { items: {}, listeners: [] };
const bc = 'BroadcastChannel' in window ? new BroadcastChannel('labflow-dev') : null;
if (bc) bc.onmessage = (m) => { const d = m.data || {}; if (d.type === 'qr') { relay.items[d.as] = d; relay.listeners.forEach((f) => f()); } };
function stage(root) {
  root.append(h('h1', null, 'Stage'), h('p', { class: 'lead' }, 'Run a lab session end to end in real browsers with real WebCrypto keys. The kiosk, a student\'s phone and a teacher\'s phone are live app frames. Pointing a camera is simulated: the relay hands the latest QR a frame drew to another frame, exactly as if its camera app had opened the link.'));
  const students = state.users.filter((u) => String(u.roles).indexOf('student') >= 0);
  const rank = (u) => /faculty/.test(u.roles) ? 0 : /staff/.test(u.roles) ? 1 : /admin/.test(u.roles) ? 2 : 3;
  const teachers = state.users.filter((u) => /faculty|staff|admin/.test(u.roles)).concat(students.filter((u) => u.classRep || u.coordinator)).sort((a, b) => rank(a) - rank(b));
  const kSel = h('select', { class: 'input' }, state.kiosks.map((k) => h('option', { value: k.email }, k.name + ' (' + k.lab + ', ' + k.mode + ')')));
  const pSel = h('select', { class: 'input' }, students.map((u) => h('option', { value: u.email }, (u.name || u.email) + (u.classRep ? ' (CR)' : '') + (u.coordinator ? ' (coordinator)' : ''))));
  const tSel = h('select', { class: 'input' }, teachers.map((u) => h('option', { value: u.email }, (u.name || u.email) + ' · ' + u.roles)));
  const kFrame = h('iframe', { title: 'Kiosk screen', src: appUrl(kSel.value) }), pFrame = h('iframe', { title: 'Student phone', src: appUrl(pSel.value) }), tFrame = h('iframe', { title: 'Teacher phone', src: appUrl(tSel.value) });
  kSel.addEventListener('change', () => { kFrame.src = appUrl(kSel.value); }); pSel.addEventListener('change', () => { pFrame.src = appUrl(pSel.value); drawRelay(); }); tSel.addEventListener('change', () => { tFrame.src = appUrl(tSel.value); drawRelay(); });
  const relayBox = h('div', { class: 'relay' });
  function drawRelay() {
    const items = Object.values(relay.items).sort((a, b) => b.at - a.at).slice(0, 6);
    clear(relayBox).append(...(items.length ? items.map((d) => {
      const isKiosk = /[?&]k=/.test(d.text), age = Math.round((Date.now() - d.at) / 1000);
      return h('div', { class: 'item' }, h('div', { class: 'row' }, h('span', { class: 'chip ' + (isKiosk ? 'warn' : 'ok') }, isKiosk ? 'kiosk QR' : 'student QR'), h('span', { class: 'hint' }, d.as + ' · ' + age + ' s ago')),
        h('div', { class: 'mono hint', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, d.text),
        h('div', { class: 'row' }, isKiosk ? btn('Student phone scans it', () => { bc.postMessage({ type: 'open', to: pSel.value, text: d.text }); toast('Opened on ' + pSel.value); }, 'primary sm')
          : btn('Teacher phone scans it', () => { bc.postMessage({ type: 'open', to: tSel.value, text: d.text }); toast('Opened on ' + tSel.value); }, 'primary sm'),
          isKiosk ? btn('Teacher scans it', () => { bc.postMessage({ type: 'open', to: tSel.value, text: d.text }); }, 'sm') : btn('Student phone scans it', () => { bc.postMessage({ type: 'open', to: pSel.value, text: d.text }); }, 'sm')));
    }) : [h('div', { class: 'hint' }, 'Waiting for a QR. Kiosks in mode A draw one every few seconds; a student draws one with "Show my QR".')]));
  }
  relay.listeners = [drawRelay]; drawRelay(); every(2000, drawRelay);
  // simulated GPS for every phone frame
  const g = state.geo;
  const mode = h('select', { class: 'input' }, [['inside', 'Inside the lab'], ['outside', 'Outside (250 m away)'], ['spoof', 'Faked (0.5 m accuracy)'], ['denied', 'Permission denied'], ['unavailable', 'No fix'], ['real', 'Real device GPS']].map(([v, l]) => h('option', { value: v, selected: v === g.mode }, l)));
  const labSel = h('select', { class: 'input' }, [['A', 'IoT lab'], ['B', 'GPU lab'], ['C', 'Computing lab'], ['UNNATI', 'Unnati lab (demo GPS)']].map(([v, l]) => h('option', { value: v, selected: v === (g.lab || 'A') }, l)));
  const acc = h('input', { class: 'input', type: 'number', min: 1, max: 200, value: g.accuracy || 12, style: { width: '80px' } }), off = h('input', { class: 'input', type: 'number', min: 0, max: 2000, value: g.offsetM || 4, style: { width: '80px' } });
  const saveGeo = async () => { await api('geo', { mode: mode.value, lab: labSel.value, accuracy: Number(acc.value), offsetM: Number(off.value) }); toast('Phones now report: ' + mode.options[mode.selectedIndex].text); };
  [mode, labSel, acc, off].forEach((x) => x.addEventListener('change', saveGeo));
  root.append(h('div', { class: 'panel row', style: { marginBottom: '14px' } }, h('strong', null, 'Phone location'), mode, h('span', { class: 'hint' }, 'near'), labSel, h('span', { class: 'hint' }, 'distance m'), off, h('span', { class: 'hint' }, 'accuracy m'), acc,
    btn('+5 min', async () => { await api('clock', { action: 'advance', ms: 300000 }); await refreshState(); }, 'sm'), btn('Run tick', async () => { await api('job', { name: 'tickSessions' }); toast('Tick ran'); }, 'sm')));
  root.append(h('div', { class: 'stage' },
    h('section', null, h('div', { class: 'frame-head' }, h('h2', null, 'Kiosk screen'), kSel), h('div', { class: 'screen' }, kFrame), h('section', { class: 'panel', style: { marginTop: '14px' } }, h('h2', null, 'QR relay (simulated camera)'), relayBox)),
    h('section', null, h('div', { class: 'frame-head' }, h('h2', null, 'Student phone'), pSel), h('div', { class: 'device' }, pFrame)),
    h('section', null, h('div', { class: 'frame-head' }, h('h2', null, 'Teacher / staff / CR phone'), tSel), h('div', { class: 'device' }, tFrame))));
}

/* ------------------------------------------------------------------ Pipelines: fault injection + traces */
const PIPE_LABEL = { 'A.open': 'Version A: page opens with the kiosk code', 'A.checkin': 'Version A: check-in with location', 'B.scan': 'Version B: device QR scanned' };
function pipelines(root) {
  root.append(h('h1', null, 'Verification pipeline'), h('p', { class: 'lead' }, 'Every check-in runs an ordered list of checks; the last ones (marked) run inside the script lock. Make a step fail, skip it, or slow it down here, then check in from the Stage or run a scenario to see what changes. Faults apply only to this local server; the deployed code always runs every step.'));
  const grid = h('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' } }), traces = h('div', { class: 'stack' });
  root.append(h('div', { class: 'row', style: { marginBottom: '12px' } }, btn('Reset all steps to normal', async () => { await api('faults.clear', {}); draw(); toast('All steps normal'); })), grid, h('h2', { style: { marginTop: '18px' } }, 'Live traces'), h('p', { class: 'hint' }, 'Newest first. Green ran and passed, red decided the refusal, purple was skipped, grey never ran.'), traces);
  async function draw() {
    const { pipelines: P } = await api('pipelines');
    clear(grid).append(...Object.keys(P).map((name) => h('section', { class: 'panel stack' }, h('h2', null, PIPE_LABEL[name] || name), h('div', { class: 'stack' }, P[name].map((s) => {
      const sel = h('select', { class: 'input', 'aria-label': 'Mode for ' + s.id }, ['normal', s.skippable ? 'skip' : null, 'fail', 'delay'].filter(Boolean).map((m) => h('option', { value: m, selected: m === s.mode }, m)));
      const ms = h('input', { class: 'input', type: 'number', min: 0, max: 5000, step: 100, value: s.ms || 800, style: { width: '76px' }, hidden: s.mode !== 'delay' });
      const save = async () => { ms.hidden = sel.value !== 'delay'; await api('fault', { pipeline: name, step: s.id, mode: sel.value, ms: Number(ms.value) }); draw(); };
      sel.addEventListener('change', save); ms.addEventListener('change', save);
      return h('div', { class: 'step' + (s.locked ? ' locked' : '') + (s.mode !== 'normal' ? ' faulted' : '') }, h('div', null, h('div', { class: 'id' }, s.id + (s.locked ? '  · locked' : '')), h('div', { class: 'hint' }, s.label)), h('div', { class: 'row' }, sel, ms));
    })))));
  }
  let since = 0; const seen = [];
  async function poll() {
    try {
      const r = await api('traces' + '?since=' + since);
      if (!r.traces.length) return;
      since = r.traces[r.traces.length - 1].id; seen.unshift(...r.traces.reverse()); seen.length = Math.min(seen.length, 40);
      const P = (await api('pipelines')).pipelines;
      clear(traces).append(...seen.map((t) => {
        const all = P[t.pipeline] || P['B.scan'], ran = {}; t.trace.forEach((x) => { ran[x.id] = x; });
        return h('div', { class: 'trace ' + (t.ok ? 'ok' : 'bad') }, h('div', { class: 'row' }, h('strong', null, PIPE_LABEL[t.pipeline] || t.pipeline), h('span', { class: 'chip ' + (t.ok ? 'ok' : 'bad') }, t.ok ? 'accepted' : t.code), h('span', { class: 'hint mono' }, fmtTime(t.at)), t.subject && t.subject.studentId ? h('span', { class: 'hint mono' }, t.subject.studentId) : null, t.message && !t.ok ? h('span', { class: 'hint' }, t.message) : null),
          h('div', { class: 'chain' }, all.map((s) => { const x = ran[s.id], skipped = (t.skipped || []).indexOf(s.id) >= 0; return h('span', { class: 'chip ' + (skipped ? 'skip' : !x ? 'idle' : x.ok ? 'ok' : 'bad'), title: x ? x.ms + ' ms' : 'not reached' }, s.id + (x && x.ms > 20 ? ' ' + x.ms + 'ms' : '')); })));
      }));
    } catch (e) { /* server restarting */ }
  }
  draw(); poll(); every(1500, poll);
}

/* ------------------------------------------------------------------ Scenarios */
function scenariosView(root) {
  root.append(h('h1', null, 'Scenario runs'), h('p', { class: 'lead' }, 'Scripted runs of the class rush and every attack from the SRS (section 15.4), each in a fresh world with the expected and actual outcome. They use your current pipeline faults: switch a check off on the pipeline page and run again to see which attacks start getting through.'));
  const opts = { latency: h('input', { type: 'checkbox' }) };
  const out = h('div', { class: 'stack' }), summary = h('div', { class: 'row' });
  root.append(h('div', { class: 'panel row', style: { marginBottom: '12px' } }, btn('Run all', () => run('all'), 'gold'), h('label', { class: 'row hint' }, opts.latency, 'Apply the simulated sheet latency (slower, realistic timings)'), summary), out);
  const results = {};
  function render(list) {
    const groups = {};
    list.forEach((s) => { (groups[s.group] = groups[s.group] || []).push(s); });
    clear(out).append(...Object.keys(groups).map((g) => h('section', { class: 'panel stack' }, h('h2', null, g), groups[g].map((s) => {
      const r = results[s.id];
      const box = h('div', { class: 'result' + (r ? (r.ok ? ' ok' : ' bad') : '') });
      const body = h('div', { class: 'body', hidden: !r || r.ok });
      box.append(h('header', { onclick: () => { body.hidden = !body.hidden; } }, h('div', null, h('strong', null, s.title), ' ', h('span', { class: 'hint' }, s.srs)),
        h('div', { class: 'row' }, r ? h('span', { class: 'chip ' + (r.ok ? 'ok' : 'bad') }, r.ok ? 'as expected' : 'UNEXPECTED') : h('span', { class: 'chip idle' }, 'not run'), r ? h('span', { class: 'hint mono' }, r.ms + ' ms') : null, btn('Run', (e) => { e.stopPropagation(); return run(s.id); }, 'sm'))), body);
      if (r) body.append(...r.steps.map((x) => h('div', { class: 'row' }, h('span', { class: 'chip ' + (x.ok ? 'ok' : 'bad') }, x.ok ? 'ok' : 'differs'), h('span', null, x.label), h('span', { class: 'hint' }, 'expected ' + x.expected + ', got ' + x.actual + (x.error ? ' (' + x.error + ')' : '')))),
        ...r.notes.map((n) => h('div', { class: 'hint' }, 'Note: ' + n)), r.crashed ? h('div', { class: 'chip bad' }, 'crashed: ' + r.crashed) : null, r.faults.length ? h('div', { class: 'hint' }, 'Ran with faults: ' + r.faults.join(', ')) : null);
      return box;
    }))));
    const done = Object.values(results), bad = done.filter((x) => !x.ok).length;
    clear(summary).append(done.length ? h('span', { class: 'chip ' + (bad ? 'bad' : 'ok') }, (done.length - bad) + ' of ' + done.length + ' as expected') : null);
  }
  let list = [];
  async function run(id) { toast(id === 'all' ? 'Running all scenarios...' : 'Running...'); const r = await api('scenario', { id, latency: opts.latency.checked }); r.results.forEach((x) => { results[x.id] = x; }); render(list); }
  api('scenarios').then((r) => { list = r.scenarios; render(list); });
}

/* ------------------------------------------------------------------ Site themes */
/** Switches the site theme the way the administrator does (settings.set as admin) and shows it live. */
async function asUser(as, action, payload) {
  const r = await (await fetch('/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ as, action, payload }) })).json();
  if (!r.ok) throw new Error(r.error ? r.error.message : 'request failed'); return r.data;
}
function themeView(root) {
  try { localStorage.removeItem('lf-dev-theme'); } catch (e) { /* old token-editor overrides, no longer used */ }
  root.append(h('h1', null, 'Site themes'), h('p', { class: 'lead' }, 'The administrator picks one theme for everyone (Settings > Appearance). Pick one here to switch this world, as the admin would, and look at it as any role.'));
  const preview = h('iframe', { title: 'Theme preview', src: appUrl('admin@karunya.edu'), style: { width: '100%', height: '760px', border: '0', borderRadius: '8px', background: '#fff' } });
  const previewAs = h('select', { class: 'input' }, ['admin@karunya.edu', 'faculty@karunya.edu', 'staff@karunya.edu', 'student1@karunya.edu', 'kiosk1@karunya.edu'].map((a) => h('option', { value: a }, a)));
  previewAs.addEventListener('change', () => { preview.src = appUrl(previewAs.value); });
  const list = h('div', { class: 'stack' });
  async function draw() {
    const s = (await asUser('admin@karunya.edu', 'settings.get', {})).settings.find((x) => x.key === 'uiTheme');
    clear(list).append(...s.values.map((id) => btn((id === s.value ? '● ' : '') + id.replace(/-/g, ' '), async () => {
      await asUser('admin@karunya.edu', 'settings.set', { values: { uiTheme: id } }); toast('Theme: ' + id); preview.src = appUrl(previewAs.value); draw();
    }, id === s.value ? 'primary' : '')));
  }
  draw().catch((e) => toast(String(e.message || e), true));
  root.append(h('div', { style: { display: 'grid', gap: '14px', gridTemplateColumns: 'minmax(200px, 260px) minmax(0, 1fr)', alignItems: 'start' } },
    h('section', { class: 'panel stack' }, h('h2', null, 'Theme'), list),
    h('section', { class: 'panel stack', style: { position: 'sticky', top: '76px' } }, h('div', { class: 'row' }, h('h2', null, 'Live preview'), previewAs), preview)));
}

/* ------------------------------------------------------------------ Data and mail */
function dataView(root) {
  root.append(h('h1', null, 'Data and mail'), h('p', { class: 'lead' }, 'The fake Google Sheet behind this world, the mail the server has "sent", and the audit chain. Try the tamper button, then verify.'));
  const grid = h('div', { class: 'grid' }), tableBox = h('div', { class: 'stack' }), mailBox = h('div', { class: 'stack' }), auditBox = h('div', { class: 'stack' });
  root.append(grid);
  grid.append(h('section', { class: 'panel stack', style: { gridColumn: '1 / -1' } }, h('h2', null, 'Sheets'), tableBox), h('section', { class: 'panel stack' }, h('h2', null, 'Outbox'), mailBox), h('section', { class: 'panel stack' }, h('h2', null, 'Audit chain'), auditBox));
  api('tables').then((r) => {
    const sel = h('select', { class: 'input' }, r.tables.map((t) => h('option', { value: t.name }, t.name + ' (' + t.rows + ')'))), out = h('div', { class: 'scroll' });
    const load = async () => {
      const d = await api('table?name=' + encodeURIComponent(sel.value) + '&limit=200'), cols = (r.tables.find((t) => t.name === sel.value) || {}).columns || [];
      clear(out).append(d.rows.length ? h('table', null, h('thead', null, h('tr', null, cols.map((c) => h('th', null, c)))), h('tbody', null, d.rows.map((row) => h('tr', null, cols.map((c) => { const v = row[c]; return h('td', { class: typeof v === 'number' && v > 1e12 ? 'mono' : null }, v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : typeof v === 'number' && v > 1e12 ? fmtDate(v) + ' ' + fmtTime(v) : String(v)); }))))) : h('div', { class: 'hint', style: { padding: '10px' } }, 'Empty.'));
    };
    sel.addEventListener('change', load); tableBox.append(h('div', { class: 'row' }, sel, btn('Reload', load, 'sm'), h('span', { class: 'hint' }, 'Newest first, up to 200 rows.')), out); load();
  });
  const loadMail = async () => { const r = await api('outbox'); clear(mailBox).append(h('div', { class: 'row' }, btn('Reload', loadMail, 'sm')), ...(r.mail.length ? r.mail.map((m) => h('details', { class: 'panel' }, h('summary', null, h('strong', null, m.subject), h('span', { class: 'hint' }, ' to ' + m.to + (m.attachments ? ' · ' + m.attachments + ' attachment' : ''))), h('pre', { class: 'hint', style: { marginTop: '6px' } }, m.body))) : [h('div', { class: 'hint' }, 'Nothing sent yet. Run "Send emails", "Morning" or "Evening digest" on the overview.')])); };
  loadMail();
  const verify = async () => { const v = await api('audit.verify'); clear(verifyOut).append(h('span', { class: 'chip ' + (v.ok ? 'ok' : 'bad') }, v.ok ? 'chain intact' : 'PROBLEM FOUND'), h('div', { class: 'hint' }, v.rows + ' rows, head #' + v.headSeq), ...v.chainProblems.concat(v.checkpointProblems).slice(0, 5).map((p) => h('div', { class: 'hint' }, '#' + p.seq + ': ' + p.problem))); };
  const verifyOut = h('div', { class: 'stack' });
  auditBox.append(h('p', { class: 'hint' }, 'Each audit row stores a hash of the previous one. Editing a row by hand (as the sheet owner could) breaks every later hash.'), h('div', { class: 'row' }, btn('Verify chain', verify, 'primary'), btn('Tamper with a row', async () => { const r = await api('audit.tamper', {}); toast(r.done ? 'Edited audit row #' + r.seq + ' directly in the sheet' : 'Not enough rows yet'); }, 'danger')), verifyOut);
}

/* ------------------------------------------------------------------ boot */
clear($('#top-actions')).append(h('a', { class: 'btn sm', href: appUrl('admin@karunya.edu'), target: '_blank', rel: 'noopener' }, 'Open app'), btn('+5 min', async () => { await api('clock', { action: 'advance', ms: 300000 }); await refreshState(); }, 'sm'));
refreshState().then(() => go((location.hash || '#overview').slice(1))).catch((e) => { clear($('#main')).append(h('h1', null, 'The dev server is not responding'), h('p', null, String(e.message))); });
addEventListener('hashchange', () => { if (!current || location.hash.slice(1) !== current.id) go(location.hash.slice(1)); });
setInterval(() => { refreshState().catch(() => {}); }, 15000);
})();
