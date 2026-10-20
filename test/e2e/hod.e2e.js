#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright-core');
const { start } = require('../../dev/server');
(async()=>{
 const dev=await start(0,{preset:'small'}),w=dev.lab.w,demo=dev.lab.unnati;let browser,admin,hod,passed=0;const errors=[],responses=[];
 const check=(name,ok)=>{assert.ok(ok,name);passed++;console.log('PASS '+name);};
 async function login(page,who){await page.goto(dev.base+'?as='+who);await page.waitForFunction(()=>window.LF&&LF.me&&LF.role);}
 async function editHod(department){await admin.evaluate(()=>LF.go('users'));const row=admin.getByRole('row').filter({hasText:w.hod});await row.getByRole('button',{name:'Edit',exact:true}).click();const d=admin.getByRole('dialog');await d.getByLabel('Department',{exact:true}).fill(department);await d.getByRole('button',{name:'Save',exact:true}).click();await d.waitFor({state:'hidden'});}
 try{
  dev.lab.autoJobs=false;
  const secret=w.ok(w.admin,'labs.upsert',{code:'ECESECRET',name:'ECE-SECRET Lab',type:'research',department:'ECE',capacity:20}).lab;
  const shared=w.ok(w.admin,'labs.upsert',{code:'SHAREDDEMO',name:'Shared demo facility',type:'computing',department:'',capacity:10}).lab;
  const cat=w.ok(w.staff,'categories.upsert',{name:'Secret inventory',trackingMode:'individual',workstation:true}).category;
  w.ok(w.staff,'assets.upsert',{categoryId:cat.categoryId,labId:secret.labId,name:'ECE-SECRET Workstation',assetTag:'ECE-SECRET-01'});
  browser=await chromium.launch(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{channel:'chrome'});
  admin=await browser.newPage({viewport:{width:1280,height:900}});hod=await browser.newPage({viewport:{width:390,height:844}});
  for(const p of [admin,hod])p.on('pageerror',e=>errors.push(e.message));
  hod.on('response',async r=>{try{if(r.url().endsWith('/rpc')&&r.request().postDataJSON().as===w.hod)responses.push({action:r.request().postDataJSON().action,data:await r.json()});}catch{}});
  await login(admin,w.admin);check('super admin role uses the clarified label',await admin.getByText('Super admin',{exact:true}).count()>=1);
  await admin.evaluate(()=>LF.go('users'));await admin.getByLabel('Role',{exact:true}).selectOption('hod');
  check('HOD appears in the admin role filter',await admin.getByRole('row').filter({hasText:w.hod}).count()===1);
  await admin.getByRole('row').filter({hasText:w.hod}).getByRole('button',{name:'Edit',exact:true}).click();let dialog=admin.getByRole('dialog');
  check('HOD role is editable without enabling coordinator or super admin',await dialog.getByLabel('HOD',{exact:true}).isChecked()&&!await dialog.getByLabel('Coordinator',{exact:true}).isChecked()&&!await dialog.getByLabel('Super admin',{exact:true}).isChecked());
  check('user editor loads the saved department',await dialog.getByLabel('Department',{exact:true}).inputValue()==='CSE');await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
  await editHod('ECE');check('department edits persist without changing HOD role',w.ok(w.hod,'me').department==='ECE'&&w.ok(w.hod,'me').roles.join(',')==='hod');
  await editHod('CSE');await admin.evaluate(()=>LF.go('labs'));await admin.getByRole('row').filter({hasText:'Intel Unnati AI Lab'}).getByRole('button',{name:'Edit',exact:true}).click();dialog=admin.getByRole('dialog');
  await dialog.getByLabel('Department',{exact:true}).fill('CSE');await dialog.getByRole('button',{name:'Save',exact:true}).click();await dialog.waitFor({state:'hidden'});
  check('lab editor saves department ownership',w.ok(w.admin,'labs.list').labs.find(l=>l.labId===demo.lab.labId).department==='CSE');
  await login(hod,w.hod);await hod.getByText('CSE and shared labs · Read-only access',{exact:true}).waitFor();
  check('HOD lands on the department overview',await hod.getByRole('heading',{name:'Department overview',exact:true}).count()===1);
  check('overview includes shared labs but excludes ECE',!(await hod.locator('main').innerText()).includes('ECE-SECRET')&&(await hod.locator('main').innerText()).includes(shared.name));
  check('overview fits a phone',await hod.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await hod.evaluate(()=>LF.go('facilities'));await hod.getByRole('table',{name:'Department equipment',exact:true}).waitFor();
  await hod.getByLabel('Facilities lab',{exact:true}).selectOption(demo.lab.labId);
  await hod.waitForFunction(()=>{const t=Array.from(document.querySelectorAll('table')).find(t=>t.caption&&t.caption.textContent==='Department labs');return t&&t.rows.length===2;});
  check('facilities shows scoped labs and inventory',!(await hod.locator('main').innerText()).includes('ECE-SECRET')&&(await hod.locator('main').innerText()).includes('GPU workstation 01 (demo)'));
  check('HOD has no operational add/edit/issue/approval controls',await hod.getByRole('button',{name:/^(Add|Edit|Issue|Approve|Save|Delete|Return)\b/}).count()===0);
  await hod.getByLabel('Facilities lab',{exact:true}).selectOption(demo.lab.labId);check('facilities lab filter is usable',await hod.getByRole('table',{name:'Department labs',exact:true}).getByRole('row').count()===2);
  check('facilities fits a phone',await hod.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));fs.mkdirSync('.build/shots',{recursive:true});await hod.screenshot({path:'.build/shots/hod-facilities-mobile.png',fullPage:true});
  await hod.evaluate(()=>LF.go('lab-board'));await hod.getByRole('region',{name:'UNNATI live board',exact:true}).waitFor();
  check('HOD live board now opens with current project/system assignments',(await hod.locator('main').innerText()).includes('Image classification (demo)')&&!(await hod.locator('main').innerText()).includes('ECE-SECRET'));
  await hod.evaluate(()=>LF.go('reports'));await hod.getByLabel('Report',{exact:true}).selectOption('inventory');await hod.getByRole('button',{name:'Run report',exact:true}).click();await hod.getByRole('button',{name:'CSV',exact:true}).waitFor();
  check('HOD inventory report is scoped',!(await hod.locator('main').innerText()).includes('ECE-SECRET'));
  const dl=hod.waitForEvent('download');await hod.getByRole('button',{name:'CSV',exact:true}).click();const downloaded=await dl;check('HOD CSV contains no other-department inventory',!fs.readFileSync(await downloaded.path(),'utf8').includes('ECE-SECRET'));
  check('admin-only audit and ERP reports are absent',await hod.locator('#rp-type option[value="audit"],#rp-type option[value="erp"]').count()===0);
  const denied=await hod.evaluate(async ({labId,sessionId})=>{const out={};for(const [a,p]of [['labs.upsert',{labId}],['sessions.close',{sessionId}],['settings.get',{}],['reports.run',{type:'inventory',labId}]]){try{await LF.api(a,p);out[a]='ALLOWED';}catch(e){out[a]=e.code;}}return out;},{labId:secret.labId,sessionId:demo.sessionId});
  check('server refuses writes, admin settings and forged cross-department report filters',Object.values(denied).every(x=>x==='FORBIDDEN'));
  const safeReads=new Set(['dash.hod','labs.list','labs.occupancy','labs.live','assets.list','reports.run','reports.csv']);
  check('successful HOD read responses contain no other-department data',responses.filter(x=>safeReads.has(x.action)&&x.data.ok).every(x=>!JSON.stringify(x.data).includes('ECE-SECRET')));
  await editHod('ECE');await hod.evaluate(()=>LF.go('overview'));await hod.getByText('ECE and shared labs · Read-only access',{exact:true}).waitFor();
  check('department change takes effect without reopening the HOD account',(await hod.locator('main').innerText()).includes('ECE-SECRET Lab')&&!(await hod.locator('main').innerText()).includes('Intel Unnati AI Lab'));
  await editHod('');await hod.evaluate(()=>LF.go('overview'));await hod.getByText(/Shared labs only — ask the super admin/).waitFor();
  check('missing department shows shared facilities only',!(await hod.locator('main').innerText()).includes('ECE-SECRET')&&!(await hod.locator('main').innerText()).includes('Intel Unnati AI Lab'));
  check('no uncaught browser errors',errors.length===0);console.log('\n'+passed+' HOD checks passed.');
 }catch(e){for(const [name,p]of [['admin',admin],['hod',hod]])if(p){fs.mkdirSync('.build/shots',{recursive:true});await p.screenshot({path:'.build/shots/hod-'+name+'-failure.png',fullPage:true});console.error(name+': '+await p.locator('body').innerText());}throw e;}
 finally{if(browser)await browser.close();dev.server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
