/**
 * Config.gs - constants, the Google Sheets schema and the admin-editable settings catalogue.
 *
 * Schema DSL: each table is a space-separated list of column tokens  name[:type[:flags]]
 *   type  s = text (default), n = number, b = boolean, j = JSON stored as text
 *   flags u = unique (empty values ignored), c = lookup column that is cached (see Db.cachedGet)
 * The FIRST column of every table is its primary key (always unique and cacheable).
 * Rows are never deleted: records are soft-deleted via a status column so row numbers stay stable
 * and history is preserved.
 */
var Cfg = (function () {
  var TZ = 'Asia/Kolkata';
  var TZ_OFFSET_MIN = 330; // India has no DST, so a fixed offset is exact.

  var ROLES = ['student', 'faculty', 'staff', 'admin'];
  var DEFAULT_ALLOWED_DOMAINS = ['karunya.edu', 'karunya.edu.in'];

  var SCHEMA_SRC = {
    Config: 'key value updatedBy updatedAt:n',
    Users: 'userId email:s:u:c displayName roles status createdAt:n updatedAt:n lastLoginAt:n',
    StudentProfiles: 'studentId userId:s:c email:s:c importedEmail rollNo:s:u:c name department section year:n photoFileId status verifiedBy verifiedAt:n createdAt:n updatedAt:n',
    FacultyProfiles: 'facultyId userId:s:c email:s:c name department employeeCode status createdAt:n',
    Labs: 'labId code:s:u name type building room capacity:n status notes createdAt:n',
    Kiosks: 'kioskId labId name authorizedEmail:s:u:c status lastSeenAt:n createdAt:n revokedAt:n',
    Courses: 'courseId code:s:u name department semester status createdAt:n',
    Rosters: 'rosterId scopeType scopeId studentId status addedBy addedAt:n',
    FacultyCourses: 'mapId facultyId courseId section term status createdAt:n',
    Timetable: 'slotId labId courseId facultyId section dayOfWeek:n startTime endTime validFrom validTo status createdAt:n',
    Sessions: 'sessionId type labId courseId facultyId title slotId slotKey:s:u section date scheduledStart:n scheduledEnd:n status openedAt:n openedBy closedAt:n closedBy closeReason openToAll:b rescanMode nextRescanAt:n rescansDone:n requestedBy approvedBy approvedAt:n notes createdBy createdAt:n',
    AttendanceEvents: 'eventId sessionId labId studentId type source kioskId credentialId nonce at:n recordedBy reason approvalStatus approvedBy ref createdAt:n',
    AttendanceSummaries: 'sumId sessionId studentId status firstIn:n lastOut:n verifiedUntil:n verifiedMinutes:n flags:j computedAt:n',
    SpotChecks: 'checkId sessionId studentId requestedBy requestedAt:n outcome resolvedBy resolvedAt:n note',
    RescanWindows: 'windowId sessionId kind openedAt:n closesAt:n openedBy status',
    DeviceCredentials: 'credentialId studentId:s:c userEmail publicKey:s:u alg label status replacesCredentialId createdAt:n approvedBy approvedAt:n revokedAt:n revokedBy revokeReason lastUsedAt:n',
    Redemptions: 'nonce purpose studentId sessionId kioskId at:n eventId',
    Categories: 'categoryId name:s:u trackingMode notes',
    Assets: 'assetId labId categoryId name serialNo assetTag:s:u trackingMode quantityTotal:n quantityAvailable:n status condition location valueInr:n currentLoanId notes createdAt:n updatedAt:n',
    Kits: 'kitId labId name description status createdAt:n',
    KitComponents: 'componentId kitId categoryId quantity:n note',
    Groups: 'groupId name courseId labId status createdBy createdAt:n',
    GroupMembers: 'groupMemberId groupId studentId isLeader:b addedAt:n',
    Loans: 'loanId labId borrowerType borrowerId kitId reservationId status issuedBy issuedAt:n dueAt:n returnedAt:n verifiedBy notes idemKey:s:u',
    LoanItems: 'loanItemId loanId assetId categoryId qtyIssued:n qtyReturned:n qtyConsumed:n qtyDamaged:n qtyMissing:n conditionOut conditionIn status note',
    AssetEvents: 'txId assetId loanId type qtyDelta:n at:n by note idemKey:s:u',
    Reservations: 'reservationId labId resourceType resourceId quantity:n requesterType requesterId requestedBy startAt:n endAt:n status purpose requestedAt:n decidedBy decidedAt:n decisionNote cancelledAt:n',
    Notifications: 'notificationId userId type title body createdAt:n readAt:n emailStatus dedupeKey:s:u',
    AuditEvents: 'seq:n eventId at:n actor role action entityType entityId result detail:j prevHash hash',
    AuditCheckpoints: 'checkpointId seq:n hash at:n note',
    SystemLog: 'logId at:n level source code message detail:j',
    JobRuns: 'runId job startedAt:n finishedAt:n status detail:j'
  };

  var SCHEMA = {};
  Object.keys(SCHEMA_SRC).forEach(function (table) {
    SCHEMA[table] = SCHEMA_SRC[table].split(' ').map(function (tok, i) {
      var p = tok.split(':');
      var flags = p.slice(2).join(''); // 'u:c' must give both flags
      return {
        name: p[0],
        type: p[1] || 's',
        unique: i === 0 || flags.indexOf('u') >= 0,
        cache: i === 0 || flags.indexOf('c') >= 0,
        pk: i === 0
      };
    });
  });

  /** Admin-editable settings. Stored in the Config sheet; validated against this catalogue. */
  var SETTINGS = {
    qrTtlSeconds: { type: 'int', def: 60, min: 20, max: 180, desc: 'Lifetime of a student QR before it expires (seconds).' },
    exitGraceMinutes: { type: 'int', def: 15, min: 0, max: 120, desc: 'Exit scans are still accepted this long after a session is closed.' },
    autoCloseGraceMinutes: { type: 'int', def: 30, min: 5, max: 240, desc: 'Open sessions are auto-closed this long after their scheduled end.' },
    rescanMode: { type: 'enum', def: 'random', values: ['off', 'random'], desc: 'Default mid-session rescan policy for new sessions.' },
    rescanWindowMinutes: { type: 'int', def: 10, min: 2, max: 60, desc: 'How long a rescan window stays open.' },
    rescanMinFraction: { type: 'int', def: 25, min: 5, max: 90, desc: 'Earliest random rescan, as % of the session length.' },
    rescanMaxFraction: { type: 'int', def: 85, min: 10, max: 95, desc: 'Latest random rescan, as % of the session length.' },
    spotCheckDefaultCount: { type: 'int', def: 3, min: 1, max: 20, desc: 'Students picked per random photo spot check.' },
    credentialMaxActive: { type: 'int', def: 1, min: 1, max: 3, desc: 'Active device credentials allowed per student.' },
    requireExitScan: { type: 'bool', def: true, desc: 'Verified duration requires an exit scan.' },
    correctionApprovalAfterHours: { type: 'int', def: 24, min: 0, max: 720, desc: 'Corrections to sessions older than this need admin approval.' },
    loanDefaultDays: { type: 'int', def: 7, min: 1, max: 120, desc: 'Default loan period.' },
    maxOpenLoansPerBorrower: { type: 'int', def: 3, min: 1, max: 20, desc: 'Open loans allowed per student or group.' },
    blockLoansWhenOverdue: { type: 'bool', def: true, desc: 'Block new loans while the borrower has overdue items.' },
    bookingMaxAdvanceDays: { type: 'int', def: 14, min: 1, max: 180, desc: 'How far ahead a booking may start.' },
    bookingMaxDays: { type: 'int', def: 7, min: 1, max: 60, desc: 'Longest booking duration.' },
    bookingMaxActivePerRequester: { type: 'int', def: 3, min: 1, max: 20, desc: 'Active bookings per student or group.' },
    bookingHoldPending: { type: 'bool', def: true, desc: 'Pending requests reserve stock until decided.' },
    emailEnabled: { type: 'bool', def: true, desc: 'Send email notifications.' },
    emailDailyReserve: { type: 'int', def: 50, min: 0, max: 500, desc: 'Mail quota kept in reserve; sending stops below this.' },
    reportRecipients: { type: 'str', def: '', desc: 'Comma-separated emails that receive scheduled reports.' },
    auditCheckpointEvery: { type: 'int', def: 50, min: 5, max: 1000, desc: 'Store an audit checkpoint every N audit events.' }
  };

  var LAB_TYPES = ['iot', 'computing', 'gpu', 'research', 'other'];
  var SESSION_TYPES = ['class', 'event', 'research'];
  var CONDITIONS = ['good', 'fair', 'poor', 'damaged'];

  return {
    TZ: TZ, TZ_OFFSET_MIN: TZ_OFFSET_MIN, ROLES: ROLES, DEFAULT_ALLOWED_DOMAINS: DEFAULT_ALLOWED_DOMAINS,
    SCHEMA: SCHEMA, SETTINGS: SETTINGS, LAB_TYPES: LAB_TYPES, SESSION_TYPES: SESSION_TYPES, CONDITIONS: CONDITIONS,
    ID_PREFIX: {
      user: 'USR', student: 'STU', faculty: 'FAC', lab: 'LAB', kiosk: 'KSK', course: 'CRS', roster: 'RST', map: 'FCM',
      slot: 'SLT', session: 'SES', event: 'EVT', spot: 'SPC', window: 'RSW', cred: 'CRD', category: 'CAT', asset: 'AST',
      kit: 'KIT', component: 'KCP', group: 'GRP', member: 'GMB', loan: 'LON', loanItem: 'LIT', tx: 'TXN',
      reservation: 'RSV', notification: 'NTF', audit: 'AUD', checkpoint: 'CHK', log: 'LOG', run: 'RUN'
    },
    /** Script-property keys (secrets and deployment configuration; never stored in a sheet). */
    PROP: { DB_ID: 'DB_SPREADSHEET_ID', HMAC: 'QR_HMAC_SECRET', BOOTSTRAP_ADMIN: 'BOOTSTRAP_ADMIN_EMAIL', DOMAINS: 'ALLOWED_DOMAINS',
            AUDIT_HEAD: 'AUDIT_HEAD', PHOTO_FOLDER: 'PHOTO_FOLDER_ID', REPORT_FOLDER: 'REPORT_FOLDER_ID', EMAIL_TRANSPORT: 'EMAIL_TRANSPORT' }
  };
})();

