/**
 * Util.gs - errors, time (Asia/Kolkata), encoding, hashing and small helpers.
 * Everything here is pure or depends only on Utilities, so it is unit-testable.
 */

/** A failure that is safe to show to the caller. Anything else is logged and replaced by a generic message. */
class AppError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.extra = extra || null;
  }
}
function fail(code, message, extra) { throw new AppError(code, message, extra); }
/** Placeholder for a v2 contract that is not built yet; `task` is its id in docs/tasks.md. */
function notBuilt_(task) { fail('NOT_IMPLEMENTED', 'This feature is not built yet (task ' + task + ').'); }

var U = {
  // v2 stubs (docs/requirements.md section 4); each task replaces its own.
  /** URK24CS1021 -> { joinYear: 2024, gradYear: 2028, dept: 'CS', serial: '1021' }; null for other formats. */
  parseRoll: function (roll) {
    var m = /^URK(\d{2})([A-Z]{2,4})(\d{3,5})$/.exec(String(roll === undefined || roll === null ? '' : roll).trim().toUpperCase());
    if (!m) return null;
    var joinYear = 2000 + parseInt(m[1], 10);
    return { joinYear: joinYear, gradYear: joinYear + 4, dept: m[2], serial: m[3] };
  },
  /** Current time in epoch ms. Tests may set the global __testNow to control the clock. */
  now: function () { return (typeof __testNow === 'number') ? __testNow : Date.now(); },

  // ---- identifiers ---------------------------------------------------------------------------
  id: function (kind) {
    var prefix = Cfg.ID_PREFIX[kind];
    if (!prefix) throw new Error('Unknown id kind ' + kind);
    return prefix + '-' + Utilities.getUuid().replace(/-/g, '').slice(0, 12).toUpperCase();
  },

  // ---- time (fixed +05:30; India has no DST) --------------------------------------------------
  p2: function (n) { return (n < 10 ? '0' : '') + n; },
  local: function (ms) {
    var d = new Date(ms + Cfg.TZ_OFFSET_MIN * 60000);
    var y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, day = d.getUTCDate();
    var H = d.getUTCHours(), M = d.getUTCMinutes();
    return { y: y, m: m, d: day, H: H, M: M, dow: d.getUTCDay() || 7,
             date: y + '-' + U.p2(m) + '-' + U.p2(day), time: U.p2(H) + ':' + U.p2(M), month: y + '-' + U.p2(m) };
  },
  isDate: function (s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s; },
  isTime: function (s) { return typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s); },
  fromLocal: function (dateStr, timeStr) {
    if (!U.isDate(dateStr) || !U.isTime(timeStr)) fail('BAD_INPUT', 'Invalid date or time.');
    var y = +dateStr.slice(0, 4), m = +dateStr.slice(5, 7), d = +dateStr.slice(8, 10);
    return Date.UTC(y, m - 1, d, +timeStr.slice(0, 2), +timeStr.slice(3, 5)) - Cfg.TZ_OFFSET_MIN * 60000;
  },
  addDays: function (dateStr, n) {
    var t = Date.parse(dateStr + 'T00:00:00Z') + n * 86400000;
    return new Date(t).toISOString().slice(0, 10);
  },
  dayStart: function (dateStr) { return U.fromLocal(dateStr, '00:00'); },
  fmt: function (ms) { var l = U.local(ms); return l.date + ' ' + l.time; },

  // ---- bytes / encoding ----------------------------------------------------------------------
  /** Apps Script returns SIGNED bytes (-128..127) from digest/HMAC/base64 decode. Normalise to 0..255. */
  unsigned: function (bytes) {
    var out = new Uint8Array(bytes.length);
    for (var i = 0; i < bytes.length; i++) out[i] = bytes[i] & 255;
    return out;
  },
  hex: function (bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += ((bytes[i] & 255) + 256).toString(16).slice(1);
    return s;
  },
  b64uEncode: function (bytesOrString) { return Utilities.base64EncodeWebSafe(bytesOrString).replace(/=+$/, ''); },
  b64uDecode: function (s) {
    if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) fail('BAD_INPUT', 'Malformed encoded value.');
    while (s.length % 4) s += '=';
    return U.unsigned(Utilities.base64DecodeWebSafe(s));
  },
  sha256Hex: function (str) { return U.hex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8)); },
  sha256Bytes: function (str) { return U.unsigned(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, str, Utilities.Charset.UTF_8)); },
  hmacB64u: function (key, msg) { return U.b64uEncode(Utilities.computeHmacSha256Signature(msg, key)); },
  /** Constant-time string comparison. */
  safeEq: function (a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    var r = 0;
    for (var i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return r === 0;
  },

  // ---- misc ----------------------------------------------------------------------------------
  clamp: function (n, lo, hi) { return Math.min(hi, Math.max(lo, n)); },
  uniq: function (arr) { var seen = {}; return arr.filter(function (x) { return seen[x] ? false : (seen[x] = true); }); },
  groupBy: function (arr, fn) { var o = {}; arr.forEach(function (x) { var k = fn(x); (o[k] = o[k] || []).push(x); }); return o; },
  indexBy: function (arr, key) { var o = {}; arr.forEach(function (x) { o[x[key]] = x; }); return o; },
  chunk: function (arr, n) { var out = []; for (var i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; },
  /** Unbiased random integer in [0, n). */
  randInt: function (n) {
    var bytes = U.unsigned(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Math.random(), Utilities.Charset.UTF_8));
    var x = (bytes[0] * 16777216 + bytes[1] * 65536 + bytes[2] * 256 + bytes[3]);
    return x % n;
  },
  shuffle: function (arr) { var a = arr.slice(); for (var i = a.length - 1; i > 0; i--) { var j = U.randInt(i + 1); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; },
  /** Neutralise spreadsheet formula injection in exported text cells. */
  csvSafe: function (v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return isFinite(v) ? String(v) : ''; // real numbers are never formulas
    var s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  },
  toCsv: function (columns, rows) {
    var lines = [columns.map(U.csvSafe).join(',')];
    rows.forEach(function (r) { lines.push(r.map(U.csvSafe).join(',')); });
    return lines.join('\r\n');
  },
  overlaps: function (aStart, aEnd, bStart, bEnd) { return aStart < bEnd && bStart < aEnd; },

  // ---- geography -----------------------------------------------------------------------------
  /** Great-circle distance in metres between two lat/lng points (haversine, mean Earth radius). */
  haversineM: function (lat1, lng1, lat2, lng2) {
    var R = 6371008.8, rad = Math.PI / 180;
    var dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  },
  /** Coarse band stored instead of a precise distance where only the order of magnitude matters. */
  distanceBand: function (m) { return m === null || m === undefined ? '' : m < 20 ? '<20m' : m < 50 ? '20-50m' : m < 100 ? '50-100m' : m < 500 ? '100-500m' : '>500m'; },

  /** Value of one query parameter in a URL or query string, or ''. Only used on short, length-checked input. */
  queryParam: function (url, name) {
    var q = String(url || ''), i = q.indexOf('?');
    if (i >= 0) q = q.slice(i + 1);
    var parts = q.split('#')[0].split('&');
    for (var j = 0; j < parts.length; j++) {
      var kv = parts[j].split('=');
      if (kv[0] === name) { try { return decodeURIComponent((kv.slice(1).join('=') || '').replace(/\+/g, ' ')); } catch (e) { return ''; } }
    }
    return '';
  }
};

/**
 * Verification pipelines. A check-in or scan is an ordered list of named steps; each step's run(c) reads and extends
 * the shared context `c`, and throws an AppError to refuse. Steps marked `locked` (always at the end) run together
 * inside the script lock, so the lock is held only for the replay check and the write.
 *
 * The list is data so that tests and the local Test Lab can see which step decided the outcome. An optional global
 * observer (__pipelineObserver, defined only by the dev server) receives the trace. Production code never reads any
 * per-step switch: every step in the list always runs.
 */
/**
 * Encryption at rest for personal data such as phone numbers (A2).
 *
 * AES-256-GCM, a vetted authenticated cipher (the audited @noble/ciphers bundle in Vendor_AES.gs), not a homemade scheme.
 * The key is HMAC-SHA256(PII_KEY, 'enc'), where PII_KEY is a script property that is created by Setup.initialise and is never
 * written to a sheet. Every value gets a fresh random 96-bit nonce (a hash of two random UUIDs). The field name is bound in as
 * additional authenticated data, so a sealed value copied into another column does not open.
 * Stored form: `enc1:<b64u nonce>:<b64u ciphertext>:<b64u tag>`. Opening verifies the tag first; a changed character fails.
 */
var Crypt = {
  PREFIX: 'enc1:',
  _bytes: function (signed) { var o = new Uint8Array(signed.length); for (var i = 0; i < signed.length; i++) o[i] = signed[i] & 255; return o; },
  _signed: function (u8) { var o = []; for (var i = 0; i < u8.length; i++) o.push(u8[i] > 127 ? u8[i] - 256 : u8[i]); return o; },
  _utf8: function (s) { var bin = unescape(encodeURIComponent(String(s))), o = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i); return o; },
  _text: function (u8) { var bin = ''; for (var i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]); return decodeURIComponent(escape(bin)); },
  _b64: function (u8) { return Utilities.base64EncodeWebSafe(Crypt._signed(u8)).replace(/=+$/, ''); },
  _unb64: function (s) { return Crypt._bytes(Utilities.base64DecodeWebSafe(s + '===='.slice(s.length % 4 || 4))); },
  _key: function () {
    var secret = PropertiesService.getScriptProperties().getProperty(Cfg.PROP.PII_KEY);
    if (!secret) fail('NOT_CONFIGURED', 'The encryption key is not set. The script owner must run setupInitialise.');
    return Crypt._bytes(Utilities.computeHmacSha256Signature('enc', secret));
  },
  isSealed: function (v) { return typeof v === 'string' && v.indexOf(Crypt.PREFIX) === 0 && v.split(':').length === 4; },
  /** Encrypt text. `field` names what it is stored in (for example 'Users.mobile'); open() must be given the same name. */
  seal: function (plain, field) {
    var nonce = Crypt._bytes(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Utilities.getUuid())).slice(0, 12);
    var out = NobleAES.seal(Crypt._key(), nonce, Crypt._utf8(plain), Crypt._utf8(field || ''));
    return Crypt.PREFIX + Crypt._b64(nonce) + ':' + Crypt._b64(out.slice(0, out.length - 16)) + ':' + Crypt._b64(out.slice(out.length - 16));
  },
  /** Decrypt a sealed value. A value that was changed, or sealed for a different field, fails with INTEGRITY. */
  open: function (sealed, field) {
    if (!Crypt.isSealed(sealed)) fail('INTEGRITY', 'The stored value is not in the expected format.');
    var parts = sealed.split(':');
    try {
      var nonce = Crypt._unb64(parts[1]), ct = Crypt._unb64(parts[2]), tag = Crypt._unb64(parts[3]), joined = new Uint8Array(ct.length + tag.length);
      // Base64 can spell the same bytes in more than one way (spare bits in the last character). Only the canonical spelling opens,
      // so changing any character of a stored value fails, not just those that change the bytes.
      if (Crypt._b64(nonce) !== parts[1] || Crypt._b64(ct) !== parts[2] || Crypt._b64(tag) !== parts[3] || nonce.length !== 12 || tag.length !== 16) throw new Error('format');
      joined.set(ct, 0); joined.set(tag, ct.length);
      return Crypt._text(NobleAES.open(Crypt._key(), nonce, joined, Crypt._utf8(field || '')));
    } catch (e) {
      if (e && e.code === 'NOT_CONFIGURED') throw e;
      fail('INTEGRITY', 'The stored value failed its integrity check.');
    }
  },
  /** A sealed or plain value, as plain text. Values stored before A2 are plain until the migration seals them. */
  reveal: function (stored, field) { return !stored ? '' : (Crypt.isSealed(stored) ? Crypt.open(stored, field) : String(stored)); },
  /** What other people see instead of the number: six dots and the last four digits. */
  mask: function (plain) {
    var s = String(plain === undefined || plain === null ? '' : plain);
    if (!s) return '';
    return s.length <= 4 ? '\u2022\u2022\u2022\u2022' : '\u2022\u2022\u2022\u2022\u2022\u2022' + s.slice(-4);
  }
};

