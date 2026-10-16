/**
 * AdminService.gs - settings, audit viewing, system status and the real-data dashboard summaries.
 * Every handler here is reached only through the RPC permission table in Code.gs (admin / staff as noted there).
 */
var Admin = {
  // ---- settings ------------------------------------------------------------------------------------------------
  getSettings: function () {
    var cur = Settings.all();
    return { settings: Object.keys(Cfg.SETTINGS).map(function (k) { var d = Cfg.SETTINGS[k]; return { key: k, type: d.type, value: cur[k], def: d.def, min: d.min, max: d.max, values: d.values, desc: d.desc }; }) };
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
    if (key === 'reportRecipients') {
      var list = s ? s.split(',').map(function (x) { return x.trim().toLowerCase(); }).filter(Boolean) : [];
      list.forEach(function (e) { V.email(e, 'Recipient'); if (Auth.allowedDomains().indexOf(e.split('@')[1]) < 0) fail('BAD_INPUT', e + ' is not on an allowed domain.'); });
      return list.join(',');
    }
    return s;
  },
  setSettings: function (ctx, p) {
    V.obj(p); V.obj(p.values);
    var keys = Object.keys(p.values);
    if (!keys.length || keys.length > 40) fail('BAD_INPUT', 'Nothing to change.');
    var clean = {};
    keys.forEach(function (k) { if (!Cfg.SETTINGS[k]) fail('BAD_INPUT', 'Unknown setting ' + k + '.'); clean[k] = Admin._strict(k, Cfg.SETTINGS[k], p.values[k]); });
    var before = Settings.all(), changes = {};
    Locks.with(function () {
      keys.forEach(function (k) {
        if (String(before[k]) === String(clean[k])) return;
        var row = Db.getBy('Config', 'key', k), rec = { value: String(clean[k]), updatedBy: ctx.email, updatedAt: U.now() };
        if (row) Db.update('Config', k, rec); else Db.insert('Config', Object.assign({ key: k }, rec));
        changes[k] = { from: before[k], to: clean[k] };
      });
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
  reconcileSession: function (ctx, p) { V.obj(p); return Attend.reconcile(V.id(p.sessionId, 'Session', 'session')); }
};

/** Dashboard summaries computed from live data only. */
var Dash = {
  student: function (ctx) {
    if (!ctx.student) return { profile: null };
    var sid = ctx.student.studentId, now = U.now();
    var loans = Loans.mine(ctx).loans, active = loans.filter(function (l) { return l.status === 'open' || l.status === 'partial'; });
    var books = Booking.mine(ctx).reservations.filter(function (r) { return (r.status === 'pending' || r.status === 'approved') && r.endAt > now; });
    var unread = Notify.list(ctx).unread, hist = Attend.myHistory(ctx, { limit: 1 });
    return { credential: Creds.summaryFor(sid), attendance: hist.totals, activeLoans: active.length, overdueLoans: active.filter(function (l) { return l.overdue; }).length, upcomingBookings: books.length, unread: unread, serverNow: now };
  },
  faculty: function (ctx) {
    var today = U.local(U.now()).date;
    Sessions.materialize(today);
    var mine = Db.where('Sessions', function (s) { return s.date === today && (ctx.has('admin') || (ctx.faculty && s.facultyId === ctx.faculty.facultyId)); });
    var pending = ctx.faculty ? Sessions.pendingResearch(ctx).requests.length : 0;
    return { today: today, sessions: mine.length, open: mine.filter(function (s) { return s.status === 'open'; }).length, pendingResearch: pending, serverNow: U.now() };
  },
  staff: function () {
    var now = U.now();
    var loans = Db.where('Loans', function (l) { return l.status === 'open' || l.status === 'partial'; });
    return {
      pendingStudents: Db.where('StudentProfiles', function (s) { return s.status === 'pending'; }).length,
      pendingCredentials: Creds.listPending().pending.length,
      pendingBookings: Db.where('Reservations', function (r) { return r.status === 'pending'; }).length,
      activeLoans: loans.length, overdueLoans: loans.filter(function (l) { return l.dueAt < now; }).length,
      damaged: Db.where('Assets', function (a) { return a.status === 'damaged'; }).length, missing: Db.where('Assets', function (a) { return a.status === 'missing'; }).length,
      pendingCorrections: Attend.pendingCorrections().corrections.length, serverNow: now
    };
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
