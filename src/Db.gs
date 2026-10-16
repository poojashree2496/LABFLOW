/**
 * Db.gs - the Google Sheets data layer.
 *
 * Design rules
 *  - One sheet per table, header row = Cfg.SCHEMA column names. Row numbers never change (no deletes).
 *  - Every write goes through Db.insert / Db.update / Db.insertMany, which take the (re-entrant) script lock,
 *    enforce uniqueness and invalidate caches. Nothing else in the code base writes to a data sheet.
 *  - Reads of single records use Db.cachedGet (CacheService, short TTL, invalidated by every write to that
 *    record), so security-relevant state such as credential revocation takes effect immediately.
 */
var Locks = {
  depth: 0,
  /** Run fn under the script-wide lock. Re-entrant within one execution. */
  with: function (fn, timeoutMs) {
    if (Locks.depth > 0) { Locks.depth++; try { return fn(); } finally { Locks.depth--; } }
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(timeoutMs || 25000)) fail('BUSY', 'The system is busy. Please try again in a few seconds.');
    Locks.depth = 1;
    try { return fn(); }
    finally { Locks.depth = 0; lock.releaseLock(); }
  }
};

var Db = (function () {
  var ss = null;
  var sheets = {};

  var scratch = false;
  function spreadsheet() {
    if (ss) return ss;
    var id = PropertiesService.getScriptProperties().getProperty(Cfg.PROP.DB_ID);
    if (!id) fail('NOT_INITIALISED', 'The database has not been created yet. Run Setup.initialise() from the Apps Script editor.');
    ss = SpreadsheetApp.openById(id);
    return ss;
  }
  function sheet(table) {
    if (!Cfg.SCHEMA[table]) throw new Error('Unknown table ' + table);
    if (sheets[table]) return sheets[table];
    var s = spreadsheet().getSheetByName(table);
    if (!s) fail('NOT_INITIALISED', 'Sheet "' + table + '" is missing. Run Setup.initialise().');
    sheets[table] = s;
    return s;
  }
  function cols(table) { return Cfg.SCHEMA[table]; }
  function colIndex(table, name) {
    var c = cols(table);
    for (var i = 0; i < c.length; i++) if (c[i].name === name) return i;
    throw new Error('Unknown column ' + table + '.' + name);
  }

  function fromCell(type, v) {
    if (type === 'n') return (v === '' || v === null || v === undefined) ? null : Number(v);
    if (type === 'b') return v === true || v === 'TRUE' || v === 'true';
    if (type === 'j') { if (v === '' || v === null || v === undefined) return null; try { return JSON.parse(v); } catch (e) { return null; } }
    return (v === null || v === undefined) ? '' : String(v);
  }
  function toCell(type, v) {
    if (v === undefined || v === null) return '';
    if (type === 'j') return JSON.stringify(v);
    if (type === 'b') return !!v;
    if (type === 'n') return v === '' ? '' : Number(v);
    return String(v);
  }
  function defaultFor(type) { return type === 'n' ? null : type === 'b' ? false : type === 'j' ? null : ''; }
  function rowToObj(table, row, rowNum) {
    var o = {};
    var c = cols(table);
    for (var i = 0; i < c.length; i++) o[c[i].name] = fromCell(c[i].type, row[i]);
    Object.defineProperty(o, '__row', { value: rowNum, enumerable: false, writable: true });
    return o;
  }
  function objToRow(table, o) {
    return cols(table).map(function (c) { return toCell(c.type, o[c.name]); });
  }

  // ---- reading ---------------------------------------------------------------------------------
  function readAll(table) {
    var s = sheet(table);
    var last = s.getLastRow();
    if (last < 2) return [];
    var vals = s.getRange(2, 1, last - 1, cols(table).length).getValues();
    var out = [];
    for (var i = 0; i < vals.length; i++) {
      if (vals[i][0] === '' || vals[i][0] === null) continue; // skip blank rows
      out.push(rowToObj(table, vals[i], i + 2));
    }
    return out;
  }
  function where(table, pred) { return readAll(table).filter(pred); }
  function whereEq(table, match) {
    var keys = Object.keys(match);
    return readAll(table).filter(function (r) { return keys.every(function (k) { return r[k] === match[k]; }); });
  }
  /** Last n rows, oldest first. One range read, independent of table size. */
  function tail(table, n) {
    var s = sheet(table);
    var last = s.getLastRow();
    if (last < 2) return [];
    var first = Math.max(2, last - n + 1);
    var vals = s.getRange(first, 1, last - first + 1, cols(table).length).getValues();
    return vals.map(function (v, i) { return rowToObj(table, v, first + i); }).filter(function (r) { return r[cols(table)[0].name] !== '' && r[cols(table)[0].name] !== null; });
  }
  function count(table) { return Math.max(0, sheet(table).getLastRow() - 1); }

  /** Sheet row number (>=2) of the first record whose column equals value, or 0. Reads one column only. */
  function findRow(table, colName, value) {
    var s = sheet(table);
    var last = s.getLastRow();
    if (last < 2) return 0;
    var idx = colIndex(table, colName);
    var type = cols(table)[idx].type;
    var vals = s.getRange(2, idx + 1, last - 1, 1).getValues();
    var want = toCell(type, value);
    for (var i = 0; i < vals.length; i++) {
      var v = vals[i][0];
      if (v === '' && want === '') continue;
      if (v === want || String(v) === String(want)) return i + 2;
    }
    return 0;
  }
  function readRow(table, rowNum) {
    var vals = sheet(table).getRange(rowNum, 1, 1, cols(table).length).getValues();
    return rowToObj(table, vals[0], rowNum);
  }
  function getBy(table, colName, value) {
    if (value === '' || value === null || value === undefined) return null;
    var r = findRow(table, colName, value);
    return r ? readRow(table, r) : null;
  }
  function get(table, id) { return getBy(table, cols(table)[0].name, id); }
  function mustGet(table, id, what) {
    var r = get(table, id);
    if (!r) fail('NOT_FOUND', (what || 'Record') + ' not found.');
    return r;
  }

  // ---- caching -----------------------------------------------------------------------------------
  function cacheKey(table, col, value) {
    var k = 'db|' + table + '|' + col + '|' + value;
    return k.length > 240 ? 'db|h|' + U.sha256Hex(k) : k;
  }
  /** Cached single-record lookup by a cache-flagged column (see Cfg.SCHEMA). TTL seconds. */
  function cachedGet(table, colName, value, ttl) {
    if (value === '' || value === null || value === undefined) return null;
    var key = cacheKey(table, colName, value);
    var cache = CacheService.getScriptCache();
    try {
      var hit = cache.get(key);
      if (hit) {
        var parsed = JSON.parse(hit);
        Object.defineProperty(parsed, '__row', { value: parsed.__r, enumerable: false, writable: true });
        delete parsed.__r;
        return parsed;
      }
    } catch (e) { /* cache problems must never break a request */ }
    var rec = getBy(table, colName, value);
    if (rec) {
      try { var copy = Object.assign({}, rec); copy.__r = rec.__row; cache.put(key, JSON.stringify(copy), ttl || 300); } catch (e) {}
    }
    return rec;
  }
  function invalidate(table, rec) {
    try {
      var keys = [];
      cols(table).forEach(function (c) { if (c.cache && rec && rec[c.name] !== '' && rec[c.name] != null) keys.push(cacheKey(table, c.name, rec[c.name])); });
      if (keys.length) CacheService.getScriptCache().removeAll(keys);
      if (table === 'Config') Settings.reset();
    } catch (e) {}
  }

  // ---- writing -----------------------------------------------------------------------------------
  /** Grow the grid when needed. New rows must keep the plain-text format, or Sheets would turn "007" into 7. */
  function ensureCapacity(s, lastNeededRow, table) {
    var max = s.getMaxRows();
    if (lastNeededRow <= max) return;
    var add = Math.max(500, lastNeededRow - max);
    s.insertRowsAfter(max, add);
    cols(table).forEach(function (c, i) { if (c.type === 's' || c.type === 'j') s.getRange(max + 1, i + 1, add, 1).setNumberFormat('@'); });
  }
  function normalise(table, obj) {
    var rec = {};
    cols(table).forEach(function (c) { rec[c.name] = obj[c.name] !== undefined ? obj[c.name] : defaultFor(c.type); });
    return rec;
  }
  /** Primary keys are generated (random UUID-based ids or a lock-protected sequence), so inserts skip the
   *  O(n) primary-key scan. Explicit unique columns (email, rollNo, serial ...) are always checked. */
  function checkUnique(table, rec, ignoreRow, pending, isInsert) {
    cols(table).forEach(function (c) {
      if (!c.unique) return;
      if (isInsert && c.pk) return;
      var v = rec[c.name];
      if (v === '' || v === null || v === undefined) return;
      var r = findRow(table, c.name, v);
      if (r && r !== ignoreRow) fail('DUPLICATE', 'A record with this ' + c.name + ' already exists.', { table: table, column: c.name });
      if (pending) {
        var key = c.name + '=' + v;
        if (pending[key]) fail('DUPLICATE', 'Duplicate ' + c.name + ' in the submitted data.', { table: table, column: c.name });
        pending[key] = true;
      }
    });
  }

  function insert(table, obj) {
    return Locks.with(function () {
      var rec = normalise(table, obj);
      checkUnique(table, rec, 0, null, true);
      var s = sheet(table);
      var row = s.getLastRow() + 1;
      ensureCapacity(s, row, table);
      s.getRange(row, 1, 1, cols(table).length).setValues([objToRow(table, rec)]);
      Object.defineProperty(rec, '__row', { value: row, enumerable: false, writable: true });
      invalidate(table, rec);
      return rec;
    });
  }
  /** Insert many rows with one range write. All-or-nothing with respect to uniqueness. */
  function insertMany(table, objs) {
    if (!objs.length) return [];
    return Locks.with(function () {
      var recs = objs.map(function (o) { return normalise(table, o); });
      var pending = {};
      // For large imports, read each unique column once instead of once per row.
      var uniqCols = cols(table).filter(function (c) { return c.unique && !c.pk; });
      var existing = {};
      uniqCols.forEach(function (c) {
        var s0 = sheet(table), last0 = s0.getLastRow(), set = {};
        if (last0 >= 2) s0.getRange(2, colIndex(table, c.name) + 1, last0 - 1, 1).getValues().forEach(function (v) { if (v[0] !== '') set[String(v[0])] = true; });
        existing[c.name] = set;
      });
      recs.forEach(function (rec) {
        uniqCols.forEach(function (c) {
          var v = rec[c.name];
          if (v === '' || v === null || v === undefined) return;
          if (existing[c.name][String(v)]) fail('DUPLICATE', 'A record with this ' + c.name + ' already exists (' + v + ').', { table: table, column: c.name });
          var key = c.name + '=' + v;
          if (pending[key]) fail('DUPLICATE', 'Duplicate ' + c.name + ' in the submitted data (' + v + ').', { table: table, column: c.name });
          pending[key] = true;
        });
      });
      var s = sheet(table);
      var start = s.getLastRow() + 1;
      ensureCapacity(s, start + recs.length - 1, table);
      s.getRange(start, 1, recs.length, cols(table).length).setValues(recs.map(function (r) { return objToRow(table, r); }));
      recs.forEach(function (r, i) { Object.defineProperty(r, '__row', { value: start + i, enumerable: false, writable: true }); invalidate(table, r); });
      return recs;
    });
  }
  function update(table, id, patch) {
    return Locks.with(function () {
      var pk = cols(table)[0].name;
      var rowNum = findRow(table, pk, id);
      if (!rowNum) fail('NOT_FOUND', 'Record not found.');
      var cur = readRow(table, rowNum);
      var next = Object.assign({}, cur, patch);
      next[pk] = cur[pk]; // the primary key is immutable
      Object.keys(patch).forEach(function (k) { if (!cols(table).some(function (c) { return c.name === k; })) throw new Error('Unknown column ' + table + '.' + k); });
      checkUnique(table, next, rowNum);
      sheet(table).getRange(rowNum, 1, 1, cols(table).length).setValues([objToRow(table, next)]);
      Object.defineProperty(next, '__row', { value: rowNum, enumerable: false, writable: true });
      invalidate(table, cur);
      invalidate(table, next);
      return next;
    });
  }
  /** Overwrite a row whose number is known (rows never move). For derived tables rebuilt in bulk; no uniqueness checks. */
  function putRow(table, rowNum, obj) {
    return Locks.with(function () {
      sheet(table).getRange(rowNum, 1, 1, cols(table).length).setValues([objToRow(table, normalise(table, obj))]);
      invalidate(table, obj);
    });
  }
  /** Update an already-read record in place (row number known). Caller must hold the lock or accept last-writer-wins. */
  function updateRecord(table, rec, patch) { return update(table, rec[cols(table)[0].name], patch); }

  return {
    readAll: readAll, where: where, whereEq: whereEq, tail: tail, count: count, findRow: findRow,
    get: get, getBy: getBy, mustGet: mustGet, cachedGet: cachedGet, invalidate: invalidate,
    insert: insert, insertMany: insertMany, update: update, updateRecord: updateRecord, putRow: putRow,
    sheet: sheet, spreadsheet: spreadsheet, resetHandles: function () { ss = null; sheets = {}; scratch = false; },
    /** Point THIS execution at another spreadsheet (used only by Setup.benchmarkScans). Other executions are unaffected. */
    useSpreadsheet: function (other) { ss = other; sheets = {}; scratch = true; },
    isScratch: function () { return scratch; }
  };
})();
