const test = require('node:test');
const assert = require('node:assert/strict');
const { load, initDb } = require('./harness');

function fresh() { const e = load(); initDb(e); return e; }

test('time: Asia/Kolkata conversion round-trips and handles day boundaries', () => {
  const e = load();
  // 2026-10-14 23:45 IST == 2026-10-14 18:15 UTC
  const ms = Date.UTC(2026, 9, 14, 18, 15);
  assert.deepEqual(JSON.parse(e.run(`JSON.stringify(U.local(${ms}))`)), { y: 2026, m: 10, d: 14, H: 23, M: 45, dow: 3, date: '2026-10-14', time: '23:45', month: '2026-10' });
  // 00:30 IST next day is still the previous UTC day
  assert.equal(e.run(`U.local(${Date.UTC(2026, 9, 14, 19, 0)}).date`), '2026-10-15');
  assert.equal(e.run(`U.fromLocal('2026-10-14','23:45')`), ms);
  assert.equal(e.run(`U.local(U.fromLocal('2026-03-01','00:00')).date`), '2026-03-01');
  assert.equal(e.run(`U.addDays('2026-02-28', 1)`), '2026-03-01');
  assert.equal(e.run(`U.addDays('2026-12-31', 1)`), '2027-01-01');
  // Sunday is ISO day 7
  assert.equal(e.run(`U.local(U.fromLocal('2026-10-18','10:00')).dow`), 7);
});

test('time: invalid dates and times are rejected', () => {
  const e = load();
  for (const bad of ['2026-02-30', '2026-13-01', '26-01-01', '', null, '2026-1-1']) assert.equal(e.run(`U.isDate(${JSON.stringify(bad)})`), false, String(bad));
  for (const bad of ['24:00', '9:30', '12:60', 'ab:cd']) assert.equal(e.run(`U.isTime(${JSON.stringify(bad)})`), false, bad);
  assert.throws(() => e.run(`U.fromLocal('2026-02-30','10:00')`), /Invalid date/);
});

test('bytes: signed Apps Script bytes are normalised; hashes match Node', () => {
  const e = load();
  const crypto = require('node:crypto');
  assert.equal(e.run(`U.sha256Hex('labflow')`), crypto.createHash('sha256').update('labflow').digest('hex'));
  // The raw Utilities digest really is signed (negative values) - the trap this helper exists for.
  assert.ok(e.run(`Utilities.computeDigest('SHA_256','labflow').some(function(b){return b<0;})`));
  assert.ok(e.run(`U.sha256Bytes('labflow')`).every((b) => b >= 0 && b <= 255));
  assert.equal(e.run(`U.hmacB64u('k','m')`), crypto.createHmac('sha256', 'k').update('m').digest('base64url'));
  const b64 = e.run(`U.b64uEncode('hello world?>')`);
  assert.equal(Buffer.from(Array.from(e.run(`U.b64uDecode('${b64}')`))).toString(), 'hello world?>');
  assert.throws(() => e.run(`U.b64uDecode('a b')`), /Malformed/);
});

test('csv: formula injection is neutralised, quoting is correct', () => {
  const e = load();
  assert.equal(e.run(`U.csvSafe('=HYPERLINK("x")')`), `"'=HYPERLINK(""x"")"`);
  assert.equal(e.run(`U.csvSafe('+1')`), "'+1");
  assert.equal(e.run(`U.csvSafe('@SUM(A1)')`), "'@SUM(A1)");
  assert.equal(e.run(`U.csvSafe('a,b')`), '"a,b"');
  assert.equal(e.run(`U.csvSafe(null)`), '');
  assert.equal(e.run(`U.csvSafe(12)`), '12');
});

