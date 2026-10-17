/**
 * DeviceCredentialService.gs - device-bound signing credentials and single-use challenge tokens.
 *
 * WHAT THIS PROVES (and what it does not) - see SECURITY.md for the full discussion:
 *  - A credential is an ECDSA P-256 key pair generated in the student's browser with WebCrypto (extractable:false).
 *    The server stores only the PUBLIC key. At registration the browser must sign a server challenge with the new
 *    private key (proof of possession).
 *  - An attendance QR carries a server-issued, HMAC-protected, single-use token PLUS an ECDSA signature over it made
 *    by the device key. A copy of the QR image is worthless after it is redeemed or expires; a stolen Google session
 *    alone cannot produce the signature.
 *  - "Non-extractable" means the browser will not export the key; it does NOT mean hardware-backed, and a passkey /
 *    synced key may exist on more than one device. We therefore treat this as "possession of an enrolled browser
 *    profile", and rely on the kiosk scan + spot checks for physical presence.
 *  - WebAuthn is evaluated in SECURITY.md; it is not used because the HtmlService iframe origin is unstable and WebAuthn
 *    in a cross-origin sandboxed iframe is not something Google documents as supported. The verifier here is the same
 *    ES256 primitive WebAuthn would need, so it can be added once deployment testing proves it works.
 */
var Tokens = {
  _secret: function () {
    var s = PropertiesService.getScriptProperties().getProperty(Cfg.PROP.HMAC);
    if (!s) fail('NOT_INITIALISED', 'Server secret missing. Run Setup.initialise().');
    return s;
  },
  _mac: function (body) { return U.hmacB64u(Tokens._secret(), body).slice(0, 27); },
  nonce: function () { return U.b64uEncode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + U.now(), Utilities.Charset.UTF_8)).slice(0, 16); },
  make: function (parts) {
    var body = parts.join('.');
    return body + '.' + Tokens._mac(body);
  },
  /** Returns the parts (without the mac) or throws BAD_TOKEN. Constant-time MAC comparison. */
  parse: function (token, kind, nParts) {
    if (typeof token !== 'string' || token.length > 400) fail('BAD_TOKEN', 'Unrecognised code.');
    var i = token.lastIndexOf('.');
    if (i < 0) fail('BAD_TOKEN', 'Unrecognised code.');
    var body = token.slice(0, i), mac = token.slice(i + 1);
    if (!U.safeEq(mac, Tokens._mac(body))) fail('BAD_TOKEN', 'This code was not issued by LABFLOW.');
    var parts = body.split('.');
    if (parts[0] !== kind || parts.length !== nParts) fail('BAD_TOKEN', 'Unrecognised code.');
    return parts;
  },
  /** Has this nonce already been redeemed? Looks only at the recent window (tokens live <= ~3 minutes). */
  wasRedeemed: function (nonce) {
    var cache = CacheService.getScriptCache();
    try { if (cache.get('nonce|' + nonce)) return true; } catch (e) {}
    var cutoff = U.now() - 6 * 60 * 1000, n = 400, rows;
    for (;;) {
      rows = Db.tail('Redemptions', n);
      for (var i = rows.length - 1; i >= 0; i--) { if (rows[i].at < cutoff) return false; if (rows[i].nonce === nonce) return true; }
      if (rows.length < n) return false; // read the whole table
      n *= 4;
    }
  },
  /** Record redemption (call inside the lock, after wasRedeemed() returned false). */
  redeem: function (nonce, purpose, studentId, sessionId, kioskId, eventId) {
    Db.insert('Redemptions', { nonce: nonce, purpose: purpose, studentId: studentId, sessionId: sessionId || '', kioskId: kioskId || '', at: U.now(), eventId: eventId || '' });
    try { CacheService.getScriptCache().put('nonce|' + nonce, '1', 900); } catch (e) {}
  }
};

