const test = require('node:test');
const assert = require('node:assert/strict');
const { world } = require('./fixtures');

// A4: the yearly archive. Real flows build the history; the clock is then moved past the end of the academic year.
const YEAR = '2026-27'; // the fixtures run on 2026-10-14, so their sessions belong to 1 June 2026 - 31 May 2027
const goto = (w, date, time = '10:00') => w.e.setTime(w.eval(`U.fromLocal('${date}','${time}')`));
const count = (w, table) => w.eval(`Db.count('${table}')`);
const archiveBook = (w, year = YEAR) => w.e.spreadsheets[JSON.parse(w.eval("PropertiesService.getScriptProperties().getProperty(Cfg.PROP.ARCHIVES)"))[year]];
const archived = (w, table, year) => Math.max(0, archiveBook(w, year).getSheetByName(table).getLastRow() - 1);
let n = 0;
const key = () => 'idem-' + String(++n).padStart(6, '0') + '-abcdefghij';

/** A finished class: three students come in, two leave, one never scans out; the faculty closes the session. */
function held() {
  const w = world({ students: 3 });
  w.sid = w.session().sessionId;
  w.ok(w.faculty, 'sessions.open', { sessionId: w.sid });
  const [a, b, c] = w.students;
  for (const s of w.students) assert.equal(w.checkin(s).ok, true);
  w.advance(3600000);
  assert.equal(w.checkin(a, { action: 'out' }).ok, true); assert.equal(w.checkin(b, { action: 'out' }).ok, true);
  w.advance(600000);
  w.ok(w.faculty, 'sessions.close', { sessionId: w.sid });
  w.c = c;
  return w;
}
const snap = (w) => ({
  history: w.students.map((s) => w.ok(s.email, 'attend.history')),
  report: w.students.map((s) => { const r = w.ok(w.staff, 'reports.run', { type: 'student', studentId: s.studentId, from: '2026-10-01', to: '2026-10-31' }); return { hours: r.meta.totals.hours, days: r.meta.totals.distinctDays, rows: r.rows, note: r.meta.note }; }),
  sums: w.eval("Db.readAll('AttendanceSummaries').map(function (x) { return [x.sumId, x.status, x.firstIn, x.lastOut, x.verifiedMinutes, x.flags]; })"),
  roster: w.ok(w.faculty, 'attend.roster', { sessionId: w.sid }),
});
const rosterRows = (r) => r.roster.map((x) => [x.studentId, x.status, x.firstIn, x.lastOut, x.verifiedMinutes, x.flags]);

/** Hand-made closed sessions and events, for the cases that are awkward to reach through the real flows. */
function craft(w, id, date, studentId, extra) {
  w.e.run(`(function(){
    Db.insert('Sessions', { sessionId: '${id}', type: 'class', labId: '${w.lab.labId}', courseId: '${w.course.courseId}', facultyId: '${w.facultyId}', title: 'Crafted ${id}', slotKey: 'x|${id}', section: 'A', date: '${date}',
      scheduledStart: 1000, scheduledEnd: 2000, status: 'closed', openedAt: 1000, closedAt: 2000, createdAt: 1000 });
    Db.insert('AttendanceEvents', { eventId: 'E-${id}-1', sessionId: '${id}', labId: '${w.lab.labId}', studentId: '${studentId}', type: 'IN', source: 'manual', at: 1100, createdAt: 1100, approvalStatus: 'na' });
    Db.insert('AttendanceEvents', { eventId: 'E-${id}-2', sessionId: '${id}', labId: '${w.lab.labId}', studentId: '${studentId}', type: 'OUT', source: 'manual', at: 1900, createdAt: 1900, approvalStatus: 'na' });
    Db.insert('AttendanceSummaries', { sumId: '${id}:${studentId}', sessionId: '${id}', studentId: '${studentId}', status: 'present', firstIn: 1100, lastOut: 1900, verifiedUntil: 1900, verifiedMinutes: 1, flags: [], computedAt: 2000 });
    Db.insert('RescanWindows', { windowId: 'W-${id}', sessionId: '${id}', kind: 'rescan', openedAt: 1200, closesAt: 1300, openedBy: 'x', status: 'closed' });
  })()`);
  if (extra) w.e.run(extra);
}

