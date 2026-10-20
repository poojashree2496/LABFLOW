/**
 * TriggerService.gs - the only place triggers are created, and the entry points they call.
 *
 * Safety rules
 *  - Exactly five LABFLOW triggers exist (see HANDLERS). install() removes ONLY triggers whose handler is one of
 *    ours and recreates them, so running it twice never produces duplicates and never touches other projects' triggers.
 *  - Every entry point goes through Jobs.run(): it takes the script lock with a short wait and SKIPS the run if
 *    another execution holds it (no pile-up), logs a JobRuns row, catches and logs failures, and never throws, so Apps
 *    Script does not disable the trigger after repeated errors.
 *  - Jobs are idempotent: sessions materialise via a unique slotKey, notifications dedupe via dedupeKey, daily reports
 *    use a JobRuns marker, and the audit anchor is emailed at most once per date.
 *  - Time budget: heavy jobs check a deadline (4.5 minutes of the 6-minute limit) and stop cleanly; the next run resumes.
 */
var Triggers = {
  HANDLERS: {
    trg_tickSessions: { every: 'minutes', n: 5, desc: 'Open timetabled sessions, rescan windows, auto-close stale sessions, release no-show bookings, overstay alerts' },
    trg_sendEmails: { every: 'hours', n: 1, desc: 'Send queued notification emails as one digest per person' },
    trg_nightly: { every: 'day', hour: 1, desc: 'Materialise timetable sessions, reconcile attendance and inventory, audit checkpoint, monthly audit on the 1st, backup copy of the spreadsheet with rotation (A3), yearly archive in July (A4)' },
    trg_morning: { every: 'day', hour: 8, desc: 'Overdue reminders, daily report, audit anchor email' },
    trg_evening: { every: 'day', hour: 18, desc: 'Daily digest per lab to the lab incharges (FR-34)' }
  },

  install: function () {
    var ours = Object.keys(Triggers.HANDLERS), removed = 0, created = [];
    ScriptApp.getProjectTriggers().forEach(function (t) { if (ours.indexOf(t.getHandlerFunction()) >= 0) { ScriptApp.deleteTrigger(t); removed++; } });
    ours.forEach(function (name) {
      var h = Triggers.HANDLERS[name], b = ScriptApp.newTrigger(name).timeBased();
      if (h.every === 'minutes') b = b.everyMinutes(h.n);
      else if (h.every === 'hours') b = b.everyHours(h.n);
      else b = b.everyDays(1).atHour(h.hour);
      b.create(); created.push(name);
    });
    return { removed: removed, created: created };
  },

  remove: function () {
    var ours = Object.keys(Triggers.HANDLERS), n = 0;
    ScriptApp.getProjectTriggers().forEach(function (t) { if (ours.indexOf(t.getHandlerFunction()) >= 0) { ScriptApp.deleteTrigger(t); n++; } });
    return { removed: n };
  },

  status: function () {
    var have = {}, extra = 0;
    ScriptApp.getProjectTriggers().forEach(function (t) {
      var h = t.getHandlerFunction();
      if (Triggers.HANDLERS[h]) have[h] = (have[h] || 0) + 1; else extra++;
    });
    var names = Object.keys(Triggers.HANDLERS);
    var missing = names.filter(function (n) { return !have[n]; }), dup = names.filter(function (n) { return have[n] > 1; });
    return { ok: !missing.length && !dup.length, missing: missing, duplicated: dup, otherTriggers: extra,
             summary: missing.length || dup.length ? ('PROBLEM - missing: [' + missing.join(', ') + '] duplicated: [' + dup.join(', ') + ']. Run setupInstallTriggers().') : 'all ' + names.length + ' installed' };
  }
};

