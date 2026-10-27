/**
 * AdminService.gs - settings, audit viewing, system status and the real-data dashboard summaries.
 * Every handler here is reached only through the RPC permission table in Code.gs (admin / staff as noted there).
 */
var Admin = {
  // ---- settings ------------------------------------------------------------------------------------------------
  getSettings: function () {
    var cur = Settings.all();
    return { settings: Object.keys(Cfg.SETTINGS).map(function (k) { var d = Cfg.SETTINGS[k]; return { key: k, group: d.group, type: d.type, value: cur[k], def: d.def, min: d.min, max: d.max, values: d.values, desc: d.desc }; }) };
  },
  _strict: function (key, def, raw) {
    if (def.type === 'int') {
      var n = typeof raw === 'number' ? raw : (typeof raw === 'string' && /^-?\d+$/.test(raw.trim()) ? parseInt(raw, 10) : NaN);
      if (!isFinite(n) || Math.floor(n) !== n || n < def.min || n > def.max) fail('BAD_INPUT', key + ' must be a whole number from ' + def.min + ' to ' + def.max + '.');
      return n;
    }
    if (def.type === 'bool') { if (raw !== true && raw !== false && raw !== 'true' && raw !== 'false') fail('BAD_INPUT', key + ' must be true or false.'); return raw === true || raw === 'true'; }
    if (def.type === 'enum') { if (def.values.indexOf(raw) < 0) fail('BAD_INPUT', key + ' must be one of: ' + def.values.join(', ') + '.'); return raw; }
    var s = V.str(raw, key, { optional: true, max: 600 });
    if (key === 'reportRecipients' || key === 'hodEmail') {
      var list = s ? s.split(',').map(function (x) { return x.trim().toLowerCase(); }).filter(Boolean) : [];
      list.forEach(function (e) { V.email(e, 'Recipient'); if (Auth.allowedDomains().indexOf(e.split('@')[1]) < 0) fail('BAD_INPUT', e + ' is not on an allowed domain.'); });
      if (key === 'hodEmail' && list.length > 3) fail('BAD_INPUT', 'At most 3 HOD addresses.');
      return list.join(',');
    }
    if (key === 'rollEmailPattern') {
      if (!s || s.length > 120) fail('BAD_INPUT', 'Pattern must be 1-120 characters.');
      try { new RegExp(s); } catch (e) { fail('BAD_INPUT', 'That is not a valid regular expression.'); }
      return s;
    }
    if (key === 'reportTemplateDocId' && s && !/^[A-Za-z0-9_-]{20,80}$/.test(s)) fail('BAD_INPUT', 'Paste the document id from the template URL.');
    return s;
  },
  setSettings: function (ctx, p) {
    V.obj(p); V.obj(p.values);
    var keys = Object.keys(p.values);
    if (!keys.length || keys.length > 40) fail('BAD_INPUT', 'Nothing to change.');
    var clean = {};
    keys.forEach(function (k) { if (!Cfg.SETTINGS[k]) fail('BAD_INPUT', 'Unknown setting ' + k + '.'); clean[k] = Admin._strict(k, Cfg.SETTINGS[k], p.values[k]); });
    var before = Settings.all(), changes = {}, values = {};
    if (clean.rescanMinFraction !== undefined || clean.rescanMaxFraction !== undefined) {
      var lo = clean.rescanMinFraction !== undefined ? clean.rescanMinFraction : before.rescanMinFraction, hi = clean.rescanMaxFraction !== undefined ? clean.rescanMaxFraction : before.rescanMaxFraction;
      if (lo > hi) fail('BAD_INPUT', 'The earliest random rescan must not be later than the latest.');
    }
    Locks.with(function () {
      keys.forEach(function (k) {
        if (String(before[k]) === String(clean[k])) return;
        values[k] = clean[k];
        changes[k] = { from: before[k], to: clean[k] };
      });
      if (Object.keys(values).length) Settings.put(values);
      Settings.reset();
      if (Object.keys(changes).length) Audit.log({ actor: ctx.email, role: 'admin', action: 'settings.update', entityType: 'Settings', entityId: '', detail: changes });
    });
    return { changed: Object.keys(changes), settings: Admin.getSettings().settings };
  },

  // ---- audit / system -------------------------------------------------------------------------------------------
  auditList: function (ctx, p) {
    p = p || {};
    var limit = V.int(p.limit, 'Limit', 1, 300, { optional: true, def: 100 }), action = p.action ? V.str(p.action, 'Action', { max: 60 }) : '', actor = p.actor ? V.str(p.actor, 'Actor', { max: 120 }).toLowerCase() : '';
    var scoped = Auth.scopedHod(ctx), visible = {};
    if (scoped) {
      var allowed = Auth.labFilter(ctx), students = Auth.studentFilter(ctx);
      var tables = {Labs:'labId',Sessions:'sessionId',Assets:'assetId',Loans:'loanId',Reservations:'reservationId',EquipmentRequests:'requestId',Events:'labEventId',Projects:'projectId',Groups:'groupId',Kiosks:'kioskId'};
      Object.keys(tables).forEach(function(t){Db.where(t,function(x){return allowed(x.labId);}).forEach(function(x){visible[x[tables[t]]]=true;});});
      Db.where('StudentProfiles',function(s){return students(s.studentId);}).forEach(function(s){visible[s.studentId]=true;});
      Users.listUsers(ctx).users.forEach(function(u){visible[u.userId]=true;});
      Db.where('AttendanceEvents',function(e){return visible[e.sessionId];}).forEach(function(e){visible[e.eventId]=true;});
    }
    var rows = Db.tail('AuditEvents', 1500).filter(function (e) { return (!scoped || visible[e.entityId]) && (!action || e.action.indexOf(action) === 0) && (!actor || String(e.actor).toLowerCase().indexOf(actor) >= 0); }).reverse().slice(0, limit);
    return { events: rows.map(function (e) { return { seq: e.seq, at: e.at, actor: e.actor, role: e.role, action: e.action, entityType: e.entityType, entityId: e.entityId, result: e.result, detail: e.detail, hash: e.hash.slice(0, 12) }; }) };
  },
  auditVerify: function (ctx) {
    var v = Audit.verify();
    Audit.tryLog({ actor: ctx.email, role: 'admin', action: 'audit.verify', entityType: 'Audit', detail: { ok: v.ok, rows: v.rows } });
    return v;
  },
  systemStatus: function () {
    var jobs = Db.tail('JobRuns', 60).reverse(), seen = {}, latest = [];
    jobs.forEach(function (j) { var base = j.job.split(':')[0]; if (!seen[base]) { seen[base] = true; latest.push({ job: base, at: j.finishedAt, status: j.status, detail: j.detail }); } });
    var errors = Db.tail('SystemLog', 100).filter(function (l) { return l.level === 'error'; }).reverse().slice(0, 15).map(function (l) { return { at: l.at, source: l.source, code: l.code, message: l.message }; });
    var mailLeft = null; try { mailLeft = MailApp.getRemainingDailyQuota(); } catch (e) {}
    var queued = Db.tail('Notifications', 500).filter(function (n) { return n.emailStatus === 'queued'; }).length;
    return { triggers: Triggers.status(), latestJobs: latest, recentErrors: errors, mail: { remainingToday: mailLeft, queued: queued }, serverNow: U.now(), timeZone: Cfg.TZ,
             allowedDomains: Auth.allowedDomains(), emailTransport: PropertiesService.getScriptProperties().getProperty(Cfg.PROP.EMAIL_TRANSPORT) || 'gmail', readiness: Admin.labReadiness() };
  },
  /** Read-only configuration checks, not certification of GPS, identity, cameras or successful attendance. */
  labReadiness: function () {
    var now = U.now(), today = U.local(now).date, dow = U.local(now).dow;
    var kiosks = Db.readAll('Kiosks'), projects = Db.readAll('Projects'), slots = Db.readAll('Timetable');
    var todaySessions = Db.whereEq('Sessions', { date: today }), bySlot = U.indexBy(todaySessions, 'slotKey');
    var sessions = todaySessions.filter(function (s) { return (s.type === 'class' || s.type === 'event') && (s.status === 'scheduled' || s.status === 'open') && s.scheduledEnd > now; });
    var categories = U.indexBy(Db.readAll('Categories'), 'categoryId'), assets = Db.readAll('Assets');
    function check(key, label, state, detail, target) { return { key: key, label: label, state: state, detail: detail, target: target }; }
    var labs = Db.whereEq('Labs', { status: 'active' }).map(function (lab) {
      var modeA = Labs.allows(lab, 'A'), hours = U.isTime(lab.openTime) && U.isTime(lab.closeTime) && lab.closeTime > lab.openTime;
      var active = kiosks.filter(function (k) { return k.labId === lab.labId && k.status === 'active'; });
      var seen = active.some(function (k) { return k.lastSeenAt && k.lastSeenAt <= now && now - k.lastSeenAt <= 120000; });
      var teaching = sessions.some(function (s) { return s.labId === lab.labId; }) || slots.some(function (s) {
        if (s.labId !== lab.labId || s.status !== 'active' || s.dayOfWeek !== dow || s.validFrom > today || s.validTo < today || !U.isTime(s.endTime)) return false;
        // A closed/cancelled materialized class must not look like an upcoming timetable slot.
        var key = s.slotId + '|' + today;
        if (bySlot[key]) return false;
        return U.fromLocal(today, s.endTime) > now;
      });
      var usable = projects.some(function (p) { return p.labId === lab.labId && (p.status === 'pending' || p.status === 'active'); });
      var systems = assets.filter(function (a) { return a.labId === lab.labId && a.status !== 'retired' && a.trackingMode === 'individual' && categories[a.categoryId] && categories[a.categoryId].workstation; }).length;
      return { labId: lab.labId, code: lab.code, name: lab.name, mode: Labs.modeOf(lab), checks: [
        check('geofence', 'Door GPS', !modeA ? 'not_required' : Labs.hasGeofence(lab) ? 'configured' : 'attention', !modeA ? 'Device QR mode does not use GPS.' : Labs.hasGeofence(lab) ? 'Coordinates and a ' + Labs.radiusOf(lab) + ' m radius are saved. Test inside and outside at the door.' : 'Save the lab location from a phone in the room, then test the boundary.', 'labs'),
        check('walkins', 'Walk-in access', lab.openLab ? 'configured' : 'info', lab.openLab ? 'Walk-ins enabled.' : 'Walk-ins are off. Enable them if this lab offers extra-hours visits.', 'labs'),
        check('hours', 'Opening hours', hours ? 'configured' : lab.openLab ? 'attention' : 'not_required', hours ? lab.openTime + ' to ' + lab.closeTime + ' IST.' : lab.openLab ? 'Walk-ins need valid opening and closing times.' : 'No hours saved; required only when walk-ins are enabled.', 'labs'),
        check('kiosk', 'Door kiosk', seen ? 'configured' : 'attention', seen ? 'An active kiosk reported within the last 2 minutes.' : active.length ? 'No active kiosk reported within the last 2 minutes. Sign in at the door.' : 'No active kiosk is assigned to this lab.', 'labs'),
        check('teaching', 'Class or event today', teaching ? 'configured' : 'info', teaching ? 'A class or event remains scheduled today; opening and roster checks still apply.' : 'No remaining class or event today. Add one if your demo needs a teaching session.', 'academics'),
        check('project', 'Walk-in projects', usable ? 'configured' : lab.openLab ? 'attention' : 'not_required', usable ? 'A pending or active project is assigned to this lab. Each visitor needs an eligible own/group project.' : lab.openLab ? 'Create a student project for this lab before rehearsing walk-in entry.' : 'No pending/active project; required only for walk-in visits.', 'projects'),
        check('systems', 'Workstations', 'info', systems + ' workstation(s) configured. Own-laptop visits are also supported.', 'labs')
      ] };
    });
    var backup = check('backup', 'Recent backup', 'attention', 'No backup copy found. Use Back up now below.', 'backups');
    var folderId = PropertiesService.getScriptProperties().getProperty(Cfg.PROP.BACKUP_FOLDER);
    if (folderId) {
      try {
        // Inspect only an existing folder; displaying setup checks must not create Drive resources.
        var entries = Backup._entries(DriveApp.getFolderById(folderId));
        var times = entries.map(function (e) { return e.createdAt; }).filter(function (t) { return t <= now; }).sort(function (a, b) { return b - a; });
        if (times.length) { backup.state = now - times[0] <= 36 * 3600000 ? 'configured' : 'attention'; backup.detail = backup.state === 'configured' ? 'A database copy was created within the last 36 hours. Restore testing is separate.' : 'The latest database copy is older than 36 hours. Check nightly jobs or back up now.'; backup.lastBackupAt = times[0]; }
      } catch (e) { backup.state = 'unknown'; backup.detail = 'Could not inspect the backup folder. Check Drive access and refresh.'; }
    }
    var hods = Db.where('Users', function (u) { return u.status === 'active' && String(u.roles).split(',').indexOf('hod') >= 0 && !!String(u.department || '').trim(); }).length;
    return { checkedAt: now, labs: labs, global: [backup, check('hod', 'Department HOD account', hods ? 'configured' : 'info', hods ? 'An active HOD account has a department. Check that it matches the labs you will show.' : 'No active HOD account has a department. Configure one if the demo includes departmental views.', 'users')] };
  },
  reconcileInventory: function (ctx, p) {
    var rep = Assets.reconcile({ fix: !(p && p.dryRun) });
    Audit.tryLog({ actor: ctx.email, role: ctx.roles[0], action: 'inventory.reconcile.manual', entityType: 'Asset', detail: { fixed: rep.fixed, drift: rep.drift.length } });
    return rep;
  },
  reconcileSession: function (ctx, p) { V.obj(p); return Attend.reconcile(V.id(p.sessionId, 'Session', 'session')); },

  // ---- quota usage (SRS section 14: Google can change limits, so the admin screen shows what is used) ---------
  /** Approximate count of rpc calls today (a cache counter; it can under-count if the cache is evicted). */
  countCall: function () {
    try { var c = CacheService.getScriptCache(), k = 'calls|' + U.local(U.now()).date; c.put(k, String((parseInt(c.get(k) || '0', 10) || 0) + 1), 90000); } catch (e) {}
  },
  quota: function () {
    var now = U.now(), today = U.local(now).date, dayStart = U.dayStart(today);
    var mailLeft = null; try { mailLeft = MailApp.getRemainingDailyQuota(); } catch (e) {}
    var calls = 0; try { calls = parseInt(CacheService.getScriptCache().get('calls|' + today) || '0', 10) || 0; } catch (e) {}
    var runs = Db.tail('JobRuns', 400).filter(function (j) { return j.startedAt >= dayStart; });
    var triggerMs = runs.reduce(function (a, j) { return a + Math.max(0, (j.finishedAt || j.startedAt) - j.startedAt); }, 0);
    var docs = runs.filter(function (j) { return /^report-(daily|monthly)/.test(j.job); }).length;
    var props = PropertiesService.getScriptProperties().getProperties(), propBytes = 0;
    Object.keys(props).forEach(function (k) { propBytes += k.length + String(props[k]).length; });
    var cells = 0, sheets = [];
    Object.keys(Cfg.SCHEMA).forEach(function (t) { var rows = Db.count(t); cells += (rows + 1) * Cfg.SCHEMA[t].length; sheets.push({ table: t, rows: rows }); });
    sheets.sort(function (a, b) { return b.rows - a.rows; });
    return {
      date: today,
      items: [
        { key: 'mail', label: 'Email recipients used today', used: mailLeft === null ? null : Math.max(0, 1500 - mailLeft), limit: 1500, remaining: mailLeft, note: 'Workspace accounts: 1,500 a day (2,000 within the domain). Sending stops at the reserve of ' + Settings.get('emailDailyReserve') + '.' },
        { key: 'triggers', label: 'Trigger runtime today', used: Math.round(triggerMs / 1000), limit: 6 * 3600, unit: 's', note: 'Workspace accounts: 6 hours a day.' },
        { key: 'triggerCount', label: 'Installed LABFLOW triggers', used: Object.keys(Triggers.HANDLERS).length, limit: 20, note: '20 per user per script.' },
        { key: 'calls', label: 'App requests today (approximate)', used: calls, limit: null, note: 'Up to 30 run at the same time per user; each is short.' },
        { key: 'docs', label: 'Report documents created today', used: docs, limit: 1500, note: 'Documents created per day.' },
        { key: 'props', label: 'Properties storage', used: propBytes, limit: 500 * 1024, unit: 'bytes', note: 'Configuration only.' },
        { key: 'cells', label: 'Spreadsheet cells in use', used: cells, limit: 10000000, note: 'Google Sheets holds up to 10 million cells per spreadsheet.' }
      ],
      largestTables: sheets.slice(0, 6), serverNow: now
    };
  }
};

