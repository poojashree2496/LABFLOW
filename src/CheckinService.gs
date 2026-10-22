/**
 * CheckinService.gs - Version A, the check-in the functional requirements describe: the lab kiosk shows a QR that
 * changes every few seconds, the student scans it with the phone camera, the web app opens with the code in the link,
 * and the phone's GPS reading is checked against the lab's geofence.
 *
 *   kiosk.display   (kiosk account)  current code and link, drawn as a QR; rotates every kioskQrIntervalSeconds (FR-7)
 *   checkin.open    (student)        validates the scanned code the moment the page opens (FR-8, FR-9) and returns a
 *                                    short pass bound to this student plus the choices (in / out / rescan, sessions)
 *   checkin.submit  (student)        pass + action + session + location reading -> Checkin.STEPS_A
 *
 * A code is valid for every student, but each student can use it once (FR-10), so a whole class can scan the same
 * screen. The pass gives the student kioskPassMinutes to finish (login and GPS take longer than one rotation).
 *
 * What this proves, and what it does not (SRS 6.3): the code proves someone saw the kiosk screen recently; the
 * location is whatever the phone reports, and a student who calls this function from the browser console can send
 * the lab's coordinates. The geofence stops casual cheating only. Spot checks and rescan windows are the defence,
 * and Version B (device-signed QR scanned in the room) is the stronger mode.
 *
 * Privacy (FR-31): latitude and longitude are used for the distance check and then dropped. Only the geofence
 * result, the distance to the lab (0.1 m) and the reported accuracy are stored; never the coordinates.
 */
