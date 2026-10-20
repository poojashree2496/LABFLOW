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
    var today = U.local(U.now()).date, folder = Backup._folder(), entries = Backup._entries(folder), plan = Backup._plan(entries, today);
    return { backups: entries.slice().reverse().map(function (e) { return Backup._view(e, plan.keep); }),
             retention: { dailyDays: Backup.DAILY_KEEP, monthlyMonths: Backup.MONTHLY_KEEP }, folderUrl: folder.getUrl() };
  },

  archiveYear: function () { notBuilt_('A4'); }
};
