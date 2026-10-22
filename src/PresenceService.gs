/**
 * PresenceService.gs - tier 3, the LABFLOW phone app (Android), plus the random location checks of tier 1.
 *
 * The three tiers of proxy protection:
 *   1  kiosk QR + browser GPS (CheckinService.gs). While the student's page stays open, it also reports the location
 *      at random times the server picks (presence.webPing). A browser stops when the screen locks, so this is weak.
 *   2  device-signed student QR scanned in the room (AttendanceService.gs, Version B).
 *   3  the phone app: it scans the same kiosk code, then reports the phone's location every few minutes until the
 *      session ends (a foreground service, so it keeps going with the screen locked), and asks for a fingerprint at
 *      random times. The faculty choose it per session (Sessions.checkinMode 'C').
 *
 * Keys. When the app is linked it makes two P-256 keys in the Android Keystore; the server stores only the public
 * halves (DeviceCredentials, kind 'app'). The device key signs every scan and report. The fingerprint key can only be
 * used after a strong biometric (no PIN fallback), so a valid signature from it proves a fingerprint was given on that
 * phone. One active app phone per student; a switch waits for faculty, coordinator or super admin approval.
 *
 * Nothing here refuses a student for a location problem. Faked, jumping or frozen locations, replayed or tampered
 * reports, a missing app (an iPhone) or an old kiosk code are recorded and raised as flags. In a phone-app session any
 * open flag makes the result Flagged, and the faculty decide (dismiss the flag, or override the result).
 *
 * Result of a phone-app session, per student (derived, never stored as truth; Presence.decorate):
 *   Present  checked in, at the lab for presentCoveragePct of the session, every fingerprint check passed, no open flag
 *   Partial  checked in, but a fingerprint check was missed or failed, or at the lab for less than presentCoveragePct
 *   Absent   never checked in, or at the lab for less than absentCoveragePct
 *   Flagged  an open flag; the faculty decide
 * The faculty can override any result (an OVERRIDE event, audited).
 *
 * Privacy (FR-31): reports keep the distance to the lab, the reported accuracy and a short hash of the exact reading
 * (to spot a location that never changes). Latitude and longitude are never stored.
 */
