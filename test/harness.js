/**
 * Test harness: loads the REAL src/*.gs files into a bare V8 context (no Node globals, like Apps Script) and
 * provides in-memory fakes of the Apps Script services LABFLOW uses.
 *
 * What the fakes reproduce faithfully (because they are the classic Apps Script traps):
 *  - Utilities.computeDigest / computeHmacSha256Signature / base64Decode return SIGNED bytes (-128..127).
 *  - Sheet writes outside the grid throw; getLastRow ignores blank trailing rows.
 *  - Text-formatted columns ('@') keep strings as strings; unformatted cells turn numeric-looking text into numbers
 *    (so a missing '@' format would corrupt roll numbers like "007" - the tests would catch it).
 *  - CacheService values are strings with a 100KB limit; LockService is exclusive.
 * What they cannot reproduce: real concurrency, real latency, quotas, the HtmlService sandbox. Those are listed
 * in TEST_PLAN.md as deployment checks.
 */
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');

const SRC = path.join(__dirname, '..', 'src');
// Load order mirrors .clasp.json filePushOrder.
const LOAD_ORDER = ['Config.gs', 'Util.gs', 'Db.gs', 'AuditService.gs', 'Vendor_P256.gs', 'Vendor_AES.gs', 'Setup.gs', 'AuthService.gs', 'NotificationService.gs', 'DeviceCredentialService.gs', 'UserService.gs', 'LabService.gs', 'SessionService.gs', 'AttendanceService.gs', 'CheckinService.gs', 'FlagService.gs', 'EventService.gs', 'AssetService.gs', 'BookingService.gs', 'ProjectService.gs', 'ReportService.gs', 'AdminService.gs', 'BackupService.gs', 'TriggerService.gs', 'Code.gs'];

function signed(buf) { return Array.from(buf, (b) => (b > 127 ? b - 256 : b)); }
function toBuf(x) { return Buffer.isBuffer(x) ? x : Buffer.from(x.map ? x.map((b) => b & 255) : x); }

class FakeRange {
  constructor(sheet, r, c, nr, nc) { Object.assign(this, { sheet, r, c, nr, nc }); }
  getValues() {
    if (this.sheet.ss.onOp) this.sheet.ss.onOp('read', this.sheet.name);
    const out = [];
    for (let i = 0; i < this.nr; i++) {
      const row = [];
      for (let j = 0; j < this.nc; j++) { const v = (this.sheet.cells[this.r + i - 1] || [])[this.c + j - 1]; row.push(v === undefined ? '' : v); }
      out.push(row);
    }
    return out;
  }
  setValues(vals) {
    if (this.sheet.ss.onOp) this.sheet.ss.onOp('write', this.sheet.name);
    if (vals.length !== this.nr || vals[0].length !== this.nc) throw new Error('setValues dimension mismatch');
    if (this.r + this.nr - 1 > this.sheet.maxRows || this.c + this.nc - 1 > this.sheet.maxCols) throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
    for (let i = 0; i < this.nr; i++) {
      const rr = this.r + i - 1;
      this.sheet.cells[rr] = this.sheet.cells[rr] || [];
      for (let j = 0; j < this.nc; j++) {
        let v = vals[i][j];
        const fmt = this.sheet.colFormat[this.c + j];
        if (fmt === '@') v = v === '' ? '' : String(v);
        else if (typeof v === 'string' && v !== '' && /^-?\d+(\.\d+)?$/.test(v)) v = Number(v); // Sheets auto-parses numerics
        this.sheet.cells[rr][this.c + j - 1] = v;
      }
    }
    this.sheet.writes++;
    return this;
  }
  setNumberFormat(f) { for (let j = 0; j < this.nc; j++) this.sheet.colFormat[this.c + j] = f; return this; }
  setFontWeight() { return this; } setBackground() { return this; } setFontColor() { return this; }
}
class FakeSheet {
  constructor(name, ss) { this.name = name; this.ss = ss; this.cells = []; this.maxRows = 1000; this.maxCols = 26; this.colFormat = {}; this.writes = 0; this.frozen = 0; }
  getName() { return this.name; }
  getLastRow() { for (let i = this.cells.length - 1; i >= 0; i--) if ((this.cells[i] || []).some((v) => v !== '' && v !== undefined)) return i + 1; return 0; }
  getMaxRows() { return this.maxRows; }
  insertRowsAfter(_after, n) { this.maxRows += n; }
  getMaxColumns() { return this.maxCols; }
  insertColumnsAfter(_after, n) { this.maxCols += n; }
  /** Like Sheets: later rows move up, the grid shrinks, and the last non-frozen row cannot be deleted. */
  deleteRows(start, n) {
    if (start < 1 || n < 1 || start + n - 1 > this.maxRows) throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
    if (this.maxRows - n <= this.frozen) throw new Error("You can't delete all the non-frozen rows in a sheet.");
    this.cells.splice(start - 1, n); this.maxRows -= n; this.writes++;
  }
  getRange(r, c, nr = 1, nc = 1) {
    if (r < 1 || c < 1) throw new Error('Range coordinates must be >= 1');
    return new FakeRange(this, r, c, nr, nc);
  }
  setFrozenRows(n) { this.frozen = n; } appendRow(a) { const r = this.getLastRow() + 1; this.getRange(r, 1, 1, a.length).setValues([a]); }
  setColumnWidth() {} autoResizeColumns() {} hideSheet() {} protect() { return { setWarningOnly() {}, removeEditors() {}, addEditor() {} }; }
}
class FakeSpreadsheet {
  constructor(name) { this.name = name; this.sheets = {}; this._id = 'ss-' + nodeCrypto.randomBytes(4).toString('hex'); }
  getId() { return this._id; } getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this._id; }
  getSheetByName(n) { return this.sheets[n] || null; }
  insertSheet(n) { const s = new FakeSheet(n, this); this.sheets[n] = s; return s; }
  getSheets() { return Object.values(this.sheets); }
  deleteSheet(s) { delete this.sheets[s.name]; }
}

