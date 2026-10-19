/**
 * ProjectService.gs - student projects with a supervisor, a timeline and an outcome (task C1).
 *
 * A student or group leader creates a project and names a faculty supervisor, who approves it. A pending project can
 * be picked at check-in straight away. Statuses: pending -> active | rejected ; active -> completed | archived.
 * Contract: docs/requirements.md section 4.
 */
var Projects = {
  _student: function (ctx) {
    if (!ctx.student || ctx.student.status !== 'verified') fail('FORBIDDEN', 'A verified student profile is required.');
    return ctx.student.studentId;
  },
  _member: function (studentId, project) {
    if (project.ownerStudentId === studentId) return true;
    var group = project.groupId && Db.get('Groups', project.groupId);
    return !!(group && group.status === 'active' && Db.whereEq('GroupMembers', { groupId: group.groupId, studentId: studentId }).length);
  },
  _leader: function (studentId, groupId) {
    return Db.whereEq('GroupMembers', { groupId: groupId, studentId: studentId }).some(function (m) { return m.isLeader; });
  },
  _reviewer: function (ctx, project) {
    return ctx.has('admin') || ctx.has('staff') || !!(ctx.has('faculty') && ctx.faculty && ctx.faculty.status === 'active' && ctx.faculty.facultyId === project.supervisorFacultyId);
  },
  _readScope: function (ctx) {
    if (ctx.has('admin') || ctx.has('staff')) return function () { return true; };
    // B3 supplies department scope. Until then the HOD path fails closed via the shared helper's explicit stub.
    var labs = ctx.has('hod') ? Auth.labScope(ctx) : [];
    return function (project) {
      return !!((ctx.student && Projects._member(ctx.student.studentId, project)) ||
        (ctx.has('faculty') && ctx.faculty && ctx.faculty.facultyId === project.supervisorFacultyId) || labs.indexOf(project.labId) >= 0);
    };
  },
  _view: function (project) {
    var owner = Db.get('StudentProfiles', project.ownerStudentId), supervisor = Db.get('FacultyProfiles', project.supervisorFacultyId);
    var lab = Db.get('Labs', project.labId), group = project.groupId && Db.get('Groups', project.groupId);
    return Object.assign({}, project, { ownerName: owner ? owner.name : '', ownerRollNo: owner ? owner.rollNo : '',
      supervisorName: supervisor ? supervisor.name : '', labName: lab ? lab.name : '', groupName: group ? group.name : '' });
  },
  _audit: function (ctx, action, project, detail) {
    Audit.log({ actor: ctx.email, role: ctx.has('admin') ? 'admin' : ctx.has('staff') ? 'staff' : ctx.has('faculty') ? 'faculty' : 'student',
      action: 'project.' + action, entityType: 'Project', entityId: project.projectId, detail: detail });
  },
  create: function (ctx, p) {
    V.obj(p);
    var rec = { title: V.str(p.title, 'Title', { max: 120 }), description: V.str(p.description, 'Description', { max: 2000 }),
      labId: V.id(p.labId, 'Lab', 'lab'), supervisorFacultyId: V.id(p.supervisorFacultyId, 'Supervisor', 'faculty'),
      groupId: p.groupId ? V.id(p.groupId, 'Group', 'group') : '', startDate: V.date(p.startDate, 'Start date'), endDate: V.date(p.endDate, 'End date') };
    if (rec.endDate < rec.startDate) fail('BAD_INPUT', 'End date must be on or after the start date.');
    // Optional client-generated PRJ id makes a lost creation response safe to retry without new schema columns.
    var projectId = p.projectId ? V.id(p.projectId, 'Project', 'project') : U.id('project');
    return Locks.with(function () {
      ctx = Auth._contextForEmail(ctx.email, true); Auth.requireRole(ctx, ['student']);
      var sid = Projects._student(ctx), existing = Db.get('Projects', projectId);
      if (existing) {
        if (existing.ownerStudentId !== sid) fail('FORBIDDEN', 'This project belongs to another student.');
        if (!Object.keys(rec).every(function (k) { return existing[k] === rec[k]; })) fail('CONFLICT', 'This project request was already saved with different details.');
        return { project: Projects._view(existing) };
      }
      if (Db.mustGet('Labs', rec.labId, 'Lab').status !== 'active') fail('BAD_INPUT', 'Choose an active lab.');
      var supervisor = Db.mustGet('FacultyProfiles', rec.supervisorFacultyId, 'Supervisor');
      var user = supervisor.userId && Db.get('Users', supervisor.userId);
      if (supervisor.status !== 'active' || !user || user.status !== 'active' || String(user.roles).split(',').indexOf('faculty') < 0) fail('BAD_INPUT', 'Choose an active faculty supervisor.');
      if (rec.groupId) {
        var group = Db.mustGet('Groups', rec.groupId, 'Group');
        if (group.status !== 'active' || !Projects._leader(sid, rec.groupId)) fail('FORBIDDEN', 'Only an active group leader can create its project.');
        if (group.labId && group.labId !== rec.labId) fail('BAD_INPUT', 'Choose the group\'s lab.');
      }
      var now = U.now(), project = Db.insert('Projects', Object.assign({}, rec, { projectId: projectId, ownerStudentId: sid, status: 'pending', createdAt: now, updatedAt: now }));
      Projects._audit(ctx, 'create', project, { title: project.title, groupId: project.groupId, supervisorFacultyId: project.supervisorFacultyId });
      Notify.toUser(supervisor.userId, 'project', 'Project awaiting approval', project.title, 'project:create:' + projectId);
      return { project: Projects._view(project) };
    });
  },
  _list: function (p, visible) {
    p = p || {}; V.obj(p);
    var status = V.enumOf(p.status, 'Status', ['pending', 'active', 'completed', 'rejected', 'archived'], { optional: true });
    var labId = p.labId ? V.id(p.labId, 'Lab', 'lab') : '';
    var rows = Db.where('Projects', function (r) { return visible(r) && (!status || r.status === status) && (!labId || r.labId === labId); });
    rows.sort(function (a, b) { return b.createdAt - a.createdAt || a.projectId.localeCompare(b.projectId); });
    return { projects: rows.slice(0, 200).map(Projects._view), truncated: rows.length > 200 };
  },
  mine: function (ctx, p) {
    var sid = Projects._student(ctx);
    return Projects._list(p, function (r) { return Projects._member(sid, r); });
  },
  get: function (ctx, p) {
    V.obj(p);
    var project = Db.mustGet('Projects', V.id(p.projectId, 'Project', 'project'), 'Project');
    if (!Projects._readScope(ctx)(project)) fail('FORBIDDEN', 'You do not have access to this project.');
    return { project: Projects._view(project) };
  },
  list: function (ctx, p) { return Projects._list(p, Projects._readScope(ctx)); },
  decide: function (ctx, p) {
    V.obj(p);
    var id = V.id(p.projectId, 'Project', 'project');
    if (p.approve !== true && p.approve !== false) fail('BAD_INPUT', 'Choose approve or reject.');
    var note = V.str(p.note, 'Note', { optional: true, max: 300 });
    return Locks.with(function () {
      ctx = Auth._contextForEmail(ctx.email, true); Auth.requireRole(ctx, ['faculty', 'staff', 'admin']);
      var project = Db.mustGet('Projects', id, 'Project');
      if (!Projects._reviewer(ctx, project)) fail('FORBIDDEN', 'Only this project\'s supervisor or a coordinator can decide.');
      var status = p.approve ? 'active' : 'rejected';
      if (project.status === status) return { project: Projects._view(project) };
      if (project.status !== 'pending') fail('INVALID_STATE', 'This project has already been decided.');
      project = Db.update('Projects', id, { status: status, approvedBy: ctx.email, approvedAt: U.now(), updatedAt: U.now() });
      Projects._audit(ctx, 'decide', project, { status: status, note: note });
      Notify.toStudent(project.ownerStudentId, 'project', p.approve ? 'Project approved' : 'Project rejected', project.title + (note ? ': ' + note : ''), 'project:decide:' + id);
      return { project: Projects._view(project) };
    });
  },
  outcome: function (ctx, p) {
    V.obj(p);
    var id = V.id(p.projectId, 'Project', 'project'), accept = p.accept === true;
    if (p.accept !== undefined && typeof p.accept !== 'boolean') fail('BAD_INPUT', 'Accept must be true or false.');
    var text = accept ? '' : V.str(p.outcome, 'Outcome', { max: 4000 });
    var link = accept ? '' : V.str(p.outcomeLink, 'Outcome link', { optional: true, max: 1000, re: /^https?:\/\/[^\s/?#@]+(?:[/?#][^\s]*)?$/i, reMsg: 'Use an http:// or https:// link without credentials.' });
    var expected = accept ? V.int(p.outcomeAt, 'Outcome version', 1, Number.MAX_SAFE_INTEGER) : null;
    return Locks.with(function () {
      ctx = Auth._contextForEmail(ctx.email, true); Auth.requireRole(ctx, ['student', 'faculty']);
      var project = Db.mustGet('Projects', id, 'Project');
      if (accept) {
        if (!ctx.has('faculty') || !ctx.faculty || ctx.faculty.status !== 'active' || ctx.faculty.facultyId !== project.supervisorFacultyId) fail('FORBIDDEN', 'Only the named supervisor can accept this outcome.');
        if (!project.outcome || project.outcomeAt !== expected) fail('CONFLICT', 'The outcome changed. Reload and review it before accepting.');
        if (project.status === 'completed') return { project: Projects._view(project) };
        if (project.status !== 'active') fail('INVALID_STATE', 'Only an active project can be completed.');
        project = Db.update('Projects', id, { status: 'completed', updatedAt: U.now() });
        Projects._audit(ctx, 'outcome.accept', project, { outcomeAt: expected });
        Notify.toStudent(project.ownerStudentId, 'project', 'Project outcome accepted', project.title, 'project:complete:' + id);
      } else {
        var sid = Projects._student(ctx);
        if (project.ownerStudentId !== sid && !(project.groupId && Projects._member(sid, project) && Projects._leader(sid, project.groupId))) fail('FORBIDDEN', 'Only the project owner or group leader can submit its outcome.');
        if (project.status !== 'active') fail('INVALID_STATE', 'An outcome can be submitted after project approval and before completion.');
        if (project.outcome === text && project.outcomeLink === link) return { project: Projects._view(project) };
        project = Db.update('Projects', id, { outcome: text, outcomeLink: link, outcomeAt: Math.max(U.now(), (project.outcomeAt || 0) + 1), updatedAt: U.now() });
        Projects._audit(ctx, 'outcome.submit', project, { outcomeAt: project.outcomeAt });
        var supervisor = Db.get('FacultyProfiles', project.supervisorFacultyId);
        if (supervisor) Notify.toUser(supervisor.userId, 'project', 'Project outcome ready for review', project.title, 'project:outcome:' + id + ':' + project.outcomeAt);
      }
      return { project: Projects._view(project) };
    });
  },
  /** True when the student owns the project (or is in its group) and it is pending or active. */
  usableBy: function (studentId, projectId) {
    var student = Db.get('StudentProfiles', studentId), project = Db.get('Projects', projectId);
    if (!student || student.status !== 'verified' || !project || ['pending', 'active'].indexOf(project.status) < 0) return false;
    if (project.groupId) { var group = Db.get('Groups', project.groupId); if (!group || group.status !== 'active') return false; }
    return Projects._member(studentId, project);
  }
};
