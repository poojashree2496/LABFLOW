/**
 * AttendanceService.gs - attendance rules shared by both check-in modes, Version B scanning, rescans, spot checks,
 * corrections and summaries. Version A (kiosk QR + GPS) lives in CheckinService.gs and reuses the gates here.
 *
 * SOURCE OF TRUTH: AttendanceEvents is APPEND-ONLY. No code path updates or deletes an event row.
 *   IN / OUT / RESCAN      accepted check-ins (mode A or B; method kiosk | scanner)
 *   SPOT_OK / SPOT_FAIL    faculty photo spot-check outcomes
 *   CORR_IN / CORR_OUT     manual corrections (operator, reason, approval status recorded)
 *   VOID                   cancels an earlier event (ref = that event's id) - the original stays in the log
 *   DECISION               admin approval/rejection of a pending correction (ref = the correction's id)
 * AttendanceSummaries is DERIVED and can be rebuilt from events at any time (Attend.rebuildSummary).
 *
 * VERIFIED DURATION: time counts only between an entry and a verified end - an exit scan, or (when the exit scan is
 * missing) the last rescan/spot-check inside that stint. A missing exit scan NEVER credits the full session.
 * An event's lunch break (session.breakStart..breakEnd) is never counted and needs no scans.
 *
 * VERSION B (device-signed QR): the phone holds a server nonce (Attend.challenge) and re-signs "token.timestamp"
 * every few seconds; the QR is a link carrying "token~timestamp~signature". A kiosk scanner, or the phone of the
 * session's teacher, lab staff, an event coordinator or a class representative, submits it. Attend.STEPS_B is the
 * verification pipeline.
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

  /** Milliseconds of [a, b] that fall inside the session's break (0 when there is none). */
  _breakOverlap: function (session, a, b) {
    if (!session.breakStart || !session.breakEnd || b <= a) return 0;
    return Math.max(0, Math.min(b, session.breakEnd) - Math.max(a, session.breakStart));
  },
  inBreak: function (session, t) { return !!(session.breakStart && session.breakEnd && t >= session.breakStart && t < session.breakEnd); },

  /** Pure derivation for ONE student from their effective events. */
  _compute: function (session, evts, windows, now, withIntervals) {
    var inAt = null, stints = [], firstIn = null, lastOut = null, verified = [], spotFail = false, corrected = false, autoOut = false, lastEvent = null;
    (evts || []).forEach(function (e) {
      if (e.type === 'WORK') return; // work metadata never verifies presence or resets the scan gap
      if (e.type === 'CORR_IN' || e.type === 'CORR_OUT') corrected = true;
      if (e.type === 'IN' || e.type === 'CORR_IN') { if (inAt === null) { inAt = e.at; if (firstIn === null) firstIn = e.at; verified.push(e.at); } }
      else if (e.type === 'OUT' || e.type === 'CORR_OUT') {
        if (inAt !== null) {
          if (session.type === 'openlab' && e.type === 'OUT' && e.method === 'auto') autoOut = true;
          stints.push({ inAt: inAt, out: e.at }); lastOut = e.at; inAt = null; verified.push(e.at);
        }
      }
      else if (e.type === 'RESCAN' || e.type === 'SPOT_OK') verified.push(e.at);
      else if (e.type === 'SPOT_FAIL') spotFail = true;
      if (e.type === 'IN' || e.type === 'OUT' || e.type === 'RESCAN' || e.type === 'CORR_IN' || e.type === 'CORR_OUT') lastEvent = e;
    });
    var openIn = inAt;
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

    var requireExit = Settings.get('requireExitScan'), minutes = 0, verifiedUntil = null, intervals = [];
    stints.forEach(function (s) {
      var inStint = verified.filter(function (t) { return t >= s.inAt && (s.out === null || t <= s.out); });
      var lastV = Math.max.apply(null, inStint.concat([s.inAt]));
      var end = s.out !== null ? s.out : (requireExit ? lastV : Math.min(session.closedAt || now, session.scheduledEnd));
      if (session.type === 'openlab') end = Math.min(end, session.scheduledEnd, session.closedAt || now);
      var m = missed.filter(function (t) { return t > s.inAt && (s.out === null || t < s.out); });
      if (m.length) {
        var cap = Math.min.apply(null, m);
        var before = inStint.filter(function (t) { return t < cap; });
        end = Math.min(end, Math.max.apply(null, before.concat([s.inAt])));
      }
      if (withIntervals) intervals.push({ from: s.inAt, to: end });
      minutes += Math.max(0, end - s.inAt - Attend._breakOverlap(session, s.inAt, end)) / 60000;
      if (verifiedUntil === null || end > verifiedUntil) verifiedUntil = end;
    });

    var flags = [];
    if (firstIn !== null && firstIn > session.scheduledStart + Attend.LATE_AFTER_MIN * 60000) flags.push('late');
    if (inside && requireExit && session.status !== 'open') flags.push('unverified_exit');
    if (missed.length) flags.push('missed_rescan');
    if (spotFail) flags.push('spot_check_failed');
    if (corrected) flags.push('corrected');
    if (autoOut) flags.push('auto_out');
    var status = firstIn === null ? 'absent' : spotFail ? 'flagged' : missed.length ? 'missed_rescan' : (inside && requireExit && session.status !== 'open') ? 'unverified_exit' : 'present';
    var result = { state: inside ? 'in' : (firstIn === null ? 'none' : 'out'), firstIn: firstIn, lastOut: lastOut, lastIn: openIn, verifiedMinutes: Math.round(minutes * 10) / 10, verifiedUntil: verifiedUntil,
             status: status, flags: flags, inside: inside, missedWindows: missed.length, lastEvent: lastEvent };
    if (withIntervals) result.creditedIntervals = intervals;
    return result;
  },

  activeWindow: function (sessionId, now) {
    now = now || U.now();
    var w = Db.where('RescanWindows', function (x) { return x.sessionId === sessionId && x.status === 'open' && x.openedAt <= now && now <= x.closesAt; });
    return w.length ? w[w.length - 1] : null;
  },

  // ---- gates shared by both check-in modes -----------------------------------------------------------------
  /** Is the session in a state that accepts this kind of scan right now? */
  _sessionGate: function (session, purpose, now) {
    if (session.type === 'openlab') {
      var pending = Db.get('JobRuns', Sessions._closeRunId(session.sessionId));
      if ((session.status === 'open' && now >= session.scheduledEnd) || (pending && pending.status === 'pending')) {
        Sessions._closeOpenLab(session, 'system', 'system', 'Open lab closed at scheduled end');
        // Refuse this scan even if its caller read events before closure. A new scan must read fresh state.
        fail('OUT_OF_WINDOW', 'Open lab is available only during its enabled opening hours.');
      }
      if (purpose === 'in' && !Sessions.openLabAvailable(session, now)) fail('OUT_OF_WINDOW', 'Open lab is available only during its enabled opening hours.');
      if (session.status === 'closed') fail('SESSION_NOT_OPEN', 'This open lab is closed. Check your history for your sign-out.');
    }
    var st = session.status;
    if (purpose === 'in') { if (st !== 'open') fail('SESSION_NOT_OPEN', st === 'closed' ? 'This session is closed.' : 'This session has not been opened yet.'); }
    else if (purpose === 'out') {
      var graceOk = st === 'closed' && session.closedAt && now <= session.closedAt + Settings.get('exitGraceMinutes') * 60000;
      if (st !== 'open' && !graceOk) fail('SESSION_NOT_OPEN', 'This session is closed and the exit grace period has passed. Ask your faculty for a correction.');
    } else if (purpose === 'rescan') {
      if (st !== 'open') fail('SESSION_NOT_OPEN', 'This session is not open.');
      if (!Attend.activeWindow(session.sessionId, now)) fail('NO_RESCAN_WINDOW', 'There is no rescan window open right now.');
    } else fail('BAD_INPUT', 'Unknown action.');
  },
  _enrolmentGate: function (session, studentId) {
    if (!Roster.isEligible(session, studentId)) fail('NOT_ELIGIBLE', 'This student is not on the roster for this session.');
  },
  /** Direction rules for one student, from their effective events. Returns the computed state. */
  _stateGate: function (session, studentId, purpose, now, effectiveByStudent) {
    var mine = effectiveByStudent[studentId] || [];
    var c = Attend._compute(session, mine, [], now);
    if (purpose === 'in' && c.inside) fail('DUPLICATE_IN', 'Already checked in.');
    if ((purpose === 'out' || purpose === 'rescan') && !c.inside) fail('NO_ENTRY', 'Not checked in to this session.');
    if (purpose === 'out') {
      var gap = Settings.get('minScanGapSeconds') * 1000, since = c.lastEvent ? now - c.lastEvent.at : Infinity;
      if (since < gap) fail('TOO_SOON', 'Checked in ' + Math.round(since / 1000) + ' seconds ago. Check-out is possible after ' + Math.round(gap / 1000) + ' seconds (stops accidental double scans).');
    }
    if (purpose === 'rescan') {
      var w = Attend.activeWindow(session.sessionId, now), done = mine.some(function (e) { return e.type === 'RESCAN' && e.at >= w.openedAt; });
      if (done) fail('ALREADY_RESCANNED', 'Presence already confirmed for this rescan.');
    }
    return c;
  },
  _checkAllowed: function (session, studentId, purpose, now, effectiveByStudent) {
    Attend._sessionGate(session, purpose, now);
    Attend._enrolmentGate(session, studentId);
    return Attend._stateGate(session, studentId, purpose, now, effectiveByStudent);
  },

  /** Append the accepted event, consume the single-use key, audit. Runs inside the lock (last pipeline step). */
  _record: function (c) {
    var s = c.session, now = c.now, purpose = c.purpose;
    var win = purpose === 'rescan' ? Attend.activeWindow(s.sessionId, now) : null;
    var ev = Db.insert('AttendanceEvents', {
      eventId: U.id('event'), sessionId: s.sessionId, labId: s.labId, studentId: c.studentId, type: Attend.TYPE_OF[purpose], source: c.method, kioskId: c.kioskId || '',
      credentialId: c.credentialId || '', nonce: c.nonce, at: now, recordedBy: c.scannedBy, approvalStatus: 'na', ref: win ? win.windowId : '', createdAt: now,
      mode: c.mode, method: c.method, scannedBy: c.scannedBy, scannerRole: c.scannerRole, geofence: c.geofence || '', distanceM: c.distanceM === undefined ? null : c.distanceM,
      accuracyM: c.accuracyM === undefined ? null : c.accuracyM, entryReason: c.entryReason || (purpose === 'in' ? Attend.reasonOf(s) : ''), assurance: c.assurance || 'standard',
      projectId: purpose === 'in' ? c.projectId || '' : '', assetId: purpose === 'in' ? c.assetId || '' : ''
    });
    Tokens.redeem(c.nonce, c.redeemPurpose || purpose, c.studentId, s.sessionId, c.kioskId || '', ev.eventId);
    Audit.log({ actor: c.scannedBy, role: c.scannerRole, action: 'scan.accept', entityType: 'AttendanceEvent', entityId: ev.eventId,
                detail: { type: ev.type, mode: c.mode, method: c.method, studentId: c.studentId, sessionId: s.sessionId, kioskId: c.kioskId || '', geofence: ev.geofence, assurance: ev.assurance,
                  projectId: ev.projectId, assetId: ev.assetId } });
    Occupancy.invalidate(s.labId);
    var stu = c.student || Db.cachedGet('StudentProfiles', 'studentId', c.studentId, 120) || {};
    c.event = ev;
    c.result = { ok: true, type: ev.type, at: now, eventId: ev.eventId, mode: c.mode, method: c.method, assurance: ev.assurance, geofence: ev.geofence,
                 student: { studentId: c.studentId, name: stu.name, rollNo: stu.rollNo, hasPhoto: !!stu.photoFileId }, session: { sessionId: s.sessionId, title: s.title } };
  },
  /** The entry reason a session implies (FR-13, plus v2 open lab). */
  reasonOf: function (session) { return session.type === 'openlab' ? 'openlab' : session.type === 'event' ? 'event' : session.type === 'research' ? 'research' : 'class'; },

  /** Follow-up work after an accepted scan. Never changes the outcome; failures are only logged. */
  _afterAccept: function (c) {
    try { Booking.markUsed(c.studentId, c.session.labId, c.now, c.assetId || ''); } catch (e) { Syslog.warn('attend', 'BOOKING_MARK_FAILED', String(e && e.message)); }
    try { Flags.afterScan(c); } catch (e) { Syslog.warn('attend', 'FLAG_CHECK_FAILED', String(e && e.message)); }
  },
  /** Record why a scan was refused, and raise a flag for refusals that indicate sharing or relaying. */
  _afterReject: function (c, e, actor, role) {
    if (e && e.code === 'SCAN_AGAIN') return; // a normal first read of a two-read check, not a rejection
    Audit.tryLog({ actor: actor, role: role, action: 'scan.reject', entityType: 'Session', entityId: c.sessionId || '', result: 'rejected',
                   detail: { code: e.code, mode: c.mode, method: c.method, kioskId: c.kioskId || '', studentId: c.studentId || '', purpose: c.purpose || '', step: (c.trace && c.trace.length) ? c.trace[c.trace.length - 1].id : '' } });
    try { Flags.afterReject(c, e); } catch (x) { /* never mask the real error */ }
  },

  // ---- challenge (student side, Version B) ------------------------------------------------------------------
  /** Issue a fresh, single-use server nonce for the device. The phone signs "token.timestamp" every few seconds. */
  challenge: function (ctx, p) {
    V.obj(p);
    var st = Creds._requireVerifiedStudent(ctx);
    var purpose = V.enumOf(p.purpose, 'Action', ['in', 'out', 'rescan']);
    var session = Db.mustGet('Sessions', V.id(p.sessionId, 'Session', 'session'), 'Session');
    var lab = Db.cachedGet('Labs', 'labId', session.labId, 120);
    if (!Labs.allows(lab, 'B')) fail('MODE_DISABLED', 'This lab uses the kiosk QR. Scan the code on the lab screen with your phone camera.');
    var cred = Creds.get(V.id(p.credentialId, 'Device', 'cred'));
    if (!cred || cred.studentId !== st.studentId) fail('NO_DEVICE', 'This device is not registered to you.');
    if (cred.status !== 'active') fail('DEVICE_INACTIVE', cred.status === 'pending_approval' ? 'This device is waiting for approval at the lab desk.' : 'This device has been revoked. Register it again.');
    if (!Auth.rateLimit('chal|' + st.studentId, 40, 60)) fail('RATE_LIMITED', 'Too many requests. Wait a moment.');
    session = Sessions.openResearchIfDue(session, st.studentId);
    var now = U.now();
    Attend._checkAllowed(session, st.studentId, purpose, now, Attend._effective(Attend._eventsFor(session)));
    var ttl = Settings.get('qrTtlSeconds'), exp = Math.floor(now / 1000) + ttl;
    var token = Tokens.make(['a1', st.studentId, cred.credentialId, session.sessionId, session.labId, Attend.PURPOSE_CODE[purpose], Tokens.nonce(), String(exp)]);
    return { token: token, expiresAt: exp * 1000, ttl: ttl, serverNow: now, rotateSeconds: Settings.get('studentQrRotateSeconds'), freshSeconds: Settings.get('qrFreshSeconds'), url: Setup.webAppUrl() };
  },

  _nonceFresh: function (c) {
    var now = U.now();
    if (now / 1000 > c.exp + 5) fail('EXPIRED', 'This code has expired. Keep the app open; it fetches a new one by itself.');
    if (c.exp - now / 1000 > 200) fail('BAD_TOKEN', 'Invalid code timing.');
  },
  _qrFresh: function (c) {
    var age = (U.now() - c.ts) / 1000;
    if (age > Settings.get('qrFreshSeconds')) fail('STALE_QR', 'This QR is ' + Math.round(age) + ' seconds old. Show the live code on the phone, not a screenshot.');
    if (age < -10) fail('STALE_QR', 'This QR is dated in the future. Check the phone clock and reopen the app.');
  },
  /**
   * Optional second read (setting scanLivenessReads = 2). The phone re-signs its QR every few seconds with a new timestamp.
   * The first good read is remembered and answered with SCAN_AGAIN; the code is accepted only when the same scanner reads
   * the same challenge again with a LATER signed timestamp. A still picture carries one timestamp, so it can never pass.
   * A live video of the phone does pass: this raises the cost of relaying, it does not remove it.
   */
  _liveness: function (c) {
    if (Settings.get('scanLivenessReads') < 2) return;
    if (Tokens.wasRedeemed(c.nonce)) fail('REPLAY', 'This code was already used.');
    var cache = CacheService.getScriptCache(), key = 'live|' + c.nonce, now = U.now(), first = null;
    try { first = JSON.parse(cache.get(key) || 'null'); } catch (e) { first = null; }
    if (first && first.by === c.scannedBy && now - first.at <= 20000) {
      if (c.ts > first.ts) { try { cache.remove(key); } catch (e) { /* the nonce is consumed on record anyway */ } return; }
      fail('SCAN_AGAIN', 'Same picture as the last read. Keep the live code in view until it changes.');
    }
    try { cache.put(key, JSON.stringify({ ts: c.ts, at: now, by: c.scannedBy }), 30); } catch (e) { fail('BUSY', 'Try the scan again.'); }
    fail('SCAN_AGAIN', 'Keep the phone in view. One more read to confirm it is live.');
  },
  _verifiedStudent: function (studentId) {
    var st = Db.get('StudentProfiles', studentId);
    if (!st) fail('UNKNOWN_STUDENT', 'Student not found.');
    if (st.status === 'disabled') fail('ACCOUNT_DISABLED', 'This student profile is disabled. Contact the lab office.');
    if (st.status !== 'verified') fail('NOT_VERIFIED', 'This student profile is not verified.');
    var user = st.userId ? Db.get('Users', st.userId) : null;
    if (!user || user.status !== 'active' || String(user.roles).split(',').indexOf('student') < 0) fail('ACCOUNT_DISABLED', 'This student account is not active.');
    return st;
  },

  // ---- Version B verification pipeline -------------------------------------------------------------------------
  STEPS_B: [
    { id: 'payload', label: 'Code is a LABFLOW student QR (link or raw text)', run: function (c) {
      var raw = String(c.input || '').trim();
      if (!raw || raw.length > 900) fail('BAD_TOKEN', 'That is not a LABFLOW code.');
      if (raw.indexOf('?') >= 0) raw = U.queryParam(raw, 's');
      var p = raw.split('~');
      if (p.length !== 3 || !p[0] || !/^\d{10,14}$/.test(p[1]) || !/^[A-Za-z0-9_-]{60,120}$/.test(p[2])) fail('BAD_TOKEN', 'That is not a LABFLOW code.');
      c.token = p[0]; c.ts = Number(p[1]); c.sig = p[2];
    } },
    { id: 'token_mac', label: 'Server token is authentic and untampered (HMAC)', run: function (c) {
      var parts = Tokens.parse(c.token, 'a1', 8);
      c.studentId = parts[1]; c.credentialId = parts[2]; c.sessionId = parts[3]; c.labId = parts[4]; c.purpose = Attend.PURPOSE[parts[5]]; c.nonce = parts[6]; c.exp = Number(parts[7]);
      if (!c.purpose) fail('BAD_TOKEN', 'Unrecognised code.');
      c.subject = { studentId: c.studentId, sessionId: c.sessionId, purpose: c.purpose };
    } },
    { id: 'nonce_fresh', label: 'Server nonce is still valid', run: function (c) { Attend._nonceFresh(c); } },
    { id: 'qr_fresh', label: 'Rotating timestamp is fresh (screenshots go stale)', run: function (c) { Attend._qrFresh(c); } },
    { id: 'mode_enabled', label: 'The lab accepts device QR check-in', run: function (c) {
      c.lab = Db.cachedGet('Labs', 'labId', c.labId, 120);
      if (!c.lab) fail('BAD_TOKEN', 'Unknown lab.');
      if (!Labs.allows(c.lab, 'B')) fail('MODE_DISABLED', 'This lab uses the kiosk QR + GPS check-in.');
    } },
    { id: 'scanner_allowed', label: 'The scanner may scan for this session', run: function (c) { Attend._authorizeScanner(c); } },
    { id: 'rate_limit', label: 'Per-student scan rate limit', run: function (c) {
      if (!Auth.rateLimit('scanstu|' + c.studentId, 15, 60)) fail('RATE_LIMITED', 'Too many scans for this student. Wait a moment.');
    } },
    { id: 'device_active', label: 'Device credential belongs to the student and is active', run: function (c) {
      c.cred = Creds.get(c.credentialId);
      if (!c.cred || c.cred.studentId !== c.studentId) fail('UNKNOWN_DEVICE', 'Device not recognised.');
      if (c.cred.status !== 'active') fail('REVOKED', 'This device is no longer valid.');
    } },
    { id: 'student_verified', label: 'Student profile is verified and the account active', run: function (c) {
      c.student = Db.cachedGet('StudentProfiles', 'studentId', c.studentId, 120);
      if (!c.student) fail('UNKNOWN_STUDENT', 'Student not found.');
      if (c.student.status === 'disabled') fail('ACCOUNT_DISABLED', 'This student profile is disabled. Contact the lab office.');
      if (c.student.status !== 'verified') fail('NOT_VERIFIED', 'This student profile is not verified.');
      var user = c.student.userId ? Db.cachedGet('Users', 'userId', c.student.userId, 120) : null;
      if (!user || user.status !== 'active') fail('ACCOUNT_DISABLED', 'This account is disabled.');
    } },
    { id: 'signature', label: 'ECDSA P-256 signature matches the registered public key', run: function (c) {
      if (!Creds.verifySignature(c.cred.publicKey, c.token + '.' + c.ts, c.sig)) fail('BAD_SIGNATURE', 'The device signature is invalid.');
    } },
    { id: 'liveness', label: 'QR was read twice with a new signed timestamp (live phone, not a picture)', run: function (c) { Attend._liveness(c); } },
    { id: 'replay', locked: true, label: 'Nonce has not been used before', run: function (c) {
      if (Tokens.wasRedeemed(c.nonce)) fail('REPLAY', 'This code was already used.');
    } },
    { id: 'revocation_recheck', locked: true, label: 'Credential still active (revocation wins a race)', run: function (c) {
      var again = Db.get('DeviceCredentials', c.credentialId);
      if (!again || again.status !== 'active' || again.studentId !== c.studentId) fail('REVOKED', 'This device is no longer valid.');
    } },
    { id: 'authorization_recheck', locked: true, label: 'Fresh code, active student, lab and scanner at commit time', run: function (c) {
      Attend._nonceFresh(c); Attend._qrFresh(c);
      c.student = Attend._verifiedStudent(c.studentId);
      c.lab = Db.get('Labs', c.labId);
      if (!c.lab || c.lab.status !== 'active' || !Labs.allows(c.lab, 'B')) fail('MODE_DISABLED', 'This lab no longer accepts device QR check-in.');
      if (c.scanner.kind === 'kiosk') {
        var kiosk = Db.get('Kiosks', c.scanner.kiosk.kioskId);
        if (!kiosk || kiosk.status !== 'active' || kiosk.authorizedEmail !== c.scannedBy) fail('KIOSK_INACTIVE', 'This kiosk is not active.');
        c.scanner.kiosk = kiosk;
      } else c.scanner.ctx = Auth._contextForEmail(c.scanner.ctx.email, true);
      Attend._authorizeScanner(c);
    } },
    { id: 'session_open', locked: true, label: 'Session is open in this lab (or inside the exit grace)', run: function (c) {
      c.session = Db.get('Sessions', c.sessionId);
      if (!c.session || c.session.labId !== c.labId) fail('SESSION_NOT_FOUND', 'Session not found.');
      c.now = U.now();
      Attend._sessionGate(c.session, c.purpose, c.now);
    } },
    { id: 'enrolment', locked: true, label: 'Student is on the roster for this session', run: function (c) { Attend._enrolmentGate(c.session, c.studentId); } },
    { id: 'attendance_state', locked: true, label: 'Direction is valid (no double entry, minimum gap, one rescan)', run: function (c) {
      c.state = Attend._stateGate(c.session, c.studentId, c.purpose, c.now, Attend._effective(Attend._eventsFor(c.session)));
    } },
    { id: 'work', locked: true, label: 'Booked workstation is available at entry', run: function (c) {
      if (c.purpose !== 'in') return;
      var booked = Work.booked(c.studentId, c.labId, c.now);
      c.assetId = Work.reservedSystem(c.session) || (booked.length ? booked[0].resourceId : '');
      Work.validate(c.studentId, c.session, '', c.assetId, false);
    } },
    { id: 'record', locked: true, label: 'Append the event and consume the nonce', run: function (c) { Attend._record(c); } }
  ],

  /** Who may submit a student QR. Sets method / scannerRole / scannedBy / assurance on the context. */
  _authorizeScanner: function (c) {
    var sc = c.scanner;
    if (sc.kind === 'kiosk') {
      if (c.labId !== sc.kiosk.labId) fail('WRONG_LAB', 'This code is for a different lab.');
      c.method = 'kiosk'; c.scannerRole = 'kiosk'; c.scannedBy = sc.kiosk.authorizedEmail; c.kioskId = sc.kiosk.kioskId; c.assurance = 'standard';
      return;
    }
    var ctx = sc.ctx, s = Db.get('Sessions', c.sessionId);
    if (!s || s.labId !== c.labId) fail('SESSION_NOT_FOUND', 'Session not found.');
    c.method = 'scanner'; c.scannedBy = ctx.email;
    if (ctx.has('admin')) { c.scannerRole = 'admin'; c.assurance = 'high'; return; }
    if (ctx.has('staff')) { c.scannerRole = 'staff'; c.assurance = 'high'; return; }
    if (ctx.has('faculty') && Auth.ownsSession(ctx, s)) { c.scannerRole = 'faculty'; c.assurance = 'high'; return; }
    if (Events.isCoordinator(ctx, s)) { c.scannerRole = 'coordinator'; c.assurance = 'standard'; if (ctx.student && ctx.student.studentId === c.studentId) fail('SELF_SCAN', 'You cannot scan your own code.'); return; }
    if (ctx.student && ClassReps.isRepFor(ctx.student.studentId, s)) {
      if (!Settings.get('crScanningEnabled')) fail('NOT_SCANNER', 'Class representative scanning is switched off.');
      if (ctx.student.studentId === c.studentId) fail('SELF_SCAN', 'A class representative cannot scan their own code.');
      if (s.status !== 'open') fail('CR_SESSION_ENDED', 'Class representative scanning is only possible while the session is open.');
      c.scannerRole = 'cr'; c.assurance = 'standard';
      return;
    }
    fail('NOT_SCANNER', 'Only the teacher, lab staff, the event coordinator or the class representative of this session can scan student codes.');
  },

  _runB: function (c, actor, role) {
    c.mode = 'B';
    try {
      var res = Pipeline.run('B.scan', Attend.STEPS_B, c);
      Attend._afterAccept(c);
      return res;
    } catch (e) {
      if (e instanceof AppError) {
        Attend._afterReject(c, e, actor, role);
        if (c.student && c.student.name) e.extra = Object.assign({}, e.extra, { student: c.student.name });
      }
      throw e;
    }
  },

  /** Kiosk with a USB/Bluetooth scanner (or camera) reading student QR codes. */
  kioskScan: function (ctx, p) {
    V.obj(p);
    if (!ctx.kiosk) fail('FORBIDDEN', 'Only a registered kiosk can scan.');
    if (!Auth.rateLimit('scan|' + ctx.kiosk.kioskId, 150, 60)) fail('RATE_LIMITED', 'Scanner is going too fast. Wait a moment.');
    return Attend._runB({ input: p.qr, scanner: { kind: 'kiosk', kiosk: ctx.kiosk } }, ctx.kiosk.authorizedEmail, 'kiosk');
  },

  /** Teacher, staff, coordinator or class representative scanning on their own phone (in-app camera or a QR link). */
  phoneScan: function (ctx, p) {
    V.obj(p);
    if (!Auth.rateLimit('pscan|' + ctx.email, 120, 60)) fail('RATE_LIMITED', 'Scanning too fast. Wait a moment.');
    return Attend._runB({ input: p.qr, scanner: { kind: 'phone', ctx: ctx } }, ctx.email, ctx.roles[0] || 'user');
  },

  /** A photo for the scanner screen, only for an event this scanner recorded in the last two minutes. */
  scanPhoto: function (ctx, p) {
    V.obj(p);
    var ev = Db.mustGet('AttendanceEvents', V.id(p.eventId, 'Event', 'event'), 'Event');
    var mine = ctx.kiosk ? ev.kioskId === ctx.kiosk.kioskId : ev.scannedBy === ctx.email;
    if (!mine || U.now() - ev.at > 120000) fail('FORBIDDEN', 'This photo is no longer available on this screen.');
    var prof = Db.get('StudentProfiles', ev.studentId);
    if (!prof || !prof.photoFileId) return { dataUrl: null };
    Audit.tryLog({ actor: ctx.email, role: ctx.kiosk ? 'kiosk' : ctx.roles[0], action: 'photo.view', entityType: 'StudentProfile', entityId: prof.studentId, detail: { via: 'scan', eventId: ev.eventId } });
    return { dataUrl: 'data:image/jpeg;base64,' + Utilities.base64Encode(DriveApp.getFileById(prof.photoFileId).getBlob().getBytes()) };
  },

  /** Lab staff confirming who is at the desk before issuing a kit: the student shows their live QR. */
  STEPS_IDENTIFY: null, // built below from STEPS_B
  identify: function (ctx, p) {
    V.obj(p);
    var c = { input: p.qr, scanner: { kind: 'phone', ctx: ctx }, mode: 'B' };
    Pipeline.run('B.identify', Attend.STEPS_IDENTIFY, c);
    var st = c.student;
    Audit.tryLog({ actor: ctx.email, role: ctx.roles[0], action: 'student.identify', entityType: 'StudentProfile', entityId: st.studentId });
    return { student: Users._pubStudent(st) };
  },

  // ---- live views -----------------------------------------------------------------------------------------
  studentState: function (session, studentId) {
    var now = U.now(), eff = Attend._effective(Attend._eventsFor(session));
    var wins = Db.where('RescanWindows', function (w) { return w.sessionId === session.sessionId; });
    var c = Attend._compute(session, eff[studentId] || [], wins, now);
    var w = Attend.activeWindow(session.sessionId, now), done = w ? (eff[studentId] || []).some(function (e) { return e.type === 'RESCAN' && e.at >= w.openedAt; }) : false;
    return { state: c.state, firstIn: c.firstIn, lastOut: c.lastOut, lastIn: c.lastIn, status: c.status, verifiedMinutes: c.verifiedMinutes, flags: c.flags,
             work: Work.describe(Work.current(eff[studentId] || [])),
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
    var w = Attend.activeWindow(session.sessionId, now), lab = Db.cachedGet('Labs', 'labId', session.labId, 120) || {};
    var capacity = session.labEventId ? ((Db.get('Events', session.labEventId) || {}).capacity || lab.capacity) : lab.capacity;
    return { enrolled: eligible ? eligible.length : null, inside: inside, left: left, attended: seen, absent: eligible ? Math.max(0, eligible.length - seen) : null, flagged: flagged, unverifiedExits: unverified,
             rescanWindow: w ? { windowId: w.windowId, closesAt: w.closesAt } : null, capacity: capacity || null, overCapacity: !!capacity && inside > capacity, onBreak: Attend.inBreak(session, now), serverNow: now };
  },

  /** Live roster: every enrolled student plus anyone else who scanned in, with how they were checked in. */
  roster: function (ctx, p) {
    V.obj(p);
    var session = Db.mustGet('Sessions', V.id(p.sessionId, 'Session', 'session'), 'Session');
    if (!(Auth.canView(ctx) || Auth.canOperate(ctx, session))) fail('FORBIDDEN', 'This is not your session.');
    Auth.assertLab(ctx, session.labId);
    if (session.archivedAt) return Attend._archivedRoster(session);
    var now = U.now(), eff = Attend._effective(Attend._eventsFor(session)), wins = Db.where('RescanWindows', function (w) { return w.sessionId === session.sessionId; });
    var eligible = session.openToAll ? {} : Roster.eligibleSet(session), ids = Object.assign({}, eligible);
    Object.keys(eff).forEach(function (k) { ids[k] = true; });
    var profiles = U.indexBy(Db.readAll('StudentProfiles'), 'studentId');
    var checks = {}; Db.where('SpotChecks', function (c) { return c.sessionId === session.sessionId; }).forEach(function (c) { checks[c.studentId] = c; });
    var rows = Object.keys(ids).map(function (sid) {
      var pr = profiles[sid] || {}, c = Attend._compute(session, eff[sid] || [], wins, now), sc = checks[sid], le = c.lastEvent || {};
      return { studentId: sid, rollNo: pr.rollNo, name: pr.name, section: pr.section, enrolled: session.openToAll ? null : !!eligible[sid], state: c.state, firstIn: c.firstIn, lastOut: c.lastOut, status: c.status, flags: c.flags,
               verifiedMinutes: c.verifiedMinutes, spotCheck: sc ? sc.outcome : null, hasPhoto: !!pr.photoFileId,
               method: le.method || le.source || '', scannerRole: le.scannerRole || '', scannedBy: le.scannerRole === 'cr' || le.scannerRole === 'coordinator' ? le.scannedBy : '', geofence: le.geofence || '', assurance: le.assurance || '' };
    }).sort(function (a, b) { return String(a.rollNo) < String(b.rollNo) ? -1 : 1; });
    var openFlags = Db.where('Flags', function (f) { return f.sessionId === session.sessionId && f.status === 'open'; }).length;
    return { session: Sessions.pub(session, Sessions._ref()), counts: Attend.liveCounts(session), roster: rows, openFlags: openFlags, guests: session.labEventId ? Events.guestCount(session.labEventId) : 0, serverNow: now };
  },

  /** Roster of an archived session. Its scan-level events live in the archive, so this shows the stored summaries. */
  _archivedRoster: function (session) {
    var sums = Db.where('AttendanceSummaries', function (x) { return x.sessionId === session.sessionId; }), profiles = U.indexBy(Db.readAll('StudentProfiles'), 'studentId');
    var eligible = session.openToAll ? null : Roster.eligibleSet(session), seen = 0, flagged = 0, unverified = 0;
    var rows = sums.map(function (x) {
      var pr = profiles[x.studentId] || {};
      if (x.firstIn !== null && x.firstIn !== undefined) seen++;
      if (x.status === 'flagged' || x.status === 'missed_rescan') flagged++;
      if (x.status === 'unverified_exit') unverified++;
      return { studentId: x.studentId, rollNo: pr.rollNo, name: pr.name, section: pr.section, enrolled: eligible ? !!eligible[x.studentId] : null, state: x.firstIn === null || x.firstIn === undefined ? 'none' : 'out',
               firstIn: x.firstIn, lastOut: x.lastOut, status: x.status, flags: x.flags || [], verifiedMinutes: x.verifiedMinutes, spotCheck: null, hasPhoto: !!pr.photoFileId,
               method: '', scannerRole: '', scannedBy: '', geofence: '', assurance: '' };
    }).sort(function (a, b) { return String(a.rollNo) < String(b.rollNo) ? -1 : 1; });
    var enrolled = eligible ? Object.keys(eligible).length : null, now = U.now();
    return { session: Sessions.pub(session, Sessions._ref()), archived: true, roster: rows, openFlags: 0, serverNow: now, guests: session.labEventId ? Events.guestCount(session.labEventId) : 0,
             counts: { enrolled: enrolled, inside: 0, left: seen, attended: seen, absent: enrolled === null ? null : Math.max(0, enrolled - seen), flagged: flagged, unverifiedExits: unverified,
                       rescanWindow: null, capacity: null, overCapacity: false, onBreak: false, serverNow: now } };
  },

  // ---- rescan windows --------------------------------------------------------------------------------------
  openRescan: function (ctx, p) {
    V.obj(p);
    var seconds = V.int(p.seconds, 'Seconds', 30, 3600, { optional: true, def: Settings.get('rescanWindowSeconds') });
    return Locks.with(function () {
      var s = Db.mustGet('Sessions', V.id(p.sessionId, 'Session', 'session'), 'Session');
      if (!Auth.canOperate(ctx, s)) fail('FORBIDDEN', 'This is not your session.');
      if (s.status !== 'open') fail('INVALID_STATE', 'Rescans can only be requested while the session is open.');
      if (Attend.inBreak(s, U.now())) fail('INVALID_STATE', 'The session is on its break.');
      if (Attend.activeWindow(s.sessionId)) fail('CONFLICT', 'A rescan window is already open.');
      var w = Attend._startWindow(s, 'manual', ctx.email, seconds);
      Audit.log({ actor: ctx.email, role: Auth.operatorRole(ctx, s), action: 'rescan.open', entityType: 'Session', entityId: s.sessionId, detail: { seconds: seconds, windowId: w.windowId } });
      return { window: { windowId: w.windowId, closesAt: w.closesAt } };
    });
  },
  _startWindow: function (session, kind, by, seconds) {
    var now = U.now();
    var w = Db.insert('RescanWindows', { windowId: U.id('window'), sessionId: session.sessionId, kind: kind, openedAt: now, closesAt: now + seconds * 1000, openedBy: by, status: 'open' });
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
        if (Attend.inBreak(fresh, U.now())) { Db.update('Sessions', fresh.sessionId, { nextRescanAt: fresh.breakEnd + 5 * 60000 }); return; }
        var w = Attend._startWindow(fresh, 'random', 'system', Settings.get('rescanWindowSeconds'));
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
      if (s.archivedAt) fail('ARCHIVED', 'This session is archived and can no longer be corrected.');
      if (s.status !== 'open' && s.status !== 'closed') fail('INVALID_STATE', 'Corrections apply to opened sessions.');
      var studentId = V.id(p.studentId, 'Student', 'student');
      var student = Db.mustGet('StudentProfiles', studentId, 'Student');
      var now = U.now(), eff = Attend._effective(Attend._eventsFor(s)), cur = Attend._compute(s, eff[studentId] || [], [], now);
      var rec = { eventId: U.id('event'), sessionId: s.sessionId, labId: s.labId, studentId: studentId, source: 'manual', method: 'manual', scannedBy: ctx.email, scannerRole: ctx.roles[0], recordedBy: ctx.email, reason: reason, createdAt: now };
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
          if (at < cur.lastIn) fail('BAD_INPUT', 'An exit cannot be before the current entry.');
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
      if (action === 'add_in') { try { Flags.afterManual(studentId, s); } catch (e) { Syslog.warn('attend', 'FLAG_CHECK_FAILED', String(e && e.message)); } }
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
      var own = Db.get('Sessions', e.sessionId);
      if (own && own.archivedAt) fail('ARCHIVED', 'This session is archived and can no longer be changed.');
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
    // The scan-level events of an archived session are gone, so a rebuild would wipe its stored totals.
    if (s.archivedAt) fail('ARCHIVED', 'This session is archived. Its stored summary is final.');
    var events = Db.where('AttendanceEvents', function (e) { return e.sessionId === sessionId; });
    var eff = Attend._effective(events), wins = Db.where('RescanWindows', function (w) { return w.sessionId === sessionId; });
    var ids = s.openToAll ? {} : Roster.eligibleSet(s);
    Object.keys(eff).forEach(function (k) { ids[k] = true; });
    var create = [], updated = 0;
    Locks.with(function () {
      // Read the stored rows inside the lock: the archive deletes rows, and a row number read earlier could point at a different row.
      var existing = {}; Db.where('AttendanceSummaries', function (r) { return r.sessionId === sessionId; }).forEach(function (r) { existing[r.studentId] = r; });
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
    if (s.archivedAt) fail('ARCHIVED', 'This session is archived. Its events are in the archive spreadsheet, so it cannot be reconciled here.');
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
  /** Record a project or system change during a visit as a WORK event (task C3). */
  setWork: function (ctx, p) {
    V.obj(p);
    var sessionId = V.id(p.sessionId, 'Session', 'session'), entryId = V.id(p.entryEventId, 'Entry', 'event');
    var expected = V.id(p.expectedEventId, 'Work version', 'event'), id = p.eventId ? V.id(p.eventId, 'Event', 'event') : U.id('event');
    var projectId = p.projectId ? V.id(p.projectId, 'Project', 'project') : '', assetId = p.assetId ? V.id(p.assetId, 'System', 'asset') : '';
    return Locks.with(function () {
      ctx = Auth._contextForEmail(ctx.email, true); Auth.requireRole(ctx, ['student']);
      var student = Creds._requireVerifiedStudent(ctx), sid = student.studentId;
      var saved = Db.get('AttendanceEvents', id);
      if (saved) {
        if (saved.type !== 'WORK' || saved.studentId !== sid || saved.sessionId !== sessionId || saved.ref !== entryId || saved.projectId !== projectId || saved.assetId !== assetId) fail('CONFLICT', 'This work request id was already used.');
        return { work: Work.fromEvent(saved, entryId), replay: true };
      }
      var session = Db.mustGet('Sessions', sessionId, 'Session'), now = U.now();
      Attend._sessionGate(session, 'in', now);
      var lab = Db.mustGet('Labs', session.labId, 'Lab');
      if (lab.status !== 'active') fail('FORBIDDEN', 'This lab is not active.');
      var effective = Attend._effective(Attend._eventsFor(session)), current = Work.current(effective[sid] || []);
      if (!current || current.entryEventId !== entryId) fail('NO_ENTRY', 'This visit has ended. Refresh your sessions.');
      if (current.eventId !== expected) fail('CONFLICT', 'Your system or project changed. Refresh before saving.');
      Work.validate(sid, session, projectId, assetId, session.type === 'openlab');
      if (current.projectId === projectId && current.assetId === assetId) return { work: current, unchanged: true };
      var ev = Db.insert('AttendanceEvents', { eventId: id, sessionId: sessionId, labId: session.labId, studentId: sid, type: 'WORK',
        at: now, createdAt: now, source: 'student', recordedBy: ctx.email, approvalStatus: 'na', ref: entryId, projectId: projectId, assetId: assetId });
      Audit.log({ actor: ctx.email, role: 'student', action: 'attend.work', entityType: 'AttendanceEvent', entityId: id,
        detail: { sessionId: sessionId, entryEventId: entryId, projectId: projectId, assetId: assetId } });
      Occupancy.invalidate(session.labId);
      try { Booking.markUsed(sid, session.labId, now, assetId); } catch (e) { Syslog.warn('attend', 'BOOKING_MARK_FAILED', String(e && e.message)); }
      return { work: Work.fromEvent(ev, entryId) };
    });
  },
  myHistory: function (ctx, p) {
    Sessions.closeOpenLabsDue();
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
    var totals = { sessions: rows.length, present: 0, absent: 0, unverifiedExits: 0, autoSignOuts: 0, flagged: 0, verifiedMinutes: 0 };
    rows.forEach(function (r) { if ((r.flags || []).indexOf('auto_out') >= 0) totals.autoSignOuts++; if (r.status === 'present') totals.present++; if (r.status === 'absent') totals.absent++; if (r.status === 'unverified_exit') totals.unverifiedExits++; if (r.status === 'flagged' || r.status === 'missed_rescan') totals.flagged++; totals.verifiedMinutes += r.verifiedMinutes || 0; });
    totals.verifiedMinutes = Math.round(totals.verifiedMinutes);
    // Days used and time per lab for the student home (R10): a day counts when the student actually entered a lab.
    var usedDays = {}, perLab = {};
    rows.forEach(function (r) {
      if (!r.firstIn) return;
      var l = perLab[r.labName || 'Lab'] || (perLab[r.labName || 'Lab'] = { labName: r.labName || 'Lab', days: {}, visits: 0, verifiedMinutes: 0 });
      usedDays[r.date] = true; l.days[r.date] = true; l.visits++; l.verifiedMinutes += r.verifiedMinutes || 0;
    });
    totals.days = Object.keys(usedDays).length;
    totals.byLab = Object.keys(perLab).map(function (k) { var l = perLab[k]; return { labName: l.labName, days: Object.keys(l.days).length, visits: l.visits, verifiedMinutes: Math.round(l.verifiedMinutes) }; })
      .sort(function (a, b) { return b.verifiedMinutes - a.verifiedMinutes; });
    return { history: rows.slice(0, limit), totals: totals };
  },
  /** One student's raw events in one session, for the responsible faculty (or staff/admin), so an earlier scan can be voided with a reason. */
  studentEvents: function (ctx, p) {
    V.obj(p);
    var s = Db.mustGet('Sessions', V.id(p.sessionId, 'Session', 'session'), 'Session');
    if (!(Auth.canView(ctx) || Auth.ownsSession(ctx, s))) fail('FORBIDDEN', 'This is not your session.');
    Auth.assertLab(ctx, s.labId);
    var sid = V.id(p.studentId, 'Student', 'student');
    var evs = Db.where('AttendanceEvents', function (e) { return e.sessionId === s.sessionId && e.studentId === sid; }), voided = {};
    evs.forEach(function (e) { if (e.type === 'VOID' && e.approvalStatus !== 'rejected') voided[e.ref] = true; });
    return { archived: !!s.archivedAt, events: evs.filter(function (e) { return e.type !== 'DECISION'; }).map(function (e) { return { eventId: e.eventId, type: e.type, at: e.at, source: e.source, method: e.method, reason: e.reason, approvalStatus: e.approvalStatus, voided: !!voided[e.eventId] }; }).sort(function (a, b) { return a.at - b.at; }) };
  },
  /** One session's raw events for the student themselves (shows exceptions and corrections transparently). */
  myEvents: function (ctx, p) {
    V.obj(p);
    if (!ctx.student) return { events: [] };
    var sessionId = V.id(p.sessionId, 'Session', 'session'), sid = ctx.student.studentId, own = Db.get('Sessions', sessionId);
    return { archived: !!(own && own.archivedAt), events: Db.where('AttendanceEvents', function (e) { return e.sessionId === sessionId && e.studentId === sid && e.type !== 'DECISION'; })
      .map(function (e) { return { type: e.type, at: e.at, source: e.source, method: e.method, reason: e.source === 'manual' ? e.reason : '', approvalStatus: e.approvalStatus }; }).sort(function (a, b) { return a.at - b.at; }) };
  }
};

/** Identification at the lab desk: the device checks of Version B without the session and attendance steps. */
Attend.STEPS_IDENTIFY = Attend.STEPS_B.filter(function (s) { return ['payload', 'token_mac', 'nonce_fresh', 'qr_fresh', 'device_active', 'student_verified', 'signature'].indexOf(s.id) >= 0; });

/** Project/system metadata is derived from effective IN/WORK/OUT events, independently of attendance minutes. */
var Work = {
  fromEvent: function (e, entryId) { return { entryEventId: entryId, eventId: e.eventId, projectId: e.projectId || '', assetId: e.assetId || '' }; },
  current: function (events) {
    var current = null;
    (events || []).forEach(function (e) {
      if ((e.type === 'IN' || e.type === 'CORR_IN') && !current) current = Work.fromEvent(e, e.eventId);
      else if ((e.type === 'OUT' || e.type === 'CORR_OUT') && current) current = null;
      else if (e.type === 'WORK' && current && e.ref === current.entryEventId) current = Work.fromEvent(e, current.entryEventId);
    });
    return current;
  },
  describe: function (work) {
    if (!work) return null;
    var project = work.projectId && Db.get('Projects', work.projectId), asset = work.assetId && Db.get('Assets', work.assetId);
    return Object.assign({}, work, { projectTitle: project ? project.title : '', assetName: asset ? asset.name : '' });
  },
  occupants: function (labId) {
    var result = [];
    Db.where('Sessions', function (s) { return s.labId === labId && s.status === 'open'; }).forEach(function (s) {
      var effective = Attend._effective(Attend._eventsFor(s));
      Object.keys(effective).forEach(function (sid) {
        var work = Work.current(effective[sid]);
        if (work && work.assetId) result.push({ sessionId: s.sessionId, studentId: sid, assetId: work.assetId });
      });
    });
    return result;
  },
  isSystem: function (asset) {
    var cat = asset && Db.get('Categories', asset.categoryId);
    return !!(asset && asset.trackingMode === 'individual' && cat && cat.workstation === true);
  },
  _mine: function (studentId, r) {
    if (r.requesterType === 'student') return r.requesterId === studentId;
    var group = r.requesterType === 'group' && Db.get('Groups', r.requesterId);
    return !!(group && group.status === 'active' && Db.whereEq('GroupMembers', { groupId: group.groupId, studentId: studentId }).length);
  },
  _reservations: function (labId, now) {
    return Db.where('Reservations', function (r) { return r.labId === labId && r.resourceType === 'asset' && Booking._holds(r) &&
      r.startAt - Checkin.BOOKING_EARLY_MS <= now && now < r.endAt; });
  },
  booked: function (studentId, labId, now) {
    return Work._reservations(labId, now).filter(function (r) { return r.status === 'approved' && Work._mine(studentId, r) && Work.isSystem(Db.get('Assets', r.resourceId)); })
      .sort(function (a, b) { return a.startAt - b.startAt || a.reservationId.localeCompare(b.reservationId); });
  },
  reservedSystem: function (session) {
    if (String(session.slotKey || '').indexOf('rsv|') !== 0) return '';
    var r = Db.get('Reservations', session.slotKey.slice(4));
    return r && r.resourceType === 'asset' && Work.isSystem(Db.get('Assets', r.resourceId)) ? r.resourceId : '';
  },
  choices: function (studentId, labId, now, sessionId) {
    var projects = Db.where('Projects', function (p) { return p.labId === labId && Projects.usableBy(studentId, p.projectId); })
      .map(function (p) { return { projectId: p.projectId, title: p.title, status: p.status }; });
    var busy = Work.occupants(labId), reservations = Work._reservations(labId, now), booked = Work.booked(studentId, labId, now);
    var systems = Db.whereEq('Assets', { labId: labId }).filter(Work.isSystem).map(function (a) {
      var occupied = busy.some(function (x) { return x.assetId === a.assetId && !(x.studentId === studentId && x.sessionId === sessionId); });
      var held = reservations.some(function (r) { return r.resourceId === a.assetId && !(r.status === 'approved' && Work._mine(studentId, r)); });
      return { assetId: a.assetId, name: a.name, assetTag: a.assetTag,
        status: a.status !== 'available' || a.condition === 'damaged' ? 'unavailable' : occupied ? 'busy' : held ? 'booked' : 'free' };
    });
    return { projects: projects, systems: systems, bookedAssetIds: U.uniq(booked.map(function (r) { return r.resourceId; })) };
  },
  validate: function (studentId, session, projectId, assetId, requireProject) {
    if (requireProject && !projectId) fail('BAD_INPUT', 'Choose a project for this open-lab visit.');
    if (projectId) {
      var project = Db.get('Projects', projectId);
      if (!project || project.labId !== session.labId || !Projects.usableBy(studentId, projectId)) fail('NOT_ELIGIBLE', 'Choose your own pending or active project in this lab.');
    }
    var now = U.now(), booked = Work.booked(studentId, session.labId, now);
    var exact = Work.reservedSystem(session);
    if (exact && !booked.some(function (r) { return r.reservationId === session.slotKey.slice(4); })) fail('NOT_ELIGIBLE', 'This workstation booking is no longer active.');
    if (exact && exact !== assetId) fail('BOOKED_SYSTEM_REQUIRED', 'Use the exact system selected for this booking.');
    if (booked.length && !booked.some(function (r) { return r.resourceId === assetId; })) fail('BOOKED_SYSTEM_REQUIRED', 'Use one of your currently booked systems.');
    if (!assetId) return;
    var asset = Db.get('Assets', assetId);
    if (!Work.isSystem(asset) || asset.labId !== session.labId || asset.status !== 'available' || asset.condition === 'damaged') fail('NOT_AVAILABLE', 'Choose an available workstation in this lab.');
    if (Work.occupants(session.labId).some(function (x) { return x.assetId === assetId && !(x.studentId === studentId && x.sessionId === session.sessionId); })) fail('SYSTEM_BUSY', 'That system is in use. Choose another system or your own laptop.');
    if (Work._reservations(session.labId, now).some(function (r) { return r.resourceId === assetId && !(r.status === 'approved' && Work._mine(studentId, r)); })) fail('NOT_AVAILABLE', 'That system is reserved for another visit.');
  }
};
