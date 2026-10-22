/**
 * Config.gs - constants, the Google Sheets schema and the admin-editable settings catalogue.
 *
 * Schema DSL: each table is a space-separated list of column tokens  name[:type[:flags]]
 *   type  s = text (default), n = number, b = boolean, j = JSON stored as text
 *   flags u = unique (empty values ignored), c = lookup column that is cached (see Db.cachedGet)
 * The FIRST column of every table is its primary key (always unique and cacheable).
 * Rows are never deleted: records are soft-deleted via a status column so row numbers stay stable
 * and history is preserved.
 *
 * Schema changes must be additive: new columns go at the END of a table, so Setup.initialise() can extend an
 * existing sheet without touching the data already in it.
 */
var Cfg = (function () {
  var TZ = 'Asia/Kolkata';
  var TZ_OFFSET_MIN = 330; // India has no DST, so a fixed offset is exact.

  var ROLES = ['student', 'faculty', 'staff', 'admin', 'hod'];
  var DEFAULT_ALLOWED_DOMAINS = ['karunya.edu', 'karunya.edu.in'];

  var SCHEMA_SRC = {
    Users: 'userId email:s:u:c displayName roles status createdAt:n updatedAt:n lastLoginAt:n mobile consentAt:n consentVersion department',
    StudentProfiles: 'studentId userId:s:c email:s:c importedEmail rollNo:s:u:c name department section year:n photoFileId status verifiedBy verifiedAt:n createdAt:n updatedAt:n joinYear:n',
    FacultyProfiles: 'facultyId userId:s:c email:s:c name department employeeCode status createdAt:n',
    Labs: 'labId code:s:u name type building room capacity:n status notes createdAt:n latitude:n longitude:n radiusM:n openTime closeTime checkinMode inchargeEmails department openLab:b',
    Kiosks: 'kioskId labId name authorizedEmail:s:u:c status lastSeenAt:n createdAt:n revokedAt:n',
    Courses: 'courseId code:s:u name department semester status createdAt:n',
    Rosters: 'rosterId scopeType scopeId studentId status addedBy addedAt:n',
    FacultyCourses: 'mapId facultyId courseId section term status createdAt:n',
    ClassReps: 'repId courseId section studentId status assignedBy assignedAt:n',
    Timetable: 'slotId labId courseId facultyId section dayOfWeek:n startTime endTime validFrom validTo status createdAt:n',
    Events: 'labEventId name labId coordinatorEmail:s:c startAt:n endAt:n breakStart:n breakEnd:n capacity:n sessionId status description createdBy createdAt:n',
    EventGuests: 'guestId labEventId name organisation addedBy addedAt:n',
    Sessions: 'sessionId type labId courseId facultyId title slotId slotKey:s:u section date scheduledStart:n scheduledEnd:n status openedAt:n openedBy closedAt:n closedBy closeReason openToAll:b rescanMode nextRescanAt:n rescansDone:n requestedBy approvedBy approvedAt:n notes createdBy createdAt:n labEventId breakStart:n breakEnd:n archivedAt:n checkinMode',
    AttendanceEvents: 'eventId sessionId labId studentId type source kioskId credentialId nonce at:n recordedBy reason approvalStatus approvedBy ref createdAt:n mode method scannedBy scannerRole geofence distanceM:n accuracyM:n entryReason assurance projectId assetId outcome',
    AttendanceSummaries: 'sumId sessionId studentId status firstIn:n lastOut:n verifiedUntil:n verifiedMinutes:n flags:j computedAt:n',
    SpotChecks: 'checkId sessionId studentId requestedBy requestedAt:n outcome resolvedBy resolvedAt:n note',
    RescanWindows: 'windowId sessionId kind openedAt:n closesAt:n openedBy status',
    DeviceCredentials: 'credentialId studentId:s:c userEmail publicKey:s:u alg label status replacesCredentialId createdAt:n approvedBy approvedAt:n revokedAt:n revokedBy revokeReason lastUsedAt:n kind bioPublicKey',
    Redemptions: 'nonce purpose studentId sessionId kioskId at:n eventId',
    Flags: 'flagId type severity studentId sessionId labId detail:j status createdAt:n resolvedBy resolvedAt:n note dedupeKey:s:u',
    Categories: 'categoryId name:s:u trackingMode notes workstation:b',
    Assets: 'assetId labId categoryId name serialNo assetTag:s:u trackingMode quantityTotal:n quantityAvailable:n status condition location valueInr:n currentLoanId notes createdAt:n updatedAt:n',
    Kits: 'kitId labId name description status createdAt:n',
    KitComponents: 'componentId kitId categoryId quantity:n note',
    Groups: 'groupId name courseId labId status createdBy createdAt:n',
    GroupMembers: 'groupMemberId groupId studentId isLeader:b addedAt:n',
    Loans: 'loanId labId borrowerType borrowerId kitId reservationId status issuedBy issuedAt:n dueAt:n returnedAt:n verifiedBy notes idemKey:s:u',
    LoanItems: 'loanItemId loanId assetId categoryId qtyIssued:n qtyReturned:n qtyConsumed:n qtyDamaged:n qtyMissing:n conditionOut conditionIn status note',
    AssetEvents: 'txId assetId loanId type qtyDelta:n at:n by note idemKey:s:u',
    Reservations: 'reservationId labId resourceType resourceId quantity:n requesterType requesterId requestedBy startAt:n endAt:n status purpose requestedAt:n decidedBy decidedAt:n decisionNote cancelledAt:n usedAt:n projectId waitlistedAt:n',
    EquipmentRequests: 'requestId labId sessionId studentId resourceType resourceId quantity:n note status requestedAt:n decidedBy decidedAt:n decisionNote loanId',
    Notifications: 'notificationId userId type title body createdAt:n readAt:n emailStatus dedupeKey:s:u',
    AuditEvents: 'seq:n eventId at:n actor role action entityType entityId result detail:j prevHash hash',
    AuditCheckpoints: 'checkpointId seq:n hash at:n note',
    SystemLog: 'logId at:n level source code message detail:j',
    JobRuns: 'runId job startedAt:n finishedAt:n status detail:j',
    PresencePings: 'pingId sessionId studentId credentialId source seq:n at:n receivedAt:n inLab:b distanceM:n accuracyM:n mock:b posKey verdict',
    BioChecks: 'bioId slotKey:s:u sessionId studentId kind dueAt:n deliveredAt:n deadline:n respondedAt:n outcome requestedBy nonce',
    Projects: 'projectId title description ownerStudentId groupId supervisorFacultyId labId startDate endDate status outcome outcomeLink outcomeAt:n approvedBy approvedAt:n createdAt:n updatedAt:n'
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

  /**
   * Admin-editable settings, stored in script properties (PropertiesService) as "cfg.<key>" and validated against
   * this catalogue. `group` only decides where the admin screen shows them.
   */
  var SETTINGS = {
    // attendance, both modes
    defaultCheckinMode: { group: 'Attendance', type: 'enum', def: 'A', values: ['A', 'B', 'AB'], desc: 'Check-in mode for labs that do not set their own. A = kiosk QR + GPS (the spec), B = device-signed student QR scanned in the room, AB = both.' },
    autoOpenSessions: { group: 'Attendance', type: 'bool', def: true, desc: 'Timetabled class sessions open by themselves at their start time.' },
    requireExitScan: { group: 'Attendance', type: 'bool', def: true, desc: 'Verified hours need an exit scan. Without one the student gets "unverified exit".' },
    minScanGapSeconds: { group: 'Attendance', type: 'int', def: 120, min: 0, max: 1800, desc: 'Minimum time between check-in and check-out, so an accidental double scan does not check a student out.' },
    exitGraceMinutes: { group: 'Attendance', type: 'int', def: 15, min: 0, max: 120, desc: 'Exit scans are still accepted this long after a session is closed.' },
    autoCloseGraceMinutes: { group: 'Attendance', type: 'int', def: 30, min: 5, max: 240, desc: 'Open sessions are auto-closed this long after their scheduled end.' },
    rescanMode: { group: 'Attendance', type: 'enum', def: 'off', values: ['off', 'random'], desc: 'Default mid-session rescan policy for new sessions. Off = rescans only when the faculty (or a class rep) calls one; random = the server also plans one at an unannounced time.' },
    rescanWindowSeconds: { group: 'Attendance', type: 'int', def: 90, min: 30, max: 3600, desc: 'How long a rescan window stays open (the SRS uses 90 seconds).' },
    rescanMinFraction: { group: 'Attendance', type: 'int', def: 25, min: 5, max: 90, desc: 'Earliest random rescan, as % of the session length.' },
    rescanMaxFraction: { group: 'Attendance', type: 'int', def: 85, min: 10, max: 95, desc: 'Latest random rescan, as % of the session length.' },
    spotCheckDefaultCount: { group: 'Attendance', type: 'int', def: 5, min: 1, max: 20, desc: 'Students picked per random photo spot check.' },
    correctionApprovalAfterHours: { group: 'Attendance', type: 'int', def: 24, min: 0, max: 720, desc: 'Corrections to sessions older than this need admin approval.' },

    // Version A: kiosk QR + GPS geofence
    kioskQrIntervalSeconds: { group: 'Kiosk QR + GPS (A)', type: 'int', def: 7, min: 5, max: 10, desc: 'The kiosk QR changes this often (FR-7).' },
    kioskCodeMaxAgeSeconds: { group: 'Kiosk QR + GPS (A)', type: 'int', def: 30, min: 10, max: 120, desc: 'A kiosk code is accepted for this long after it was shown, to cover camera and page-load time.' },
    kioskPassMinutes: { group: 'Kiosk QR + GPS (A)', type: 'int', def: 2, min: 1, max: 5, desc: 'After the page opens, the student has this long to finish checking in (FR-9).' },
    defaultGeofenceRadiusM: { group: 'Kiosk QR + GPS (A)', type: 'int', def: 20, min: 5, max: 500, desc: 'Geofence radius for labs that do not set their own (metres).' },
    gpsAccuracyAllowanceM: { group: 'Kiosk QR + GPS (A)', type: 'int', def: 30, min: 0, max: 100, desc: 'Up to this much of the phone\'s reported GPS error is forgiven, so indoor error does not reject a student in the lab (FR-12).' },
    minPlausibleAccuracyM: { group: 'Kiosk QR + GPS (A)', type: 'int', def: 2, min: 0, max: 20, desc: 'Readings claiming better accuracy than this are impossible for a phone browser and are rejected (FR-30).' },
    geoUnavailablePolicy: { group: 'Kiosk QR + GPS (A)', type: 'enum', def: 'allow_flagged', values: ['allow_flagged', 'reject'], desc: 'When the phone cannot give a location: accept the check-in with geofence "not available" and a flag, or refuse it.' },
    maxTravelSpeedKmh: { group: 'Kiosk QR + GPS (A)', type: 'int', def: 15, min: 3, max: 200, desc: 'Consecutive check-ins at two labs implying a faster speed are flagged as impossible travel (FR-29).' },

    // Version B: device-signed QR
    qrTtlSeconds: { group: 'Device QR (B)', type: 'int', def: 60, min: 20, max: 180, desc: 'Lifetime of a server nonce. The phone fetches a new one about every half of this.' },
    studentQrRotateSeconds: { group: 'Device QR (B)', type: 'int', def: 3, min: 2, max: 10, desc: 'The student QR is re-signed and redrawn this often.' },
    qrFreshSeconds: { group: 'Device QR (B)', type: 'int', def: 15, min: 5, max: 60, desc: 'A rotating QR whose signed timestamp is older than this is refused, so screenshots go stale.' },
    scanLivenessReads: { group: 'Device QR (B)', type: 'int', def: 1, min: 1, max: 2, desc: '2 = a student QR is accepted only after the scanner has read it twice, with a new signed timestamp the second time. A photo or screenshot of the QR has one timestamp and never passes, so it has to be a live phone. A live video relay still passes (see SECURITY.md). 1 = single read.' },
    credentialMaxActive: { group: 'Device QR (B)', type: 'int', def: 1, min: 1, max: 3, desc: 'Active device credentials allowed per student.' },
    crScanningEnabled: { group: 'Device QR (B)', type: 'bool', def: true, desc: 'Class representatives may scan classmates during their own open session.' },
    backToBackSeconds: { group: 'Device QR (B)', type: 'int', def: 2, min: 0, max: 30, desc: 'Two students scanned on the same phone scanner closer together than this are flagged (one person, two phones). 0 = off.' },

    // tier 3: the LABFLOW phone app (Android)
    appPingSeconds: { group: 'Phone app (tier 3)', type: 'int', def: 120, min: 60, max: 900, desc: 'After check-in the app reports the location of the phone this often until the session ends, also with the screen locked.' },
    appRadiusSlackM: { group: 'Phone app (tier 3)', type: 'int', def: 30, min: 0, max: 500, desc: 'How loose the "still at the lab" check is: metres added to the lab radius for the reports from the app. A student just outside the door still counts as present.' },
    bioChecksPerSession: { group: 'Phone app (tier 3)', type: 'int', def: 2, min: 0, max: 2, desc: 'Fingerprint checks at random times per student per session (never near the start or end, well apart). Faculty can also ask for one at any time.' },
    bioResponseSeconds: { group: 'Phone app (tier 3)', type: 'int', def: 120, min: 60, max: 600, desc: 'Time a student has to answer a fingerprint check after the phone receives it.' },
    presentCoveragePct: { group: 'Phone app (tier 3)', type: 'int', def: 75, min: 10, max: 100, desc: 'Present needs the phone at the lab for at least this % of the session (and every fingerprint check passed, nothing flagged). Below it the result is Partial.' },
    absentCoveragePct: { group: 'Phone app (tier 3)', type: 'int', def: 40, min: 0, max: 100, desc: 'Below this % of the session at the lab the result is Absent.' },
    frozenPings: { group: 'Phone app (tier 3)', type: 'int', def: 6, min: 3, max: 50, desc: 'This many reports in a row with exactly the same location and accuracy are flagged (real GPS always jitters).' },
    webPingMinSeconds: { group: 'Phone app (tier 3)', type: 'int', def: 300, min: 60, max: 3600, desc: 'Tier 1: while the LABFLOW page of the student is open after check-in, it reports the location at random times, at least this far apart.' },
    webPingMaxSeconds: { group: 'Phone app (tier 3)', type: 'int', def: 900, min: 60, max: 7200, desc: 'Tier 1: random location checks are at most this far apart.' },

    // labs, events, live view
    overstayAlertMinutes: { group: 'Labs and events', type: 'int', def: 10, min: 0, max: 120, desc: 'Staff are alerted about students still inside this long after the lab closing time.' },
    occupancyRefreshSeconds: { group: 'Labs and events', type: 'int', def: 5, min: 3, max: 60, desc: 'Live counters and rosters refresh this often.' },
    academicYearStartMonth: { group: 'Backups and archive', type: 'int', def: 6, min: 1, max: 12, desc: 'Month the academic year starts (6 = June, so the year runs 1 June to 31 May). The yearly archive groups sessions by this.' },
    eventCoordinatorGraceMinutes: { group: 'Labs and events', type: 'int', def: 60, min: 0, max: 240, desc: 'An event coordinator\'s permissions start this long before and end this long after the event.' },

    // inventory and bookings
    requireCheckinForRequests: { group: 'Inventory', type: 'bool', def: true, desc: 'Students can request equipment only while checked in (FR-21). Advance bookings are separate.' },
    loanDefaultDays: { group: 'Inventory', type: 'int', def: 7, min: 1, max: 120, desc: 'Default loan period.' },
    maxOpenLoansPerBorrower: { group: 'Inventory', type: 'int', def: 3, min: 1, max: 20, desc: 'Open loans allowed per student or group.' },
    blockLoansWhenOverdue: { group: 'Inventory', type: 'bool', def: true, desc: 'Block new loans while the borrower has overdue items.' },
    bookingMaxAdvanceDays: { group: 'Inventory', type: 'int', def: 14, min: 1, max: 180, desc: 'How far ahead a booking may start.' },
    bookingMaxDays: { group: 'Inventory', type: 'int', def: 7, min: 1, max: 60, desc: 'Longest booking duration.' },
    bookingMaxActivePerRequester: { group: 'Inventory', type: 'int', def: 3, min: 1, max: 20, desc: 'Active bookings per student or group.' },
    bookingHoldPending: { group: 'Inventory', type: 'bool', def: true, desc: 'Pending requests reserve stock until decided.' },
    noShowReleaseMinutes: { group: 'Inventory', type: 'int', def: 15, min: 5, max: 240, desc: 'A workstation slot is released if the student has not checked in to the lab this long after it starts (FR-25).' },

    // profiles
    requireMobile: { group: 'Profiles', type: 'bool', def: true, desc: 'First login asks for a mobile number (FR-2).' },
    studentAutoVerify: { group: 'Profiles', type: 'bool', def: true, desc: 'A student who claims an imported roll number at first sign-in is verified at once, without a desk check. The claim is audited and the roll number cannot be claimed twice. A phone change still needs desk approval. Off = staff verify each claim.' },
    rollFromEmail: { group: 'Profiles', type: 'bool', def: true, desc: 'Take the roll number from the student\'s email address when it matches the pattern below, and lock it (FR-3).' },
    rollEmailPattern: { group: 'Profiles', type: 'str', def: '^[a-z]{3}[0-9]{2}[a-z]{2}[0-9]{4}$', desc: 'Regular expression for the part of a student email before @ that IS the roll number.' },

    // notifications and reports
    emailEnabled: { group: 'Reports and email', type: 'bool', def: true, desc: 'Send email notifications.' },
    emailDailyReserve: { group: 'Reports and email', type: 'int', def: 50, min: 0, max: 500, desc: 'Mail quota kept in reserve; sending stops below this.' },
    reportRecipients: { group: 'Reports and email', type: 'str', def: '', desc: 'Comma-separated emails that receive scheduled reports and audit anchors.' },
    hodEmail: { group: 'Reports and email', type: 'str', def: '', desc: 'Head of department; receives the monthly audit (FR-35).' },
    reportTemplateDocId: { group: 'Reports and email', type: 'str', def: '', desc: 'Optional Google Docs template for PDF reports, with {{title}}, {{generated}}, {{summary}} and {{table}} placeholders (FR-38).' },

    // audit
    auditCheckpointEvery: { group: 'Audit', type: 'int', def: 50, min: 5, max: 1000, desc: 'Store an audit checkpoint every N audit events.' },
    // appearance
    uiTheme: { group: 'Appearance', type: 'enum', def: 'karunya', values: ['karunya', 'neo-brutalism', 'pixel-art', 'wabi-sabi', 'cybercore', 'maximal-library', 'scrapbook', 'post-internet', 'luxury-type', 'bohemian'], desc: 'The design theme for every user, the kiosks and the sign-in screen. Each theme changes the layout as well as the look.' }
  };

  var LAB_TYPES = ['iot', 'computing', 'gpu', 'research', 'other'];
  var SESSION_TYPES = ['class', 'event', 'research', 'openlab'];
  var CONDITIONS = ['good', 'fair', 'poor', 'damaged'];
  var CHECKIN_MODES = ['A', 'B', 'AB'];
  /** Session check-in choices: the lab modes plus C, the phone app (tier 3), which also takes A and B scans, flagged. */
  var SESSION_MODES = ['A', 'B', 'AB', 'C'];
  var ENTRY_REASONS = ['class', 'event', 'research', 'openlab'];
  /** Bump when the privacy notice text changes; users accept it again on their next visit. */
  var CONSENT_VERSION = '2026-10';

  return {
    TZ: TZ, TZ_OFFSET_MIN: TZ_OFFSET_MIN, ROLES: ROLES, DEFAULT_ALLOWED_DOMAINS: DEFAULT_ALLOWED_DOMAINS,
    SCHEMA: SCHEMA, SETTINGS: SETTINGS, LAB_TYPES: LAB_TYPES, SESSION_TYPES: SESSION_TYPES, CONDITIONS: CONDITIONS,
    CHECKIN_MODES: CHECKIN_MODES, SESSION_MODES: SESSION_MODES, ENTRY_REASONS: ENTRY_REASONS, CONSENT_VERSION: CONSENT_VERSION,
    ID_PREFIX: {
      user: 'USR', student: 'STU', faculty: 'FAC', lab: 'LAB', kiosk: 'KSK', course: 'CRS', roster: 'RST', map: 'FCM',
      slot: 'SLT', session: 'SES', event: 'EVT', spot: 'SPC', window: 'RSW', cred: 'CRD', category: 'CAT', asset: 'AST',
      kit: 'KIT', component: 'KCP', group: 'GRP', member: 'GMB', loan: 'LON', loanItem: 'LIT', tx: 'TXN',
      reservation: 'RSV', notification: 'NTF', audit: 'AUD', checkpoint: 'CHK', log: 'LOG', run: 'RUN',
      labEvent: 'LEV', guest: 'GST', rep: 'CRP', flag: 'FLG', request: 'EQR', project: 'PRJ', ping: 'PNG', bio: 'BIO'
    },
    /** Script-property keys (secrets and deployment configuration; never stored in a sheet). */
    PROP: { DB_ID: 'DB_SPREADSHEET_ID', HMAC: 'QR_HMAC_SECRET', BOOTSTRAP_ADMIN: 'BOOTSTRAP_ADMIN_EMAIL', DOMAINS: 'ALLOWED_DOMAINS',
            AUDIT_HEAD: 'AUDIT_HEAD', PHOTO_FOLDER: 'PHOTO_FOLDER_ID', REPORT_FOLDER: 'REPORT_FOLDER_ID', EMAIL_TRANSPORT: 'EMAIL_TRANSPORT',
            WEBAPP_URL: 'WEBAPP_URL', SESSION: 'SESSION_SECRET', GOOGLE_CLIENT_ID: 'GOOGLE_CLIENT_ID', PII_KEY: 'PII_KEY', BACKUP_FOLDER: 'BACKUP_FOLDER_ID', ARCHIVES: 'ARCHIVE_SPREADSHEETS', ARCHIVE_FOLDER: 'ARCHIVE_FOLDER_ID' }
  };
})();

/**
 * Settings accessors. Values live in script properties as "cfg.<key>" (the spec keeps configuration in
 * PropertiesService), falling back to the catalogue default. Read once per execution.
 */
var Settings = {
  PREFIX: 'cfg.',
  _memo: null,
  all: function () {
    if (Settings._memo) return Settings._memo;
    var out = {};
    Object.keys(Cfg.SETTINGS).forEach(function (k) { out[k] = Cfg.SETTINGS[k].def; });
    try {
      var props = PropertiesService.getScriptProperties().getProperties();
      Object.keys(Cfg.SETTINGS).forEach(function (k) {
        var raw = props[Settings.PREFIX + k];
        if (raw !== undefined && raw !== null) out[k] = Settings.coerce(Cfg.SETTINGS[k], raw, Cfg.SETTINGS[k].def);
      });
    } catch (e) { /* properties unavailable: defaults apply */ }
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
  /** Store already-validated values (Admin.setSettings validates). */
  put: function (values) {
    var props = PropertiesService.getScriptProperties();
    Object.keys(values).forEach(function (k) { props.setProperty(Settings.PREFIX + k, String(values[k])); });
    Settings.reset();
  },
  reset: function () { Settings._memo = null; }
};