test('archive: moves a finished year, and history, totals, the roster and the audit chain read the same afterwards', () => {
  const w = held(), before = snap(w), sid = w.sid, [a] = w.students;
  const n0 = count(w, 'AttendanceEvents'); assert.ok(n0 >= 5);
  goto(w, '2027-07-15');
  const dry = w.ok(w.admin, 'system.archive', { year: YEAR, dryRun: true });
  assert.equal(dry.dryRun, true); assert.equal(dry.sessions, 1); assert.equal(dry.moved.AttendanceEvents, n0);
  assert.equal(count(w, 'AttendanceEvents'), n0, 'a dry run moves nothing');
  assert.equal(w.eval("PropertiesService.getScriptProperties().getProperty(Cfg.PROP.ARCHIVES)"), null, 'and creates no archive spreadsheet');

  const r = w.ok(w.admin, 'system.archive', { year: YEAR });
  assert.equal(r.status, 'complete'); assert.equal(r.sessions, 1); assert.equal(r.moved.AttendanceEvents, n0);
  assert.equal(count(w, 'AttendanceEvents'), 0, 'the live row count drops');
  assert.equal(archived(w, 'AttendanceEvents'), n0, 'the archive holds the rows');
  assert.equal(archiveBook(w).name, 'LABFLOW Archive 2026-27');
  assert.ok(w.eval(`Db.get('Sessions','${sid}').archivedAt`) > 0);

  const after = snap(w);
  assert.deepEqual(after.history, before.history, 'student history is unchanged');
  assert.deepEqual(after.sums, before.sums, 'stored summaries are untouched');
  assert.deepEqual(after.report.map((x) => [x.hours, x.days, x.rows]), before.report.map((x) => [x.hours, x.days, x.rows]), 'student report hours, days and rows are unchanged');
  assert.match(after.report[0].note, /archived/);
  assert.deepEqual(rosterRows(after.roster), rosterRows(before.roster), 'the roster of the archived session still lists everyone');
  assert.equal(after.roster.archived, true); assert.equal(after.roster.counts.attended, before.roster.counts.attended); assert.equal(after.roster.counts.absent, before.roster.counts.absent);

  assert.equal(w.err(w.faculty, 'attend.correct', { sessionId: sid, studentId: a.studentId, action: 'add_in', reason: 'Forgot to scan in the morning' }).code, 'ARCHIVED');
  assert.equal(w.err(w.admin, 'system.reconcileSession', { sessionId: sid }).code, 'ARCHIVED');
  assert.throws(() => w.e.run(`Attend.rebuildSummary('${sid}')`), /archived/i);
  assert.equal(w.ok(w.admin, 'audit.verify').ok, true, 'the audit chain still verifies');
  assert.ok(w.eval("Db.readAll('AuditEvents')").some((e) => e.action === 'archive.run' && e.entityId === YEAR));

  const again = w.ok(w.admin, 'system.archive', { year: YEAR });
  assert.equal(again.status, 'complete'); assert.equal(again.sessions, 0); assert.equal(archived(w, 'AttendanceEvents'), n0, 'running it again copies nothing twice');
});

test('archive: reports that need scan-level detail say archived instead of showing short numbers', () => {
  const w = held();
  const digest0 = w.ok(w.staff, 'reports.run', { type: 'digest', date: '2026-10-14' });
  goto(w, '2027-07-15'); w.ok(w.admin, 'system.archive', { year: YEAR });
  const session = w.ok(w.staff, 'reports.run', { type: 'session', sessionId: w.sid });
  assert.equal(session.rows.length, 3); assert.ok(session.rows.every((r) => r[6] === 'archived')); assert.equal(session.meta.archived, true); assert.match(session.meta.note, /archived/);
  const erp = w.ok(w.admin, 'reports.run', { type: 'erp', from: '2026-10-01', to: '2026-10-31' });
  assert.equal(erp.rows.length, 3); assert.ok(erp.rows.every((r) => r[12] === 'archived')); assert.match(erp.meta.note, /1 archived session/);
  const digest = w.ok(w.staff, 'reports.run', { type: 'digest', date: '2026-10-14' });
  assert.equal(digest.summary.find((x) => x[0] === 'Unique visits')[1], digest0.summary.find((x) => x[0] === 'Unique visits')[1], 'visitors still counted, from the stored summaries');
  assert.match(digest.meta.note, /archived/);
  const events = w.ok(w.faculty, 'attend.studentEvents', { sessionId: w.sid, studentId: w.students[0].studentId });
  assert.equal(events.archived, true); assert.deepEqual(events.events, []);
});

