/**
 * BackupService.gs - nightly Drive copies of the spreadsheet (task A3) and the yearly archive that moves old
 * event-level rows into a per-year archive spreadsheet (task A4). Contract: docs/requirements.md section 4.
 *
 * Backups (A3)
 *  - A copy of the whole database spreadsheet goes into the private Drive folder "LABFLOW Backups", named
 *    "LABFLOW backup YYYY-MM-DD" (IST date). A manual copy is "LABFLOW backup YYYY-MM-DD (manual HHMMSS)".
 *  - Rotation keeps the newest 30 days of copies, plus the first copy of each of the last 12 calendar months. Everything
 *    else that carries our name goes to the Drive bin. Files in the folder with any other name are never touched.
 *  - The nightly step is idempotent (a second run on the same day makes no new copy) and rotates only after a copy exists,
 *    so a failed copy never costs us an older backup.
 *  - The encryption key (script property PII_KEY) is NOT in the spreadsheet, so a restored copy shows phone numbers as
 *    sealed text until the same key is set again. Keep a note of the key somewhere safe (SECURITY.md).
 *
 * Yearly archive (A4)
 *  - Academic year = 1 June to 31 May (start month is a setting). Scan-level rows of finished years move to the
 *    spreadsheet "LABFLOW Archive YYYY-YY"; Sessions, AttendanceSummaries, Loans and AuditEvents stay live.
 *  - Whole sessions only. A session with a pending correction or an unfinished closing journal waits for a later run.
 *  - Each batch under the script lock: copy, read back and compare, delete from the live sheet, check they are gone. A run
 *    stops at its time budget and resumes where it left off; running a year again moves nothing twice.
 *  - Sessions.archivedAt marks archived sessions; code that would recompute from scans refuses them with ARCHIVED.
 *  - Manual (system.archive, admin) makes today's backup first. The nightly job archives years older than the previous
 *    one each July, only if today's backup exists, and writes its JobRuns marker only when everything finished.
 */
