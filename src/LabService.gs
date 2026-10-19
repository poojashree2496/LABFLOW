/**
 * LabService.gs - laboratories, kiosks, courses, rosters, faculty-course mapping, timetable.
 * All writers here are admin-only (enforced in the RPC permission table). Lab data is configuration, not code:
 * a new lab type is just another Labs row, no code change.
 */
var Labs = {
  list: function (ctx, p) {
    var all = !!(p && p.includeInactive && (ctx.has('admin') || ctx.has('staff')));
    return { labs: Db.readAll('Labs').filter(function (l) { return all || l.status === 'active'; }).map(Labs._pub), defaultMode: Settings.get('defaultCheckinMode') };
  },
  _pub: function (l) {
    return { labId: l.labId, code: l.code, name: l.name, type: l.type, building: l.building, room: l.room, capacity: l.capacity, status: l.status, notes: l.notes,
             latitude: l.latitude, longitude: l.longitude, radiusM: l.radiusM, openTime: l.openTime, closeTime: l.closeTime, checkinMode: l.checkinMode || '',
             mode: Labs.modeOf(l), inchargeEmails: l.inchargeEmails || '', openLab: l.openLab === true };
  },
  /** The lab's check-in mode: its own setting, else the global default. 'A', 'B' or 'AB'. */
  modeOf: function (lab) { return (lab && lab.checkinMode) || Settings.get('defaultCheckinMode'); },
  allows: function (lab, mode) { return !!lab && Labs.modeOf(lab).indexOf(mode) >= 0; },
  hasGeofence: function (lab) { return typeof lab.latitude === 'number' && typeof lab.longitude === 'number' && !(lab.latitude === 0 && lab.longitude === 0); },
  radiusOf: function (lab) { return lab.radiusM || Settings.get('defaultGeofenceRadiusM'); },
  /** Lab closing time today as epoch ms, or null when the lab has no hours set. */
  closesAt: function (lab, date) { return lab.closeTime && U.isTime(lab.closeTime) ? U.fromLocal(date, lab.closeTime) : null; },
  incharges: function (lab) { return String(lab.inchargeEmails || '').split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean); },

  upsert: function (ctx, p) {
    V.obj(p);
    var rec = {
      code: V.str(p.code, 'Code', { max: 20, re: /^[A-Za-z0-9_-]+$/ }).toUpperCase(), name: V.str(p.name, 'Name', { max: 80 }),
      type: V.enumOf(p.type, 'Type', Cfg.LAB_TYPES), building: V.str(p.building, 'Building', { optional: true, max: 60 }), room: V.str(p.room, 'Room', { optional: true, max: 30 }),
      capacity: V.int(p.capacity, 'Capacity', 1, 1000, { optional: true, def: 60 }), status: V.enumOf(p.status, 'Status', ['active', 'inactive'], { optional: true, def: 'active' }),
      notes: V.str(p.notes, 'Notes', { optional: true, max: 300 }),
      checkinMode: V.enumOf(p.checkinMode, 'Check-in mode', Cfg.CHECKIN_MODES, { optional: true, def: '' }),
      radiusM: V.int(p.radiusM, 'Geofence radius', 5, 500, { optional: true, def: null }),
      latitude: null, longitude: null, openTime: '', closeTime: '', inchargeEmails: ''
    };
    var hasLat = p.latitude !== undefined && p.latitude !== null && p.latitude !== '', hasLng = p.longitude !== undefined && p.longitude !== null && p.longitude !== '';
    if (hasLat !== hasLng) fail('BAD_INPUT', 'Give both latitude and longitude, or neither.');
    if (hasLat) { var ll = V.latLng(p.latitude, p.longitude); rec.latitude = Math.round(ll.lat * 1e6) / 1e6; rec.longitude = Math.round(ll.lng * 1e6) / 1e6; }
    if (!!p.openTime !== !!p.closeTime) fail('BAD_INPUT', 'Give both opening and closing time, or neither.');
    if (p.openTime) {
      rec.openTime = V.time(p.openTime, 'Opening time'); rec.closeTime = V.time(p.closeTime, 'Closing time');
      if (rec.closeTime <= rec.openTime) fail('BAD_INPUT', 'Closing time must be after opening time.');
    }
    var existing = p.labId ? Db.mustGet('Labs', V.id(p.labId, 'Lab', 'lab'), 'Lab') : null;
    rec.openLab = p.openLab === undefined ? !!(existing && existing.openLab) : V.bool(p.openLab);
    if (rec.openLab && !rec.openTime) fail('BAD_INPUT', 'Set opening and closing times before enabling open lab.');
    if (p.inchargeEmails) {
      var list = String(p.inchargeEmails).split(',').map(function (s) { return s.trim(); }).filter(Boolean).map(function (e) { return V.email(e, 'Lab incharge email'); });
      list.forEach(function (e) { if (Auth.allowedDomains().indexOf(e.split('@')[1]) < 0) fail('BAD_INPUT', e + ' is not on an allowed domain.'); });
      if (list.length > 5) fail('BAD_INPUT', 'At most 5 lab incharge emails.');
      rec.inchargeEmails = list.join(',');
    }
    var lab;
    if (p.labId) { lab = Db.update('Labs', V.id(p.labId, 'Lab', 'lab'), rec); }
    else lab = Db.insert('Labs', Object.assign({ labId: U.id('lab'), createdAt: U.now() }, rec));
    Occupancy.invalidate(lab.labId);
    Audit.log({ actor: ctx.email, role: 'admin', action: p.labId ? 'lab.update' : 'lab.create', entityType: 'Lab', entityId: lab.labId, detail: rec });
    return { lab: Labs._pub(lab) };
  }
};