test('archive: only whole, settled sessions move; a pending correction or unfinished closing journal waits', () => {
  const w = world({ students: 2 }), [s1, s2] = w.students;
  craft(w, 'SES-CORR', '2026-11-02', s1.studentId, `Db.insert('AttendanceEvents', { eventId: 'E-PEND', sessionId: 'SES-CORR', labId: '${w.lab.labId}', studentId: '${s1.studentId}', type: 'CORR_IN', source: 'manual', at: 1500, createdAt: 1500, approvalStatus: 'pending' })`);
  craft(w, 'SES-JRNL', '2026-11-03', s1.studentId, `Db.insert('JobRuns', { runId: Sessions._closeRunId('SES-JRNL'), job: 'openlabClose', startedAt: 1, status: 'pending', detail: { sessionId: 'SES-JRNL' } })`);
  craft(w, 'SES-OK', '2026-11-04', s2.studentId);
  goto(w, '2027-07-15');
  const r = w.ok(w.admin, 'system.archive', { year: YEAR });
  assert.equal(r.sessions, 1);
  assert.deepEqual(r.skipped.map((x) => x.sessionId).sort(), ['SES-CORR', 'SES-JRNL']);
  const left = w.eval("Db.readAll('AttendanceEvents').map(function (e) { return e.sessionId; })");
  assert.ok(!left.includes('SES-OK') && left.includes('SES-CORR') && left.includes('SES-JRNL'));
  assert.equal(w.eval("Db.get('Sessions','SES-CORR').archivedAt"), null);
  assert.equal(w.eval("Db.readAll('JobRuns').filter(function (j) { return j.status === 'pending'; }).length"), 1, 'the unfinished closing journal is kept');
  // once the correction is decided and the journal finishes, the next run picks them up
  w.e.run(`Db.insert('AttendanceEvents', { eventId: 'E-DEC', sessionId: 'SES-CORR', labId: '${w.lab.labId}', studentId: '${s1.studentId}', type: 'DECISION', source: 'manual', at: 1600, createdAt: 1600, approvalStatus: 'approved', ref: 'E-PEND' })`);
  w.e.run("Db.update('JobRuns', Sessions._closeRunId('SES-JRNL'), { status: 'ok', finishedAt: 5 })");
  const second = w.ok(w.admin, 'system.archive', { year: YEAR });
  assert.equal(second.sessions, 2); assert.equal(second.skipped.length, 0);
  assert.equal(count(w, 'AttendanceEvents'), 0);
});

test('archive: a run that stops part way carries on where it left off, and an error never leaves a half-moved session', () => {
  const w = world({ students: 1 }), [s] = w.students;
  ['A', 'B', 'C'].forEach((x, i) => craft(w, 'SES-' + x, '2026-11-0' + (i + 2), s.studentId));
  goto(w, '2027-07-15');
  w.e.run('Backup.CHUNK_SESSIONS = 1');
  const step = () => w.eval(`Backup._archiveOne('${YEAR}', { chunkLimit: 1 })`);
  const one = step(); assert.equal(one.status, 'partial'); assert.equal(one.sessions, 1);
  // the next batch fails after the copy but before the delete
  w.e.run("var __orig = Backup._deleteRowNums, __n = 0; Backup._deleteRowNums = function (s, r) { if (__n++ === 0) throw new Error('boom'); return __orig(s, r); };");
  assert.throws(() => step(), /boom/);
  assert.equal(w.eval("Db.get('Sessions','SES-B').archivedAt"), null, 'not marked archived while its rows are still live');
  assert.equal(count(w, 'AttendanceEvents'), 4, 'its rows are still live');
  const rest = []; let guard = 0;
  for (;;) { const r = step(); rest.push(r); if (r.status === 'complete' || ++guard > 10) break; }
  assert.equal(rest.at(-1).status, 'complete');
  assert.equal(count(w, 'AttendanceEvents'), 0);
  const ids = archiveBook(w).getSheetByName('AttendanceEvents').getRange(2, 1, 6, 1).getValues().map((r) => r[0]);
  assert.equal(ids.length, 6); assert.equal(new Set(ids).size, 6, 'six events in the archive, none twice');
  assert.equal(w.eval("Db.readAll('Sessions').filter(function (x) { return x.archivedAt; }).length"), 3);
});