var Pipeline = {
  run: function (name, steps, c) {
    var trace = [];
    c.trace = trace;
    function exec(step) {
      var t0 = Date.now(); // wall time: measures cost, independent of the test clock
      try { step.run(c); trace.push({ id: step.id, ok: true, ms: Date.now() - t0 }); }
      catch (e) { trace.push({ id: step.id, ok: false, ms: Date.now() - t0, code: (e && e.code) || 'ERROR' }); throw e; }
    }
    try {
      var firstLocked = -1;
      for (var i = 0; i < steps.length; i++) { if (steps[i].locked) { firstLocked = i; break; } }
      var pre = firstLocked < 0 ? steps : steps.slice(0, firstLocked), locked = firstLocked < 0 ? [] : steps.slice(firstLocked);
      pre.forEach(exec);
      if (locked.length) Locks.with(function () { locked.forEach(exec); });
      Pipeline._emit(name, c, true, null);
      return c.result;
    } catch (e) {
      Pipeline._emit(name, c, false, e);
      throw e;
    }
  },
  /** Step ids and labels, for documentation and the Test Lab. */
  describe: function (steps) { return steps.map(function (s) { return { id: s.id, label: s.label, locked: !!s.locked }; }); },
  _emit: function (name, c, ok, e) {
    if (typeof __pipelineObserver !== 'function') return;
    try { __pipelineObserver({ pipeline: name, ok: ok, code: e ? (e.code || 'ERROR') : null, message: e ? String(e.message) : null, trace: c.trace, at: U.now(), subject: c.subject || null }); } catch (x) { /* observers never affect the outcome */ }
  }
};