var Backup = {
  PREFIX: 'LABFLOW backup ',
  FOLDER_NAME: 'LABFLOW Backups',
  DAILY_KEEP: 30,
  MONTHLY_KEEP: 12,

  _folder: function () { return Setup.folder(Cfg.PROP.BACKUP_FOLDER, Backup.FOLDER_NAME); },

  /** 'LABFLOW backup 2026-10-21' (or with a manual suffix) -> '2026-10-21'; null for any file that is not one of ours. */
  _dateOf: function (name) {
    var m = /^LABFLOW backup (\d{4}-\d{2}-\d{2})(?: \(manual \d{6}\))?$/.exec(String(name || ''));
    return m ? m[1] : null;
  },

  /** Our backup files in the folder, oldest first. Trashed files are not listed by Drive. */
  _entries: function (folder) {
    var out = [], it = folder.getFiles();
    while (it.hasNext()) {
      var f = it.next(), name = f.getName(), date = Backup._dateOf(name);
      if (!date) continue;
      out.push({ file: f, id: f.getId(), name: name, date: date, manual: / \(manual \d{6}\)$/.test(name),
                 createdAt: f.getDateCreated().getTime(), url: f.getUrl() });
    }
    out.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt - b.createdAt; });
    return out;
  },

  _monthIndex: function (ymd) { return +ymd.slice(0, 4) * 12 + (+ymd.slice(5, 7) - 1); },

  /** Decide what stays. Returns { keep: { id: 'daily'|'monthly' }, trash: [entry] }. Pure: it touches nothing. */
  _plan: function (entries, today) {
    var dates = {}, keep = {}, trash = [], first = {}, nowIdx = Backup._monthIndex(today);
    entries.forEach(function (e) { dates[e.date] = true; var mk = e.date.slice(0, 7); if (!first[mk]) first[mk] = e; });
    var recent = Object.keys(dates).sort().reverse().slice(0, Backup.DAILY_KEEP);
    entries.forEach(function (e) { if (recent.indexOf(e.date) >= 0) keep[e.id] = 'daily'; });
    Object.keys(first).forEach(function (mk) {
      var idx = Backup._monthIndex(mk + '-01');
      if (idx <= nowIdx && idx > nowIdx - Backup.MONTHLY_KEEP && !keep[first[mk].id]) keep[first[mk].id] = 'monthly';
    });
    entries.forEach(function (e) { if (!keep[e.id]) trash.push(e); });
    return { keep: keep, trash: trash };
  },

  _rotate: function (folder, today) {
    var entries = Backup._entries(folder), plan = Backup._plan(entries, today);
    plan.trash.forEach(function (e) { e.file.setTrashed(true); });
    return { kept: entries.length - plan.trash.length, trashed: plan.trash.length };
  },

  /** Copy the live spreadsheet while holding the script lock, so the copy never catches a write half done. */
  _copy: function (name, folder) {
    var dbId = PropertiesService.getScriptProperties().getProperty(Cfg.PROP.DB_ID);
    if (!dbId) fail('NOT_INITIALISED', 'The database has not been created yet.');
    return Locks.with(function () { return DriveApp.getFileById(dbId).makeCopy(name, folder); }, 20000);
  },

  _view: function (e, keep) {
    return { id: e.id, name: e.name, date: e.date, createdAt: e.createdAt, url: e.url, manual: e.manual, keeps: keep[e.id] || null };
  },

  /** The nightly job step: copy (once per day), then rotate (30 daily + 12 monthly). */
  nightly: function () {
    var today = U.local(U.now()).date, name = Backup.PREFIX + today, folder = Backup._folder();
    var already = Backup._entries(folder).some(function (e) { return e.name === name; });
    if (!already) {
      try { Backup._copy(name, folder); }
      catch (e) {
        try { Notify.toRole('admin', 'integrity', 'Nightly backup failed', 'No backup copy was made on ' + today + ': ' + String(e && e.message).slice(0, 160) + ' Older backups were kept.', 'backup-fail:' + today); } catch (n) { /* the failure itself is recorded by the job */ }
        throw e;
      }
    }
    var rot = Backup._rotate(folder, today);
    return { created: already ? null : name, alreadyDone: already, kept: rot.kept, trashed: rot.trashed };
  },

  /** Make a backup copy now (super admin) and return it with the refreshed list. */
  now: function (ctx) {
    var t = U.local(U.now()), folder = Backup._folder();
    var name = Backup.PREFIX + t.date + ' (manual ' + U.p2(t.H) + U.p2(t.M) + U.p2(new Date(U.now()).getUTCSeconds()) + ')';
    var file = Backup._copy(name, folder);
    Audit.log({ actor: ctx.email, role: 'admin', action: 'backup.manual', entityType: 'Backup', entityId: file.getId(), detail: { name: name } });
    var rot = Backup._rotate(folder, t.date), listing = Backup.list(ctx);
    return { created: name, trashed: rot.trashed, backups: listing.backups, retention: listing.retention, folderUrl: listing.folderUrl };
  },

  /** Every backup copy, newest first, with what rotation will keep it for. */
  list: function () {
    var folderId = PropertiesService.getScriptProperties().getProperty(Cfg.PROP.BACKUP_FOLDER);
    if (!folderId) return { backups: [], retention: { dailyDays: Backup.DAILY_KEEP, monthlyMonths: Backup.MONTHLY_KEEP }, folderUrl: null };
    var today = U.local(U.now()).date, folder = DriveApp.getFolderById(folderId), entries = Backup._entries(folder), plan = Backup._plan(entries, today);
    return { backups: entries.slice().reverse().map(function (e) { return Backup._view(e, plan.keep); }),
             retention: { dailyDays: Backup.DAILY_KEEP, monthlyMonths: Backup.MONTHLY_KEEP }, folderUrl: folder.getUrl() };
  },

  // ===========================================================================================================================
  // Yearly archive (A4)
  //
  //  - Moves the event-level rows of a finished academic year (1 June to 31 May; the start month is a setting) into the
  //    spreadsheet "LABFLOW Archive YYYY-YY", so the live sheets stay small. What moves: AttendanceEvents, RescanWindows and
  //    SpotChecks of closed sessions; Redemptions, SystemLog and JobRuns of the year; read Notifications of the year; the
  //    AssetEvents of loans that were fully returned in the year (their plan and complete rows go together).
  //  - What never moves: Sessions, AttendanceSummaries, Loans, LoanItems and AuditEvents. So student history, totals and the
  //    audit chain read the same before and after. A session that has been archived says so in Sessions.archivedAt and refuses
  //    corrections and rebuilds.
  //  - Every batch runs under the script lock: copy the rows, read the copy back and compare it cell by cell, and only then
  //    delete the live rows (last block first, so row numbers never shift under us). Rows already in the archive are not
  //    copied twice, so a run that stops half way (deadline, error) is simply run again.
  //  - Whole sessions only. A session with a correction waiting for approval, or with an unfinished open-lab closing journal,
  //    is skipped and picked up by a later run.
  // ===========================================================================================================================
  ARCHIVE_NAME: 'LABFLOW Archive ',
  ARCHIVE_TABLES: ['AttendanceEvents', 'RescanWindows', 'SpotChecks', 'Redemptions', 'AssetEvents', 'SystemLog', 'JobRuns', 'Notifications'],
  CHUNK_SESSIONS: 100,
  ROWS_PER_BATCH: 2000,
  MANUAL_BUDGET_MS: 200000,
  AUTO_MONTH: 7,

  _startMonth: function () { return Settings.get('academicYearStartMonth'); },
  _yearLabel: function (startYear) { return Backup._startMonth() === 1 ? String(startYear) : startYear + '-' + U.p2((startYear + 1) % 100); },
  /** First calendar year of the academic year that contains a YYYY-MM-DD date. */
  _yearStartOf: function (ymd) { return +ymd.slice(5, 7) >= Backup._startMonth() ? +ymd.slice(0, 4) : +ymd.slice(0, 4) - 1; },
  _yearRange: function (label) {
    var start = +String(label || '').slice(0, 4);
    if (!start || Backup._yearLabel(start) !== label) fail('BAD_INPUT', 'Use an academic year such as ' + Backup._yearLabel(U.local(U.now()).y - 1) + '.');
    var sm = U.p2(Backup._startMonth()), from = start + '-' + sm + '-01', to = (start + 1) + '-' + sm + '-01';
    return { label: label, start: start, from: from, to: to, fromMs: U.dayStart(from), toMs: U.dayStart(to) };
  },
  /** Academic years that have ended and still hold closed, unarchived sessions; auto marks the ones July archives by itself. */
  _endedYears: function () {
    var now = U.now(), cur = Backup._yearStartOf(U.local(now).date), first = null;
    Db.where('Sessions', function (s) { return s.status === 'closed' && !s.archivedAt && s.date; }).forEach(function (s) { var y = Backup._yearStartOf(s.date); if (first === null || y < first) first = y; });
    var out = [];
    if (first === null) return out;
    for (var y = first; y < cur; y++) out.push({ year: Backup._yearLabel(y), auto: y < cur - 1 });
    return out;
  },

  _ci: function (table, name) {
    var c = Cfg.SCHEMA[table];
    for (var i = 0; i < c.length; i++) if (c[i].name === name) return i;
    throw new Error('Unknown column ' + table + '.' + name);
  },
  /** One column of a live table for rows 2..last: index i is sheet row i + 2. */
  _col: function (table, name) {
    var s = Db.sheet(table), last = s.getLastRow();
    if (last < 2) return [];
    return s.getRange(2, Backup._ci(table, name) + 1, last - 1, 1).getValues().map(function (r) { return r[0]; });
  },
  /** Sheet row numbers (ascending) where test(value) holds for one column. */
  _pick: function (table, name, test) {
    var vals = Backup._col(table, name), out = [];
    for (var i = 0; i < vals.length; i++) if (test(vals[i])) out.push(i + 2);
    return out;
  },
  _blocks: function (rowNums) {
    var out = [], i = 0;
    while (i < rowNums.length) { var j = i; while (j + 1 < rowNums.length && rowNums[j + 1] === rowNums[j] + 1) j++; out.push([rowNums[i], j - i + 1]); i = j + 1; }
    return out;
  },
  _rowsAt: function (sheet, ncols, rowNums) {
    var out = [];
    Backup._blocks(rowNums).forEach(function (b) { sheet.getRange(b[0], 1, b[1], ncols).getValues().forEach(function (r) { out.push(r); }); });
    return out;
  },
  /** Delete the rows, last block first so the numbers of the earlier blocks do not move. */
  _deleteRowNums: function (sheet, rowNums) {
    if (!rowNums.length) return;
    // A sheet cannot lose every row below the header; keep one spare row in the grid.
    if (sheet.getMaxRows() <= rowNums[rowNums.length - 1]) sheet.insertRowsAfter(sheet.getMaxRows(), 1);
    var blocks = Backup._blocks(rowNums);
    for (var b = blocks.length - 1; b >= 0; b--) sheet.deleteRows(blocks[b][0], blocks[b][1]);
  },
  _pkSet: function (sheet) {
    var last = sheet.getLastRow(), set = {};
    if (last >= 2) sheet.getRange(2, 1, last - 1, 1).getValues().forEach(function (r) { if (r[0] !== '' && r[0] !== null) set[String(r[0])] = true; });
    return set;
  },
  /** Grow an archive sheet; new rows keep the plain-text format (same rule as Db). */
  _ensureRows: function (sheet, table, lastNeeded) {
    var max = sheet.getMaxRows();
    if (lastNeeded <= max) return;
    var add = Math.max(500, lastNeeded - max);
    sheet.insertRowsAfter(max, add);
    Cfg.SCHEMA[table].forEach(function (c, i) { if (c.type === 's' || c.type === 'j') sheet.getRange(max + 1, i + 1, add, 1).setNumberFormat('@'); });
  },

  _archiveMap: function () {
    try { var m = JSON.parse(PropertiesService.getScriptProperties().getProperty(Cfg.PROP.ARCHIVES) || '{}'); return m && typeof m === 'object' ? m : {}; } catch (e) { return {}; }
  },
  /** The archive spreadsheet of one academic year (created on first use when create is true). Never silently replaces a lost one. */
  _archiveBook: function (label, create) {
    var map = Backup._archiveMap(), id = map[label], ss = null;
    if (id) {
      try { ss = SpreadsheetApp.openById(id); }
      catch (e) { fail('ARCHIVE_MISSING', 'The archive spreadsheet for ' + label + ' cannot be opened, so nothing was moved. Restore access to it, then run again.'); }
    } else if (create) {
      ss = SpreadsheetApp.create(Backup.ARCHIVE_NAME + label);
      map[label] = ss.getId();
      PropertiesService.getScriptProperties().setProperty(Cfg.PROP.ARCHIVES, JSON.stringify(map));
      try { DriveApp.getFileById(ss.getId()).moveTo(Setup.folder(Cfg.PROP.ARCHIVE_FOLDER, 'LABFLOW Archive')); } catch (e) { /* tidiness only */ }
    }
    if (ss) Setup.ensureSchema(ss, Backup.ARCHIVE_TABLES);
    return ss;
  },
  _archiveList: function () {
    var map = Backup._archiveMap();
    return Object.keys(map).sort().map(function (label) {
      var url = null; try { url = SpreadsheetApp.openById(map[label]).getUrl(); } catch (e) { /* listed without a link */ }
      return { year: label, name: Backup.ARCHIVE_NAME + label, url: url };
    });
  },

  /**
   * Copy live rows (ascending sheet row numbers) to the archive, check the copy, then delete them from the live sheet.
   * Caller holds the script lock. Returns how many rows left the live sheet.
   */
  _move: function (book, table, rowNums, state) {
    if (!rowNums.length) return 0;
    var live = Db.sheet(table), ncols = Cfg.SCHEMA[table].length, arch = book.getSheetByName(table);
    if (!arch) fail('ARCHIVE_VERIFY', 'The archive has no ' + table + ' sheet.');
    var rows = Backup._rowsAt(live, ncols, rowNums), have = state.have[table] || (state.have[table] = Backup._pkSet(arch));
    var fresh = rows.filter(function (r) { return !have[String(r[0])]; });
    for (var i = 0; i < fresh.length; i += Backup.ROWS_PER_BATCH) {
      var slice = fresh.slice(i, i + Backup.ROWS_PER_BATCH), start = arch.getLastRow() + 1;
      Backup._ensureRows(arch, table, start + slice.length - 1);
      arch.getRange(start, 1, slice.length, ncols).setValues(slice);
      var back = arch.getRange(start, 1, slice.length, ncols).getValues();
      for (var k = 0; k < slice.length; k++) {
        if (JSON.stringify(back[k]) !== JSON.stringify(slice[k])) fail('ARCHIVE_VERIFY', 'The copy of a ' + table + ' row did not match. Nothing was deleted.');
        have[String(slice[k][0])] = true;
      }
    }
    rows.forEach(function (r) { if (!have[String(r[0])]) fail('ARCHIVE_VERIFY', 'A ' + table + ' row is missing from the archive. Nothing was deleted.'); });
    Backup._deleteRowNums(live, rowNums);
    var gone = {}; rows.forEach(function (r) { gone[String(r[0])] = true; });
    Backup._col(table, Cfg.SCHEMA[table][0].name).forEach(function (v) { if (gone[String(v)]) fail('ARCHIVE_VERIFY', 'A ' + table + ' row is still in the live sheet after deleting it.'); });
    return rows.length;
  },

  _pendingJournals: function () {
    var out = {};
    Db.where('JobRuns', function (r) { return r.job === 'openlabClose' && r.status === 'pending'; }).forEach(function (r) { if (r.detail && r.detail.sessionId) out[r.detail.sessionId] = true; });
    return out;
  },
  _summaryIndex: function () {
    var out = {};
    Db.readAll('AttendanceSummaries').forEach(function (x) { (out[x.sessionId] = out[x.sessionId] || {})[x.studentId] = true; });
    return out;
  },
  /** For one batch of sessions: why a session must wait, and which students have a check-in but no stored summary. */
  _inspect: function (ids, state) {
    var set = {}, skip = {}, needSummary = {};
    ids.forEach(function (id) { set[id] = true; if (state.journals[id]) skip[id] = 'open-lab closing has not finished'; });
    var sid = Backup._col('AttendanceEvents', 'sessionId'), type = Backup._col('AttendanceEvents', 'type'), who = Backup._col('AttendanceEvents', 'studentId'),
        status = Backup._col('AttendanceEvents', 'approvalStatus'), ref = Backup._col('AttendanceEvents', 'ref'), eid = Backup._col('AttendanceEvents', 'eventId'), decided = {}, i;
    for (i = 0; i < type.length; i++) if (type[i] === 'DECISION') decided[String(ref[i])] = true;
    for (i = 0; i < sid.length; i++) {
      if (!set[sid[i]]) continue;
      if ((type[i] === 'CORR_IN' || type[i] === 'CORR_OUT' || type[i] === 'VOID') && status[i] === 'pending' && !decided[String(eid[i])]) skip[sid[i]] = 'a correction is waiting for approval';
      if ((type[i] === 'IN' || type[i] === 'CORR_IN') && !((state.sums[sid[i]] || {})[who[i]])) needSummary[sid[i]] = true;
    }
    return { skip: skip, needSummary: needSummary };
  },
  _runChunk: function (book, ids, state, res) {
    Locks.with(function () {
      var look = Backup._inspect(ids, state), ok = ids.filter(function (id) { return !look.skip[id]; });
      Object.keys(look.skip).forEach(function (id) { res.skipped.push({ sessionId: id, reason: look.skip[id] }); });
      if (!ok.length) return;
      if (!state.dry) Object.keys(look.needSummary).forEach(function (id) { if (ok.indexOf(id) >= 0) Attend.rebuildSummary(id); }); // never lose a total: derive it before the events go
      var set = {}; ok.forEach(function (id) { set[id] = true; });
      ['AttendanceEvents', 'RescanWindows', 'SpotChecks'].forEach(function (table) {
        var rows = Backup._pick(table, 'sessionId', function (v) { return set[v] === true; });
        res.moved[table] = (res.moved[table] || 0) + (state.dry ? rows.length : Backup._move(book, table, rows, state));
      });
      if (!state.dry) { var now = U.now(); ok.forEach(function (id) { Db.update('Sessions', id, { archivedAt: now }); }); }
      res.sessions += ok.length;
    });
  },

  /** Row selectors for the tables that are archived by date or by loan instead of by session. */
  _sweeps: function (range) {
    var between = function (v) { return v !== '' && v !== null && v >= range.fromMs && v < range.toMs; };
    return [
      { table: 'Redemptions', select: function () { return Backup._pick('Redemptions', 'at', between); } },
      { table: 'SystemLog', select: function () { return Backup._pick('SystemLog', 'at', between); } },
      { table: 'JobRuns', select: function () {
        var at = Backup._col('JobRuns', 'startedAt'), st = Backup._col('JobRuns', 'status'), job = Backup._col('JobRuns', 'job'), out = [];
        for (var i = 0; i < at.length; i++) if (between(at[i]) && st[i] !== 'pending' && !/^archive/.test(String(job[i]))) out.push(i + 2);
        return out;
      } },
      { table: 'Notifications', select: function () {
        var at = Backup._col('Notifications', 'createdAt'), read = Backup._col('Notifications', 'readAt'), out = [];
        for (var i = 0; i < at.length; i++) if (between(at[i]) && read[i] !== '' && read[i] !== null) out.push(i + 2);
        return out;
      } },
      { table: 'AssetEvents', select: function () { return Backup._assetEventRows(range); } }
    ];
  },
  /** Ledger rows of loans fully returned in the year. A loan with a return plan that was never completed stays until recovery ends it. */
  _assetEventRows: function (range) {
    var loans = {}, any = false;
    Db.where('Loans', function (l) { return l.status === 'closed' && l.returnedAt && l.returnedAt >= range.fromMs && l.returnedAt < range.toMs; }).forEach(function (l) { loans[l.loanId] = true; any = true; });
    if (!any) return [];
    var lid = Backup._col('AssetEvents', 'loanId'), type = Backup._col('AssetEvents', 'type'), key = Backup._col('AssetEvents', 'idemKey'), done = {}, plans = {}, i;
    for (i = 0; i < type.length; i++) {
      if (type[i] === 'return-complete') done[String(key[i])] = true;
      else if (type[i] === 'return-plan' && loans[lid[i]]) (plans[lid[i]] = plans[lid[i]] || []).push(String(key[i]).replace('ret-plan:', 'ret-done:'));
    }
    var ready = {}; Object.keys(loans).forEach(function (id) { if ((plans[id] || []).every(function (k) { return done[k]; })) ready[id] = true; });
    var out = []; for (i = 0; i < lid.length; i++) if (ready[lid[i]]) out.push(i + 2);
    return out;
  },
  _sweep: function (book, sweep, state, res, ctl) {
    for (;;) {
      if ((ctl.deadline && U.now() > ctl.deadline) || (ctl.chunkLimit && ctl.chunks >= ctl.chunkLimit)) return false;
      var moved = Locks.with(function () {
        var rows = sweep.select();
        if (state.dry) { res.moved[sweep.table] = (res.moved[sweep.table] || 0) + rows.length; return -1; }
        rows = rows.slice(0, Backup.ROWS_PER_BATCH);
        return rows.length ? Backup._move(book, sweep.table, rows, state) : 0;
      });
      if (moved <= 0) return true;
      res.moved[sweep.table] = (res.moved[sweep.table] || 0) + moved;
      ctl.chunks++;
    }
  },

  /** Archive (or, with dry, only count) one academic year. opts: dry, deadline (ms), chunkLimit (batches per call). */
  _archiveOne: function (label, opts) {
    opts = opts || {};
    var range = Backup._yearRange(label), dry = !!opts.dry, ctl = { deadline: opts.deadline || 0, chunkLimit: opts.chunkLimit || 0, chunks: 0 };
    var res = { year: label, dryRun: dry, status: 'complete', sessions: 0, moved: {}, skipped: [], archiveUrl: null };
    var book = Backup._archiveBook(label, !dry), state = { dry: dry, have: {}, journals: Backup._pendingJournals(), sums: Backup._summaryIndex() };
    var sessions = Db.where('Sessions', function (s) { return s.status === 'closed' && !s.archivedAt && s.date >= range.from && s.date < range.to; })
      .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.sessionId < b.sessionId ? -1 : 1; }).map(function (s) { return s.sessionId; });
    var stopped = false;
    for (var i = 0; i < sessions.length && !stopped; i += Backup.CHUNK_SESSIONS) {
      if ((ctl.deadline && U.now() > ctl.deadline) || (ctl.chunkLimit && ctl.chunks >= ctl.chunkLimit)) { stopped = true; break; }
      Backup._runChunk(book, sessions.slice(i, i + Backup.CHUNK_SESSIONS), state, res); ctl.chunks++;
    }
    var sweeps = Backup._sweeps(range);
    for (var k = 0; k < sweeps.length && !stopped; k++) if (!Backup._sweep(book, sweeps[k], state, res, ctl)) stopped = true;
    if (stopped) res.status = 'partial';
    if (book) res.archiveUrl = book.getUrl();
    if (!dry && !stopped && !Db.where('JobRuns', function (j) { return j.job === 'archive:' + label; }).length) {
      Db.insert('JobRuns', { runId: U.id('run'), job: 'archive:' + label, startedAt: U.now(), finishedAt: U.now(), status: 'ok', detail: { sessions: res.sessions, moved: res.moved } });
    }
    return res;
  },

  _backupName: function () { return Backup.PREFIX + U.local(U.now()).date; },
  _hasBackupToday: function () { var name = Backup._backupName(); return Backup._entries(Backup._folder()).some(function (e) { return e.name === name; }); },

  /**
   * Super admin. Without a year: what could be archived (dry run per ended academic year). With a year: archive it
   * (dryRun: true only counts). A backup copy of today is made first when there is none, so the move can always be undone.
   */
  archiveYear: function (ctx, p) {
    p = p || {};
    if (!p.year) {
      var plan = Backup._endedYears().map(function (y) { var r = Backup._archiveOne(y.year, { dry: true }); r.auto = y.auto; return r; });
      return { plan: plan, archives: Backup._archiveList(), startMonth: Backup._startMonth() };
    }
    var label = V.str(p.year, 'Academic year', { max: 9 }), range = Backup._yearRange(label), dry = p.dryRun === true;
    if (range.toMs > U.now()) fail('INVALID_STATE', 'That academic year has not ended yet, so it cannot be archived.');
    if (!dry && !Backup._hasBackupToday()) Backup._copy(Backup._backupName(), Backup._folder());
    var res = Backup._archiveOne(label, { dry: dry, deadline: U.now() + Backup.MANUAL_BUDGET_MS });
    if (!dry) Audit.log({ actor: ctx.email, role: 'admin', action: 'archive.run', entityType: 'Archive', entityId: label, detail: { status: res.status, sessions: res.sessions, moved: res.moved, skipped: res.skipped.length } });
    res.archives = Backup._archiveList();
    return res;
  },

  /**
   * Nightly job step. Each July, archive every ended academic year older than the previous one. Needs a backup made today,
   * and writes a JobRuns marker only when everything finished, so an interrupted run carries on the next night.
   */
  autoArchive: function (deadline) {
    var t = U.local(U.now());
    if (t.m !== Backup.AUTO_MONTH) return { skipped: 'not July' };
    var marker = 'archiveAuto:' + t.y;
    if (Db.where('JobRuns', function (j) { return j.job === marker && j.status === 'ok'; }).length) return { skipped: 'already done this July' };
    if (!Backup._hasBackupToday()) return { skipped: 'no backup copy from today' };
    var years = Backup._endedYears().filter(function (y) { return y.auto; }), out = [], complete = true;
    years.forEach(function (y) {
      if (!complete) return;
      var r = Backup._archiveOne(y.year, { deadline: deadline });
      out.push({ year: y.year, status: r.status, sessions: r.sessions, moved: r.moved, skipped: r.skipped.length });
      if (r.status !== 'complete') complete = false;
    });
    if (out.some(function (r) { return r.sessions; })) Audit.tryLog({ actor: 'system', role: 'system', action: 'archive.auto', entityType: 'Archive', entityId: String(t.y), detail: { years: out } });
    if (complete) Db.insert('JobRuns', { runId: U.id('run'), job: marker, startedAt: U.now(), finishedAt: U.now(), status: 'ok', detail: { years: out.length } });
    return { years: out, complete: complete };
  }
};