test('validators reject bad input with BAD_INPUT', () => {
  const e = load();
  const bad = (code) => assert.throws(() => e.run(code), (err) => err.code === 'BAD_INPUT' || /BAD_INPUT/.test(String(err.code)));
  bad(`V.str('', 'Name')`); bad(`V.str('x'.repeat(300), 'Name')`); bad(`V.int('abc','N',1,5)`); bad(`V.int(9,'N',1,5)`);
  bad(`V.int(1.5,'N',1,5)`); bad(`V.email('not-an-email')`); bad(`V.rollNo('a b')`); bad(`V.enumOf('x','K',['a','b'])`);
  bad(`V.id('X-1','id','lab')`); bad(`V.str('a\\u0000b','Name')`);
  assert.equal(e.run(`V.email('  Armaan@Karunya.EDU ')`), 'armaan@karunya.edu');
  assert.equal(e.run(`V.rollNo('urk23cs1001')`), 'URK23CS1001');
  assert.equal(e.run(`V.int('7','N',1,10)`), 7);
});

test('db: insert / get / update / types round-trip; text columns keep leading zeros', () => {
  const e = fresh();
  e.run(`Db.insert('StudentProfiles', { studentId:'STU-000000000001', rollNo:'007', email:'a@karunya.edu', name:'A', year:3, status:'verified', createdAt: 5 })`);
  const r = e.run(`Db.getBy('StudentProfiles','rollNo','007')`);
  assert.equal(r.rollNo, '007'); assert.equal(r.year, 3); assert.equal(typeof r.year, 'number');
  e.run(`Db.update('StudentProfiles','STU-000000000001',{ name:'B', year:4 })`);
  const r2 = e.run(`Db.get('StudentProfiles','STU-000000000001')`);
  assert.equal(r2.name, 'B'); assert.equal(r2.year, 4); assert.equal(r2.rollNo, '007');
  // json + bool columns
  e.run(`Db.insert('AttendanceSummaries', { sumId:'S1', sessionId:'X', studentId:'Y', flags:['a','b'], verifiedMinutes: 12.5 })`);
  const s = e.run(`Db.get('AttendanceSummaries','S1')`);
  assert.deepEqual(Array.from(s.flags), ['a', 'b']); assert.equal(s.verifiedMinutes, 12.5);
  e.run(`Db.insert('Sessions', { sessionId:'SES-1', openToAll:true })`);
  assert.equal(e.run(`Db.get('Sessions','SES-1').openToAll`), true);
});

test('db: unique columns enforced on insert and update; primary key immutable', () => {
  const e = fresh();
  e.run(`Db.insert('Labs', { labId:'LAB-1', code:'IOT1', name:'IoT' })`);
  assert.throws(() => e.run(`Db.insert('Labs', { labId:'LAB-2', code:'IOT1', name:'Dup' })`), (x) => x.code === 'DUPLICATE');
  e.run(`Db.insert('Labs', { labId:'LAB-2', code:'GPU1', name:'GPU' })`);
  assert.throws(() => e.run(`Db.update('Labs','LAB-2',{ code:'IOT1' })`), (x) => x.code === 'DUPLICATE');
  e.run(`Db.update('Labs','LAB-2',{ labId:'HACK', name:'GPU2' })`);
  assert.equal(e.run(`Db.get('Labs','LAB-2').name`), 'GPU2');
  assert.equal(e.run(`Db.get('Labs','HACK')`), null);
  // empty unique values do not collide (several sessions without slotKey)
  e.run(`Db.insert('Sessions', { sessionId:'SES-A' })`); e.run(`Db.insert('Sessions', { sessionId:'SES-B' })`);
  assert.equal(e.run(`Db.count('Sessions')`), 2);
  assert.throws(() => e.run(`Db.update('Labs','LAB-2',{ nope: 1 })`), /Unknown column/);
});