function createEnv(opts = {}) {
  const props = {};
  const cacheStore = {};
  const spreadsheets = {};
  const sentMail = [];
  const clock = () => (typeof ctxRef.ctx.__testNow === 'number' ? ctxRef.ctx.__testNow : Date.now());
  const ctxRef = {};
  const folders = {}, trashed = [], docs = [], triggers = [];
  const state = { activeUser: opts.activeUser === undefined ? '' : opts.activeUser, lockHeld: false, lockTimeouts: 0, mailQuota: 1500, fetches: [] };

  const env = {
    console,
    SpreadsheetApp: {
      create: (n) => { const s = new FakeSpreadsheet(n); spreadsheets[s.getId()] = s; return s; },
      openById: (id) => { if (!spreadsheets[id]) throw new Error('No spreadsheet ' + id); return spreadsheets[id]; },
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = String(v); },
        deleteProperty: (k) => { delete props[k]; },
        getProperties: () => ({ ...props }),
      }),
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => { const x = cacheStore[k]; if (!x) return null; if (x.exp !== null && x.exp <= clock()) { delete cacheStore[k]; return null; } return x.v; },
        put: (k, v, ttl) => { if (typeof v !== 'string') throw new Error('cache value must be string'); if (v.length > 100000) throw new Error('Argument too large'); cacheStore[k] = { v, exp: clock() + (ttl === undefined ? 600 : Math.min(ttl, 21600)) * 1000 }; },
        remove: (k) => { delete cacheStore[k]; },
        removeAll: (ks) => ks.forEach((k) => delete cacheStore[k]),
      }),
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => { if (state.lockHeld) { state.lockTimeouts++; return false; } state.lockHeld = true; return true; },
        releaseLock: () => { state.lockHeld = false; },
      }),
    },
    Session: {
      getActiveUser: () => ({ getEmail: () => state.activeUser }),
      getEffectiveUser: () => ({ getEmail: () => state.effectiveUser || 'owner@karunya.edu' }),
      getScriptTimeZone: () => state.scriptTz || 'Asia/Kolkata',
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
      getUuid: () => nodeCrypto.randomUUID(),
      computeDigest: (alg, v) => signed(nodeCrypto.createHash('sha256').update(typeof v === 'string' ? v : toBuf(v)).digest()),
      computeHmacSha256Signature: (v, k) => signed(nodeCrypto.createHmac('sha256', k).update(v).digest()),
      base64EncodeWebSafe: (v) => (typeof v === 'string' ? Buffer.from(v, 'utf8') : toBuf(v)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
      base64DecodeWebSafe: (s) => signed(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')),
      newBlob: (s) => ({ getBytes: () => signed(Buffer.from(s, 'utf8')) }),
      base64Decode: (s) => signed(Buffer.from(s, 'base64')),
      base64Encode: (v) => (typeof v === 'string' ? Buffer.from(v, 'utf8') : toBuf(v)).toString('base64'),
      sleep: () => {},
    },
    MailApp: { getRemainingDailyQuota: () => state.mailQuota, sendEmail: (o) => { sentMail.push({ to: o.to, subject: o.subject, body: o.body, via: 'mail' }); state.mailQuota--; } },
    MimeType: { CSV: 'text/csv' },
    // Google's tokeninfo endpoint, faked: an ID token is "<header>.<b64u claims>.<sig>" and only sig "google-signed"
    // verifies (a real token's signature is checked by Google). Expired tokens are refused, as Google does.
    UrlFetchApp: { fetch: (url, o) => {
      state.fetches.push(url);
      const m = /^https:\/\/oauth2\.googleapis\.com\/tokeninfo\?id_token=(.+)$/.exec(url);
      if (!m) throw new Error('UrlFetchApp: unexpected URL ' + url);
      const parts = decodeURIComponent(m[1]).split('.');
      let claims = null; try { claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch (e) { claims = null; }
      const ok = parts[2] === 'google-signed' && claims && Number(claims.exp) * 1000 > clock();
      const body = ok ? JSON.stringify(Object.fromEntries(Object.entries(claims).map(([k, v]) => [k, String(v)]))) : '{"error":"invalid_token"}';
      if (!ok && !(o && o.muteHttpExceptions)) throw new Error('Request failed with code 400');
      return { getResponseCode: () => (ok ? 200 : 400), getContentText: () => body };
    } },
    ContentService: { MimeType: { JSON: 'JSON' }, createTextOutput: (t) => { const o = { text: t, getContent: () => t, setMimeType: (m) => { o.mime = m; return o; } }; return o; } },
    HtmlService: { XFrameOptionsMode: { DEFAULT: 'DEFAULT' }, createHtmlOutputFromFile: (n) => ({ getContent: () => '<!-- ' + n + ' -->' }),
      createTemplateFromFile: (n) => ({ evaluate: () => { const o = { setTitle: () => o, addMetaTag: () => o, setXFrameOptionsMode: () => o, template: n }; return o; } }) },
    // Drive: folders hold files; files can be copied, trashed and listed. Like the real service, getFiles() never returns
    // trashed files, and getFileById() knows the database spreadsheet. Unknown ids still get a throwaway file (Docs temp files).
    DriveApp: (() => {
      const files = {}; let seq = 0;
      const mk = (id, name, parent, extra) => {
        const f = Object.assign({ id, name, parent, trashed: false, created: clock() }, extra || {});
        f.getId = () => id; f.getName = () => f.name; f.getUrl = () => 'https://drive/' + f.name;
        f.getDateCreated = () => new Date(f.created);
        f.setTrashed = (v) => { f.trashed = v !== false; trashed.push(id); return f; };
        f.makeCopy = (n, folder) => { const c = mk('file-' + (++seq), n, folder || parent, { copyOf: id }); if (folder) folder.files.push(c); return c; };
        f.moveTo = (folder) => { f.parent = folder; folder.files.push(f); return f; };
        f.getAs = () => ({ getBytes: () => signed(Buffer.from('%PDF-fake')) });
        files[id] = f; return f;
      };
      return {
        createFolder: (n) => {
          const f = { id: 'fld-' + n, name: n, files: [], getId: () => 'fld-' + n, getUrl: () => 'https://drive/folders/' + n,
            createFile: (name, body) => { const file = mk('file-' + (++seq), name, f, { body }); f.files.push(file); return file; },
            getFiles: () => { const list = f.files.filter((x) => !x.trashed); let i = 0; return { hasNext: () => i < list.length, next: () => list[i++] }; } };
          folders[f.id] = f; return f;
        },
        getFolderById: (id) => { if (!folders[id]) throw new Error('no folder'); return folders[id]; },
        getFileById: (id) => files[id] || mk(id, spreadsheets[id] ? 'LABFLOW database' : id, null),
      };
    })(),
    DocumentApp: { ParagraphHeading: { HEADING1: 'H1', HEADING2: 'H2' },
      create: () => { const doc = { getId: () => 'doc-1', getBody: () => { const b = { setMarginTop: () => b, setMarginBottom: () => b, setMarginLeft: () => b, setMarginRight: () => b, appendParagraph: (t) => { docs.push(t); return { setHeading() {} }; },
        appendTable: (d) => { docs.push('table:' + d.length); return { setFontSize() {}, getRow: () => ({ editAsText: () => ({ setBold() {} }) }) }; } }; return b; }, saveAndClose: () => {} }; return doc; } },
    ScriptApp: { getProjectTriggers: () => triggers.slice(), deleteTrigger: (t) => { const i = triggers.indexOf(t); if (i >= 0) triggers.splice(i, 1); },
      newTrigger: (fn) => { const spec = { fn }; const b = { timeBased: () => b, everyMinutes: (n) => { spec.n = n; return b; }, everyHours: (n) => { spec.h = n; return b; }, everyDays: () => b, atHour: (h) => { spec.hour = h; return b; },
        create: () => { const t = { getHandlerFunction: () => fn, spec }; triggers.push(t); return t; } }; return b; } },
    GmailApp: { sendEmail: (to, subject, body, o) => { if (state.mailFail) throw new Error('Service invoked too many times: email'); sentMail.push({ to, subject, body, o }); state.mailQuota--; } },
  };
  const ctx = vm.createContext(env);
  ctxRef.ctx = ctx;
  // Mimic the Apps Script global: `globalThis` exists in V8 runtime.
  return { ctx, state, props, cacheStore, sentMail, spreadsheets, folders, trashed, docs, triggers };
}

/** Load the project into a fresh environment. */
function load(opts = {}) {
  const e = createEnv(opts);
  const files = opts.files || LOAD_ORDER;
  for (const f of files) {
    const p = path.join(SRC, f);
    if (!fs.existsSync(p)) continue;
    vm.runInContext(fs.readFileSync(p, 'utf8'), e.ctx, { filename: f });
  }
  // `class` and top-level `const` are not properties of the context object; expose via an evaluator.
  e.run = (code) => vm.runInContext(code, e.ctx);
  e.get = (name) => vm.runInContext(name, e.ctx);
  e.setTime = (ms) => { e.ctx.__testNow = ms; };
  e.clearTime = () => { delete e.ctx.__testNow; };
  return e;
}

/** Create the database through the real Setup code when present, else a minimal equivalent. */
function initDb(e) {
  if (e.run('typeof Setup') !== 'undefined') return e.run('Setup.initialise({ silent: true })');
  const ssId = e.run(`(function(){ var ss = SpreadsheetApp.create('t'); var p = PropertiesService.getScriptProperties();
    p.setProperty(Cfg.PROP.DB_ID, ss.getId()); p.setProperty(Cfg.PROP.HMAC, 'test-secret');
    Object.keys(Cfg.SCHEMA).forEach(function(t){ var s = ss.insertSheet(t); var c = Cfg.SCHEMA[t];
      s.getRange(1,1,1,c.length).setValues([c.map(function(x){return x.name;})]);
      c.forEach(function(x,i){ if (x.type==='s'||x.type==='j') s.getRange(1,i+1,s.getMaxRows(),1).setNumberFormat('@'); });
      s.getRange(1,1,1,c.length).setValues([c.map(function(x){return x.name;})]); });
    return ss.getId(); })()`);
  return ssId;
}

module.exports = { load, initDb, createEnv, SRC, LOAD_ORDER, signed };
