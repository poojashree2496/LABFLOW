/**
 * SessionService.gs - lab sessions: timetable-derived classes, events and research visits.
 *
 * Invariants
 *  - A session's attendance events are never rewritten when it is closed. Closing only changes the session row and
 *    (re)derives AttendanceSummaries, which are rebuildable from events at any time.
 *  - Closing or opening one session never touches another session.
 *  - At most one class/event session is OPEN per lab at a time (admin override is audited).
 *    Research and daily open-lab sessions can coexist with it.
 *  - Research visits need authorisation: created by faculty/admin, or requested by a student and approved by the
 *    named supervisor (or admin).
 */
var Sessions = {
  _OPEN_EARLY_MS: 30 * 60 * 1000,

  pub: function (s, ref) {
    ref = ref || {};
    var lab = (ref.labs || {})[s.labId] || {}, course = (ref.courses || {})[s.courseId] || {}, fac = (ref.fac || {})[s.facultyId] || {};
    return { sessionId: s.sessionId, type: s.type, labId: s.labId, labName: lab.name, labCode: lab.code, courseId: s.courseId, courseCode: course.code, courseName: course.name,
      facultyId: s.facultyId, facultyName: fac.name, title: s.title, section: s.section, date: s.date, scheduledStart: s.scheduledStart, scheduledEnd: s.scheduledEnd, status: s.status,
      openedAt: s.openedAt, closedAt: s.closedAt, openToAll: s.openToAll, rescanMode: s.rescanMode, nextRescanAt: s.nextRescanAt, rescansDone: s.rescansDone, notes: s.notes,
      labEventId: s.labEventId || '', breakStart: s.breakStart, breakEnd: s.breakEnd, archived: !!s.archivedAt, selfWork: String(s.slotKey || '').indexOf('rsv|') === 0, labMode: lab.labId ? Labs.modeOf(lab) : '' };
  },
  _ref: function () {
    return { labs: U.indexBy(Db.readAll('Labs'), 'labId'), courses: U.indexBy(Db.readAll('Courses'), 'courseId'), fac: U.indexBy(Db.readAll('FacultyProfiles'), 'facultyId') };
  },

  /** Create the day's class sessions from active timetable slots. Idempotent (slotKey is unique). */
  materialize: function (date) {
    V.date(date);
    var dow = U.local(U.fromLocal(date, '12:00')).dow;
    var slots = Db.where('Timetable', function (s) { return s.status === 'active' && s.dayOfWeek === dow && s.validFrom <= date && date <= s.validTo; });
    if (!slots.length) return 0;
    var have = {}; Db.where('Sessions', function (s) { return s.date === date && s.slotKey; }).forEach(function (s) { have[s.slotKey] = true; });
    var courses = U.indexBy(Db.readAll('Courses'), 'courseId'), mode = Settings.get('rescanMode'), now = U.now();
    var fresh = slots.filter(function (s) { return !have[s.slotId + '|' + date]; }).map(function (s) {
      var c = courses[s.courseId] || {};
      return { sessionId: U.id('session'), type: 'class', labId: s.labId, courseId: s.courseId, facultyId: s.facultyId, title: (c.code || '') + ' ' + (c.name || ''), slotId: s.slotId, slotKey: s.slotId + '|' + date,
        section: s.section, date: date, scheduledStart: U.fromLocal(date, s.startTime), scheduledEnd: U.fromLocal(date, s.endTime), status: 'scheduled', openToAll: false, rescanMode: mode,
        rescansDone: 0, createdBy: 'system', createdAt: now };
    });
    if (!fresh.length) return 0;
    try { Db.insertMany('Sessions', fresh); }
    catch (e) { if (e && e.code === 'DUPLICATE') return 0; throw e; } // another request materialised the same day first
    Audit.log({ actor: 'system', role: 'system', action: 'sessions.materialize', entityType: 'Session', detail: { date: date, created: fresh.length } });
    return fresh.length;
  },

  /** Daily walk-in session for each enabled lab with valid opening hours. Never revive closed/cancelled rows. */
  materializeOpenLab: function (date) {
    V.date(date);
    return Locks.with(function () {
      var have = {}; Db.where('Sessions', function (s) { return s.date === date && s.slotKey; }).forEach(function (s) { have[s.slotKey] = s; });
      var now = U.now(), labs = Db.where('Labs', Sessions._openLabConfigured);
      labs.forEach(function (lab) {
        var s = have['open|' + lab.labId + '|' + date], start = U.fromLocal(date, lab.openTime), end = U.fromLocal(date, lab.closeTime);
        if (s && s.status === 'scheduled' && (s.scheduledStart !== start || s.scheduledEnd !== end)) Db.update('Sessions', s.sessionId, { scheduledStart: start, scheduledEnd: end });
      });
      var fresh = labs.filter(function (lab) { return !have['open|' + lab.labId + '|' + date]; }).map(function (lab) {
        return { sessionId: U.id('session'), type: 'openlab', labId: lab.labId, title: 'Open lab', slotKey: 'open|' + lab.labId + '|' + date,
          date: date, scheduledStart: U.fromLocal(date, lab.openTime), scheduledEnd: U.fromLocal(date, lab.closeTime), status: 'scheduled',
          openToAll: true, rescanMode: 'off', rescansDone: 0, createdBy: 'system', createdAt: now };
      });
      if (!fresh.length) return 0;
      Db.insertMany('Sessions', fresh);
      Audit.log({ actor: 'system', role: 'system', action: 'sessions.materializeOpenLab', entityType: 'Session', detail: { date: date, created: fresh.length } });
      return fresh.length;
    });
  },
  _openLabConfigured: function (lab) {
    return !!(lab && lab.status === 'active' && lab.openLab === true && U.isTime(lab.openTime) && U.isTime(lab.closeTime) && lab.openTime < lab.closeTime);
  },
  /** Live configuration is checked again at scan commit, so disabling a lab stops new entries immediately. */
  openLabAvailable: function (session, now) {
    var lab = Db.get('Labs', session.labId);
    return Sessions._openLabConfigured(lab) && now >= session.scheduledStart && now < session.scheduledEnd &&
      now >= U.fromLocal(session.date, lab.openTime) && now < U.fromLocal(session.date, lab.closeTime);
  },
  _exclusive: function (session) { return session.type !== 'research' && session.type !== 'openlab'; },
  /** Used by the trigger and arrival screens; opening time is exact, with no class-style early window. */
  _openLabsDue: function (date) {
    Sessions.closeOpenLabsDue();
    Sessions.materializeOpenLab(date);
    var now = U.now(), opened = 0;
    Db.where('Sessions', function (s) { return s.date === date && s.type === 'openlab' && s.status === 'scheduled' && s.scheduledStart <= now && now < s.scheduledEnd; }).forEach(function (s) {
      if (Sessions._systemOpen(s, 'open-lab-hours').status === 'open') opened++;
    });
    return opened;
  },

  /** Faculty: own sessions for a date. Admin/staff: all (optionally one lab). */
  listForDay: function (ctx, p) {
    p = p || {};
    var date = p.date ? V.date(p.date) : U.local(U.now()).date;
    Sessions.materialize(date);
    Sessions._openLabsDue(date);
    var rows = Db.where('Sessions', function (s) { return s.date === date && s.status !== 'cancelled'; });
    var allowedLabs = Auth.labFilter(ctx); rows = rows.filter(function(s){return allowedLabs(s.labId);});
    if (!Auth.canView(ctx)) {
      if (!ctx.faculty) return { date: date, sessions: [] };
      rows = rows.filter(function (s) { return s.facultyId === ctx.faculty.facultyId; });
    }
    if (p.labId) rows = rows.filter(function (s) { return s.labId === p.labId; });
    rows.sort(function (a, b) { return a.scheduledStart - b.scheduledStart; });
    var ref = Sessions._ref();
    return { date: date, sessions: rows.map(function (s) {
      var o = Sessions.pub(s, ref);
      if (s.status === 'open' || s.status === 'closed') o.counts = Attend.liveCounts(s);
      return o;
    }) };
  },

  /** Students: sessions today they may attend, with their own attendance state. */
  listForStudent: function (ctx, p) {
    if (!ctx.student) return { sessions: [] };
    var date = p && p.date ? V.date(p.date) : U.local(U.now()).date;
    Sessions.materialize(date);
    Sessions._openLabsDue(date);
    var ref = Sessions._ref(), sid = ctx.student.studentId;
    var rows = Db.where('Sessions', function (s) { return s.date === date && (s.status === 'scheduled' || s.status === 'open' || s.status === 'closed'); })
      .filter(function (s) { return Roster.isEligible(s, sid) && (s.type !== 'openlab' || (s.status === 'open' && Sessions.openLabAvailable(s, U.now()))); })
      .sort(function (a, b) { return (a.type === 'openlab') - (b.type === 'openlab') || a.scheduledStart - b.scheduledStart; });
    return { date: date, sessions: rows.map(function (s) {
      var o = Sessions.pub(s, ref); o.mine = Attend.studentState(s, sid);
      if (s.status === 'open' && o.mine.state === 'in') o.workChoices = Work.choices(sid, s.labId, U.now(), s.sessionId);
      return o;
    }) };
  },

  get: function (ctx, p) {
    var s = Db.mustGet('Sessions', V.id(p.sessionId, 'Session', 'session'), 'Session');
    if (!(Auth.canView(ctx) || Auth.canOperate(ctx, s))) fail('FORBIDDEN', 'You cannot view this session.');
    Auth.assertLab(ctx, s.labId);
    return { session: Sessions.pub(s, Sessions._ref()) };
  },

  _labConflicts: function (labId, start, end, excludeId) {
    return Db.where('Sessions', function (s) { return s.labId === labId && s.sessionId !== excludeId && Sessions._exclusive(s) && (s.status === 'scheduled' || s.status === 'open') && U.overlaps(start, end, s.scheduledStart, s.scheduledEnd); });
  },

  /** Events/workshops and faculty-authorised research visits. */
  create: function (ctx, p) {
    V.obj(p);
    var type = V.enumOf(p.type, 'Type', ['event', 'research']);
    var labId = V.id(p.labId, 'Lab', 'lab'); Db.mustGet('Labs', labId, 'Lab');
    var date = V.date(p.date, 'Date'), start = U.fromLocal(date, V.time(p.startTime, 'Start time')), end = U.fromLocal(date, V.time(p.endTime, 'End time'));
    if (end <= start) fail('BAD_INPUT', 'End time must be after start time.');
    var facultyId = ctx.has('admin') && p.facultyId ? V.id(p.facultyId, 'Faculty', 'faculty') : (ctx.faculty ? ctx.faculty.facultyId : '');
    if (!facultyId) fail('BAD_INPUT', 'Choose the responsible faculty member.');
    Db.mustGet('FacultyProfiles', facultyId, 'Faculty');
    var openToAll = type === 'event' && V.bool(p.openToAll);
    var courseId = p.courseId ? V.id(p.courseId, 'Course', 'course') : '';
    return Locks.with(function () {
      var cf = type === 'research' ? [] : Sessions._labConflicts(labId, start, end, '');
      if (cf.length && !(ctx.has('admin') && V.bool(p.override))) fail('CONFLICT', 'This lab is already booked then: ' + cf[0].title + '.', { overridable: ctx.has('admin'), conflicts: cf.map(function (s) { return Sessions.pub(s, Sessions._ref()); }) });
      var s = Db.insert('Sessions', { sessionId: U.id('session'), type: type, labId: labId, courseId: courseId, facultyId: facultyId, title: V.str(p.title, 'Title', { max: 100 }), date: date, scheduledStart: start, scheduledEnd: end,
        status: 'scheduled', openToAll: openToAll, rescanMode: type === 'research' ? 'off' : Settings.get('rescanMode'), rescansDone: 0, notes: V.str(p.notes, 'Notes', { optional: true, max: 300 }), createdBy: ctx.email, createdAt: U.now() });
      Audit.log({ actor: ctx.email, role: ctx.roles[0], action: 'session.create', entityType: 'Session', entityId: s.sessionId, detail: { type: type, labId: labId, date: date, overrodeConflict: cf.length > 0 } });
      return { session: Sessions.pub(s, Sessions._ref()) };
    });
  },

  /** Student asks to visit a lab for research; the named supervisor (or admin) approves. */
  requestResearch: function (ctx, p) {
    V.obj(p);
    if (!ctx.student || ctx.student.status !== 'verified') fail('NOT_VERIFIED', 'Your profile must be verified first.');
    var labId = V.id(p.labId, 'Lab', 'lab'); Db.mustGet('Labs', labId, 'Lab');
    var supervisor = Db.mustGet('FacultyProfiles', V.id(p.facultyId, 'Supervisor', 'faculty'), 'Supervisor');
    var date = V.date(p.date), start = U.fromLocal(date, V.time(p.startTime)), end = U.fromLocal(date, V.time(p.endTime));
    if (end <= start) fail('BAD_INPUT', 'End time must be after start time.');
    if (start < U.now() - 3600000) fail('BAD_INPUT', 'That time is in the past.');
    if (end - start > 12 * 3600000) fail('BAD_INPUT', 'A research visit can be at most 12 hours.');
    if (!Auth.rateLimit('rv|' + ctx.student.studentId, 5, 86400)) fail('RATE_LIMITED', 'Too many requests today.');
    var s = Locks.with(function () {
      var ses = Db.insert('Sessions', { sessionId: U.id('session'), type: 'research', labId: labId, facultyId: supervisor.facultyId, title: 'Research: ' + V.str(p.purpose, 'Purpose', { max: 100 }), date: date, scheduledStart: start, scheduledEnd: end,
        status: 'pending_approval', openToAll: false, rescanMode: 'off', rescansDone: 0, requestedBy: ctx.student.studentId, createdBy: ctx.email, createdAt: U.now() });
      Db.insert('Rosters', { rosterId: U.id('roster'), scopeType: 'session', scopeId: ses.sessionId, studentId: ctx.student.studentId, status: 'active', addedBy: ctx.email, addedAt: U.now() });
      Roster._bump();
      Audit.log({ actor: ctx.email, role: 'student', action: 'research.request', entityType: 'Session', entityId: ses.sessionId, detail: { supervisor: supervisor.facultyId, labId: labId, date: date } });
      return ses;
    });
    Notify.toUser(supervisor.userId, 'research', 'Research visit request', ctx.student.name + ' (' + ctx.student.rollNo + ') requests a visit on ' + date + '. Approve or reject in LABFLOW.', 'rv:' + s.sessionId);
    return { session: Sessions.pub(s, Sessions._ref()) };
  },

  pendingResearch: function (ctx) {
    var rows = Db.where('Sessions', function (s) { return s.type === 'research' && s.status === 'pending_approval' && (ctx.has('admin') || (ctx.faculty && s.facultyId === ctx.faculty.facultyId)); });
    var profiles = U.indexBy(Db.readAll('StudentProfiles'), 'studentId'), ref = Sessions._ref();
    return { requests: rows.map(function (s) { var o = Sessions.pub(s, ref), st = profiles[s.requestedBy] || {}; o.student = { name: st.name, rollNo: st.rollNo }; return o; }) };
  },

  decideResearch: function (ctx, p) {
    V.obj(p);
    var approve = V.bool(p.approve), note = V.str(p.note, 'Note', { optional: true, max: 200 });
    return Locks.with(function () {
      var s = Db.mustGet('Sessions', V.id(p.sessionId, 'Session', 'session'), 'Request');
      if (s.type !== 'research' || s.status !== 'pending_approval') fail('INVALID_STATE', 'This request has already been decided.');
      if (!Auth.ownsSession(ctx, s)) fail('FORBIDDEN', 'Only the named supervisor or an admin can decide this request.');
      var next = Db.update('Sessions', s.sessionId, approve ? { status: 'scheduled', approvedBy: ctx.email, approvedAt: U.now() } : { status: 'cancelled', approvedBy: ctx.email, approvedAt: U.now(), notes: ('Rejected: ' + note).slice(0, 300) });
      Audit.log({ actor: ctx.email, role: ctx.roles[0], action: approve ? 'research.approve' : 'research.reject', entityType: 'Session', entityId: s.sessionId, detail: { note: note } });
      Notify.toStudent(s.requestedBy, 'research', approve ? 'Research visit approved' : 'Research visit rejected', 'Your visit on ' + s.date + ' was ' + (approve ? 'approved. Check in when you arrive.' : 'rejected. ' + note), 'rvres:' + s.sessionId + ':' + next.status);
      return { session: Sessions.pub(next, Sessions._ref()) };
    });
  },

  open: function (ctx, p) {
    V.obj(p);
    var override = ctx.has('admin') && V.bool(p.override);
    return Locks.with(function () {
      var s = Db.mustGet('Sessions', V.id(p.sessionId, 'Session', 'session'), 'Session');
      if (!Auth.canOperate(ctx, s)) fail('FORBIDDEN', 'This is not your session.');
      if (s.status !== 'scheduled') fail('INVALID_STATE', 'Only a scheduled session can be opened (this one is ' + s.status + ').');
      var now = U.now(), grace = Settings.get('autoCloseGraceMinutes') * 60000, overrides = [];
      if (s.type === 'openlab' && !Sessions.openLabAvailable(s, now)) fail('OUT_OF_WINDOW', 'Open lab is available only during its enabled opening hours.');
      if (now < s.scheduledStart - Sessions._OPEN_EARLY_MS || now > s.scheduledEnd + grace) {
        if (!override) fail('OUT_OF_WINDOW', 'A session can be opened from 30 minutes before it starts until it ends. Ask an admin to override.');
        overrides.push('time-window');
      }
      if (Sessions._exclusive(s)) {
        var other = Db.where('Sessions', function (x) { return x.labId === s.labId && x.sessionId !== s.sessionId && Sessions._exclusive(x) && x.status === 'open'; });
        if (other.length) { if (!override) fail('CONFLICT', 'Another session is already open in this lab: ' + other[0].title + '. Close it first.', { overridable: ctx.has('admin') }); overrides.push('lab-busy:' + other[0].sessionId); }
      }
      var mode = p.rescanMode ? V.enumOf(p.rescanMode, 'Rescan mode', ['off', 'random']) : s.rescanMode;
      if (s.type === 'openlab') mode = 'off';
      var next = Db.update('Sessions', s.sessionId, { status: 'open', openedAt: now, openedBy: ctx.email, rescanMode: mode, rescansDone: 0, nextRescanAt: mode === 'random' ? Sessions._planRescan(now, s.scheduledEnd) : null });
      Audit.log({ actor: ctx.email, role: Auth.operatorRole(ctx, s), action: overrides.length ? 'session.open.override' : 'session.open', entityType: 'Session', entityId: s.sessionId, detail: { overrides: overrides, rescanMode: mode } });
      Occupancy.invalidate(s.labId);
      return { session: Sessions.pub(next, Sessions._ref()) };
    });
  },

  /** Random time between minFraction and maxFraction of the remaining session; null if the session is too short. */
  _planRescan: function (openedAt, scheduledEnd) {
    var span = scheduledEnd - openedAt, win = Settings.get('rescanWindowSeconds') * 1000;
    if (span < 3 * win) return null;
    var lo = Settings.get('rescanMinFraction') / 100, hi = Math.max(lo, Settings.get('rescanMaxFraction') / 100);
    var at = openedAt + span * (lo + (hi - lo) * (U.randInt(10000) / 10000));
    return Math.min(Math.round(at), scheduledEnd - win);
  },

  close: function (ctx, p) {
    V.obj(p);
    var reason = V.str(p.reason, 'Reason', { optional: true, max: 200, def: 'closed by faculty' });
    var hint = Db.mustGet('Sessions', V.id(p.sessionId, 'Session', 'session'), 'Session');
    var s = Sessions._closeInternal(hint, ctx.email, Auth.operatorRole(ctx, hint), reason, function (sess) { if (!Auth.canOperate(ctx, sess)) fail('FORBIDDEN', 'This is not your session.'); });
    return { session: Sessions.pub(s, Sessions._ref()), counts: Attend.liveCounts(s) };
  },

  _closeInternal: function (sessionHint, actor, role, reason, authCheck) {
    if (sessionHint.type === 'openlab') return Sessions._closeOpenLab(sessionHint, actor, role, reason, authCheck);
    var closed = Locks.with(function () {
      var s = Db.mustGet('Sessions', sessionHint.sessionId, 'Session');
      if (authCheck) authCheck(s);
      if (s.status !== 'open') fail('INVALID_STATE', 'Only an open session can be closed (this one is ' + s.status + ').');
      var now = U.now();
      Db.where('RescanWindows', function (w) { return w.sessionId === s.sessionId && w.status === 'open'; }).forEach(function (w) { Db.update('RescanWindows', w.windowId, { status: 'closed', closesAt: Math.min(w.closesAt, now) }); });
      var next = Db.update('Sessions', s.sessionId, { status: 'closed', closedAt: now, closedBy: actor, closeReason: reason, nextRescanAt: null });
      Audit.log({ actor: actor, role: role, action: 'session.close', entityType: 'Session', entityId: s.sessionId, detail: { reason: reason } });
      return next;
    });
    Attend.rebuildSummary(closed.sessionId); // derived data; events are untouched
    Occupancy.invalidate(closed.labId);
    try { Flags.afterClose(closed); } catch (e) { Syslog.warn('sessions', 'FLAG_CHECK_FAILED', String(e && e.message)); }
    return closed;
  },

  _closeRunId: function (sessionId) { return 'RUN-' + U.sha256Hex('openlab.close|' + sessionId).slice(0, 12).toUpperCase(); },
  /** A pending journal survives partial Sheets writes, including a failure after the session is closed.
   * Append exits first, then rebuild derived data under the same re-entrant lock. A retry only exits
   * visitors still inside; the persisted closing time also preserves an interrupted early manual close. */
  _closeOpenLab: function (hint, actor, role, reason, authCheck) {
    return Locks.with(function () {
      var s = Db.mustGet('Sessions', hint.sessionId, 'Session');
      if (authCheck) authCheck(s);
      if (s.type !== 'openlab') fail('INVALID_STATE', 'Only open labs use automatic sign-out.');
      var runId = Sessions._closeRunId(s.sessionId), run = Db.get('JobRuns', runId), now = U.now();
      if (!run) {
        if (s.status !== 'open') fail('INVALID_STATE', 'Only an open session can be closed.');
        run = Db.insert('JobRuns', { runId: runId, job: 'openlabClose', startedAt: now, status: 'pending',
          detail: { sessionId: s.sessionId, actor: actor, role: role, reason: reason, closedAt: Math.min(now, s.scheduledEnd) } });
      }
      if (run.status === 'ok') return s;
      var d = run.detail, effective = Attend._effective(Attend._eventsFor(s));
      Object.keys(effective).forEach(function (sid) {
        var work = Work.current(effective[sid]);
        if (!work) return;
        var entry = effective[sid].filter(function (e) { return e.eventId === work.entryEventId; })[0];
        Db.insert('AttendanceEvents', { eventId: U.id('event'), sessionId: s.sessionId, labId: s.labId, studentId: sid,
          type: 'OUT', source: 'system', method: 'auto', at: Math.max(d.closedAt, entry.at), createdAt: now,
          recordedBy: 'system', approvalStatus: 'na', ref: entry.eventId, reason: 'Automatic sign-out at open-lab close' });
      });
      Occupancy.invalidate(s.labId);
      Db.where('RescanWindows', function (w) { return w.sessionId === s.sessionId && w.status === 'open'; }).forEach(function (w) {
        Db.update('RescanWindows', w.windowId, { status: 'closed', closesAt: Math.min(w.closesAt, d.closedAt) });
      });
      var next = Db.update('Sessions', s.sessionId, { status: 'closed', closedAt: d.closedAt, closedBy: d.actor, closeReason: d.reason, nextRescanAt: null });
      // If the audit append succeeded before an exception, do not append a second close record.
      if (!Db.where('AuditEvents', function (e) { return e.action === 'session.close' && e.entityId === s.sessionId && e.detail && e.detail.closeRunId === runId; }).length) {
        Audit.log({ actor: d.actor, role: d.role, action: 'session.close', entityType: 'Session', entityId: s.sessionId,
          detail: { reason: d.reason, closeRunId: runId, autoSignOutEventIds: Attend._eventsFor(s).filter(function (e) { return e.type === 'OUT' && e.method === 'auto'; }).map(function (e) { return e.eventId; }) } });
      }
      Attend.rebuildSummary(s.sessionId);
      Flags.afterClose(next);
      Db.update('JobRuns', runId, { status: 'ok', finishedAt: U.now() });
      return next;
    });
  },
  /** No class-style grace period: open labs close at their scheduled end. Arrival screens also run
   * this sweep, so a delayed trigger can recover both overdue sessions and unfinished close journals. */
  closeOpenLabsDue: function () {
    var due = {}, now = U.now(), closed = 0, failed = 0;
    Db.where('Sessions', function (s) { return s.type === 'openlab' && s.status === 'open' && s.scheduledEnd <= now; }).forEach(function (s) { due[s.sessionId] = s; });
    Db.where('JobRuns', function (r) { return r.job === 'openlabClose' && r.status === 'pending'; }).forEach(function (r) {
      var s = Db.get('Sessions', r.detail.sessionId); if (s) due[s.sessionId] = s;
    });
    Object.keys(due).forEach(function (id) {
      try { Sessions._closeOpenLab(due[id], 'system', 'system', 'Open lab closed at scheduled end'); closed++; }
      catch (e) { failed++; Syslog.error('sessions', 'AUTOCLOSE_FAILED', String(e && e.message), { sessionId: id }); }
    });
    return { closed: closed, failed: failed };
  },

  cancel: function (ctx, p) {
    V.obj(p);
    var reason = V.str(p.reason, 'Reason', { min: 3, max: 200 });
    return Locks.with(function () {
      var s = Db.mustGet('Sessions', V.id(p.sessionId, 'Session', 'session'), 'Session');
      if (!Auth.ownsSession(ctx, s)) fail('FORBIDDEN', 'This is not your session.');
      if (s.status !== 'scheduled' && s.status !== 'pending_approval') fail('INVALID_STATE', 'Only a session that has not opened can be cancelled.');
      var next = Db.update('Sessions', s.sessionId, { status: 'cancelled', notes: ('Cancelled: ' + reason).slice(0, 300) });
      Audit.log({ actor: ctx.email, role: ctx.roles[0], action: 'session.cancel', entityType: 'Session', entityId: s.sessionId, detail: { reason: reason } });
      return { session: Sessions.pub(next, Sessions._ref()) };
    });
  },

  /** Open a session as the system (timetable auto-open, research visit on arrival). Returns the fresh row. */
  _systemOpen: function (s, why) {
    return Locks.with(function () {
      var cur = Db.get('Sessions', s.sessionId);
      if (cur.status !== 'scheduled') return cur;
      var now = U.now(), mode = cur.rescanMode;
      if (cur.type === 'openlab') { if (!Sessions.openLabAvailable(cur, now)) return cur; mode = 'off'; }
      if (Sessions._exclusive(cur)) {
        var other = Db.where('Sessions', function (x) { return x.labId === cur.labId && x.sessionId !== cur.sessionId && Sessions._exclusive(x) && x.status === 'open'; });
        if (other.length) return cur; // the lab is still busy; faculty can open it by hand
      }
      var next = Db.update('Sessions', cur.sessionId, { status: 'open', openedAt: now, openedBy: 'system', rescansDone: 0, nextRescanAt: mode === 'random' ? Sessions._planRescan(now, cur.scheduledEnd) : null });
      Audit.log({ actor: 'system', role: 'system', action: 'session.open', entityType: 'Session', entityId: cur.sessionId, detail: { auto: why } });
      Occupancy.invalidate(cur.labId);
      return next;
    });
  },

  /** Trigger: open timetabled class sessions at their start time (teachers do nothing at the start of class). */
  autoOpenDue: function () {
    var now = U.now(), openLabs = 0, openLabsFailed = 0;
    try { openLabs = Sessions._openLabsDue(U.local(now).date); }
    catch (e) { openLabsFailed++; Syslog.error('sessions', 'OPEN_LAB_AUTO_OPEN_FAILED', String(e && e.message)); }
    var opened = openLabs;
    if (!Settings.get('autoOpenSessions')) return { opened: opened, openLabsOpened: openLabs, openLabsFailed: openLabsFailed, disabled: true };
    Sessions.materialize(U.local(now).date);
    Db.where('Sessions', function (s) { return s.type === 'class' && s.status === 'scheduled' && s.scheduledStart - 5 * 60000 <= now && now < s.scheduledEnd; }).forEach(function (s) {
      try { if (Sessions._systemOpen(s, 'timetable').status === 'open') opened++; }
      catch (e) { Syslog.error('sessions', 'AUTO_OPEN_FAILED', String(e && e.message), { sessionId: s.sessionId }); }
    });
    return { opened: opened, openLabsOpened: openLabs, openLabsFailed: openLabsFailed };
  },

  /** An approved research visit opens when its student arrives inside the visit window. */
  openResearchIfDue: function (session, studentId) {
    if (session.type !== 'research' || session.status !== 'scheduled') return session;
    var now = U.now();
    if (now < session.scheduledStart - Sessions._OPEN_EARLY_MS || now > session.scheduledEnd) return session;
    if (!Roster.isEligible(session, studentId)) return session;
    return Sessions._systemOpen(session, 'research-arrival');
  },

  /**
   * The self-work session behind an approved workstation booking (FR-25). One per booking (unique slotKey), with the
   * booking's requester (or group) on its roster and no faculty owner; lab staff oversee it.
   */
  selfWorkFor: function (r, studentId) {
    var key = 'rsv|' + r.reservationId, have = Db.getBy('Sessions', 'slotKey', key);
    if (have) return have.status === 'scheduled' ? Sessions._systemOpen(have, 'booking') : have;
    return Locks.with(function () {
      var again = Db.getBy('Sessions', 'slotKey', key);
      if (again) return again;
      var now = U.now(), name = Booking._resourceName(r);
      var s = Db.insert('Sessions', { sessionId: U.id('session'), type: 'research', labId: r.labId, courseId: '', facultyId: '', title: 'Self-work: ' + name, slotKey: key, date: U.local(r.startAt).date,
        scheduledStart: r.startAt, scheduledEnd: r.endAt, status: 'open', openedAt: now, openedBy: 'system', openToAll: false, rescanMode: 'off', rescansDone: 0, requestedBy: studentId,
        notes: 'Booking ' + r.reservationId, createdBy: 'system', createdAt: now });
      var members = r.requesterType === 'group' ? Db.whereEq('GroupMembers', { groupId: r.requesterId }).map(function (m) { return m.studentId; }) : [studentId];
      Db.insertMany('Rosters', U.uniq(members).map(function (sid) { return { rosterId: U.id('roster'), scopeType: 'session', scopeId: s.sessionId, studentId: sid, status: 'active', addedBy: 'system', addedAt: now }; }));
      Roster._bump();
      Audit.log({ actor: 'system', role: 'system', action: 'session.selfwork', entityType: 'Session', entityId: s.sessionId, detail: { reservationId: r.reservationId } });
      Occupancy.invalidate(r.labId);
      return s;
    });
  },

  /** Trigger: close sessions left open long after their scheduled end. Each is closed independently. */
  autoCloseStale: function () {
    var openLabs = Sessions.closeOpenLabsDue();
    var cutoff = U.now() - Settings.get('autoCloseGraceMinutes') * 60000, closed = openLabs.closed, failed = openLabs.failed;
    Db.where('Sessions', function (s) { return s.type !== 'openlab' && s.status === 'open' && s.scheduledEnd < cutoff; }).forEach(function (s) {
      try { Sessions._closeInternal(s, 'system', 'system', 'auto-closed after scheduled end'); closed++; }
      catch (e) { failed++; Syslog.error('sessions', 'AUTOCLOSE_FAILED', String(e && e.message), { sessionId: s.sessionId }); }
    });
    return { closed: closed, failed: failed };
  }
};