/**
 * Live occupancy (FR-16): students currently inside each lab, across its open sessions. Cached for a few seconds
 * because every dashboard polls it; an accepted scan clears the lab's entry so the count moves immediately.
 */
var Occupancy = {
  // v2 stubs (docs/requirements.md section 4); each task replaces its own.
  live: function () { notBuilt_('B4'); },
  systems: function () { notBuilt_('B4'); },
  _key: function (labId) { return 'occ|' + labId; },
  invalidate: function (labId) { try { CacheService.getScriptCache().remove(Occupancy._key(labId)); } catch (e) {} },
  lab: function (labId) {
    var cache = CacheService.getScriptCache(), key = Occupancy._key(labId);
    try { var hit = cache.get(key); if (hit) return JSON.parse(hit); } catch (e) {}
    var lab = Db.cachedGet('Labs', 'labId', labId, 120) || {};
    var open = Db.where('Sessions', function (s) { return s.labId === labId && s.status === 'open'; });
    var sessions = open.map(function (s) { var c = Attend.liveCounts(s); return { sessionId: s.sessionId, title: s.title, type: s.type, inside: c.inside, enrolled: c.enrolled, onBreak: c.onBreak }; });
    var inside = sessions.reduce(function (a, s) { return a + s.inside; }, 0);
    var out = { labId: labId, code: lab.code, name: lab.name, inside: inside, capacity: lab.capacity || null, overCapacity: !!lab.capacity && inside > lab.capacity,
                openTime: lab.openTime || '', closeTime: lab.closeTime || '', sessions: sessions, at: U.now() };
    try { cache.put(key, JSON.stringify(out), Settings.get('occupancyRefreshSeconds')); } catch (e) {}
    return out;
  },
  list: function () {
    return { labs: Db.where('Labs', function (l) { return l.status === 'active'; }).map(function (l) { return Occupancy.lab(l.labId); }), refreshSeconds: Settings.get('occupancyRefreshSeconds'), serverNow: U.now() };
  },
  /** The open session in this lab the student is currently inside, or null. */
  insideSession: function (studentId, labId) {
    var open = Db.where('Sessions', function (s) { return s.labId === labId && s.status === 'open'; });
    for (var i = 0; i < open.length; i++) if (Attend.studentState(open[i], studentId).state === 'in') return open[i];
    return null;
  }
};

