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
    var rows = Db.tail('AuditEvents', 1500).filter(function (e) { return (!action || e.action.indexOf(action) === 0) && (!actor || String(e.actor).toLowerCase().indexOf(actor) >= 0); }).reverse().slice(0, limit);
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
             allowedDomains: Auth.allowedDomains(), emailTransport: PropertiesService.getScriptProperties().getProperty(Cfg.PROP.EMAIL_TRANSPORT) || 'gmail' };
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
  // v2 stubs (docs/requirements.md section 4); each task replaces its own.
  hod: function () { notBuilt_('B3'); },
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
  staff: function () {
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
  activity: function () {
    var labs = U.indexBy(Db.readAll('Labs'), 'labId');
    var scans = Db.tail('AttendanceEvents', 80).filter(function (e) { return e.type === 'IN' || e.type === 'OUT' || e.type === 'RESCAN' || e.type === 'CORR_IN' || e.type === 'CORR_OUT'; }).slice(-25).reverse().map(function (e) {
      var st = Db.cachedGet('StudentProfiles', 'studentId', e.studentId, 300) || {};
      return { kind: 'scan', at: e.at, type: e.type, name: st.name, rollNo: st.rollNo, labCode: (labs[e.labId] || {}).code, method: e.method || e.source, mode: e.mode, scannerRole: e.scannerRole, assurance: e.assurance };
    });
    var moves = Db.tail('AssetEvents', 40).slice(-15).reverse().map(function (x) { var a = Db.cachedGet('Assets', 'assetId', x.assetId, 300) || {}; return { kind: 'asset', at: x.at, type: x.type, name: a.name, qty: x.qtyDelta, by: x.by }; });
    return { items: scans.concat(moves).sort(function (a, b) { return b.at - a.at; }).slice(0, 30), serverNow: U.now() };
  },
  admin: function (ctx, p) {
    var now = U.now(), today = U.local(now).date, days = V.int(p && p.days, 'Days', 3, 60, { optional: true, def: 14 });
    var users = Db.readAll('Users'), roleCount = { student: 0, faculty: 0, staff: 0, admin: 0 };
    users.forEach(function (u) { if (u.status === 'active') String(u.roles).split(',').forEach(function (r) { if (roleCount[r] !== undefined) roleCount[r]++; }); });
    var from = U.addDays(today, -(days - 1)), sessions = Db.where('Sessions', function (s) { return s.date >= from && s.date <= today && (s.status === 'closed' || s.status === 'open'); });
    var byId = {}; sessions.forEach(function (s) { byId[s.sessionId] = s; });
    var perDay = {}; for (var i = 0; i < days; i++) perDay[U.addDays(from, i)] = { sessions: 0, present: 0 };
    sessions.forEach(function (s) { perDay[s.date].sessions++; });
    Db.where('AttendanceSummaries', function (x) { return byId[x.sessionId] && (x.status === 'present' || x.status === 'unverified_exit' || x.status === 'missed_rescan' || x.status === 'flagged'); }).forEach(function (x) { perDay[byId[x.sessionId].date].present++; });
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