var Jobs = {
  BUDGET_MS: 270000,
  // Minimum seconds between runs of each job. Trigger entry points are global functions, so (like every global function in a
  // web-app project) a signed-in user could invoke them through google.script.run. They return nothing, are idempotent, and
  // this throttle caps the effect of repeated calls to at most one early run per interval.
  MIN_GAP_SEC: { tickSessions: 120, sendEmails: 900, nightly: 3600, morning: 3600, evening: 3600 },
  run: function (name, fn) {
    var started = U.now(), deadline = started + Jobs.BUDGET_MS;
    var gap = Jobs.MIN_GAP_SEC[name] || 60, cache = CacheService.getScriptCache(), gk = 'job|' + name;
    try { if (cache.get(gk)) { return { skipped: 'throttled' }; } cache.put(gk, '1', gap); } catch (e) { /* cache unavailable: run anyway */ }
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(8000)) { Syslog.info('jobs', 'SKIPPED_BUSY', name); return { skipped: 'busy' }; }
    // Hold the lock only while the job's own steps take it (they re-enter via Locks); release first so web requests stay responsive.
    lock.releaseLock();
    var status = 'ok', detail = null;
    try { detail = fn(deadline); }
    catch (e) {
      status = 'error'; detail = { error: String(e && e.message).slice(0, 300), code: e && e.code };
      Syslog.error('jobs', 'JOB_FAILED', name + ': ' + String(e && e.message), { stack: String(e && e.stack).slice(0, 400) });
    }
    try { Db.insert('JobRuns', { runId: U.id('run'), job: name, startedAt: started, finishedAt: U.now(), status: status, detail: detail }); } catch (e) { /* logging must never fail the job */ }
    return { status: status, detail: detail };
  },
  /** Run one named step; a failing step is recorded and does not stop the later steps. */
  step: function (results, name, fn) {
    try { results[name] = fn(); } catch (e) { results[name] = { error: String(e && e.message).slice(0, 200) }; Syslog.error('jobs', 'STEP_FAILED', name + ': ' + String(e && e.message)); }
  },

  tickSessions: function () {
    return Jobs.run('tickSessions', function () {
      var r = {};
      Jobs.step(r, 'autoOpen', function () { return Sessions.autoOpenDue(); });
      Jobs.step(r, 'rescans', function () { return Attend.tickRescans(); });
      Jobs.step(r, 'autoClose', function () { return Sessions.autoCloseStale(); });
      Jobs.step(r, 'bookings', function () { return Booking.expireStale(); });
      Jobs.step(r, 'overstay', function () { return Jobs.overstay(); });
      return r;
    });
  },
  sendEmails: function () { return Jobs.run('sendEmails', function (deadline) { return Notify.flushEmails(deadline); }); },

  nightly: function () {
    return Jobs.run('nightly', function (deadline) {
      var r = {}, today = U.local(U.now()).date;
      Jobs.step(r, 'materialize', function () { return [0, 1, 2].map(function (d) { return Sessions.materialize(U.addDays(today, d)); }); });
      Jobs.step(r, 'materializeOpenLab', function () { return [0, 1, 2].map(function (d) { return Sessions.materializeOpenLab(U.addDays(today, d)); }); });
      Jobs.step(r, 'attendanceReconcile', function () {
        var out = [], cutoff = U.addDays(today, -2);
        Db.where('Sessions', function (s) { return s.status === 'closed' && s.date >= cutoff; }).forEach(function (s) { if (U.now() < deadline) { var x = Attend.reconcile(s.sessionId); if (x.problems.length) out.push({ sessionId: s.sessionId, problems: x.problems.length }); } });
        if (out.length) Notify.toRole('admin', 'integrity', 'Attendance consistency findings', out.length + ' session(s) have inconsistencies. See the audit view.', 'att-reconcile:' + today);
        return { sessionsWithProblems: out };
      });
      Jobs.step(r, 'inventoryReconcile', function () {
        var rep = Assets.reconcile({ fix: true });
        if (rep.fixed) Notify.toRole('admin', 'integrity', 'Inventory auto-repaired', rep.fixed + ' derived stock value(s) were out of step with loan records and were corrected.', 'inv-reconcile:' + today);
        return { fixed: rep.fixed, stale: rep.staleLoans.length };
      });
      Jobs.step(r, 'encryptMobiles', function () { return Users.encryptMobiles(); });
      Jobs.step(r, 'auditCheckpoint', function () { var c = Audit.checkpoint('nightly'); return c ? { seq: c.seq } : null; });
      Jobs.step(r, 'monthlyAudit', function () {
        if (U.local(U.now()).d !== 1) return { skipped: 'not the 1st' };
        return Reports.runScheduledMonthly(U.local(U.dayStart(today) - 86400000).month);
      });
      // Last, so the copy includes everything the steps above wrote tonight (A3).
      Jobs.step(r, 'backup', function () { return Backup.nightly(); });
      // Each July, archive academic years older than the previous one. Only runs when tonight's backup exists (A4).
      Jobs.step(r, 'archive', function () { return Backup.autoArchive(deadline); });
      return r;
    });
  },

  evening: function () {
    return Jobs.run('evening', function (deadline) {
      var r = {}, today = U.local(U.now()).date;
      Jobs.step(r, 'digest', function () { return Reports.runScheduledDigest(today, deadline); });
      return r;
    });
  },

  /**
   * Students still inside a lab after its closing time (SRS B.3): one alert per lab per day to lab staff and the lab
   * incharges, overstayAlertMinutes after closing.
   */
  overstay: function () {
    var now = U.now(), today = U.local(now).date, alerts = 0, after = Settings.get('overstayAlertMinutes') * 60000;
    Db.where('Labs', function (l) { return l.status === 'active' && l.closeTime; }).forEach(function (lab) {
      var closes = Labs.closesAt(lab, today);
      if (!closes || now < closes + after || now > closes + 6 * 3600000) return;
      var marker = 'overstay:' + lab.labId + ':' + today;
      if (Db.where('JobRuns', function (j) { return j.job === marker; }).length) return;
      var occ = Occupancy.lab(lab.labId);
      Db.insert('JobRuns', { runId: U.id('run'), job: marker, startedAt: now, finishedAt: now, status: 'ok', detail: { inside: occ.inside } });
      if (!occ.inside) return;
      var names = [];
      Db.where('Sessions', function (s) { return s.labId === lab.labId && s.status === 'open'; }).forEach(function (s) {
        var eff = Attend._effective(Attend._eventsFor(s));
        Object.keys(eff).forEach(function (sid) { if (Attend._compute(s, eff[sid], [], now).inside) { var st = Db.cachedGet('StudentProfiles', 'studentId', sid, 300) || {}; names.push((st.name || sid) + ' (' + (st.rollNo || '') + ')'); } });
      });
      var title = lab.code + ' closed at ' + lab.closeTime + ': ' + occ.inside + ' still inside';
      var body = names.slice(0, 30).join(', ') + (names.length > 30 ? ' and ' + (names.length - 30) + ' more' : '') + '. Ask them to scan out, or close the session.';
      Notify.toRole('staff', 'overstay', title, body, marker);
      Labs.incharges(lab).forEach(function (e) { Notify.toEmail(e, 'overstay', title, body, marker); });
      alerts++;
    });
    return { alerts: alerts };
  },

  morning: function () {
    return Jobs.run('morning', function (deadline) {
      var r = {}, today = U.local(U.now()).date, yesterday = U.addDays(today, -1);
      Jobs.step(r, 'overdue', function () { return Loans.sendOverdueReminders(); });
      Jobs.step(r, 'dailyReport', function () { return Reports.runScheduledDaily(yesterday); });
      Jobs.step(r, 'auditAnchor', function () { return Jobs.emailAuditAnchor(today); });
      return r;
    });
  },

  /**
   * Email the audit head hash to the configured recipients, once per date. Copies in other people's inboxes are the
   * external anchor that makes a fully recomputed audit chain detectable (see SECURITY.md).
   */
  emailAuditAnchor: function (date) {
    var marker = 'audit-anchor:' + date;
    if (Db.where('JobRuns', function (j) { return j.job === marker && j.status === 'ok'; }).length) return { skipped: 'already sent' };
    var v = Audit.verify();
    var recipients = String(Settings.get('reportRecipients') || '').split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(function (e) { return /@/.test(e) && Auth.allowedDomains().indexOf(e.split('@')[1]) >= 0; });
    var sent = 0, body = 'LABFLOW audit anchor for ' + date + '\n\nRows: ' + v.rows + '\nHead sequence: ' + v.headSeq + '\nHead hash: ' + v.headHash + '\nChain verification: ' + (v.ok ? 'OK' : 'PROBLEMS FOUND (' + v.chainProblems.length + ' chain, ' + v.checkpointProblems.length + ' checkpoint)') +
      '\n\nKeep this message. If the spreadsheet is ever rewritten, the head hash of a past date will no longer match the chain.\n';
    recipients.forEach(function (to) { if (Notify.sendNow(to, 'Audit anchor ' + date + (v.ok ? '' : ' - PROBLEMS'), body)) sent++; });
    if (!v.ok) Notify.toRole('admin', 'integrity', 'Audit chain verification FAILED', 'Open the audit view for details.', 'audit-fail:' + date);
    Db.insert('JobRuns', { runId: U.id('run'), job: marker, startedAt: U.now(), finishedAt: U.now(), status: 'ok', detail: { headSeq: v.headSeq, ok: v.ok, sent: sent } });
    return { headSeq: v.headSeq, ok: v.ok, sent: sent };
  }
};

// Global trigger entry points (Apps Script resolves handlers by global function name).
function trg_tickSessions() { Jobs.tickSessions(); }
function trg_sendEmails() { Jobs.sendEmails(); }
function trg_nightly() { Jobs.nightly(); }
function trg_morning() { Jobs.morning(); }
function trg_evening() { Jobs.evening(); }