var Kiosks = {
  _pub: function (k) { return { kioskId: k.kioskId, labId: k.labId, name: k.name, authorizedEmail: k.authorizedEmail, status: k.status, lastSeenAt: k.lastSeenAt }; },
  list: function () { return { kiosks: Db.readAll('Kiosks').map(Kiosks._pub) }; },
  upsert: function (ctx, p) {
    V.obj(p);
    var email = V.email(p.authorizedEmail, 'Kiosk account email');
    if (Auth.allowedDomains().indexOf(email.split('@')[1]) < 0) fail('BAD_INPUT', 'Kiosk account must be on an allowed domain.');
    var person = Db.getBy('Users', 'email', email);
    if (person) fail('BAD_INPUT', 'That Google account belongs to a person in LABFLOW. Use a dedicated kiosk account.');
    var rec = { labId: V.id(p.labId, 'Lab', 'lab'), name: V.str(p.name, 'Name', { max: 60 }), authorizedEmail: email, status: V.enumOf(p.status, 'Status', ['active', 'revoked'], { optional: true, def: 'active' }) };
    Db.mustGet('Labs', rec.labId, 'Lab');
    var k;
    if (p.kioskId) { k = Db.update('Kiosks', V.id(p.kioskId, 'Kiosk', 'kiosk'), Object.assign(rec, rec.status === 'revoked' ? { revokedAt: U.now() } : {})); }
    else k = Db.insert('Kiosks', Object.assign({ kioskId: U.id('kiosk'), createdAt: U.now() }, rec));
    Audit.log({ actor: ctx.email, role: 'admin', action: p.kioskId ? 'kiosk.update' : 'kiosk.create', entityType: 'Kiosk', entityId: k.kioskId, detail: { labId: rec.labId, email: email, status: rec.status } });
    return { kiosk: Kiosks._pub(k) };
  },
  /** Record the kiosk as alive (at most one sheet write a minute). */
  touch: function (k) { if (!k.lastSeenAt || U.now() - k.lastSeenAt > 60000) { try { Db.update('Kiosks', k.kioskId, { lastSeenAt: U.now() }); } catch (e) { /* best effort */ } } },
  /** Kiosk heartbeat so admins can see which kiosks are alive. */
  ping: function (ctx) {
    var k = ctx.kiosk;
    if (!k) fail('FORBIDDEN', 'Not a kiosk account.');
    Kiosks.touch(k);
    var lab = Db.get('Labs', k.labId);
    var open = Db.where('Sessions', function (s) { return s.labId === k.labId && s.status === 'open'; });
    return { kiosk: { kioskId: k.kioskId, name: k.name }, lab: lab ? Labs._pub(lab) : null, mode: Labs.modeOf(lab), occupancy: Occupancy.lab(k.labId),
             openSessions: open.map(function (s) { return { sessionId: s.sessionId, title: s.title, type: s.type }; }), serverNow: U.now() };
  }
};

var Courses = {
  _pub: function (c) { return { courseId: c.courseId, code: c.code, name: c.name, department: c.department, semester: c.semester, status: c.status }; },
  list: function () { return { courses: Db.readAll('Courses').map(Courses._pub) }; },
  upsert: function (ctx, p) {
    V.obj(p);
    var rec = { code: V.str(p.code, 'Course code', { max: 20, re: /^[A-Za-z0-9_-]+$/ }).toUpperCase(), name: V.str(p.name, 'Name', { max: 100 }),
      department: V.str(p.department, 'Department', { optional: true, max: 60, def: 'CSE' }), semester: V.str(p.semester, 'Semester', { optional: true, max: 20 }),
      status: V.enumOf(p.status, 'Status', ['active', 'inactive'], { optional: true, def: 'active' }) };
    var c = p.courseId ? Db.update('Courses', V.id(p.courseId, 'Course', 'course'), rec) : Db.insert('Courses', Object.assign({ courseId: U.id('course'), createdAt: U.now() }, rec));
    Audit.log({ actor: ctx.email, role: 'admin', action: p.courseId ? 'course.update' : 'course.create', entityType: 'Course', entityId: c.courseId, detail: rec });
    return { course: Courses._pub(c) };
  },
  import: function (ctx, p) {
    V.obj(p);
    var rows = V.arr(p.rows, 'Rows', 300), existing = U.indexBy(Db.readAll('Courses'), 'code'), create = [], errors = [], skipped = 0, seen = {};
    rows.forEach(function (r, i) {
      try {
        var code = V.str(r.code, 'Course code', { max: 20, re: /^[A-Za-z0-9_-]+$/ }).toUpperCase();
        if (seen[code]) fail('BAD_INPUT', 'Duplicate code in file.'); seen[code] = true;
        if (existing[code]) { skipped++; return; }
        create.push({ courseId: U.id('course'), code: code, name: V.str(r.name, 'Name', { max: 100 }), department: V.str(r.department, 'Department', { optional: true, max: 60, def: 'CSE' }),
          semester: V.str(r.semester, 'Semester', { optional: true, max: 20 }), status: 'active', createdAt: U.now() });
      } catch (e) { errors.push({ row: i + 1, message: e.message }); }
    });
    if (create.length) Db.insertMany('Courses', create);
    Audit.log({ actor: ctx.email, role: 'admin', action: 'courses.import', entityType: 'Course', detail: { created: create.length, skipped: skipped, errors: errors.length } });
    return { created: create.length, skipped: skipped, errors: errors };
  }
};

