const test = require('node:test');
const assert = require('node:assert/strict');
const { world } = require('./fixtures');

const input = (w, extra = {}) => ({ title: 'Drone navigation', description: 'Evaluate indoor navigation accuracy.', labId: w.lab.labId,
  supervisorFacultyId: w.facultyId, startDate: '2026-10-14', endDate: '2026-11-20', ...extra });
const create = (w, extra) => w.ok(w.students[0].email, 'projects.create', input(w, extra)).project;
const usable = (w, s, p) => w.eval(`Projects.usableBy(${JSON.stringify(s.studentId)}, ${JSON.stringify(p.projectId)})`);
const rows = (w, table) => w.eval(`Db.readAll(${JSON.stringify(table)})`);
const group = (w) => w.ok(w.staff, 'groups.create', { name: 'Navigation team', labId: w.lab.labId,
  studentIds: w.students.slice(0, 2).map((s) => s.studentId), leaderId: w.students[0].studentId }).group;
const approve = (w, p, email = w.faculty) => w.ok(email, 'projects.decide', { projectId: p.projectId, approve: true }).project;
const submit = (w, p, extra = {}) => w.ok(w.students[0].email, 'projects.outcome', { projectId: p.projectId, outcome: 'Navigation error below 10 cm.', outcomeLink: 'https://example.org/results', ...extra }).project;

test('projects: full lifecycle, pending eligibility, notifications and audited acceptance', () => {
  const w = world(), [s] = w.students;
  let p = create(w, { ownerStudentId: w.students[1].studentId, status: 'completed', approvedBy: w.admin });
  assert.equal(p.ownerStudentId, s.studentId); assert.equal(p.status, 'pending'); assert.equal(p.approvedBy, '');
  assert.equal(p.ownerName, 'Student 1'); assert.equal(p.supervisorName, 'Dr Faculty');
  assert.equal(usable(w, s, p), true);
  assert.equal(w.ok(s.email, 'projects.mine').projects.length, 1);
  assert.equal(w.ok(w.faculty, 'projects.list', { status: 'pending' }).projects.length, 1);
  p = approve(w, p); assert.equal(p.status, 'active');
  p = submit(w, p); assert.equal(p.status, 'active'); assert.ok(p.outcomeAt);
  p = w.ok(w.faculty, 'projects.outcome', { projectId: p.projectId, accept: true, outcomeAt: p.outcomeAt }).project;
  assert.equal(p.status, 'completed'); assert.equal(usable(w, s, p), false);
  assert.deepEqual(rows(w, 'AuditEvents').filter((a) => a.entityId === p.projectId).map((a) => a.action),
    ['project.create', 'project.decide', 'project.outcome.submit', 'project.outcome.accept']);
  assert.equal(rows(w, 'Notifications').filter((n) => n.type === 'project').length, 4);
  assert.equal(w.ok(w.admin, 'audit.verify').ok, true);
});

test('projects: students and unrelated supervisors cannot read or decide another project', () => {
  const w = world(), p = create(w);
  for (const email of [w.students[1].email, w.faculty2]) {
    assert.equal(w.err(email, 'projects.get', { projectId: p.projectId }).code, 'FORBIDDEN');
    assert.equal(w.err(email, 'projects.decide', { projectId: p.projectId, approve: true }).code, 'FORBIDDEN');
  }
  assert.equal(w.ok(w.students[1].email, 'projects.mine').projects.length, 0);
  assert.equal(w.ok(w.faculty2, 'projects.list').projects.length, 0);
  for (const email of [w.faculty, w.staff, w.admin]) assert.equal(w.ok(email, 'projects.get', { projectId: p.projectId }).project.projectId, p.projectId);
});

test('projects: coordinator approves, rejects and notifies without changing a final decision', () => {
  const w = world(), p = create(w);
  assert.equal(approve(w, p, w.staff).status, 'active');
  assert.equal(w.err(w.staff, 'projects.decide', { projectId: p.projectId, approve: false }).code, 'INVALID_STATE');
  const q = create(w, { title: 'Second project' });
  assert.equal(w.ok(w.staff, 'projects.decide', { projectId: q.projectId, approve: false, note: 'Revise the scope.' }).project.status, 'rejected');
  assert.equal(usable(w, w.students[0], q), false);
  assert.ok(rows(w, 'Notifications').some((n) => n.body.includes('Revise the scope.')));
  assert.equal(rows(w, 'AuditEvents').find((a) => a.action === 'project.decide').role, 'staff');
});

