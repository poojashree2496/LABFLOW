// The v2 contracts in docs/requirements.md section 4. Workstreams code against these names; change them only with
// that document (and this test) in the same pull request.
const test = require('node:test');
const assert = require('node:assert/strict');
const { world } = require('./fixtures');

test('v2 contract: schema columns are appended in the agreed order', () => {
  const w = world({ students: 0 });
  const cols = (t) => w.eval("Cfg.SCHEMA['" + t + "'].map(function(c){ return c.name; })");
  const tail = { Labs: ['department', 'openLab'], Users: ['department'], StudentProfiles: ['joinYear'], Categories: ['workstation'], Sessions: ['archivedAt'],
    AttendanceEvents: ['projectId', 'assetId'], Reservations: ['projectId', 'waitlistedAt'] };
  for (const t of Object.keys(tail)) assert.deepEqual(cols(t).slice(-tail[t].length), tail[t], t);
  assert.deepEqual(cols('Projects'), ['projectId', 'title', 'description', 'ownerStudentId', 'groupId', 'supervisorFacultyId', 'labId', 'startDate', 'endDate', 'status',
    'outcome', 'outcomeLink', 'outcomeAt', 'approvedBy', 'approvedAt', 'createdAt', 'updatedAt']);
  assert.equal(w.eval("Cfg.ID_PREFIX.project"), 'PRJ');
  // the live sheets were created with the new columns
  assert.deepEqual(w.eval("SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty(Cfg.PROP.DB_ID)).getSheetByName('Projects').getRange(1, 1, 1, 3).getValues()[0]"), ['projectId', 'title', 'description']);
});

test('v2 contract: enum values and roles', () => {
  const w = world({ students: 0 });
  assert.ok(w.eval("Cfg.ROLES").includes('hod'));
  assert.ok(w.eval("Cfg.SESSION_TYPES").includes('openlab'));
  assert.ok(w.eval("Cfg.ENTRY_REASONS").includes('openlab'));
  assert.deepEqual(w.ok(w.hod, 'me').roles, ['hod']);
  assert.equal(w.eval("Auth.canView(Auth._contextForEmail('hod@karunya.edu'))"), true);
  assert.equal(w.eval("Auth.canView(Auth._contextForEmail('faculty@karunya.edu'))"), false);
});

test('v2 contract: new routes exist with their agreed roles', () => {
  const w = world({ students: 0 });
  const want = {
    'projects.create': ['student'], 'projects.mine': ['student'], 'projects.get': ['student', 'faculty', 'staff', 'admin', 'hod'],
    'projects.list': ['faculty', 'staff', 'admin', 'hod'], 'projects.decide': ['faculty', 'staff', 'admin'], 'projects.outcome': ['student', 'faculty'],
    'attend.setWork': ['student'], 'labs.live': ['faculty', 'staff', 'admin', 'hod'], 'systems.status': ['user'],
    'users.revealMobile': ['staff', 'admin'], 'students.status': ['staff', 'admin'], 'dash.hod': ['hod', 'admin'],
    'system.backup': ['admin'], 'system.backups': ['admin'], 'system.archive': ['admin']
  };
  const got = w.eval("(function(){ var o = {}; Object.keys(ROUTES).forEach(function(k){ o[k] = ROUTES[k].roles; }); return o; })()");
  for (const k of Object.keys(want)) assert.deepEqual(got[k], want[k], k);
  for (const t of ['systemUsage', 'projects']) assert.ok(w.eval("Reports.TYPES").includes(t), t);
});