/** Settings accessors. Values come from the Config sheet, falling back to the catalogue default. */
var Settings = {
  _memo: null,
  all: function () {
    if (Settings._memo) return Settings._memo;
    var out = {};
    Object.keys(Cfg.SETTINGS).forEach(function (k) { out[k] = Cfg.SETTINGS[k].def; });
    try {
      var cache = CacheService.getScriptCache().get('settings');
      var rows = cache ? JSON.parse(cache) : null;
      if (!rows) {
        rows = Db.readAll('Config').map(function (r) { return { key: r.key, value: r.value }; });
        CacheService.getScriptCache().put('settings', JSON.stringify(rows), 120);
      }
      rows.forEach(function (r) {
        var def = Cfg.SETTINGS[r.key];
        if (def) out[r.key] = Settings.coerce(def, r.value, def.def);
      });
    } catch (e) { /* before Setup has run, defaults apply */ }
    Settings._memo = out;
    return out;
  },
  get: function (key) { return Settings.all()[key]; },
  coerce: function (def, raw, fallback) {
    if (def.type === 'int') { var n = parseInt(raw, 10); return isNaN(n) ? fallback : Math.min(def.max, Math.max(def.min, n)); }
    if (def.type === 'bool') { return raw === true || raw === 'true' || raw === 'TRUE'; }
    if (def.type === 'enum') { return def.values.indexOf(String(raw)) >= 0 ? String(raw) : fallback; }
    return raw == null ? fallback : String(raw);
  },
  reset: function () { Settings._memo = null; try { CacheService.getScriptCache().remove('settings'); } catch (e) {} }
};