test('projects: only group leader creates, members share access and outsiders cannot join by payload', () => {
  const w = world(), g = group(w), [leader, member, outsider] = w.students;
  assert.equal(w.err(member.email, 'projects.create', input(w, { groupId: g.groupId })).code, 'FORBIDDEN');
  assert.equal(w.err(outsider.email, 'projects.create', input(w, { groupId: g.groupId })).code, 'FORBIDDEN');
  const p = create(w, { groupId: g.groupId });
  assert.equal(w.ok(member.email, 'projects.mine').projects[0].groupName, g.name);
  assert.equal(w.ok(member.email, 'projects.get', { projectId: p.projectId }).project.projectId, p.projectId);
  assert.equal(usable(w, leader, p), true); assert.equal(usable(w, member, p), true); assert.equal(usable(w, outsider, p), false);
  approve(w, p);
  assert.equal(w.err(member.email, 'projects.outcome', { projectId: p.projectId, outcome: 'Hijacked' }).code, 'FORBIDDEN');
  w.e.run(`Db.update('Groups', ${JSON.stringify(g.groupId)}, {status:'disbanded'})`);
  assert.equal(usable(w, leader, p), false); assert.equal(usable(w, member, p), false);
  assert.equal(w.ok(member.email, 'projects.mine').projects.length, 0);
});

test('projects: invalid timeline, lab, supervisor and group lab leave no records', () => {
  const w = world(), g = group(w);
  for (const extra of [{ endDate: '2026-01-01' }, { startDate: '2026-02-30' }, { title: ' ' }, { description: 'x'.repeat(2001) },
    { supervisorFacultyId: w.students[0].studentId }, { groupId: g.groupId, labId: w.lab2.labId }]) {
    assert.equal(w.err(w.students[0].email, 'projects.create', input(w, extra)).code, 'BAD_INPUT');
  }
  w.e.run(`Db.update('Labs', ${JSON.stringify(w.lab.labId)}, {status:'inactive'})`);
  assert.equal(w.err(w.students[0].email, 'projects.create', input(w)).code, 'BAD_INPUT');
  assert.equal(rows(w, 'Projects').length, 0);
});

test('projects: disabled or demoted supervisor is not selectable even with an active faculty profile', () => {
  const w = world();
  const user = rows(w, 'Users').find((u) => u.email === w.faculty);
  w.e.run(`Db.update('Users', ${JSON.stringify(user.userId)}, {roles:'staff'})`);
  assert.equal(w.err(w.students[0].email, 'projects.create', input(w)).code, 'BAD_INPUT');
  w.e.run(`Db.update('Users', ${JSON.stringify(user.userId)}, {roles:'faculty',status:'disabled'})`);
  assert.equal(w.err(w.students[0].email, 'projects.create', input(w)).code, 'BAD_INPUT');
  assert.equal(rows(w, 'Projects').length, 0);
});

test('projects: creation retries use the same id and cannot overwrite or claim existing projects', () => {
  const w = world(), projectId = 'PRJ-ABCDEF123456', p = create(w, { projectId });
  assert.equal(create(w, { projectId }).projectId, p.projectId);
  assert.equal(w.err(w.students[0].email, 'projects.create', input(w, { projectId, title: 'Changed' })).code, 'CONFLICT');
  assert.equal(w.err(w.students[1].email, 'projects.create', input(w, { projectId })).code, 'FORBIDDEN');
  assert.equal(rows(w, 'Projects').length, 1);
  assert.equal(rows(w, 'AuditEvents').filter((a) => a.action === 'project.create').length, 1);
  assert.equal(rows(w, 'Notifications').filter((n) => n.type === 'project').length, 1);
});

test('projects: outcome can only be submitted on an active project by its owner', () => {
  const w = world(), p = create(w);
  assert.equal(w.err(w.students[0].email, 'projects.outcome', { projectId: p.projectId, outcome: 'Done' }).code, 'INVALID_STATE');
  approve(w, p);
  for (const email of [w.students[1].email, w.faculty2, w.faculty, w.staff, w.hod]) {
    assert.equal(w.err(email, 'projects.outcome', { projectId: p.projectId, outcome: 'Done' }).code, 'FORBIDDEN');
  }
  assert.equal(w.err(w.students[0].email, 'projects.outcome', { projectId: p.projectId, accept: true, outcomeAt: 1 }).code, 'FORBIDDEN');
  assert.equal(rows(w, 'Projects')[0].outcome, '');
});

test('projects: unsafe outcome links and malformed decisions are rejected', () => {
  const w = world(), p = create(w);
  for (const approve of [undefined, 'yes', 1]) assert.equal(w.err(w.faculty, 'projects.decide', { projectId: p.projectId, approve }).code, 'BAD_INPUT');
  approve(w, p);
  for (const link of ['javascript:alert(1)', 'data:text/html,hi', '//example.org', 'https://user:password@example.org', 'https://example.org/\nforged']) {
    assert.equal(w.err(w.students[0].email, 'projects.outcome', { projectId: p.projectId, outcome: 'Done', outcomeLink: link }).code, 'BAD_INPUT');
  }
  assert.equal(w.err(w.students[0].email, 'projects.outcome', { projectId: p.projectId, outcome: 'x'.repeat(4001) }).code, 'BAD_INPUT');
});

