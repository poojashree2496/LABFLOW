const test = require('node:test');
const assert = require('node:assert/strict');
const { world } = require('./fixtures');
async function ready() {
  const w = world({ students: 1 }), [s] = w.students;
  const old = await w.registerDevice(s), next = await w.registerDevice(s);
  const body = { credentialId: next.credentialId, idChecked: true };
  return { w, s, old, next, body, rows: () => w.ok(w.admin, 'cred.list', { studentId: s.studentId }).credentials };
}

for (const stage of ['before old write', 'after old write', 'before new write']) test('approval restores the old phone after ' + stage + ' fails', async () => {
  const { w, old, next, body, rows } = await ready();
  const id = stage.includes('old') ? old.credentialId : next.credentialId;
  w.e.run(`var retryUpdate = Db.update; Db.update = function(table,id,patch) {
    if(table==='DeviceCredentials' && id===${JSON.stringify(id)}) {
      Db.update=retryUpdate; ${stage === 'after old write' ? 'retryUpdate.apply(null,arguments);' : ''} throw new Error('injected approval write failure');
    } return retryUpdate.apply(null,arguments); };`);
  assert.equal(w.call(w.staff, 'cred.approve', body).ok, false);
  assert.equal(rows().find((c) => c.credentialId === old.credentialId).status, 'active');
  assert.equal(rows().find((c) => c.credentialId === next.credentialId).status, 'pending_approval');
  assert.equal(w.ok(w.staff, 'cred.approve', body).credential.status, 'active');
  assert.equal(rows().filter((c) => c.status === 'active').length, 1);
});

test('an activation saved before its write error is confirmed without reviving the old phone', async () => {
  const { w, old, next, body, rows } = await ready();
  w.e.run(`var retryUpdate = Db.update; Db.update = function(table,id,patch) {
    var result=retryUpdate.apply(null,arguments);
    if(table==='DeviceCredentials' && id===${JSON.stringify(next.credentialId)} && patch.status==='active') { Db.update=retryUpdate; throw new Error('activation saved but response failed'); }
    return result; };`);
  assert.equal(w.ok(w.staff, 'cred.approve', body).credential.status, 'active');
  assert.equal(rows().find((c) => c.credentialId === old.credentialId).status, 'replaced');
  assert.equal(rows().filter((c) => c.status === 'active').length, 1);
});

test('lost approval responses are retryable without changing timestamps or duplicating notifications', async () => {
  const { w, body } = await ready();
  const first = w.ok(w.staff, 'cred.approve', body);
  w.advance(5000);
  const retry = w.ok(w.staff, 'cred.approve', body);
  assert.equal(retry.replayed, true);
  assert.equal(retry.credential.approvedAt, first.credential.approvedAt);
  assert.equal(w.eval("Db.readAll('Notifications').filter(function(n){return n.dedupeKey.indexOf('credok:')===0;}).length"), 1);
});

test('audit failure after activation can be retried, but revoked phones are never reactivated', async () => {
  const { w, next, body } = await ready();
  w.e.run("var retryAudit=Audit.log; Audit.log=function(entry){if(entry.action==='cred.approve'){Audit.log=retryAudit;throw new Error('approval audit interrupted');}return retryAudit(entry);};");
  assert.equal(w.call(w.staff, 'cred.approve', body).ok, false);
  assert.equal(w.ok(w.staff, 'cred.approve', body).replayed, true);
  assert.ok(w.eval("Db.readAll('AuditEvents').some(function(a){return a.action==='cred.approve';})"));
  w.ok(w.staff, 'cred.revoke', { credentialId: next.credentialId, reason: 'Lost new phone' });
  assert.equal(w.err(w.staff, 'cred.approve', body).code, 'INVALID_STATE');
});

test('if rollback also fails, retry finishes the pending approval with exactly one active phone', async () => {
  const { w, old, next, body, rows } = await ready();
  w.e.run(`var retryUpdate = Db.update; Db.update = function(table,id,patch) {
    if(table==='DeviceCredentials' && ((id===${JSON.stringify(next.credentialId)} && patch.status==='active') || (id===${JSON.stringify(old.credentialId)} && patch.status==='active'))) throw new Error('writes temporarily unavailable');
    return retryUpdate.apply(null,arguments); };`);
  assert.equal(w.call(w.staff, 'cred.approve', body).ok, false);
  w.e.run('Db.update=retryUpdate;');
  assert.equal(w.ok(w.staff, 'cred.approve', body).credential.status, 'active');
  assert.equal(rows().filter((c) => c.status === 'active').length, 1);
});

test('a replay rechecks authorization and cannot approve a first self-service phone', async () => {
  const { w, s, old, body } = await ready();
  assert.equal(w.err(w.staff, 'cred.approve', { credentialId: old.credentialId, idChecked: true }).code, 'INVALID_STATE');
  w.ok(w.staff, 'cred.approve', body);
  w.ok(w.staff, 'students.status', { studentId: s.studentId, status: 'disabled', reason: 'Disabled after approval' });
  assert.equal(w.err(w.staff, 'cred.approve', body).code, 'ACCOUNT_DISABLED');
});

test('notification failure does not fail an already completed phone replacement', async () => {
  const { w, body, rows } = await ready();
  w.e.run("Notify.toUser=function(){throw new Error('temporary notification failure');};");
  assert.equal(w.ok(w.staff, 'cred.approve', body).credential.status, 'active');
  assert.equal(rows().filter((c) => c.status === 'active').length, 1);
  assert.ok(w.eval("Db.readAll('SystemLog').some(function(l){return l.code==='APPROVAL_NOTIFY_FAILED';})"));
});