var Presence = {
  PAIR_MINUTES: 5,
  MAX_BATCH: 200,
  FUTURE_MS: 2 * 60000,

  // ---- linking the app ---------------------------------------------------------------------------------------
  /** The signed-in web app makes a single-use code; the phone app trades it for its own session (app.link). */
  pairCode: function (ctx) {
    var st = Creds._requireVerifiedStudent(ctx);
    var exp = Math.floor(U.now() / 1000) + Presence.PAIR_MINUTES * 60;
    var token = Tokens.make(['ap', st.studentId, Tokens.nonce(), String(exp)]);
    return { token: token, link: 'labflow://pair?t=' + encodeURIComponent(token), expiresAt: exp * 1000 };
  },

  /**
   * Session-free (doPost). The app sends the pairing code, its two public keys and a signature of the code with each
   * (the fingerprint key's signature means a fingerprint was given while linking). The first app phone is active at
   * once; any later one waits for approval, and until then its check-ins are flagged.
   */
  link: function (p) {
    V.obj(p);
    if (!Auth.rateLimit('applink|all', 120, 60)) fail('RATE_LIMITED', 'Too many requests. Try again in a minute.');
    var parts = Tokens.parse(p.token, 'ap', 4);
    if (U.now() / 1000 > Number(parts[3])) fail('EXPIRED', 'This link code has expired. Make a new one in LABFLOW on the web.');
    var key = function (v, n) { return V.str(v, n, { max: 120, re: /^[A-Za-z0-9_-]+$/ }); };
    var publicKey = key(p.publicKey, 'Public key'), bioPublicKey = key(p.bioPublicKey, 'Fingerprint key');
    var label = V.str(p.label, 'Phone name', { optional: true, max: 60, def: 'Phone app' });
    if (!Creds.verifySignature(publicKey, p.token, key(p.sig, 'Signature')) || !Creds.verifySignature(bioPublicKey, p.token, key(p.bioSig, 'Fingerprint signature'))) {
      fail('BAD_SIGNATURE', 'The phone could not prove it holds its keys. Try linking again.');
    }
    return Locks.with(function () {
      if (Tokens.wasRedeemed(parts[2])) fail('REPLAY', 'This link code was already used. Make a new one.');
      var st = Attend._verifiedStudent(parts[1]), user = Db.get('Users', st.userId);
      var mine = Db.whereEq('DeviceCredentials', { studentId: st.studentId }).filter(function (c) { return c.kind === 'app'; });
      var active = mine.filter(function (c) { return c.status === 'active'; }), now = U.now();
      // A newer request replaces an older pending one (a reinstall makes new keys).
      mine.forEach(function (c) { if (c.status === 'pending_approval') Db.update('DeviceCredentials', c.credentialId, { status: 'revoked', revokedAt: now, revokedBy: user.email, revokeReason: 'superseded by a newer link request' }); });
      var needsApproval = mine.length > 0;
      var cred = Db.insert('DeviceCredentials', {
        credentialId: U.id('cred'), studentId: st.studentId, userEmail: user.email, publicKey: publicKey, alg: 'ES256', label: label,
        status: needsApproval ? 'pending_approval' : 'active', replacesCredentialId: needsApproval && active.length ? active[0].credentialId : '',
        createdAt: now, approvedBy: needsApproval ? '' : 'auto-first-device', approvedAt: needsApproval ? null : now, kind: 'app', bioPublicKey: bioPublicKey
      });
      Tokens.redeem(parts[2], 'P', st.studentId, '', '', cred.credentialId);
      Audit.log({ actor: user.email, role: 'student', action: needsApproval ? 'app.link_request' : 'app.link', entityType: 'DeviceCredential', entityId: cred.credentialId,
                  detail: { studentId: st.studentId, label: label, replaces: cred.replacesCredentialId } });
      if (needsApproval) Notify.toRole('staff', 'device', 'Phone app switch request', st.name + ' (' + st.rollNo + ') linked a new phone. Faculty or the lab desk can approve it after checking the student.', 'cred:' + cred.credentialId);
      var s = Auth._issueSession(user.email);
      return { session: s.session, email: user.email, expiresAt: s.expiresAt, credentialId: cred.credentialId, status: cred.status,
               student: { name: st.name, rollNo: st.rollNo } };
    });
  },

  /** The calling student's app credential. Revoked or replaced keys are dead; a pending one works but is flagged. */
  _appCred: function (ctx, credentialId) {
    var st = Creds._requireVerifiedStudent(ctx);
    var cred = Db.get('DeviceCredentials', V.id(credentialId, 'Phone', 'cred'));
    if (!cred || cred.studentId !== st.studentId || cred.kind !== 'app') fail('NO_DEVICE', 'This phone is not linked to you. Link it again from LABFLOW on the web.');
    if (cred.status !== 'active' && cred.status !== 'pending_approval') fail('NO_DEVICE', 'This phone was unlinked. Link it again from LABFLOW on the web.');
    return { student: st, cred: cred };
  },

  /** App home screen: the phone's link status and the session the student is in now, if any. */
  status: function (ctx, p) {
    V.obj(p);
    var a = Presence._appCred(ctx, p.credentialId), now = U.now(), inside = null;
    Db.where('Sessions', function (s) { return s.status === 'open'; }).some(function (s) {
      var st = Attend.studentState(s, a.student.studentId);
      if (st.state !== 'in') return false;
      inside = Presence._tracking(s, st, now);
      return true;
    });
    return { student: { name: a.student.name, rollNo: a.student.rollNo }, device: { credentialId: a.cred.credentialId, status: a.cred.status, label: a.cred.label },
             inside: inside, pingSeconds: Settings.get('appPingSeconds'), serverNow: now };
  },
  _tracking: function (s, st, now) {
    var lab = Db.cachedGet('Labs', 'labId', s.labId, 120) || {};
    return { sessionId: s.sessionId, title: s.title, labCode: lab.code, since: st.lastIn || st.firstIn, endsAt: s.scheduledEnd,
             track: Sessions.isApp(s, lab) && s.status === 'open' && now < s.scheduledEnd, pingSeconds: Settings.get('appPingSeconds') };
  },

  // ---- tier 3 check-in: the app scans the kiosk code ----------------------------------------------------------
  /** Signed message: c1|<kiosk code>|<in|out>|<phone time ms>|<lat>|<lng>|<accuracy m>|<mock 0/1> */
  STEPS_C: null, // built below from Checkin.STEPS_OPEN and Checkin.STEPS_A
  appScan: function (ctx, p) {
    V.obj(p);
    var c = { ctx: ctx, mode: 'C', appFlags: [], sessionId: p.sessionId ? V.id(p.sessionId, 'Session', 'session') : '',
      reservationId: p.reservationId ? V.id(p.reservationId, 'Booking', 'reservation') : '',
      projectId: p.projectId ? V.id(p.projectId, 'Project', 'project') : '', assetId: p.assetId ? V.id(p.assetId, 'System', 'asset') : '',
      message: V.str(p.m, 'Check-in', { max: 400 }), sig: V.str(p.sig, 'Signature', { max: 120, re: /^[A-Za-z0-9_-]+$/ }), credentialId: p.credentialId };
    try {
      var res = Pipeline.run('C.checkin', Presence.STEPS_C, c);
      Attend._afterAccept(c);
      return Object.assign(res, { tracking: Presence._tracking(c.session, Attend.studentState(c.session, c.studentId), U.now()), flagged: c.appFlags.map(function (f) { return f.type; }).concat(c.geoFlag ? [c.geoFlag] : []) });
    } catch (e) {
      if (e instanceof AppError) Attend._afterReject(c, e, ctx.email, 'student');
      throw e;
    }
  },

  /** Where a reading puts the phone. Lab without coordinates: cannot be checked, counted as at the lab. */
  _place: function (lab, lat, lng, acc) {
    if (!Labs.hasGeofence(lab)) return { inLab: true, distanceM: null };
    var d = U.haversineM(lat, lng, lab.latitude, lab.longitude), allowance = Math.min(acc, Settings.get('gpsAccuracyAllowanceM'));
    return { inLab: d - allowance <= Labs.radiusOf(lab) + Settings.get('appRadiusSlackM'), distanceM: Math.round(d * 10) / 10 };
  },
  /** Fields of a signed app message, or null. Numbers stay as the strings that were signed. */
  _fields: function (m, kind, n) {
    var f = String(m).split('|');
    return f.length === n && f[0] === kind ? f : null;
  },
  _reading: function (lat, lng, acc) {
    if (lat === '' || lng === '') return null;
    var a = Number(lat), b = Number(lng), r = Number(acc);
    if (!isFinite(a) || !isFinite(b) || !isFinite(r) || a < -90 || a > 90 || b < -180 || b > 180 || r < 0) return null;
    return { lat: a, lng: b, acc: r, key: U.sha256Hex(lat + '|' + lng + '|' + acc).slice(0, 12) };
  },

  // ---- presence reports from the app --------------------------------------------------------------------------
  /**
   * A batch of signed reports (the app queues them while offline and sends them in order when it can).
   * Report: p1|<sessionId>|<seq>|<phone time ms>|<lat>|<lng>|<accuracy m>|<mock 0/1>  (lat/lng empty = no fix)
   * Returns when to report next, whether to keep tracking, and a fingerprint check to show, if one is due.
   */
  ping: function (ctx, p) {
    V.obj(p);
    var a = Presence._appCred(ctx, p.credentialId), sid = a.student.studentId, now = U.now();
    var list = V.arr(p.pings || [], 'Reports', Presence.MAX_BATCH), bySession = {}, flags = [];
    var raise = function (type, sessionId, detail) { flags.push({ type: type, sessionId: sessionId, detail: detail }); };
    list.forEach(function (x) {
      var m = x && typeof x.m === 'string' && x.m.length <= 300 ? x.m : '', f = Presence._fields(m, 'p1', 8);
      var sessionId = f && /^SES-[0-9A-F]{12}$/.test(f[1]) ? f[1] : '';
      if (!f || !sessionId || typeof x.sig !== 'string' || !Creds.verifySignature(a.cred.publicKey, m, x.sig)) { raise('tampered_report', sessionId, { what: 'presence report' }); return; }
      (bySession[sessionId] = bySession[sessionId] || []).push({ seq: Number(f[2]), at: Number(f[3]), reading: Presence._reading(f[4], f[5], f[6]), mock: f[7] === '1' });
    });
    var stored = 0, rebuild = [], track = false, challenge = null;
    Object.keys(bySession).forEach(function (sessionId) {
      var s = Db.get('Sessions', sessionId);
      if (!s) return;
      var lab = Db.cachedGet('Labs', 'labId', s.labId, 120) || {}, prior = Presence._pingsFor(s).filter(function (q) { return q.studentId === sid; });
      var seen = {}; prior.forEach(function (q) { if (q.credentialId === a.cred.credentialId) seen[q.seq] = true; });
      var from = (s.openedAt || s.scheduledStart) - 5 * 60000, to = Math.max(s.scheduledEnd, s.closedAt || 0) + 30 * 60000, rows = [];
      bySession[sessionId].forEach(function (r) {
        if (!isFinite(r.seq) || !isFinite(r.at)) { raise('tampered_report', sessionId, { what: 'presence report' }); return; }
        if (seen[r.seq]) { raise('replayed_report', sessionId, { seq: r.seq }); return; }
        seen[r.seq] = true;
        var verdict = 'ok', place = r.reading ? Presence._place(lab, r.reading.lat, r.reading.lng, r.reading.acc) : null;
        if (r.at > now + Presence.FUTURE_MS) { verdict = 'clock'; raise('clock_skew', sessionId, { aheadSeconds: Math.round((r.at - now) / 1000) }); }
        else if (r.at < from || r.at > to) verdict = 'outside_session';
        else if (!r.reading) verdict = 'nofix';
        else if (r.mock) { verdict = 'mock'; raise('mock_location', sessionId, { at: r.at }); }
        else if (r.reading.acc < Settings.get('minPlausibleAccuracyM')) { verdict = 'implausible'; raise('implausible_location', sessionId, { accuracyM: r.reading.acc }); }
        rows.push({ pingId: U.id('ping'), sessionId: sessionId, studentId: sid, credentialId: a.cred.credentialId, source: 'app', seq: r.seq, at: r.at, receivedAt: now,
          inLab: verdict === 'ok' && !!place && place.inLab, distanceM: place ? place.distanceM : null, accuracyM: r.reading ? Math.round(r.reading.acc * 10) / 10 : null,
          mock: r.mock, posKey: r.reading ? r.reading.key : '', verdict: verdict });
      });
      if (a.cred.status !== 'active' && rows.length) raise('unapproved_device', sessionId, { credentialId: a.cred.credentialId });
      if (rows.length) { Db.insertMany('PresencePings', rows); stored += rows.length; }
      Presence._detect(prior.concat(rows), sessionId, raise);
      if (s.status === 'closed' && rows.length) rebuild.push(sessionId);
      if (s.status === 'open') {
        var st = Attend.studentState(s, sid);
        if (st.state === 'in' && Sessions.isApp(s, lab) && now < s.scheduledEnd) {
          track = true;
          if (!challenge) challenge = Presence._deliver(s, sid, st, now);
        }
      }
    });
    flags.forEach(function (f) {
      var s = f.sessionId ? Db.get('Sessions', f.sessionId) : null;
      try { Flags.raise(f.type, { studentId: sid, sessionId: f.sessionId || '', labId: s ? s.labId : '', detail: f.detail, dedupeKey: f.type + '|' + sid + '|' + (f.sessionId || U.local(now).date) }); }
      catch (e) { Syslog.warn('presence', 'FLAG_FAILED', String(e && e.message)); }
    });
    rebuild.forEach(function (id) { try { Attend.rebuildSummary(id); } catch (e) { Syslog.warn('presence', 'REBUILD_FAILED', String(e && e.message)); } });
    return { stored: stored, next: Settings.get('appPingSeconds'), track: track, challenge: challenge, serverNow: now };
  },

  /** Impossible jumps and a location that never changes, over one student's reports in one session. */
  _detect: function (pings, sessionId, raise) {
    var fixes = pings.filter(function (q) { return q.verdict === 'ok' && q.distanceM !== null && q.distanceM !== undefined; }).sort(function (x, y) { return x.at - y.at; });
    var kmh = Settings.get('maxTravelSpeedKmh'), run = 1, need = Settings.get('frozenPings');
    for (var i = 1; i < fixes.length; i++) {
      var a = fixes[i - 1], b = fixes[i], dt = (b.at - a.at) / 1000;
      // Distance to the lab is all that is kept, so the change in it is a lower bound on how far the phone moved.
      var moved = Math.abs(b.distanceM - a.distanceM) - (a.accuracyM || 0) - (b.accuracyM || 0);
      if (dt > 0 && moved > 50 && moved / dt * 3.6 > kmh) raise('location_jump', sessionId, { metres: Math.round(moved), seconds: Math.round(dt), kmh: Math.round(moved / dt * 3.6) });
      run = a.posKey && a.posKey === b.posKey ? run + 1 : 1;
      if (run === need) raise('frozen_location', sessionId, { reports: run });
    }
  },

  /** Reports for a session. An open session reads only the recent tail of the sheet. */
  _pingsFor: function (session) {
    if (session.status !== 'open') return Db.where('PresencePings', function (q) { return q.sessionId === session.sessionId; });
    var cutoff = (session.openedAt || session.scheduledStart) - 60000, n = 500, rows;
    for (;;) {
      rows = Db.tail('PresencePings', n);
      if (rows.length < n || (rows.length && rows[0].receivedAt < cutoff)) break;
      n *= 4;
    }
    return rows.filter(function (q) { return q.sessionId === session.sessionId; });
  },

  // ---- tier 1: random location checks from the open web page --------------------------------------------------
  /** The page sends a reading (or why it has none); the reply says when, at random, to send the next one. */
  webPing: function (ctx, p) {
    V.obj(p);
    var st = Creds._requireVerifiedStudent(ctx), now = U.now();
    var s = Db.mustGet('Sessions', V.id(p.sessionId, 'Session', 'session'), 'Session');
    var state = s.status === 'open' ? Attend.studentState(s, st.studentId) : null;
    if (!state || state.state !== 'in') return { next: null };
    var lab = Db.cachedGet('Labs', 'labId', s.labId, 120) || {}, g = p.geo && typeof p.geo === 'object' ? p.geo : null, place = null, acc = null;
    if (g) { var ll = V.latLng(g.lat, g.lng); acc = V.num(g.accuracy, 'Accuracy', 0, 100000); place = Presence._place(lab, ll.lat, ll.lng, acc); }
    Db.insert('PresencePings', { pingId: U.id('ping'), sessionId: s.sessionId, studentId: st.studentId, credentialId: '', source: 'web', seq: 0, at: now, receivedAt: now,
      inLab: !!place && place.inLab, distanceM: place ? place.distanceM : null, accuracyM: acc === null ? null : Math.round(acc * 10) / 10, mock: false, posKey: '', verdict: place ? 'ok' : 'nofix' });
    if (place && !place.inLab) Flags.raise('away_from_lab', { studentId: st.studentId, sessionId: s.sessionId, labId: s.labId, detail: { distanceM: place.distanceM, band: U.distanceBand(place.distanceM) }, dedupeKey: 'away|' + st.studentId + '|' + s.sessionId });
    if (!place) Flags.raise('no_location', { studentId: st.studentId, sessionId: s.sessionId, labId: s.labId, detail: { during: 'random location check' }, dedupeKey: 'noloc|' + st.studentId + '|' + s.sessionId });
    var lo = Settings.get('webPingMinSeconds'), hi = Math.max(lo, Settings.get('webPingMaxSeconds'));
    return { next: lo + U.randInt(hi - lo + 1), inLab: place ? place.inLab : null };
  },

  // ---- fingerprint checks -------------------------------------------------------------------------------------
  /**
   * The random check times of one student in one session, from an HMAC of the server secret: nothing is stored, the
   * student cannot predict them, and each student gets different times. With two checks the first falls in 15-40 %
   * of the session and the second in 60-85 %, so they are never at the start or end and always at least 20 % apart.
   */
  slots: function (session, studentId) {
    var n = Settings.get('bioChecksPerSession'), S = session.scheduledStart, span = session.scheduledEnd - S;
    if (!n || span < 20 * 60000) return [];
    var b = U.b64uDecode(U.hmacB64u(Tokens._secret(), 'bio|' + session.sessionId + '|' + studentId));
    var f = function (i) { return (b[i] * 256 + b[i + 1]) / 65536; };
    if (n === 1) return [{ key: 'r1', at: Math.round(S + span * (0.2 + 0.6 * f(0))) }];
    return [{ key: 'r1', at: Math.round(S + span * (0.15 + 0.25 * f(0))) }, { key: 'r2', at: Math.round(S + span * (0.6 + 0.25 * f(2))) }];
  },
  _bioRows: function (sessionId) { return Db.where('BioChecks', function (r) { return r.sessionId === sessionId; }); },
  _challenge: function (r) { return { bioId: r.bioId, message: 'b1|' + r.bioId + '|' + r.nonce, deadline: r.deadline, kind: r.kind }; },

  /** A check that is due for this student now (delivered once; its time to answer starts now). */
  _deliver: function (session, sid, st, now) {
    var rows = Presence._bioRows(session.sessionId), mine = {}, since = st.lastIn || st.firstIn;
    rows.forEach(function (r) { if (r.studentId === sid) mine[r.slotKey] = r; });
    var open = Object.keys(mine).map(function (k) { return mine[k]; }).filter(function (r) { return r.outcome === 'pending' && now <= r.deadline; })[0];
    if (open) return Presence._challenge(open);
    var due = Presence.slots(session, sid).map(function (x) { return { key: session.sessionId + '|' + sid + '|' + x.key, kind: 'random', at: x.at }; })
      .concat(rows.filter(function (r) { return r.studentId === '*'; }).map(function (r) { return { key: session.sessionId + '|' + sid + '|' + r.bioId, kind: 'teacher', at: r.dueAt, by: r.requestedBy }; }))
      .filter(function (x) { return x.at <= now && x.at >= since && !mine[x.key]; }).sort(function (x, y) { return x.at - y.at; })[0];
    if (!due) return null;
    try {
      var rec = Db.insert('BioChecks', { bioId: U.id('bio'), slotKey: due.key, sessionId: session.sessionId, studentId: sid, kind: due.kind, dueAt: due.at, deliveredAt: now,
        deadline: now + Settings.get('bioResponseSeconds') * 1000, respondedAt: null, outcome: 'pending', requestedBy: due.by || 'random', nonce: Tokens.nonce() });
      return Presence._challenge(rec);
    } catch (e) { if (e && e.code === 'DUPLICATE') return null; throw e; }
  },

  /** The app answers with the fingerprint key's signature of the challenge. A PIN cannot unlock that key. */
  bioRespond: function (ctx, p) {
    V.obj(p);
    var a = Presence._appCred(ctx, p.credentialId), now = U.now();
    var sig = V.str(p.sig, 'Signature', { max: 120, re: /^[A-Za-z0-9_-]+$/ });
    return Locks.with(function () {
      var r = Db.mustGet('BioChecks', V.id(p.bioId, 'Fingerprint check', 'bio'), 'Fingerprint check');
      if (r.studentId !== a.student.studentId) fail('FORBIDDEN', 'This check is not yours.');
      if (r.outcome !== 'pending') return { outcome: r.outcome };
      var ok = !!a.cred.bioPublicKey && Creds.verifySignature(a.cred.bioPublicKey, 'b1|' + r.bioId + '|' + r.nonce, sig);
      var outcome = !ok ? 'failed' : now > r.deadline ? 'late' : 'passed';
      Db.update('BioChecks', r.bioId, { outcome: outcome, respondedAt: now });
      if (!ok) { var s = Db.get('Sessions', r.sessionId) || {}; Flags.raise('tampered_report', { studentId: r.studentId, sessionId: r.sessionId, labId: s.labId || '', detail: { what: 'fingerprint answer' }, dedupeKey: 'tampered_report|' + r.studentId + '|' + r.sessionId }); }
      return { outcome: outcome };
    });
  },

  /** The faculty ask everyone inside for a fingerprint now. Each phone gets it with its next report. */
  bioNow: function (ctx, p) {
    V.obj(p);
    var s = Db.mustGet('Sessions', V.id(p.sessionId, 'Session', 'session'), 'Session');
    if (!Auth.canOperate(ctx, s)) fail('FORBIDDEN', 'This is not your session.');
    if (s.status !== 'open') fail('INVALID_STATE', 'Fingerprint checks can only be requested while the session is open.');
    if (!Sessions.isApp(s)) fail('MODE_DISABLED', 'Fingerprint checks need a phone-app session (tier 3).');
    var now = U.now();
    var r = Db.insert('BioChecks', { bioId: U.id('bio'), slotKey: s.sessionId + '|*|' + now, sessionId: s.sessionId, studentId: '*', kind: 'teacher', dueAt: now, deliveredAt: null,
      deadline: null, respondedAt: null, outcome: 'class', requestedBy: ctx.email, nonce: '' });
    Audit.log({ actor: ctx.email, role: Auth.operatorRole(ctx, s), action: 'bio.request', entityType: 'Session', entityId: s.sessionId, detail: { bioId: r.bioId } });
    return { bioId: r.bioId, at: now, reachWithinSeconds: Settings.get('appPingSeconds') };
  },

  // ---- results ------------------------------------------------------------------------------------------------
  /** Everything a phone-app session's results need, read once. */
  load: function (session) {
    var pings = U.groupBy(Presence._pingsFor(session), function (q) { return q.studentId; });
    var rows = Presence._bioRows(session.sessionId), bio = U.groupBy(rows.filter(function (r) { return r.studentId !== '*'; }), function (r) { return r.studentId; });
    var flags = U.groupBy(Db.where('Flags', function (f) { return f.sessionId === session.sessionId && f.status === 'open'; }), function (f) { return f.studentId; });
    return { pings: pings, bio: bio, classChecks: rows.filter(function (r) { return r.studentId === '*'; }), flags: flags };
  },

  /** Stints [in, out] from the effective events (OUT ends one; CORR_* count as faculty-confirmed). */
  _stints: function (evts, end) {
    var out = [], cur = null;
    evts.forEach(function (e) {
      if ((e.type === 'IN' || e.type === 'CORR_IN') && !cur) cur = { from: e.at, to: end, inLab: e.type === 'CORR_IN' || (e.geofence !== 'fail' && e.assurance !== 'flagged') };
      else if ((e.type === 'OUT' || e.type === 'CORR_OUT') && cur) { cur.to = Math.min(e.at, end); out.push(cur); cur = null; }
    });
    if (cur) out.push(cur);
    return out;
  },

  /**
   * Phone-app result for one student. Sets c.status (unless the faculty overrode it) and returns what the live view
   * shows: last report, at the lab now, % of the session at the lab, fingerprint checks and open flags.
   */
  decorate: function (session, data, sid, evts, c, now) {
    var S = Math.max(session.scheduledStart, session.openedAt || 0), E = Math.min(session.scheduledEnd, session.closedAt || Infinity, now);
    var cap = 2 * Settings.get('appPingSeconds') * 1000 + 60000, grace = cap + Settings.get('bioResponseSeconds') * 1000;
    var pings = (data.pings[sid] || []).filter(function (q) { return q.verdict !== 'outside_session' && q.verdict !== 'clock'; }).sort(function (a, b) { return a.at - b.at; });
    var stints = Presence._stints(evts, E), credit = 0;
    stints.forEach(function (st) {
      var pts = [{ at: st.from, inLab: st.inLab }].concat(pings.filter(function (q) { return q.at >= st.from && q.at <= st.to; }));
      pts.forEach(function (q, i) {
        if (!q.inLab) return;
        var a = Math.max(q.at, S), b = Math.min(i + 1 < pts.length ? pts[i + 1].at : st.to, st.to, q.at + cap, E);
        if (b > a) credit += b - a;
      });
    });
    var pct = E > S ? Math.min(100, Math.round(100 * credit / (E - S))) : null;
    var inside = function (t) { return stints.some(function (st) { return t >= st.from && t <= st.to; }); };
    var mine = U.indexBy(data.bio[sid] || [], 'slotKey'), checks = [];
    Presence.slots(session, sid).map(function (x) { return { key: session.sessionId + '|' + sid + '|' + x.key, kind: 'random', at: x.at }; })
      .concat(data.classChecks.map(function (r) { return { key: session.sessionId + '|' + sid + '|' + r.bioId, kind: 'teacher', at: r.dueAt }; }))
      .forEach(function (x) {
        var r = mine[x.key];
        if (r) checks.push({ kind: r.kind, at: r.deliveredAt, outcome: r.outcome === 'pending' ? (now > r.deadline ? 'missed' : 'pending') : r.outcome === 'late' ? 'missed' : r.outcome });
        else if (x.at <= E && inside(x.at) && E >= x.at + grace) checks.push({ kind: x.kind, at: x.at, outcome: 'missed' }); // never reached the phone (app off or offline)
      });
    var open = (data.flags[sid] || []).map(function (f) { return f.type; });
    var last = pings.length ? pings[pings.length - 1] : null;
    var result = c.firstIn === null ? 'absent' : open.length ? 'flagged' : (pct !== null && pct < Settings.get('absentCoveragePct')) ? 'absent'
      : (checks.some(function (k) { return k.outcome === 'missed' || k.outcome === 'failed'; }) || (pct !== null && pct < Settings.get('presentCoveragePct'))) ? 'partial' : 'present';
    if (!c.override) c.status = result;
    return { result: c.status, computed: result, coveragePct: pct, lastReportAt: last ? last.at : null, lastSource: last ? last.source : '',
             atLab: last ? (last.verdict === 'ok' ? last.inLab : null) : null, lastDistanceM: last ? last.distanceM : null, checks: checks, flags: U.uniq(open), usesApp: pings.some(function (q) { return q.source === 'app'; }) || evts.some(function (e) { return e.mode === 'C'; }) };
  },

  /** The faculty's final result for a student in their session. Append-only and audited. */
  override: function (ctx, p) {
    V.obj(p);
    var s = Db.mustGet('Sessions', V.id(p.sessionId, 'Session', 'session'), 'Session');
    if (!Auth.ownsSession(ctx, s)) fail('FORBIDDEN', 'Only the session\'s faculty can override a result.');
    if (s.archivedAt) fail('ARCHIVED', 'This session is archived.');
    var studentId = V.id(p.studentId, 'Student', 'student'), outcome = V.enumOf(p.outcome, 'Result', ['present', 'partial', 'absent', 'flagged']);
    var reason = V.str(p.reason, 'Reason', { min: 3, max: 300 });
    if (!Db.get('StudentProfiles', studentId)) fail('NOT_FOUND', 'Student not found.');
    var now = U.now();
    var ev = Db.insert('AttendanceEvents', { eventId: U.id('event'), sessionId: s.sessionId, labId: s.labId, studentId: studentId, type: 'OVERRIDE', source: 'manual', at: now,
      recordedBy: ctx.email, reason: reason, approvalStatus: 'na', createdAt: now, method: 'manual', scannedBy: ctx.email, scannerRole: Auth.actorRole(ctx), outcome: outcome });
    Audit.log({ actor: ctx.email, role: Auth.actorRole(ctx), action: 'attend.override', entityType: 'AttendanceEvent', entityId: ev.eventId, detail: { sessionId: s.sessionId, studentId: studentId, outcome: outcome, reason: reason } });
    if (s.status !== 'open') Attend.rebuildSummary(s.sessionId);
    return { eventId: ev.eventId, outcome: outcome };
  }
};

