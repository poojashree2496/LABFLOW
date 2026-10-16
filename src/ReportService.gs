/**
 * ReportService.gs - reports as plain tables { title, columns, rows, meta }, exportable as CSV or PDF.
 *
 * Types: daily, monthly, faculty, student, utilisation, assetUsage, inventory, overdue, audit.
 * Authorisation (enforced here, in addition to the RPC permission table):
 *   admin/staff: everything except audit (admin only); faculty: own 'faculty' report and 'student' reports for students
 *   in their courses/sessions; student: own 'student' report only.
 * Limits: reports read bounded date ranges (<= 366 days) and are capped at 5000 rows (CSV) / 1000 rows (PDF) so a request
 * stays well inside the 6-minute execution limit; the result says when it was truncated.
 * Exports are returned to the browser (CSV text / base64 PDF). Scheduled reports are saved to a private Drive folder.
 */
var Reports = {
  TYPES: ['daily', 'monthly', 'faculty', 'student', 'utilisation', 'assetUsage', 'inventory', 'overdue', 'audit'],
  MAX_ROWS: 5000, MAX_PDF_ROWS: 1000,

  _range: function (p, defDays) {
    var to = p.to ? V.date(p.to, 'To') : U.local(U.now()).date;
    var from = p.from ? V.date(p.from, 'From') : U.addDays(to, -(defDays || 30));
    if (from > to) fail('BAD_INPUT', 'The start date is after the end date.');
    if (U.addDays(from, 366) < to) fail('BAD_INPUT', 'Choose a range of at most 366 days.');
    return { from: from, to: to, fromMs: U.dayStart(from), toMs: U.dayStart(U.addDays(to, 1)) };
  },

  _authorize: function (ctx, type, p) {
    var admin = ctx.has('admin'), staff = ctx.has('staff');
    if (type === 'audit') { if (!admin) fail('FORBIDDEN', 'Only administrators can export the audit trail.'); return {}; }
    if (type === 'student') {
      if (admin || staff) return { studentId: V.id(p.studentId, 'Student', 'student') };
      if (ctx.has('faculty') && p.studentId) {
        var id = V.id(p.studentId, 'Student', 'student');
        if (!Roster.studentIdsForFaculty(ctx.faculty && ctx.faculty.facultyId)[id]) fail('FORBIDDEN', 'That student is not in any of your courses or sessions.');
        return { studentId: id };
      }
      if (ctx.student) return { studentId: ctx.student.studentId }; // a student can only ever get their own report
      fail('FORBIDDEN', 'You do not have permission to view this report.');
    }
    if (type === 'faculty') {
      if (admin || staff) return { facultyId: V.id(p.facultyId, 'Faculty', 'faculty') };
      if (ctx.faculty) return { facultyId: ctx.faculty.facultyId };
      fail('FORBIDDEN', 'You do not have permission to view this report.');
    }
    if (!admin && !staff) fail('FORBIDDEN', 'You do not have permission to view this report.');
    return {};
  },

  run: function (ctx, p) {
    V.obj(p);
    var type = V.enumOf(p.type, 'Report type', Reports.TYPES);
    var scope = Reports._authorize(ctx, type, p);
    var rep = Reports.build(type, Object.assign({}, p, scope));
    return rep;
  },

  build: function (type, p) {
    var fn = Reports['_' + type];
    var rep = fn(p);
    rep.type = type;
    rep.generatedAt = U.now();
    rep.truncated = false;
    if (rep.rows.length > Reports.MAX_ROWS) { rep.rows = rep.rows.slice(0, Reports.MAX_ROWS); rep.truncated = true; }
    return rep;
  },

  _sessionsIn: function (r, pred) {
    return Db.where('Sessions', function (s) { return s.date >= r.from && s.date <= r.to && s.status !== 'cancelled' && s.status !== 'pending_approval' && (!pred || pred(s)); });
  },
  _sumsBySession: function (sessionIds) {
    var set = {}; sessionIds.forEach(function (id) { set[id] = true; });
    return U.groupBy(Db.where('AttendanceSummaries', function (x) { return set[x.sessionId]; }), function (x) { return x.sessionId; });
  },
  _counts: function (sums) {
    var c = { enrolled: sums.length, present: 0, absent: 0, unverified: 0, flagged: 0, minutes: 0 };
    sums.forEach(function (x) {
      if (x.status === 'present') c.present++; else if (x.status === 'absent') c.absent++; else if (x.status === 'unverified_exit') c.unverified++; else c.flagged++;
      c.minutes += x.verifiedMinutes || 0;
    });
    return c;
  },
  _hhmm: function (ms) { return ms ? U.local(ms).time : ''; },
  _r1: function (n) { return Math.round(n * 10) / 10; },

  _daily: function (p) {
    var date = p.date ? V.date(p.date, 'Date') : U.local(U.now()).date;
    var r = { from: date, to: date };
    var sessions = Reports._sessionsIn(r), by = Reports._sumsBySession(sessions.map(function (s) { return s.sessionId; })), ref = Sessions._ref();
    var rows = sessions.sort(function (a, b) { return a.scheduledStart - b.scheduledStart; }).map(function (s) {
      var c = Reports._counts(by[s.sessionId] || []), lab = ref.labs[s.labId] || {}, fac = ref.fac[s.facultyId] || {};
      return [lab.code || '', s.title, fac.name || '', s.type, s.status, Reports._hhmm(s.scheduledStart) + '-' + Reports._hhmm(s.scheduledEnd), c.enrolled, c.present, c.absent, c.unverified, c.flagged, Reports._r1(c.minutes / 60)];
    });
    return { title: 'Daily lab report - ' + date, columns: ['Lab', 'Session', 'Faculty', 'Type', 'Status', 'Time', 'Roster', 'Present', 'Absent', 'Unverified exit', 'Flagged', 'Verified hours'], rows: rows,
      meta: { date: date, sessions: sessions.length, totalPresent: rows.reduce(function (a, x) { return a + x[7]; }, 0) } };
  },

  _monthly: function (p) {
    var month = p.month ? V.str(p.month, 'Month', { re: /^\d{4}-(0[1-9]|1[0-2])$/ }) : U.local(U.now()).month;
    var from = month + '-01', next = U.local(U.fromLocal(from, '12:00') + 32 * 86400000), to = U.addDays(next.y + '-' + U.p2(next.m) + '-01', -1);
    var r = { from: from, to: to }, sessions = Reports._sessionsIn(r), by = Reports._sumsBySession(sessions.map(function (s) { return s.sessionId; })), ref = Sessions._ref();
    var agg = {};
    sessions.forEach(function (s) {
      var lab = ref.labs[s.labId] || {}, a = agg[s.labId] || (agg[s.labId] = { lab: lab.code || s.labId, sessions: 0, closed: 0, enrolled: 0, present: 0, minutes: 0, schedHours: 0 });
      var c = Reports._counts(by[s.sessionId] || []);
      a.sessions++; if (s.status === 'closed') a.closed++; a.enrolled += c.enrolled; a.present += c.present; a.minutes += c.minutes; a.schedHours += (s.scheduledEnd - s.scheduledStart) / 3600000;
    });
    var rows = Object.keys(agg).map(function (k) { var a = agg[k]; return [a.lab, a.sessions, a.closed, Reports._r1(a.schedHours), a.enrolled, a.present, a.enrolled ? Math.round(a.present * 100 / a.enrolled) : 0, Reports._r1(a.minutes / 60)]; });
    return { title: 'Monthly report - ' + month, columns: ['Lab', 'Sessions', 'Closed', 'Scheduled hours', 'Roster seats', 'Present', 'Attendance %', 'Verified student-hours'], rows: rows, meta: { month: month } };
  },

  _faculty: function (p) {
    var r = Reports._range(p, 30), f = Db.mustGet('FacultyProfiles', p.facultyId, 'Faculty'), ref = Sessions._ref();
    var sessions = Reports._sessionsIn(r, function (s) { return s.facultyId === f.facultyId; }), by = Reports._sumsBySession(sessions.map(function (s) { return s.sessionId; }));
    var rows = sessions.sort(function (a, b) { return a.scheduledStart - b.scheduledStart; }).map(function (s) {
      var c = Reports._counts(by[s.sessionId] || []);
      return [s.date, (ref.labs[s.labId] || {}).code || '', s.title, s.status, Reports._hhmm(s.openedAt), Reports._hhmm(s.closedAt), c.enrolled, c.present, c.absent, c.unverified, c.flagged];
    });
    return { title: 'Faculty report - ' + f.name + ' (' + r.from + ' to ' + r.to + ')', columns: ['Date', 'Lab', 'Session', 'Status', 'Opened', 'Closed', 'Roster', 'Present', 'Absent', 'Unverified exit', 'Flagged'], rows: rows, meta: { faculty: f.name, from: r.from, to: r.to } };
  },

  _student: function (p) {
    var r = Reports._range(p, 90), st = Db.mustGet('StudentProfiles', p.studentId, 'Student'), ref = Sessions._ref();
    var sessions = U.indexBy(Reports._sessionsIn(r), 'sessionId');
    var rows = Db.where('AttendanceSummaries', function (x) { return x.studentId === st.studentId && sessions[x.sessionId]; })
      .sort(function (a, b) { return sessions[a.sessionId].scheduledStart - sessions[b.sessionId].scheduledStart; })
      .map(function (x) { var s = sessions[x.sessionId]; return [s.date, (ref.labs[s.labId] || {}).code || '', s.title, x.status, Reports._hhmm(x.firstIn), Reports._hhmm(x.lastOut), x.verifiedMinutes || 0, (x.flags || []).join(' ')]; });
    return { title: 'Attendance - ' + st.name + ' (' + st.rollNo + ') ' + r.from + ' to ' + r.to, columns: ['Date', 'Lab', 'Session', 'Status', 'First in', 'Last out', 'Verified minutes', 'Flags'], rows: rows, meta: { student: st.name, rollNo: st.rollNo } };
  },

  _utilisation: function (p) {
    var r = Reports._range(p, 30), ref = Sessions._ref(), sessions = Reports._sessionsIn(r), by = Reports._sumsBySession(sessions.map(function (s) { return s.sessionId; })), agg = {};
    var days = Math.max(1, Math.round((r.toMs - r.fromMs) / 86400000));
    sessions.forEach(function (s) {
      var a = agg[s.labId] || (agg[s.labId] = { sched: 0, opened: 0, studentH: 0, sessions: 0, cap: (ref.labs[s.labId] || {}).capacity || 0, seats: 0 });
      a.sessions++; a.sched += (s.scheduledEnd - s.scheduledStart) / 3600000;
      if (s.openedAt) a.opened += ((s.closedAt || Math.min(U.now(), s.scheduledEnd)) - s.openedAt) / 3600000;
      var c = Reports._counts(by[s.sessionId] || []); a.studentH += c.minutes / 60; a.seats += c.present;
    });
    var rows = Object.keys(ref.labs).map(function (id) {
      var l = ref.labs[id], a = agg[id] || { sched: 0, opened: 0, studentH: 0, sessions: 0, seats: 0 };
      var avail = days * 10; // 10 working hours per day as the nominal denominator; stated in meta
      return [l.code, l.name, a.sessions, Reports._r1(a.sched), Reports._r1(a.opened), Reports._r1(a.studentH), Math.round(Math.min(100, a.sched * 100 / avail))];
    });
    return { title: 'Lab utilisation ' + r.from + ' to ' + r.to, columns: ['Lab', 'Name', 'Sessions', 'Scheduled hours', 'Hours open', 'Verified student-hours', 'Scheduled % of 10h days'], rows: rows, meta: { from: r.from, to: r.to, note: 'Utilisation % uses a nominal 10-hour day per calendar day in the range.' } };
  },

  _assetUsage: function (p) {
    var r = Reports._range(p, 90), assets = U.indexBy(Db.readAll('Assets'), 'assetId'), loans = U.indexBy(Db.readAll('Loans'), 'loanId'), agg = {};
    Db.readAll('LoanItems').forEach(function (i) {
      var l = loans[i.loanId]; if (!l || l.status === 'failed' || i.status === 'voided' || l.issuedAt < r.fromMs || l.issuedAt >= r.toMs) return;
      var a = agg[i.assetId] || (agg[i.assetId] = { loans: 0, units: 0, dayUnits: 0, damaged: 0, missing: 0, consumed: 0 });
      var end = l.returnedAt || U.now();
      a.loans++; a.units += i.qtyIssued; a.dayUnits += i.qtyIssued * Math.max(0, end - l.issuedAt) / 86400000; a.damaged += i.qtyDamaged; a.missing += i.qtyMissing; a.consumed += i.qtyConsumed;
    });
    var rows = Object.keys(agg).map(function (id) { var a = agg[id], s = assets[id] || {}; return [s.assetTag || '', s.name || id, a.loans, a.units, Reports._r1(a.dayUnits), a.consumed, a.damaged, a.missing]; })
      .sort(function (x, y) { return y[2] - x[2]; });
    return { title: 'Asset usage ' + r.from + ' to ' + r.to, columns: ['Tag', 'Asset', 'Loans', 'Units issued', 'Unit-days out', 'Consumed', 'Damaged', 'Missing'], rows: rows, meta: { from: r.from, to: r.to } };
  },

  _inventory: function () {
    var cats = U.indexBy(Db.readAll('Categories'), 'categoryId'), labs = U.indexBy(Db.readAll('Labs'), 'labId');
    var rows = Db.readAll('Assets').map(function (a) {
      return [(labs[a.labId] || {}).code || '', (cats[a.categoryId] || {}).name || '', a.assetTag, a.name, a.trackingMode, a.status, a.condition, a.quantityTotal, a.quantityAvailable, a.quantityTotal - a.quantityAvailable, a.location];
    });
    return { title: 'Inventory snapshot ' + U.fmt(U.now()), columns: ['Lab', 'Category', 'Tag', 'Item', 'Tracking', 'Status', 'Condition', 'Total', 'Available', 'Out', 'Location'], rows: rows, meta: { items: rows.length } };
  },

  _overdue: function () {
    var now = U.now();
    var rows = Db.where('Loans', function (l) { return Loans._isOverdue(l, now); }).sort(function (a, b) { return a.dueAt - b.dueAt; }).map(function (l) {
      var items = Db.whereEq('LoanItems', { loanId: l.loanId }).filter(function (i) { return i.status === Assets.OUT; }).length;
      return [l.loanId, Loans._borrowerName(l), l.borrowerType, U.fmt(l.issuedAt), U.fmt(l.dueAt), Math.floor((now - l.dueAt) / 86400000), items];
    });
    return { title: 'Overdue loans ' + U.fmt(now), columns: ['Loan', 'Borrower', 'Type', 'Issued', 'Due', 'Days overdue', 'Items still out'], rows: rows, meta: { count: rows.length } };
  },

  _audit: function (p) {
    var r = Reports._range(p, 7);
    var rows = Db.where('AuditEvents', function (e) { return e.at >= r.fromMs && e.at < r.toMs; }).map(function (e) { return [e.seq, U.fmt(e.at), e.actor, e.role, e.action, e.entityType, e.entityId, e.result, JSON.stringify(e.detail || null).slice(0, 300)]; });
    return { title: 'Audit trail ' + r.from + ' to ' + r.to, columns: ['Seq', 'Time', 'Actor', 'Role', 'Action', 'Entity', 'Entity id', 'Result', 'Detail'], rows: rows, meta: { from: r.from, to: r.to, verify: Audit.verify().ok } };
  },

  // ---- exports -----------------------------------------------------------------------------------------------
  csv: function (ctx, p) {
    var rep = Reports.run(ctx, p);
    Audit.tryLog({ actor: ctx.email, role: ctx.roles[0], action: 'report.export', entityType: 'Report', entityId: rep.type, detail: { format: 'csv', rows: rep.rows.length } });
    return { filename: Reports._filename(rep, 'csv'), csv: U.toCsv(rep.columns, rep.rows), truncated: rep.truncated };
  },
  _filename: function (rep, ext) { return (rep.type + '_' + U.local(rep.generatedAt).date + '.' + ext).replace(/[^A-Za-z0-9._-]/g, '_'); },

  /** Build a PDF with DocumentApp; returns base64 bytes. The temporary Doc is trashed afterwards. */
  pdfBlob: function (rep) {
    var doc = DocumentApp.create('LABFLOW tmp ' + rep.type + ' ' + U.now()), id = doc.getId();
    try {
      var body = doc.getBody();
      body.setMarginTop(36).setMarginBottom(36).setMarginLeft(28).setMarginRight(28);
      body.appendParagraph(rep.title).setHeading(DocumentApp.ParagraphHeading.HEADING1);
      body.appendParagraph('Generated ' + U.fmt(rep.generatedAt) + ' (Asia/Kolkata)' + (rep.meta && rep.meta.note ? ' - ' + rep.meta.note : ''));
      var rows = rep.rows.slice(0, Reports.MAX_PDF_ROWS), data = [rep.columns].concat(rows.map(function (r) { return r.map(function (v) { return v === null || v === undefined ? '' : String(v); }); }));
      if (rows.length) {
        var t = body.appendTable(data); t.setFontSize(8);
        t.getRow(0).editAsText().setBold(true);
      } else body.appendParagraph('No records for this selection.');
      if (rep.rows.length > rows.length) body.appendParagraph('Showing the first ' + rows.length + ' of ' + rep.rows.length + ' rows. Use CSV for the full data.');
      doc.saveAndClose();
      var blob = DriveApp.getFileById(id).getAs('application/pdf');
      return { bytes: blob.getBytes(), blob: blob };
    } finally { try { DriveApp.getFileById(id).setTrashed(true); } catch (e) { Syslog.warn('reports', 'TMP_DOC_NOT_TRASHED', id); } }
  },
  pdf: function (ctx, p) {
    var rep = Reports.run(ctx, p), out = Reports.pdfBlob(rep);
    Audit.tryLog({ actor: ctx.email, role: ctx.roles[0], action: 'report.export', entityType: 'Report', entityId: rep.type, detail: { format: 'pdf', rows: rep.rows.length } });
    return { filename: Reports._filename(rep, 'pdf'), base64: Utilities.base64Encode(out.bytes), truncated: rep.rows.length > Reports.MAX_PDF_ROWS };
  },

  /**
   * Scheduled daily delivery (trigger). Idempotent per date: a JobRuns marker prevents a second send, and the
   * email goes through Notify.sendNow which respects the mail quota reserve. The CSV is also saved to Drive.
   */
  runScheduledDaily: function (date) {
    var marker = 'report-daily:' + date;
    if (Db.where('JobRuns', function (j) { return j.job === marker && j.status === 'ok'; }).length) return { skipped: 'already sent for ' + date };
    var rep = Reports.build('daily', { date: date }), csv = U.toCsv(rep.columns, rep.rows), saved = null;
    try {
      var folder = Setup.folder(Cfg.PROP.REPORT_FOLDER, 'LABFLOW Reports');
      saved = folder.createFile('daily_' + date + '.csv', csv, MimeType.CSV).getUrl();
    } catch (e) { Syslog.error('reports', 'SAVE_FAILED', String(e && e.message)); }
    var recipients = String(Settings.get('reportRecipients') || '').split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(function (e) { return /@/.test(e) && Auth.allowedDomains().indexOf(e.split('@')[1]) >= 0; });
    var sent = 0;
    recipients.forEach(function (to) {
      var body = rep.title + '\n\nSessions: ' + rep.meta.sessions + '   Present (total): ' + rep.meta.totalPresent + (saved ? '\nSaved copy: ' + saved : '') + '\n\n' + rep.rows.map(function (r) { return r.slice(0, 2).concat(r.slice(5)).join(' | '); }).join('\n');
      if (Notify.sendNow(to, rep.title, body)) sent++;
    });
    Db.insert('JobRuns', { runId: U.id('run'), job: marker, startedAt: U.now(), finishedAt: U.now(), status: 'ok', detail: { rows: rep.rows.length, recipients: recipients.length, sent: sent, saved: !!saved } });
    return { date: date, rows: rep.rows.length, sent: sent };
  }
};