test('db: insertMany is atomic with respect to uniqueness', () => {
  const e = fresh();
  e.run(`Db.insert('Courses', { courseId:'CRS-1', code:'CS101', name:'Intro' })`);
  assert.throws(() => e.run(`Db.insertMany('Courses', [{courseId:'CRS-2',code:'CS102'},{courseId:'CRS-3',code:'CS101'}])`), (x) => x.code === 'DUPLICATE');
  assert.equal(e.run(`Db.count('Courses')`), 1, 'nothing from the failed batch was written');
  assert.throws(() => e.run(`Db.insertMany('Courses', [{courseId:'CRS-2',code:'CS102'},{courseId:'CRS-3',code:'CS102'}])`), (x) => x.code === 'DUPLICATE');
  e.run(`Db.insertMany('Courses', [{courseId:'CRS-2',code:'CS102'},{courseId:'CRS-3',code:'CS103'}])`);
  assert.equal(e.run(`Db.count('Courses')`), 3);
});

test('db: grows past the initial grid (ensureCapacity) without losing rows', () => {
  const e = fresh();
  e.run(`for (var i=0;i<1300;i++) Db.insert('SystemLog',{ logId:'L'+i, at:i, level:'info', message:'m'+i })`);
  assert.equal(e.run(`Db.count('SystemLog')`), 1300);
  assert.equal(e.run(`Db.tail('SystemLog',2).map(function(r){return r.logId;}).join()`), 'L1298,L1299');
});

test('db: cachedGet is invalidated by writes (revocation must be immediate)', () => {
  const e = fresh();
  e.run(`Db.insert('DeviceCredentials', { credentialId:'CRD-1', studentId:'STU-1', status:'active' })`);
  assert.equal(e.run(`Db.cachedGet('DeviceCredentials','credentialId','CRD-1').status`), 'active');
  assert.equal(e.run(`Db.cachedGet('DeviceCredentials','credentialId','CRD-1').status`), 'active'); // now from cache
  e.run(`Db.update('DeviceCredentials','CRD-1',{ status:'revoked' })`);
  assert.equal(e.run(`Db.cachedGet('DeviceCredentials','credentialId','CRD-1').status`), 'revoked');
  // lookup by a secondary cache column is invalidated too
  assert.equal(e.run(`Db.cachedGet('DeviceCredentials','studentId','STU-1').status`), 'revoked');
  e.run(`Db.update('DeviceCredentials','CRD-1',{ status:'active' })`);
  assert.equal(e.run(`Db.cachedGet('DeviceCredentials','studentId','STU-1').status`), 'active');
});

test('locks: re-entrant, exclusive across executions, released after errors', () => {
  const e = fresh();
  assert.equal(e.run(`Locks.with(function(){ return Locks.with(function(){ return Locks.depth; }); })`), 2);
  assert.equal(e.state.lockHeld, false);
  assert.throws(() => e.run(`Locks.with(function(){ throw new Error('boom'); })`), /boom/);
  assert.equal(e.state.lockHeld, false, 'lock released after exception');
  assert.equal(e.run(`Locks.depth`), 0);
  e.state.lockHeld = true; // another execution holds it
  assert.throws(() => e.run(`Locks.with(function(){ return 1; }, 10)`), (x) => x.code === 'BUSY');
});

test('audit: hash chain verifies, and edits / deletions / reordering are detected', () => {
  const e = fresh();
  for (let i = 0; i < 6; i++) e.run(`Audit.log({ actor:'a@karunya.edu', role:'admin', action:'test.${i}', entityType:'X', entityId:'${i}', detail:{ n:${i} } })`);
  let v = e.run(`Audit.verify()`);
  assert.equal(v.ok, true); assert.equal(v.rows, 6); assert.equal(v.headSeq, 6);

  // 1. edit a field in the middle without fixing the hash
  const sheet = e.run(`Db.sheet('AuditEvents')`);
  const actionCol = 6; // seq,eventId,at,actor,role,action
  const orig = sheet.cells[2][actionCol - 1];
  sheet.cells[2][actionCol - 1] = 'tampered';
  v = e.run(`Audit.verify()`);
  assert.equal(v.ok, false);
  assert.ok(v.chainProblems.some((p) => /does not match its hash/.test(p.problem)), JSON.stringify(v.chainProblems));
  sheet.cells[2][actionCol - 1] = orig;
  assert.equal(e.run(`Audit.verify().ok`), true);

  // 2. delete a row (shift up) -> sequence gap + broken link
  const removed = sheet.cells.splice(3, 1);
  v = e.run(`Audit.verify()`);
  assert.equal(v.ok, false);
  assert.ok(v.chainProblems.some((p) => /sequence gap|link broken/.test(p.problem)));
  sheet.cells.splice(3, 0, removed[0]);
  assert.equal(e.run(`Audit.verify().ok`), true);
});