/** Tier 3 reuses the kiosk-code checks of check-in (A) and its locked steps; only the proof and location differ. */
Presence.STEPS_C = (function () {
  var open = U.indexBy(Checkin.STEPS_OPEN, 'id'), a = U.indexBy(Checkin.STEPS_A, 'id');
  return [
    { id: 'device', label: 'Signed by this student\'s linked phone (Android Keystore key)', run: function (c) {
      var d = Presence._appCred(c.ctx, c.credentialId);
      c.student = d.student; c.studentId = d.student.studentId; c.cred = d.cred; c.credentialId = d.cred.credentialId;
      c.subject = { studentId: c.studentId, purpose: 'app' };
      if (!Creds.verifySignature(d.cred.publicKey, c.message, c.sig)) { c.tampered = true; fail('BAD_SIGNATURE', 'This check-in was not signed by your linked phone.'); }
      if (d.cred.status !== 'active') c.appFlags.push({ type: 'unapproved_device', detail: { credentialId: d.cred.credentialId } });
      if (Users.consentRequired(c.ctx.user)) fail('CONSENT_REQUIRED', 'Accept the privacy notice in LABFLOW on the web first.');
    } },
    { id: 'message', label: 'Check-in message is well formed', run: function (c) {
      var f = Presence._fields(c.message, 'c1', 8);
      if (!f) fail('BAD_INPUT', 'Invalid check-in.');
      c.input = f[1]; c.action = V.enumOf(f[2], 'Action', ['in', 'out']); c.phoneAt = Number(f[3]);
      c.appReading = Presence._reading(f[4], f[5], f[6]); c.mock = f[7] === '1';
      if (isFinite(c.phoneAt) && c.phoneAt > U.now() + Presence.FUTURE_MS) c.appFlags.push({ type: 'clock_skew', detail: { aheadSeconds: Math.round((c.phoneAt - U.now()) / 1000) } });
    } },
    open.code_format, open.code_mac,
    { id: 'code_fresh', label: 'Kiosk code was on the screen moments ago (an old one is recorded and flagged)', run: function (c) {
      var interval = Checkin._interval() * 1000, age = (U.now() - (c.step + 1) * interval) / 1000;
      if (c.step * interval > U.now() + 5000) fail('BAD_CODE', 'This code is dated in the future.');
      if (age > Settings.get('kioskCodeMaxAgeSeconds')) { c.appFlags.push({ type: 'stale_code', detail: { ageSeconds: Math.round(age) } }); c.assurance = 'flagged'; }
    } },
    { id: 'kiosk_active', label: 'Kiosk is active and its lab shows the kiosk code', run: function (c) { Checkin._kioskAndLab(c); c.passLabId = c.labId; c.passExp = Infinity; } },
    a.rate_limit,
    { id: 'pick', label: 'Session to join (the one the kiosk page would preselect, when the app does not say)', run: function (c) {
      if (c.action !== 'in' || c.sessionId || c.reservationId) return;
      var o = Checkin.options(c.student, c.lab, U.now());
      if (o.inside && o.actions.indexOf('in') < 0) fail('DUPLICATE_IN', 'You are already checked in to ' + o.inside.title + '.');
      if (!o.prefill) fail('NO_SESSION', 'There is no session you can join in this lab right now.');
      if (String(o.prefill).indexOf('RSV-') === 0) c.reservationId = o.prefill; else c.sessionId = o.prefill;
    } },
    a.target, a.work,
    { id: 'location', label: 'At the lab, real location (faked, impossible or outside is recorded and flagged)', run: function (c) {
      var r = c.appReading;
      if (!r) { c.geofence = 'na'; c.noGeo = true; c.assurance = c.assurance || 'lower'; return; }
      var place = Presence._place(c.lab, r.lat, r.lng, r.acc);
      c.distanceM = place.distanceM; c.accuracyM = Math.round(r.acc * 10) / 10;
      if (c.mock) { c.appFlags.push({ type: 'mock_location' }); c.assurance = 'flagged'; }
      if (r.acc < Settings.get('minPlausibleAccuracyM')) { c.geoFlag = 'implausible_location'; c.assurance = 'flagged'; }
      if (!Labs.hasGeofence(c.lab)) { c.geofence = 'na'; c.assurance = c.assurance || 'lower'; return; }
      if (!place.inLab) { c.geofence = 'fail'; c.geoFlag = c.geoFlag || 'outside_geofence'; c.assurance = 'flagged'; c.band = U.distanceBand(place.distanceM); return; }
      c.geofence = 'pass'; c.assurance = c.assurance || 'standard';
    } },
    a.code_once, a.session_open, a.enrolment, a.attendance_state,
    { id: 'record', locked: true, label: 'Append the event and mark the code used', run: function (c) {
      if (c.purpose === 'in') Work.validate(c.studentId, c.session, c.projectId, c.assetId, c.session.type === 'openlab');
      c.method = 'app'; c.scannerRole = 'app'; c.scannedBy = c.ctx.email;
      Attend._record(c);
    } }
  ];
})();
