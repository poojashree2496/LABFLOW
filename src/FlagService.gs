/**
 * FlagService.gs - anomalies for faculty and staff to review (SRS Flags tab, findings "Flags").
 *
 * A flag never changes attendance by itself. It records something a person should look at: an impossible GPS
 * reading, the same reading in two sessions, check-ins at two labs too far apart, a used or stale QR shown again,
 * two students scanned on one phone within seconds, repeated manual check-ins or missing exit scans.
 * Each flag has a dedupe key so the same situation is raised once. Detectors run after the scan outside the lock and
 * can never fail a check-in.
 */
var Flags = {
  TYPES: {
    implausible_location: { severity: 'high', label: 'Impossible GPS accuracy (possible location faking)' },
    identical_reading: { severity: 'medium', label: 'Identical GPS reading in two different sessions' },
    impossible_travel: { severity: 'high', label: 'Check-ins at two labs too far apart for the time between them' },
    no_location: { severity: 'low', label: 'Checked in without a location' },
    outside_geofence: { severity: 'low', label: 'Check-in attempt from outside the lab geofence' },
    replay_attempt: { severity: 'medium', label: 'A used code was shown again (screenshot or relay)' },
    stale_qr: { severity: 'low', label: 'An old QR was shown (screenshot)' },
    back_to_back: { severity: 'medium', label: 'Two students scanned on one phone within seconds' },
    desktop_device: { severity: 'low', label: 'Device registered from a desktop browser' },
    frequent_manual: { severity: 'medium', label: 'Frequent manual check-ins' },
    never_scans_out: { severity: 'medium', label: 'Repeatedly leaves without an exit scan' }
  },
  WINDOW_MS: 30 * 86400000,

  raise: function (type, o) {
    var meta = Flags.TYPES[type];
    if (!meta) throw new Error('Unknown flag type ' + type);
    var rec;
    try {
      rec = Db.insert('Flags', { flagId: U.id('flag'), type: type, severity: meta.severity, studentId: o.studentId || '', sessionId: o.sessionId || '', labId: o.labId || '', detail: o.detail || null,
        status: 'open', createdAt: U.now(), dedupeKey: o.dedupeKey || '' });
    } catch (e) { if (e && e.code === 'DUPLICATE') return null; throw e; }
    if (meta.severity !== 'low') {
      var st = o.studentId ? (Db.cachedGet('StudentProfiles', 'studentId', o.studentId, 300) || {}) : {}, who = st.name ? st.name + ' (' + st.rollNo + ')' : 'A student';
      var s = o.sessionId ? Db.get('Sessions', o.sessionId) : null, f = s && s.facultyId ? Db.get('FacultyProfiles', s.facultyId) : null;
      var body = who + ': ' + meta.label + (s ? ' in ' + s.title : '') + '. Review it under Flags.';
      if (f && f.userId) Notify.toUser(f.userId, 'flag', 'Attendance flag', body, 'flag:' + rec.flagId, { email: false });
      else Notify.toRole('staff', 'flag', 'Attendance flag', body, 'flag:' + rec.flagId);
    }
    return rec;
  },

  // ---- detectors ------------------------------------------------------------------------------------------
  afterScan: function (c) {
    var sid = c.studentId, s = c.session, now = c.now || U.now();
    if (c.mode === 'A' && c.noGeo) Flags.raise('no_location', { studentId: sid, sessionId: s.sessionId, labId: s.labId, dedupeKey: 'noloc|' + sid + '|' + s.sessionId });
    if (c.mode === 'A' && c.distanceM !== undefined && c.distanceM !== null) {
      var same = Db.tail('AttendanceEvents', 3000).filter(function (e) {
        return e.studentId === sid && e.sessionId !== s.sessionId && e.geofence === 'pass' && e.distanceM === c.distanceM && e.accuracyM === c.accuracyM;
      });
      if (same.length) Flags.raise('identical_reading', { studentId: sid, sessionId: s.sessionId, labId: s.labId, detail: { distanceM: c.distanceM, accuracyM: c.accuracyM, alsoIn: same.slice(-3).map(function (e) { return e.sessionId; }) }, dedupeKey: 'ident|' + sid + '|' + s.sessionId });
    }
    if (c.purpose === 'in') Flags._travel(sid, s, now);
    if (c.method === 'scanner' && Settings.get('backToBackSeconds') > 0) {
      var gap = Settings.get('backToBackSeconds') * 1000;
      var prev = Db.tail('AttendanceEvents', 20).filter(function (e) { return e.scannedBy === c.scannedBy && e.eventId !== (c.event && c.event.eventId) && e.studentId !== sid && now - e.at <= gap && now >= e.at; });
      if (prev.length) {
        var other = prev[prev.length - 1];
        Flags.raise('back_to_back', { studentId: sid, sessionId: s.sessionId, labId: s.labId, detail: { scanner: c.scannedBy, otherStudentId: other.studentId, seconds: Math.round((now - other.at) / 100) / 10 }, dedupeKey: 'b2b|' + other.eventId + '|' + sid });
      }
    }
  },
  /** Lab-to-lab hops faster than walking (FR-29). Needs both labs' coordinates; one lab alone cannot be checked. */
  _travel: function (sid, session, now) {
    var lab = Db.cachedGet('Labs', 'labId', session.labId, 120);
    if (!lab || !Labs.hasGeofence(lab)) return;
    var prev = Db.tail('AttendanceEvents', 800).filter(function (e) { return e.studentId === sid && (e.type === 'IN' || e.type === 'OUT' || e.type === 'RESCAN') && e.labId !== session.labId && now - e.at < 6 * 3600000 && e.at <= now; });
    if (!prev.length) return;
    var last = prev[prev.length - 1], other = Db.cachedGet('Labs', 'labId', last.labId, 120);
    if (!other || !Labs.hasGeofence(other)) return;
    var metres = U.haversineM(lab.latitude, lab.longitude, other.latitude, other.longitude), hours = Math.max(1, now - last.at) / 3600000, kmh = metres / 1000 / hours;
    if (metres > 50 && kmh > Settings.get('maxTravelSpeedKmh')) {
      Flags.raise('impossible_travel', { studentId: sid, sessionId: session.sessionId, labId: session.labId, dedupeKey: 'travel|' + last.eventId + '|' + sid,
        detail: { fromLab: other.code, toLab: lab.code, metres: Math.round(metres), minutes: Math.round((now - last.at) / 60000), kmh: Math.round(kmh) } });
    }
  },
  afterReject: function (c, e) {
    var sid = c.studentId, sess = c.session ? c.session.sessionId : (c.sessionId || ''), lab = c.labId || '';
    if (!sid) return;
    var day = U.local(U.now()).date;
    if (e.code === 'REPLAY') Flags.raise('replay_attempt', { studentId: sid, sessionId: sess, labId: lab, detail: { mode: c.mode, scanner: c.scannedBy || '' }, dedupeKey: 'replay|' + sid + '|' + (sess || day) });
    else if (e.code === 'STALE_QR') Flags.raise('stale_qr', { studentId: sid, sessionId: sess, labId: lab, detail: { scanner: c.scannedBy || '' }, dedupeKey: 'stale|' + sid + '|' + (sess || day) });
    else if (e.code === 'IMPLAUSIBLE_LOCATION') Flags.raise('implausible_location', { studentId: sid, sessionId: sess, labId: lab, dedupeKey: 'implaus|' + sid + '|' + day });
    else if (e.code === 'OUTSIDE_GEOFENCE') Flags.raise('outside_geofence', { studentId: sid, sessionId: sess, labId: lab, detail: { band: e.extra && e.extra.band }, dedupeKey: 'geo|' + sid + '|' + (sess || day) });
  },
  afterManual: function (studentId, session) {
    var since = U.now() - Flags.WINDOW_MS;
    var n = Db.where('AttendanceEvents', function (e) { return e.studentId === studentId && e.type === 'CORR_IN' && e.createdAt >= since; }).length;
    if (n >= 3) Flags.raise('frequent_manual', { studentId: studentId, sessionId: session.sessionId, labId: session.labId, detail: { manualInLast30Days: n }, dedupeKey: 'manual|' + studentId + '|' + U.local(U.now()).month });
  },
  afterClose: function (session) {
    var since = U.now() - Flags.WINDOW_MS, month = U.local(U.now()).month;
    var missedExit = function (x) { return x.status === 'unverified_exit' || (x.flags || []).indexOf('auto_out') >= 0; };
    var mine = Db.where('AttendanceSummaries', function (x) { return x.sessionId === session.sessionId && missedExit(x); });
    if (!mine.length) return;
    var recent = {}; Db.where('Sessions', function (s) { return s.closedAt && s.closedAt >= since; }).forEach(function (s) { recent[s.sessionId] = true; });
    var counts = {}, unverified = {}; Db.where('AttendanceSummaries', function (x) { return missedExit(x) && recent[x.sessionId]; }).forEach(function (x) {
      counts[x.studentId] = (counts[x.studentId] || 0) + 1;
      if (x.status === 'unverified_exit') unverified[x.studentId] = (unverified[x.studentId] || 0) + 1;
    });
    mine.forEach(function (x) {
      if ((counts[x.studentId] || 0) >= 3) Flags.raise('never_scans_out', { studentId: x.studentId, sessionId: session.sessionId, labId: session.labId, detail: { unverifiedExitsLast30Days: unverified[x.studentId] || 0, missedExitsLast30Days: counts[x.studentId] }, dedupeKey: 'noexit|' + x.studentId + '|' + month });
    });
  },
  afterRegistration: function (student, credentialId, desktop) {
    if (desktop) Flags.raise('desktop_device', { studentId: student.studentId, detail: { credentialId: credentialId }, dedupeKey: 'desk|' + credentialId });
  },

  // ---- review -----------------------------------------------------------------------------------------------
  _visible: function (ctx, f, sessions) {
    if (Auth.canView(ctx)) {
      var session = f.sessionId ? sessions[f.sessionId] : null, allowed = Auth.labFilter(ctx);
      return allowed(f.labId || (session || {}).labId) || !!(session && ctx.faculty && session.facultyId === ctx.faculty.facultyId);
    }
    var s = f.sessionId ? sessions[f.sessionId] : null;
    return !!(s && ctx.faculty && s.facultyId === ctx.faculty.facultyId);
  },
  list: function (ctx, p) {
    p = p || {};
    var status = V.enumOf(p.status, 'Status', ['open', 'resolved', 'dismissed', 'all'], { optional: true, def: 'open' });
    var sessions = U.indexBy(Db.readAll('Sessions'), 'sessionId'), profiles = U.indexBy(Db.readAll('StudentProfiles'), 'studentId'), labs = U.indexBy(Db.readAll('Labs'), 'labId');
    var rows = Db.readAll('Flags').filter(function (f) {
      return (status === 'all' || f.status === status) && (!p.sessionId || f.sessionId === p.sessionId) && (!p.studentId || f.studentId === p.studentId) && Flags._visible(ctx, f, sessions);
    }).reverse().slice(0, 300);
    return { flags: rows.map(function (f) {
      var st = profiles[f.studentId] || {}, s = sessions[f.sessionId] || {}, meta = Flags.TYPES[f.type] || {};
      return { flagId: f.flagId, type: f.type, label: meta.label || f.type, severity: f.severity, studentId: f.studentId, name: st.name, rollNo: st.rollNo, sessionId: f.sessionId, sessionTitle: s.title,
               labCode: (labs[f.labId] || {}).code, detail: f.detail, status: f.status, createdAt: f.createdAt, resolvedBy: f.resolvedBy, resolvedAt: f.resolvedAt, note: f.note };
    }), types: Flags.TYPES };
  },
  resolve: function (ctx, p) {
    V.obj(p);
    var outcome = V.enumOf(p.outcome, 'Outcome', ['resolved', 'dismissed']), note = V.str(p.note, 'Note', { min: 3, max: 300 });
    return Locks.with(function () {
      var f = Db.mustGet('Flags', V.id(p.flagId, 'Flag', 'flag'), 'Flag');
      var sessions = {}; if (f.sessionId) sessions[f.sessionId] = Db.get('Sessions', f.sessionId);
      if (!Flags._visible(ctx, f, sessions)) fail('FORBIDDEN', 'You cannot review this flag.');
      if (f.status !== 'open') fail('INVALID_STATE', 'This flag was already reviewed.');
      Db.update('Flags', f.flagId, { status: outcome, resolvedBy: ctx.email, resolvedAt: U.now(), note: note });
      Audit.log({ actor: ctx.email, role: ctx.roles[0], action: 'flag.' + outcome, entityType: 'Flag', entityId: f.flagId, detail: { type: f.type, studentId: f.studentId, note: note } });
      return { ok: true };
    });
  }
};