var Roster = {
  _bump: function () { PropertiesService.getScriptProperties().setProperty('ROSTER_VER', U.now() + '-' + Utilities.getUuid().slice(0, 8)); },
  _ver: function () { return PropertiesService.getScriptProperties().getProperty('ROSTER_VER') || '0'; },

  import: function (ctx, p) {
    V.obj(p);
    var course = Db.mustGet('Courses', V.id(p.courseId, 'Course', 'course'), 'Course');
    var rows = V.arr(p.rows, 'Rows', 500);
    var profiles = U.indexBy(Db.readAll('StudentProfiles'), 'rollNo');
    var current = {};
    Db.where('Rosters', function (r) { return r.scopeType === 'course' && r.scopeId === course.courseId; }).forEach(function (r) { current[r.studentId] = r; });
    var create = [], reactivate = [], errors = [], already = 0, seen = {};
    rows.forEach(function (r, i) {
      try {
        var roll = V.rollNo(typeof r === 'string' ? r : r.rollNo);
        if (seen[roll]) return; seen[roll] = true;
        var prof = profiles[roll];
        if (!prof) fail('NOT_FOUND', 'Roll number ' + roll + ' is not in the student list. Import students first.');
        if (prof.status === 'disabled') fail('BAD_INPUT', roll + ' is disabled.');
        var ex = current[prof.studentId];
        if (ex && ex.status === 'active') { already++; return; }
        if (ex) reactivate.push(ex); else create.push({ rosterId: U.id('roster'), scopeType: 'course', scopeId: course.courseId, studentId: prof.studentId, status: 'active', addedBy: ctx.email, addedAt: U.now() });
      } catch (e) { errors.push({ row: i + 1, message: e.message }); }
    });
    Locks.with(function () {
      if (create.length) Db.insertMany('Rosters', create);
      reactivate.forEach(function (r) { Db.update('Rosters', r.rosterId, { status: 'active', addedBy: ctx.email, addedAt: U.now() }); });
      Roster._bump();
      Audit.log({ actor: ctx.email, role: 'admin', action: 'roster.import', entityType: 'Course', entityId: course.courseId, detail: { added: create.length + reactivate.length, already: already, errors: errors.length } });
    });
    return { added: create.length + reactivate.length, already: already, errors: errors };
  },

  /** Add participants to ONE session (event or research visit). Faculty owner or admin. */
  addToSession: function (ctx, p) {
    V.obj(p);
    var ses = Db.mustGet('Sessions', V.id(p.sessionId, 'Session', 'session'), 'Session');
    if (!Auth.ownsSession(ctx, ses)) fail('FORBIDDEN', 'This is not your session.');
    return Roster.addToSessionAs(ctx, ses, V.arr(p.rollNos, 'Roll numbers', 300));
  },
  /** Add roll numbers to one session's roster (caller already authorised). */
  addToSessionAs: function (ctx, ses, rolls) {
    var profiles = U.indexBy(Db.readAll('StudentProfiles'), 'rollNo');
    var have = {}; Db.where('Rosters', function (r) { return r.scopeType === 'session' && r.scopeId === ses.sessionId; }).forEach(function (r) { have[r.studentId] = true; });
    var create = [], errors = [];
    rolls.forEach(function (rn, i) {
      try {
        var prof = profiles[V.rollNo(rn)];
        if (!prof) fail('NOT_FOUND', 'Unknown roll number ' + rn + '.');
        if (have[prof.studentId]) return; have[prof.studentId] = true;
        create.push({ rosterId: U.id('roster'), scopeType: 'session', scopeId: ses.sessionId, studentId: prof.studentId, status: 'active', addedBy: ctx.email, addedAt: U.now() });
      } catch (e) { errors.push({ row: i + 1, message: e.message }); }
    });
    Locks.with(function () { if (create.length) Db.insertMany('Rosters', create); Roster._bump(); Audit.log({ actor: ctx.email, role: ctx.roles[0], action: 'roster.session_add', entityType: 'Session', entityId: ses.sessionId, detail: { added: create.length } }); });
    return { added: create.length, errors: errors };
  },

  remove: function (ctx, p) {
    V.obj(p);
    var r = Db.mustGet('Rosters', V.id(p.rosterId, 'Roster entry', 'roster'), 'Roster entry');
    Db.update('Rosters', r.rosterId, { status: 'removed' });
    Roster._bump();
    Audit.log({ actor: ctx.email, role: ctx.roles[0], action: 'roster.remove', entityType: 'Roster', entityId: r.rosterId, detail: { scope: r.scopeType + ':' + r.scopeId, studentId: r.studentId } });
    return { ok: true };
  },

  list: function (ctx, p) {
    V.obj(p);
    var scopeType = p.sessionId ? 'session' : 'course', scopeId = p.sessionId ? V.id(p.sessionId, 'Session', 'session') : V.id(p.courseId, 'Course', 'course');
    if (scopeType === 'session') { var ses = Db.mustGet('Sessions', scopeId, 'Session'); if (!ctx.has('staff') && !Auth.ownsSession(ctx, ses)) fail('FORBIDDEN', 'This is not your session.'); }
    else if (!ctx.has('admin') && !ctx.has('staff')) {
      var mine = Db.where('FacultyCourses', function (m) { return ctx.faculty && m.facultyId === ctx.faculty.facultyId && m.courseId === scopeId && m.status === 'active'; });
      if (!mine.length) fail('FORBIDDEN', 'This is not your course.');
    }
    var profiles = U.indexBy(Db.readAll('StudentProfiles'), 'studentId');
    var rows = Db.where('Rosters', function (r) { return r.scopeType === scopeType && r.scopeId === scopeId && r.status === 'active'; });
    return { roster: rows.map(function (r) { var s = profiles[r.studentId] || {}; return { rosterId: r.rosterId, studentId: r.studentId, rollNo: s.rollNo, name: s.name, section: s.section, status: s.status }; })
      .sort(function (a, b) { return String(a.rollNo) < String(b.rollNo) ? -1 : 1; }) };
  },

  /** Set of studentIds in any course taught by this faculty member (used to scope what faculty may search). */
  studentIdsForFaculty: function (facultyId) {
    var out = {};
    if (!facultyId) return out;
    var courseIds = {};
    Db.where('FacultyCourses', function (m) { return m.facultyId === facultyId && m.status === 'active'; }).forEach(function (m) { courseIds[m.courseId] = true; });
    var sessionIds = {};
    Db.where('Sessions', function (s) { return s.facultyId === facultyId; }).forEach(function (s) { sessionIds[s.sessionId] = true; });
    Db.where('Rosters', function (r) { return r.status === 'active' && ((r.scopeType === 'course' && courseIds[r.scopeId]) || (r.scopeType === 'session' && sessionIds[r.scopeId])); })
      .forEach(function (r) { out[r.studentId] = true; });
    return out;
  },

  /** Students allowed into a session, cached per roster version so a 60-student rush does not re-read the sheet. */
  eligibleSet: function (session) {
    var key = 'elig|' + Roster._ver() + '|' + session.sessionId, cache = CacheService.getScriptCache();
    try { var hit = cache.get(key); if (hit) { var o = {}; JSON.parse(hit).forEach(function (id) { o[id] = true; }); return o; } } catch (e) {}
    var ids = {}, profiles = null;
    Db.where('Rosters', function (r) { return r.status === 'active' && ((session.courseId && r.scopeType === 'course' && r.scopeId === session.courseId) || (r.scopeType === 'session' && r.scopeId === session.sessionId)); })
      .forEach(function (r) {
        if (r.scopeType === 'course' && session.section) {
          profiles = profiles || U.indexBy(Db.readAll('StudentProfiles'), 'studentId');
          if (!profiles[r.studentId] || profiles[r.studentId].section !== session.section) return;
        }
        ids[r.studentId] = true;
      });
    try { cache.put(key, JSON.stringify(Object.keys(ids)), 600); } catch (e) {}
    return ids;
  },
  isEligible: function (session, studentId) { return session.openToAll === true || !!Roster.eligibleSet(session)[studentId]; }
};