var Checkin = {
  BOOKING_EARLY_MS: 15 * 60000,

  _interval: function () { return Settings.get('kioskQrIntervalSeconds'); },
  _step: function (now) { return Math.floor(now / (Checkin._interval() * 1000)); },
  _code: function (kioskId, step) {
    var body = 'k1.' + kioskId + '.' + step;
    return body + '.' + U.hmacB64u(Tokens._secret(), 'kiosk|' + body).slice(0, 16);
  },
  _onceKey: function (kioskId, step, studentId) { return 'k:' + kioskId + ':' + step + ':' + studentId; },
  linkFor: function (code) {
    var base = Setup.webAppUrl();
    return base ? base + (base.indexOf('?') >= 0 ? '&' : '?') + 'k=' + encodeURIComponent(code) : '?k=' + encodeURIComponent(code);
  },

  // ---- kiosk screen -----------------------------------------------------------------------------------------
  display: function (ctx) {
    var k = ctx.kiosk;
    if (!k) fail('FORBIDDEN', 'Not a kiosk account.');
    Kiosks.touch(k);
    var lab = Db.cachedGet('Labs', 'labId', k.labId, 120);
    if (!lab) fail('NOT_FOUND', 'This kiosk\'s lab no longer exists.');
    var now = U.now(), interval = Checkin._interval(), step = Checkin._step(now);
    var open = Db.where('Sessions', function (s) { return s.labId === k.labId && s.status === 'open'; });
    var out = {
      kiosk: { kioskId: k.kioskId, name: k.name }, lab: Labs._pub(lab), mode: Labs.modeOf(lab), serverNow: now,
      occupancy: Occupancy.lab(k.labId), openSessions: open.map(function (s) { return { sessionId: s.sessionId, title: s.title, type: s.type, scheduledEnd: s.scheduledEnd }; }),
      recent: Checkin._recent(k.labId)
    };
    if (Labs.allows(lab, 'A')) {
      var code = Checkin._code(k.kioskId, step);
      out.code = code; out.url = Checkin.linkFor(code); out.interval = interval; out.nextAt = (step + 1) * interval * 1000;
    }
    return out;
  },
  /** The last few accepted scans in this lab, for the kiosk screen (name, roll number, direction). */
  _recent: function (labId) {
    var since = U.dayStart(U.local(U.now()).date);
    var rows = Db.tail('AttendanceEvents', 60).filter(function (e) { return e.labId === labId && e.at >= since && (e.type === 'IN' || e.type === 'OUT' || e.type === 'RESCAN'); }).slice(-6).reverse();
    return rows.map(function (e) { var st = Db.cachedGet('StudentProfiles', 'studentId', e.studentId, 300) || {}; return { name: st.name, rollNo: st.rollNo, type: e.type, at: e.at, eventId: e.eventId, method: e.method }; });
  },

  // ---- page open: validate the code, issue the pass -----------------------------------------------------------
  STEPS_OPEN: [
    { id: 'code_format', label: 'Link carries a LABFLOW kiosk code', run: function (c) {
      var raw = String(c.input || '').trim();
      if (raw.length > 600) fail('BAD_CODE', 'That is not a LABFLOW kiosk code.');
      if (raw.indexOf('?') >= 0 || raw.indexOf('k=') === 0) raw = U.queryParam(raw.indexOf('?') >= 0 ? raw : '?' + raw, 'k');
      var p = raw.split('.');
      if (p.length !== 4 || p[0] !== 'k1' || !/^KSK-[0-9A-F]{12}$/.test(p[1]) || !/^\d{1,12}$/.test(p[2]) || !/^[A-Za-z0-9_-]{16}$/.test(p[3])) fail('BAD_CODE', 'That is not a LABFLOW kiosk code.');
      c.code = raw; c.kioskId = p[1]; c.step = Number(p[2]);
    } },
    { id: 'code_mac', label: 'Code was issued by this server (HMAC)', run: function (c) {
      if (!U.safeEq(Checkin._code(c.kioskId, c.step), c.code)) fail('BAD_CODE', 'This code was not issued by LABFLOW.');
    } },
    { id: 'code_age', label: 'Code was on the screen moments ago', run: function (c) {
      var now = U.now(), interval = Checkin._interval() * 1000, shownUntil = (c.step + 1) * interval, age = (now - shownUntil) / 1000;
      if (c.step * interval > now + 5000) fail('BAD_CODE', 'This code is dated in the future.');
      if (age > Settings.get('kioskCodeMaxAgeSeconds')) fail('CODE_EXPIRED', 'That kiosk code is too old. Scan the code on the lab screen again.');
    } },
    { id: 'kiosk_active', label: 'Kiosk is active and its lab uses kiosk QR check-in', run: function (c) { Checkin._kioskAndLab(c); } },
    { id: 'student_verified', label: 'Caller is a verified student', run: function (c) {
      c.student = Creds._requireVerifiedStudent(c.ctx); c.studentId = c.student.studentId;
      c.subject = { studentId: c.studentId, kioskId: c.kioskId };
    } },
    { id: 'code_unused', label: 'This student has not used this code yet (FR-10)', run: function (c) {
      if (Tokens.wasRedeemed(Checkin._onceKey(c.kioskId, c.step, c.studentId))) fail('REPLAY', 'You already used this code. Scan the current code on the lab screen.');
    } }
  ],
  _kioskAndLab: function (c) {
    c.kiosk = Db.get('Kiosks', c.kioskId);
    if (!c.kiosk || c.kiosk.status !== 'active') fail('KIOSK_INACTIVE', 'This kiosk is not active.');
    c.lab = Db.cachedGet('Labs', 'labId', c.kiosk.labId, 120);
    if (!c.lab || c.lab.status !== 'active') fail('KIOSK_INACTIVE', 'This lab is not active.');
    if (!Labs.allows(c.lab, 'A')) fail('MODE_DISABLED', 'This lab uses device QR check-in. Open LABFLOW and show your QR to the scanner.');
    c.labId = c.lab.labId;
  },

  open: function (ctx, p) {
    V.obj(p);
    if (!Auth.rateLimit('kopen|' + ctx.email, 20, 60)) fail('RATE_LIMITED', 'Too many attempts. Wait a moment.');
    var c = { input: p.code, ctx: ctx, mode: 'A' };
    try { Pipeline.run('A.open', Checkin.STEPS_OPEN, c); }
    catch (e) { if (e instanceof AppError) Attend._afterReject(c, e, ctx.email, 'student'); throw e; }
    var now = U.now(), exp = Math.floor(now / 1000) + Settings.get('kioskPassMinutes') * 60;
    var pass = Tokens.make(['p1', c.studentId, c.kioskId, c.labId, String(c.step), String(exp)]);
    var lab = c.lab;
    return Object.assign({
      pass: pass, passExpiresAt: exp * 1000, serverNow: now,
      lab: { labId: lab.labId, code: lab.code, name: lab.name, hasGeofence: Labs.hasGeofence(lab), radiusM: Labs.radiusOf(lab) },
      geoUnavailablePolicy: Settings.get('geoUnavailablePolicy'), consentRequired: Users.consentRequired(ctx.user)
    }, Checkin.options(c.student, lab, now));
  },

  /**
   * What this student can do at this lab right now. If they are inside a session here: check out, or confirm a rescan.
   * Otherwise the sessions they could check in to, grouped by entry reason (FR-13), with the timetabled class first
   * (FR-14: the course is pre-filled from the timetable).
   */
  options: function (student, lab, now) {
    Sessions._openLabsDue(U.local(now).date);
    var sid = student.studentId, workChoices = Work.choices(sid, lab.labId, now);
    var here = Db.where('Sessions', function (s) {
      return s.labId === lab.labId && (s.status === 'open' || (s.status === 'closed' && s.closedAt && now <= s.closedAt + Settings.get('exitGraceMinutes') * 60000) ||
        (s.type === 'research' && s.status === 'scheduled' && now >= s.scheduledStart - Sessions._OPEN_EARLY_MS && now <= s.scheduledEnd));
    });
    var graceExit = null;
    for (var i = 0; i < here.length; i++) {
      if (!Sessions.allows(here[i], lab, 'A')) continue;
      var st = here[i].status === 'scheduled' ? null : Attend.studentState(here[i], sid);
      if (!st || st.state !== 'in') continue;
      var inside = { sessionId: here[i].sessionId, title: here[i].title, since: st.lastIn || st.firstIn, rescan: st.rescan, closed: here[i].status === 'closed' };
      if (here[i].status === 'open') {
        var actions = ['out'];
        if (st.rescan && !st.rescan.done) actions.unshift('rescan');
        return { inside: inside, actions: actions, candidates: [], workChoices: workChoices };
      }
      graceExit = inside; // still "inside" a session that has just closed: they can scan out, or check in to the next one
    }
    var cands = [];
    here.forEach(function (s) {
      if (s.status === 'closed') return;
      if (!Sessions.allows(s, lab, 'A')) return; // the faculty chose device QR only for this session
      if (s.type === 'openlab' && !Sessions.openLabAvailable(s, now)) return;
      var eligible = Roster.isEligible(s, sid);
      if (s.type === 'research' && !eligible) return; // someone else's research visit
      cands.push({ sessionId: s.sessionId, title: s.title, reason: Attend.reasonOf(s), eligible: eligible, scheduledStart: s.scheduledStart, scheduledEnd: s.scheduledEnd, status: s.status, assetId: Work.reservedSystem(s) });
    });
    Booking.activeWorkstationBookings(sid, lab.labId, now, Checkin.BOOKING_EARLY_MS).forEach(function (r) {
      if (cands.some(function (x) { return x.reservationId === r.reservationId; })) return;
      if (Db.getBy('Sessions', 'slotKey', 'rsv|' + r.reservationId)) return; // its self-work session is already listed
      cands.push({ sessionId: null, reservationId: r.reservationId, title: 'Self-work: ' + Booking._resourceName(r), reason: 'research', eligible: true, scheduledStart: r.startAt, scheduledEnd: r.endAt, status: 'booking', assetId: Work.isSystem(Db.get('Assets', r.resourceId)) ? r.resourceId : '' });
    });
    var order = { 'class': 0, event: 1, research: 2, openlab: 3 };
    cands.sort(function (a, b) { return (b.eligible - a.eligible) || (order[a.reason] - order[b.reason]) || (a.scheduledStart - b.scheduledStart); });
    var pre = cands.filter(function (x) { return x.eligible; })[0];
    var acts = graceExit ? (pre ? ['in', 'out'] : ['out']) : ['in'];
    return { inside: graceExit, actions: acts, candidates: cands, prefill: pre ? (pre.sessionId || pre.reservationId) : null, workChoices: workChoices };
  },

  // ---- submit: the Version A verification pipeline ------------------------------------------------------------
  STEPS_A: [
    { id: 'pass_mac', label: 'Check-in pass is authentic (HMAC)', run: function (c) {
      var parts = Tokens.parse(c.input, 'p1', 6);
      c.passStudentId = parts[1]; c.kioskId = parts[2]; c.passLabId = parts[3]; c.step = Number(parts[4]); c.passExp = Number(parts[5]);
    } },
    { id: 'pass_owner', label: 'Pass belongs to the signed-in student', run: function (c) {
      c.student = Creds._requireVerifiedStudent(c.ctx); c.studentId = c.student.studentId;
      c.subject = { studentId: c.studentId, kioskId: c.kioskId, purpose: c.action };
      if (c.studentId !== c.passStudentId) fail('BAD_PASS', 'This check-in was started from another account.');
      if (Users.consentRequired(c.ctx.user)) fail('CONSENT_REQUIRED', 'Accept the privacy notice first.');
    } },
    { id: 'pass_fresh', label: 'Finished within the pass time (FR-9)', run: function (c) {
      if (U.now() / 1000 > c.passExp) fail('PASS_EXPIRED', 'More than ' + Settings.get('kioskPassMinutes') + ' minutes passed since you scanned. Scan the code on the lab screen again.');
    } },
    { id: 'kiosk_active', label: 'Kiosk is active and its lab uses kiosk QR check-in', run: function (c) {
      Checkin._kioskAndLab(c);
      if (c.labId !== c.passLabId) fail('BAD_PASS', 'This pass is for another lab.');
    } },
    { id: 'rate_limit', label: 'Per-student check-in rate limit', run: function (c) {
      if (!Auth.rateLimit('acheck|' + c.studentId, 10, 60)) fail('RATE_LIMITED', 'Too many attempts. Wait a moment.');
    } },
    { id: 'target', label: 'Session chosen and entry reason matches it (FR-13)', run: function (c) {
      Checkin._resolveTarget(c);
      if (c.session && !Sessions.allows(c.session, c.lab, 'A')) fail('MODE_DISABLED', 'This session uses device QR. Open LABFLOW and show your QR to the scanner.');
    } },
    { id: 'work', label: 'Project and workstation choices are valid', run: function (c) {
      if (c.purpose === 'in') Work.validate(c.studentId, c.session, c.projectId, c.assetId, c.session.type === 'openlab');
    } },
    { id: 'geo_reading', label: 'Location reading received (or policy allows none)', run: function (c) {
      var g = c.geo;
      if (!g) {
        if (Settings.get('geoUnavailablePolicy') === 'reject') fail('NO_LOCATION', 'LABFLOW needs your location to check you in. Allow location for this page and try again.');
        c.geofence = 'na'; c.noGeo = true; c.assurance = 'lower';
        return;
      }
      if (typeof g !== 'object') fail('BAD_INPUT', 'Invalid location.');
      var ll = V.latLng(g.lat, g.lng);
      c.reading = { lat: ll.lat, lng: ll.lng, acc: V.num(g.accuracy, 'Accuracy', 0, 100000) };
    } },
    { id: 'geo_plausible', label: 'Reading is physically plausible (FR-30)', run: function (c) {
      if (c.noGeo) return;
      var min = Settings.get('minPlausibleAccuracyM');
      if (c.reading.acc < min) { c.reading = null; fail('IMPLAUSIBLE_LOCATION', 'Your phone reported a location more precise than phones can measure. Turn off any location app and try again.'); }
    } },
    { id: 'geofence', label: 'Inside the lab geofence (haversine with accuracy allowance, FR-11/12)', run: function (c) {
      if (c.noGeo) return;
      var lab = c.lab, r = c.reading;
      c.reading = null; // raw coordinates are not kept beyond this step (FR-31)
      if (!Labs.hasGeofence(lab)) { c.geofence = 'na'; c.assurance = 'lower'; c.accuracyM = Math.round(r.acc * 10) / 10; return; }
      var d = U.haversineM(r.lat, r.lng, lab.latitude, lab.longitude);
      var allowance = Math.min(r.acc, Settings.get('gpsAccuracyAllowanceM')), radius = Labs.radiusOf(lab);
      c.distanceM = Math.round(d * 10) / 10; c.accuracyM = Math.round(r.acc * 10) / 10;
      if (d - allowance > radius) { c.geofence = 'fail'; fail('OUTSIDE_GEOFENCE', 'Your phone places you ' + U.distanceBand(d) + ' from the lab (allowed: ' + radius + ' m). Move inside the lab, wait for a better GPS fix, or ask your faculty to verify you.', { band: U.distanceBand(d) }); }
      c.geofence = 'pass'; c.assurance = 'standard';
    } },
    { id: 'code_once', locked: true, label: 'Kiosk code used once by this student (FR-10)', run: function (c) {
      // Validation and location acquisition can outlive account changes or the pass itself.
      if (U.now() / 1000 > c.passExp) fail('PASS_EXPIRED', 'This check-in pass has expired. Scan the code on the lab screen again.');
      c.student = Attend._verifiedStudent(c.studentId);
      Checkin._kioskAndLab(c);
      if (c.labId !== c.passLabId) fail('BAD_PASS', 'This pass is for another lab.');
      c.nonce = Checkin._onceKey(c.kioskId, c.step, c.studentId); c.redeemPurpose = 'K';
      if (Tokens.wasRedeemed(c.nonce)) fail('REPLAY', 'You already used this code. Scan the current code on the lab screen.');
    } },
    { id: 'session_open', locked: true, label: 'Session is open in this lab (or inside the exit grace)', run: function (c) {
      c.session = Db.get('Sessions', c.session.sessionId);
      if (!c.session || c.session.labId !== c.labId) fail('SESSION_NOT_FOUND', 'Session not found.');
      if (!Sessions.allows(c.session, c.lab, 'A')) fail('MODE_DISABLED', 'This session uses device QR. Open LABFLOW and show your QR to the scanner.');
      c.now = U.now();
      Attend._sessionGate(c.session, c.purpose, c.now);
    } },
    { id: 'enrolment', locked: true, label: 'Student is on the roster for this session', run: function (c) { Attend._enrolmentGate(c.session, c.studentId); } },
    { id: 'attendance_state', locked: true, label: 'Direction is valid (no double entry, minimum gap, one rescan)', run: function (c) {
      c.state = Attend._stateGate(c.session, c.studentId, c.purpose, c.now, Attend._effective(Attend._eventsFor(c.session)));
    } },
    { id: 'record', locked: true, label: 'Append the event and mark the code used', run: function (c) {
      if (c.purpose === 'in') Work.validate(c.studentId, c.session, c.projectId, c.assetId, c.session.type === 'openlab');
      c.method = 'kiosk'; c.scannerRole = 'kiosk'; c.scannedBy = c.kiosk.authorizedEmail;
      Attend._record(c);
    } }
  ],

  /** Which session the action applies to. A workstation booking without a session gets its self-work session here. */
  _resolveTarget: function (c) {
    c.purpose = c.action;
    if (c.action === 'in') {
      if (c.reservationId) {
        var r = Db.mustGet('Reservations', c.reservationId, 'Booking');
        var mine = Booking.activeWorkstationBookings(c.studentId, c.labId, U.now(), Checkin.BOOKING_EARLY_MS).some(function (x) { return x.reservationId === r.reservationId; });
        if (!mine) fail('NOT_ELIGIBLE', 'That booking is not yours, not approved, or not running now.');
        c.session = Sessions.selfWorkFor(r, c.studentId);
      } else {
        if (!c.sessionId) fail('BAD_INPUT', 'Choose what you are here for.');
        c.session = Db.mustGet('Sessions', c.sessionId, 'Session');
        if (c.session.labId !== c.labId) fail('WRONG_LAB', 'That session is in another lab.');
        c.session = Sessions.openResearchIfDue(c.session, c.studentId);
      }
      var reason = Attend.reasonOf(c.session);
      if (c.reason && c.reason !== reason) fail('BAD_INPUT', 'That session is a ' + reason + ' session, not ' + c.reason + '.');
      c.entryReason = reason;
      return;
    }
    var found = null;
    var now = U.now(), grace = Settings.get('exitGraceMinutes') * 60000;
    var here = c.sessionId ? [Db.mustGet('Sessions', c.sessionId, 'Session')] : Db.where('Sessions', function (s) { return s.labId === c.labId && (s.status === 'open' || (s.status === 'closed' && s.closedAt && now <= s.closedAt + grace)); });
    for (var i = here.length - 1; i >= 0 && !found; i--) { if (here[i].labId === c.labId && Attend.studentState(here[i], c.studentId).state === 'in') found = here[i]; }
    if (!found) fail('NO_ENTRY', 'You are not checked in to a session in this lab.');
    c.session = found;
  },

  submit: function (ctx, p) {
    V.obj(p);
    var c = {
      ctx: ctx, input: p.pass, mode: 'A', geo: p.geo || null,
      action: V.enumOf(p.action, 'Action', ['in', 'out', 'rescan']),
      sessionId: p.sessionId ? V.id(p.sessionId, 'Session', 'session') : '',
      reservationId: p.reservationId ? V.id(p.reservationId, 'Booking', 'reservation') : '',
      projectId: p.projectId ? V.id(p.projectId, 'Project', 'project') : '', assetId: p.assetId ? V.id(p.assetId, 'System', 'asset') : '',
      reason: V.enumOf(p.reason, 'Reason', Cfg.ENTRY_REASONS, { optional: true })
    };
    try {
      var res = Pipeline.run('A.checkin', Checkin.STEPS_A, c);
      Attend._afterAccept(c);
      return res;
    } catch (e) {
      if (e instanceof AppError) Attend._afterReject(c, e, ctx.email, 'student');
      throw e;
    }
  }
};
