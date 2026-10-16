/**
 * EventService.gs - workshops and events (SRS appendix B.2) and class representatives.
 *
 * Events
 *  - An event is created by faculty (or admin) with a lab, a time, an optional lunch break, a capacity and either a
 *    registration list (roll numbers) or "open to all". It owns one session of type 'event'; attendance works exactly
 *    like a class.
 *  - The coordinator may be a student or a staff member. They get operator rights for that event's session only, from
 *    eventCoordinatorGraceMinutes before the start until the same time after the end. Nothing else.
 *  - The lunch break pauses attendance: it is not counted in hours and needs no scans.
 *  - Guests without a Karunya account are added by name; each addition is audited.
 *
 * Class representatives
 *  - Assigned per course and section by the faculty teaching it (or an admin), at most two per section.
 *  - A CR is a session operator for their own class on the day (open/close if needed, call a rescan when the
 *    teacher asks) and, in device-QR mode, may scan classmates while the session is open: roster only, never
 *    themselves, and every scan is tagged so the teacher sees who scanned whom (SRS 7.2).
 */
var Events = {
  _pub: function (e) {
    return { labEventId: e.labEventId, name: e.name, labId: e.labId, coordinatorEmail: e.coordinatorEmail, startAt: e.startAt, endAt: e.endAt, breakStart: e.breakStart, breakEnd: e.breakEnd,
             capacity: e.capacity, sessionId: e.sessionId, status: e.status, description: e.description, createdBy: e.createdBy };
  },

  /** Is the caller the coordinator of this session's event, inside the event window? */
  isCoordinator: function (ctx, session) {
    if (!session || !session.labEventId || !ctx || !ctx.email) return false;
    var e = Db.cachedGet('Events', 'labEventId', session.labEventId, 60);
    if (!e || e.status !== 'active' || !e.coordinatorEmail || e.coordinatorEmail !== ctx.email) return false;
    var grace = Settings.get('eventCoordinatorGraceMinutes') * 60000, now = U.now();
    return now >= e.startAt - grace && now <= e.endAt + grace;
  },
  _mayManage: function (ctx, e) {
    var s = Db.get('Sessions', e.sessionId);
    return Auth.ownsSession(ctx, s) || Events.isCoordinator(ctx, s);
  },

  create: function (ctx, p) {
    V.obj(p);
    var labId = V.id(p.labId, 'Lab', 'lab'), lab = Db.mustGet('Labs', labId, 'Lab');
    var name = V.str(p.name, 'Event name', { max: 100, min: 3 }), date = V.date(p.date, 'Date');
    var start = U.fromLocal(date, V.time(p.startTime, 'Start time')), end = U.fromLocal(date, V.time(p.endTime, 'End time'));
    if (end <= start) fail('BAD_INPUT', 'End time must be after start time.');
    var bs = null, be = null;
    if (p.breakStart || p.breakEnd) {
      bs = U.fromLocal(date, V.time(p.breakStart, 'Break start')); be = U.fromLocal(date, V.time(p.breakEnd, 'Break end'));
      if (!(start < bs && bs < be && be < end)) fail('BAD_INPUT', 'The break must sit inside the event.');
    }
    var capacity = V.int(p.capacity, 'Capacity', 1, 2000, { optional: true, def: lab.capacity || 60 });
    var coordinator = p.coordinatorEmail ? V.email(p.coordinatorEmail, 'Coordinator email') : '';
    if (coordinator && Auth.allowedDomains().indexOf(coordinator.split('@')[1]) < 0) fail('BAD_INPUT', 'The coordinator must have an allowed-domain account.');
    var openToAll = V.bool(p.openToAll), rolls = p.rollNos ? V.arr(p.rollNos, 'Registrations', 1000) : [];
    var facultyId = ctx.has('admin') && p.facultyId ? V.id(p.facultyId, 'Faculty', 'faculty') : (ctx.faculty ? ctx.faculty.facultyId : '');
    if (!facultyId) fail('BAD_INPUT', 'Choose the responsible faculty member.');
    Db.mustGet('FacultyProfiles', facultyId, 'Faculty');
    var description = V.str(p.description, 'Description', { optional: true, max: 300 });
    var profiles = rolls.length ? U.indexBy(Db.readAll('StudentProfiles'), 'rollNo') : {}, regs = [], errors = [];
    rolls.forEach(function (rn, i) { try { var pr = profiles[V.rollNo(rn)]; if (!pr) fail('NOT_FOUND', 'Unknown roll number ' + rn + '.'); regs.push(pr.studentId); } catch (e) { errors.push({ row: i + 1, message: e.message }); } });
    return Locks.with(function () {
      var cf = Sessions._labConflicts(labId, start, end, '');
      if (cf.length && !(ctx.has('admin') && V.bool(p.override))) fail('CONFLICT', 'This lab is already booked then: ' + cf[0].title + '.', { overridable: ctx.has('admin') });
      var now = U.now(), eventId = U.id('labEvent'), sessionId = U.id('session');
      Db.insert('Sessions', { sessionId: sessionId, type: 'event', labId: labId, courseId: '', facultyId: facultyId, title: name, date: date, scheduledStart: start, scheduledEnd: end, status: 'scheduled',
        openToAll: openToAll, rescanMode: Settings.get('rescanMode'), rescansDone: 0, notes: description, createdBy: ctx.email, createdAt: now, labEventId: eventId, breakStart: bs, breakEnd: be });
      var ev = Db.insert('Events', { labEventId: eventId, name: name, labId: labId, coordinatorEmail: coordinator, startAt: start, endAt: end, breakStart: bs, breakEnd: be, capacity: capacity,
        sessionId: sessionId, status: 'active', description: description, createdBy: ctx.email, createdAt: now });
      var uniq = U.uniq(regs);
      if (uniq.length) Db.insertMany('Rosters', uniq.map(function (sid) { return { rosterId: U.id('roster'), scopeType: 'session', scopeId: sessionId, studentId: sid, status: 'active', addedBy: ctx.email, addedAt: now }; }));
      Roster._bump();
      Audit.log({ actor: ctx.email, role: ctx.roles[0], action: 'event.create', entityType: 'Event', entityId: eventId, detail: { labId: labId, date: date, registered: uniq.length, openToAll: openToAll, coordinator: coordinator, capacity: capacity } });
      if (coordinator) { var cu = Db.getBy('Users', 'email', coordinator); if (cu) Notify.toUser(cu.userId, 'event', 'You are coordinating ' + name, 'On ' + date + ' in ' + lab.name + '. You can open the session, scan participants and add guests in LABFLOW.', 'evcoord:' + eventId); }
      return { event: Events._pub(ev), registered: uniq.length, errors: errors };
    });
  },

  list: function (ctx, p) {
    p = p || {};
    var from = p.from ? U.dayStart(V.date(p.from)) : U.now() - 7 * 86400000, to = p.to ? U.dayStart(U.addDays(V.date(p.to), 1)) : U.now() + 60 * 86400000;
    var rows = Db.where('Events', function (e) { return e.startAt < to && e.endAt >= from; });
    if (!ctx.has('admin') && !ctx.has('staff')) {
      var mine = {}; Db.where('Sessions', function (s) { return s.type === 'event' && ctx.faculty && s.facultyId === ctx.faculty.facultyId; }).forEach(function (s) { mine[s.labEventId] = true; });
      rows = rows.filter(function (e) { return mine[e.labEventId]; });
    }
    return { events: rows.sort(function (a, b) { return a.startAt - b.startAt; }).map(Events._withCounts) };
  },
  _withCounts: function (e) {
    var o = Events._pub(e), s = Db.get('Sessions', e.sessionId);
    o.session = s ? { status: s.status, title: s.title } : null;
    o.counts = s && (s.status === 'open' || s.status === 'closed') ? Attend.liveCounts(s) : null;
    o.registered = Db.where('Rosters', function (r) { return r.scopeType === 'session' && r.scopeId === e.sessionId && r.status === 'active'; }).length;
    o.guests = Events.guestCount(e.labEventId);
    var lab = Db.cachedGet('Labs', 'labId', e.labId, 120); o.labName = lab ? lab.name : '';
    return o;
  },

  /** Events the caller coordinates that are running or still ahead. */
  mine: function (ctx) {
    var grace = Settings.get('eventCoordinatorGraceMinutes') * 60000, now = U.now();
    return { events: Db.where('Events', function (e) { return e.status === 'active' && e.coordinatorEmail === ctx.email && e.endAt + grace >= now; }).map(function (e) {
      var o = Events._withCounts(e); o.active = now >= e.startAt - grace; return o;
    }) };
  },

  register: function (ctx, p) {
    V.obj(p);
    var e = Db.mustGet('Events', V.id(p.labEventId, 'Event', 'labEvent'), 'Event');
    if (!Events._mayManage(ctx, e)) fail('FORBIDDEN', 'You cannot manage this event.');
    return Roster.addToSessionAs(ctx, Db.get('Sessions', e.sessionId), V.arr(p.rollNos, 'Roll numbers', 500));
  },

  addGuest: function (ctx, p) {
    V.obj(p);
    var e = Db.mustGet('Events', V.id(p.labEventId, 'Event', 'labEvent'), 'Event');
    if (!Events._mayManage(ctx, e)) fail('FORBIDDEN', 'You cannot manage this event.');
    var g = Db.insert('EventGuests', { guestId: U.id('guest'), labEventId: e.labEventId, name: V.str(p.name, 'Guest name', { max: 80, min: 2 }),
      organisation: V.str(p.organisation, 'Organisation', { optional: true, max: 80 }), addedBy: ctx.email, addedAt: U.now() });
    Audit.log({ actor: ctx.email, role: ctx.roles[0] || 'user', action: 'event.guest', entityType: 'Event', entityId: e.labEventId, detail: { guestId: g.guestId, name: g.name, organisation: g.organisation } });
    return { guest: g };
  },
  guests: function (ctx, p) {
    V.obj(p);
    var e = Db.mustGet('Events', V.id(p.labEventId, 'Event', 'labEvent'), 'Event');
    if (!Events._mayManage(ctx, e) && !ctx.has('staff')) fail('FORBIDDEN', 'You cannot view this event.');
    return { guests: Db.whereEq('EventGuests', { labEventId: e.labEventId }) };
  },
  guestCount: function (labEventId) { return Db.whereEq('EventGuests', { labEventId: labEventId }).length; },

  cancel: function (ctx, p) {
    V.obj(p);
    var e = Db.mustGet('Events', V.id(p.labEventId, 'Event', 'labEvent'), 'Event'), s = Db.get('Sessions', e.sessionId);
    if (!Auth.ownsSession(ctx, s)) fail('FORBIDDEN', 'Only the responsible faculty or an admin can cancel an event.');
    Sessions.cancel(ctx, { sessionId: s.sessionId, reason: V.str(p.reason, 'Reason', { min: 3, max: 200 }) });
    Db.update('Events', e.labEventId, { status: 'cancelled' });
    Audit.log({ actor: ctx.email, role: ctx.roles[0], action: 'event.cancel', entityType: 'Event', entityId: e.labEventId });
    return { ok: true };
  }
};

