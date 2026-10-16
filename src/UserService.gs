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
  _pubStudent: function (p) {
    if (!p) return null;
    return { studentId: p.studentId, rollNo: p.rollNo, name: p.name, department: p.department, section: p.section, year: p.year,
             status: p.status, email: p.email, hasPhoto: !!p.photoFileId };
  },
  _pubUser: function (u) { return { userId: u.userId, email: u.email, displayName: u.displayName, roles: String(u.roles || '').split(',').filter(Boolean), status: u.status, lastLoginAt: u.lastLoginAt }; },

  me: function (ctx) {
    var s = Settings.all(), sid = ctx.student ? ctx.student.studentId : null;
    var reps = sid ? Db.where('ClassReps', function (r) { return r.status === 'active' && r.studentId === sid; }).length : 0;
    var coordinating = Db.where('Events', function (e) { return e.status === 'active' && e.coordinatorEmail === ctx.email && e.endAt + s.eventCoordinatorGraceMinutes * 60000 >= U.now(); }).length;
    return {
      email: ctx.email,
      userId: ctx.user ? ctx.user.userId : null,
      displayName: ctx.user ? ctx.user.displayName : ctx.email.split('@')[0],
      roles: ctx.roles,
      onboardingRequired: !ctx.user || (ctx.has('student') && !ctx.student),
      consentRequired: !ctx.kiosk && Users.consentRequired(ctx.user),
      profileIncomplete: !!ctx.user && s.requireMobile && !ctx.user.mobile,
      mobile: ctx.user ? ctx.user.mobile || '' : '',
      derivedRollNo: !ctx.student ? Users.derivedRoll(ctx.email) : '',
      classRep: reps > 0, coordinating: coordinating,
      student: ctx.student ? Object.assign(Users._pubStudent(ctx.student), { credential: Creds.summaryFor(ctx.student.studentId) }) : null,
      faculty: ctx.faculty ? { facultyId: ctx.faculty.facultyId, name: ctx.faculty.name, department: ctx.faculty.department } : null,
      kiosk: ctx.kiosk ? { kioskId: ctx.kiosk.kioskId, labId: ctx.kiosk.labId, name: ctx.kiosk.name } : null,
      settings: { qrTtlSeconds: s.qrTtlSeconds, rescanWindowSeconds: s.rescanWindowSeconds, exitGraceMinutes: s.exitGraceMinutes,
                  requireExitScan: s.requireExitScan, loanDefaultDays: s.loanDefaultDays, bookingMaxAdvanceDays: s.bookingMaxAdvanceDays,
                  bookingMaxDays: s.bookingMaxDays, studentQrRotateSeconds: s.studentQrRotateSeconds, qrFreshSeconds: s.qrFreshSeconds,
                  occupancyRefreshSeconds: s.occupancyRefreshSeconds, defaultCheckinMode: s.defaultCheckinMode, requireMobile: s.requireMobile,
                  requireCheckinForRequests: s.requireCheckinForRequests, minScanGapSeconds: s.minScanGapSeconds },
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
    if (p.mobile !== undefined) { patch.mobile = V.mobile(p.mobile); detail.mobile = 'updated'; }
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
    var mobile = Settings.get('requireMobile') || p.mobile ? V.mobile(p.mobile) : '';
    var name = V.str(p.name, 'Name', { max: 80, min: 2 });
    var department = V.str(p.department, 'Department', { optional: true, max: 60, def: 'CSE' });
    var section = V.str(p.section, 'Section', { optional: true, max: 10 });
    var year = V.int(p.year, 'Year', 1, 6, { optional: true, def: null });
    var photo = p.photo ? Users._decodePhoto(p.photo) : null;

    var profile = Locks.with(function () {
      var now = U.now();
      var user = ctx.user;
      if (!user) {
        user = Db.insert('Users', { userId: U.id('user'), email: ctx.email, displayName: name, roles: 'student', status: 'active', createdAt: now, updatedAt: now,
          mobile: mobile, consentAt: now, consentVersion: Cfg.CONSENT_VERSION });
      } else {
        user = Db.update('Users', user.userId, { mobile: mobile || user.mobile, consentAt: now, consentVersion: Cfg.CONSENT_VERSION, updatedAt: now });
      }
      var existing = Db.getBy('StudentProfiles', 'rollNo', rollNo);
      var out;
      if (existing) {
        if (existing.userId && existing.userId !== user.userId) fail('ROLL_TAKEN', 'This roll number is already linked to another account. Contact the lab office if this is a mistake.');
        if (existing.status !== 'imported' && existing.status !== 'rejected' && existing.userId !== user.userId) fail('ROLL_TAKEN', 'This roll number already has a pending claim. Contact the lab office.');
        // Verified automatically when the admin imported this roll number with this email, or when the roll number IS the email.
        var matches = existing.importedEmail ? existing.importedEmail === ctx.email : !!derived;
        out = Db.update('StudentProfiles', existing.studentId, {
          userId: user.userId, email: ctx.email, name: name, department: department || existing.department, section: section || existing.section,
          year: year !== null ? year : existing.year, status: matches ? 'verified' : 'pending',
          verifiedBy: matches ? (existing.importedEmail ? 'import-email-match' : 'email-roll-match') : '', verifiedAt: matches ? now : null, updatedAt: now
        });
      } else {
        out = Db.insert('StudentProfiles', { studentId: U.id('student'), userId: user.userId, email: ctx.email, importedEmail: '', rollNo: rollNo, name: name,
          department: department, section: section, year: year, status: derived ? 'verified' : 'pending', verifiedBy: derived ? 'email-roll-match' : '', verifiedAt: derived ? now : null, createdAt: now, updatedAt: now });
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
    var prof = Db.mustGet('StudentProfiles', studentId, 'Student');
    if (prof.status === 'disabled') fail('INVALID_STATE', 'This profile is disabled.');
    if (!prof.userId) fail('INVALID_STATE', 'This profile has not been claimed by a student yet.');
    var next = Db.update('StudentProfiles', studentId, approve
      ? { status: 'verified', verifiedBy: ctx.email, verifiedAt: U.now(), updatedAt: U.now() }
      : { status: 'rejected', verifiedBy: ctx.email, verifiedAt: U.now(), updatedAt: U.now() });
    Audit.log({ actor: ctx.email, role: ctx.has('admin') ? 'admin' : 'staff', action: approve ? 'student.verify' : 'student.reject', entityType: 'StudentProfile', entityId: studentId, detail: { rollNo: prof.rollNo, note: note } });
    if (prof.userId) Notify.toUser(prof.userId, 'verification', approve ? 'Profile verified' : 'Profile not verified', approve ? 'Your student profile is verified. You can now register your device.' : 'Your profile could not be verified. ' + (note || 'Visit the lab office.'), 'verifyres:' + studentId + ':' + next.status);
    return { student: Users._pubStudent(next) };
  },

  /** Admin: detach an account from a profile (wrong account claimed it). Revokes the student's device credentials. */
  unlinkStudent: function (ctx, p) {
    V.obj(p);
    var studentId = V.id(p.studentId, 'Student', 'student');
    var reason = V.str(p.reason, 'Reason', { min: 5, max: 200 });
    var prof = Db.mustGet('StudentProfiles', studentId, 'Student');
    Creds.revokeAllFor(studentId, ctx.email, 'profile unlinked: ' + reason);
    var next = Db.update('StudentProfiles', studentId, { userId: '', email: '', status: 'imported', verifiedBy: '', verifiedAt: null, updatedAt: U.now() });
    Audit.log({ actor: ctx.email, role: 'admin', action: 'student.unlink', entityType: 'StudentProfile', entityId: studentId, detail: { rollNo: prof.rollNo, previousUserId: prof.userId, reason: reason } });
    return { student: Users._pubStudent(next) };
  },

  /** Staff/admin/faculty student directory. Faculty only see students in their own courses. */
  listStudents: function (ctx, p) {
    p = p || {};
    var q = V.str(p.q, 'Search', { optional: true, max: 60 }).toLowerCase();
    var status = V.enumOf(p.status, 'Status', ['imported', 'pending', 'verified', 'rejected', 'disabled'], { optional: true });
    var limit = V.int(p.limit, 'Limit', 1, 500, { optional: true, def: 100 });
    var rows = Db.readAll('StudentProfiles');
    if (!ctx.has('admin') && !ctx.has('staff')) {
      var allowed = Roster.studentIdsForFaculty(ctx.faculty ? ctx.faculty.facultyId : '');
      rows = rows.filter(function (r) { return allowed[r.studentId]; });
    }
    rows = rows.filter(function (r) {
      if (status && r.status !== status) return false;
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
        var rec = { rollNo: rollNo, name: V.str(raw.name, 'Name', { max: 80, min: 2 }), importedEmail: email,
                    department: V.str(raw.department, 'Department', { optional: true, max: 60, def: 'CSE' }), section: V.str(raw.section, 'Section', { optional: true, max: 10 }),
                    year: V.int(raw.year, 'Year', 1, 6, { optional: true, def: null }) };
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
      Audit.log({ actor: ctx.email, role: 'admin', action: 'students.import', entityType: 'StudentProfile', detail: { created: toCreate.length, updated: toUpdate.length, skipped: skipped, errors: errors.length } });
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
  facultyDirectory: function () {
    return { faculty: Db.where('FacultyProfiles', function (f) { return f.status === 'active'; }).map(function (f) { return { facultyId: f.facultyId, name: f.name, department: f.department }; }).sort(function (a, b) { return a.name < b.name ? -1 : 1; }) };
  },

  listUsers: function () {
    var profiles = U.indexBy(Db.readAll('StudentProfiles').filter(function (s) { return s.userId; }), 'userId');
    return { users: Db.readAll('Users').map(function (u) {
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
    var roles = U.uniq(V.arr(p.roles, 'Roles', 4).map(function (r) { return V.enumOf(r, 'Role', Cfg.ROLES); }));
    if (!roles.length) fail('BAD_INPUT', 'Choose at least one role.');
    var displayName = V.str(p.displayName, 'Name', { max: 80, min: 2 });
    var department = V.str(p.department, 'Department', { optional: true, max: 60, def: 'CSE' });
    var employeeCode = V.str(p.employeeCode, 'Employee code', { optional: true, max: 30 });
    var status = V.enumOf(p.status, 'Status', ['active', 'disabled'], { optional: true, def: 'active' });
    return Locks.with(function () {
      var now = U.now(), ex = Db.getBy('Users', 'email', email), user, before = ex ? String(ex.roles) : '';
      // Last-admin protection: an active admin may not lose the role / be disabled if no other active admin remains.
      var wasAdmin = ex && ex.status === 'active' && String(ex.roles).split(',').indexOf('admin') >= 0;
      var staysAdmin = roles.indexOf('admin') >= 0 && status === 'active';
      if (wasAdmin && !staysAdmin && Users._activeAdminCount(ex.userId) === 0) fail('LAST_ADMIN', 'This is the only administrator. Add another admin before removing or disabling this one.');
      if (ex) user = Db.update('Users', ex.userId, { displayName: displayName, roles: roles.join(','), status: status, updatedAt: now });
      else user = Db.insert('Users', { userId: U.id('user'), email: email, displayName: displayName, roles: roles.join(','), status: status, createdAt: now, updatedAt: now });
      if (roles.indexOf('faculty') >= 0) {
        var fp = Db.getBy('FacultyProfiles', 'userId', user.userId);
        if (fp) Db.update('FacultyProfiles', fp.facultyId, { name: displayName, department: department, employeeCode: employeeCode || fp.employeeCode, email: email, status: status === 'active' ? 'active' : 'disabled' });
        else Db.insert('FacultyProfiles', { facultyId: U.id('faculty'), userId: user.userId, email: email, name: displayName, department: department, employeeCode: employeeCode, status: 'active', createdAt: now });
      }
      Audit.log({ actor: ctx.email, role: 'admin', action: ex ? (before !== roles.join(',') ? 'role.change' : 'user.update') : 'user.create', entityType: 'User', entityId: user.userId,
                  detail: { email: email, rolesBefore: before, rolesAfter: roles.join(','), status: status } });
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