var FacultyCourses = {
  list: function (ctx) {
    var faculty = U.indexBy(Db.readAll('FacultyProfiles'), 'facultyId'), courses = U.indexBy(Db.readAll('Courses'), 'courseId');
    var rows = Db.readAll('FacultyCourses').filter(function (m) { return m.status === 'active' && (ctx.has('admin') || ctx.has('staff') || (ctx.faculty && m.facultyId === ctx.faculty.facultyId)); });
    return { mappings: rows.map(function (m) { return { mapId: m.mapId, facultyId: m.facultyId, facultyName: (faculty[m.facultyId] || {}).name, courseId: m.courseId, courseCode: (courses[m.courseId] || {}).code, courseName: (courses[m.courseId] || {}).name, section: m.section, term: m.term }; }) };
  },
  set: function (ctx, p) {
    V.obj(p);
    var facultyId = V.id(p.facultyId, 'Faculty', 'faculty'), courseId = V.id(p.courseId, 'Course', 'course');
    Db.mustGet('FacultyProfiles', facultyId, 'Faculty'); Db.mustGet('Courses', courseId, 'Course');
    var section = V.str(p.section, 'Section', { optional: true, max: 10 }), term = V.str(p.term, 'Term', { optional: true, max: 20 });
    var dup = Db.where('FacultyCourses', function (m) { return m.facultyId === facultyId && m.courseId === courseId && m.section === section && m.status === 'active'; });
    if (dup.length) fail('DUPLICATE', 'This faculty member is already mapped to that course and section.');
    var m = Db.insert('FacultyCourses', { mapId: U.id('map'), facultyId: facultyId, courseId: courseId, section: section, term: term, status: 'active', createdAt: U.now() });
    Audit.log({ actor: ctx.email, role: 'admin', action: 'facultycourse.set', entityType: 'FacultyCourse', entityId: m.mapId, detail: { facultyId: facultyId, courseId: courseId, section: section } });
    return { mapping: m };
  },
  remove: function (ctx, p) {
    V.obj(p);
    var m = Db.update('FacultyCourses', V.id(p.mapId, 'Mapping', 'map'), { status: 'removed' });
    Audit.log({ actor: ctx.email, role: 'admin', action: 'facultycourse.remove', entityType: 'FacultyCourse', entityId: m.mapId });
    return { ok: true };
  }
};

