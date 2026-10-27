/**
 * The Apps Script fakes from test/harness.js without Node: runs in a browser page (the shareable demo artifact) and in
 * Node (the build's self-test). Hashing is a pure-JS SHA-256 because Utilities.computeDigest is synchronous and WebCrypto
 * is not; dev/build-artifact.js checks it byte for byte against Node's crypto. Development only.
 * ponytail: a copy of the harness fakes, so a fake added to test/harness.js must be copied here too.
 */
var LFENV = (function () {
'use strict';

/* ------------------------------------------------------------------ SHA-256 and HMAC on byte arrays */
var K = [], H0 = [];
(function () {
  var primes = [], n = 2;
  while (primes.length < 64) { var p = true; for (var i = 0; i < primes.length && primes[i] * primes[i] <= n; i++) if (n % primes[i] === 0) { p = false; break; } if (p) primes.push(n); n++; }
  for (var j = 0; j < 64; j++) { K[j] = Math.floor((Math.cbrt(primes[j]) % 1) * 4294967296) | 0; if (j < 8) H0[j] = Math.floor((Math.sqrt(primes[j]) % 1) * 4294967296) | 0; }
})();
function ror(x, n) { return (x >>> n) | (x << (32 - n)); }
function sha256(bytes) {
  var l = bytes.length, n = ((l + 9 + 63) >> 6) << 6, m = new Uint8Array(n), dv = new DataView(m.buffer), w = new Int32Array(64), h = H0.slice();
  m.set(bytes); m[l] = 0x80; dv.setUint32(n - 4, (l * 8) >>> 0); dv.setUint32(n - 8, Math.floor(l / 536870912));
  for (var i = 0; i < n; i += 64) {
    for (var t = 0; t < 16; t++) w[t] = dv.getInt32(i + t * 4);
    for (t = 16; t < 64; t++) {
      var x = w[t - 15], y = w[t - 2];
      w[t] = (w[t - 16] + (ror(x, 7) ^ ror(x, 18) ^ (x >>> 3)) + w[t - 7] + (ror(y, 17) ^ ror(y, 19) ^ (y >>> 10))) | 0;
    }
    var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (t = 0; t < 64; t++) {
      var t1 = (hh + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + w[t]) | 0;
      var t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0; h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
  }
  var out = new Uint8Array(32), odv = new DataView(out.buffer);
  for (var k = 0; k < 8; k++) odv.setInt32(k * 4, h[k]);
  return out;
}
function hmac(key, msg) {
  if (key.length > 64) key = sha256(key);
  var ip = new Uint8Array(64 + msg.length), op = new Uint8Array(96);
  for (var i = 0; i < 64; i++) { var k = key[i] || 0; ip[i] = k ^ 0x36; op[i] = k ^ 0x5c; }
  ip.set(msg, 64); op.set(sha256(ip), 64);
  return sha256(op);
}

/* ------------------------------------------------------------------ bytes */
function signed(buf) { return Array.from(buf, function (b) { return b > 127 ? b - 256 : b; }); }
function bytes(v) { return typeof v === 'string' ? new TextEncoder().encode(v) : Uint8Array.from(v, function (b) { return b & 255; }); }
function b64(u8) { var s = ''; for (var i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
function unb64(s) { var bin = atob(s), u8 = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; }
function randomHex(n) { var u8 = new Uint8Array(n); crypto.getRandomValues(u8); return Array.from(u8, function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join(''); }

/* ------------------------------------------------------------------ Sheets */
class FakeRange {
  constructor(sheet, r, c, nr, nc) { Object.assign(this, { sheet: sheet, r: r, c: c, nr: nr, nc: nc }); }
  getValues() {
    if (this.sheet.ss.onOp) this.sheet.ss.onOp('read', this.sheet.name);
    var out = [];
    for (var i = 0; i < this.nr; i++) {
      var row = [];
      for (var j = 0; j < this.nc; j++) { var v = (this.sheet.cells[this.r + i - 1] || [])[this.c + j - 1]; row.push(v === undefined ? '' : v); }
      out.push(row);
    }
    return out;
  }
  setValues(vals) {
    if (this.sheet.ss.onOp) this.sheet.ss.onOp('write', this.sheet.name);
    if (vals.length !== this.nr || vals[0].length !== this.nc) throw new Error('setValues dimension mismatch');
    if (this.r + this.nr - 1 > this.sheet.maxRows || this.c + this.nc - 1 > this.sheet.maxCols) throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
    for (var i = 0; i < this.nr; i++) {
      var rr = this.r + i - 1;
      this.sheet.cells[rr] = this.sheet.cells[rr] || [];
      for (var j = 0; j < this.nc; j++) {
        var v = vals[i][j], fmt = this.sheet.colFormat[this.c + j];
        if (fmt === '@') v = v === '' ? '' : String(v);
        else if (typeof v === 'string' && v !== '' && /^-?\d+(\.\d+)?$/.test(v)) v = Number(v); // Sheets auto-parses numerics
        this.sheet.cells[rr][this.c + j - 1] = v;
      }
    }
    this.sheet.writes++;
    return this;
  }
  setNumberFormat(f) { for (var j = 0; j < this.nc; j++) this.sheet.colFormat[this.c + j] = f; return this; }
  setFontWeight() { return this; } setBackground() { return this; } setFontColor() { return this; }
}
class FakeSheet {
  constructor(name, ss) { this.name = name; this.ss = ss; this.cells = []; this.maxRows = 1000; this.maxCols = 26; this.colFormat = {}; this.writes = 0; this.frozen = 0; }
  getName() { return this.name; }
  getLastRow() { for (var i = this.cells.length - 1; i >= 0; i--) if ((this.cells[i] || []).some(function (v) { return v !== '' && v !== undefined; })) return i + 1; return 0; }
  getMaxRows() { return this.maxRows; }
  insertRowsAfter(_after, n) { this.maxRows += n; }
  getMaxColumns() { return this.maxCols; }
  insertColumnsAfter(_after, n) { this.maxCols += n; }
  deleteRows(start, n) {
    if (start < 1 || n < 1 || start + n - 1 > this.maxRows) throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
    if (this.maxRows - n <= this.frozen) throw new Error("You can't delete all the non-frozen rows in a sheet.");
    this.cells.splice(start - 1, n); this.maxRows -= n; this.writes++;
  }
  getRange(r, c, nr, nc) {
    if (r < 1 || c < 1) throw new Error('Range coordinates must be >= 1');
    return new FakeRange(this, r, c, nr === undefined ? 1 : nr, nc === undefined ? 1 : nc);
  }
  setFrozenRows(n) { this.frozen = n; } appendRow(a) { var r = this.getLastRow() + 1; this.getRange(r, 1, 1, a.length).setValues([a]); }
  setColumnWidth() {} autoResizeColumns() {} hideSheet() {} protect() { return { setWarningOnly() {}, removeEditors() {}, addEditor() {} }; }
}
class FakeSpreadsheet {
  constructor(name, id) { this.name = name; this.sheets = {}; this._id = id || 'ss-' + randomHex(4); }
  getId() { return this._id; } getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this._id; }
  getSheetByName(n) { return this.sheets[n] || null; }
  insertSheet(n) { var s = new FakeSheet(n, this); this.sheets[n] = s; return s; }
  getSheets() { return Object.values(this.sheets); }
  deleteSheet(s) { delete this.sheets[s.name]; }
}

/** The data a harness or browser environment holds, as plain JSON. Works on test/harness.js environments too. */
function snapshotOf(e) {
  var ss = {};
  Object.keys(e.spreadsheets).forEach(function (id) {
    var s = e.spreadsheets[id], sheets = {};
    Object.keys(s.sheets).forEach(function (n) { var sh = s.sheets[n]; sheets[n] = { cells: sh.cells, colFormat: sh.colFormat, maxRows: sh.maxRows, maxCols: sh.maxCols, frozen: sh.frozen }; });
    ss[id] = { name: s.name, sheets: sheets };
  });
  return JSON.parse(JSON.stringify({ props: e.props, cache: e.cacheStore, spreadsheets: ss }));
}

/** A fresh environment, optionally restored from snapshotOf(). opts.now() is the simulated clock. */
function createEnv(opts) {
  opts = opts || {};
  var snap = opts.snapshot ? JSON.parse(JSON.stringify(opts.snapshot)) : { props: {}, cache: {}, spreadsheets: {} };
  var props = snap.props, cacheStore = snap.cache, spreadsheets = {}, sentMail = [], folders = {}, trashed = [], docs = [], triggers = [];
  var clock = opts.now || function () { return Date.now(); };
  var state = { activeUser: '', lockHeld: false, lockTimeouts: 0, mailQuota: 1500 };
  Object.keys(snap.spreadsheets).forEach(function (id) {
    var src = snap.spreadsheets[id], ss = new FakeSpreadsheet(src.name, id);
    Object.keys(src.sheets).forEach(function (n) {
      var d = src.sheets[n], sh = ss.insertSheet(n);
      sh.cells = d.cells.map(function (row) { return row ? row.map(function (v) { return v === null ? undefined : v; }) : row; });
      sh.colFormat = d.colFormat; sh.maxRows = d.maxRows; sh.maxCols = d.maxCols; sh.frozen = d.frozen;
    });
    spreadsheets[id] = ss;
  });

  var services = {
    console: console,
    SpreadsheetApp: {
      create: function (n) { var s = new FakeSpreadsheet(n); spreadsheets[s.getId()] = s; return s; },
      openById: function (id) { if (!spreadsheets[id]) throw new Error('No spreadsheet ' + id); return spreadsheets[id]; }
    },
    PropertiesService: { getScriptProperties: function () { return {
      getProperty: function (k) { return k in props ? props[k] : null; },
      setProperty: function (k, v) { props[k] = String(v); },
      deleteProperty: function (k) { delete props[k]; },
      getProperties: function () { return Object.assign({}, props); }
    }; } },
    CacheService: { getScriptCache: function () { return {
      get: function (k) { var x = cacheStore[k]; if (!x) return null; if (x.exp !== null && x.exp <= clock()) { delete cacheStore[k]; return null; } return x.v; },
      put: function (k, v, ttl) { if (typeof v !== 'string') throw new Error('cache value must be string'); if (v.length > 100000) throw new Error('Argument too large'); cacheStore[k] = { v: v, exp: clock() + (ttl === undefined ? 600 : Math.min(ttl, 21600)) * 1000 }; },
      remove: function (k) { delete cacheStore[k]; },
      removeAll: function (ks) { ks.forEach(function (k) { delete cacheStore[k]; }); }
    }; } },
    LockService: { getScriptLock: function () { return {
      tryLock: function () { if (state.lockHeld) { state.lockTimeouts++; return false; } state.lockHeld = true; return true; },
      releaseLock: function () { state.lockHeld = false; }
    }; } },
    Session: {
      getActiveUser: function () { return { getEmail: function () { return state.activeUser; } }; },
      getEffectiveUser: function () { return { getEmail: function () { return 'owner@karunya.edu'; } }; },
      getScriptTimeZone: function () { return 'Asia/Kolkata'; }
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
      getUuid: function () { return crypto.randomUUID(); },
      computeDigest: function (alg, v) { return signed(sha256(bytes(v))); },
      computeHmacSha256Signature: function (v, k) { return signed(hmac(bytes(k), bytes(v))); },
      base64EncodeWebSafe: function (v) { return b64(bytes(v)).replace(/\+/g, '-').replace(/\//g, '_'); },
      base64DecodeWebSafe: function (s) { return signed(unb64(s.replace(/-/g, '+').replace(/_/g, '/'))); },
      newBlob: function (s) { return { getBytes: function () { return signed(bytes(s)); } }; },
      base64Decode: function (s) { return signed(unb64(s)); },
      base64Encode: function (v) { return b64(bytes(v)); },
      sleep: function () {}
    },
    MailApp: { getRemainingDailyQuota: function () { return state.mailQuota; }, sendEmail: function (o) { sentMail.push({ to: o.to, subject: o.subject, body: o.body, via: 'mail' }); state.mailQuota--; } },
    MimeType: { CSV: 'text/csv' },
    UrlFetchApp: { fetch: function () { throw new Error('UrlFetchApp is not available in the demo'); } },
    ContentService: { MimeType: { JSON: 'JSON' }, createTextOutput: function (t) { var o = { text: t, getContent: function () { return t; }, setMimeType: function (m) { o.mime = m; return o; } }; return o; } },
    HtmlService: { XFrameOptionsMode: { DEFAULT: 'DEFAULT' }, createHtmlOutputFromFile: function (n) { return { getContent: function () { return '<!-- ' + n + ' -->'; } }; },
      createTemplateFromFile: function (n) { return { evaluate: function () { var o = { setTitle: function () { return o; }, addMetaTag: function () { return o; }, setXFrameOptionsMode: function () { return o; }, template: n }; return o; } }; } },
    DriveApp: (function () {
      var files = {}, seq = 0;
      function mk(id, name, parent, extra) {
        var f = Object.assign({ id: id, name: name, parent: parent, trashed: false, created: clock() }, extra || {});
        f.getId = function () { return id; }; f.getName = function () { return f.name; }; f.getUrl = function () { return 'https://drive/' + f.name; };
        f.getDateCreated = function () { return new Date(f.created); };
        f.setTrashed = function (v) { f.trashed = v !== false; trashed.push(id); return f; };
        f.makeCopy = function (n, folder) { var c = mk('file-' + (++seq), n, folder || parent, { copyOf: id }); if (folder) folder.files.push(c); return c; };
        f.moveTo = function (folder) { f.parent = folder; folder.files.push(f); return f; };
        f.getAs = function () { return { getBytes: function () { return signed(bytes('%PDF-fake')); } }; };
        files[id] = f; return f;
      }
      return {
        createFolder: function (n) {
          var f = { id: 'fld-' + n, name: n, files: [], getId: function () { return 'fld-' + n; }, getUrl: function () { return 'https://drive/folders/' + n; },
            createFile: function (name, body) { var file = mk('file-' + (++seq), name, f, { body: body }); f.files.push(file); return file; },
            getFiles: function () { var list = f.files.filter(function (x) { return !x.trashed; }), i = 0; return { hasNext: function () { return i < list.length; }, next: function () { return list[i++]; } }; } };
          folders[f.id] = f; return f;
        },
        getFolderById: function (id) { if (!folders[id]) throw new Error('no folder'); return folders[id]; },
        getFileById: function (id) { return files[id] || mk(id, spreadsheets[id] ? 'LABFLOW database' : id, null); }
      };
    })(),
    DocumentApp: { ParagraphHeading: { HEADING1: 'H1', HEADING2: 'H2' },
      create: function () { return { getId: function () { return 'doc-1'; }, getBody: function () { var b = { setMarginTop: function () { return b; }, setMarginBottom: function () { return b; }, setMarginLeft: function () { return b; }, setMarginRight: function () { return b; },
        appendParagraph: function (t) { docs.push(t); return { setHeading: function () {} }; },
        appendTable: function (d) { docs.push('table:' + d.length); return { setFontSize: function () {}, getRow: function () { return { editAsText: function () { return { setBold: function () {} }; } }; } }; } }; return b; }, saveAndClose: function () {} }; } },
    ScriptApp: { getProjectTriggers: function () { return triggers.slice(); }, deleteTrigger: function (t) { var i = triggers.indexOf(t); if (i >= 0) triggers.splice(i, 1); },
      newTrigger: function (fn) { var b = { timeBased: function () { return b; }, everyMinutes: function () { return b; }, everyHours: function () { return b; }, everyDays: function () { return b; }, atHour: function () { return b; },
        create: function () { var t = { getHandlerFunction: function () { return fn; } }; triggers.push(t); return t; } }; return b; } },
    GmailApp: { sendEmail: function (to, subject, body, o) { sentMail.push({ to: to, subject: subject, body: body, o: o }); state.mailQuota--; } }
  };
  return { services: services, state: state, props: props, cacheStore: cacheStore, spreadsheets: spreadsheets, sentMail: sentMail };
}

/** The order the engine's parameters take; the build wraps src/*.gs in a function with these names. */
var SERVICE_NAMES = ['console', 'SpreadsheetApp', 'PropertiesService', 'CacheService', 'LockService', 'Session', 'Utilities', 'MailApp', 'MimeType', 'UrlFetchApp', 'ContentService', 'HtmlService', 'DriveApp', 'DocumentApp', 'ScriptApp', 'GmailApp'];

return { createEnv: createEnv, snapshotOf: snapshotOf, sha256: sha256, hmac: hmac, SERVICE_NAMES: SERVICE_NAMES };
})();
if (typeof module !== 'undefined') module.exports = LFENV;
