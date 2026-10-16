/**
 * Setup.gs - one-time initialisation and on-deployment diagnostics. Run these from the Apps Script editor
 * (they are NOT exposed through the web app; the RPC router has no route to them).
 *
 *   Setup.initialise()          create/verify the database spreadsheet, sheets, headers, formats, secrets
 *   Setup.setBootstrapAdmin(e)  the first admin (see README) - used once, when no admin exists
 *   Setup.selfTest()            verifies the platform assumptions this app depends on, with REAL timings
 *   setupInstallTriggers()      (Code.gs wrapper for Triggers.install) schedule the background jobs
 */
var Setup = {
  /** Idempotent. Never overwrites existing data, headers or secrets. Throws SCHEMA_MISMATCH instead of "fixing" data. */
  initialise: function (opts) {
    opts = opts || {};
    var props = PropertiesService.getScriptProperties();
    var ss, id = props.getProperty(Cfg.PROP.DB_ID);
    if (id) { ss = SpreadsheetApp.openById(id); }
    else {
      ss = SpreadsheetApp.create('LABFLOW Database');
      props.setProperty(Cfg.PROP.DB_ID, ss.getId());
    }
    Db.resetHandles();
    var created = [], checked = [];
    Object.keys(Cfg.SCHEMA).forEach(function (table) {
      var cols = Cfg.SCHEMA[table];
      var sheet = ss.getSheetByName(table);
      var header = cols.map(function (c) { return c.name; });
      if (!sheet) {
        sheet = ss.insertSheet(table);
        sheet.getRange(1, 1, 1, cols.length).setValues([header]);
        created.push(table);
      } else {
        var existing = sheet.getRange(1, 1, 1, cols.length).getValues()[0];
        var same = header.every(function (h, i) { return existing[i] === h; });
        if (!same) fail('SCHEMA_MISMATCH', 'Sheet "' + table + '" headers differ from the expected schema. Refusing to modify existing data.');
        checked.push(table);
      }
      // Plain-text format for text/JSON columns so ids like "007" or "=1+1" are stored literally, never parsed.
      var rows = sheet.getMaxRows();
      cols.forEach(function (c, i) { if (c.type === 's' || c.type === 'j') sheet.getRange(1, i + 1, rows, 1).setNumberFormat('@'); });
      sheet.getRange(1, 1, 1, cols.length).setFontWeight('bold');
      sheet.setFrozenRows(1);
    });
    var blank = ss.getSheetByName('Sheet1');
    if (blank && ss.getSheets().length > 1) { try { ss.deleteSheet(blank); } catch (e) {} }

    if (!props.getProperty(Cfg.PROP.HMAC)) props.setProperty(Cfg.PROP.HMAC, Setup._newSecret());
    if (opts.adminEmail) Setup.setBootstrapAdmin(opts.adminEmail);
    Db.resetHandles();
    var out = { spreadsheetId: ss.getId(), url: ss.getUrl(), created: created, verified: checked };
    if (!opts.silent) console.log(JSON.stringify(out));
    return out;
  },

  _newSecret: function () {
    return U.b64uEncode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Utilities.getUuid() + Utilities.getUuid() + U.now(), Utilities.Charset.UTF_8)) +
           U.b64uEncode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Math.random(), Utilities.Charset.UTF_8));
  },

  /** The first administrator. Honoured only while no active admin exists (see Auth.resolve). */
  setBootstrapAdmin: function (email) {
    email = V.email(email);
    var domains = Auth.allowedDomains();
    if (domains.indexOf(email.split('@')[1]) < 0) fail('DOMAIN_NOT_ALLOWED', 'Admin email must be on an allowed domain: ' + domains.join(', '));
    PropertiesService.getScriptProperties().setProperty(Cfg.PROP.BOOTSTRAP_ADMIN, email);
    return email;
  },

  /** Rotating the secret invalidates every QR currently on screen (they expire in a minute anyway). */
  rotateQrSecret: function () {
    PropertiesService.getScriptProperties().setProperty(Cfg.PROP.HMAC, Setup._newSecret());
    Audit.tryLog({ actor: 'script-owner', role: 'owner', action: 'secret.rotate', entityType: 'QR_HMAC_SECRET', result: 'ok' });
  },

  /** Private Drive folders (created lazily, owned by the script owner). */
  folder: function (propKey, name) {
    var props = PropertiesService.getScriptProperties();
    var id = props.getProperty(propKey);
    if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* recreate below */ } }
    var f = DriveApp.createFolder(name);
    props.setProperty(propKey, f.getId());
    return f;
  },

  // Known-answer vector generated with WebCrypto (ECDSA P-256 / SHA-256, IEEE-P1363 signature).
  _VECTOR: {
    pub: 'BCGlMXSRYVbUd6AO41HFYbRUbmvJehr2s_XIugnFkVfe9ddGAIdG1G_VkUwv32GjTqs-62EWUws5Pwc2LiYYGug',
    msg: 'labflow-selftest-vector-v1',
    sig: 'ZT2nQXeDyhB4WHxpQrNCWynJZeJULvR0agTI07gMyIEP8S-ewSAG-pDxZE7WKdat8GP_yiaBCKIM_oSa_r6opw'
  },

  /**
   * Verifies, on the REAL Apps Script runtime, the platform assumptions LABFLOW depends on. Run after deploying
   * and read the log. Nothing here is assumed to pass - the output is the evidence.
   */
  selfTest: function () {
    var r = { when: new Date().toISOString(), checks: [] };
    function check(name, fn) {
      var t = Date.now();
      try { var detail = fn(); r.checks.push({ name: name, ok: true, ms: Date.now() - t, detail: detail === undefined ? '' : detail }); }
      catch (e) { r.checks.push({ name: name, ok: false, ms: Date.now() - t, detail: String(e && e.message || e) }); }
    }
    check('Script time zone is Asia/Kolkata', function () {
      var tz = Session.getScriptTimeZone();
      if (tz !== Cfg.TZ) throw new Error('Script time zone is ' + tz + '. Set "timeZone" in appsscript.json / Project Settings.');
      return tz;
    });
    check('SHA-256 known answer (FIPS 180-2 "abc") + signed-byte handling', function () {
      var hex = U.sha256Hex('abc');
      if (hex !== 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad') throw new Error('SHA-256 mismatch: ' + hex);
      var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'abc');
      return 'raw digest has negative (signed) bytes: ' + raw.some(function (b) { return b < 0; });
    });
    check('P-256 verify: known-answer vector accepted', function () {
      var v = Setup._VECTOR;
      var ok = Creds.verifySignature(v.pub, v.msg, v.sig);
      if (!ok) throw new Error('valid vector rejected');
    });
    check('P-256 verify: tampered message rejected', function () {
      var v = Setup._VECTOR;
      if (Creds.verifySignature(v.pub, v.msg + 'x', v.sig)) throw new Error('tampered message accepted');
    });
    check('P-256 verify: timing (cold, then 5 warm runs)', function () {
      var v = Setup._VECTOR, t0 = Date.now(); Creds.verifySignature(v.pub, v.msg, v.sig);
      var cold = Date.now() - t0, t1 = Date.now();
      for (var i = 0; i < 5; i++) Creds.verifySignature(v.pub, v.msg, v.sig);
      return 'cold ' + cold + ' ms, warm avg ' + ((Date.now() - t1) / 5).toFixed(1) + ' ms';
    });
    check('Database reachable and schema present', function () {
      var missing = Object.keys(Cfg.SCHEMA).filter(function (t) { return !Db.spreadsheet().getSheetByName(t); });
      if (missing.length) throw new Error('missing sheets: ' + missing.join(', '));
      return Object.keys(Cfg.SCHEMA).length + ' sheets';
    });
    check('Sheet write + read-back latency (SystemLog row)', function () {
      var t = Date.now();
      Db.insert('SystemLog', { logId: U.id('log'), at: U.now(), level: 'info', source: 'selftest', message: 'selftest write' });
      var w = Date.now() - t; t = Date.now(); Db.tail('SystemLog', 1); return 'write ' + w + ' ms, tail-read ' + (Date.now() - t) + ' ms';
    });
    check('LockService acquire/release', function () { var t = Date.now(); Locks.with(function () {}); return (Date.now() - t) + ' ms'; });
    check('CacheService round-trip', function () { var c = CacheService.getScriptCache(); c.put('st', 'x', 10); if (c.get('st') !== 'x') throw new Error('cache miss'); });
    check('QR secret present', function () { if (!PropertiesService.getScriptProperties().getProperty(Cfg.PROP.HMAC)) throw new Error('missing - run Setup.initialise()'); });
    check('Mail quota available', function () { return MailApp.getRemainingDailyQuota() + ' messages left today'; });
    check('Allowed domains', function () { return Auth.allowedDomains().join(', '); });
    check('Triggers installed', function () { return Triggers.status().summary; });
    r.allOk = r.checks.every(function (c) { return c.ok; });
    console.log(JSON.stringify(r, null, 2));
    return r;
  }
};