test('projects: stale outcome acceptance fails; retries neither complete twice nor notify twice', () => {
  const w = world(), p = approve(w, create(w)), first = submit(w, p);
  const again = submit(w, p); assert.equal(first.outcomeAt, again.outcomeAt);
  const revised = submit(w, p, { outcome: 'Revised results' }); assert.ok(revised.outcomeAt > first.outcomeAt);
  assert.equal(w.err(w.faculty, 'projects.outcome', { projectId: p.projectId, accept: true, outcomeAt: first.outcomeAt }).code, 'CONFLICT');
  assert.equal(w.err(w.faculty2, 'projects.outcome', { projectId: p.projectId, accept: true, outcomeAt: revised.outcomeAt }).code, 'FORBIDDEN');
  const payload = { projectId: p.projectId, accept: true, outcomeAt: revised.outcomeAt };
  w.ok(w.faculty, 'projects.outcome', payload); w.ok(w.faculty, 'projects.outcome', payload);
  assert.equal(rows(w, 'AuditEvents').filter((a) => a.action === 'project.outcome.accept').length, 1);
  assert.equal(rows(w, 'AuditEvents').filter((a) => a.action === 'project.outcome.submit').length, 2);
  assert.equal(w.err(w.students[0].email, 'projects.outcome', { projectId: p.projectId, outcome: 'Replace accepted work' }).code, 'INVALID_STATE');
});

test('projects: HOD reads require the shared department scope and never allow writes', () => {
  const w = world(), p = create(w), q = create(w, { labId: w.lab2.labId });
  assert.equal(w.ok(w.hod, 'projects.list').projects.length, 2, 'unassigned labs are shared');
  w.e.run(`Auth.labScope = function(ctx) { return [${JSON.stringify(w.lab.labId)}]; }`);
  assert.deepEqual(w.ok(w.hod, 'projects.list').projects.map((p) => p.projectId), [p.projectId]);
  assert.equal(w.ok(w.hod, 'projects.get', { projectId: p.projectId }).project.projectId, p.projectId);
  assert.equal(w.err(w.hod, 'projects.get', { projectId: q.projectId }).code, 'FORBIDDEN');
  for (const action of ['projects.create', 'projects.decide', 'projects.outcome']) assert.equal(w.err(w.hod, action, input(w)).code, 'FORBIDDEN');
});

test('projects: filters apply after access checks and return no personal contact fields', () => {
  const w = world(), p = create(w), q = create(w, { labId: w.lab2.labId, supervisorFacultyId: w.faculty2Id });
  approve(w, p);
  assert.deepEqual(w.ok(w.staff, 'projects.list', { status: 'pending' }).projects.map((x) => x.projectId), [q.projectId]);
  assert.equal(w.ok(w.faculty, 'projects.list', { labId: w.lab2.labId }).projects.length, 0);
  assert.equal(w.ok(w.students[0].email, 'projects.mine', { labId: w.lab.labId }).projects.length, 1);
  assert.equal(JSON.stringify(w.ok(w.staff, 'projects.list')).includes('98765'), false);
  assert.equal(w.err(w.staff, 'projects.list', { status: 'unknown' }).code, 'BAD_INPUT');
});

test('projects: disabled student is refused and loses check-in eligibility', () => {
  const w = world(), p = create(w), s = w.students[0];
  w.e.run(`Db.update('StudentProfiles', ${JSON.stringify(s.studentId)}, {status:'disabled'})`);
  assert.equal(usable(w, s, p), false);
  assert.equal(w.err(s.email, 'projects.create', input(w)).code, 'FORBIDDEN');
  assert.equal(w.err(s.email, 'projects.mine').code, 'FORBIDDEN');
});

test('projects: student authorization is refreshed after lock acquisition', () => {
  const w = world(), s = w.students[0];
  w.e.run(`var projectOriginalLock = Locks.with, projectHookRan = false;
    Locks.with = function(fn) { return projectOriginalLock(function() {
      if (!projectHookRan) { projectHookRan = true; Db.update('StudentProfiles', ${JSON.stringify(s.studentId)}, {status:'disabled'}); }
      return fn();
    }); };`);
  assert.equal(w.err(s.email, 'projects.create', input(w)).code, 'FORBIDDEN');
  assert.equal(rows(w, 'Projects').length, 0);
});