test('archive: system log, job runs, read notifications, redemptions and returned-loan ledger rows move; open work stays', () => {
  const w = world({ students: 1 }), [s] = w.students;
  const cat = w.ok(w.staff, 'categories.upsert', { name: 'Arduino', trackingMode: 'individual' }).category;
  const [x, y] = [1, 2].map((i) => w.ok(w.staff, 'assets.upsert', { labId: w.lab.labId, categoryId: cat.categoryId, name: 'Arduino #' + i, assetTag: 'ARD-00' + i }).asset);
  const out = (asset) => w.ok(w.staff, 'loans.issue', { idemKey: key(), borrowerType: 'student', borrowerId: s.studentId, labId: w.lab.labId, items: [{ assetId: asset.assetId, qty: 1 }] }).loan;
  const done = out(x), open = out(y);
  w.ok(w.staff, 'loans.return', { idemKey: key(), loanId: done.loanId, lines: [{ loanItemId: done.items[0].loanItemId, qtyReturned: 1, conditionIn: 'good' }] });
  assert.equal(w.eval(`Db.get('Loans','${done.loanId}').status`), 'closed');
  w.e.run("Syslog.info('test', 'ONE', 'a log line'); Syslog.warn('test', 'TWO', 'another');");
  w.e.run(`(function(){ var t = U.now();
    Db.insert('Redemptions', { nonce: 'nonce-1', purpose: 'i', studentId: '${s.studentId}', at: t });
    Db.insert('JobRuns', { runId: 'run-ok', job: 'tickSessions', startedAt: t, finishedAt: t, status: 'ok' });
    Db.insert('JobRuns', { runId: 'run-wait', job: 'something', startedAt: t, status: 'pending' });
    Db.insert('JobRuns', { runId: 'run-marker', job: 'archive:old', startedAt: t, finishedAt: t, status: 'ok' });
    Db.insert('Notifications', { notificationId: 'N-read', userId: 'u', type: 't', title: 'read', body: 'b', createdAt: t, readAt: t, emailStatus: 'none' });
    Db.insert('Notifications', { notificationId: 'N-new', userId: 'u', type: 't', title: 'unread', body: 'b', createdAt: t, emailStatus: 'none' }); })()`);
  const ledger = (id) => w.eval(`Db.readAll('AssetEvents').filter(function (e) { return e.loanId === '${id}'; }).length`);
  assert.ok(ledger(done.loanId) >= 3); const openRows = ledger(open.loanId); assert.ok(openRows >= 1);
  const sysBefore = count(w, 'SystemLog');
  goto(w, '2027-07-15');
  const r = w.ok(w.admin, 'system.archive', { year: YEAR });
  assert.equal(r.status, 'complete');
  assert.equal(ledger(done.loanId), 0, 'the returned loan\'s plan and complete rows moved together'); assert.equal(ledger(open.loanId), openRows, 'a loan still out keeps its ledger');
  assert.ok(w.eval("Db.readAll('AssetEvents').some(function (e) { return e.type === 'create'; })"), 'stock creation rows have no loan and stay');
  assert.equal(archived(w, 'AssetEvents'), r.moved.AssetEvents);
  assert.ok(archived(w, 'SystemLog') >= 2 && count(w, 'SystemLog') < sysBefore + 1);
  assert.equal(archived(w, 'Redemptions'), 1); assert.equal(w.eval("Db.get('Redemptions','nonce-1')"), null);
  const runs = w.eval("Db.readAll('JobRuns').map(function (j) { return j.runId; })");
  assert.ok(!runs.includes('run-ok') && runs.includes('run-wait') && runs.includes('run-marker'), 'finished runs move; a pending one and an archive marker stay');
  assert.equal(w.eval("Db.get('Notifications','N-read')"), null); assert.ok(w.eval("Db.get('Notifications','N-new')"));
  assert.equal(w.ok(w.admin, 'system.reconcileInventory', { dryRun: true }).drift.length, 0, 'stock figures come from loans, so they are unaffected');
  assert.equal(w.ok(w.admin, 'audit.verify').ok, true);
});