/** Dashboard summaries computed from live data only. */
var Dash = {
  // Department-scoped HOD overview.
  hod: function (ctx, p) {
    return Locks.with(function () {
      var allowed = Auth.labFilter(ctx), studentAllowed = Auth.studentFilter(ctx), now = U.now(), today = U.local(now).date;
      var days = V.int(p && p.days, 'Days', 3, 60, {optional:true,def:14}), from = U.addDays(today, -(days-1));
      var labs = Db.where('Labs', function(l){return l.status === 'active' && allowed(l.labId);});
      var sessions = Db.where('Sessions', function(s){return allowed(s.labId);}), ids = U.indexBy(sessions,'sessionId');
      var loans = Db.where('Loans',function(l){return allowed(l.labId) && (l.status === 'open' || l.status === 'partial');});
      var assets = Db.where('Assets',function(a){return allowed(a.labId);}), stock = {individual:0,onLoan:0,quantityUnits:0,quantityOut:0,damaged:0,missing:0};
      assets.forEach(function(a){if(a.trackingMode === 'individual'){stock.individual++;if(a.status === 'on_loan')stock.onLoan++;}else{stock.quantityUnits+=a.quantityTotal;stock.quantityOut+=a.quantityTotal-a.quantityAvailable;}if(a.condition === 'damaged' || a.status === 'damaged')stock.damaged++;if(a.status === 'missing')stock.missing++;});
      var perDay = {}; for(var i=0;i<days;i++)perDay[U.addDays(from,i)]={sessions:0,present:0};
      sessions.forEach(function(s){if(perDay[s.date] && (s.status === 'open'||s.status === 'closed'))perDay[s.date].sessions++;});
      Db.where('AttendanceSummaries',function(x){return ids[x.sessionId] && perDay[ids[x.sessionId].date] && x.status !== 'absent';}).forEach(function(x){perDay[ids[x.sessionId].date].present++;});
      var roles = {}; Cfg.ROLES.forEach(function(r){roles[r]=0;}); Users.listUsers(ctx).users.forEach(function(u){if(u.status === 'active')u.roles.forEach(function(r){roles[r]++;});});
      var queues = {pendingStudents:Db.where('StudentProfiles',function(s){return studentAllowed(s.studentId)&&s.status==='pending';}).length,
        pendingCredentials:Db.where('DeviceCredentials',function(c){return studentAllowed(c.studentId)&&c.status==='pending';}).length,
        pendingBookings:Db.where('Reservations',function(r){return allowed(r.labId)&&r.status==='pending';}).length,
        pendingEquipment:Db.where('EquipmentRequests',function(r){return allowed(r.labId)&&r.status==='pending';}).length,
        openFlags:Db.where('Flags',function(f){return allowed(f.labId)&&f.status==='open';}).length,
        activeLoans:loans.length,overdueLoans:loans.filter(function(l){return l.dueAt<now;}).length,damaged:stock.damaged,missing:stock.missing,
        pendingCorrections:Attend.pendingCorrections().corrections.filter(function(e){return !!ids[e.sessionId];}).length};
      var occupancy = labs.map(function(l){return Occupancy.lab(l.labId);});
      return {department:Auth.department(ctx),labIds:labs.map(function(l){return l.labId;}),labCount:labs.length,users:roles,
        labs:labs.map(function(l){return {labId:l.labId,code:l.code,name:l.name,type:l.type,building:l.building,room:l.room,capacity:l.capacity,department:l.department || '',openLab:l.openLab};}),
        readOnly:!ctx.has('admin') && !ctx.has('staff'),inside:occupancy.reduce(function(n,o){return n+o.inside;},0),
        openSessions:sessions.filter(function(s){return s.status==='open';}).length,stock:stock,queues:queues,
        occupancy:occupancy,attendanceByDay:Object.keys(perDay).sort().map(function(d){return {date:d,sessions:perDay[d].sessions,present:perDay[d].present};}),serverNow:now};
    });
  },
  student: function (ctx) {
    if (!ctx.student) return { profile: null };
    var sid = ctx.student.studentId, now = U.now();
    var loans = Loans.mine(ctx).loans, active = loans.filter(function (l) { return l.status === 'open' || l.status === 'partial'; });
    var books = Booking.mine(ctx).reservations.filter(function (r) { return (r.status === 'pending' || r.status === 'approved') && r.endAt > now; });
    var unread = Notify.list(ctx).unread, hist = Attend.myHistory(ctx, { limit: 1 });
    var today = U.local(now).date, perLab = Reports._student({ studentId: sid, from: U.addDays(today, -89), to: today }).meta.labTotals;
    return { credential: Creds.summaryFor(sid), attendance: hist.totals, labAttendance: perLab, labAttendanceDays: 90, activeLoans: active.length, overdueLoans: active.filter(function (l) { return l.overdue; }).length, upcomingBookings: books.length, unread: unread, serverNow: now };
  },
  faculty: function (ctx) {
    var today = U.local(U.now()).date;
    Sessions.materialize(today);
    var mine = Db.where('Sessions', function (s) { return s.date === today && (ctx.has('admin') || (ctx.faculty && s.facultyId === ctx.faculty.facultyId)); });
    var pending = ctx.faculty ? Sessions.pendingResearch(ctx).requests.length : 0;
    var flags = Flags.list(ctx, { status: 'open' }).flags.length;
    return { today: today, sessions: mine.length, open: mine.filter(function (s) { return s.status === 'open'; }).length, pendingResearch: pending, openFlags: flags, serverNow: U.now() };
  },
  staff: function (ctx) {
    if (Auth.scopedHod(ctx)) { var d = Dash.hod(ctx); return Object.assign({}, d.queues, {occupancy:d.occupancy,serverNow:d.serverNow}); }
    var now = U.now();
    var loans = Db.where('Loans', function (l) { return l.status === 'open' || l.status === 'partial'; });
    return {
      pendingStudents: Db.where('StudentProfiles', function (s) { return s.status === 'pending'; }).length,
      pendingCredentials: Creds.listPending().pending.length,
      pendingBookings: Db.where('Reservations', function (r) { return r.status === 'pending'; }).length,
      pendingEquipment: Db.where('EquipmentRequests', function (r) { return r.status === 'pending'; }).length,
      openFlags: Db.where('Flags', function (f) { return f.status === 'open'; }).length,
      activeLoans: loans.length, overdueLoans: loans.filter(function (l) { return l.dueAt < now; }).length,
      damaged: Db.where('Assets', function (a) { return a.status === 'damaged'; }).length, missing: Db.where('Assets', function (a) { return a.status === 'missing'; }).length,
      pendingCorrections: Attend.pendingCorrections().corrections.length, occupancy: Occupancy.list().labs, serverNow: now
    };
  },
  /** Live activity across labs for the staff dashboard: the latest accepted scans and loan movements. */
  activity: function (ctx) {
    var allowed = Auth.labFilter(ctx);
    var labs = U.indexBy(Db.readAll('Labs'), 'labId');
    var scans = Db.tail('AttendanceEvents', 80).filter(function (e) { return allowed(e.labId) && (e.type === 'IN' || e.type === 'OUT' || e.type === 'RESCAN' || e.type === 'CORR_IN' || e.type === 'CORR_OUT'); }).slice(-25).reverse().map(function (e) {
      var st = Db.cachedGet('StudentProfiles', 'studentId', e.studentId, 300) || {};
      return { kind: 'scan', at: e.at, type: e.type, name: st.name, rollNo: st.rollNo, labCode: (labs[e.labId] || {}).code, method: e.method || e.source, mode: e.mode, scannerRole: e.scannerRole, assurance: e.assurance };
    });
    var moves = Db.tail('AssetEvents', 40).filter(function(x){var a=Db.get('Assets',x.assetId);return a&&allowed(a.labId);}).slice(-15).reverse().map(function (x) { var a = Db.cachedGet('Assets', 'assetId', x.assetId, 300) || {}; return { kind: 'asset', at: x.at, type: x.type, name: a.name, qty: x.qtyDelta, by: x.by }; });
    return { items: scans.concat(moves).sort(function (a, b) { return b.at - a.at; }).slice(0, 30), serverNow: U.now() };
  },
  admin: function (ctx, p) {
    if (Auth.scopedHod(ctx)) { var d=Dash.hod(ctx,p);return Object.assign({},d,{labs:d.labCount}); }
    var now = U.now(), today = U.local(now).date, days = V.int(p && p.days, 'Days', 3, 60, { optional: true, def: 14 });
    var users = Db.readAll('Users'), roleCount = { student: 0, faculty: 0, staff: 0, admin: 0, hod: 0 };
    users.forEach(function (u) { if (u.status === 'active') String(u.roles).split(',').forEach(function (r) { if (roleCount[r] !== undefined) roleCount[r]++; }); });
    var from = U.addDays(today, -(days - 1)), sessions = Db.where('Sessions', function (s) { return s.date >= from && s.date <= today && (s.status === 'closed' || s.status === 'open'); });
    var byId = {}; sessions.forEach(function (s) { byId[s.sessionId] = s; });
    var perDay = {}; for (var i = 0; i < days; i++) perDay[U.addDays(from, i)] = { sessions: 0, present: 0 };
    sessions.forEach(function (s) { perDay[s.date].sessions++; });
    Db.where('AttendanceSummaries', function (x) { return byId[x.sessionId] && (x.status === 'present' || x.status === 'partial' || x.status === 'unverified_exit' || x.status === 'missed_rescan' || x.status === 'flagged'); }).forEach(function (x) { perDay[byId[x.sessionId].date].present++; });
    var labs = Db.readAll('Labs'), openNow = Db.where('Sessions', function (s) { return s.status === 'open'; });
    var assets = Db.readAll('Assets'), stock = { individual: 0, onLoan: 0, quantityUnits: 0, quantityOut: 0, damaged: 0, missing: 0 };
    assets.forEach(function (a) {
      if (a.trackingMode === 'individual') { stock.individual++; if (a.status === 'on_loan') stock.onLoan++; } else { stock.quantityUnits += a.quantityTotal; stock.quantityOut += a.quantityTotal - a.quantityAvailable; }
      if (a.status === 'damaged') stock.damaged++; if (a.status === 'missing') stock.missing++;
    });
    return { users: roleCount, labs: labs.filter(function (l) { return l.status === 'active'; }).length, openSessions: openNow.length, attendanceByDay: Object.keys(perDay).sort().map(function (d) { return { date: d, sessions: perDay[d].sessions, present: perDay[d].present }; }),
             stock: stock, queues: Dash.staff(), serverNow: now };
  }
};
