const test = require('node:test');
const assert = require('node:assert/strict');
const { world, LAB_B } = require('./fixtures');
function ready() {
  const w = world({ students: 1 });
  w.lab = w.ok(w.admin, 'labs.upsert', { ...w.lab, department: ' cse ' }).lab;
  w.lab2 = w.ok(w.admin, 'labs.upsert', { ...w.lab2, department: 'ECE' }).lab;
  w.shared = w.ok(w.admin, 'labs.upsert', { code: 'SHARED', name: 'Shared lab', type: 'computing', department: '', capacity: 10 }).lab;
  w.ok(w.admin, 'users.upsert', { email: w.hod, displayName: 'CSE HOD', roles: ['hod'], department: 'CSE' });
  w.ok(w.admin, 'users.upsert', { email: w.faculty2, displayName: 'ECE-SECRET Faculty', roles: ['faculty'], department: 'ECE' });
  w.ok(w.admin, 'students.import', { rows: [{ rollNo: 'ECE999', name: 'ECE-SECRET Student', email: 'outside@karunya.edu', department: 'ECE' }] });
  w.outside = w.ok('outside@karunya.edu', 'onboard', { rollNo: 'ECE999', name: 'ECE-SECRET Student', consent: true, mobile: '9876543222' }).student;
  const course = w.ok(w.admin, 'courses.upsert', { code: 'ECE999', name: 'ECE-SECRET Course', department: 'ECE' }).course;
  w.ok(w.admin, 'roster.import', { courseId: course.courseId, rows: ['ECE999'] }); w.secretCourse = course;
  w.sid = w.session().sessionId; w.ok(w.faculty, 'sessions.open', { sessionId: w.sid });
  assert.equal(w.checkin(w.students[0], { sessionId: w.sid }).ok, true);
  const event = w.ok(w.admin, 'events.create', { name: 'ECE-SECRET Event', labId: w.lab2.labId, date: w.today, startTime: '09:00', endTime: '12:00', openToAll: true, facultyId: w.faculty2Id, override: true }).event;
  w.secretSession = event.sessionId; w.ok(w.admin, 'sessions.open', { sessionId: event.sessionId });
  assert.equal(w.checkin({email:'outside@karunya.edu'}, { sessionId:event.sessionId,kiosk:'kiosk2@karunya.edu',geo:w.at(3,12,LAB_B) }).ok,true);
  const cat = w.ok(w.staff,'categories.upsert',{name:'Test workstation',trackingMode:'individual',workstation:true}).category;
  w.asset = w.ok(w.staff,'assets.upsert',{labId:w.lab.labId,categoryId:cat.categoryId,name:'CSE system',assetTag:'CSE-01'}).asset;
  w.secretAsset = w.ok(w.staff,'assets.upsert',{labId:w.lab2.labId,categoryId:cat.categoryId,name:'ECE-SECRET Asset',assetTag:'ECE-SECRET-ASSET'}).asset;
  w.secretLoan = w.ok(w.staff,'loans.issue',{idemKey:'hod-secret-loan-01',borrowerType:'student',borrowerId:w.outside.studentId,labId:w.lab2.labId,items:[{assetId:w.secretAsset.assetId}],days:1}).loan;
  w.secretProject = w.ok('outside@karunya.edu','projects.create',{title:'ECE-SECRET Project',description:'Secret report test',labId:w.lab2.labId,supervisorFacultyId:w.faculty2Id,startDate:w.today,endDate:'2026-12-01'}).project;
  w.eval(`Attend.rebuildSummary('${w.sid}')`); w.eval(`Attend.rebuildSummary('${w.secretSession}')`);
  return w;
}
const noSecret = (x) => assert.ok(!JSON.stringify(x).includes('ECE-SECRET'), JSON.stringify(x));
test('HOD department fields persist, normalize and survive partial account/lab edits', () => {
  const w = ready(); assert.equal(w.lab.department, 'CSE'); assert.equal(w.outside.department,'ECE','onboarding preserves the official imported department');
  const { department, ...lab } = w.lab; assert.equal(w.ok(w.admin,'labs.upsert',lab).lab.department,'CSE');
  assert.equal(w.ok(w.admin,'users.upsert',{email:w.hod,displayName:'Edited HOD',roles:['hod']}).user.department,'CSE');
  assert.equal(w.ok(w.hod,'me').department,'CSE');
  assert.ok(w.ok(w.admin,'users.upsert',{email:'five@karunya.edu',displayName:'Five roles',roles:['student','faculty','staff','admin','hod'],department:'ECE'}).user.roles.length === 5);
  assert.equal(w.ok(w.admin,'dash.admin').users.hod,2);
});
test('HOD scope includes own department and shared labs; missing department gives shared labs only', () => {
  const w=ready(); assert.deepEqual(new Set(w.ok(w.hod,'labs.list').labs.map(l=>l.labId)),new Set([w.lab.labId,w.shared.labId]));
  w.ok(w.admin,'users.upsert',{email:w.hod,displayName:'No department',roles:['hod'],department:''});
  assert.deepEqual(w.ok(w.hod,'labs.list').labs.map(l=>l.labId),[w.shared.labId]);
  assert.equal(w.ok(w.admin,'labs.list').labs.length,3);
});
test('HOD reads across legacy lists and aggregate dashboards never include other-department records', () => {
  const w=ready();
  for(const action of ['labs.list','labs.occupancy','labs.live','systems.status','assets.list','catalog.list','kits.list','groups.list','kiosks.list','courses.list','facultycourses.list','timetable.list','students.list','users.list','directory.faculty','booking.list','loans.list','equipment.list','events.list','flags.list','activity.feed','audit.list','dash.hod','dash.admin','dash.staff','projects.list']) noSecret(w.ok(w.hod,action,{}));
  const d=w.ok(w.hod,'dash.hod'); assert.equal(d.labCount,2);assert.equal(d.openSessions,1);assert.equal(d.queues.activeLoans,0);assert.equal(d.stock.individual,1);
});
test('HOD direct ids cannot bypass lab scope', () => {
  const w=ready();
  for(const [action,p] of [['sessions.get',{sessionId:w.secretSession}],['attend.roster',{sessionId:w.secretSession}],['attend.studentEvents',{sessionId:w.secretSession,studentId:w.outside.studentId}],['assets.history',{assetId:w.secretAsset.assetId}],['loans.get',{loanId:w.secretLoan.loanId}],['projects.get',{projectId:w.secretProject.projectId}],['booking.check',{labId:w.lab2.labId}]]) assert.equal(w.err(w.hod,action,p).code,'FORBIDDEN',action);
  noSecret(w.ok(w.hod,'sessions.get',{sessionId:w.sid})); noSecret(w.ok(w.hod,'attend.roster',{sessionId:w.sid}));
  noSecret(w.ok(w.hod,'roster.list',{courseId:w.course.courseId})); assert.equal(w.err(w.hod,'roster.list',{courseId:w.secretCourse.courseId}).code,'FORBIDDEN');
});
test('HOD reports and CSV/PDF exports are scoped before rows and totals are computed', () => {
  const w=ready(); w.advance(180000); assert.equal(w.checkin(w.students[0],{action:'out',sessionId:w.sid}).ok,true);w.eval(`Attend.rebuildSummary('${w.sid}')`);
  for(const type of ['digest','monthlyAudit','custom','daily','monthly','faculty','student','utilisation','assetUsage','inventory','overdue','projects','systemUsage','session']) {
    const p={type,from:w.today,to:w.today,date:w.today,month:'2026-10',studentId:w.students[0].studentId,facultyId:w.facultyId,assetId:w.asset.assetId,sessionId:w.sid};
    noSecret(w.ok(w.hod,'reports.run',p));
  }
  for(const type of ['audit','erp']) assert.equal(w.err(w.hod,'reports.run',{type}).code,'FORBIDDEN');
  assert.equal(w.err(w.hod,'reports.run',{type:'student',studentId:w.outside.studentId}).code,'FORBIDDEN');
  assert.equal(w.err(w.hod,'reports.run',{type:'inventory',labId:w.lab2.labId,reportLabIds:null}).code,'FORBIDDEN');
  const csv=w.ok(w.hod,'reports.csv',{type:'inventory'});noSecret(csv); assert.ok(csv.csv.includes('CSE system'));
  assert.ok(w.ok(w.hod,'reports.pdf',{type:'inventory'}).base64.length>0);
});
test('HOD-only account cannot mutate through any route, including generic user routes', () => {
  const w=ready(); const personal=new Set(['profile.update','notifications.read']);
  const read=new Set('me profile.update notifications.list notifications.read dash.hod dash.admin dash.staff activity.feed labs.list labs.occupancy labs.live systems.status sessions.day sessions.get attend.roster attend.studentEvents flags.list events.list events.mine events.guests classreps.list students.list courses.list timetable.list facultycourses.list roster.list assets.list assets.history loans.list loans.get booking.list booking.check equipment.list audit.list users.list kiosks.list reports.run reports.csv reports.pdf categories.list catalog.list kits.list groups.list directory.faculty projects.get projects.list'.split(' '));
  const routes=w.eval('Object.keys(ROUTES)');let checked=0;
  // The business-write inventory is independent of the router role lists; generic user/any routes are included.
  const writes=routes.filter(a=>!read.has(a));
  for(const action of writes){assert.equal(w.err(w.hod,action,{sessionId:w.sid,labId:w.lab.labId,studentId:w.students[0].studentId}).code,'FORBIDDEN',action);checked++;}
  assert.ok(checked>50);
  for(const action of ['onboard','scan.submit','sessions.open','sessions.close','attend.openRescan','events.register','events.addGuest']) assert.ok(writes.includes(action));
  w.ok(w.hod,'profile.update',{consent:true,mobile:'9876543222',roles:['admin'],department:'ECE'}); assert.equal(w.ok(w.hod,'me').department,'CSE');assert.deepEqual(w.ok(w.hod,'me').roles,['hod']);
  w.ok(w.hod,'notifications.read',{ids:[]});assert.equal(personal.size,2);
  for(const action of ['system.status','system.quota','settings.get','audit.verify','cred.pending','photo.get']) assert.equal(w.err(w.hod,action).code,'FORBIDDEN',action);
});
test('fresh department updates change the scope without using the public occupancy cache', () => {
  const w=ready(); w.ok(w.staff,'labs.occupancy');w.ok(w.hod,'labs.live');
  w.ok(w.admin,'users.upsert',{email:w.hod,displayName:'ECE HOD',roles:['hod'],department:' ece '});
  const labs=w.ok(w.hod,'labs.occupancy').labs;assert.ok(labs.some(l=>l.labId===w.lab2.labId));assert.ok(!labs.some(l=>l.labId===w.lab.labId));
  assert.equal(w.err(w.hod,'sessions.get',{sessionId:w.sid}).code,'FORBIDDEN');
});
test('combined HOD and coordinator/admin roles retain their explicitly granted operational permissions',()=>{
 const w=ready();w.ok(w.admin,'users.upsert',{email:w.hod,displayName:'Combined roles',roles:['hod','staff'],department:'CSE'});
 assert.equal(w.ok(w.hod,'labs.list').labs.length,3);
 assert.ok(w.ok(w.hod,'assets.upsert',{labId:w.lab.labId,categoryId:w.asset.categoryId,name:'Coordinator write',assetTag:'COMBINED'}).asset);
});
test('HOD event-lead assignment does not bypass department reads or write restrictions',()=>{
 const w=ready();w.e.run(`Db.update('Events',Db.get('Sessions','${w.secretSession}').labEventId,{coordinatorEmail:'${w.hod}'})`);
 assert.deepEqual(w.ok(w.hod,'events.mine').events,[]);assert.equal(w.ok(w.hod,'me').coordinating,0);
 assert.equal(w.err(w.hod,'events.guests',{labEventId:w.eval(`Db.get('Sessions','${w.secretSession}').labEventId`)}).code,'FORBIDDEN');
 assert.equal(w.err(w.hod,'sessions.close',{sessionId:w.secretSession}).code,'FORBIDDEN');
});
test('HOD pending-correction counts exclude reviewed and other-department requests',()=>{
 const w=ready();w.e.run(`
 var pending=U.id('event'),reviewed=U.id('event');
 [pending,reviewed].forEach(function(id){Db.insert('AttendanceEvents',{eventId:id,sessionId:'${w.sid}',studentId:'${w.students[0].studentId}',type:'CORR_IN',source:'manual',approvalStatus:'pending',at:U.now(),createdAt:U.now()});});
 Db.insert('AttendanceEvents',{eventId:U.id('event'),sessionId:'${w.sid}',studentId:'${w.students[0].studentId}',type:'DECISION',ref:reviewed,approvalStatus:'approved',at:U.now(),createdAt:U.now()});
 Db.insert('AttendanceEvents',{eventId:U.id('event'),sessionId:'${w.secretSession}',studentId:'${w.outside.studentId}',type:'CORR_IN',source:'manual',approvalStatus:'pending',at:U.now(),createdAt:U.now()});
 `);assert.equal(w.ok(w.hod,'dash.hod').queues.pendingCorrections,1);
});