/** Input validation. Every RPC handler validates its payload through these; failures become BAD_INPUT. */
var V = {
  obj: function (p) { if (!p || typeof p !== 'object' || Array.isArray(p)) fail('BAD_INPUT', 'Invalid request.'); return p; },
  str: function (v, name, opts) {
    opts = opts || {};
    if (v === undefined || v === null || v === '') { if (opts.optional) return opts.def !== undefined ? opts.def : ''; fail('BAD_INPUT', name + ' is required.'); }
    if (typeof v !== 'string') fail('BAD_INPUT', name + ' must be text.');
    var s = v.trim();
    var max = opts.max || 200, min = opts.min || 1;
    if (s.length < min) fail('BAD_INPUT', name + ' is too short.');
    if (s.length > max) fail('BAD_INPUT', name + ' is too long.');
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s)) fail('BAD_INPUT', name + ' contains invalid characters.');
    if (opts.re && !opts.re.test(s)) fail('BAD_INPUT', opts.reMsg || (name + ' has an invalid format.'));
    return s;
  },
  int: function (v, name, min, max, opts) {
    opts = opts || {};
    if ((v === undefined || v === null || v === '') && opts.optional) return opts.def !== undefined ? opts.def : null;
    var n = typeof v === 'number' ? v : (typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? parseInt(v, 10) : NaN);
    if (!isFinite(n) || Math.floor(n) !== n) fail('BAD_INPUT', name + ' must be a whole number.');
    if (n < min || n > max) fail('BAD_INPUT', name + ' must be between ' + min + ' and ' + max + '.');
    return n;
  },
  num: function (v, name, min, max, opts) {
    opts = opts || {};
    if ((v === undefined || v === null || v === '') && opts.optional) return opts.def !== undefined ? opts.def : null;
    var n = typeof v === 'number' ? v : parseFloat(v);
    if (!isFinite(n)) fail('BAD_INPUT', name + ' must be a number.');
    if (n < min || n > max) fail('BAD_INPUT', name + ' must be between ' + min + ' and ' + max + '.');
    return n;
  },
  bool: function (v) { return v === true || v === 'true'; },
  enumOf: function (v, name, values, opts) {
    opts = opts || {};
    if ((v === undefined || v === null || v === '') && opts.optional) return opts.def !== undefined ? opts.def : '';
    if (values.indexOf(v) < 0) fail('BAD_INPUT', name + ' must be one of: ' + values.join(', ') + '.');
    return v;
  },
  id: function (v, name, kind) {
    var re = new RegExp('^' + Cfg.ID_PREFIX[kind] + '-[0-9A-F]{12}$');
    if (typeof v !== 'string' || !re.test(v)) fail('BAD_INPUT', name + ' is invalid.');
    return v;
  },
  email: function (v, name) { return V.str(v, name || 'Email', { max: 120, re: /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/ }).toLowerCase(); },
  date: function (v, name) { if (!U.isDate(v)) fail('BAD_INPUT', (name || 'Date') + ' must be a valid date (YYYY-MM-DD).'); return v; },
  time: function (v, name) { if (!U.isTime(v)) fail('BAD_INPUT', (name || 'Time') + ' must be HH:MM (24 hour).'); return v; },
  arr: function (v, name, max) {
    if (!Array.isArray(v)) fail('BAD_INPUT', name + ' must be a list.');
    if (v.length > (max || 500)) fail('BAD_INPUT', name + ' has too many entries (max ' + (max || 500) + ').');
    return v;
  },
  rollNo: function (v) { return V.str(v, 'Roll number', { max: 20, min: 3, re: /^[A-Za-z0-9._-]+$/, reMsg: 'Roll number may only contain letters, digits, dot, dash and underscore.' }).toUpperCase(); },
  /** Indian mobile number; accepts +91 / 0 prefixes and spaces, returns the 10 digits. */
  mobile: function (v) {
    var s = V.str(v, 'Mobile number', { max: 20 }).replace(/[\s()-]/g, '');
    s = s.replace(/^(\+91|0091|91(?=\d{10}$)|0(?=\d{10}$))/, '');
    if (!/^[6-9]\d{9}$/.test(s)) fail('BAD_INPUT', 'Enter a 10-digit Indian mobile number.');
    return s;
  },
  latLng: function (lat, lng) {
    var a = V.num(lat, 'Latitude', -90, 90), b = V.num(lng, 'Longitude', -180, 180);
    return { lat: a, lng: b };
  }
};
