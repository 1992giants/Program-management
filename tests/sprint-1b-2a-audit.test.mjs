import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const projectRoot=path.resolve(import.meta.dirname,'..');

function runNode(source,env={}){
  return spawnSync(process.execPath,['--input-type=module','--eval',source],{
    cwd:projectRoot,
    env:{...process.env,...env},
    encoding:'utf8',
  });
}

test('감사로그는 관리자 전용이며 민감 원문과 credential을 복제하지 않는다',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'onmaeum-audit-minimization-'));
  const databasePath=path.join(directory,'audit-test.sqlite');
  const backupDirectory=path.join(directory,'backups');
  const source=`
    import assert from 'node:assert/strict';
    import path from 'node:path';
    import { GET,POST } from './app/api/data/route.ts';
    import { getDatabase,hashPin } from './db/index.ts';
    import { SESSION_COOKIE_NAME } from './lib/security.ts';

    const db=getDatabase(),today='2026-09-11',origin='http://localhost:3000';
    db.prepare('INSERT INTO staff_users (id,username,display_name,pin_hash,role,active,created_at,must_change_pin) VALUES (?,?,?,?,?,1,?,0)').run('USR-AUDIT-ADMIN','audit-admin','감사 관리자',hashPin('audit-admin','86420975'),'관리자',today);
    db.prepare('INSERT INTO staff_users (id,username,display_name,pin_hash,role,active,created_at,must_change_pin) VALUES (?,?,?,?,?,1,?,0)').run('USR-AUDIT-STAFF','audit-staff','일반 담당',hashPin('audit-staff','75310864'),'일반 담당자',today);
    db.prepare('INSERT INTO staff_users (id,username,display_name,pin_hash,role,active,created_at,must_change_pin) VALUES (?,?,?,?,?,1,?,0)').run('USR-AUDIT-ATTENDANCE','audit-attendance','출석 담당',hashPin('audit-attendance','24681357'),'출석 입력 전용',today);
    db.prepare('INSERT INTO participants (id,name,gender,age,phone,member_status,note,created_at) VALUES (?,?,?,?,?,?,?,?)').run('P-AUDIT','감사대상','여성',40,'010-1000-2000','회원','기존 민감 메모',today);
    db.prepare('INSERT INTO programs (id,name,category,delivery_type,session_count,recurrence,location,manager,capacity,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('PRG-AUDIT','감사 프로그램','회복','집단',1,'매주','프로그램실','담당자',10,'운영 중',today);
    db.prepare('INSERT INTO program_runs (id,program_id,round_number,label,start_date,status) VALUES (?,?,?,?,?,?)').run('RUN-AUDIT','PRG-AUDIT',1,'1차',today,'진행 중');
    db.prepare('INSERT INTO sessions (id,run_id,session_number,session_date,session_time,location) VALUES (?,?,?,?,?,?)').run('SESSION-AUDIT','RUN-AUDIT',1,today,'10:00','프로그램실');
    db.prepare('INSERT INTO applications (id,participant_id,program_id,run_id,applied_at,status,queue_number) VALUES (?,?,?,?,?,?,?)').run(101,'P-AUDIT','PRG-AUDIT','RUN-AUDIT',today,'참가중',1);

    const post=(body,cookie='')=>POST(new Request(origin+'/api/data',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)}));
    const get=(cookie='',resource='')=>GET(new Request(origin+'/api/data'+resource,{headers:{...(cookie?{Cookie:cookie}:{})}}));
    const cookieFrom=response=>response.headers.get('set-cookie').split(';')[0];
    const login=async(username,pin,attendanceOnly=false)=>{const response=await post({action:'login',username,pin});assert.equal(response.status,200);const body=await response.json();if(attendanceOnly)assert.deepEqual(body.auditLogs,[]);else assert.equal(Object.hasOwn(body,'auditLogs'),false);return {cookie:cookieFrom(response),body};};
    const auditRow=(action,entityType)=>db.prepare('SELECT * FROM audit_logs WHERE action=? AND entity_type=? ORDER BY id DESC LIMIT 1').get(action,entityType);
    const auditText=row=>[row.before_json,row.after_json,row.summary,row.reason].join(' ');

    assert.equal((await get('','?resource=audit')).status,401);
    const admin=await login('audit-admin','86420975');
    const staff=await login('audit-staff','75310864');
    const attendance=await login('audit-attendance','24681357',true);
    assert.equal(Object.hasOwn(await (await get(staff.cookie)).json(),'auditLogs'),false);
    assert.deepEqual((await (await get(attendance.cookie)).json()).auditLogs,[]);
    assert.equal((await get(staff.cookie,'?resource=audit')).status,403);
    assert.equal((await get(attendance.cookie,'?resource=audit')).status,403);
    const adminAudit=await get(admin.cookie,'?resource=audit');
    assert.equal(adminAudit.status,200);
    assert.ok(Array.isArray((await adminAudit.json()).auditLogs));

    const injectedPhone='010-1234-5678',injectedMemo='존재하지 않는 대상의 민감 메모',injectedPin='15975348',injectedSessionSecret=staff.cookie.slice(SESSION_COOKIE_NAME.length+1),auditCountBeforeInjection=db.prepare('SELECT COUNT(*) AS count FROM audit_logs').get().count;
    const injectionRequests=[
      {action:'updateParticipant',id:injectedPhone,name:'없는 참가자',gender:'미입력',age:0,phone:'',memberStatus:'비회원',note:''},
      {action:'updateSession',id:injectedMemo,sessionDate:today,sessionTime:'09:00',location:'센터'},
      {action:'setAssessmentActive',id:injectedPin,active:false},
      {action:'setProgramAssessments',programId:injectedSessionSecret,assessmentIds:[]},
    ];
    for(const request of injectionRequests)assert.equal((await post(request,staff.cookie)).status,400);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_logs').get().count,auditCountBeforeInjection);
    const auditAfterInjection=JSON.stringify(db.prepare('SELECT entity_id,before_json,after_json,summary,reason FROM audit_logs').all());
    for(const injected of [injectedPhone,injectedMemo,injectedPin,injectedSessionSecret])assert.equal(auditAfterInjection.includes(injected),false);

    const newPhone='010-9999-8888',newMemo='새로운 극비 상담 메모';
    const participantResponse=await post({action:'updateParticipant',id:'P-AUDIT',name:'감사대상',gender:'여성',age:40,phone:newPhone,memberStatus:'회원',note:newMemo},staff.cookie);
    assert.equal(participantResponse.status,200);
    assert.equal(Object.hasOwn(await participantResponse.json(),'auditLogs'),false);
    const participantLog=auditRow('수정','참가자'),participantText=auditText(participantLog);
    assert.equal(participantLog.actor,'USR-AUDIT-STAFF');
    for(const secret of ['010-1000-2000',newPhone,'기존 민감 메모',newMemo])assert.equal(participantText.includes(secret),false);
    assert.deepEqual(JSON.parse(participantLog.after_json).changed_fields,['phone','note']);

    const assessmentNote='검사 관련 극비 메모',assessmentReason='검사 미실시 민감 사유';
    const assessmentResponse=await post({action:'saveAssessmentScore',applicationId:101,assessmentId:'ASM-PHQ9',preScore:27,postScore:'',note:assessmentNote,preDate:today,postDate:'',notCompletedReason:assessmentReason},staff.cookie);
    assert.equal(assessmentResponse.status,200);
    const assessmentLog=auditRow('검사 점수','성과검사'),assessmentText=auditText(assessmentLog),assessmentPayload=JSON.parse(assessmentLog.after_json);
    assert.equal(assessmentText.includes(assessmentNote),false);
    assert.equal(assessmentText.includes(assessmentReason),false);
    assert.equal(assessmentText.includes('"pre_score":27'),false);
    assert.equal(assessmentPayload.assessment_type_id,'ASM-PHQ9');
    assert.equal(assessmentPayload.note_changed,true);
    assert.equal(assessmentPayload.reason_present,true);

    const satisfactionComment='만족도 극비 자유 의견';
    assert.equal((await post({action:'saveSatisfaction',applicationId:101,score:4,comment:satisfactionComment,surveyVersion:'1.0',anonymous:false},staff.cookie)).status,200);
    const satisfactionLog=auditRow('만족도 입력','만족도'),satisfactionText=auditText(satisfactionLog),satisfactionPayload=JSON.parse(satisfactionLog.after_json);
    assert.equal(satisfactionText.includes(satisfactionComment),false);
    assert.equal(satisfactionText.includes('"score":4'),false);
    assert.equal(satisfactionPayload.score_changed,true);
    assert.equal(satisfactionPayload.comment_changed,true);

    const attendanceNote='출석 관련 극비 연락 내용';
    assert.equal((await post({action:'attendance',applicationId:101,sessionId:'SESSION-AUDIT',status:'결석',note:attendanceNote,contactedAt:'2026-09-11T10:10:00'},staff.cookie)).status,200);
    const attendanceLog=auditRow('출석 입력','출석'),attendanceText=auditText(attendanceLog),attendancePayload=JSON.parse(attendanceLog.after_json);
    assert.equal(attendanceText.includes(attendanceNote),false);
    assert.equal(attendancePayload.status,'결석');
    assert.equal(attendancePayload.note_changed,true);
    assert.equal(attendancePayload.contact_checked,true);

    const fabricatedSummary='클라이언트가 만든 가짜 감사 설명';
    assert.equal((await post({action:'recordAccess',eventType:'participant_view',targetId:'P-AUDIT',accessAction:'계정 삭제',summary:fabricatedSummary},staff.cookie)).status,200);
    const accessLog=auditRow('참가자 조회','참가자');
    assert.equal(auditText(accessLog).includes(fabricatedSummary),false);
    const countBefore=db.prepare('SELECT COUNT(*) AS count FROM audit_logs').get().count;
    assert.equal((await post({action:'recordAccess',eventType:'arbitrary_event',targetId:'P-AUDIT',summary:fabricatedSummary},staff.cookie)).status,400);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_logs').get().count,countBefore);
    assert.equal((await post({action:'recordAccess',eventType:'participant_view',targetId:'P-AUDIT'},attendance.cookie)).status,403);

    const backupResponse=await post({action:'backup'},admin.cookie);
    assert.equal(backupResponse.status,200);
    const backupBody=await backupResponse.json(),backupLog=auditRow('백업','데이터베이스');
    assert.equal(auditText(backupLog).includes(path.dirname(backupBody.backupPath)),false);
    assert.equal(JSON.parse(backupLog.after_json).backup_file,path.basename(backupBody.backupPath));
    const restoreResponse=await post({action:'restoreBackup',path:backupBody.backupPath},admin.cookie);
    assert.equal(restoreResponse.status,200);
    const restoreLog=auditRow('복원','데이터베이스'),restoreText=auditText(restoreLog);
    assert.equal(restoreText.includes(path.dirname(backupBody.backupPath)),false);
    assert.equal(JSON.parse(restoreLog.after_json).restored_from,path.basename(backupBody.backupPath));

    const allAudit=JSON.stringify(db.prepare('SELECT actor,before_json,after_json,summary,reason FROM audit_logs').all());
    for(const secret of ['86420975','75310864','24681357',admin.cookie.slice(SESSION_COOKIE_NAME.length+1),staff.cookie.slice(SESSION_COOKIE_NAME.length+1),attendance.cookie.slice(SESSION_COOKIE_NAME.length+1)])assert.equal(allAudit.includes(secret),false);
    console.log(JSON.stringify({ok:true}));
  `;
  try{
    const result=runNode(source,{
      NODE_ENV:'test',ONMAEUM_TEST_DB_PATH:databasePath,ONMAEUM_BACKUP_DIR:backupDirectory,
      ONMAEUM_BOOTSTRAP_ADMIN_USERNAME:'test-owner',ONMAEUM_BOOTSTRAP_ADMIN_DISPLAY_NAME:'테스트 관리자',ONMAEUM_BOOTSTRAP_ADMIN_PIN:'97531086',ONMAEUM_ENABLE_DEMO_SEED:'0',
    });
    assert.equal(result.status,0,result.stderr||result.stdout);
    assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)),{ok:true});
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('legacy 감사 진단은 의심 건수만 출력하고 원문을 노출하거나 수정하지 않는다',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'onmaeum-audit-scan-')),databasePath=path.join(directory,'legacy.sqlite'),missingPath=path.join(directory,'missing.sqlite');
  const secret='legacy-sensitive-content-that-must-not-print',titleSecret='legacy-title-that-must-not-print',summarySecret='legacy-summary-that-must-not-print';
  try{
    const db=new DatabaseSync(databasePath);
    db.exec(`CREATE TABLE audit_logs (id INTEGER PRIMARY KEY,action TEXT,entity_type TEXT,before_json TEXT,after_json TEXT,summary TEXT,reason TEXT)`);
    const insert=db.prepare('INSERT INTO audit_logs (action,entity_type,before_json,after_json,summary,reason) VALUES (?,?,?,?,?,?)');
    insert.run('수정','참가자',JSON.stringify({phone:secret}),'','','');
    insert.run('일정 등록','일정','',JSON.stringify({title:titleSecret}),'','');
    insert.run('일정 등록','일정','','',summarySecret,'');
    db.close();
    const beforeBytes=readFileSync(databasePath),missingResult=spawnSync(process.execPath,['scripts/audit-sensitive-scan.mjs','--database',missingPath],{cwd:projectRoot,encoding:'utf8'});
    assert.notEqual(missingResult.status,0);
    assert.equal(existsSync(missingPath),false);
    const result=spawnSync(process.execPath,['scripts/audit-sensitive-scan.mjs','--database',databasePath],{cwd:projectRoot,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    for(const value of [secret,titleSecret,summarySecret])assert.equal(result.stdout.includes(value),false);
    const report=JSON.parse(result.stdout);
    assert.equal(report.total_rows,3);
    assert.equal(report.suspected_rows,3);
    assert.deepEqual(report.groups,[{action:'일정 등록',entity_type:'일정',count:2},{action:'수정',entity_type:'참가자',count:1}]);
    assert.equal(report.interpretation,'heuristic_candidates_not_proof_of_absence');
    assert.deepEqual(readFileSync(databasePath),beforeBytes);
    const verify=new DatabaseSync(databasePath,{readOnly:true});
    assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM audit_logs').get().count,3);
    verify.close();
  }finally{rmSync(directory,{recursive:true,force:true});}
});
