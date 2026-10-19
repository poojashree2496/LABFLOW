/**
 * ReportService.gs - reports as plain tables { title, columns, rows, meta, summary?, sections? }, exportable as CSV or PDF.
 *
 * Types: digest (FR-34), monthlyAudit (FR-35), custom (FR-36), session (FR-37), erp (FR-39), daily, monthly, faculty,
 * student, utilisation, assetUsage, systemUsage, projects, inventory, overdue, audit. A report with `sections` has several tables; its
 * columns/rows are the first section so simple consumers still work. PDFs come from a Google Docs template when one
 * is configured (FR-38), else from a generated document.
 * Authorisation (enforced here, in addition to the RPC permission table):
 *   admin/staff: everything except audit and erp (admin only); faculty: own 'faculty' report, 'session' logs of their
 *   own sessions, supervised 'projects', and 'student' reports for students in their courses/sessions; student: own 'student' report only.
 * Limits: reports read bounded date ranges (<= 366 days) and are capped at 5000 rows (CSV) / 1000 rows (PDF) so a request
 * stays well inside the 6-minute execution limit; the result says when it was truncated.
 * Exports are returned to the browser (CSV text / base64 PDF). Scheduled reports are saved to a private Drive folder.
 */
var Reports = {
  TYPES: ['digest', 'monthlyAudit', 'custom', 'session', 'erp', 'daily', 'monthly', 'faculty', 'student', 'utilisation', 'assetUsage', 'inventory', 'overdue', 'audit', 'systemUsage', 'projects'],
  ERP_COLUMNS: ['date', 'roll_no', 'student_name', 'course_code', 'section', 'lab_code', 'session_id', 'session_type', 'status', 'first_in', 'last_out', 'verified_minutes', 'method', 'flags'],
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
    if (type === 'erp') { if (!admin) fail('FORBIDDEN', 'Only administrators can export the ERP file.'); return {}; }
    if (Auth.scopedHod(ctx)) {
      var labs = Auth.labScope(ctx), scope = { reportLabIds: labs, reportFacultyId: '' };
      if (p.labId && labs.indexOf(V.id(p.labId, 'Lab', 'lab')) < 0) fail('FORBIDDEN', 'This lab is outside your department scope.');
      if (type === 'session') { var session = Db.mustGet('Sessions', V.id(p.sessionId, 'Session', 'session'), 'Session'); Auth.assertLab(ctx, session.labId); scope.sessionId = session.sessionId; }
      if (type === 'student') { scope.studentId = V.id(p.studentId, 'Student', 'student'); if (!Auth.studentFilter(ctx)(scope.studentId)) fail('FORBIDDEN', 'This student is outside your department scope.'); }
      if (type === 'faculty') {
        scope.facultyId = V.id(p.facultyId, 'Faculty', 'faculty');
        var f = Db.mustGet('FacultyProfiles', scope.facultyId, 'Faculty'), d = String(f.department || '').trim().toUpperCase();
        if (d && d !== Auth.department(ctx) && !Db.where('Sessions', function(s){return s.facultyId === f.facultyId && labs.indexOf(s.labId) >= 0;}).length) fail('FORBIDDEN','This faculty member is outside your department scope.');
      }
      return scope;
    }
    if (type === 'systemUsage' || type === 'projects') {
      if (admin || staff) return { reportLabIds: null, reportFacultyId: '' };
      if (ctx.has('hod')) {
        var labs = Auth.labScope(ctx);
        if (!Array.isArray(labs)) fail('FORBIDDEN', 'Department scope is unavailable.');
        return { reportLabIds: labs, reportFacultyId: '' };
      }
      if (type === 'projects' && ctx.faculty) return { reportLabIds: null, reportFacultyId: ctx.faculty.facultyId };
      fail('FORBIDDEN', 'You do not have permission to view this report.');
    }
    if (type === 'session') {
      var ses = Db.mustGet('Sessions', V.id(p.sessionId, 'Session', 'session'), 'Session');
      if (!(admin || staff || Auth.ownsSession(ctx, ses))) fail('FORBIDDEN', 'This is not your session.');
      return { sessionId: ses.sessionId };
    }
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
    var build = function () { var scope = Reports._authorize(ctx, type, p); return Reports.build(type, Object.assign({}, p, scope)); };
    return Auth.scopedHod(ctx) || ['student', 'systemUsage', 'projects'].indexOf(type) >= 0 ? Locks.with(build) : build();
  },

  build: function (type, p) {
    var fn = Reports['_' + type];
    var rep = fn(p);
    rep.type = type;
    rep.generatedAt = U.now();
    rep.truncated = false;
    if (rep.sections) {
      rep.sections.forEach(function (s) { if (s.rows.length > Reports.MAX_ROWS) { s.rows = s.rows.slice(0, Reports.MAX_ROWS); rep.truncated = true; } });
      rep.columns = rep.sections[0].columns; rep.rows = rep.sections[0].rows;
    }
    if (rep.rows.length > Reports.MAX_ROWS) { rep.rows = rep.rows.slice(0, Reports.MAX_ROWS); rep.truncated = true; }
    return rep;
  },

  _sessionsIn: function (r, pred, p) {
    return Db.where('Sessions', function (s) { return s.date >= r.from && s.date <= r.to && s.status !== 'cancelled' && s.status !== 'pending_approval' && Reports._reportLab(p || {}, s.labId) && (!pred || pred(s)); });
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
  _labFilter: function (p) { return p.labId ? V.id(p.labId, 'Lab', 'lab') : ''; },

  /**
   * FR-34 daily digest for one lab (or all): unique visits, peak occupancy hour, hourly distribution, unreturned
   * items, unverified exits and flags. Occupancy per hour is swept from the accepted entry/exit events.
   */
  _digest: function (p) {
    var date = p.date ? V.date(p.date, 'Date') : U.local(U.now()).date, labId = Reports._labFilter(p);
    var from = U.dayStart(date), to = U.dayStart(U.addDays(date, 1)), lab = labId ? Db.mustGet('Labs', labId, 'Lab') : null;
    var sessions = Db.where('Sessions', function (s) { return s.date === date && Reports._reportLab(p, s.labId) && (!labId || s.labId === labId) && (s.status === 'open' || s.status === 'closed'); });
    var sesIds = {}; sessions.forEach(function (s) { sesIds[s.sessionId] = s; });
    var events = Db.where('AttendanceEvents', function (e) { return sesIds[e.sessionId]; });
    var eff = Attend._effective(events), visitors = {}, hourly = {}, deltas = [];
    for (var h = 0; h < 24; h++) hourly[h] = { ins: 0, outs: 0, peak: 0 };
    Object.keys(eff).forEach(function (sid) {
      var inAt = null, ses = null;
      eff[sid].forEach(function (e) {
        ses = sesIds[e.sessionId];
        if (e.type === 'IN' || e.type === 'CORR_IN') { visitors[sid] = true; if (inAt === null) { inAt = e.at; deltas.push([e.at, 1]); hourly[U.local(e.at).H].ins++; } }
        if ((e.type === 'OUT' || e.type === 'CORR_OUT') && inAt !== null) { deltas.push([e.at, -1]); hourly[U.local(e.at).H].outs++; inAt = null; }
      });
      if (inAt !== null && ses) deltas.push([Math.min(ses.closedAt || U.now(), Math.max(ses.scheduledEnd, inAt), to), -1]);
    });
    deltas.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    var inside = 0;
    deltas.forEach(function (d) { inside += d[1]; if (d[0] >= from && d[0] < to) { var hh = U.local(d[0]).H; hourly[hh].peak = Math.max(hourly[hh].peak, inside); } });
    var peakH = 0; Object.keys(hourly).forEach(function (k) { if (hourly[k].peak > hourly[peakH].peak) peakH = +k; });
    var sums = Reports._sumsBySession(sessions.map(function (s) { return s.sessionId; })), unverified = 0;
    Object.keys(sums).forEach(function (k) { sums[k].forEach(function (x) { if (x.status === 'unverified_exit') unverified++; }); });
    var now = U.now(), unreturned = 0;
    var openLoans = U.indexBy(Db.where('Loans', function (l) { return (l.status === 'open' || l.status === 'partial') && Reports._reportLab(p, l.labId) && (!labId || l.labId === labId) && l.dueAt < to; }), 'loanId');
    Db.where('LoanItems', function (i) { return i.status === Assets.OUT && openLoans[i.loanId]; }).forEach(function (i) { unreturned += i.qtyIssued - i.qtyReturned - i.qtyConsumed - i.qtyDamaged - i.qtyMissing; });
    var flags = Db.where('Flags', function (f) { return f.createdAt >= from && f.createdAt < to && Reports._reportLab(p, f.labId) && (!labId || f.labId === labId); });
    var rows = Object.keys(hourly).map(Number).filter(function (k) { return hourly[k].ins || hourly[k].outs || hourly[k].peak; })
      .map(function (k) { return [U.p2(k) + ':00', hourly[k].ins, hourly[k].outs, hourly[k].peak]; });
    var flagRows = flags.map(function (f) { var st = Db.cachedGet('StudentProfiles', 'studentId', f.studentId, 300) || {}; return [U.local(f.createdAt).time, (Flags.TYPES[f.type] || {}).label || f.type, f.severity, st.rollNo || '', f.status]; });
    var where = lab ? lab.code + ' ' + lab.name : 'All labs';
    return {
      title: 'Daily digest - ' + where + ' - ' + date,
      summary: [['Sessions held', sessions.length], ['Unique visits', Object.keys(visitors).length], ['Peak occupancy', hourly[peakH].peak ? hourly[peakH].peak + ' at ' + U.p2(peakH) + ':00' : '-'],
                ['Unverified exits', unverified], ['Items not yet returned (due by today)', unreturned], ['Flags raised', flags.length]],
      sections: [{ title: 'Hourly distribution', columns: ['Hour', 'Check-ins', 'Check-outs', 'Peak inside'], rows: rows },
                 { title: 'Flags', columns: ['Time', 'Flag', 'Severity', 'Roll no', 'Status'], rows: flagRows }],
      meta: { date: date, labId: labId, uniqueVisits: Object.keys(visitors).length, peakHour: peakH, peakInside: hourly[peakH].peak, unverifiedExits: unverified, unreturned: unreturned, flags: flags.length, sessions: sessions.length }
    };
  },

  /**
   * FR-35 monthly audit: student-hours per course, workstation utilisation (booked vs actually used slots), component
   * turnover per category, and spot-check outcomes.
   */
  _monthlyAudit: function (p) {
    var month = p.month ? V.str(p.month, 'Month', { re: /^\d{4}-(0[1-9]|1[0-2])$/ }) : U.local(U.now()).month;
    var from = month + '-01', next = U.local(U.fromLocal(from, '12:00') + 32 * 86400000), to = U.addDays(next.y + '-' + U.p2(next.m) + '-01', -1);
    var r = { from: from, to: to }, fromMs = U.dayStart(from), toMs = U.dayStart(U.addDays(to, 1)), ref = Sessions._ref();
    var sessions = Reports._sessionsIn(r, null, p), by = Reports._sumsBySession(sessions.map(function (s) { return s.sessionId; })), perCourse = {};
    sessions.forEach(function (s) {
      var key = s.courseId ? 'c:' + s.courseId : (s.type === 'openlab' ? 'Open lab' : s.type === 'event' ? 'Events and workshops' : 'Research and self-work');
      var a = perCourse[key] || (perCourse[key] = { sessions: 0, students: {}, minutes: 0, present: 0, seats: 0 });
      a.sessions++;
      (by[s.sessionId] || []).forEach(function (x) { a.seats++; if (x.status !== 'absent') { a.students[x.studentId] = true; a.present++; } a.minutes += x.verifiedMinutes || 0; });
    });
    var courseRows = Object.keys(perCourse).map(function (k) {
      var a = perCourse[k], c = k.indexOf('c:') === 0 ? ref.courses[k.slice(2)] || {} : null;
      return [c ? c.code : k, c ? c.name : '', a.sessions, Object.keys(a.students).length, a.seats ? Math.round(a.present * 100 / a.seats) : 0, Reports._r1(a.minutes / 60)];
    }).sort(function (x, y) { return y[5] - x[5]; });
    var assets = U.indexBy(Db.readAll('Assets'), 'assetId'), ws = {};
    Db.where('Reservations', function (x) { return Reports._reportLab(p, x.labId) && x.resourceType === 'asset' && x.startAt < toMs && x.endAt > fromMs && (x.status === 'approved' || x.status === 'completed' || x.status === 'expired' || x.status === 'fulfilled'); }).forEach(function (x) {
      if (x.status === 'expired' && !/No-show/.test(x.decisionNote || '')) return;
      var a = ws[x.resourceId] || (ws[x.resourceId] = { booked: 0, used: 0, noShows: 0 }), hrs = (Math.min(x.endAt, toMs) - Math.max(x.startAt, fromMs)) / 3600000;
      a.booked += hrs; if (x.usedAt) a.used += hrs; else if (x.status === 'expired') a.noShows++;
    });
    var wsRows = Object.keys(ws).map(function (id) { var a = ws[id], s = assets[id] || {}; return [s.assetTag || '', s.name || id, Reports._r1(a.booked), Reports._r1(a.used), a.booked ? Math.round(a.used * 100 / a.booked) : 0, a.noShows]; });
    var cats = U.indexBy(Db.readAll('Categories'), 'categoryId'), loans = U.indexBy(Db.where('Loans', function (l) { return Reports._reportLab(p, l.labId) && l.issuedAt >= fromMs && l.issuedAt < toMs && l.status !== 'failed'; }), 'loanId'), turn = {};
    Db.where('LoanItems', function (i) { return loans[i.loanId] && i.status !== 'voided'; }).forEach(function (i) {
      var t = turn[i.categoryId] || (turn[i.categoryId] = { loans: {}, units: 0, consumed: 0, damaged: 0, missing: 0 });
      t.loans[i.loanId] = true; t.units += i.qtyIssued; t.consumed += i.qtyConsumed; t.damaged += i.qtyDamaged; t.missing += i.qtyMissing;
    });
    var turnRows = Object.keys(turn).map(function (k) { var t = turn[k]; return [(cats[k] || {}).name || k, Object.keys(t.loans).length, t.units, t.consumed, t.damaged, t.missing]; }).sort(function (x, y) { return y[2] - x[2]; });
    var spot = { confirmed: 0, mismatch: 0, absent: 0, pending: 0 };
    Db.where('SpotChecks', function (c) { return c.requestedAt >= fromMs && c.requestedAt < toMs && Db.get('Sessions', c.sessionId) && Reports._reportLab(p, Db.get('Sessions', c.sessionId).labId); }).forEach(function (c) { spot[c.outcome] = (spot[c.outcome] || 0) + 1; });
    var spotTotal = spot.confirmed + spot.mismatch + spot.absent;
    return {
      title: 'Monthly audit - ' + month,
      summary: [['Sessions', sessions.length], ['Verified student-hours', Reports._r1(courseRows.reduce(function (a, x) { return a + x[5]; }, 0))], ['Spot checks resolved', spotTotal],
                ['Spot-check mismatches or absences', spot.mismatch + spot.absent], ['Open flags at month end', Db.where('Flags', function (f) { return f.status === 'open' && f.createdAt < toMs && Reports._reportLab(p, f.labId); }).length]],
      sections: [
        { title: 'Student-hours per course', columns: ['Course', 'Name', 'Sessions', 'Students', 'Attendance %', 'Verified student-hours'], rows: courseRows },
        { title: 'Workstation utilisation (booked vs used)', columns: ['Tag', 'Workstation', 'Booked hours', 'Used hours', 'Used %', 'No-shows'], rows: wsRows },
        { title: 'Component turnover', columns: ['Category', 'Loans', 'Units issued', 'Consumed', 'Damaged', 'Missing'], rows: turnRows },
        { title: 'Spot-check results', columns: ['Outcome', 'Count'], rows: [['Confirmed', spot.confirmed], ['Photo mismatch', spot.mismatch], ['Absent', spot.absent], ['Still pending', spot.pending || 0]] }
      ],
      meta: { month: month, from: from, to: to }
    };
  },

  /** FR-36 custom range (workshops, hackathons, assessment weeks): sessions, and verified hours per student. */
  _custom: function (p) {
    var r = Reports._range(p, 7), labId = Reports._labFilter(p), ref = Sessions._ref();
    var sessions = Reports._sessionsIn(r, function (s) { return !labId || s.labId === labId; }, p).sort(function (a, b) { return a.scheduledStart - b.scheduledStart; });
    var by = Reports._sumsBySession(sessions.map(function (s) { return s.sessionId; }));
    var sesRows = sessions.map(function (s) {
      var c = Reports._counts(by[s.sessionId] || []);
      return [s.date, (ref.labs[s.labId] || {}).code || '', s.title, s.type, Reports._hhmm(s.scheduledStart) + '-' + Reports._hhmm(s.scheduledEnd), c.enrolled, c.present, c.absent, c.unverified, c.flagged, Reports._r1(c.minutes / 60)];
    });
    var per = {}, profiles = U.indexBy(Db.readAll('StudentProfiles'), 'studentId');
    Object.keys(by).forEach(function (k) { by[k].forEach(function (x) { var a = per[x.studentId] || (per[x.studentId] = { sessions: 0, attended: 0, minutes: 0 }); a.sessions++; if (x.status !== 'absent') a.attended++; a.minutes += x.verifiedMinutes || 0; }); });
    var stuRows = Object.keys(per).map(function (sid) { var a = per[sid], pr = profiles[sid] || {}; return [pr.rollNo || sid, pr.name || '', a.sessions, a.attended, Reports._r1(a.minutes / 60)]; })
      .sort(function (x, y) { return String(x[0]) < String(y[0]) ? -1 : 1; });
    return { title: 'Attendance ' + r.from + ' to ' + r.to, sections: [
      { title: 'Sessions', columns: ['Date', 'Lab', 'Session', 'Type', 'Time', 'Roster', 'Present', 'Absent', 'Unverified exit', 'Flagged', 'Verified hours'], rows: sesRows },
      { title: 'Verified hours per student', columns: ['Roll no', 'Name', 'Sessions', 'Attended', 'Verified hours'], rows: stuRows }
    ], meta: { from: r.from, to: r.to, labId: labId } };
  },

  /** FR-37 session log: who was there, times, how they were checked in, flags. */
  _session: function (p) {
    var s = Db.mustGet('Sessions', p.sessionId, 'Session'), now = U.now();
    var eff = Attend._effective(Attend._eventsFor(s)), wins = Db.where('RescanWindows', function (w) { return w.sessionId === s.sessionId; });
    var ids = s.openToAll ? {} : Object.assign({}, Roster.eligibleSet(s)); Object.keys(eff).forEach(function (k) { ids[k] = true; });
    var profiles = U.indexBy(Db.readAll('StudentProfiles'), 'studentId'), lab = Db.cachedGet('Labs', 'labId', s.labId, 120) || {};
    var rows = Object.keys(ids).map(function (sid) {
      var c = Attend._compute(s, eff[sid] || [], wins, now), pr = profiles[sid] || {}, evs = eff[sid] || [];
      var methods = U.uniq(evs.map(function (e) { return e.method || e.source; }).filter(Boolean)).join(' ');
      var crBy = U.uniq(evs.filter(function (e) { return e.scannerRole === 'cr' || e.scannerRole === 'coordinator'; }).map(function (e) { return e.scannedBy; })).join(' ');
      var geo = U.uniq(evs.map(function (e) { return e.geofence; }).filter(Boolean)).join(' ');
      return [pr.rollNo || sid, pr.name || '', c.status, Reports._hhmm(c.firstIn), Reports._hhmm(c.lastOut), c.verifiedMinutes, methods, crBy, geo, (c.flags || []).join(' ')];
    }).sort(function (a, b) { return String(a[0]) < String(b[0]) ? -1 : 1; });
    return { title: 'Session log - ' + s.title + ' - ' + s.date + ' (' + (lab.code || '') + ')',
      columns: ['Roll no', 'Name', 'Status', 'First in', 'Last out', 'Verified minutes', 'Method', 'Scanned by (CR / coordinator)', 'Geofence', 'Flags'], rows: rows,
      meta: { sessionId: s.sessionId, status: s.status, guests: s.labEventId ? Events.guestCount(s.labEventId) : 0 } };
  },

  /** FR-39 ERP export: raw attendance rows in a fixed column order (one row per student per session). */
  _erp: function (p) {
    var r = Reports._range(p, 30), ref = Sessions._ref(), sessions = U.indexBy(Reports._sessionsIn(r, function (s) { return s.status === 'closed'; }, p), 'sessionId');
    var profiles = U.indexBy(Db.readAll('StudentProfiles'), 'studentId'), methods = {};
    Db.where('AttendanceEvents', function (e) { return sessions[e.sessionId] && (e.type === 'IN' || e.type === 'CORR_IN'); }).forEach(function (e) { methods[e.sessionId + '|' + e.studentId] = e.method || e.source; });
    var rows = Db.where('AttendanceSummaries', function (x) { return sessions[x.sessionId]; }).map(function (x) {
      var s = sessions[x.sessionId], pr = profiles[x.studentId] || {}, c = ref.courses[s.courseId] || {}, lab = ref.labs[s.labId] || {};
      return [s.date, pr.rollNo || '', pr.name || '', c.code || '', s.section || '', lab.code || '', s.sessionId, s.type, x.status, Reports._hhmm(x.firstIn), Reports._hhmm(x.lastOut), x.verifiedMinutes || 0, methods[x.sessionId + '|' + x.studentId] || '', (x.flags || []).join(' ')];
    }).sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : String(a[1]) < String(b[1]) ? -1 : 1; });
    return { title: 'ERP export ' + r.from + ' to ' + r.to, columns: Reports.ERP_COLUMNS.slice(), rows: rows, meta: { from: r.from, to: r.to, fixedColumns: true } };
  },

  _daily: function (p) {
    var date = p.date ? V.date(p.date, 'Date') : U.local(U.now()).date;
    var r = { from: date, to: date };
    var sessions = Reports._sessionsIn(r, null, p), by = Reports._sumsBySession(sessions.map(function (s) { return s.sessionId; })), ref = Sessions._ref();
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
    var r = { from: from, to: to }, sessions = Reports._sessionsIn(r, null, p), by = Reports._sumsBySession(sessions.map(function (s) { return s.sessionId; })), ref = Sessions._ref();
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
    var sessions = Reports._sessionsIn(r, function (s) { return s.facultyId === f.facultyId; }, p), by = Reports._sumsBySession(sessions.map(function (s) { return s.sessionId; }));
    var rows = sessions.sort(function (a, b) { return a.scheduledStart - b.scheduledStart; }).map(function (s) {
      var c = Reports._counts(by[s.sessionId] || []);
      return [s.date, (ref.labs[s.labId] || {}).code || '', s.title, s.status, Reports._hhmm(s.openedAt), Reports._hhmm(s.closedAt), c.enrolled, c.present, c.absent, c.unverified, c.flagged];
    });
    return { title: 'Faculty report - ' + f.name + ' (' + r.from + ' to ' + r.to + ')', columns: ['Date', 'Lab', 'Session', 'Status', 'Opened', 'Closed', 'Roster', 'Present', 'Absent', 'Unverified exit', 'Flagged'], rows: rows, meta: { faculty: f.name, from: r.from, to: r.to } };
  },

  /** Fresh event derivation for live/current records, with stored summaries as the historical fallback. */
  _studentData: function (p, r) {
    var labId = Reports._labFilter(p), sessions = Reports._sessionsIn(r, function (s) { return !labId || s.labId === labId; }, p);
    var stored = {}, events = U.groupBy(Db.where('AttendanceEvents', function (e) { return e.studentId === p.studentId; }), function (e) { return e.sessionId; });
    Db.whereEq('AttendanceSummaries', { studentId: p.studentId }).forEach(function (x) { stored[x.sessionId] = x; });
    var wins = U.groupBy(Db.readAll('RescanWindows'), function (w) { return w.sessionId; });
    return sessions.map(function (s) {
      var eff = Attend._effective(events[s.sessionId] || [])[p.studentId] || [], x = stored[s.sessionId];
      if ((events[s.sessionId] || []).length) x = Attend._compute(s, eff, wins[s.sessionId] || [], U.now());
      if (!x) return null;
      var count = 0, inside = false;
      eff.forEach(function (e) { if ((e.type === 'IN' || e.type === 'CORR_IN') && !inside) { inside = true; count++; } else if (e.type === 'OUT' || e.type === 'CORR_OUT') inside = false; });
      return { session: s, attendance: x, visits: count, visitCountUnavailable: !(events[s.sessionId] || []).length && x.firstIn !== null && x.firstIn !== undefined };
    }).filter(Boolean).sort(function (a, b) { return a.session.scheduledStart - b.session.scheduledStart; });
  },
  _student: function (p) {
    Sessions.closeOpenLabsDue();
    var r = Reports._range(p, 90), st = Db.mustGet('StudentProfiles', p.studentId, 'Student'), ref = Sessions._ref(), data = Reports._studentData(p, r);
    var totals = { verifiedMinutes: 0, hours: 0, distinctDays: 0, visits: 0, autoSignOuts: 0, unknownVisitSessions: 0 }, days = {}, labs = {};
    var rows = data.map(function (item) {
      var s = item.session, x = item.attendance, code = (ref.labs[s.labId] || {}).code || '', a = labs[s.labId] || (labs[s.labId] = { labId: s.labId, labName: (ref.labs[s.labId] || {}).name || code, code: code, days: {}, verifiedMinutes: 0, visits: 0, autoSignOuts: 0, unknownVisitSessions: 0 });
      var auto = (x.flags || []).indexOf('auto_out') >= 0 ? 1 : 0;
      if (x.firstIn !== null && x.firstIn !== undefined) { days[s.date] = true; a.days[s.date] = true; }
      if (item.visitCountUnavailable) { totals.unknownVisitSessions++; a.unknownVisitSessions++; }
      totals.verifiedMinutes += x.verifiedMinutes || 0; totals.visits += item.visits; totals.autoSignOuts += auto;
      a.verifiedMinutes += x.verifiedMinutes || 0; a.visits += item.visits; a.autoSignOuts += auto;
      return [s.date, code, s.title, x.status, Reports._hhmm(x.firstIn), Reports._hhmm(x.lastOut), x.verifiedMinutes || 0, (x.flags || []).join(' ')];
    });
    totals.verifiedMinutes = Reports._r1(totals.verifiedMinutes); totals.hours = Reports._r1(totals.verifiedMinutes / 60); totals.distinctDays = Object.keys(days).length;
    var labTotals = Object.keys(labs).map(function (id) { var a = labs[id]; a.distinctDays = Object.keys(a.days).length; delete a.days; a.verifiedMinutes = Reports._r1(a.verifiedMinutes); a.hours = Reports._r1(a.verifiedMinutes / 60); return a; });
    var columns = ['Date', 'Lab', 'Session', 'Status', 'First in', 'Last out', 'Verified minutes', 'Flags'];
    return { title: 'Attendance - ' + st.name + ' (' + st.rollNo + ') ' + r.from + ' to ' + r.to, columns: columns, rows: rows,
      summary: [['Verified hours', totals.hours], ['Distinct days', totals.distinctDays], [totals.unknownVisitSessions ? 'Visits (available events)' : 'Visits', totals.visits], ['Auto sign-outs', totals.autoSignOuts]],
      sections: [{ title: 'Attendance by session', columns: columns, rows: rows }, { title: 'Per-lab totals', columns: ['Lab', 'Name', 'Distinct days', 'Visits', 'Verified hours', 'Auto sign-outs'], rows: labTotals.map(function (a) { return [a.code, a.labName, a.distinctDays, a.visits, a.hours, a.autoSignOuts]; }) }],
      meta: { note: 'Historical summaries without events retain hours/days; visit counts include only available events. Unknown visit sessions: ' + totals.unknownVisitSessions, student: st.name, rollNo: st.rollNo, from: r.from, to: r.to, totals: totals, labTotals: labTotals } };
  },

  _utilisation: function (p) {
    var r = Reports._range(p, 30), ref = Sessions._ref(), sessions = Reports._sessionsIn(r, null, p), by = Reports._sumsBySession(sessions.map(function (s) { return s.sessionId; })), agg = {};
    var days = Math.max(1, Math.round((r.toMs - r.fromMs) / 86400000));
    sessions.forEach(function (s) {
      var a = agg[s.labId] || (agg[s.labId] = { sched: 0, opened: 0, studentH: 0, sessions: 0, cap: (ref.labs[s.labId] || {}).capacity || 0, seats: 0 });
      a.sessions++; a.sched += (s.scheduledEnd - s.scheduledStart) / 3600000;
      if (s.openedAt) a.opened += ((s.closedAt || Math.min(U.now(), s.scheduledEnd)) - s.openedAt) / 3600000;
      var c = Reports._counts(by[s.sessionId] || []); a.studentH += c.minutes / 60; a.seats += c.present;
    });
    var rows = Object.keys(ref.labs).filter(function(id){return Reports._reportLab(p,id);}).map(function (id) {
      var l = ref.labs[id], a = agg[id] || { sched: 0, opened: 0, studentH: 0, sessions: 0, seats: 0 };
      var avail = days * 10; // 10 working hours per day as the nominal denominator; stated in meta
      return [l.code, l.name, a.sessions, Reports._r1(a.sched), Reports._r1(a.opened), Reports._r1(a.studentH), Math.round(Math.min(100, a.sched * 100 / avail))];
    });
    return { title: 'Lab utilisation ' + r.from + ' to ' + r.to, columns: ['Lab', 'Name', 'Sessions', 'Scheduled hours', 'Hours open', 'Verified student-hours', 'Scheduled % of 10h days'], rows: rows, meta: { from: r.from, to: r.to, note: 'Utilisation % uses a nominal 10-hour day per calendar day in the range.' } };
  },

  _assetUsage: function (p) {
    var r = Reports._range(p, 90), assets = U.indexBy(Db.readAll('Assets'), 'assetId'), loans = U.indexBy(Db.readAll('Loans'), 'loanId'), agg = {};
    Db.readAll('LoanItems').forEach(function (i) {
      var l = loans[i.loanId]; if (!l || !Reports._reportLab(p, l.labId) || l.status === 'failed' || i.status === 'voided' || l.issuedAt < r.fromMs || l.issuedAt >= r.toMs) return;
      var a = agg[i.assetId] || (agg[i.assetId] = { loans: 0, units: 0, dayUnits: 0, damaged: 0, missing: 0, consumed: 0 });
      var end = l.returnedAt || U.now();
      a.loans++; a.units += i.qtyIssued; a.dayUnits += i.qtyIssued * Math.max(0, end - l.issuedAt) / 86400000; a.damaged += i.qtyDamaged; a.missing += i.qtyMissing; a.consumed += i.qtyConsumed;
    });
    var rows = Object.keys(agg).map(function (id) { var a = agg[id], s = assets[id] || {}; return [s.assetTag || '', s.name || id, a.loans, a.units, Reports._r1(a.dayUnits), a.consumed, a.damaged, a.missing]; })
      .sort(function (x, y) { return y[2] - x[2]; });
    return { title: 'Asset usage ' + r.from + ' to ' + r.to, columns: ['Tag', 'Asset', 'Loans', 'Units issued', 'Unit-days out', 'Consumed', 'Damaged', 'Missing'], rows: rows, meta: { from: r.from, to: r.to } };
  },

  _reportLab: function (p, labId) {
    return (!p.labId || p.labId === labId) && (p.reportLabIds === undefined || p.reportLabIds === null || p.reportLabIds.indexOf(labId) >= 0);
  },
  /** Split work at effective IN/WORK/OUT boundaries, intersecting the exact credit caps from attendance.
   * Bookings/loans never manufacture presence. Break overlap is subtracted per credited segment. */
  _workUsage: function (p, r) {
    Sessions.closeOpenLabsDue();
    var sessions = Db.where('Sessions', function (s) { return s.date <= r.to && (s.closedAt || U.now()) >= r.fromMs && s.status !== 'cancelled' && s.status !== 'pending_approval' && Reports._reportLab(p, s.labId); });
    var ids = U.indexBy(sessions, 'sessionId'), raw = U.groupBy(Db.where('AttendanceEvents', function (e) { return !!ids[e.sessionId]; }), function (e) { return e.sessionId; });
    var wins = U.groupBy(Db.readAll('RescanWindows'), function (w) { return w.sessionId; }), rows = [];
    sessions.forEach(function (s) {
      var effective = Attend._effective(raw[s.sessionId] || []);
      Object.keys(effective).forEach(function (sid) {
        var events = effective[sid], state = Attend._compute(s, events, wins[s.sessionId] || [], U.now(), true), current = null, start = null;
        function finish(at) {
          if (!current) return;
          var from = Math.max(start, r.fromMs), to = Math.min(at, r.toMs, U.now()), ms = 0;
          if (to < from || from >= r.toMs || at <= r.fromMs) return;
          state.creditedIntervals.forEach(function (v) { var a = Math.max(from, v.from), b = Math.min(to, v.to); if (b > a) ms += Math.max(0, b - a - Attend._breakOverlap(s, a, b)); });
          rows.push({ session: s, studentId: sid, entryEventId: current.entryEventId, projectId: current.projectId, assetId: current.assetId, from: from, to: to, minutes: ms / 60000 });
        }
        events.forEach(function (e) {
          if ((e.type === 'IN' || e.type === 'CORR_IN') && !current) { current = Work.fromEvent(e, e.eventId); start = e.at; }
          else if (e.type === 'WORK' && current && e.ref === current.entryEventId) { finish(e.at); current = Work.fromEvent(e, current.entryEventId); start = e.at; }
          else if ((e.type === 'OUT' || e.type === 'CORR_OUT') && current) { finish(e.at); current = null; }
        });
        if (current) finish(s.closedAt || U.now());
      });
    });
    return rows;
  },
  _systemUsage: function (p) {
    var r = Reports._range(p, 90), labId = Reports._labFilter(p), asset = Db.mustGet('Assets', V.id(p.assetId, 'System', 'asset'), 'System');
    if (!Work.isSystem(asset)) fail('BAD_INPUT', 'Choose an individual workstation.');
    if (!Reports._reportLab(p, asset.labId)) fail('FORBIDDEN', 'This system is outside your report scope.');
    var profiles = U.indexBy(Db.readAll('StudentProfiles'), 'studentId'), projects = U.indexBy(Db.readAll('Projects'), 'projectId'), people = {}, visits = {}, minutes = 0;
    var bookingById = U.indexBy(Db.readAll('Reservations'), 'reservationId');
    var used = Reports._workUsage(Object.assign({}, p, { labId: asset.labId }), r).filter(function (x) { return x.assetId === asset.assetId; });
    var rows = used.map(function (x) { var st = profiles[x.studentId] || {}, pr = projects[x.projectId], booking = String(x.session.slotKey || '').indexOf('rsv|') === 0 ? bookingById[x.session.slotKey.slice(4)] : null; people[x.studentId] = true; visits[x.entryEventId] = true; minutes += x.minutes;
      return [U.local(x.from).date, st.rollNo || '', st.name || '', x.session.title, U.fmt(x.from), U.fmt(x.to), pr && pr.labId === asset.labId ? pr.title : booking && booking.resourceId === asset.assetId ? booking.purpose : '', Reports._r1(x.minutes)]; });
    var groups = U.indexBy(Db.readAll('Groups'), 'groupId'), reservations = Db.where('Reservations', function (b) { return b.resourceType === 'asset' && b.resourceId === asset.assetId && b.labId === asset.labId && b.startAt < r.toMs && b.endAt > r.fromMs; });
    function borrower(type, id) { var b = type === 'student' ? profiles[id] : type === 'group' ? groups[id] : null; return b ? b.name + (b.rollNo ? ' (' + b.rollNo + ')' : '') : id; }
    var loans = U.indexBy(Db.where('Loans', function (l) { return l.status !== 'failed' && l.issuedAt < r.toMs && (!l.returnedAt || l.returnedAt >= r.fromMs); }), 'loanId');
    var items = Db.where('LoanItems', function (i) { return i.assetId === asset.assetId && loans[i.loanId] && i.status !== 'voided'; });
    var columns = ['Date', 'Register number', 'Student', 'Session', 'From', 'To', 'Project or booking purpose', 'Verified minutes'];
    return { title: 'System usage - ' + asset.name + ' (' + asset.assetTag + ')', columns: columns, rows: rows,
      summary: [['Checked-in people', Object.keys(people).length], ['Attendance visits', Object.keys(visits).length], ['Verified hours', Reports._r1(minutes / 60)], ['Reservations', reservations.length], ['Loan records', items.length]],
      sections: [{ title: 'Reported system use', columns: columns, rows: rows },
        { title: 'Reservations (not attendance)', columns: ['Requester', 'Start', 'End', 'Status', 'Purpose'], rows: reservations.map(function (b) { return [borrower(b.requesterType, b.requesterId), U.fmt(b.startAt), U.fmt(b.endAt), b.status, b.purpose]; }) },
        { title: 'Equipment loans (not attendance)', columns: ['Borrower', 'Issued', 'Due', 'Loan closed', 'Loan status', 'Issued units', 'Returned units', 'Notes'], rows: items.map(function (i) { var l = loans[i.loanId]; return [borrower(l.borrowerType, l.borrowerId), U.fmt(l.issuedAt), U.fmt(l.dueAt), l.returnedAt ? U.fmt(l.returnedAt) : '', l.status, i.qtyIssued, i.qtyReturned, l.notes || '']; }) }],
      meta: { from: r.from, to: r.to, assetId: asset.assetId, verifiedMinutes: Reports._r1(minutes), note: 'Verified hours come only from attendance, split at work changes and excluding breaks/unverified time. Reservation and loan records are separate context; a loan closing time is not a per-item return time.' } };
  },
  _projects: function (p) {
    var r = Reports._range(p, 90), labId = Reports._labFilter(p), profiles = U.indexBy(Db.readAll('StudentProfiles'), 'studentId'), faculty = U.indexBy(Db.readAll('FacultyProfiles'), 'facultyId');
    var projects = Db.where('Projects', function (pr) { return Reports._reportLab(p, pr.labId) && (!p.reportFacultyId || pr.supervisorFacultyId === p.reportFacultyId); });
    var agg = {}; projects.forEach(function (pr) { agg[pr.projectId] = { minutes: 0, visits: {} }; });
    Reports._workUsage(p, r).forEach(function (x) { var a = agg[x.projectId]; if (a) { a.minutes += x.minutes; a.visits[x.entryEventId] = true; } });
    projects = projects.filter(function (pr) { return (pr.startDate <= r.to && pr.endDate >= r.from) || Object.keys(agg[pr.projectId].visits).length; });
    var total = 0, rows = projects.map(function (pr) { var a = agg[pr.projectId]; total += a.minutes; var st = profiles[pr.ownerStudentId] || {}, f = faculty[pr.supervisorFacultyId] || {};
      return [pr.title, st.name || '', st.rollNo || '', f.name || '', pr.startDate, pr.endDate, pr.status, pr.outcome || '', pr.outcomeLink || '', Object.keys(a.visits).length, Reports._r1(a.minutes / 60)]; });
    return { title: 'Projects ' + r.from + ' to ' + r.to, columns: ['Project', 'Owner', 'Register number', 'Supervisor', 'Start', 'End', 'Status', 'Outcome', 'Outcome link', 'Visits', 'Verified hours'], rows: rows,
      summary: [['Projects', projects.length], ['Verified hours', Reports._r1(total / 60)]], meta: { from: r.from, to: r.to, note: 'Projects whose planned timelines overlap or have recorded work in this range; hours use verified attendance in the selected range, split at project/system changes.' } };
  },

  _inventory: function (p) {
    var cats = U.indexBy(Db.readAll('Categories'), 'categoryId'), labs = U.indexBy(Db.readAll('Labs'), 'labId');
    var rows = Db.readAll('Assets').filter(function(a){return Reports._reportLab(p, a.labId);}).map(function (a) {
      return [(labs[a.labId] || {}).code || '', (cats[a.categoryId] || {}).name || '', a.assetTag, a.name, a.trackingMode, a.status, a.condition, a.quantityTotal, a.quantityAvailable, a.quantityTotal - a.quantityAvailable, a.location];
    });
    return { title: 'Inventory snapshot ' + U.fmt(U.now()), columns: ['Lab', 'Category', 'Tag', 'Item', 'Tracking', 'Status', 'Condition', 'Total', 'Available', 'Out', 'Location'], rows: rows, meta: { items: rows.length } };
  },

  _overdue: function (p) {
    var now = U.now();
    var rows = Db.where('Loans', function (l) { return Reports._reportLab(p,l.labId) && Loans._isOverdue(l, now); }).sort(function (a, b) { return a.dueAt - b.dueAt; }).map(function (l) {
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
  /** CSV text. Multi-table reports become consecutive blocks, each headed by its title. A BOM keeps Excel on UTF-8. */
  toCsv: function (rep) {
    var parts = [];
    if (rep.summary && rep.summary.length) parts.push(U.toCsv(['Summary', 'Value'], rep.summary));
    (rep.sections || [{ title: '', columns: rep.columns, rows: rep.rows }]).forEach(function (s) {
      parts.push((s.title ? U.csvSafe(s.title) + '\r\n' : '') + U.toCsv(s.columns, s.rows));
    });
    return '﻿' + parts.join('\r\n\r\n');
  },
  csv: function (ctx, p) {
    var rep = Reports.run(ctx, p);
    Audit.tryLog({ actor: ctx.email, role: ctx.roles[0], action: 'report.export', entityType: 'Report', entityId: rep.type, detail: { format: 'csv', rows: rep.rows.length } });
    return { filename: Reports._filename(rep, 'csv'), csv: Reports.toCsv(rep), truncated: rep.truncated };
  },
  _filename: function (rep, ext) { return (rep.type + '_' + U.local(rep.generatedAt).date + '.' + ext).replace(/[^A-Za-z0-9._-]/g, '_'); },

  /** Write the summary and tables of a report into a document body, at `index` when given (template placeholder). */
  _writeBody: function (body, rep, index) {
    var at = typeof index === 'number' ? index : null;
    function para(text, heading) {
      var p = at === null ? body.appendParagraph(text) : body.insertParagraph(at++, text);
      if (heading) p.setHeading(heading);
      return p;
    }
    function table(data) {
      var t = at === null ? body.appendTable(data) : body.insertTable(at++, data);
      t.setFontSize(8); t.getRow(0).editAsText().setBold(true);
      return t;
    }
    if (rep.summary && rep.summary.length) rep.summary.forEach(function (s) { para(s[0] + ': ' + s[1]); });
    (rep.sections || [{ title: '', columns: rep.columns, rows: rep.rows }]).forEach(function (s) {
      if (s.title) para(s.title, DocumentApp.ParagraphHeading.HEADING2);
      var rows = s.rows.slice(0, Reports.MAX_PDF_ROWS);
      if (rows.length) table([s.columns].concat(rows.map(function (r) { return r.map(function (v) { return v === null || v === undefined ? '' : String(v); }); })));
      else para('No records for this selection.');
      if (s.rows.length > rows.length) para('Showing the first ' + rows.length + ' of ' + s.rows.length + ' rows. Use CSV for the full data.');
    });
  },

  /**
   * Build a PDF with DocumentApp and return its bytes. With reportTemplateDocId set, the template is copied and its
   * {{title}}, {{generated}} and {{summary}} placeholders replaced, and the tables go where {{table}} is (FR-38).
   * The temporary document is trashed afterwards.
   */
  pdfBlob: function (rep) {
    var tpl = Settings.get('reportTemplateDocId'), doc, id, generated = 'Generated ' + U.fmt(rep.generatedAt) + ' (Asia/Kolkata)' + (rep.meta && rep.meta.note ? ' - ' + rep.meta.note : '');
    if (tpl) {
      id = DriveApp.getFileById(tpl).makeCopy('LABFLOW tmp ' + rep.type + ' ' + U.now()).getId();
      doc = DocumentApp.openById(id);
    } else {
      doc = DocumentApp.create('LABFLOW tmp ' + rep.type + ' ' + U.now()); id = doc.getId();
    }
    try {
      var body = doc.getBody();
      if (tpl) {
        body.replaceText('\\{\\{title\\}\\}', rep.title);
        body.replaceText('\\{\\{generated\\}\\}', generated);
        body.replaceText('\\{\\{summary\\}\\}', (rep.summary || []).map(function (s) { return s[0] + ': ' + s[1]; }).join('\n'));
        var hit = body.findText('\\{\\{table\\}\\}');
        if (hit) {
          var el = hit.getElement().getParent(), idx = body.getChildIndex(el);
          Reports._writeBody(body, Object.assign({}, rep, { summary: null }), idx + 1);
          el.removeFromParent();
        } else Reports._writeBody(body, Object.assign({}, rep, { summary: null }));
      } else {
        body.setMarginTop(36).setMarginBottom(36).setMarginLeft(28).setMarginRight(28);
        body.appendParagraph(rep.title).setHeading(DocumentApp.ParagraphHeading.HEADING1);
        body.appendParagraph(generated);
        Reports._writeBody(body, rep);
      }
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

  // ---- scheduled delivery --------------------------------------------------------------------------------------
  _recipients: function (extra) {
    var list = String(Settings.get('reportRecipients') || '').split(',').concat(extra || []);
    return U.uniq(list.map(function (s) { return String(s).trim().toLowerCase(); }).filter(function (e) { return /@/.test(e) && Auth.allowedDomains().indexOf(e.split('@')[1]) >= 0; }));
  },
  _done: function (marker) { return Db.where('JobRuns', function (j) { return j.job === marker && j.status === 'ok'; }).length > 0; },
  _summaryText: function (rep) { return (rep.summary || []).map(function (s) { return s[0] + ': ' + s[1]; }).join('\n'); },

  /**
   * FR-34, every evening: one digest per active lab to its lab incharges (PDF attached), and an all-lab digest to the
   * report recipients. Idempotent per date and lab (JobRuns markers); mail goes through the quota reserve.
   */
  runScheduledDigest: function (date, deadline) {
    var out = { date: date, labs: 0, sent: 0, skipped: 0 }, folder = null;
    try { folder = Setup.folder(Cfg.PROP.REPORT_FOLDER, 'LABFLOW Reports'); } catch (e) { Syslog.error('reports', 'FOLDER_FAILED', String(e && e.message)); }
    Db.where('Labs', function (l) { return l.status === 'active'; }).forEach(function (lab) {
      var marker = 'report-digest:' + date + ':' + lab.labId;
      if (Reports._done(marker) || (deadline && U.now() > deadline)) { out.skipped++; return; }
      var rep = Reports.build('digest', { date: date, labId: lab.labId });
      if (!rep.meta.sessions && !rep.meta.uniqueVisits && !rep.meta.unreturned) { Db.insert('JobRuns', { runId: U.id('run'), job: marker, startedAt: U.now(), finishedAt: U.now(), status: 'ok', detail: { empty: true } }); return; }
      var pdf = null; try { pdf = Reports.pdfBlob(rep).blob; if (pdf.setName) pdf.setName('digest_' + lab.code + '_' + date + '.pdf'); } catch (e) { Syslog.error('reports', 'PDF_FAILED', String(e && e.message)); }
      var sent = 0;
      Labs.incharges(lab).forEach(function (to) { if (Notify.sendNow(to, rep.title, rep.title + '\n\n' + Reports._summaryText(rep) + '\n\nThe full digest is attached.', pdf ? { attachments: [pdf] } : null)) sent++; });
      Db.insert('JobRuns', { runId: U.id('run'), job: marker, startedAt: U.now(), finishedAt: U.now(), status: 'ok', detail: { sent: sent } });
      out.labs++; out.sent += sent;
    });
    var allMarker = 'report-digest:' + date + ':all';
    if (!Reports._done(allMarker)) {
      var all = Reports.build('digest', { date: date }), csv = Reports.toCsv(all), saved = null;
      try { if (folder) saved = folder.createFile('digest_' + date + '.csv', csv, MimeType.CSV).getUrl(); } catch (e) { Syslog.error('reports', 'SAVE_FAILED', String(e && e.message)); }
      Reports._recipients([]).forEach(function (to) { if (Notify.sendNow(to, all.title, all.title + '\n\n' + Reports._summaryText(all) + (saved ? '\n\nSaved copy: ' + saved : ''))) out.sent++; });
      Db.insert('JobRuns', { runId: U.id('run'), job: allMarker, startedAt: U.now(), finishedAt: U.now(), status: 'ok', detail: { saved: !!saved } });
    }
    return out;
  },

  /** FR-35, on the 1st: last month's audit as a PDF in the reports folder, emailed to the HOD and lab incharges. */
  runScheduledMonthly: function (month) {
    var marker = 'report-monthly:' + month;
    if (Reports._done(marker)) return { skipped: 'already sent for ' + month };
    var rep = Reports.build('monthlyAudit', { month: month }), pdf = null, url = null;
    try {
      pdf = Reports.pdfBlob(rep).blob;
      var folder = Setup.folder(Cfg.PROP.REPORT_FOLDER, 'LABFLOW Reports');
      var file = folder.createFile(pdf); if (file.setName) file.setName('monthly_audit_' + month + '.pdf');
      url = file.getUrl();
    } catch (e) { Syslog.error('reports', 'MONTHLY_PDF_FAILED', String(e && e.message)); }
    var incharges = []; Db.where('Labs', function (l) { return l.status === 'active'; }).forEach(function (l) { incharges = incharges.concat(Labs.incharges(l)); });
    var to = Reports._recipients(String(Settings.get('hodEmail') || '').split(',').concat(incharges)), sent = 0;
    to.forEach(function (addr) { if (Notify.sendNow(addr, rep.title, rep.title + '\n\n' + Reports._summaryText(rep) + (url ? '\n\nPDF in Drive: ' + url : ''), pdf ? { attachments: [pdf] } : null)) sent++; });
    Db.insert('JobRuns', { runId: U.id('run'), job: marker, startedAt: U.now(), finishedAt: U.now(), status: 'ok', detail: { recipients: to.length, sent: sent, saved: !!url } });
    return { month: month, recipients: to.length, sent: sent, saved: !!url };
  },

  /** Daily table (all labs) saved to Drive and sent to the report recipients. Kept for the morning job. */
  runScheduledDaily: function (date) {
    var marker = 'report-daily:' + date;
    if (Reports._done(marker)) return { skipped: 'already sent for ' + date };
    var rep = Reports.build('daily', { date: date }), csv = U.toCsv(rep.columns, rep.rows), saved = null;
    try {
      var folder = Setup.folder(Cfg.PROP.REPORT_FOLDER, 'LABFLOW Reports');
      saved = folder.createFile('daily_' + date + '.csv', csv, MimeType.CSV).getUrl();
    } catch (e) { Syslog.error('reports', 'SAVE_FAILED', String(e && e.message)); }
    var recipients = Reports._recipients([]);
    var sent = 0;
    recipients.forEach(function (to) {
      var body = rep.title + '\n\nSessions: ' + rep.meta.sessions + '   Present (total): ' + rep.meta.totalPresent + (saved ? '\nSaved copy: ' + saved : '') + '\n\n' + rep.rows.map(function (r) { return r.slice(0, 2).concat(r.slice(5)).join(' | '); }).join('\n');
      if (Notify.sendNow(to, rep.title, body)) sent++;
    });
    Db.insert('JobRuns', { runId: U.id('run'), job: marker, startedAt: U.now(), finishedAt: U.now(), status: 'ok', detail: { rows: rep.rows.length, recipients: recipients.length, sent: sent, saved: !!saved } });
    return { date: date, rows: rep.rows.length, sent: sent };
  }
};