test('archive: each July the nightly job archives years older than the previous one, needs today\'s backup, and runs once', () => {
  const w = held();
  const status = (days) => { w.advance(days * 86400000); Object.keys(w.e.cacheStore).filter((k) => k.startsWith('job|')).forEach((k) => delete w.e.cacheStore[k]); return JSON.parse(w.e.run('JSON.stringify(Jobs.nightly())')); };
  goto(w, '2027-07-10', '01:00');
  assert.equal(w.ok(w.admin, 'system.archive', {}).plan[0].auto, false, '2026-27 is the previous year in July 2027, so it waits for a manual run');
  let r = status(0); assert.equal(r.detail.archive.years.length, 0); assert.equal(count(w, 'AttendanceEvents') > 0, true);
  goto(w, '2028-07-10', '01:00');
  assert.equal(w.ok(w.admin, 'system.archive', {}).plan[0].auto, true);
  w.e.run("var __hb = Backup._hasBackupToday; Backup._hasBackupToday = function () { return false; }");
  r = status(0); assert.equal(r.detail.archive.skipped, 'no backup copy from today'); assert.ok(count(w, 'AttendanceEvents') > 0, 'nothing is deleted without a fresh backup');
  w.e.run("Backup._hasBackupToday = __hb");
  r = status(1);
  assert.equal(r.detail.backup.created !== null, true);
  assert.equal(r.detail.archive.complete, true); assert.equal(r.detail.archive.years[0].year, YEAR); assert.equal(count(w, 'AttendanceEvents'), 0);
  assert.ok(w.eval("Db.readAll('AuditEvents')").some((e) => e.action === 'archive.auto'));
  r = status(1); assert.equal(r.detail.archive.skipped, 'already done this July');
  goto(w, '2028-09-10'); r = status(0); assert.equal(r.detail.archive.skipped, 'not July');
});

test('archive: guards - admin only, ended years only, valid labels, and a backup is made first', () => {
  const w = held();
  assert.equal(w.err(w.staff, 'system.archive', { year: YEAR }).code, 'FORBIDDEN');
  assert.equal(w.err(w.admin, 'system.archive', { year: YEAR }).code, 'INVALID_STATE', 'the running year cannot be archived');
  goto(w, '2027-07-15');
  assert.equal(w.err(w.admin, 'system.archive', { year: '2026' }).code, 'BAD_INPUT');
  assert.equal(w.err(w.admin, 'system.archive', { year: '2026-28' }).code, 'BAD_INPUT');
  assert.equal(w.ok(w.admin, 'system.backups').backups.length, 0);
  w.ok(w.admin, 'system.archive', { year: YEAR });
  assert.equal(w.ok(w.admin, 'system.backups').backups.length, 1, 'a backup of the day was made before anything moved');
  w.e.run("Backup._archiveBook = function () { throw Object.assign(new Error('gone'), { code: 'ARCHIVE_MISSING' }); }");
  assert.throws(() => w.e.run(`Backup._archiveOne('${YEAR}', {})`), /gone/);
});

test('archive: the HOD still sees a student whose only attendance is in an archived session', () => {
  const w = world({ students: 1 });
  w.ok(w.admin, 'students.import', { rows: [{ rollNo: 'S900', name: 'Walk In', email: 'walkin@karunya.edu' }] });
  const id = w.eval("Db.getBy('StudentProfiles','rollNo','S900').studentId");
  craft(w, 'SES-WALK', '2026-11-02', id);
  const sees = () => w.ok(w.hod, 'students.list', {}).students.some((x) => x.rollNo === 'S900');
  assert.equal(sees(), true);
  goto(w, '2027-07-15'); w.ok(w.admin, 'system.archive', { year: YEAR });
  assert.equal(count(w, 'AttendanceEvents'), 0);
  assert.equal(sees(), true, 'the stored summary stands in for the moved events');
});