test('audit: owner who recomputes the WHOLE chain is caught by an earlier checkpoint copy', () => {
  const e = fresh();
  for (let i = 0; i < 4; i++) e.run(`Audit.log({ actor:'x', action:'a${i}' })`);
  e.run(`Audit.checkpoint('daily')`);
  const anchoredHash = e.run(`Audit.verify().headHash`);
  assert.equal(e.run(`Audit.verify().ok`), true);

  // Attacker rewrites row 2's action and recomputes every subsequent hash so the chain is internally consistent.
  const sheet = e.run(`Db.sheet('AuditEvents')`);
  sheet.cells[1][5] = 'rewritten-history'; // row index 1 == seq 1... (row 2 in sheet terms is seq 1)
  let prev = '0'.repeat(64);
  const crypto = require('node:crypto');
  for (let i = 1; i <= 4; i++) {
    const c = sheet.cells[i];
    const detail = c[9] === '' ? 'null' : c[9];
    c[10] = prev;
    const canon = [c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7], c[8], detail].join('␟');
    c[11] = crypto.createHash('sha256').update(prev + '|' + canon).digest('hex');
    prev = c[11];
  }
  const v = e.run(`Audit.verify()`);
  assert.equal(v.chainProblems.length, 0, 'the forged chain is internally consistent');
  assert.equal(v.ok, false, 'but it no longer matches the checkpoint');
  assert.ok(v.checkpointProblems.length > 0 || v.storedHeadProblem);
  assert.notEqual(v.headHash, anchoredHash, 'and its head differs from the emailed anchor');
});

test('audit: truncating the tail is detected via the stored head', () => {
  const e = fresh();
  for (let i = 0; i < 5; i++) e.run(`Audit.log({ actor:'x', action:'a${i}' })`);
  e.run(`Audit.checkpoint('daily')`);
  const sheet = e.run(`Db.sheet('AuditEvents')`);
  sheet.cells.length = 3; // drop seq 3..5
  const v = e.run(`Audit.verify()`);
  assert.equal(v.ok, false);
  assert.ok(v.checkpointProblems.some((p) => /no longer exists/.test(p.problem)) || /no longer exists/.test(v.storedHeadProblem || ''));
});

test('audit: periodic checkpoint is written every N events', () => {
  const e = fresh();
  e.run(`Db.insert('Config', { key:'auditCheckpointEvery', value:'5' })`);
  e.run(`Settings.reset()`);
  for (let i = 0; i < 12; i++) e.run(`Audit.log({ actor:'x', action:'a${i}' })`);
  assert.equal(e.run(`Db.count('AuditCheckpoints')`), 2);
  assert.match(e.props.AUDIT_HEAD, /^10:[0-9a-f]{64}$/);
});

test('settings: defaults apply, stored values are coerced and clamped', () => {
  const e = fresh();
  assert.equal(e.run(`Settings.get('qrTtlSeconds')`), 60);
  e.run(`Db.insert('Config', { key:'qrTtlSeconds', value:'9999' })`); e.run(`Settings.reset()`);
  assert.equal(e.run(`Settings.get('qrTtlSeconds')`), 180, 'clamped to max');
  e.run(`Db.insert('Config', { key:'requireExitScan', value:'false' })`); e.run(`Settings.reset()`);
  assert.equal(e.run(`Settings.get('requireExitScan')`), false);
});
