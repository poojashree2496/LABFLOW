/**
 * UserService.gs - accounts, roles, student profiles, onboarding and photos.
 *
 * Roll-number integrity: StudentProfiles.rollNo is a unique column (enforced by Db under the script lock).
 * A student can only become "verified" in one of two controlled ways:
 *   1. the admin imported the roll number WITH the student's official email and the student signs in with it, or
 *   2. a lab staff member / admin approves the claim after checking ID.
 * Unverified students cannot register a device or check in.
 */
var Users = {
  /** Stored join year, or the one in the register number for profiles saved before A1. */
  _joinYear: function (p) { if (p.joinYear) return p.joinYear; var r = U.parseRoll(p.rollNo); return r ? r.joinYear : null; },
  _pubStudent: function (p) {
    if (!p) return null;
    return { studentId: p.studentId, rollNo: p.rollNo, name: p.name, department: p.department, section: p.section, year: p.year, joinYear: Users._joinYear(p),
             status: p.status, email: p.email, hasPhoto: !!p.photoFileId };
  },
  _pubUser: function (u) { return { userId: u.userId, email: u.email, displayName: u.displayName, roles: String(u.roles || '').split(',').filter(Boolean), status: u.status, department: u.department || '', lastLoginAt: u.lastLoginAt }; },

  me: function (ctx) {
    var s = Settings.all(), sid = ctx.student ? ctx.student.studentId : null;
    var reps = sid ? Db.where('ClassReps', function (r) { return r.status === 'active' && r.studentId === sid; }).length : 0;
    var eventLabs = Auth.labFilter(ctx);
    var coordinating = Db.where('Events', function (e) { return eventLabs(e.labId) && e.status === 'active' && e.coordinatorEmail === ctx.email && e.endAt + s.eventCoordinatorGraceMinutes * 60000 >= U.now(); }).length;
    return {
      email: ctx.email,
      userId: ctx.user ? ctx.user.userId : null,
      displayName: ctx.user ? ctx.user.displayName : ctx.email.split('@')[0],
      roles: ctx.roles, department: ctx.user ? ctx.user.department || '' : '',
      onboardingRequired: !ctx.user || (ctx.has('student') && !ctx.student),
      consentRequired: !ctx.kiosk && Users.consentRequired(ctx.user),
      profileIncomplete: !!ctx.user && s.requireMobile && !ctx.user.mobile,
      mobile: ctx.user ? Users._mobileOf(ctx.user) : '', // a user always gets their own number in full; nobody else's leaves the server unmasked (A2)
      derivedRollNo: !ctx.student ? Users.derivedRoll(ctx.email) : '',
      classRep: reps > 0, coordinating: coordinating,
      student: ctx.student ? Object.assign(Users._pubStudent(ctx.student), { credential: Creds.summaryFor(ctx.student.studentId) }) : null,
      faculty: ctx.faculty ? { facultyId: ctx.faculty.facultyId, name: ctx.faculty.name, department: ctx.faculty.department } : null,
      kiosk: ctx.kiosk ? { kioskId: ctx.kiosk.kioskId, labId: ctx.kiosk.labId, name: ctx.kiosk.name } : null,
      settings: { qrTtlSeconds: s.qrTtlSeconds, rescanWindowSeconds: s.rescanWindowSeconds, exitGraceMinutes: s.exitGraceMinutes,
                  requireExitScan: s.requireExitScan, loanDefaultDays: s.loanDefaultDays, bookingMaxAdvanceDays: s.bookingMaxAdvanceDays,
                  bookingMaxDays: s.bookingMaxDays, studentQrRotateSeconds: s.studentQrRotateSeconds, qrFreshSeconds: s.qrFreshSeconds,
                  occupancyRefreshSeconds: s.occupancyRefreshSeconds, defaultCheckinMode: s.defaultCheckinMode, requireMobile: s.requireMobile,
                  requireCheckinForRequests: s.requireCheckinForRequests, minScanGapSeconds: s.minScanGapSeconds, uiTheme: s.uiTheme },
      consentVersion: Cfg.CONSENT_VERSION,
      webAppUrl: Setup.webAppUrl(),
      serverNow: U.now(), tz: Cfg.TZ
    };
  },

  /** Has this account accepted the current privacy notice (DPDP Act notice, SRS section 13)? */
  consentRequired: function (user) { return !user || user.consentVersion !== Cfg.CONSENT_VERSION; },

  /** Roll number taken from the student email (FR-3), e.g. urk24cs1021@karunya.edu.in -> URK24CS1021, or '' if it does not match. */
  derivedRoll: function (email) {
    if (!Settings.get('rollFromEmail')) return '';
    var local = String(email || '').split('@')[0].toLowerCase(), re;
    try { re = new RegExp(Settings.get('rollEmailPattern')); } catch (e) { return ''; }
    return local.length <= 20 && re.test(local) ? local.toUpperCase() : '';
  },

  /** The signed-in user's own profile fields: mobile number and acceptance of the privacy notice. */
  updateProfile: function (ctx, p) {
    V.obj(p);
    if (!ctx.user) fail('NOT_ONBOARDED', 'Complete onboarding first.');
    var patch = {}, detail = {};
    if (p.mobile !== undefined) { patch.mobile = Crypt.seal(V.mobile(p.mobile), Users.MOBILE_FIELD); detail.mobile = 'updated'; }
    if (p.consent === true) { patch.consentAt = U.now(); patch.consentVersion = Cfg.CONSENT_VERSION; detail.consentVersion = Cfg.CONSENT_VERSION; }
    if (!Object.keys(patch).length) fail('BAD_INPUT', 'Nothing to change.');
    patch.updatedAt = U.now();
    Db.update('Users', ctx.user.userId, patch);
    Audit.log({ actor: ctx.email, role: ctx.roles[0] || 'user', action: patch.consentVersion ? 'consent.accept' : 'profile.update', entityType: 'User', entityId: ctx.user.userId, detail: detail });
    return { ok: true, consentRequired: false };
  },

  // ---- onboarding ----------------------------------------------------------------------------------
  onboard: function (ctx, p) {
    V.obj(p);
    if (ctx.student) fail('ALREADY_ONBOARDED', 'Your student profile already exists.');
    if (ctx.user && !ctx.has('student')) fail('FORBIDDEN', 'Only students can onboard here. Staff and faculty accounts are created by an administrator.');
    if (p.consent !== true) fail('CONSENT_REQUIRED', 'Read and accept the privacy notice to continue.');
    var derived = Users.derivedRoll(ctx.email);
    var rollNo = derived || V.rollNo(p.rollNo); // a roll number that comes from the email cannot be typed differently (FR-3)
    var parsedRoll = U.parseRoll(rollNo);
    var mobile = Settings.get('requireMobile') || p.mobile ? V.mobile(p.mobile) : '';
    var name = V.str(p.name, 'Name', { max: 80, min: 2 });
    var previous = Db.getBy('Users', 'email', ctx.email);
    var department = V.str(p.department === undefined ? (previous ? previous.department || '' : (parsedRoll ? parsedRoll.dept : 'CSE')) : p.department, 'Department', { optional: true, max: 60 }).trim().toUpperCase();
    var section = V.str(p.section, 'Section', { optional: true, max: 10 });
    var year = V.int(p.year, 'Year', 1, 6, { optional: true, def: null });
    var photo = p.photo ? Users._decodePhoto(p.photo) : null;

    var profile = Locks.with(function () {
      var now = U.now();
      // Identity may have been resolved while another claim waited for this lock.
      var fresh = Auth._contextForEmail(ctx.email, true), user = fresh.user;
      if (fresh.student) fail('ALREADY_ONBOARDED', 'Your student profile already exists.');
      if (user && !fresh.has('student')) fail('FORBIDDEN', 'Only students can onboard here.');
      var existing = Db.getBy('StudentProfiles', 'rollNo', rollNo);
      // Refused claims must not insert an account, change contact data or reserve the profile.
      if (existing) {
        if (existing.userId && (!user || existing.userId !== user.userId)) fail('ROLL_TAKEN', 'This roll number is already linked to another account. Contact the lab office if this is a mistake.');
        if (existing.status !== 'imported' && existing.status !== 'rejected' && (!user || existing.userId !== user.userId)) fail('ROLL_TAKEN', 'This roll number already has a pending claim. Contact the lab office.');
        if (existing.importedEmail && existing.importedEmail !== ctx.email) fail('FORBIDDEN', 'This roll number is assigned to a different university email. Contact the lab office.');
      }
      if (!user) {
        user = Db.insert('Users', { userId: U.id('user'), email: ctx.email, displayName: name, roles: 'student', status: 'active', createdAt: now, updatedAt: now,
          mobile: mobile ? Crypt.seal(mobile, Users.MOBILE_FIELD) : '', consentAt: now, consentVersion: Cfg.CONSENT_VERSION });
      } else {
        user = Db.update('Users', user.userId, { mobile: mobile ? Crypt.seal(mobile, Users.MOBILE_FIELD) : user.mobile, consentAt: now, consentVersion: Cfg.CONSENT_VERSION, updatedAt: now });
      }
      var out;
      if (existing) {
        // Verified automatically when the admin imported this roll number with this email, or when the roll number IS the email.
        // Otherwise, with studentAutoVerify, the first claim of an imported roll number that carries no email is trusted.
        var firstClaim = !existing.importedEmail && !derived && Settings.get('studentAutoVerify');
        var matches = existing.importedEmail ? existing.importedEmail === ctx.email : (!!derived || firstClaim);
        out = Db.update('StudentProfiles', existing.studentId, {
          userId: user.userId, email: ctx.email, name: name, department: existing.department || department, section: section || existing.section,
          year: year !== null ? year : existing.year, status: matches ? 'verified' : 'pending',
          verifiedBy: matches ? (existing.importedEmail ? 'import-email-match' : derived ? 'email-roll-match' : 'first-claim') : '', verifiedAt: matches ? now : null, updatedAt: now
        });
      } else {
        out = Db.insert('StudentProfiles', { studentId: U.id('student'), userId: user.userId, email: ctx.email, importedEmail: '', rollNo: rollNo, name: name,
          department: department, section: section, year: year, joinYear: parsedRoll ? parsedRoll.joinYear : null, status: derived ? 'verified' : 'pending', verifiedBy: derived ? 'email-roll-match' : '', verifiedAt: derived ? now : null, createdAt: now, updatedAt: now });
      }
      Audit.log({ actor: ctx.email, role: 'student', action: 'student.onboard', entityType: 'StudentProfile', entityId: out.studentId,
                  detail: { rollNo: rollNo, resultStatus: out.status } });
      return out;
    });
    if (photo) { try { Users._storePhoto(profile, photo); } catch (e) { Syslog.warn('users', 'PHOTO_STORE_FAILED', String(e.message)); } }
    if (profile.status === 'pending') Notify.toRole('staff', 'verification', 'Student awaiting verification', profile.name + ' (' + profile.rollNo + ') needs identity verification.', 'verify:' + profile.studentId);
    return { student: Users._pubStudent(Db.get('StudentProfiles', profile.studentId)) };
  },

  verifyStudent: function (ctx, p) {
    V.obj(p);
    var studentId = V.id(p.studentId, 'Student', 'student');
    var approve = V.bool(p.approve);
    var note = V.str(p.note, 'Note', { optional: true, max: 200 });
    return Locks.with(function () {
      var actor = Auth._contextForEmail(ctx.email, true);
      Auth.requireRole(actor, ['staff', 'admin']);
      var prof = Db.mustGet('StudentProfiles', studentId, 'Student');
      Users._reviewedClaim(prof, p);
      if (prof.status === 'disabled') fail('INVALID_STATE', 'This profile is disabled.');
      if (!prof.userId) fail('INVALID_STATE', 'This profile has not been claimed by a student yet.');
      var next = Db.update('StudentProfiles', studentId, approve
        ? { status: 'verified', verifiedBy: ctx.email, verifiedAt: U.now(), updatedAt: U.now() }
        : { status: 'rejected', verifiedBy: ctx.email, verifiedAt: null, updatedAt: U.now() });
      Audit.log({ actor: ctx.email, role: actor.has('admin') ? 'admin' : 'staff', action: approve ? 'student.verify' : 'student.reject', entityType: 'StudentProfile', entityId: studentId, detail: { rollNo: prof.rollNo, note: note } });
      Notify.toUser(prof.userId, 'verification', approve ? 'Profile verified' : 'Profile not verified', approve ? 'Your student profile is verified. You can now register your device.' : 'Your profile could not be verified. ' + (note || 'Visit the lab office.'), 'verifyres:' + studentId + ':' + next.status);
      return { student: Users._pubStudent(next) };
    });
  },

  /** A desk dialog may outlive an unlink/reclaim. Older clients may omit the reviewed account. */
  _reviewedClaim: function (prof, p) {
    if (p.expectedEmail !== undefined && V.str(p.expectedEmail, 'Reviewed account', { optional: true, max: 254 }).trim().toLowerCase() !== prof.email) {
      fail('CONFLICT', 'The account linked to this profile changed. Refresh the student list and review it again.');
    }
  },

  /** Admin: detach an account from a profile (wrong account claimed it). Revokes the student's device credentials. */
  unlinkStudent: function (ctx, p) {
    V.obj(p);
    var studentId = V.id(p.studentId, 'Student', 'student');
    var reason = V.str(p.reason, 'Reason', { min: 5, max: 200 });
    return Locks.with(function () {
      Auth.requireRole(Auth._contextForEmail(ctx.email, true), ['admin']);
      var prof = Db.mustGet('StudentProfiles', studentId, 'Student');
      Users._reviewedClaim(prof, p);
      if (!prof.userId && prof.status === 'imported') return { student: Users._pubStudent(prof), replayed: true };
      Creds.revokeAllFor(studentId, ctx.email, 'profile unlinked: ' + reason);
      var next = Db.update('StudentProfiles', studentId, { userId: '', email: '', status: 'imported', verifiedBy: '', verifiedAt: null, updatedAt: U.now() });
      Audit.log({ actor: ctx.email, role: 'admin', action: 'student.unlink', entityType: 'StudentProfile', entityId: studentId, detail: { rollNo: prof.rollNo, previousUserId: prof.userId, reason: reason } });
      return { student: Users._pubStudent(next), replayed: false };
    });
  },

  /** Staff/admin/faculty student directory. Faculty only see students in their own courses. */
  MOBILE_FIELD: 'Users.mobile',
  /** The number a user has stored, in plain text. Only ever returned to that same user, or through revealMobile. */
  _mobileOf: function (user) { return Crypt.reveal(user && user.mobile, Users.MOBILE_FIELD); },
  /** The masked number shown to other people (last four digits). Empty when there is none. */
  maskedMobileOf: function (user) { return user && user.mobile ? Crypt.mask(Users._mobileOf(user)) : ''; },
  /** The masked number of a student, by student id, for desks that need to recognise who they are talking to. */
  maskedMobileForStudent: function (studentId) {
    var prof = studentId && Db.get('StudentProfiles', studentId), user = prof && prof.userId && Db.get('Users', prof.userId);
    return user ? Users.maskedMobileOf(user) : '';
  },
  /**
   * Show one person's full number to a coordinator or super admin (A2). One student per call, rate-limited by the route, and
   * every reveal is written to the audit trail with who asked and why.
   */
  revealMobile: function (ctx, p) {
    V.obj(p);
    var studentId = V.id(p.studentId, 'Student', 'student'), reason = V.str(p.reason, 'Reason', { optional: true, max: 120, def: '' });
    var prof = Db.mustGet('StudentProfiles', studentId, 'Student'), user = prof.userId ? Db.get('Users', prof.userId) : null;
    Audit.log({ actor: ctx.email, role: Auth.actorRole(ctx), action: 'pii.reveal', entityType: 'StudentProfile', entityId: studentId, detail: { field: 'mobile', rollNo: prof.rollNo, reason: reason, hadNumber: !!(user && user.mobile) } });
    return { studentId: studentId, name: prof.name, rollNo: prof.rollNo, mobile: user ? Users._mobileOf(user) : '' };
  },
  /**
   * Seal every phone number that is still plain text (A2). Safe to run again: a value that already starts with `enc1:` is left alone,
   * so a second run changes nothing. Runs from the owner-only setupEncryptMobiles and in the nightly job.
   */
  encryptMobiles: function () {
    return Locks.with(function () {
      var sealed = 0, already = 0, empty = 0;
      Db.readAll('Users').forEach(function (u) {
        if (!u.mobile) { empty++; return; }
        if (Crypt.isSealed(u.mobile)) { already++; return; }
        Db.update('Users', u.userId, { mobile: Crypt.seal(String(u.mobile), Users.MOBILE_FIELD) });
        sealed++;
      });
      return { sealed: sealed, alreadySealed: already, noNumber: empty };
    });
  },
  /**
   * Disable or re-enable a student profile (B2). A profile is never deleted, so attendance, loans and reports stay intact.
   * A disabled student cannot check in, scan or book, and cannot be added to a roster. Enabling restores the state the profile
   * had before: verified if it was verified, pending if it was claimed but not verified, otherwise imported.
   */
  setStudentStatus: function (ctx, p) {
    V.obj(p);
    var studentId = V.id(p.studentId, 'Student', 'student');
    var status = V.enumOf(p.status, 'Status', ['disabled', 'enabled']);
    var reason = V.str(p.reason, 'Reason', { optional: status === 'enabled', min: 3, max: 200 });
    return Locks.with(function () {
      var prof = Db.mustGet('StudentProfiles', studentId, 'Student');
      var next = status === 'disabled' ? 'disabled' : (prof.userId ? (prof.verifiedAt ? 'verified' : 'pending') : 'imported');
      if (prof.status === next) return { student: Users._pubStudent(prof), replayed: true };
      if (status === 'enabled' && prof.status !== 'disabled') fail('INVALID_STATE', 'This profile is not disabled.');
      var upd = Db.update('StudentProfiles', studentId, { status: next, verifiedAt: status === 'disabled' && prof.status !== 'verified' ? null : prof.verifiedAt, updatedAt: U.now() });
      Audit.log({ actor: ctx.email, role: Auth.actorRole(ctx), action: status === 'disabled' ? 'student.disable' : 'student.enable', entityType: 'StudentProfile', entityId: studentId, detail: { rollNo: prof.rollNo, was: prof.status, now: next, reason: reason } });
      if (prof.userId) Notify.toUser(prof.userId, 'verification', status === 'disabled' ? 'Profile disabled' : 'Profile enabled', status === 'disabled' ? 'Your lab profile was disabled. Contact the lab office.' : 'Your lab profile is active again.', 'stu-status:' + studentId + ':' + next + ':' + upd.updatedAt);
      return { student: Users._pubStudent(upd), replayed: false };
    });
  },
  listStudents: function (ctx, p) {
    p = p || {};
    var q = V.str(p.q, 'Search', { optional: true, max: 60 }).toLowerCase();
    var status = V.enumOf(p.status, 'Status', ['imported', 'pending', 'verified', 'rejected', 'disabled'], { optional: true });
    var limit = V.int(p.limit, 'Limit', 1, 500, { optional: true, def: 100 });
    var batch = V.int(p.batch, 'Batch', 2000, 2100, { optional: true });
    var studentAllowed = Auth.studentFilter(ctx);
    var rows = Db.readAll('StudentProfiles').filter(function (x) { return studentAllowed(x.studentId); });
    if (!Auth.canView(ctx)) {
      var allowed = Roster.studentIdsForFaculty(ctx.faculty ? ctx.faculty.facultyId : '');
      rows = rows.filter(function (r) { return allowed[r.studentId]; });
    }
    rows = rows.filter(function (r) {
      if (status && r.status !== status) return false;
      if (batch !== null && Users._joinYear(r) !== batch) return false;
      return !q || r.rollNo.toLowerCase().indexOf(q) >= 0 || r.name.toLowerCase().indexOf(q) >= 0;
    });
    rows.sort(function (a, b) { return a.rollNo < b.rollNo ? -1 : 1; });
    return { students: rows.slice(0, limit).map(Users._pubStudent), total: rows.length };
  },

  importStudents: function (ctx, p) {
    V.obj(p);
    var rows = V.arr(p.rows, 'Rows', 500);
    var existing = U.indexBy(Db.readAll('StudentProfiles'), 'rollNo');
    var domains = Auth.allowedDomains();
    var toCreate = [], toUpdate = [], errors = [], skipped = 0, seen = {};
    rows.forEach(function (raw, i) {
      try {
        V.obj(raw);
        var rollNo = V.rollNo(raw.rollNo);
        if (seen[rollNo]) fail('BAD_INPUT', 'Duplicate roll number in file.'); seen[rollNo] = true;
        var email = raw.email ? V.email(raw.email) : '';
        if (email && domains.indexOf(email.split('@')[1]) < 0) fail('BAD_INPUT', 'Email is not on an allowed domain.');
        var parsed = U.parseRoll(rollNo);
        var rec = { rollNo: rollNo, name: V.str(raw.name, 'Name', { max: 80, min: 2 }), importedEmail: email,
                    department: V.str(raw.department, 'Department', { optional: true, max: 60, def: parsed ? parsed.dept : 'CSE' }), section: V.str(raw.section, 'Section', { optional: true, max: 10 }),
                    year: V.int(raw.year, 'Year', 1, 6, { optional: true, def: null }) };
        if (parsed) rec.joinYear = parsed.joinYear;
        var ex = existing[rollNo];
        if (!ex) toCreate.push(rec);
        else if (ex.userId) skipped++;
        else toUpdate.push({ id: ex.studentId, patch: rec });
      } catch (e) { errors.push({ row: i + 1, message: e.message }); }
    });
    var now = U.now();
    Locks.with(function () {
      if (toCreate.length) Db.insertMany('StudentProfiles', toCreate.map(function (r) { return Object.assign({ studentId: U.id('student'), status: 'imported', createdAt: now, updatedAt: now }, r); }));
      toUpdate.forEach(function (u) { Db.update('StudentProfiles', u.id, Object.assign({ updatedAt: now }, u.patch)); });
      Audit.log({ actor: ctx.email, role: Auth.actorRole(ctx), action: 'students.import', entityType: 'StudentProfile', detail: { created: toCreate.length, updated: toUpdate.length, skipped: skipped, errors: errors.length } });
    });
    return { created: toCreate.length, updated: toUpdate.length, skipped: skipped, errors: errors };
  },

  // ---- photos (private Drive folder; only the server reads them) ------------------------------------
  _decodePhoto: function (dataUrl) {
    var m = /^data:image\/jpeg;base64,([A-Za-z0-9+\/=]+)$/.exec(String(dataUrl || ''));
    if (!m) fail('BAD_INPUT', 'Photo must be a JPEG image.');
    if (m[1].length > 560000) fail('BAD_INPUT', 'Photo is too large (max about 400 KB).');
    var bytes = Utilities.base64Decode(m[1]);
    if (!(bytes.length > 3 && (bytes[0] & 255) === 0xFF && (bytes[1] & 255) === 0xD8 && (bytes[2] & 255) === 0xFF)) fail('BAD_INPUT', 'That file is not a valid JPEG.');
    return bytes;
  },
  _storePhoto: function (profile, bytes) {
    var folder = Setup.folder(Cfg.PROP.PHOTO_FOLDER, 'LABFLOW Student Photos (private)');
    var file = folder.createFile(Utilities.newBlob(bytes, 'image/jpeg', profile.studentId + '.jpg'));
    var old = profile.photoFileId;
    Db.update('StudentProfiles', profile.studentId, { photoFileId: file.getId(), updatedAt: U.now() });
    if (old) { try { DriveApp.getFileById(old).setTrashed(true); } catch (e) {} }
    return file.getId();
  },
  setPhoto: function (ctx, p) {
    V.obj(p);
    var prof;
    if (p.studentId && (ctx.has('staff') || ctx.has('admin'))) prof = Db.mustGet('StudentProfiles', V.id(p.studentId, 'Student', 'student'), 'Student');
    else {
      if (!ctx.student) fail('NOT_FOUND', 'No student profile.');
      prof = ctx.student;
      // The photo is the reference for spot checks: once a profile is verified with a photo, only staff may change it.
      if (prof.photoFileId && prof.status === 'verified') fail('FORBIDDEN', 'Your verified photo can only be changed by lab staff. Visit the lab desk.');
    }
    Users._storePhoto(prof, Users._decodePhoto(p.photo));
    Audit.log({ actor: ctx.email, role: ctx.roles[0], action: 'photo.set', entityType: 'StudentProfile', entityId: prof.studentId });
    return { ok: true };
  },
  /**
   * Photos are personal data. Access is limited to: admin/staff (identity verification) and the faculty member
   * who owns a session with a PENDING spot check for this student. Every view is audited.
   */
  getPhoto: function (ctx, p) {
    V.obj(p);
    var studentId = V.id(p.studentId, 'Student', 'student');
    var allowed = ctx.has('admin') || ctx.has('staff');
    var detail = {};
    if (!allowed && ctx.has('faculty')) {
      var checks = Db.where('SpotChecks', function (c) { return c.studentId === studentId && c.outcome === 'pending'; });
      for (var i = 0; i < checks.length && !allowed; i++) {
        var ses = Db.get('Sessions', checks[i].sessionId);
        if (ses && Auth.ownsSession(ctx, ses)) { allowed = true; detail.checkId = checks[i].checkId; }
      }
    }
    if (!allowed) { Audit.tryLog({ actor: ctx.email, role: ctx.roles[0], action: 'photo.view', entityType: 'StudentProfile', entityId: studentId, result: 'denied' }); fail('FORBIDDEN', 'You cannot view this photo.'); }
    var prof = Db.mustGet('StudentProfiles', studentId, 'Student');
    if (!prof.photoFileId) return { dataUrl: null };
    var blob = DriveApp.getFileById(prof.photoFileId).getBlob();
    Audit.log({ actor: ctx.email, role: ctx.roles[0], action: 'photo.view', entityType: 'StudentProfile', entityId: studentId, detail: detail });
    return { dataUrl: 'data:image/jpeg;base64,' + Utilities.base64Encode(blob.getBytes()) };
  },

  // ---- administration of accounts ---------------------------------------------------------------------
  /** Names of active faculty, for choosing a research supervisor / group owner. Minimal fields only. */
  facultyDirectory: function (ctx) {
    var dept = Auth.scopedHod(ctx) ? Auth.department(ctx) : null;
    return { faculty: Db.where('FacultyProfiles', function (f) { return f.status === 'active' && (dept === null || !f.department || String(f.department).trim().toUpperCase() === dept); }).map(function (f) { return { facultyId: f.facultyId, name: f.name, department: f.department }; }).sort(function (a, b) { return a.name < b.name ? -1 : 1; }) };
  },

  listUsers: function (ctx) {
    var dept = Auth.scopedHod(ctx) ? Auth.department(ctx) : null, studentAllowed = Auth.studentFilter(ctx);
    var profiles = U.indexBy(Db.readAll('StudentProfiles').filter(function (s) { return s.userId; }), 'userId');
    return { users: Db.readAll('Users').filter(function (u) { return dept === null || (profiles[u.userId] ? studentAllowed(profiles[u.userId].studentId) : (!u.department || String(u.department).trim().toUpperCase() === dept)); }).map(function (u) {
      var o = Users._pubUser(u); if (profiles[u.userId]) o.rollNo = profiles[u.userId].rollNo; return o;
    }) };
  },

  _activeAdminCount: function (excludeUserId) {
    return Db.where('Users', function (u) { return u.userId !== excludeUserId && u.status === 'active' && String(u.roles).split(',').indexOf('admin') >= 0; }).length;
  },

  /** Create or update a staff/faculty/admin account. Role changes are audited with before and after. */
  upsertUser: function (ctx, p) {
    V.obj(p);
    var email = V.email(p.email);
    if (Auth.allowedDomains().indexOf(email.split('@')[1]) < 0) fail('BAD_INPUT', 'Email must be on an allowed domain.');
    var roles = U.uniq(V.arr(p.roles, 'Roles', 5).map(function (r) { return V.enumOf(r, 'Role', Cfg.ROLES); }));
    if (!roles.length) fail('BAD_INPUT', 'Choose at least one role.');
    var displayName = V.str(p.displayName, 'Name', { max: 80, min: 2 });
    var previous = Db.getBy('Users', 'email', email);
    var department = V.str(p.department === undefined ? (previous ? previous.department || '' : 'CSE') : p.department, 'Department', { optional: true, max: 60 }).trim().toUpperCase();
    var employeeCode = V.str(p.employeeCode, 'Employee code', { optional: true, max: 30 });
    var status = V.enumOf(p.status, 'Status', ['active', 'disabled'], { optional: true, def: 'active' });
    return Locks.with(function () {
      var now = U.now(), ex = Db.getBy('Users', 'email', email), user, before = ex ? String(ex.roles) : '';
      // Last-admin protection: an active admin may not lose the role / be disabled if no other active admin remains.
      var wasAdmin = ex && ex.status === 'active' && String(ex.roles).split(',').indexOf('admin') >= 0;
      var staysAdmin = roles.indexOf('admin') >= 0 && status === 'active';
      if (wasAdmin && !staysAdmin && Users._activeAdminCount(ex.userId) === 0) fail('LAST_ADMIN', 'This is the only administrator. Add another admin before removing or disabling this one.');
      if (ex) user = Db.update('Users', ex.userId, { displayName: displayName, department: department, roles: roles.join(','), status: status, updatedAt: now });
      else user = Db.insert('Users', { userId: U.id('user'), email: email, displayName: displayName, department: department, roles: roles.join(','), status: status, createdAt: now, updatedAt: now });
      if (roles.indexOf('faculty') >= 0) {
        var fp = Db.getBy('FacultyProfiles', 'userId', user.userId);
        if (fp) Db.update('FacultyProfiles', fp.facultyId, { name: displayName, department: department, employeeCode: employeeCode || fp.employeeCode, email: email, status: status === 'active' ? 'active' : 'disabled' });
        else Db.insert('FacultyProfiles', { facultyId: U.id('faculty'), userId: user.userId, email: email, name: displayName, department: department, employeeCode: employeeCode, status: 'active', createdAt: now });
      }
      Audit.log({ actor: ctx.email, role: 'admin', action: ex ? (before !== roles.join(',') ? 'role.change' : 'user.update') : 'user.create', entityType: 'User', entityId: user.userId,
                  detail: { email: email, rolesBefore: before, rolesAfter: roles.join(','), status: status, department: user.department } });
      return { user: Users._pubUser(user) };
    });
  },

  setUserStatus: function (ctx, p) {
    V.obj(p);
    var userId = V.id(p.userId, 'User', 'user');
    var status = V.enumOf(p.status, 'Status', ['active', 'disabled']);
    var reason = V.str(p.reason, 'Reason', { optional: true, max: 200 });
    return Locks.with(function () {
      var u = Db.mustGet('Users', userId, 'User');
      if (status === 'disabled' && String(u.roles).split(',').indexOf('admin') >= 0 && Users._activeAdminCount(userId) === 0) fail('LAST_ADMIN', 'Cannot disable the only administrator.');
      var next = Db.update('Users', userId, { status: status, updatedAt: U.now() });
      Audit.log({ actor: ctx.email, role: 'admin', action: 'user.status', entityType: 'User', entityId: userId, detail: { email: u.email, status: status, reason: reason } });
      return { user: Users._pubUser(next) };
    });
  },

  importUsers: function (ctx, p) {
    V.obj(p);
    var rows = V.arr(p.rows, 'Rows', 200), ok = 0, errors = [];
    rows.forEach(function (r, i) {
      try {
        V.obj(r);
        var roles = String(r.roles || r.role || '').split(/[;,|\s]+/).filter(Boolean);
        Users.upsertUser(ctx, { email: r.email, displayName: r.name || r.displayName, roles: roles, department: r.department, employeeCode: r.employeeCode, status: 'active' });
        ok++;
      } catch (e) { errors.push({ row: i + 1, message: e.message }); }
    });
    return { imported: ok, errors: errors };
  }
};
