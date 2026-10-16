/**
 * AttendanceService.gs - challenge issue, kiosk scanning, rescans, spot checks, corrections, summaries.
 *
 * SOURCE OF TRUTH: AttendanceEvents is APPEND-ONLY. No code path updates or deletes an event row.
 *   IN / OUT / RESCAN      accepted kiosk scans
 *   SPOT_OK / SPOT_FAIL    faculty photo spot-check outcomes
 *   CORR_IN / CORR_OUT     manual corrections (operator, reason, approval status recorded)
 *   VOID                   cancels an earlier event (ref = that event's id) - the original stays in the log
 *   DECISION               admin approval/rejection of a pending correction (ref = the correction's id)
 * AttendanceSummaries is DERIVED and can be rebuilt from events at any time (Attend.rebuildSummary).
 *
 * VERIFIED DURATION: time counts only between an entry and a verified end - an exit scan, or (when the exit scan is
 * missing) the last rescan/spot-check inside that stint. A missing exit scan NEVER credits the full session.
 */
var Attend = {
  LATE_AFTER_MIN: 15,
  PURPOSE: { i: 'in', o: 'out', r: 'rescan' },
  PURPOSE_CODE: { 'in': 'i', 'out': 'o', rescan: 'r' },
  TYPE_OF: { 'in': 'IN', out: 'OUT', rescan: 'RESCAN' },

  // ---- reading events ---------------------------------------------------------------------------------
  /** All events for a session. Open sessions read only the recent tail (fast); others scan the table. */
  _eventsFor: function (session) {
    if (session.status !== 'open') return Db.where('AttendanceEvents', function (e) { return e.sessionId === session.sessionId; });
    var cutoff = (session.openedAt || session.scheduledStart) - 60000, n = 400, rows;
    for (;;) {
      rows = Db.tail('AttendanceEvents', n);
      if (rows.length < n || (rows.length && rows[0].createdAt < cutoff)) break;
      n *= 4;
    }
    return rows.filter(function (e) { return e.sessionId === session.sessionId; });
  },

  /** Apply VOID / DECISION / pending / rejected semantics; return events that count, grouped by student. */
  _effective: function (events) {
    var decisions = {};
    events.filter(function (e) { return e.type === 'DECISION'; }).sort(function (a, b) { return a.createdAt - b.createdAt; }).forEach(function (d) { decisions[d.ref] = d.approvalStatus; });
    function approval(e) { return decisions[e.eventId] || e.approvalStatus; }
    var voided = {};
    events.forEach(function (e) { if (e.type === 'VOID' && approval(e) !== 'pending' && approval(e) !== 'rejected') voided[e.ref] = true; });
    var out = {};
    events.forEach(function (e) {
      if (e.type === 'DECISION' || e.type === 'VOID') return;
      var a = approval(e);
      if (a === 'pending' || a === 'rejected' || voided[e.eventId]) return;
      (out[e.studentId] = out[e.studentId] || []).push(e);
    });
    Object.keys(out).forEach(function (k) { out[k].sort(function (a, b) { return a.at - b.at || a.createdAt - b.createdAt; }); });
    return out;
  },

  /** Pure derivation for ONE student from their effective events. */
  _compute: function (session, evts, windows, now) {
    var inAt = null, stints = [], firstIn = null, lastOut = null, verified = [], spotFail = false, corrected = false;
    (evts || []).forEach(function (e) {
      if (e.type === 'CORR_IN' || e.type === 'CORR_OUT') corrected = true;
      if (e.type === 'IN' || e.type === 'CORR_IN') { if (inAt === null) { inAt = e.at; if (firstIn === null) firstIn = e.at; verified.push(e.at); } }
      else if (e.type === 'OUT' || e.type === 'CORR_OUT') { if (inAt !== null) { stints.push({ inAt: inAt, out: e.at }); lastOut = e.at; inAt = null; verified.push(e.at); } }
      else if (e.type === 'RESCAN' || e.type === 'SPOT_OK') verified.push(e.at);
      else if (e.type === 'SPOT_FAIL') spotFail = true;
    });
    if (inAt !== null) stints.push({ inAt: inAt, out: null });
    var inside = inAt !== null;

    // Rescan windows the student was inside for, but did not answer.
    var rescans = (evts || []).filter(function (e) { return e.type === 'RESCAN'; });
    var missed = [];
    (windows || []).forEach(function (w) {
      var over = w.status === 'closed' || now > w.closesAt;
      if (!over) return;
      var was = stints.some(function (s) { return s.inAt <= w.openedAt && (s.out === null || s.out > w.openedAt); });
      if (!was) return;
      if (!rescans.some(function (r) { return r.at >= w.openedAt && r.at <= w.closesAt + 2000; })) missed.push(w.openedAt);
    });

    var requireExit = Settings.get('requireExitScan'), minutes = 0, verifiedUntil = null;
    stints.forEach(function (s) {
      var inStint = verified.filter(function (t) { return t >= s.inAt && (s.out === null || t <= s.out); });
      var lastV = Math.max.apply(null, inStint.concat([s.inAt]));
      var end = s.out !== null ? s.out : (requireExit ? lastV : Math.min(session.closedAt || now, session.scheduledEnd));
      var m = missed.filter(function (t) { return t > s.inAt && (s.out === null || t < s.out); });
      if (m.length) {
        var cap = Math.min.apply(null, m);
        var before = inStint.filter(function (t) { return t < cap; });
        end = Math.min(end, Math.max.apply(null, before.concat([s.inAt])));
      }
      minutes += Math.max(0, end - s.inAt) / 60000;
      if (verifiedUntil === null || end > verifiedUntil) verifiedUntil = end;
    });

    var flags = [];
    if (firstIn !== null && firstIn > session.scheduledStart + Attend.LATE_AFTER_MIN * 60000) flags.push('late');
    if (inside && requireExit && session.status !== 'open') flags.push('unverified_exit');
    if (missed.length) flags.push('missed_rescan');
    if (spotFail) flags.push('spot_check_failed');
    if (corrected) flags.push('corrected');
    var status = firstIn === null ? 'absent' : spotFail ? 'flagged' : missed.length ? 'missed_rescan' : (inside && requireExit && session.status !== 'open') ? 'unverified_exit' : 'present';
    return { state: inside ? 'in' : (firstIn === null ? 'none' : 'out'), firstIn: firstIn, lastOut: lastOut, verifiedMinutes: Math.round(minutes * 10) / 10, verifiedUntil: verifiedUntil, status: status, flags: flags, inside: inside, missedWindows: missed.length };
  },

  activeWindow: function (sessionId, now) {
    now = now || U.now();
    var w = Db.where('RescanWindows', function (x) { return x.sessionId === sessionId && x.status === 'open' && x.openedAt <= now && now <= x.closesAt; });
    return w.length ? w[w.length - 1] : null;
  },

  // ---- challenge (student side) ---------------------------------------------------------------------------
  /**
   * Validate that `studentId` may perform `purpose` in `session` right now, given effective events.
   * Used both when issuing a challenge and again, under the lock, when the scan is redeemed.
   */
  _checkAllowed: function (session, studentId, purpose, now, effectiveByStudent) {
    var st = session.status;
    if (purpose === 'in') { if (st !== 'open') fail('SESSION_NOT_OPEN', st === 'closed' ? 'This session is closed.' : 'This session has not been opened by the faculty yet.'); }
    else if (purpose === 'out') {
      var graceOk = st === 'closed' && session.closedAt && now <= session.closedAt + Settings.get('exitGraceMinutes') * 60000;
      if (st !== 'open' && !graceOk) fail('SESSION_NOT_OPEN', 'This session is closed and the exit grace period has passed. Ask your faculty for a correction.');
    } else if (purpose === 'rescan') {
      if (st !== 'open') fail('SESSION_NOT_OPEN', 'This session is not open.');
      if (!Attend.activeWindow(session.sessionId, now)) fail('NO_RESCAN_WINDOW', 'There is no rescan window open right now.');
    } else fail('BAD_INPUT', 'Unknown action.');
    if (!Roster.isEligible(session, studentId)) fail('NOT_ELIGIBLE', 'You are not enrolled in this session.');
    var c = Attend._compute(session, effectiveByStudent[studentId] || [], [], now);
    if (purpose === 'in' && c.inside) fail('DUPLICATE_IN', 'You are already checked in.');
    if ((purpose === 'out' || purpose === 'rescan') && !c.inside) fail('NO_ENTRY', 'You have not checked in to this session.');
    if (purpose === 'rescan') {
      var w = Attend.activeWindow(session.sessionId, now), done = (effectiveByStudent[studentId] || []).some(function (e) { return e.type === 'RESCAN' && e.at >= w.openedAt; });
      if (done) fail('ALREADY_RESCANNED', 'You have already confirmed for this rescan.');
    }
    return c;
  },

  /** Issue a fresh, single-use challenge for the device to sign. The QR = token + '~' + signature. */
  challenge: function (ctx, p) {
    V.obj(p);
    var st = Creds._requireVerifiedStudent(ctx);
    var purpose = V.enumOf(p.purpose, 'Action', ['in', 'out', 'rescan']);
    var session = Db.mustGet('Sessions', V.id(p.sessionId, 'Session', 'session'), 'Session');
    var cred = Creds.get(V.id(p.credentialId, 'Device', 'cred'));
    if (!cred || cred.studentId !== st.studentId) fail('NO_DEVICE', 'This device is not registered to you.');
    if (cred.status !== 'active') fail('DEVICE_INACTIVE', cred.status === 'pending_approval' ? 'This device is waiting for approval at the lab desk.' : 'This device has been revoked. Register it again.');
    if (!Auth.rateLimit('chal|' + st.studentId, 40, 60)) fail('RATE_LIMITED', 'Too many requests. Wait a moment.');
    var now = U.now();
    Attend._checkAllowed(session, st.studentId, purpose, now, Attend._effective(Attend._eventsFor(session)));
    var ttl = Settings.get('qrTtlSeconds'), exp = Math.floor(now / 1000) + ttl;
    var token = Tokens.make(['a1', st.studentId, cred.credentialId, session.sessionId, session.labId, Attend.PURPOSE_CODE[purpose], Tokens.nonce(), String(exp)]);
    return { token: token, expiresAt: exp * 1000, ttl: ttl, serverNow: now };
  },

  // ---- scanning (kiosk side) ------------------------------------------------------------------------------
  kioskScan: function (ctx, p) {
    V.obj(p);
    var kiosk = ctx.kiosk;
    if (!kiosk) fail('FORBIDDEN', 'Only a registered kiosk can scan.');
    var info = { kioskId: kiosk.kioskId };
    try { return Attend._scan(kiosk, String(p.qr || ''), info); }
    catch (e) {
      if (e instanceof AppError) {
        Audit.tryLog({ actor: kiosk.authorizedEmail, role: 'kiosk', action: 'scan.reject', entityType: 'Session', entityId: info.sessionId || '', result: 'rejected',
                       detail: { code: e.code, kioskId: kiosk.kioskId, studentId: info.studentId || '', purpose: info.purpose || '', credentialId: info.credentialId || '' } });
        if (info.studentName) e.extra = Object.assign({}, e.extra, { student: info.studentName });
      }
      throw e;
    }
  },

  _scan: function (kiosk, qr, info) {
    if (!Auth.rateLimit('scan|' + kiosk.kioskId, 150, 60)) fail('RATE_LIMITED', 'Scanner is going too fast. Wait a moment.');
    var sep = qr.indexOf('~');
    if (sep < 1 || qr.length > 500) fail('BAD_TOKEN', 'That is not a LABFLOW code.');
    var token = qr.slice(0, sep), sig = qr.slice(sep + 1);
    var parts = Tokens.parse(token, 'a1', 8); // MAC check: proves the server issued it, untampered
    var studentId = parts[1], credId = parts[2], sessionId = parts[3], labId = parts[4], purpose = Attend.PURPOSE[parts[5]], nonce = parts[6], exp = Number(parts[7]);
    Object.assign(info, { studentId: studentId, credentialId: credId, sessionId: sessionId, purpose: purpose });
    if (!purpose) fail('BAD_TOKEN', 'Unrecognised code.');
    var now = U.now();
    if (now / 1000 > exp + 5) fail('EXPIRED', 'This code has expired. Refresh it on the phone and scan again.');
    if (exp - now / 1000 > 190) fail('BAD_TOKEN', 'Invalid code timing.');
    if (labId !== kiosk.labId) fail('WRONG_LAB', 'This code is for a different lab.');
    if (!Auth.rateLimit('scanstu|' + studentId, 15, 60)) fail('RATE_LIMITED', 'Too many scans for this student. Wait a moment.');

    var cred = Creds.get(credId);
    if (!cred || cred.studentId !== studentId) fail('UNKNOWN_DEVICE', 'Device not recognised.');
    if (cred.status !== 'active') fail('REVOKED', 'This device is no longer valid.');
    var student = Db.cachedGet('StudentProfiles', 'studentId', studentId, 120);
    if (!student) fail('UNKNOWN_STUDENT', 'Student not found.');
    info.studentName = student.name;
    if (!Creds.verifySignature(cred.publicKey, token, sig)) fail('BAD_SIGNATURE', 'The device signature is invalid.'); // the expensive step: outside the lock

    return Locks.with(function () {
      if (Tokens.wasRedeemed(nonce)) fail('REPLAY', 'This code was already used.');
      var again = Creds.get(credId); // re-read inside the lock: revocation must win a race
      if (!again || again.status !== 'active') fail('REVOKED', 'This device is no longer valid.');
      var stu = Db.cachedGet('StudentProfiles', 'studentId', studentId, 120);
      if (!stu || stu.status !== 'verified') fail('NOT_VERIFIED', 'This student profile is not verified.');
      var user = stu.userId ? Db.cachedGet('Users', 'userId', stu.userId, 120) : null;
      if (!user || user.status !== 'active') fail('ACCOUNT_DISABLED', 'This account is disabled.');
      var session = Db.get('Sessions', sessionId);
      if (!session || session.labId !== kiosk.labId) fail('SESSION_NOT_FOUND', 'Session not found.');
      var now2 = U.now();
      var eff = Attend._effective(Attend._eventsFor(session));
      Attend._checkAllowed(session, studentId, purpose, now2, eff);
      var win = purpose === 'rescan' ? Attend.activeWindow(sessionId, now2) : null;
      var ev = Db.insert('AttendanceEvents', { eventId: U.id('event'), sessionId: sessionId, labId: labId, studentId: studentId, type: Attend.TYPE_OF[purpose], source: 'kiosk', kioskId: kiosk.kioskId,
        credentialId: credId, nonce: nonce, at: now2, recordedBy: kiosk.authorizedEmail, approvalStatus: 'na', ref: win ? win.windowId : '', createdAt: now2 });
      Tokens.redeem(nonce, purpose, studentId, sessionId, kiosk.kioskId, ev.eventId);
      Audit.log({ actor: kiosk.authorizedEmail, role: 'kiosk', action: 'scan.accept', entityType: 'AttendanceEvent', entityId: ev.eventId, detail: { type: ev.type, studentId: studentId, sessionId: sessionId, kioskId: kiosk.kioskId } });
      return { ok: true, type: ev.type, at: now2, student: { name: stu.name, rollNo: stu.rollNo }, session: { sessionId: sessionId, title: session.title } };
    });
  },

  // ---- live views -----------------------------------------------------------------------------------------
  studentState: function (session, studentId) {
    var now = U.now(), eff = Attend._effective(Attend._eventsFor(session));
    var wins = Db.where('RescanWindows', function (w) { return w.sessionId === session.sessionId; });
    var c = Attend._compute(session, eff[studentId] || [], wins, now);
    var w = Attend.activeWindow(session.sessionId, now), done = w ? (eff[studentId] || []).some(function (e) { return e.type === 'RESCAN' && e.at >= w.openedAt; }) : false;
    return { state: c.state, firstIn: c.firstIn, lastOut: c.lastOut, status: c.status, verifiedMinutes: c.verifiedMinutes, flags: c.flags,
             rescan: w && c.inside ? { windowId: w.windowId, closesAt: w.closesAt, done: done } : null };
  },

  liveCounts: function (session) {
    var now = U.now(), eff = Attend._effective(Attend._eventsFor(session)), wins = Db.where('RescanWindows', function (w) { return w.sessionId === session.sessionId; });
    var eligible = session.openToAll ? null : Object.keys(Roster.eligibleSet(session));
    var inside = 0, left = 0, seen = 0, flagged = 0, unverified = 0;
    Object.keys(eff).forEach(function (sid) {
      var c = Attend._compute(session, eff[sid], wins, now);
      if (c.firstIn !== null) seen++;
      if (c.inside) inside++; else if (c.firstIn !== null) left++;
      if (c.status === 'flagged' || c.status === 'missed_rescan') flagged++;
      if (c.status === 'unverified_exit') unverified++;
    });
    var w = Attend.activeWindow(session.sessionId, now);
    return { enrolled: eligible ? eligible.length : null, inside: inside, left: left, attended: seen, absent: eligible ? Math.max(0, eligible.length - seen) : null, flagged: flagged, unverifiedExits: unverified, rescanWindow: w ? { windowId: w.windowId, closesAt: w.closesAt } : null };
  },

  /** Faculty live roster: every enrolled student plus anyone else who scanned in. */
  roster: function (ctx, p) {
    V.obj(p);
    var session = Db.mustGet('Sessions', V.id(p.sessionId, 'Session', 'session'), 'Session');
    if (!(ctx.has('staff') || Auth.ownsSession(ctx, session))) fail('FORBIDDEN', 'This is not your session.');
    var now = U.now(), eff = Attend._effective(Attend._eventsFor(session)), wins = Db.where('RescanWindows', function (w) { return w.sessionId === session.sessionId; });
    var ids = session.openToAll ? {} : Roster.eligibleSet(session);
    Object.keys(eff).forEach(function (k) { ids[k] = true; });
    var profiles = U.indexBy(Db.readAll('StudentProfiles'), 'studentId');
    var checks = {}; Db.where('SpotChecks', function (c) { return c.sessionId === session.sessionId; }).forEach(function (c) { checks[c.studentId] = c; });
    var rows = Object.keys(ids).map(function (sid) {
      var pr = profiles[sid] || {}, c = Attend._compute(session, eff[sid] || [], wins, now), sc = checks[sid];
      return { studentId: sid, rollNo: pr.rollNo, name: pr.name, section: pr.section, enrolled: session.openToAll ? null : !!Roster.eligibleSet(session)[sid], state: c.state, firstIn: c.firstIn, lastOut: c.lastOut, status: c.status, flags: c.flags,
               verifiedMinutes: c.verifiedMinutes, spotCheck: sc ? sc.outcome : null, hasPhoto: !!pr.photoFileId };
    }).sort(function (a, b) { return String(a.rollNo) < String(b.rollNo) ? -1 : 1; });
    return { session: Sessions.pub(session, Sessions._ref()), counts: Attend.liveCounts(session), roster: rows, serverNow: now };
  },

  // ---- rescan windows --------------------------------------------------------------------------------------
  openRescan: function (ctx, p) {
    V.obj(p);
    var minutes = V.int(p.minutes, 'Minutes', 1, 60, { optional: true, def: Settings.get('rescanWindowMinutes') });
    return Locks.with(function () {
      var s = Db.mustGet('Sessions', V.id(p.sessionId, 'Session', 'session'), 'Session');
      if (!Auth.ownsSession(ctx, s)) fail('FORBIDDEN', 'This is not your session.');
      if (s.status !== 'open') fail('INVALID_STATE', 'Rescans can only be requested while the session is open.');
      if (Attend.activeWindow(s.sessionId)) fail('CONFLICT', 'A rescan window is already open.');
      var w = Attend._startWindow(s, 'manual', ctx.email, minutes);
      Audit.log({ actor: ctx.email, role: ctx.roles[0], action: 'rescan.open', entityType: 'Session', entityId: s.sessionId, detail: { minutes: minutes, windowId: w.windowId } });
      return { window: { windowId: w.windowId, closesAt: w.closesAt } };
    });
  },
  _startWindow: function (session, kind, by, minutes) {
    var now = U.now();
    var w = Db.insert('RescanWindows', { windowId: U.id('window'), sessionId: session.sessionId, kind: kind, openedAt: now, closesAt: now + minutes * 60000, openedBy: by, status: 'open' });
    Db.update('Sessions', session.sessionId, { rescansDone: (session.rescansDone || 0) + 1, nextRescanAt: null });
    return w;
  },
  /** Trigger (every few minutes): start due random windows, close expired ones. */
  tickRescans: function () {
    var now = U.now(), started = 0, closed = 0;
    Db.where('RescanWindows', function (w) { return w.status === 'open' && w.closesAt < now; }).forEach(function (w) { Db.update('RescanWindows', w.windowId, { status: 'closed' }); closed++; });
    Db.where('Sessions', function (s) { return s.status === 'open' && s.rescanMode === 'random' && s.nextRescanAt && s.nextRescanAt <= now; }).forEach(function (s) {
      Locks.with(function () {
        var fresh = Db.get('Sessions', s.sessionId);
        if (fresh.status !== 'open' || !fresh.nextRescanAt || fresh.nextRescanAt > U.now() || Attend.activeWindow(fresh.sessionId)) return;
        var w = Attend._startWindow(fresh, 'random', 'system', Settings.get('rescanWindowMinutes'));
        Audit.log({ actor: 'system', role: 'system', action: 'rescan.random', entityType: 'Session', entityId: fresh.sessionId, detail: { windowId: w.windowId } });
        started++;
      });
    });
    return { started: started, closed: closed };
  },

  // ---- photo spot checks -----------------------------------------------------------------------------------
  startSpotCheck: function (ctx, p) {
    V.obj(p);
    var count = V.int(p.count, 'Count', 1, 20, { optional: true, def: Settings.get('spotCheckDefaultCount') });
    return Locks.with(function () {
      var s = Db.mustGet('Sessions', V.id(p.sessionId, 'Session', 'session'), 'Session');
      if (!Auth.ownsSession(ctx, s)) fail('FORBIDDEN', 'This is not your session.');
      if (s.status !== 'open') fail('INVALID_STATE', 'Spot checks run while the session is open.');
      var now = U.now(), eff = Attend._effective(Attend._eventsFor(s)), done = {};
      Db.where('SpotChecks', function (c) { return c.sessionId === s.sessionId; }).forEach(function (c) { done[c.studentId] = true; });
      var pool = Object.keys(eff).filter(function (sid) { return !done[sid] && Attend._compute(s, eff[sid], [], now).inside; });
      var chosen = p.studentId ? [V.id(p.studentId, 'Student', 'student')] : U.shuffle(pool).slice(0, count);
      if (p.studentId && pool.indexOf(chosen[0]) < 0) fail('INVALID_STATE', 'That student is not currently checked in (or was already checked).');
      if (!chosen.length) fail('INVALID_STATE', 'There is nobody left to check right now.');
      var profiles = U.indexBy(Db.readAll('StudentProfiles'), 'studentId');
      var rows = Db.insertMany('SpotChecks', chosen.map(function (sid) { return { checkId: U.id('spot'), sessionId: s.sessionId, studentId: sid, requestedBy: ctx.email, requestedAt: now, outcome: 'pending' }; }));
      Audit.log({ actor: ctx.email, role: ctx.roles[0], action: 'spot.start', entityType: 'Session', entityId: s.sessionId, detail: { checked: chosen.length } });
      return { checks: rows.map(function (c) { var pr = profiles[c.studentId] || {}; return { checkId: c.checkId, studentId: c.studentId, name: pr.name, rollNo: pr.rollNo, hasPhoto: !!pr.photoFileId }; }) };
    });
  },
  listSpotChecks: function (ctx, p) {
    V.obj(p);
    var s = Db.mustGet('Sessions', V.id(p.sessionId, 'Session', 'session'), 'Session');
    if (!Auth.ownsSession(ctx, s) && !ctx.has('staff')) fail('FORBIDDEN', 'This is not your session.');
    var profiles = U.indexBy(Db.readAll('StudentProfiles'), 'studentId');
    return { checks: Db.where('SpotChecks', function (c) { return c.sessionId === s.sessionId; }).map(function (c) { var pr = profiles[c.studentId] || {}; return { checkId: c.checkId, studentId: c.studentId, name: pr.name, rollNo: pr.rollNo, hasPhoto: !!pr.photoFileId, outcome: c.outcome, note: c.note, requestedAt: c.requestedAt, resolvedAt: c.resolvedAt }; }) };
  },
  resolveSpotCheck: function (ctx, p) {
    V.obj(p);
    var outcome = V.enumOf(p.outcome, 'Outcome', ['confirmed', 'mismatch', 'absent']), note = V.str(p.note, 'Note', { optional: true, max: 200 });
    if (outcome !== 'confirmed' && note.length < 3) fail('BAD_INPUT', 'Add a short note explaining what you saw.');
    return Locks.with(function () {
      var c = Db.mustGet('SpotChecks', V.id(p.checkId, 'Spot check', 'spot'), 'Spot check');
      var s = Db.mustGet('Sessions', c.sessionId, 'Session');
      if (!Auth.ownsSession(ctx, s)) fail('FORBIDDEN', 'This is not your session.');
      if (c.outcome !== 'pending') fail('INVALID_STATE', 'This check is already resolved.');
      var now = U.now();
      Db.update('SpotChecks', c.checkId, { outcome: outcome, resolvedBy: ctx.email, resolvedAt: now, note: note });
      Db.insert('AttendanceEvents', { eventId: U.id('event'), sessionId: s.sessionId, labId: s.labId, studentId: c.studentId, type: outcome === 'confirmed' ? 'SPOT_OK' : 'SPOT_FAIL', source: 'faculty', at: now, recordedBy: ctx.email,
        reason: note, approvalStatus: 'na', ref: c.checkId, createdAt: now });
      Audit.log({ actor: ctx.email, role: ctx.roles[0], action: 'spot.resolve', entityType: 'SpotCheck', entityId: c.checkId, detail: { outcome: outcome, studentId: c.studentId, note: note } });
      return { ok: true };
    });
  },

  // ---- corrections (append-only) -------------------------------------------------------------------------------
  correct: function (ctx, p) {
    V.obj(p);
    var action = V.enumOf(p.action, 'Action', ['add_in', 'add_out', 'void']);
    var reason = V.str(p.reason, 'Reason', { min: 10, max: 300 });
    return Locks.with(function () {
      var s = Db.mustGet('Sessions', V.id(p.sessionId, 'Session', 'session'), 'Session');
      if (!Auth.ownsSession(ctx, s)) fail('FORBIDDEN', 'This is not your session.');
      if (s.status !== 'open' && s.status !== 'closed') fail('INVALID_STATE', 'Corrections apply to opened sessions.');
      var studentId = V.id(p.studentId, 'Student', 'student');
      var student = Db.mustGet('StudentProfiles', studentId, 'Student');
      var now = U.now(), eff = Attend._effective(Attend._eventsFor(s)), cur = Attend._compute(s, eff[studentId] || [], [], now);
      var rec = { eventId: U.id('event'), sessionId: s.sessionId, labId: s.labId, studentId: studentId, source: 'manual', recordedBy: ctx.email, reason: reason, createdAt: now };
      if (action === 'void') {
        var target = Db.mustGet('AttendanceEvents', V.id(p.eventId, 'Event', 'event'), 'Event');
        if (target.sessionId !== s.sessionId || target.studentId !== studentId) fail('BAD_INPUT', 'That event does not belong to this student and session.');
        if (target.type === 'VOID' || target.type === 'DECISION') fail('BAD_INPUT', 'That kind of event cannot be voided.');
        rec.type = 'VOID'; rec.ref = target.eventId; rec.at = now;
      } else {
        var at = p.at ? V.int(p.at, 'Time', 1, 4102444800000) : now;
        if (at > now + 60000) fail('BAD_INPUT', 'A correction cannot be in the future.');
        if (at < s.scheduledStart - 3600000) fail('BAD_INPUT', 'That time is long before the session.');
        if (action === 'add_in') {
          if (!Roster.isEligible(s, studentId) && !ctx.has('admin')) fail('NOT_ELIGIBLE', 'This student is not enrolled in the session. An admin must add them first.');
          if (cur.inside) fail('DUPLICATE_IN', 'The student is already checked in.');
          rec.type = 'CORR_IN';
        } else {
          if (!cur.inside) fail('NO_ENTRY', 'The student has no open entry to close.');
          if (at < cur.firstIn) fail('BAD_INPUT', 'An exit cannot be before the entry.');
          rec.type = 'CORR_OUT';
        }
        rec.at = at;
      }
      var late = now - s.scheduledEnd > Settings.get('correctionApprovalAfterHours') * 3600000;
      var auto = ctx.has('admin') || !late;
      rec.approvalStatus = auto ? 'approved' : 'pending';
      rec.approvedBy = auto ? (ctx.has('admin') ? ctx.email : 'policy:within-' + Settings.get('correctionApprovalAfterHours') + 'h') : '';
      var ev = Db.insert('AttendanceEvents', rec);
      Audit.log({ actor: ctx.email, role: ctx.roles[0], action: 'attendance.correct', entityType: 'AttendanceEvent', entityId: ev.eventId, detail: { action: action, studentId: studentId, rollNo: student.rollNo, sessionId: s.sessionId, reason: reason, approval: rec.approvalStatus, at: rec.at } });
      if (!auto) Notify.toRole('admin', 'correction', 'Attendance correction needs approval', ctx.email + ' requested a correction for ' + student.rollNo + ' (' + s.title + ').', 'corr:' + ev.eventId);
      if (s.status === 'closed' && auto) Attend.rebuildSummary(s.sessionId);
      return { eventId: ev.eventId, approvalStatus: rec.approvalStatus };
    });
  },

  pendingCorrections: function () {
    var all = Db.where('AttendanceEvents', function (e) { return (e.type === 'CORR_IN' || e.type === 'CORR_OUT' || e.type === 'VOID') && e.approvalStatus === 'pending'; });
    var decided = {}; Db.where('AttendanceEvents', function (e) { return e.type === 'DECISION'; }).forEach(function (d) { decided[d.ref] = true; });
    var profiles = U.indexBy(Db.readAll('StudentProfiles'), 'studentId'), sessions = U.indexBy(Db.readAll('Sessions'), 'sessionId');
    return { corrections: all.filter(function (e) { return !decided[e.eventId]; }).map(function (e) { var pr = profiles[e.studentId] || {}, s = sessions[e.sessionId] || {};
      return { eventId: e.eventId, type: e.type, at: e.at, reason: e.reason, requestedBy: e.recordedBy, createdAt: e.createdAt, studentName: pr.name, rollNo: pr.rollNo, sessionTitle: s.title, sessionDate: s.date, sessionId: e.sessionId }; }) };
  },
  decideCorrection: function (ctx, p) {
    V.obj(p);
    var approve = V.bool(p.approve), note = V.str(p.note, 'Note', { optional: true, max: 200 });
    return Locks.with(function () {
      var e = Db.mustGet('AttendanceEvents', V.id(p.eventId, 'Correction', 'event'), 'Correction');
      if (e.approvalStatus !== 'pending' || ['CORR_IN', 'CORR_OUT', 'VOID'].indexOf(e.type) < 0) fail('INVALID_STATE', 'This is not a pending correction.');
      if (Db.where('AttendanceEvents', function (d) { return d.type === 'DECISION' && d.ref === e.eventId; }).length) fail('INVALID_STATE', 'Already decided.');
      var now = U.now();
      Db.insert('AttendanceEvents', { eventId: U.id('event'), sessionId: e.sessionId, labId: e.labId, studentId: e.studentId, type: 'DECISION', source: 'manual', at: now, recordedBy: ctx.email, reason: note, approvalStatus: approve ? 'approved' : 'rejected', approvedBy: ctx.email, ref: e.eventId, createdAt: now });
      Audit.log({ actor: ctx.email, role: 'admin', action: approve ? 'correction.approve' : 'correction.reject', entityType: 'AttendanceEvent', entityId: e.eventId, detail: { note: note, requestedBy: e.recordedBy } });
      var s = Db.get('Sessions', e.sessionId);
      if (s && s.status === 'closed') Attend.rebuildSummary(s.sessionId);
      return { ok: true };
    });
  },

  // ---- derived summaries ---------------------------------------------------------------------------------------
  /** Recompute AttendanceSummaries for a session from its events. Safe to run any number of times. */
  rebuildSummary: function (sessionId) {
    var s = Db.mustGet('Sessions', sessionId, 'Session'), now = U.now();
    var events = Db.where('AttendanceEvents', function (e) { return e.sessionId === sessionId; });
    var eff = Attend._effective(events), wins = Db.where('RescanWindows', function (w) { return w.sessionId === sessionId; });
    var ids = s.openToAll ? {} : Roster.eligibleSet(s);
    Object.keys(eff).forEach(function (k) { ids[k] = true; });
    var existing = {}; Db.where('AttendanceSummaries', function (r) { return r.sessionId === sessionId; }).forEach(function (r) { existing[r.studentId] = r; });
    var create = [], updated = 0;
    Locks.with(function () {
      Object.keys(ids).forEach(function (sid) {
        var c = Attend._compute(s, eff[sid] || [], wins, now);
        var rec = { sumId: sessionId + ':' + sid, sessionId: sessionId, studentId: sid, status: c.status, firstIn: c.firstIn, lastOut: c.lastOut, verifiedUntil: c.verifiedUntil, verifiedMinutes: c.verifiedMinutes, flags: c.flags, computedAt: now };
        var ex = existing[sid];
        if (!ex) create.push(rec);
        else if (ex.status !== rec.status || ex.firstIn !== rec.firstIn || ex.lastOut !== rec.lastOut || ex.verifiedMinutes !== rec.verifiedMinutes || JSON.stringify(ex.flags) !== JSON.stringify(rec.flags)) { Db.putRow('AttendanceSummaries', ex.__row, rec); updated++; }
      });
      if (create.length) Db.insertMany('AttendanceSummaries', create);
    });
    return { students: Object.keys(ids).length, created: create.length, updated: updated };
  },

  /** Consistency checks for one session (admin tool / nightly job). Reports; does not change events. */
  reconcile: function (sessionId) {
    var s = Db.mustGet('Sessions', sessionId, 'Session'), problems = [];
    var events = Db.where('AttendanceEvents', function (e) { return e.sessionId === sessionId; });
    var seenNonce = {};
    events.forEach(function (e) {
      if (e.nonce) { if (seenNonce[e.nonce]) problems.push({ kind: 'duplicate_nonce', eventId: e.eventId }); seenNonce[e.nonce] = true; }
      if (e.source === 'kiosk' && s.status === 'scheduled') problems.push({ kind: 'scan_before_open', eventId: e.eventId });
    });
    var eff = Attend._effective(events);
    Object.keys(eff).forEach(function (sid) {
      var depth = 0;
      eff[sid].forEach(function (e) {
        if (e.type === 'IN' || e.type === 'CORR_IN') { depth++; if (depth > 1) problems.push({ kind: 'double_entry', studentId: sid, eventId: e.eventId }); }
        if (e.type === 'OUT' || e.type === 'CORR_OUT') { depth--; if (depth < 0) { problems.push({ kind: 'exit_without_entry', studentId: sid, eventId: e.eventId }); depth = 0; } }
      });
      if (!s.openToAll && !Roster.eligibleSet(s)[sid]) problems.push({ kind: 'not_enrolled', studentId: sid });
    });
    var sum = Attend.rebuildSummary(sessionId);
    return { sessionId: sessionId, events: events.length, problems: problems, summary: sum };
  },

  // ---- history -----------------------------------------------------------------------------------------------
  /** A student's own attendance history. Never reads another student's rows. */
  myHistory: function (ctx, p) {
    if (!ctx.student) return { history: [], totals: {} };
    p = p || {};
    var limit = V.int(p.limit, 'Limit', 1, 200, { optional: true, def: 60 });
    var sid = ctx.student.studentId, sessions = U.indexBy(Db.readAll('Sessions'), 'sessionId'), labs = U.indexBy(Db.readAll('Labs'), 'labId');
    var rows = Db.where('AttendanceSummaries', function (r) { return r.studentId === sid; }).filter(function (r) { return r.status !== 'absent' || (sessions[r.sessionId] && sessions[r.sessionId].status === 'closed'); });
    // Sessions still open have no stored summary yet (it is derived when the session closes): compute them live so the student sees today's record.
    var have = {}; rows.forEach(function (r) { have[r.sessionId] = true; });
    Object.keys(sessions).forEach(function (id) {
      var s = sessions[id]; if (s.status !== 'open' || have[id]) return;
      var st = Attend.studentState(s, sid); if (st.state === 'none') return;
      rows.push({ sessionId: id, studentId: sid, status: st.status, firstIn: st.firstIn, lastOut: st.lastOut, verifiedMinutes: st.verifiedMinutes, flags: st.flags });
    });
    rows = rows.map(function (r) { var s = sessions[r.sessionId] || {}; return { sessionId: r.sessionId, title: s.title, date: s.date, labName: (labs[s.labId] || {}).name, status: r.status, firstIn: r.firstIn, lastOut: r.lastOut, verifiedMinutes: r.verifiedMinutes, flags: r.flags || [], scheduledStart: s.scheduledStart, scheduledEnd: s.scheduledEnd }; })
      .sort(function (a, b) { return (b.scheduledStart || 0) - (a.scheduledStart || 0); });
    var totals = { sessions: rows.length, present: 0, absent: 0, unverifiedExits: 0, flagged: 0, verifiedMinutes: 0 };
    rows.forEach(function (r) { if (r.status === 'present') totals.present++; if (r.status === 'absent') totals.absent++; if (r.status === 'unverified_exit') totals.unverifiedExits++; if (r.status === 'flagged' || r.status === 'missed_rescan') totals.flagged++; totals.verifiedMinutes += r.verifiedMinutes || 0; });
    totals.verifiedMinutes = Math.round(totals.verifiedMinutes);
    return { history: rows.slice(0, limit), totals: totals };
  },
  /** One student's raw events in one session, for the responsible faculty (or staff/admin), so an earlier scan can be voided with a reason. */
  studentEvents: function (ctx, p) {
    V.obj(p);
    var s = Db.mustGet('Sessions', V.id(p.sessionId, 'Session', 'session'), 'Session');
    if (!(ctx.has('staff') || Auth.ownsSession(ctx, s))) fail('FORBIDDEN', 'This is not your session.');
    var sid = V.id(p.studentId, 'Student', 'student');
    var evs = Db.where('AttendanceEvents', function (e) { return e.sessionId === s.sessionId && e.studentId === sid; }), voided = {};
    evs.forEach(function (e) { if (e.type === 'VOID' && e.approvalStatus !== 'rejected') voided[e.ref] = true; });
    return { events: evs.filter(function (e) { return e.type !== 'DECISION'; }).map(function (e) { return { eventId: e.eventId, type: e.type, at: e.at, source: e.source, reason: e.reason, approvalStatus: e.approvalStatus, voided: !!voided[e.eventId] }; }).sort(function (a, b) { return a.at - b.at; }) };
  },
  /** One session's raw events for the student themselves (shows exceptions and corrections transparently). */
  myEvents: function (ctx, p) {
    V.obj(p);
    if (!ctx.student) return { events: [] };
    var sessionId = V.id(p.sessionId, 'Session', 'session'), sid = ctx.student.studentId;
    return { events: Db.where('AttendanceEvents', function (e) { return e.sessionId === sessionId && e.studentId === sid && e.type !== 'DECISION'; })
      .map(function (e) { return { type: e.type, at: e.at, source: e.source, reason: e.source === 'manual' ? e.reason : '', approvalStatus: e.approvalStatus }; }).sort(function (a, b) { return a.at - b.at; }) };
  }
};