var ClassReps = {
  MAX_PER_SECTION: 2,

  /** Is this student an active CR for the session's course and section? */
  isRepFor: function (studentId, session) {
    if (!session || session.type !== 'class' || !session.courseId) return false;
    return Db.where('ClassReps', function (r) { return r.status === 'active' && r.studentId === studentId && r.courseId === session.courseId && (!session.section || r.section === session.section); }).length > 0;
  },

  _mayAssign: function (ctx, courseId, section) {
    if (ctx.has('admin')) return true;
    return !!ctx.faculty && Db.where('FacultyCourses', function (m) { return m.facultyId === ctx.faculty.facultyId && m.courseId === courseId && m.status === 'active' && (!m.section || m.section === section); }).length > 0;
  },

  set: function (ctx, p) {
    V.obj(p);
    var courseId = V.id(p.courseId, 'Course', 'course'), section = V.str(p.section, 'Section', { optional: true, max: 10 }), studentId = V.id(p.studentId, 'Student', 'student');
    var course = Db.mustGet('Courses', courseId, 'Course'), st = Db.mustGet('StudentProfiles', studentId, 'Student');
    if (!ClassReps._mayAssign(ctx, courseId, section)) fail('FORBIDDEN', 'Only the faculty teaching this course and section, or an admin, can assign class representatives.');
    if (st.status !== 'verified') fail('INVALID_STATE', st.name + ' is not a verified student.');
    var onRoster = Db.where('Rosters', function (r) { return r.scopeType === 'course' && r.scopeId === courseId && r.studentId === studentId && r.status === 'active'; }).length > 0;
    if (!onRoster || (section && st.section !== section)) fail('NOT_ELIGIBLE', st.name + ' is not on the roster for ' + course.code + (section ? ' section ' + section : '') + '.');
    return Locks.with(function () {
      var active = Db.where('ClassReps', function (r) { return r.status === 'active' && r.courseId === courseId && r.section === section; });
      if (active.some(function (r) { return r.studentId === studentId; })) fail('DUPLICATE', st.name + ' is already a class representative here.');
      if (active.length >= ClassReps.MAX_PER_SECTION) fail('LIMIT', 'This section already has ' + ClassReps.MAX_PER_SECTION + ' class representatives. Remove one first.');
      var rep = Db.insert('ClassReps', { repId: U.id('rep'), courseId: courseId, section: section, studentId: studentId, status: 'active', assignedBy: ctx.email, assignedAt: U.now() });
      Audit.log({ actor: ctx.email, role: ctx.roles[0], action: 'cr.assign', entityType: 'ClassRep', entityId: rep.repId, detail: { courseId: courseId, section: section, studentId: studentId, rollNo: st.rollNo } });
      if (st.userId) Notify.toUser(st.userId, 'cr', 'You are a class representative', 'For ' + course.code + (section ? ' section ' + section : '') + '. You can operate your class session and, where the lab uses device QR, scan classmates.', 'cr:' + rep.repId);
      return { rep: ClassReps._view(rep) };
    });
  },

  remove: function (ctx, p) {
    V.obj(p);
    var rep = Db.mustGet('ClassReps', V.id(p.repId, 'Class representative', 'rep'), 'Class representative');
    if (!ClassReps._mayAssign(ctx, rep.courseId, rep.section)) fail('FORBIDDEN', 'You cannot change class representatives for this course.');
    Db.update('ClassReps', rep.repId, { status: 'removed' });
    Audit.log({ actor: ctx.email, role: ctx.roles[0], action: 'cr.remove', entityType: 'ClassRep', entityId: rep.repId, detail: { studentId: rep.studentId } });
    return { ok: true };
  },

  _view: function (r) {
    var st = Db.get('StudentProfiles', r.studentId) || {}, c = Db.get('Courses', r.courseId) || {};
    return { repId: r.repId, courseId: r.courseId, courseCode: c.code, courseName: c.name, section: r.section, studentId: r.studentId, name: st.name, rollNo: st.rollNo, assignedBy: r.assignedBy, assignedAt: r.assignedAt };
  },

  list: function (ctx, p) {
    p = p || {};
    var rows = Db.where('ClassReps', function (r) { return r.status === 'active' && (!p.courseId || r.courseId === p.courseId); });
    if (!ctx.has('admin') && !ctx.has('staff')) rows = rows.filter(function (r) { return ClassReps._mayAssign(ctx, r.courseId, r.section); });
    return { reps: rows.map(ClassReps._view) };
  },

  /** The caller's CR assignments with today's sessions for those classes. */
  mine: function (ctx) {
    if (!ctx.student) return { reps: [], sessions: [] };
    var sid = ctx.student.studentId, reps = Db.where('ClassReps', function (r) { return r.status === 'active' && r.studentId === sid; });
    if (!reps.length) return { reps: [], sessions: [] };
    var today = U.local(U.now()).date;
    Sessions.materialize(today);
    var ref = Sessions._ref();
    var sessions = Db.where('Sessions', function (s) { return s.date === today && s.status !== 'cancelled' && ClassReps.isRepFor(sid, s); })
      .sort(function (a, b) { return a.scheduledStart - b.scheduledStart; })
      .map(function (s) { var o = Sessions.pub(s, ref); if (s.status === 'open' || s.status === 'closed') o.counts = Attend.liveCounts(s); return o; });
    return { reps: reps.map(ClassReps._view), sessions: sessions, crScanning: Settings.get('crScanningEnabled') };
  }
};