var Creds = {
  /** ECDSA P-256 / SHA-256 verification. Public key = 65-byte uncompressed point; signature = 64-byte r||s (WebCrypto format). */
  verifySignature: function (pubKeyB64u, message, sigB64u) {
    try {
      var pub = U.b64uDecode(pubKeyB64u), sig = U.b64uDecode(sigB64u);
      if (pub.length !== 65 || pub[0] !== 4 || sig.length !== 64) return false;
      return NobleP256.verify(sig, U.sha256Bytes(message), pub) === true;
    } catch (e) { return false; }
  },

  get: function (credentialId) { return Db.cachedGet('DeviceCredentials', 'credentialId', credentialId, 300); },

  summaryFor: function (studentId) {
    var all = Db.whereEq('DeviceCredentials', { studentId: studentId });
    var pick = function (c) { return c ? { credentialId: c.credentialId, label: c.label, createdAt: c.createdAt, status: c.status } : null; };
    var active = all.filter(function (c) { return c.status === 'active'; });
    var pending = all.filter(function (c) { return c.status === 'pending_approval'; });
    return { active: active.map(pick), pending: pick(pending[0]), hasActive: active.length > 0 };
  },

  /** Step 1 of registration: a fresh challenge the new key must sign. */
  beginRegistration: function (ctx) {
    var st = Creds._requireVerifiedStudent(ctx);
    if (!Auth.rateLimit('reg|' + st.studentId, 10, 3600)) fail('RATE_LIMITED', 'Too many attempts. Try again later.');
    var exp = Math.floor(U.now() / 1000) + 300;
    var challenge = Tokens.make(['r1', st.studentId, Tokens.nonce(), String(exp)]);
    return { challenge: challenge, expiresAt: exp * 1000 };
  },

  /** Step 2: the browser returns its new PUBLIC key and a signature of the challenge made with the new PRIVATE key. */
  completeRegistration: function (ctx, p) {
    V.obj(p);
    var st = Creds._requireVerifiedStudent(ctx);
    if (Users.consentRequired(ctx.user)) fail('CONSENT_REQUIRED', 'Accept the privacy notice first.');
    var label = V.str(p.label, 'Device name', { optional: true, max: 60, def: 'My phone' });
    var publicKey = V.str(p.publicKey, 'Public key', { max: 120, re: /^[A-Za-z0-9_-]+$/ });
    var signature = V.str(p.signature, 'Signature', { max: 120, re: /^[A-Za-z0-9_-]+$/ });
    var parts = Tokens.parse(p.challenge, 'r1', 4);
    if (parts[1] !== st.studentId) { Audit.tryLog({ actor: ctx.email, role: 'student', action: 'cred.register', entityType: 'DeviceCredential', result: 'rejected', detail: { reason: 'challenge for another student' } }); fail('BAD_TOKEN', 'This registration code was issued to someone else.'); }
    if (U.now() / 1000 > Number(parts[3])) fail('EXPIRED', 'Registration timed out. Start again.');
    if (!Creds.verifySignature(publicKey, p.challenge, signature)) { Audit.tryLog({ actor: ctx.email, role: 'student', action: 'cred.register', entityType: 'DeviceCredential', result: 'rejected', detail: { reason: 'bad proof of possession' } }); fail('BAD_SIGNATURE', 'The device could not prove it holds the key.'); }

    return Locks.with(function () {
      if (U.now() / 1000 > Number(parts[3])) fail('EXPIRED', 'Registration timed out. Start again.');
      st = Attend._verifiedStudent(st.studentId);
      if (Tokens.wasRedeemed(parts[2])) fail('REPLAY', 'This registration code was already used.');
      var all = Db.whereEq('DeviceCredentials', { studentId: st.studentId });
      var active = all.filter(function (c) { return c.status === 'active'; });
      if (all.some(function (c) { return c.status === 'pending_approval'; })) fail('PENDING_EXISTS', 'You already have a device waiting for approval. Visit the lab desk.');
      var max = Settings.get('credentialMaxActive');
      // Only a student's very first device is self-service. Any later registration (including after revoking the old one, e.g. a lost phone)
      // needs in-person approval, so identity cannot be moved between phones at will.
      var needsApproval = all.length > 0 || active.length >= max;
      var now = U.now();
      var cred = Db.insert('DeviceCredentials', {
        credentialId: U.id('cred'), studentId: st.studentId, userEmail: ctx.email, publicKey: publicKey, alg: 'ES256', label: label,
        status: needsApproval ? 'pending_approval' : 'active', replacesCredentialId: needsApproval && active.length ? active[0].credentialId : '',
        createdAt: now, approvedBy: needsApproval ? '' : 'auto-first-device', approvedAt: needsApproval ? null : now
      });
      Tokens.redeem(parts[2], 'R', st.studentId, '', '', cred.credentialId);
      Audit.log({ actor: ctx.email, role: 'student', action: needsApproval ? 'cred.request_replacement' : 'cred.register', entityType: 'DeviceCredential', entityId: cred.credentialId,
                  detail: { studentId: st.studentId, label: label, replaces: cred.replacesCredentialId } });
      if (needsApproval) Notify.toRole('staff', 'device', 'Device replacement request', st.name + ' (' + st.rollNo + ') requests a new device. Verify ID in person, then approve.', 'cred:' + cred.credentialId);
      // Students register phones; a desktop registration is allowed but flagged (a browser profile is easier to copy).
      try { Flags.afterRegistration(st, cred.credentialId, V.bool(p.desktop)); } catch (e) { Syslog.warn('creds', 'FLAG_CHECK_FAILED', String(e && e.message)); }
      return { credentialId: cred.credentialId, status: cred.status };
    });
  },

  _requireVerifiedStudent: function (ctx) {
    if (!ctx.student) fail('NOT_ONBOARDED', 'Complete your student profile first.');
    if (ctx.student.status !== 'verified') fail('NOT_VERIFIED', 'Your profile is not verified yet. Visit the lab desk with your ID card.');
    return ctx.student;
  },

  /** In-person approval of a replacement device (lab staff / admin). The old credential stops working immediately. */
  approve: function (ctx, p) {
    V.obj(p);
    var credentialId = V.id(p.credentialId, 'Credential', 'cred');
    var idChecked = V.bool(p.idChecked);
    if (!idChecked) fail('BAD_INPUT', 'Confirm that you checked the student\'s ID in person.');
    return Locks.with(function () {
      var c = Db.mustGet('DeviceCredentials', credentialId, 'Credential');
      if (c.status !== 'pending_approval') fail('INVALID_STATE', 'This request is no longer pending.');
      if (ctx.student && ctx.student.studentId === c.studentId) fail('FORBIDDEN', 'You cannot approve your own device.');
      var now = U.now();
      if (c.replacesCredentialId) {
        var old = Db.get('DeviceCredentials', c.replacesCredentialId);
        if (old && old.status === 'active') Db.update('DeviceCredentials', old.credentialId, { status: 'replaced', revokedAt: now, revokedBy: ctx.email, revokeReason: 'replaced by ' + c.credentialId });
      }
      var next = Db.update('DeviceCredentials', credentialId, { status: 'active', approvedBy: ctx.email, approvedAt: now });
      Audit.log({ actor: ctx.email, role: ctx.has('admin') ? 'admin' : 'staff', action: 'cred.approve', entityType: 'DeviceCredential', entityId: credentialId, detail: { studentId: c.studentId, replaced: c.replacesCredentialId } });
      var st = Db.get('StudentProfiles', c.studentId);
      if (st && st.userId) Notify.toUser(st.userId, 'device', 'New device approved', 'Your new device is active. The old device no longer works.', 'credok:' + credentialId);
      return { credential: Creds._pub(next) };
    });
  },

  reject: function (ctx, p) {
    V.obj(p);
    var credentialId = V.id(p.credentialId, 'Credential', 'cred');
    var reason = V.str(p.reason, 'Reason', { min: 3, max: 200 });
    return Locks.with(function () {
      var c = Db.mustGet('DeviceCredentials', credentialId, 'Credential');
      if (c.status !== 'pending_approval') fail('INVALID_STATE', 'This request is no longer pending.');
      var next = Db.update('DeviceCredentials', credentialId, { status: 'revoked', revokedAt: U.now(), revokedBy: ctx.email, revokeReason: 'rejected: ' + reason });
      Audit.log({ actor: ctx.email, role: ctx.has('admin') ? 'admin' : 'staff', action: 'cred.reject', entityType: 'DeviceCredential', entityId: credentialId, detail: { studentId: c.studentId, reason: reason } });
      return { credential: Creds._pub(next) };
    });
  },

  /** Revoke. Students may revoke their own (lost phone); staff/admin may revoke anyone's. Effective immediately. */
  revoke: function (ctx, p) {
    V.obj(p);
    var credentialId = V.id(p.credentialId, 'Credential', 'cred');
    var reason = V.str(p.reason, 'Reason', { optional: true, max: 200, def: 'no reason given' });
    return Locks.with(function () {
      var c = Db.mustGet('DeviceCredentials', credentialId, 'Credential');
      var own = ctx.student && ctx.student.studentId === c.studentId;
      if (!own && !ctx.has('staff') && !ctx.has('admin')) fail('FORBIDDEN', 'You cannot revoke this device.');
      if (c.status === 'revoked' || c.status === 'replaced') fail('INVALID_STATE', 'Already revoked.');
      var next = Db.update('DeviceCredentials', credentialId, { status: 'revoked', revokedAt: U.now(), revokedBy: ctx.email, revokeReason: reason });
      Audit.log({ actor: ctx.email, role: ctx.roles[0], action: 'cred.revoke', entityType: 'DeviceCredential', entityId: credentialId, detail: { studentId: c.studentId, reason: reason, self: !!own } });
      return { credential: Creds._pub(next) };
    });
  },

  revokeAllFor: function (studentId, actorEmail, reason) {
    Db.whereEq('DeviceCredentials', { studentId: studentId }).forEach(function (c) {
      if (c.status === 'active' || c.status === 'pending_approval') {
        Db.update('DeviceCredentials', c.credentialId, { status: 'revoked', revokedAt: U.now(), revokedBy: actorEmail, revokeReason: reason });
        Audit.log({ actor: actorEmail, role: 'admin', action: 'cred.revoke', entityType: 'DeviceCredential', entityId: c.credentialId, detail: { studentId: studentId, reason: reason } });
      }
    });
  },

  _pub: function (c) { return { credentialId: c.credentialId, studentId: c.studentId, label: c.label, status: c.status, createdAt: c.createdAt, approvedBy: c.approvedBy, approvedAt: c.approvedAt, revokedAt: c.revokedAt, revokeReason: c.revokeReason, replacesCredentialId: c.replacesCredentialId }; },

  listForStudent: function (ctx, p) {
    var studentId;
    if (p && p.studentId && (ctx.has('staff') || ctx.has('admin'))) studentId = V.id(p.studentId, 'Student', 'student');
    else { if (!ctx.student) return { credentials: [] }; studentId = ctx.student.studentId; }
    return { credentials: Db.whereEq('DeviceCredentials', { studentId: studentId }).map(Creds._pub) };
  },

  /** Staff queue: replacement requests awaiting in-person approval. */
  listPending: function () {
    var students = U.indexBy(Db.readAll('StudentProfiles'), 'studentId');
    return { pending: Db.whereEq('DeviceCredentials', { status: 'pending_approval' }).map(function (c) {
      var s = students[c.studentId] || {};
      return Object.assign(Creds._pub(c), { studentName: s.name, rollNo: s.rollNo });
    }) };
  }
};