var Timetable = {
  _toMin: function (t) { return parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(3), 10); },
  /** Active slots that clash with the candidate (same weekday, overlapping time and date range). */
  conflicts: function (c, excludeSlotId) {
    var res = [];
    Db.where('Timetable', function (s) { return s.status === 'active' && s.slotId !== excludeSlotId && s.dayOfWeek === c.dayOfWeek; }).forEach(function (s) {
      if (!(Timetable._toMin(c.startTime) < Timetable._toMin(s.endTime) && Timetable._toMin(s.startTime) < Timetable._toMin(c.endTime))) return;
      if (!(c.validFrom <= s.validTo && s.validFrom <= c.validTo)) return;
      if (s.labId === c.labId) res.push({ kind: 'lab', slotId: s.slotId, with: s });
      if (s.facultyId === c.facultyId) res.push({ kind: 'faculty', slotId: s.slotId, with: s });
    });
    return res;
  },
  _decorate: function (rows) {
    var labs = U.indexBy(Db.readAll('Labs'), 'labId'), courses = U.indexBy(Db.readAll('Courses'), 'courseId'), fac = U.indexBy(Db.readAll('FacultyProfiles'), 'facultyId');
    return rows.map(function (s) { return { slotId: s.slotId, labId: s.labId, labName: (labs[s.labId] || {}).name, courseId: s.courseId, courseCode: (courses[s.courseId] || {}).code, courseName: (courses[s.courseId] || {}).name,
      facultyId: s.facultyId, facultyName: (fac[s.facultyId] || {}).name, section: s.section, dayOfWeek: s.dayOfWeek, startTime: s.startTime, endTime: s.endTime, validFrom: s.validFrom, validTo: s.validTo, status: s.status }; });
  },
  list: function (ctx, p) {
    p = p || {};
    var rows = Db.where('Timetable', function (s) { return s.status === 'active'; });
    if (ctx.has('admin') || ctx.has('staff')) { if (p.labId) rows = rows.filter(function (s) { return s.labId === p.labId; }); }
    else if (ctx.has('faculty') && ctx.faculty) rows = rows.filter(function (s) { return s.facultyId === ctx.faculty.facultyId; });
    else if (ctx.has('student') && ctx.student) {
      var mine = {}; Db.where('Rosters', function (r) { return r.scopeType === 'course' && r.studentId === ctx.student.studentId && r.status === 'active'; }).forEach(function (r) { mine[r.scopeId] = true; });
      rows = rows.filter(function (s) { return mine[s.courseId] && (!s.section || s.section === ctx.student.section); });
    } else rows = [];
    return { slots: Timetable._decorate(rows) };
  },
  upsert: function (ctx, p) {
    V.obj(p);
    var rec = { labId: V.id(p.labId, 'Lab', 'lab'), courseId: V.id(p.courseId, 'Course', 'course'), facultyId: V.id(p.facultyId, 'Faculty', 'faculty'), section: V.str(p.section, 'Section', { optional: true, max: 10 }),
      dayOfWeek: V.int(p.dayOfWeek, 'Day of week', 1, 7), startTime: V.time(p.startTime, 'Start time'), endTime: V.time(p.endTime, 'End time'), validFrom: V.date(p.validFrom, 'Valid from'), validTo: V.date(p.validTo, 'Valid to') };
    if (Timetable._toMin(rec.startTime) >= Timetable._toMin(rec.endTime)) fail('BAD_INPUT', 'End time must be after start time.');
    if (rec.validFrom > rec.validTo) fail('BAD_INPUT', '"Valid to" must not be before "Valid from".');
    Db.mustGet('Labs', rec.labId, 'Lab'); Db.mustGet('Courses', rec.courseId, 'Course'); Db.mustGet('FacultyProfiles', rec.facultyId, 'Faculty');
    return Locks.with(function () {
      var cf = Timetable.conflicts(rec, p.slotId || '');
      var hard = cf.filter(function (c) { return c.kind === 'faculty'; }), soft = cf.filter(function (c) { return c.kind === 'lab'; });
      if (hard.length) fail('CONFLICT', 'That faculty member already teaches at this time (' + hard[0].with.startTime + '-' + hard[0].with.endTime + ').', { conflicts: Timetable._decorate(hard.map(function (c) { return c.with; })) });
      if (soft.length && !V.bool(p.override)) fail('CONFLICT', 'This lab is already booked at that time. Confirm the override only if the lab can host both classes.', { overridable: true, conflicts: Timetable._decorate(soft.map(function (c) { return c.with; })) });
      var s = p.slotId ? Db.update('Timetable', V.id(p.slotId, 'Slot', 'slot'), rec) : Db.insert('Timetable', Object.assign({ slotId: U.id('slot'), status: 'active', createdAt: U.now() }, rec));
      Audit.log({ actor: ctx.email, role: 'admin', action: p.slotId ? 'timetable.update' : 'timetable.create', entityType: 'Timetable', entityId: s.slotId, detail: Object.assign({ overrodeLabConflict: soft.length > 0 }, rec) });
      return { slot: Timetable._decorate([s])[0] };
    });
  },
  remove: function (ctx, p) {
    V.obj(p);
    var s = Db.update('Timetable', V.id(p.slotId, 'Slot', 'slot'), { status: 'inactive' });
    Audit.log({ actor: ctx.email, role: 'admin', action: 'timetable.remove', entityType: 'Timetable', entityId: s.slotId });
    return { ok: true };
  }
};
