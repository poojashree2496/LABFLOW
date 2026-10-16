/**
 * AuditService.gs - tamper-evident audit trail and operational log.
 *
 * Each audit row stores hash = SHA-256(previousHash | canonical row). Rewriting or deleting any row breaks
 * every later hash, which Audit.verify() detects.
 *
 * HONEST LIMITS (also in SECURITY.md): the spreadsheet owner can edit every row AND recompute the whole chain.
 * To make that detectable we publish checkpoints (seq + head hash) somewhere the owner cannot silently
 * rewrite: (1) AuditCheckpoints sheet and a script property (weak - same owner), and (2) a daily email of the
 * head hash to the configured report recipients (strong - copies already sitting in other people's inboxes).
 * Audit.verify() compares the live chain against all of these.
 */
var GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

var Audit = {
  _canonical: function (r) {
    return [r.seq, r.eventId, r.at, r.actor, r.role, r.action, r.entityType, r.entityId, r.result, JSON.stringify(r.detail || null)].join('␟');
  },

  /**
   * Append an audit event. Must succeed for security-relevant operations, so it throws on failure.
   * evt: { actor, role, action, entityType, entityId, result, detail }
   */
  log: function (evt) {
    return Locks.with(function () {
      var last = Db.tail('AuditEvents', 1)[0];
      var rec = {
        seq: last ? last.seq + 1 : 1,
        eventId: U.id('audit'),
        at: U.now(),
        actor: evt.actor || 'system',
        role: evt.role || '',
        action: String(evt.action),
        entityType: evt.entityType || '',
        entityId: evt.entityId || '',
        result: evt.result || 'ok',
        detail: evt.detail === undefined ? null : evt.detail,
        prevHash: last ? last.hash : GENESIS_HASH
      };
      rec.hash = U.sha256Hex(rec.prevHash + '|' + Audit._canonical(rec));
      Db.insert('AuditEvents', rec);
      var every = Settings.get('auditCheckpointEvery');
      if (rec.seq % every === 0) Audit.checkpoint('periodic');
      return rec;
    });
  },
  /** For denials and other best-effort records: never let logging failure change the outcome. */
  tryLog: function (evt) { try { return Audit.log(evt); } catch (e) { Syslog.error('audit', 'AUDIT_WRITE_FAILED', String(e && e.message)); return null; } },

  checkpoint: function (note) {
    return Locks.with(function () {
      var last = Db.tail('AuditEvents', 1)[0];
      if (!last) return null;
      var cp = Db.insert('AuditCheckpoints', { checkpointId: U.id('checkpoint'), seq: last.seq, hash: last.hash, at: U.now(), note: note || '' });
      if (!Db.isScratch()) PropertiesService.getScriptProperties().setProperty(Cfg.PROP.AUDIT_HEAD, last.seq + ':' + last.hash);
      return cp;
    });
  },

  /** Re-walk the whole chain. Returns a report; never throws for tamper findings. */
  verify: function () {
    var rows = Db.readAll('AuditEvents');
    var prev = GENESIS_HASH, problems = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.seq !== i + 1) { problems.push({ seq: r.seq, problem: 'sequence gap or reorder (expected ' + (i + 1) + ')' }); }
      if (r.prevHash !== prev) problems.push({ seq: r.seq, problem: 'previous-hash link broken' });
      var expect = U.sha256Hex(r.prevHash + '|' + Audit._canonical(r));
      if (expect !== r.hash) problems.push({ seq: r.seq, problem: 'row content does not match its hash' });
      prev = r.hash;
      if (problems.length >= 20) break;
    }
    var head = rows.length ? rows[rows.length - 1] : null;
    // Compare with stored checkpoints (detects a fully recomputed chain only if a checkpoint copy was kept elsewhere).
    var bySeq = {};
    rows.forEach(function (r) { bySeq[r.seq] = r.hash; });
    var cpBad = [];
    Db.readAll('AuditCheckpoints').forEach(function (c) {
      if (bySeq[c.seq] === undefined) cpBad.push({ seq: c.seq, problem: 'checkpoint refers to a row that no longer exists (truncation?)' });
      else if (bySeq[c.seq] !== c.hash) cpBad.push({ seq: c.seq, problem: 'checkpoint hash differs from the chain (rewritten?)' });
    });
    var prop = PropertiesService.getScriptProperties().getProperty(Cfg.PROP.AUDIT_HEAD);
    var propBad = null;
    if (prop) {
      var pp = prop.split(':'), ps = parseInt(pp[0], 10);
      if (bySeq[ps] === undefined) propBad = 'stored head (seq ' + ps + ') no longer exists';
      else if (bySeq[ps] !== pp[1]) propBad = 'stored head hash differs from the chain at seq ' + ps;
    }
    return {
      ok: problems.length === 0 && cpBad.length === 0 && !propBad,
      rows: rows.length, headSeq: head ? head.seq : 0, headHash: head ? head.hash : GENESIS_HASH,
      chainProblems: problems, checkpointProblems: cpBad, storedHeadProblem: propBad,
      note: 'A matching chain proves internal consistency. Compare headHash with the emailed daily anchors to detect a fully rewritten chain.'
    };
  }
};

/** Operational log for unexpected errors and job results (admin "error summaries"). */
var Syslog = {
  _write: function (level, source, code, message, detail) {
    try {
      Db.insert('SystemLog', { logId: U.id('log'), at: U.now(), level: level, source: source, code: code, message: String(message).slice(0, 500), detail: detail || null });
    } catch (e) { /* last resort: Apps Script's own logger */ console.error(source + ' ' + code + ' ' + message); }
  },
  error: function (source, code, message, detail) { Syslog._write('error', source, code, message, detail); },
  warn: function (source, code, message, detail) { Syslog._write('warn', source, code, message, detail); },
  info: function (source, code, message, detail) { Syslog._write('info', source, code, message, detail); }
};
