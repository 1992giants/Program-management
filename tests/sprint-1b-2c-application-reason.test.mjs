import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { isApplicationReasonResponseCurrent, updateApplicationReasonCache } from '../lib/application-reason-state.ts';

const projectRoot=path.resolve(import.meta.dirname,'..');

test('staff 신청 사유는 단건 on-demand로만 조회되고 상태 변경 결과도 canonical 값만 반환한다',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'onmaeum-application-reason-'));
  const databasePath=path.join(directory,'application-reason.sqlite');
  const source=`
    import assert from 'node:assert/strict';
    import { GET,POST } from './app/api/data/route.ts';
    import { getDatabase,hashPin } from './db/index.ts';

    const db=getDatabase(),origin='http://localhost:3000',today='2026-09-13';
    for(const row of [
      ['USR-REASON-ADMIN','reason-admin','사유 관리자','86420975','관리자',0],
      ['USR-REASON-STAFF','reason-staff','사유 담당자','75310864','일반 담당자',0],
      ['USR-REASON-ONLY','reason-only','출석 담당자','24681357','출석 입력 전용',0],
      ['USR-REASON-TEMP','reason-temp','임시 담당자','13572468','일반 담당자',1],
    ])db.prepare('INSERT INTO staff_users (id,username,display_name,pin_hash,role,active,created_at,must_change_pin) VALUES (?,?,?,?,?,1,?,?)').run(row[0],row[1],row[2],hashPin(row[1],row[3]),row[4],today,row[5]);
    for(const row of [['P-REASON-A','사유 참가자 A'],['P-REASON-B','사유 참가자 B'],['P-REASON-C','사유 참가자 C']])db.prepare("INSERT INTO participants (id,name,gender,age,phone,member_status,note,created_at) VALUES (?,?,'미입력',0,'010-0000-0000','비회원','',?)").run(row[0],row[1],today);
    db.prepare("INSERT INTO programs (id,name,category,delivery_type,session_count,recurrence,location,manager,capacity,status,created_at) VALUES ('PRG-REASON','사유 프로그램','회복','집단',1,'매주','센터','담당자',10,'운영 중',?)").run(today);
    db.prepare("INSERT INTO program_runs (id,program_id,round_number,label,start_date,status) VALUES ('RUN-REASON','PRG-REASON',1,'1차',?,'진행 중')").run(today);
    db.prepare("INSERT INTO sessions (id,run_id,session_number,session_date,session_time,location) VALUES ('SESSION-REASON','RUN-REASON',1,?,'10:00','센터')").run(today);
    const insertApplication=db.prepare('INSERT INTO applications (id,participant_id,program_id,run_id,applied_at,status,queue_number,status_reason) VALUES (?,?,?,?,?,?,?,?)');
    insertApplication.run(901,'P-REASON-A','PRG-REASON','RUN-REASON',today,'취소',1,'APPLICATION_REASON_SECRET_SENTINEL');
    insertApplication.run(902,'P-REASON-B','PRG-REASON','RUN-REASON',today,'중도탈락',2,'APPLICATION_REASON_OTHER_SENTINEL');
    insertApplication.run(903,'P-REASON-C','PRG-REASON','RUN-REASON',today,'참가중',3,'');

    const request=(method,url,cookie,body)=>new Request(origin+url,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(method==='POST'?{Origin:origin,'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const get=(url,cookie)=>GET(request('GET',url,cookie));
    const post=(body,cookie)=>POST(request('POST','/api/data',cookie,body));
    const login=async(username,pin)=>{const response=await post({action:'login',username,pin});assert.equal(response.status,200);return {body:await response.json(),cookie:response.headers.get('set-cookie').split(';')[0]}};
    const originalSentinels=['APPLICATION_REASON_SECRET_SENTINEL','APPLICATION_REASON_OTHER_SENTINEL'];
    const assertStaffSummary=(body)=>{
      assert.equal(body.currentUser.role,'일반 담당자');
      const first=body.applications.find(item=>item.id===901),second=body.applications.find(item=>item.id===902),empty=body.applications.find(item=>item.id===903);
      for(const application of body.applications)assert.equal(Object.hasOwn(application,'status_reason'),false);
      assert.equal(first.reason_present,1);assert.equal(second.reason_present,1);assert.equal(empty.reason_present,0);
      const serialized=JSON.stringify(body);for(const sentinel of originalSentinels)assert.equal(serialized.includes(sentinel),false,sentinel);
    };

    const admin=await login('reason-admin','86420975');
    assert.equal(admin.body.applications.find(item=>item.id===901).status_reason,originalSentinels[0]);
    assert.equal(admin.body.applications.find(item=>item.id===902).status_reason,originalSentinels[1]);
    const staff=await login('reason-staff','75310864');assertStaffSummary(staff.body);
    const staffGet=await get('/api/data',staff.cookie);assert.equal(staffGet.status,200);assertStaffSummary(await staffGet.json());
    const participantMutation=await post({action:'updateParticipant',id:'P-REASON-A',name:'사유 참가자 A',gender:'미입력',age:0,phone:'010-0000-0000',memberStatus:'비회원',note:''},staff.cookie);assert.equal(participantMutation.status,200);assertStaffSummary(await participantMutation.json());
    const attendanceMutation=await post({action:'attendance',applicationId:903,sessionId:'SESSION-REASON',status:'참석',note:'',contactedAt:'',makeupForSessionId:''},staff.cookie);assert.equal(attendanceMutation.status,200);assertStaffSummary(await attendanceMutation.json());
    const applicationMutation=await post({action:'applicationStatus',id:903,status:'참가대기',reason:''},staff.cookie);assert.equal(applicationMutation.status,200);const applicationMutationBody=await applicationMutation.json();assertStaffSummary(applicationMutationBody);assert.deepEqual(applicationMutationBody.updatedApplicationReason,{applicationId:903,reasonPresent:false,statusReason:''});

    const attendanceOnly=await login('reason-only','24681357');
    assert.equal(Object.hasOwn(attendanceOnly.body.applications[0],'status_reason'),false);assert.equal(Object.hasOwn(attendanceOnly.body.applications[0],'reason_present'),false);
    const temporary=await login('reason-temp','13572468');

    const reasonAResponse=await get('/api/data?resource=application-reason&id=901',staff.cookie);assert.equal(reasonAResponse.status,200);assert.equal(reasonAResponse.headers.get('cache-control'),'no-store');const reasonA=await reasonAResponse.json();
    assert.deepEqual(Object.keys(reasonA).sort(),['applicationId','statusReason']);assert.deepEqual(reasonA,{applicationId:901,statusReason:originalSentinels[0]});assert.equal(JSON.stringify(reasonA).includes(originalSentinels[1]),false);
    const emptyReason=await get('/api/data?resource=application-reason&id=903',staff.cookie);assert.equal(emptyReason.status,200);assert.deepEqual(await emptyReason.json(),{applicationId:903,statusReason:''});
    const adminReason=await get('/api/data?resource=application-reason&id=902',admin.cookie);assert.equal(adminReason.status,200);assert.deepEqual(await adminReason.json(),{applicationId:902,statusReason:originalSentinels[1]});
    const unauthorized=await get('/api/data?resource=application-reason&id=901'),attendanceDenied=await get('/api/data?resource=application-reason&id=901',attendanceOnly.cookie),temporaryDenied=await get('/api/data?resource=application-reason&id=901',temporary.cookie);
    assert.equal(unauthorized.status,401);assert.equal(attendanceDenied.status,403);assert.equal(temporaryDenied.status,403);
    for(const response of [unauthorized,attendanceDenied,temporaryDenied])assert.equal(response.headers.get('cache-control'),'no-store');

    const invalidUrls=[
      '/api/data?resource=application-reason',
      '/api/data?resource=application-reason&id=',
      '/api/data?resource=application-reason&id=%20%20',
      '/api/data?resource=application-reason&id=901&id=902',
      '/api/data?resource=application-reason&id=*',
      '/api/data?resource=application-reason&id=%25',
      '/api/data?resource=application-reason&id=1%20OR%201=1',
      '/api/data?resource=application-reason&id=0',
      '/api/data?resource=application-reason&id=-1',
      '/api/data?resource=application-reason&id=1.5',
      '/api/data?resource=application-reason&id=NaN',
      '/api/data?resource=application-reason&id=999999',
    ];
    for(const url of invalidUrls){const response=await get(url,staff.cookie);assert.ok(response.status>=400&&response.status<500,url);assert.equal(response.headers.get('cache-control'),'no-store');const serialized=JSON.stringify(await response.json());for(const sentinel of originalSentinels)assert.equal(serialized.includes(sentinel),false,url)}

    const beforeBlank=db.prepare('SELECT status,status_reason FROM applications WHERE id=903').get(),auditBeforeBlank=db.prepare('SELECT COUNT(*) AS count FROM audit_logs').get().count;
    const blankTerminal=await post({action:'applicationStatus',id:903,status:'취소',reason:'   '},staff.cookie);assert.equal(blankTerminal.status,400);assert.deepEqual(db.prepare('SELECT status,status_reason FROM applications WHERE id=903').get(),beforeBlank);assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_logs').get().count,auditBeforeBlank);

    const newReason='NEW_APPLICATION_REASON_SENTINEL';
    const terminal=await post({action:'applicationStatus',id:901,status:'취소',reason:newReason},staff.cookie);assert.equal(terminal.status,200);const terminalBody=await terminal.json();
    assert.equal(terminalBody.applications.find(item=>item.id===901).reason_present,1);assert.equal(Object.hasOwn(terminalBody.applications.find(item=>item.id===901),'status_reason'),false);assert.deepEqual(terminalBody.updatedApplicationReason,{applicationId:901,reasonPresent:true,statusReason:newReason});assert.equal(db.prepare('SELECT status_reason FROM applications WHERE id=901').get().status_reason,newReason);

    const nonterminal=await post({action:'applicationStatus',id:902,status:'참가중'},staff.cookie);assert.equal(nonterminal.status,200);const nonterminalBody=await nonterminal.json();
    assert.equal(nonterminalBody.applications.find(item=>item.id===902).reason_present,0);assert.deepEqual(nonterminalBody.updatedApplicationReason,{applicationId:902,reasonPresent:false,statusReason:''});assert.equal(db.prepare('SELECT status_reason FROM applications WHERE id=902').get().status_reason,'');

    const auditSerialized=JSON.stringify(db.prepare('SELECT * FROM audit_logs').all());for(const sentinel of [...originalSentinels,newReason])assert.equal(auditSerialized.includes(sentinel),false,sentinel);assert.ok(auditSerialized.includes('reason_present'));
    console.log(JSON.stringify({ok:true}));
  `;
  try{
    const result=spawnSync(process.execPath,['--input-type=module','--eval',source],{cwd:projectRoot,env:{...process.env,NODE_ENV:'test',ONMAEUM_TEST_DB_PATH:databasePath,ONMAEUM_BACKUP_DIR:path.join(directory,'backups'),ONMAEUM_BOOTSTRAP_ADMIN_USERNAME:'test-owner',ONMAEUM_BOOTSTRAP_ADMIN_DISPLAY_NAME:'테스트 관리자',ONMAEUM_BOOTSTRAP_ADMIN_PIN:'97531086',ONMAEUM_ENABLE_DEMO_SEED:'0'},encoding:'utf8'});
    assert.equal(result.status,0,result.stderr||result.stdout);assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)),{ok:true});
  }finally{rmSync(directory,{recursive:true,force:true})}
});

test('신청 사유 client state는 application identity와 canonical mutation result를 유지한다',()=>{
  assert.equal(isApplicationReasonResponseCurrent(902,901,901),false);
  assert.equal(isApplicationReasonResponseCurrent(902,902,901),false);
  assert.equal(isApplicationReasonResponseCurrent(902,902,902),true);
  assert.deepEqual(updateApplicationReasonCache({901:'old',902:'other'},{applicationId:901,reasonPresent:true,statusReason:'canonical'}),{901:'canonical',902:'other'});
  assert.deepEqual(updateApplicationReasonCache({901:'old',902:'other'},{applicationId:901,reasonPresent:false,statusReason:''}),{902:'other'});
  const page=readFileSync(path.join(projectRoot,'app/page.tsx'),'utf8');
  assert.match(page,/resource=application-reason&id=/);assert.match(page,/reasonAbort\.current\?\.abort\(\)/);assert.match(page,/isApplicationReasonResponseCurrent/);assert.match(page,/updateApplicationReasonCache\(current,result\)/);assert.match(page,/updatedApplicationReason/);
  assert.match(page,/delete snapshotData\.updatedApplicationReason/);
  assert.doesNotMatch(page,/(localStorage|sessionStorage|indexedDB).*reason/i);
});
